/**
 * engine-playback.js — Routes all music playback through the local engine API.
 *
 * Architecture:
 *  1. Block Apple CDN src at HTMLMediaElement.prototype (runs before any element
 *     exists, so MK can never set a CDN URL on any audio element).
 *  2. On nowPlayingItemDidChange: POST → engine session → inject MSE stream
 *     directly into MusicKit's <audio> element.
 *  3. First time handleTrackChange runs, install an instance-level play() proxy
 *     on the audio element.  MK calls audio.play() before our MSE has data;
 *     the proxy returns a deferred Promise that resolves the moment 'playing'
 *     fires — which happens when our canplay handler calls _nativePlay().
 *     MK's state machine then transitions to "playing" on its own.
 *  4. We never touch mk.play() / mk.pause() at the API level.  MK's state
 *     machine follows DOM events (play, playing, pause, timeupdate) naturally.
 */

const ENGINE = window._amlEngineURL || 'http://127.0.0.1:20025';

// ── Raw audio capture module ──────────────────────────────────────────────────
// Stores raw chunk bytes + deep MP4 parse for every audio append so the
// external debug_app.py inspector can retrieve and analyse them.
// Capped at 64 MB total to avoid OOM.
(function installAudioCapture() {
    const CAP_LIMIT = 64 * 1024 * 1024;

    window.__amlCapture = {
        chunks: [],   // {n, path, size, b64, boxes, bufBefore, bufAfter, grew, t}
        totalBytes: 0,
        enabled: true,
    };

    // Deep MP4 box walker — returns array of box descriptors.
    window.__amlParseMp4 = function parseMp4(data, maxDepth) {
        if (maxDepth === undefined) maxDepth = 4;
        const result = [];
        let off = 0;
        while (off + 8 <= data.length) {
            const size = (data[off]<<24 | data[off+1]<<16 | data[off+2]<<8 | data[off+3]) >>> 0;
            const type = String.fromCharCode(data[off+4], data[off+5], data[off+6], data[off+7]);
            if (size < 8) break;
            const boxData = data.slice(off, off + Math.min(size, data.length - off));
            const box = { type, size, offset: off };

            // Recurse into container boxes.
            const containers = ['moov','trak','mdia','minf','stbl','stsd','mvex',
                                'moof','traf','udta','meta','ilst','edts'];
            if (containers.includes(type) && maxDepth > 0) {
                const headerSize = (type === 'stsd') ? 16 : (type === 'meta') ? 12 : 8;
                box.children = parseMp4(data.slice(off + headerSize, off + boxData.length), maxDepth - 1);
            }
            // Extract key fields.
            if (type === 'ftyp' && boxData.length >= 12) {
                box.majorBrand = String.fromCharCode(boxData[8],boxData[9],boxData[10],boxData[11]);
            }
            if (type === 'mdhd' && boxData.length >= 24) {
                const ver = boxData[8];
                box.timescale = ver === 1
                    ? (boxData[20]<<24|boxData[21]<<16|boxData[22]<<8|boxData[23])>>>0
                    : (boxData[16]<<24|boxData[17]<<16|boxData[18]<<8|boxData[19])>>>0;
            }
            if (type === 'hdlr' && boxData.length >= 20) {
                box.handler = String.fromCharCode(boxData[16],boxData[17],boxData[18],boxData[19]);
            }
            if ((type === 'mp4a' || type === 'enca') && boxData.length >= 28) {
                box.sampleRate = (boxData[24]<<8|boxData[25]);
                box.channels   = (boxData[16]<<8|boxData[17]);
                box.isEncrypted = (type === 'enca');
            }
            if (type === 'schm' && boxData.length >= 16) {
                box.schemeType = String.fromCharCode(boxData[8],boxData[9],boxData[10],boxData[11]);
            }
            if (type === 'tfhd' && boxData.length >= 16) {
                box.trackID = (boxData[8]<<24|boxData[9]<<16|boxData[10]<<8|boxData[11])>>>0;
                box.flags   = (boxData[9]<<16|boxData[10]<<8|boxData[11]);
            }
            if (type === 'trun' && boxData.length >= 16) {
                box.sampleCount = (boxData[8]<<24|boxData[9]<<16|boxData[10]<<8|boxData[11])>>>0;
            }
            if (type === 'tfdt' && boxData.length >= 12) {
                const ver = boxData[8];
                box.baseMediaDecodeTime = ver === 1
                    ? ((boxData[12]*2**24+boxData[13]*2**16+boxData[14]*256+boxData[15])*2**32
                       + (boxData[16]*2**24+boxData[17]*2**16+boxData[18]*256+boxData[19]))
                    : (boxData[12]<<24|boxData[13]<<16|boxData[14]<<8|boxData[15])>>>0;
            }
            if (type === 'senc' && boxData.length >= 12) {
                box.sampleCount = (boxData[12]<<24|boxData[13]<<16|boxData[14]<<8|boxData[15])>>>0;
                box.ENCRYPTED   = true;
            }
            if (type === 'mdat') {
                box.hex32 = Array.from(boxData.slice(8, Math.min(40, boxData.length)))
                    .map(b => b.toString(16).padStart(2,'0')).join(' ');
            }

            result.push(box);
            off += size;
            if (off >= data.length) break;
        }
        return result;
    };

    // Capture one chunk — called from runAudioPipe and pipeToSourceBuffer hooks.
    // Only encodes the first 8 KB as base64 to avoid blocking the JS thread.
    // Full box structure is parsed from that prefix (sufficient for all headers).
    window.__amlCaptureChunk = function(path, n, value, bufBefore, bufAfter, grew) {
        if (!window.__amlCapture.enabled) return;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const HEADER = 8192; // first 8 KB — covers ftyp+moov or moof+mdat header
        const slice  = bytes.slice(0, HEADER);
        // hex-encode only (no btoa binary-string loop — that blocks for large chunks)
        const hex = Array.from(slice).map(b => b.toString(16).padStart(2,'0')).join('');
        const boxes = window.__amlParseMp4(bytes);
        window.__amlCapture.chunks.push({
            n, path,
            size: value.byteLength,
            capturedBytes: slice.length,
            hex,          // first 8 KB as hex string
            boxes,
            bufBefore, bufAfter, grew,
            t: Date.now()
        });
        window.__amlCapture.totalBytes += value.byteLength;
    };

    // Python inspector calls this to drain all captured chunks.
    window.__amlDrainCapture = function() {
        const out = window.__amlCapture.chunks.slice();
        window.__amlCapture.chunks = [];
        return out;
    };
})();

// Suppress MusicKit's high-frequency event-queue overflow spam so it doesn't
// drown useful [AML *] diagnostic messages in the renderer console.
(() => {
    const _orig = console.log;
    console.log = (...args) => {
        if (typeof args[0] === 'string' && args[0].includes('eventQueue overflow')) return;
        _orig.apply(console, args);
    };
})();

// ── Native handles ─────────────────────────────────────────────────────────────

let _nativeSrcSet = null; // saved by blockAppleCDN() for our own src writes
let _nativeCTSet  = null; // native currentTime setter — used by MSE seek to fire 'seeking'
let _nativePlay   = null; // saved when play() proxy is installed on the element
let _ourBlobUrl   = null; // current blob URL we own; blocks MK from replacing it

// The music.apple.com origin's HTMLMediaElement.prototype.play is gated by Chromium's
// autoplay policy for that realm, which blocks play() on elements managed by the native
// amp-video-player controller while MusicKit state=1 (loading). An iframe's play() from
// a blank realm bypasses this gate and works reliably for the MV native video element.
const _iframePlay = (() => {
    try {
        const ifr = document.createElement('iframe');
        ifr.style.display = 'none';
        document.body.appendChild(ifr);
        const fn = ifr.contentWindow.HTMLMediaElement.prototype.play;
        document.body.removeChild(ifr);
        return fn;
    } catch (e) { return HTMLMediaElement.prototype.play; }
})();

// Captured before blockAppleCDN() or any other override — same reference Apple Music
// saves as 'savedPause' at page-load time. Used by the MV counter-pause interceptor.
const _nativePauseRef = HTMLMediaElement.prototype.pause;
const _origFnCall     = Function.prototype.call;
const _origFnApply    = Function.prototype.apply;

// ── VLC state ─────────────────────────────────────────────────────────────────

let _vlcMode       = false; // true when VLC is handling playback (MSE bypassed)
let _vlcPosMs      = 0;     // last polled VLC position (frozen during seek)
let _vlcPaused     = false; // virtual paused state (overrides audio.paused in VLC mode)
let _vlcPollTimer  = null;  // setInterval handle
let _vlcSeekTimer  = null;  // debounce: actual VLC seek fires after scrubbing stops
let _vlcSeekFrozen    = false; // true during scrub → poll won't overwrite _vlcPosMs
let _vlcSeekOffsetMs  = 0;    // song-position base of current VLC HTTP stream (ms)
let _vlcRetryCount    = 0;    // premature-end retries for current track (reset on track change)
let _vlcPrevState     = null; // last VLC state seen by the poll (null forces re-emit after seek)
let _vlcLoading       = false; // true from VLC.Load until VLC first enters 'playing' state
let _seekBurstLog     = 0;    // ticks remaining in post-seek burst logging window

// ── MSE state (AAC-only path) ─────────────────────────────────────────────────

let _seekable         = false;
let _seekTarget       = -Infinity;
let _seekFetchCtrl    = null;
let _pipeCtrl         = null;
let _activeSb         = null;
let _activeMs         = null;
let _activeStreamBase = '';
let _ourSeekPending   = false;
let _ourSeekTarget    = -Infinity;
let _streamComplete   = false;
let _chunkCache       = null;
let _msePaused        = false; // true while user has manually paused in MSE mode

// ── Queue snapshot (for auto-advance detection) ───────────────────────────────
// Saved after every nowPlayingItemDidChange so queueDidChange can compare
// old vs new state to distinguish "play next" insertions from "play now" replacements.


// ── Engine capability snapshot (from SSE) ─────────────────────────────────────

let _engineCaps      = { lossless: false, atmos: false };
let _losslessWaitDone = false;  // true after waitForLossless has timed out once — skip future waits
let _snapshotEventId  = -1;     // SSE meta.id of the last engine.snapshot — drm events older than this are stale replays

// ── DRM key system stub (prevents MKError mk-140 in Electron) ─────────────────
// Electron doesn't ship Widevine/FairPlay CDM. MusicKit probes for a key system
// via navigator.requestMediaKeySystemAccess() before setting nowPlayingItem;
// if none found it throws CONTENT_UNSUPPORTED and nowPlayingItemDidChange never
// fires. We stub the probe so MusicKit proceeds to change the queue, then our
// MSE pipeline takes over. Since MSE pipes raw AAC (no encryption), no actual
// DRM license is ever requested.

// ── CDN blocker (prototype-level, runs at parse time) ─────────────────────────

function blockAppleCDN() {
    if (window.__amlCDNBlocked) return;
    window.__amlCDNBlocked = true;

    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    _nativeSrcSet = desc.set;
    _nativeCTSet  = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime').set;

    const isAppleCDN = url =>
        url && !url.startsWith('blob:') && !url.startsWith('data:') && url !== '' &&
        /mzstatic\.com|audio-ssl\.itunes\.apple\.com|akamaized\.net|cdn-apple\.com/i.test(url);

    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        get: desc.get,
        set(val) {
            if (isAppleCDN(val)) { console.log('[AML Engine] Blocked CDN src:', val.slice(0, 80)); return; }
            if (val?.startsWith('blob:') && _ourBlobUrl && val !== _ourBlobUrl) { return; }
            desc.set.call(this, val);
        },
        configurable: true,
        enumerable: desc.enumerable,
    });

    const realSetAttr = HTMLMediaElement.prototype.setAttribute;
    HTMLMediaElement.prototype.setAttribute = function(name, val) {
        if (name === 'src' && isAppleCDN(val)) return;
        return realSetAttr.call(this, name, val);
    };

    console.log('[AML Engine] Apple CDN audio blocked');
}

// ── Play proxy (instance-level, installed lazily on first track change) ────────

let _proxyInstalled = false;

/**
 * Override audio.play() on the element instance.
 *
 * MK calls audio.play() before our MSE stream has data.  If we returned a
 * Promise that eventually resolved, MK's "after play() settled" handler would
 * run and call audio.pause() — because it detects CDN loading never completed.
 * Instead we return a Promise that never resolves; MK's handler never fires.
 * MK's state machine still transitions to "playing" through DOM events
 * (the 'playing' event from _nativePlay() in our canplay handler).
 */
function installPlayProxy(mkAudio) {
    if (_proxyInstalled) return;
    _proxyInstalled = true;

    _nativePlay = HTMLMediaElement.prototype.play.bind(mkAudio);

    const _resolvers = [];
    mkAudio.addEventListener('playing', () => {
        const batch = _resolvers.splice(0);
        batch.forEach(r => r());
    });

    mkAudio.play = () => {
        if (_vlcMode) {
            // Push a resolver BEFORE dispatching 'playing' so the event resolves it
            // synchronously.  MK's AudioPlayer awaits this Promise for its state
            // transition — the never-resolving version caused MK to hang in paused
            // state forever after the first manual pause/resume cycle.
            console.log(`[AML VLC] audio.play() → resume`);
            _vlcPaused = false;
            const p = new Promise(resolve => _resolvers.push(resolve));
            mkAudio.dispatchEvent(new Event('playing')); // fires listener above synchronously → resolves p
            // While VLC is still opening, follow with 'waiting' so MK shows a
            // buffering indicator instead of the playing animation. The poll clears
            // this by dispatching 'playing' once VLC enters 'playing' state.
            if (_vlcLoading) mkAudio.dispatchEvent(new Event('waiting'));
            fetch(`${ENGINE}/api/v1/vlc/resume`, { method: 'POST' }).catch(() => {});
            return p;
        }
        // MSE mode: if the user explicitly paused, block MK's internal play()
        // retries from overriding the manual pause state.
        if (_msePaused) return new Promise(() => {});
        if (!_sessionId) return new Promise(() => {}); // no session yet: stay pending
        // Same synchronous-resolve trick as VLC so MK's state machine settles into
        // "playing" before its "after play() settled" handler runs.
        const p = new Promise(resolve => _resolvers.push(resolve));
        mkAudio.dispatchEvent(new Event('playing')); // resolves p synchronously
        _nativePlay().catch(() => {});
        return p;
    };

    console.log('[AML Engine] Play proxy installed');
}

function installMKSeekInterceptor(mk) {
    if (mk.__amlSeekIntercepted) return;
    mk.__amlSeekIntercepted = true;

    const _origSeek = mk.seekToTime.bind(mk);

    mk.seekToTime = async function(seekSec) {
        const audio = getMKAudio();
        if (_vlcMode) {
            _vlcPosMs = Math.round(seekSec * 1000);
            _vlcSeekFrozen = true;
            console.log(`[AML VLC] seekToTime(${seekSec.toFixed(3)})  target=${_vlcPosMs}ms  debounce-reset`);
            if (audio) {
                audio.dispatchEvent(new Event('seeking'));
                audio.dispatchEvent(new Event('seeked'));
            }
            clearTimeout(_vlcSeekTimer);
            _vlcSeekTimer = setTimeout(async () => {
                _vlcSeekTimer = null;
                console.log(`[AML VLC] seek FIRE  posMs=${_vlcPosMs}`);
                // Signal MK to show a buffering/loading indicator while VLC loads
                // the new segment stream. The poll will dispatch 'playing' once VLC
                // actually starts playing at the seek position.
                getMKAudio()?.dispatchEvent(new Event('waiting'));
                const seekTarget = _vlcPosMs;
                let actualStartMs = seekTarget;
                try {
                    const t0 = performance.now();
                    const seekResp = await fetch(`${ENGINE}/api/v1/vlc/seek`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ posMs: seekTarget, sessionId: _sessionId }),
                    });
                    const seekData = await seekResp.json().catch(() => ({}));
                    actualStartMs = seekData.actualStartMs ?? seekTarget;
                    console.log(`[AML VLC] seek DONE  target=${seekTarget}ms  actualStart=${actualStartMs}ms  rtt=${(performance.now()-t0).toFixed(0)}ms`);
                    // Snap position to the requested target so UI stays in sync while VLC loads.
                    _vlcPosMs = seekTarget;
                } catch (e) {
                    console.warn(`[AML VLC] seek ERROR`, e);
                }
                // VLC reports absolute fMP4 timestamps (tfdt), so no offset is needed.
                // _vlcPosMs = posMs (raw VLC time) gives the correct absolute position.
                _vlcSeekOffsetMs = 0;
                _vlcPrevState = null;          // force poll to re-emit 'playing', cancelling 'waiting'
                _vlcSeekFrozen = false;
                _seekBurstLog = 15;            // log every tick for 15 ticks (3.75s) after seek
                console.log(`[AML VLC] seek UNFREEZE`);
                // Emit Seeked signal so MPRIS clients re-anchor their seek bar.
                window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1000, seeked: true });
            }, 150);
        } else {
            // MSE path: set currentTime via the native prototype setter.
            // This fires the DOM 'seeking' event which our onSeeking handler
            // (installed after canplay) picks up to call mseSeekToTime().
            _ourSeekPending = true;
            _ourSeekTarget  = seekSec;
            if (audio) _nativeCTSet.call(audio, seekSec);
        }
    };

    console.log('[AML Engine] MK seek interceptor installed');
}

// ── MusicKit helpers ──────────────────────────────────────────────────────────

function getMKAudio() {
    return document.getElementById('apple-music-player') || document.querySelector('audio') || null;
}


function waitForMusicKit() {
    return new Promise(resolve => {
        const check = () => {
            try {
                const mk = window.MusicKit?.getInstance?.();
                if (mk && 'nowPlayingItem' in mk) return resolve(mk);
            } catch (_) {}
            setTimeout(check, 50);
        };
        check();
    });
}

function getMUT() {
    const c = document.cookie.split(';').find(s => s.trim().startsWith('media-user-token='));
    return c ? decodeURIComponent(c.trim().slice('media-user-token='.length)) : '';
}

// ── Duration bridge ───────────────────────────────────────────────────────────

let _mkInstance = null;

function bridgeDuration(mk, durationSec) {
    _mkInstance = mk;
    try {
        Object.defineProperty(mk, 'currentPlaybackDuration', {
            get: () => durationSec, configurable: true,
        });
    } catch (_) {}
    const item = mk.nowPlayingItem;
    if (item && durationSec > 0) {
        const durMs = Math.round(durationSec * 1000);
        for (const obj of [item, item.attributes].filter(Boolean)) {
            try { Object.defineProperty(obj, 'durationInMillis', { get: () => durMs, configurable: true }); }
            catch (_) {}
        }
    }
}

function unbridgeDuration() {
    if (_mkInstance) {
        try { delete _mkInstance.currentPlaybackDuration; } catch (_) {}
        _mkInstance = null;
    }
}

// ── Session state ─────────────────────────────────────────────────────────────

let _sessionId      = null;
let _currentAssetId = null;
let _durationSec = 0;
let _abortCtrl   = null;   // session-level abort — killed on track change
let _generation  = 0;
let _videoCodec  = null;   // HLS CODECS= for the video track (MV sessions only)
let _mvMaxHeight    = parseInt(localStorage.getItem('aml-mv-quality') || '1080', 10); // 480/720/1080/2160
let _mvVideoHeights = []; // available variant heights from HLS master, set per-session

// ── Quality badge ─────────────────────────────────────────────────────────────

function showQualityBadge(codec, sampleRate, bitDepth, spatialAudio) {
    let badge = document.getElementById('aml-quality-badge');

    let text, color;
    if (spatialAudio === 'binaural-lossless' || spatialAudio === 'binaural') {
        text  = 'SPATIAL AUDIO';
        color = '#bf5af2';
    } else if (codec === 'alac') {
        const hiRes = sampleRate > 48000 || bitDepth > 16;
        text  = hiRes
            ? `HI-RES LOSSLESS  ·  ${(sampleRate / 1000).toFixed(0)} kHz / ${bitDepth}-bit`
            : 'LOSSLESS';
        color = '#30d158';
    } else {
        if (badge) badge.style.display = 'none';
        return;
    }

    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'aml-quality-badge';
        badge.style.cssText =
            'font-size:8px;font-weight:700;letter-spacing:.07em;' +
            'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;' +
            'border-radius:3px;' +
            'padding:1px 4px;pointer-events:none;z-index:9999;white-space:nowrap;';

        // Inject into the player LCD area so it moves with the player.
        // Fall back to a fixed overlay if the LCD isn't in the DOM yet.
        const lcd = document.querySelector('.player-lcd');
        if (lcd) {
            if (getComputedStyle(lcd).position === 'static') lcd.style.position = 'relative';
            badge.style.position = 'absolute';
            badge.style.bottom   = '3px';
            badge.style.left     = '4px';
            lcd.appendChild(badge);
        } else {
            badge.style.position  = 'fixed';
            badge.style.bottom    = '14px';
            badge.style.left      = '50%';
            badge.style.transform = 'translateX(-50%)';
            document.body.appendChild(badge);
        }
    }

    badge.style.color  = color;
    badge.style.border = `1px solid ${color}`;
    badge.textContent  = text;
    badge.style.display = '';
}

function deleteSession(id) {
    if (id) fetch(`${ENGINE}/api/v1/playback/${id}`, { method: 'DELETE' }).catch(() => {});
}

// ── MSE pipe + seek (AAC path) ────────────────────────────────────────────────

async function pipeToSourceBuffer(sb, audio, streamUrlOrResp, signal, ms, durationSec, t0) {
    const localSessionId = _sessionId;
    let resp;
    if (typeof streamUrlOrResp === 'string') {
        resp = await fetch(streamUrlOrResp, { signal });
        if (!resp.ok) throw new Error(`Engine stream ${resp.status}`);
        console.log(`[AML Engine] Stream open +${((performance.now()-t0)/1000).toFixed(2)}s`);
    } else {
        resp = streamUrlOrResp;
        console.log(`[AML Engine] Stream open (seek) +${((performance.now()-t0)/1000).toFixed(2)}s`);
    }

    const reader = resp.body.getReader();
    let chunks = 0;
    try {

    const waitUpdate = () => new Promise((res, rej) => {
        if (!sb.updating) return res();
        const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); res(); };
        const fail = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); rej(new Error(`SB error chunk ${chunks}`)); };
        sb.addEventListener('updateend', done, { once: true });
        sb.addEventListener('error',     fail, { once: true });
    });

    const sbRemove = async (start, end) => {
        if (ms.readyState !== 'open' || end <= start) return;
        await waitUpdate();
        if (ms.readyState !== 'open') return;
        await new Promise((res, rej) => {
            sb.addEventListener('updateend', res, { once: true });
            sb.addEventListener('error',     rej, { once: true });
            sb.remove(start, end);
        });
    };

    const FORWARD_SECS  = 900;
    const BACKWARD_SECS = 900;

    const evictPlayed = async (aggressiveSecs = BACKWARD_SECS) => {
        if (ms.readyState !== 'open' || sb.buffered.length === 0) return;
        const evictEnd = Math.max(0, audio.currentTime - aggressiveSecs);
        if (evictEnd > sb.buffered.start(0) + 1) await sbRemove(sb.buffered.start(0), evictEnd);
    };

    while (true) {
        if (signal.aborted) throw new Error('aborted');
        const { done, value } = await reader.read();
        if (done) {
            console.log(`[AML Engine] Stream done (${chunks} chunks) +${((performance.now()-t0)/1000).toFixed(2)}s`);
            break;
        }
        chunks++;

        if (ms.readyState !== 'open' || audio.error) throw new Error(`MediaSource closed or audio error: ms=${ms.readyState} err=${audio.error?.code}`);

        if (_chunkCache && _chunkCache.sessionId === localSessionId &&
                _chunkCache.byteSize < 80 * 1024 * 1024) {
            const copy = new Uint8Array(value.byteLength);
            copy.set(value);
            _chunkCache.chunks.push(copy);
            _chunkCache.byteSize += value.byteLength;
        }

        if (sb.buffered.length > 0 && audio.currentTime > sb.buffered.start(0) + BACKWARD_SECS + 1) {
            await evictPlayed();
        }

        while (ms.readyState === 'open' && sb.buffered.length > 0 &&
               (sb.buffered.end(sb.buffered.length - 1) - audio.currentTime) > FORWARD_SECS) {
            if (signal.aborted) throw new Error('aborted');
            await new Promise(r => setTimeout(r, 500));
        }

        await waitUpdate();
        if (signal.aborted) throw new Error('aborted');
        if (ms.readyState !== 'open' || audio.error) throw new Error(`MediaSource closed or audio error [post-wait]: ms=${ms.readyState} err=${audio.error?.code}`);
        try {
            sb.appendBuffer(value);
        } catch (e) {
            if (e.name === 'InvalidStateError') {
                // Browser triggered an internal buffer op between our waitUpdate() check and
                // appendBuffer() — typically happens when video playback starts mid-pipe.
                await waitUpdate();
                if (signal.aborted) throw new Error('aborted');
                sb.appendBuffer(value);
            } else if (e.name === 'QuotaExceededError') {
                let appended = false;
                for (let attempt = 0; !appended; attempt++) {
                    await new Promise(r => setTimeout(r, 300));
                    if (signal.aborted) throw new Error('aborted');
                    await evictPlayed(attempt >= 2 ? 30 : BACKWARD_SECS);
                    await waitUpdate();
                    try { sb.appendBuffer(value); appended = true; }
                    catch (e2) { if (e2.name !== 'QuotaExceededError') throw e2; }
                }
            } else { throw e; }
        }
    }

    await waitUpdate();
    if (!signal.aborted && ms.readyState === 'open') {
        if (durationSec > 0) { try { ms.duration = durationSec; } catch (_) {} }
        ms.endOfStream();
        _streamComplete = true;
        console.log(`[AML Engine] Stream complete +${((performance.now()-t0)/1000).toFixed(2)}s`);
    }
    } finally {
        reader.cancel().catch(() => {});
    }
}

async function mseSeekToTime(seekSec, audio, sb, ms) {
    if (ms.readyState === 'closed') return;
    const bufferedRanges = Array.from({length: sb.buffered.length}, (_, i) =>
        `[${sb.buffered.start(i).toFixed(1)},${sb.buffered.end(i).toFixed(1)}]`).join(' ');
    console.log(`[AML MSE] seekToTime(${seekSec.toFixed(2)}) ct=${audio.currentTime.toFixed(2)} buffered=${bufferedRanges||'(empty)'} seekable=${_seekable}`);

    // Already buffered — let the browser handle it natively.
    for (let i = 0; i < sb.buffered.length; i++) {
        if (seekSec >= sb.buffered.start(i) - 1.0 && seekSec < sb.buffered.end(i) + 1.0) {
            console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s → native (buffered)`);
            _seekTarget = -Infinity;
            const wasPlaying = !audio.paused;
            audio.addEventListener('seeked', () => {
                if (wasPlaying && audio.paused) _nativePlay().catch(() => {});
            }, { once: true });
            return;
        }
    }

    // Cache re-inject path (backward seeks outside buffer).
    if (_chunkCache && _chunkCache.sessionId === _sessionId && _chunkCache.chunks.length > 0) {
        if (Math.abs(_seekTarget - seekSec) < 0.5) {
            console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s → cache guard`);
            return;
        }
        _seekTarget = seekSec;
        const wasPlaying = !audio.paused;
        const cacheSnap = _chunkCache;
        const wasStreamComplete = _streamComplete;
        _streamComplete = false;

        if (_seekFetchCtrl) { _seekFetchCtrl.abort(); }
        _seekFetchCtrl = new AbortController();
        const mySC = _seekFetchCtrl;

        if (_pipeCtrl) { _pipeCtrl.abort(); _pipeCtrl = null; }
        _pipeCtrl = new AbortController();
        const pipeCtrl = _pipeCtrl;

        console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s → cache re-inject (${(cacheSnap.byteSize / 1e6).toFixed(1)} MB)`);

        const waitIdle = () => new Promise((res, rej) => {
            if (!sb.updating) return res();
            const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); res(); };
            const fail = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); rej(new Error('SB error during cache re-inject')); };
            sb.addEventListener('updateend', done, { once: true });
            sb.addEventListener('error',     fail, { once: true });
        });

        (async () => {
            try {
                await waitIdle();
                if (pipeCtrl.signal.aborted || ms.readyState !== 'open') return;
                if (sb.buffered.length > 0) sb.remove(0, Infinity);
                await waitIdle();
                // Discard decoded frames before seekSec so playback starts sample-
                // accurately at the target without MDCT warmup artifacts.
                // Reset to 0 in the canplay handler after the seek resolves.
                try { sb.appendWindowStart = seekSec; } catch (_) {}
                for (const chunk of cacheSnap.chunks) {
                    if (pipeCtrl.signal.aborted) return;
                    await waitIdle();
                    if (pipeCtrl.signal.aborted || ms.readyState !== 'open') return;
                    try { sb.appendBuffer(chunk); }
                    catch (e) { if (e.name === 'QuotaExceededError') console.warn('[AML MSE] cache re-inject quota exceeded'); return; }
                }
                if (pipeCtrl.signal.aborted || _seekFetchCtrl !== mySC) return;
                await waitIdle();
                if (wasStreamComplete) {
                    if (ms.readyState === 'open') {
                        if (_durationSec > 0) { try { ms.duration = _durationSec; } catch (_) {} }
                        ms.endOfStream(); _streamComplete = true;
                    }
                } else if (_seekable && _activeStreamBase) {
                    const bufEnd = sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : seekSec;
                    let resumeResp;
                    try { resumeResp = await fetch(`${_activeStreamBase}&t=${bufEnd.toFixed(3)}`, { signal: pipeCtrl.signal }); }
                    catch (_) { return; }
                    if (!resumeResp.ok || pipeCtrl.signal.aborted || _seekFetchCtrl !== mySC) { resumeResp?.body?.cancel(); return; }
                    await pipeToSourceBuffer(sb, audio, resumeResp, pipeCtrl.signal, ms, _durationSec, performance.now());
                }
            } catch (e) {
                if (!pipeCtrl.signal.aborted) console.error('[AML MSE] cache re-inject error:', e.message);
            }
        })();

        // Set currentTime before re-inject so the browser positions itself once
        // the buffer covers seekSec (appendWindowStart filters earlier frames).
        try { _nativeCTSet.call(audio, seekSec); } catch (_) {}

        audio.addEventListener('canplay', () => {
            if (pipeCtrl.signal.aborted) return;
            try { sb.appendWindowStart = 0; } catch (_) {}
            _seekTarget = -Infinity;
            if (wasPlaying) _nativePlay().catch(() => {});
        }, { once: true });
        return;
    }

    if (!_seekable) { console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s → not seekable`); return; }

    if (_streamComplete) { _seekTarget = -Infinity; _streamComplete = false; }

    if (Math.abs(_seekTarget - seekSec) < 0.5) { console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s → guard`); return; }
    _seekTarget = seekSec;

    const wasPlaying = !audio.paused;

    if (_seekFetchCtrl) { _seekFetchCtrl.abort(); }
    _seekFetchCtrl = new AbortController();
    const mySeekCtrl = _seekFetchCtrl;

    const seekUrl = `${_activeStreamBase}&t=${seekSec.toFixed(3)}`;
    let resp;
    try {
        resp = await fetch(seekUrl, { signal: AbortSignal.any([mySeekCtrl.signal, _abortCtrl?.signal].filter(Boolean)) });
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[AML MSE] Seek fetch error:', e.message);
        return;
    }
    if (!resp.ok) { console.warn(`[AML MSE] Seek ${resp.status} — not seekable`); return; }
    if (_abortCtrl?.signal.aborted || _seekFetchCtrl !== mySeekCtrl) { resp.body?.cancel(); return; }

    const actualStart = parseFloat(resp.headers.get('X-Actual-Start') ?? seekSec);
    console.log(`[AML MSE] Seek → ${seekSec.toFixed(2)}s (actual=${actualStart.toFixed(2)}s)`);

    if (_pipeCtrl) { _pipeCtrl.abort(); _pipeCtrl = null; }

    const waitSBIdle = () => new Promise((res, rej) => {
        if (!sb.updating) return res();
        const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); res(); };
        const fail = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); rej(new Error('SB error during seek')); };
        sb.addEventListener('updateend', done, { once: true });
        sb.addEventListener('error',     fail, { once: true });
    });

    try { await waitSBIdle(); if (ms.readyState === 'open') sb.remove(0, Infinity); await waitSBIdle(); } catch (_) {}

    // Strip decoded frames before seekSec — the engine's sub-segment trimming
    // (PassthroughStreaming) already drops fMP4 fragments ending before seekSec,
    // so appendWindowStart handles the sub-frame boundary and MDCT pre-roll.
    // Reset to 0 in canplay after the seek resolves.
    try { sb.appendWindowStart = seekSec; } catch (_) {}

    // Tell the browser where we want to resume BEFORE the pipe starts filling.
    // It waits for the buffer to cover seekSec, then resolves the seek naturally.
    // onSeeking ignores this (_ourSeekPending=false) so no seek loop.
    try { _nativeCTSet.call(audio, seekSec); } catch (_) {}

    _pipeCtrl = new AbortController();
    const pipeCtrl = _pipeCtrl;

    pipeToSourceBuffer(sb, audio, resp, pipeCtrl.signal, ms, _durationSec, performance.now()).catch(e => {
        if (!pipeCtrl.signal.aborted) console.error('[AML MSE] Seek pipe error:', e.message);
    });

    audio.addEventListener('canplay', () => {
        if (pipeCtrl.signal.aborted) return;
        try { sb.appendWindowStart = 0; } catch (_) {}
        _seekTarget = -Infinity;
        console.log(`[AML MSE] Seek ready — req=${seekSec.toFixed(2)}s actual=${actualStart.toFixed(2)}s ct=${audio.currentTime.toFixed(2)}s`);
        if (wasPlaying) _nativePlay().catch(e => console.warn('[AML MSE] seek play():', e));
    }, { once: true });
}

// ── VLC poll ──────────────────────────────────────────────────────────────────

function stopVLCPoll() {
    if (_vlcPollTimer) { clearInterval(_vlcPollTimer); _vlcPollTimer = null; }
}

// Wait for the MV full-screen container: DIV.container.takeover inside amp-window-takeover.
// amp-window-takeover has no shadow root — .container is plain light DOM.
// DOM: apple-music-video-player shadowRoot → amp-window-takeover → DIV.container.takeover.show
// The container is 908×513, position:fixed, z-index:20 — the actual full player window.
// amp-video-player-internal sits inside it at top:256.5px (only 185px tall, hence the thin strip bug).
function getMVContainer(signal, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
            if (signal.aborted) return;
            const awk = document.querySelector('apple-music-video-player')
                ?.shadowRoot?.querySelector('amp-window-takeover');
            const c = awk?.querySelector('.container.takeover');
            if (c && c.offsetHeight > 0) { resolve(c); return; }
            if (Date.now() > deadline) { reject(new Error('MV container not found')); return; }
            setTimeout(poll, 100);
        };
        poll();
    });
}

async function startMVPipeline() {
    const _mvGen = _generation; // capture at entry; if a second handleTrackChange fires, _generation will differ
    console.log(`[AML MV-V] enter gen=${_mvGen} session=${_sessionId} t=${Date.now()}`);

    // Video: wait for DIV.container.takeover inside amp-window-takeover (the real full-screen
    // player — 908×513, position:fixed, z-index:20). amp-video-player-internal sits inside it
    // at top:256.5px and is only 185px tall, which caused the thin-strip aspect-ratio bug.
    let mvContainer;
    try {
        mvContainer = await getMVContainer(_abortCtrl.signal);
        console.log(`[AML MV] container found ${mvContainer.offsetWidth}×${mvContainer.offsetHeight}`);
    } catch (e) {
        console.warn('[AML MV] MV container not found, aborting:', e.message);
        return;
    }


    // amp-video-player-internal sits at top:256.5px / 185px tall inside the 513px container.
    // Expand it to fill the full container and feed our MSE directly to its native <video>
    // element so the native controls (scrim, title, progress bar) work correctly.
    const avpi = mvContainer.querySelector('amp-video-player-internal');
    const avp  = avpi?.shadowRoot?.querySelector('amp-video-player');
    const avpShadow = avp?.shadowRoot;
    const vcDiv = avpShadow?.querySelector('#video-container');
    const nativeVidEl = avpShadow?.querySelector('#apple-music-video-player') ?? avpShadow?.querySelector('video');
    console.log(`[AML MV-V] shadow traversal: avpi=${!!avpi} avp=${!!avp} avpShadow=${!!avpShadow} vcDiv=${!!vcDiv} nativeVidEl=${!!nativeVidEl} nativeVidEl.id=${nativeVidEl?.id} nativeVidEl.src="${nativeVidEl?.src?.slice(0,60)}"`);

    // ── Counter-pause interceptor ────────────────────────────────────────────────
    // Apple Music saves HTMLMediaElement.prototype.pause at page-load ('savedPause').
    // Their 'playing' listener calls savedPause.call(nativeVidEl) — bypassing instance
    // and prototype overrides. BUT: savedPause.call() is a JS property lookup that
    // resolves through Function.prototype.call, so our override catches it.
    // _nativePauseRef === savedPause (same reference). Reflect.apply prevents recursion.
    if (nativeVidEl) {
        const _vidRef = nativeVidEl;
        Function.prototype.call = function(ctx, ...args) {
            if (this === _nativePauseRef && ctx === _vidRef) {
                console.warn('[AML MV] intercepted savedPause.call(nativeVidEl) — counter-pause blocked. Stack:', new Error().stack.split('\n').slice(1, 4).join(' | '));
                return;
            }
            return Reflect.apply(_origFnCall, this, [ctx, ...args]);
        };
        Function.prototype.apply = function(ctx, args) {
            if (this === _nativePauseRef && ctx === _vidRef) {
                console.warn('[AML MV] intercepted savedPause.apply(nativeVidEl) — counter-pause blocked.');
                return;
            }
            return Reflect.apply(_origFnApply, this, [ctx, args]);
        };
        console.log('[AML MV] Function.prototype.call/apply intercept installed for counter-pause');
    }

    // ── Fullscreen redirect ──────────────────────────────────────────────────────
    // Redirect ALL requestFullscreen() calls (from our UI or from Apple Music's own
    // keyboard handlers) to document.documentElement so the entire overlay (video +
    // controls) enters fullscreen as one unit.  Without this, AML's native keyboard
    // shortcut may fullscreen only nativeVidEl, showing video without our UI, while
    // our button fullscreens only the document, occasionally without the video.
    const _origReqFS = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function(opts) {
        return _origReqFS.call(document.documentElement, opts);
    };

    // ── Container: full-viewport overlay (Layer 2) ──────────────────────────────
    // Force mvContainer to cover the entire viewport. avpi's internal top:256.5px
    // layout becomes irrelevant — myVid centers in the full viewport via CSS transform.
    const _containerProps = ['position','top','left','width','height','z-index','background','display','justify-content','align-content'];
    mvContainer.style.setProperty('position', 'fixed', 'important');
    mvContainer.style.setProperty('top', '0', 'important');
    mvContainer.style.setProperty('left', '0', 'important');
    mvContainer.style.setProperty('width', '100vw', 'important');
    mvContainer.style.setProperty('height', '100vh', 'important');
    mvContainer.style.setProperty('z-index', '999990', 'important');
    mvContainer.style.setProperty('background', '#000', 'important');
    mvContainer.style.setProperty('display', 'flex', 'important');
    mvContainer.style.setProperty('justify-content', 'center', 'important');
    mvContainer.style.setProperty('align-content', 'center', 'important');
    mvContainer.style.setProperty('cursor', 'default', 'important');

    // ── Video element (Layer 3) ──────────────────────────────────────────────────
    // CSS transform centering: top:50%+left:50%+translate(-50%,-50%) places the video
    // at the true viewport center regardless of avpi's internal layout offsets.
    const myVid = document.createElement('video');
    myVid.muted = true; // audio is on mkAudio
    myVid.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:100%;height:100%;object-fit:contain;z-index:1;pointer-events:none;';

    // Separate audio element — own MSE, own SB, pipeToSourceBuffer handles everything.
    const mkAudio = document.createElement('audio');
    mkAudio.style.display = 'none';
    document.body.appendChild(mkAudio);
    mvContainer.insertAdjacentElement('afterbegin', myVid);
    if (nativeVidEl) nativeVidEl.style.opacity = '0';
    // Suppress CDN-buffering events from nativeVidEl that cause MK loading-indicator blinking.
    // nativeVidEl keeps loading from Apple CDN in the background; its waiting/stalled/suspend
    // events propagate to MK's state machine and toggle the loading spinner continuously.
    const _nativeVidStopEvt = e => e.stopImmediatePropagation();
    if (nativeVidEl) {
        ['waiting', 'stalled', 'suspend'].forEach(evt =>
            nativeVidEl.addEventListener(evt, _nativeVidStopEvt, true)
        );
    }

    // ── Subtitle / CC overlay ────────────────────────────────────────────────────
    // myVid is fed the real H.264 fMP4; Chromium extracts EIA-608/WebVTT cues from
    // the video stream and surfaces them as TextTrack objects on myVid. We render
    // them ourselves so they appear on top of our video overlay, not on nativeVidEl.
    const _subDiv = document.createElement('div');
    _subDiv.style.cssText = 'position:absolute;bottom:90px;left:5%;right:5%;text-align:center;z-index:20;pointer-events:none;font-family:inherit;';
    mvContainer.appendChild(_subDiv);
    // _ccEnabled: follows native CC button. Default true — show if tracks exist.
    // Chromium extracts EIA-608 CC from the H.264 MSE stream and surfaces them as
    // TextTrack objects on myVid. We render them ourselves (mode='hidden') so cues
    // appear on our overlay, not on the hidden nativeVidEl.
    let _ccEnabled = true;

    const _renderSubs = () => {
        if (!_ccEnabled) { _subDiv.innerHTML = ''; return; }
        const lines = [];
        for (let i = 0; i < myVid.textTracks.length; i++) {
            const track = myVid.textTracks[i];
            if (track.mode === 'disabled') continue;
            const cues = track.activeCues;
            for (let j = 0; j < (cues?.length ?? 0); j++) {
                const cue = cues[j];
                const text = (cue instanceof VTTCue && cue.getCueAsHTML)
                    ? cue.getCueAsHTML().textContent
                    : (cue.text ?? '');
                if (text.trim()) lines.push(text.replace(/<[^>]+>/g, '').trim());
            }
        }
        if (lines.length) {
            _subDiv.innerHTML = `<span style="display:inline-block;background:rgba(0,0,0,0.72);color:#fff;padding:3px 10px;border-radius:4px;font-size:1.05em;line-height:1.45;white-space:pre-wrap;max-width:80%">${lines.map(l => l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')).join('\n')}</span>`;
        } else {
            _subDiv.innerHTML = '';
        }
    };

    const _attachTrack = track => {
        if (track.kind !== 'captions' && track.kind !== 'subtitles') return;
        track.mode = 'hidden'; // activeCues populated, no native rendering (we do it)
        track.addEventListener('cuechange', _renderSubs);
    };
    for (let i = 0; i < myVid.textTracks.length; i++) _attachTrack(myVid.textTracks[i]);
    myVid.textTracks.addEventListener('addtrack', e => _attachTrack(e.track));
    // Expand avpi + avp to fill the entire container so the native scrim controls
    // span the full viewport (header at top, footer at bottom, clickable in between).
    // Cancel Apple Music's transform:translateY(-256.5px) animation on avpi. Without
    // this, avpi starts at top:0 (our override) but the translateY pushes it to y=-256.5
    // (off-screen above viewport), making scrimClickable cover only the bottom portion.
    const _avpiProps = ['position','top','left','width','height','background','transform'];
    if (avpi) {
        avpi.style.setProperty('position', 'absolute', 'important');
        avpi.style.setProperty('top', '0', 'important');
        avpi.style.setProperty('left', '0', 'important');
        avpi.style.setProperty('width', '100%', 'important');
        avpi.style.setProperty('height', '100%', 'important');
        avpi.style.setProperty('background', 'transparent', 'important');
        avpi.style.setProperty('transform', 'none', 'important');
    }
    const avpEl = avpi?.shadowRoot?.querySelector('amp-video-player');
    if (avpEl) {
        avpEl.style.setProperty('width', '100%', 'important');
        avpEl.style.setProperty('height', '100%', 'important');
        avpEl.style.setProperty('background', 'transparent', 'important');
    }
    if (vcDiv) {
        vcDiv.style.setProperty('width', '100%', 'important');
        vcDiv.style.setProperty('height', '100%', 'important');
        vcDiv.style.setProperty('background', 'transparent', 'important');
    }

    // Force the native .gradient div visible — Apple Music hides it when no native video
    // is active. It adds top/bottom dark vignette over the video frame.
    const gradientDiv = avpShadow?.querySelector('.gradient');
    if (gradientDiv) {
        gradientDiv.style.setProperty('display', 'block', 'important');
        gradientDiv.style.setProperty('opacity', '1', 'important');
        gradientDiv.style.setProperty('visibility', 'visible', 'important');
        gradientDiv.style.setProperty('pointer-events', 'none', 'important');
        gradientDiv.style.setProperty('transition', 'opacity 0.3s ease', 'important');
    }
    const nativeVidInVc = vcDiv?.querySelector('video');
    if (nativeVidInVc && nativeVidInVc !== nativeVidEl) {
        nativeVidInVc.style.setProperty('display', 'none', 'important');
    }

    const mvPlay  = () => { _iframePlay.call(myVid).then(() => mkAudio.play().catch(() => {})).catch(() => {}); };
    const mvPause = () => { myVid.pause(); mkAudio.pause(); };
    const togglePlayPause = () => { if (myVid.paused) mvPlay(); else mvPause(); };

    // ── Fullscreen ────────────────────────────────────────────────────────────
    const toggleFullscreen = () => {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else {
            // Use documentElement — requesting fullscreen on a shadow DOM element is
            // unreliable in Electron/Chromium and causes a black video frame.
            // mvContainer is already position:fixed; width:100vw so it covers the screen.
            document.documentElement.requestFullscreen?.().catch(() => {});
        }
    };
    const onFullscreenChange = () => {
        // Re-fit scrim to video bounds after the viewport size changes.
        _resizeScrim();
        // Force mvContainer dimensions in case fullscreen collapses fixed sizing.
        mvContainer.style.setProperty('width',  '100%',  'important');
        mvContainer.style.setProperty('height', '100%',  'important');
        setTimeout(_resizeScrim, 100); // second pass after browser reflow
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // ── Scrim elements (Layers 4 & 5) ───────────────────────────────────────────
    const scrimEl        = avpShadow?.querySelector('.scrim');
    const scrimClickable = avpShadow?.querySelector('.scrim__clickable');
    const scrimHeader    = avpShadow?.querySelector('.scrim__header');
    const scrimFooter    = avpShadow?.querySelector('.scrim__footer');
    const scrimInfo      = avpShadow?.querySelector('.scrim__info');
    const exitBtn        = mvContainer.querySelector('amp-playback-controls-exit');

    // Fit avpi (and thus avp + scrim) to the rendered video area, excluding letterbox bars.
    // Native scrim is display:grid with children at position:static — the grid distributes
    // space correctly once avpi height matches the actual video frame height.
    const _resizeScrim = () => {
        const cw = mvContainer.offsetWidth  || window.innerWidth;
        const ch = mvContainer.offsetHeight || window.innerHeight;
        const vw = myVid.videoWidth, vh2 = myVid.videoHeight;
        let lv = 0, lh = 0;
        if (vw && vh2) {
            const vr = vw / vh2, cr = cw / ch;
            if (vr > cr) lv = Math.round((ch - cw / vr) / 2);   // wide video → top/bottom bars
            else         lh = Math.round((cw - ch * vr) / 2);    // tall video → left/right bars
        }
        if (avpi) {
            avpi.style.setProperty('top',    lv + 'px', 'important');
            avpi.style.setProperty('left',   lh + 'px', 'important');
            avpi.style.setProperty('width',  (cw - 2 * lh) + 'px', 'important');
            avpi.style.setProperty('height', (ch - 2 * lv) + 'px', 'important');
        }
    };
    myVid.addEventListener('loadedmetadata', _resizeScrim);
    myVid.addEventListener('resize', _resizeScrim);
    const _scrimResizeObs = new ResizeObserver(_resizeScrim);
    _scrimResizeObs.observe(mvContainer);
    _resizeScrim();

    // Force scrim visible — Apple Music keeps opacity:0 when native video isn't playing.
    // Don't override display/position: native display:grid + position:relative is correct,
    // the grid distributes header/info/footer rows automatically via named grid areas.
    if (scrimEl) {
        scrimEl.style.setProperty('opacity', '1', 'important');
        scrimEl.style.setProperty('visibility', 'visible', 'important');
        scrimEl.style.setProperty('transition', 'opacity 0.3s ease', 'important');
        scrimEl.style.setProperty('cursor', 'default', 'important');
    }

    // scrimClickable: native gridArea "1/1/-3/-1" (spans rows 1–4, covers everything above footer).
    // position:static in the native grid — no override needed.
    if (scrimClickable) {
        scrimClickable.style.setProperty('pointer-events', 'auto', 'important');
        scrimClickable.style.setProperty('cursor', 'default', 'important');
    }

    // scrimHeader: hide — exitBtn (amp-playback-controls-exit) handles the X button.
    if (scrimHeader) scrimHeader.style.setProperty('display', 'none', 'important');

    // scrimFooter/scrimInfo: native CSS grid positions them. Force visibility + pointer-events
    // so slotted buttons (skip, play, fullscreen) actually receive clicks.
    if (scrimFooter) {
        scrimFooter.style.setProperty('opacity', '1', 'important');
        scrimFooter.style.setProperty('visibility', 'visible', 'important');
        scrimFooter.style.setProperty('pointer-events', 'auto', 'important');
    }
    if (scrimInfo) {
        scrimInfo.style.setProperty('opacity', '1', 'important');
        scrimInfo.style.setProperty('visibility', 'visible', 'important');
    }

    const onExitClick = (e) => { e.stopPropagation(); _abortCtrl?.abort(); };
    if (exitBtn) {
        exitBtn.style.transition = 'opacity 0.3s ease';
        exitBtn.style.setProperty('cursor', 'default', 'important');
        // Raise above avpi's shadow stacking context without touching position — Apple Music
        // already positions exitBtn absolutely in the corner; overriding position moves it.
        exitBtn.style.setProperty('z-index', '999999', 'important');
        exitBtn.addEventListener('click', onExitClick);
    }

    // ── Quality selector — integrated into native footer control bar ─────────────
    // ── Load SF Pro font from bundled engine resource ─────────────────────────────
    // Injected once per page — blob: URL bypasses CSP restrictions on @font-face src.
    if (!document.querySelector('#aml-sfpro-style')) {
        fetch(`${ENGINE}/fonts/SF-Pro.ttf`)
            .then(r => r.ok ? r.blob() : null)
            .then(b => {
                if (!b) return;
                const url = URL.createObjectURL(b);
                const s = document.createElement('style');
                s.id = 'aml-sfpro-style';
                s.textContent = `@font-face{font-family:'SF Pro';src:url('${url}')format('truetype');font-weight:100 900;font-style:normal;}`;
                document.head.appendChild(s);
            })
            .catch(() => {});
    }

    const _sfFont = `'SF Pro',-apple-system,BlinkMacSystemFont,sans-serif`;
    const _qualityLabel = () => _mvMaxHeight >= 2160 ? '4K' : `${_mvMaxHeight}p`;

    // tv.fill SVG — matches SF Symbols style: filled rounded-rect body + short stand + base bar
    const _tvIcon = `<svg width="20" height="17" viewBox="0 0 20 17" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">` +
        `<rect x="0.75" y="0.75" width="18.5" height="11.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
        `<rect x="8" y="13" width="4" height="1.5" rx="0.6"/>` +
        `<rect x="5.5" y="14.5" width="9" height="2" rx="1"/>` +
        `</svg>`;

    const _qualityBtn = document.createElement('button');
    _qualityBtn.setAttribute('tabindex', '0');
    Object.assign(_qualityBtn.style, {
        background: 'none', border: 'none', color: 'rgba(255,255,255,0.9)',
        fontSize: '11px', fontWeight: '510', letterSpacing: '0.02em',
        fontFamily: _sfFont,
        cursor: 'pointer', padding: '5px 8px', borderRadius: '8px',
        display: 'inline-flex', alignItems: 'center', gap: '5px',
        transition: 'background 0.12s, opacity 0.3s', flexShrink: '0',
    });
    const _qualitySpanEl = document.createElement('span');
    _qualitySpanEl.textContent = _qualityLabel();
    _qualityBtn.innerHTML = _tvIcon;
    _qualityBtn.appendChild(_qualitySpanEl);
    _qualityBtn.addEventListener('mouseenter', () => { _qualityBtn.style.background = 'rgba(255,255,255,0.1)'; });
    _qualityBtn.addEventListener('mouseleave', () => { _qualityBtn.style.background = 'none'; });

    // Inject before fullscreen button in the native footer control bar.
    const fsCtrl = avp?.querySelector('amp-playback-controls-full-screen');
    if (fsCtrl?.parentNode) {
        fsCtrl.parentNode.insertBefore(_qualityBtn, fsCtrl);
    } else if (footerRow) {
        footerRow.appendChild(_qualityBtn);
    } else {
        Object.assign(_qualityBtn.style, { position: 'fixed', bottom: '64px', right: '56px', zIndex: '999999' });
        mvContainer.appendChild(_qualityBtn);
    }

    // ── Quality menu — macOS vibrancy style ───────────────────────────────────────
    // SF checkmark SVG for selected item (matches SF Symbols checkmark weight)
    const _checkSVG = `<svg width="11" height="9" viewBox="0 0 11 9" fill="none" xmlns="http://www.w3.org/2000/svg">` +
        `<path d="M1 4.5L4 7.5L10 1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>` +
        `</svg>`;

    const _qualityMenu = document.createElement('div');
    Object.assign(_qualityMenu.style, {
        position: 'fixed', zIndex: '1000001',
        width: '150px',
        background: 'rgba(28,28,30,0.82)',
        backdropFilter: 'blur(48px) saturate(180%)',
        WebkitBackdropFilter: 'blur(48px) saturate(180%)',
        border: '0.5px solid rgba(255,255,255,0.13)',
        borderRadius: '10px',
        padding: '5px 0',
        display: 'none', flexDirection: 'column',
        boxShadow: '0 4px 24px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset, 0 0 0 0.5px rgba(0,0,0,0.3)',
        fontFamily: _sfFont,
        overflow: 'hidden',
        boxSizing: 'border-box',
    });

    // Available variant heights returned by the engine after parsing the HLS master playlist.
    // Used to filter quality options so we only show tiers that actually differ.
    const _sessHeights = Array.isArray(_mvVideoHeights) ? _mvVideoHeights : [];
    const _allTiers = [
        { label: '4K',    height: 2160 },
        { label: '1080p', height: 1080 },
        { label: '720p',  height: 720  },
        { label: '480p',  height: 480  },
    ];
    const _bestForMax = max => Math.max(0, ..._sessHeights.filter(h => h <= max));
    const _qualityOptions = _sessHeights.length === 0 ? _allTiers :
        _allTiers.filter((tier, i) => {
            const myBest = _bestForMax(tier.height);
            if (myBest === 0) return false; // no variant at or below this tier
            const below = _allTiers[i + 1];
            return !below || myBest > _bestForMax(below.height); // adds a distinct quality step
        });
    // Snap _mvMaxHeight to highest available tier so the button label is accurate
    if (_qualityOptions.length > 0 && !_qualityOptions.some(o => o.height === _mvMaxHeight)) {
        _mvMaxHeight = _qualityOptions[0].height;
    }

    _qualityOptions.forEach(({ label, height }) => {
        const opt = document.createElement('button');
        Object.assign(opt.style, {
            background: 'none', border: 'none',
            color: 'rgba(255,255,255,0.92)',
            padding: '0 14px 0 10px',
            height: '28px',
            textAlign: 'left', fontSize: '13px', fontWeight: '400',
            fontFamily: _sfFont,
            cursor: 'default', width: '100%',
            display: 'flex', alignItems: 'center', gap: '0',
            transition: 'background 0.08s',
        });

        // Left gutter: 22px — checkmark sits here for selected item
        const checkEl = document.createElement('span');
        checkEl.style.cssText = `width:22px;display:flex;align-items:center;flex-shrink:0;color:rgba(255,255,255,0.92)`;
        checkEl.innerHTML = height === _mvMaxHeight ? _checkSVG : '';

        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        labelEl.style.flex = '1';

        opt.append(checkEl, labelEl);

        opt.addEventListener('mouseenter', () => {
            opt.style.background = 'rgba(10,132,255,0.85)';
            opt.style.color = '#fff';
        });
        opt.addEventListener('mouseleave', () => {
            opt.style.background = 'none';
            opt.style.color = 'rgba(255,255,255,0.92)';
        });
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            _mvMaxHeight = height;
            localStorage.setItem('aml-mv-quality', String(height));
            _qualitySpanEl.textContent = _qualityLabel();
            _qualityMenu.querySelectorAll('button').forEach((b, i) => {
                b.querySelector('span').innerHTML = _qualityOptions[i].height === _mvMaxHeight ? _checkSVG : '';
            });
            _qualityMenu.style.display = 'none';
            _qualityMenuOpen = false;
            // Abort the current pipeline. Restoring Function.prototype.call/apply in cleanup
            // may cause MK to fire nowPlayingItemDidChange naturally. Only call handleTrackChange
            // manually if the generation hasn't advanced (i.e. no natural restart happened).
            const _genSnap = _generation;
            _abortCtrl.abort();
            setTimeout(() => { if (_generation === _genSnap && _mkInstance) handleTrackChange(_mkInstance); }, 200);
        });
        _qualityMenu.appendChild(opt);
    });
    // Append to body, not mvContainer — mvContainer may have a CSS transform
    // (Apple Music entrance animation) which makes position:fixed children position
    // relative to it rather than the viewport, breaking getBoundingClientRect math.
    document.body.appendChild(_qualityMenu);

    let _qualityMenuOpen = false;

    const _openQualityMenu = () => {
        _qualityMenuOpen = true;
        _qualityMenu.style.visibility = 'hidden';
        _qualityMenu.style.display = 'flex';
        const mh = _qualityMenu.offsetHeight;
        _qualityMenu.style.visibility = '';
        // btnRect is always viewport-relative; with the menu on body the fixed
        // positioning is also viewport-relative, so the math is exact.
        const btnRect = _qualityBtn.getBoundingClientRect();
        _qualityMenu.style.top    = Math.max(8, btnRect.top - mh - 8) + 'px';
        _qualityMenu.style.right  = (window.innerWidth - btnRect.right) + 'px';
        _qualityMenu.style.bottom = '';
        _qualityMenu.style.left   = '';
        // Focus the currently-selected option for keyboard navigation.
        const selected = [..._qualityMenu.querySelectorAll('button')]
            .find(b => b.querySelector('span')?.innerHTML?.includes('<svg')) ?? _qualityMenu.querySelector('button');
        selected?.focus();
    };
    const _closeQualityMenu = (restoreFocus = true) => {
        _qualityMenuOpen = false;
        _qualityMenu.style.display = 'none';
        if (restoreFocus) _qualityBtn.focus();
    };

    _qualityBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_qualityMenuOpen) _closeQualityMenu(false); else _openQualityMenu();
        _showControls();
    });
    _qualityBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _qualityBtn.click(); }
        if (e.key === 'Escape') _closeQualityMenu();
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); _openQualityMenu(); }
    });
    _qualityMenu.addEventListener('keydown', (e) => {
        const items = [..._qualityMenu.querySelectorAll('button')];
        const idx = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length]?.focus(); }
        if (e.key === 'ArrowUp')   { e.preventDefault(); items[(idx - 1 + items.length) % items.length]?.focus(); }
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); items[idx]?.click(); }
        if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); _closeQualityMenu(); }
    });
    mvContainer.addEventListener('click', () => {
        if (_qualityMenuOpen) _closeQualityMenu(false);
    });

    // MutationObserver: re-force scrim visible whenever Apple Music's JS hides it.
    // _scrimAllowHide gates intentional fade-outs so the observer doesn't fight _showControls.
    let _scrimAllowHide = false;
    const _scrimObs = scrimEl ? new MutationObserver(() => {
        if (_scrimAllowHide) return;
        if (scrimEl.style.opacity !== '1') scrimEl.style.setProperty('opacity', '1', 'important');
        if (scrimEl.style.visibility !== 'visible') scrimEl.style.setProperty('visibility', 'visible', 'important');
    }) : null;
    if (_scrimObs) _scrimObs.observe(scrimEl, { attributes: true, attributeFilter: ['style', 'class'] });

    // ── Slotted light-DOM children of avp (info + footer rows) ──────────────────
    // These have slot="info" / slot="footer" attributes — they are light DOM children
    // of amp-video-player distributed to named slots inside avp's shadow root.
    // Apple Music hides them when no native video is detected — force them visible.
    const footerRow = avp?.querySelector('[slot="footer"]');
    const infoEls   = avp ? [...avp.querySelectorAll('[slot="info"]')] : [];
    // Force visibility/opacity only — native display values are already correct
    // (info__eyebrow / info__title are display:block; footer rows are display:flex).
    // Overriding display:flex on info elements shifts text layout vs. Chrome reference.
    [...infoEls, footerRow].forEach(el => {
        if (!el) return;
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('opacity', '1', 'important');
    });

    // ── Seek bar ──────────────────────────────────────────────────────────────────
    const footerEls  = avp ? [...avp.querySelectorAll('[slot="footer"]')] : [];
    const scrubberEl = footerEls[0]?.querySelector('amp-playback-controls-progress')
                    ?? footerRow?.querySelector('amp-playback-controls-progress');
    const scrubberShadow = scrubberEl?.shadowRoot;
    const rangeInput = scrubberShadow?.querySelector('#playback-progress') ?? scrubberShadow?.querySelector('input[type=range]');
    if (scrubberEl) {
        scrubberEl.style.setProperty('visibility', 'visible', 'important');
        scrubberEl.style.setProperty('opacity', '1', 'important');
    }
    let _userScrubbing = false;
    if (rangeInput) {
        rangeInput.removeAttribute('disabled');
        rangeInput.style.setProperty('pointer-events', 'auto', 'important');
        rangeInput.addEventListener('mousedown', () => { _userScrubbing = true; }, true);
        rangeInput.addEventListener('touchstart', () => { _userScrubbing = true; }, true);
        rangeInput.addEventListener('input', () => {
            const t = parseFloat(rangeInput.value);
            if (!isNaN(t)) {
                myVid.currentTime = t; mkAudio.currentTime = t;
                _updateProgress();
            }
            _showControls();
        }, true);
        rangeInput.addEventListener('mouseup',    () => { _userScrubbing = false; }, true);
        rangeInput.addEventListener('touchend',   () => { _userScrubbing = false; }, true);
        // Set max from video duration once known
        const _setRangeMax = () => {
            if (myVid.duration && isFinite(myVid.duration)) rangeInput.max = String(myVid.duration);
        };
        myVid.addEventListener('loadedmetadata', _setRangeMax);
        myVid.addEventListener('durationchange', _setRangeMax);
        _setRangeMax();
    }

    // ── Play/pause button — our own, injected next to the native controls ────────
    // Native amp-playback-controls-play is hidden by AM's CSS when our synthetic
    // video (not the native one) is playing. Hide it and inject a reliable button.
    const playCtrl = avp?.querySelector('amp-playback-controls-play');
    if (playCtrl) playCtrl.style.setProperty('display', 'none', 'important');

    // play.fill / pause.fill — SF Symbols proportions, sized to match native skip buttons
    const _svgPlay  = `<svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9 6L22 14 9 22V6z"/></svg>`;
    const _svgPause = `<svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="4" width="6" height="20" rx="2"/><rect x="17" y="4" width="6" height="20" rx="2"/></svg>`;

    const _mvPlayBtn = document.createElement('button');
    Object.assign(_mvPlayBtn.style, {
        background: 'none', border: 'none', color: 'rgba(255,255,255,0.95)',
        cursor: 'pointer', padding: '0',
        width: '40px', height: '40px',
        borderRadius: '50%', flexShrink: '0',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 0.15s',
    });
    _mvPlayBtn.addEventListener('mouseenter', () => { _mvPlayBtn.style.background = 'rgba(255,255,255,0.15)'; });
    _mvPlayBtn.addEventListener('mouseleave', () => { _mvPlayBtn.style.background = 'none'; });
    _mvPlayBtn.addEventListener('click', (e) => { e.stopImmediatePropagation(); togglePlayPause(); _showControls(); }, true);

    const _syncPlayIcon = () => {
        _mvPlayBtn.innerHTML = myVid.paused ? _svgPlay : _svgPause;
        _mvPlayBtn.setAttribute('aria-label', myVid.paused ? 'Play' : 'Pause');
    };
    myVid.addEventListener('play',  _syncPlayIcon);
    myVid.addEventListener('pause', _syncPlayIcon);
    _syncPlayIcon();

    // Inject between the skip-back and skip-forward controls, or after playCtrl.
    const _skipFwd = avp?.querySelector('amp-playback-controls-skip-forward')
                  ?? avp?.querySelector('[aria-label*="forward" i]')
                  ?? avp?.querySelector('[aria-label*="10" i]');
    const _insertTarget = playCtrl ?? _skipFwd;
    if (_insertTarget?.parentNode) {
        _insertTarget.parentNode.insertBefore(_mvPlayBtn, _insertTarget);
    } else if (footerRow) {
        footerRow.appendChild(_mvPlayBtn);
    }

    // ── Volume slider ─────────────────────────────────────────────────────────────
    // AMP-VOLUME-CONTROL has a shadow root with a single INPUT[type=range] (min=0 max=1).
    const volCtrl   = avp?.querySelector('amp-volume-control');
    const volInput  = volCtrl?.shadowRoot?.querySelector('input[type=range]');
    if (volInput) {
        volInput.addEventListener('input', () => {
            mkAudio.volume = parseFloat(volInput.value);
            mkAudio.muted  = (parseFloat(volInput.value) === 0);
            _showControls();
        }, true);
    }
    const _syncVolSlider = () => {
        if (volInput && !_userScrubbing) volInput.value = String(mkAudio.muted ? 0 : mkAudio.volume);
    };
    mkAudio.addEventListener('volumechange', _syncVolSlider);

    // ── Auto-hide UI after 3 s of inactivity ─────────────────────────────────────
    let _hideTimer = null;
    const _showControls = () => {
        _scrimAllowHide = false;
        if (scrimEl) { scrimEl.style.setProperty('opacity', '1', 'important'); scrimEl.style.removeProperty('pointer-events'); }
        if (gradientDiv) gradientDiv.style.setProperty('opacity', '1', 'important');
        if (exitBtn) exitBtn.style.opacity = '1';
        _qualityBtn.style.opacity = '1';
        mvContainer.style.setProperty('cursor', 'default', 'important');
        clearTimeout(_hideTimer);
        _hideTimer = setTimeout(() => {
            if (myVid.paused) return;
            _scrimAllowHide = true;
            if (scrimEl) { scrimEl.style.setProperty('opacity', '0', 'important'); scrimEl.style.setProperty('pointer-events', 'none', 'important'); }
            if (gradientDiv) gradientDiv.style.setProperty('opacity', '0', 'important');
            if (exitBtn) exitBtn.style.opacity = '0';
            _qualityBtn.style.opacity = '0';
            _qualityMenuOpen = false; _qualityMenu.style.display = 'none';
            mvContainer.style.setProperty('cursor', 'none', 'important');
        }, 3000);
    };
    mvContainer.addEventListener('mousemove', _showControls);
    // Keyboard shortcuts (document-level so they fire regardless of focus).
    const onKeyDown = (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.key) {
            case ' ': case 'k': case 'K':
                e.preventDefault(); togglePlayPause(); _showControls(); break;
            case 'f': case 'F':
                e.preventDefault(); toggleFullscreen(); break;
            case 'ArrowLeft':
                e.preventDefault();
                myVid.currentTime = Math.max(0, myVid.currentTime - 10);
                mkAudio.currentTime = myVid.currentTime; _showControls(); break;
            case 'ArrowRight':
                e.preventDefault();
                myVid.currentTime = Math.min(myVid.duration || 1e9, myVid.currentTime + 10);
                mkAudio.currentTime = myVid.currentTime; _showControls(); break;
            case 'ArrowUp':
                e.preventDefault();
                mkAudio.volume = Math.min(1, mkAudio.volume + 0.1); _showControls(); break;
            case 'ArrowDown':
                e.preventDefault();
                mkAudio.volume = Math.max(0, mkAudio.volume - 0.1); _showControls(); break;
            case 'm': case 'M':
                mkAudio.muted = !mkAudio.muted; _showControls(); break;
            case 'Escape':
                if (!document.fullscreenElement) _abortCtrl.abort(); break;
            default: _showControls();
        }
    };
    document.addEventListener('keydown', onKeyDown);
    _showControls();

    const onScrimClick = (e) => {
        // Don't toggle play/pause if a button, input, or link was the actual target
        if (e.target.closest('button, input, a, [role="button"], [role="slider"]')) {
            _showControls();
            return;
        }
        e.stopImmediatePropagation();
        _showControls();
        togglePlayPause();
    };
    scrimClickable?.addEventListener('click', onScrimClick, true);

    // scrim__footer: native controls bar — non-clickthrough for the container.
    // Intercept play/pause + skip buttons; let scrub bar reach Apple Music natively.
    const onFooterClick = (e) => {
        const btn = e.target.closest('button');
        // Skip our own quality button — it handles its own clicks.
        if (!btn || btn === _qualityBtn) return;
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const text  = btn.textContent.trim().toLowerCase();
        const cls   = btn.className.toLowerCase();
        // Use aria-label for semantic matching; fall back to class only (not textContent,
        // which would match "1080p" as containing "10" for the skip-seconds buttons).
        if (label.includes('play') || label.includes('pause') || cls.includes('play') || cls.includes('pause')) {
            e.stopImmediatePropagation();
            togglePlayPause(); _showControls();
        } else if (label.includes('10') || label.includes('skip') || label.includes('forward') || label.includes('back') || label.includes('rewind') || cls.includes('skip')) {
            e.stopImmediatePropagation();
            const delta = (label.includes('back') || label.includes('rewind') || cls.includes('back')) ? -10 : 10;
            myVid.currentTime = Math.max(0, myVid.currentTime + delta);
            mkAudio.currentTime = myVid.currentTime; _showControls();
        } else if (label.includes('fullscreen') || label.includes('screen') || cls.includes('full-screen') || cls.includes('fullscreen')) {
            e.stopImmediatePropagation();
            toggleFullscreen();
        }
    };
    scrimFooter?.addEventListener('click', onFooterClick, true);

    // ── Seek bar position + fill sync ─────────────────────────────────────────────
    // nativeVidEl is null in MV mode. Drive thumb (value), filled track (--progress),
    // and the elapsed/remaining <time> text elements directly from myVid.currentTime.
    const _fmtTime = s => {
        const t = Math.max(0, Math.floor(s));
        const m = Math.floor(t / 60), sec = t % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };
    const progShadow   = scrubberEl?.shadowRoot;
    const timeElapsed  = progShadow?.querySelector('.time.elapsed');
    const timeRemain   = progShadow?.querySelector('.time.remaining');
    const _updateProgress = () => {
        if (!rangeInput) return;
        const t   = myVid.currentTime;
        const max = parseFloat(rangeInput.max) || parseFloat(rangeInput.getAttribute('max')) || 1;
        // Write value so the thumb position moves. Programmatic .value writes do NOT fire
        // the input/change events (confirmed), so mk.seekToTime() is never triggered here.
        // Not writing it causes amp-playback-controls-progress to see a stale value of 0 and
        // enter its loading/blink state repeatedly.
        rangeInput.value = String(t);
        const pct = (t / max * 100).toFixed(2) + '%';
        rangeInput.style.setProperty('--progress', pct);
        rangeInput.style.setProperty('--width',    pct);
        if (timeElapsed) timeElapsed.textContent = _fmtTime(t);
        if (timeRemain)  timeRemain.textContent  = '-' + _fmtTime(max - t);
    };
    const _seekSyncInterval = setInterval(_updateProgress, 250);
    const onNativeSeeked  = null;
    const onNativeVolume  = null;

    console.log(`[AML MV-V] myVid created in mvContainer; nativeVidEl readyState=${nativeVidEl?.readyState}`);

    // ── Audio MSE — separate element, pipeToSourceBuffer handles caching/seeking ──
    const audioMs = new MediaSource();
    const audioBlobUrl = URL.createObjectURL(audioMs);
    _nativeSrcSet.call(mkAudio, audioBlobUrl);
    try {
        await new Promise((resolve, reject) => {
            const sig = _abortCtrl.signal;
            sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            audioMs.addEventListener('sourceopen', resolve, { once: true });
        });
    } catch (e) {
        console.warn(`[AML MV-V] audio MSE sourceopen failed: ${e.message}`);
        if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
        return;
    }
    URL.revokeObjectURL(audioBlobUrl);
    // Start mkAudio as soon as audio data arrives so MK exits "loading" state early,
    // preventing the seek bar loading-blink that occurs while the video MSE is still
    // filling (which can take seconds).  onVideoPlay will re-sync currentTime if needed.
    mkAudio.addEventListener('canplay', function _onAudCanPlay() {
        if (mkAudio.paused && !_abortCtrl.signal.aborted) mkAudio.play().catch(() => {});
    }, { once: true });
    const audioSb = audioMs.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const audioUrl = `${ENGINE}/api/v1/playback/${_sessionId}/audio?raw=1`;
    let _audioPipeCtrl = new AbortController();

    const _waitAudIdle = () => new Promise((res, rej) => {
        if (!audioSb.updating) return res();
        const onEnd = () => { audioSb.removeEventListener('error', onErr); res(); };
        const onErr = (ev) => {
            audioSb.removeEventListener('updateend', onEnd);
            const detail = `code=${ev.target?.error?.code} msg=${ev.target?.error?.message}`;
            console.error(`[AML MV-A] SourceBuffer ERROR event: ${detail}`);
            rej(new Error(`audio SB error: ${detail}`));
        };
        audioSb.addEventListener('updateend', onEnd, { once: true });
        audioSb.addEventListener('error',     onErr, { once: true });
    });

    // Parse MP4 box chain from a chunk using direct byte access (no DataView).
    const _parseBoxHeader = (buf) => {
        if (!buf || buf.byteLength < 8) return `(${buf?.byteLength ?? 0}B too small)`;
        const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        const results = [];
        let off = 0;
        while (off + 8 <= b.length && off < 512) {
            const size = (b[off]<<24 | b[off+1]<<16 | b[off+2]<<8 | b[off+3]) >>> 0;
            const type = String.fromCharCode(b[off+4], b[off+5], b[off+6], b[off+7]);
            results.push(`[${type}:${size}B]`);
            if (size < 8 || off + size > b.length) break;
            off += size;
        }
        const hex16 = Array.from(b.slice(0, Math.min(16, b.length))).map(x => x.toString(16).padStart(2,'0')).join(' ');
        return `boxes=${results.join('')} hex=${hex16}`;
    };
    const _mvaTs = () => (Date.now() / 1000).toFixed(3);
    const _mvaBufStr = () => {
        if (!audioSb || audioSb.buffered.length === 0) return '(empty)';
        const ranges = [];
        for (let i = 0; i < audioSb.buffered.length; i++)
            ranges.push(`${audioSb.buffered.start(i).toFixed(2)}-${audioSb.buffered.end(i).toFixed(2)}`);
        return ranges.join(' ');
    };
    const runAudioPipe = async (signal) => {
        console.log(`[AML MV-A] fetch start t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} url=${audioUrl}`);
        const t0 = performance.now();
        const resp = await fetch(audioUrl, { signal });
        if (!resp.ok) throw new Error(`audio ${resp.status}`);
        const reader = resp.body.getReader();
        let chunk = 0;
        const evictAudio = async () => {
            if (audioMs.readyState !== 'open' || audioSb.buffered.length === 0) return;
            const evictTo = Math.max(0, mkAudio.currentTime - 30);
            if (evictTo > audioSb.buffered.start(0) + 1) {
                console.log(`[AML MV-A] evict 0-${evictTo.toFixed(2)}s t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()}`);
                await _waitAudIdle();
                await new Promise((res, rej) => {
                    audioSb.addEventListener('updateend', res, { once: true });
                    audioSb.addEventListener('error', rej, { once: true });
                    audioSb.remove(audioSb.buffered.start(0), evictTo);
                });
            }
        };
        // INTERCEPT: listen for raw SourceBuffer error events (fires before updateend).
        const _sbErrListener = (ev) => {
            console.error(`[INTERCEPT SB-ERR] SourceBuffer error event fired! code=${ev.target?.error?.code} msg=${ev.target?.error?.message} readyState=${audioMs.readyState} buf=${_mvaBufStr()}`);
        };
        audioSb.addEventListener('error', _sbErrListener);

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { console.log(`[AML MV-A] stream done t=${_mvaTs()} chunk#${chunk} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()}`); break; }
                if (signal.aborted || audioMs.readyState !== 'open') break;
                const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
                await _waitAudIdle();
                if (signal.aborted || audioMs.readyState !== 'open') break;

                // INTERCEPT: log chunk content before append.
                const bufBefore = _mvaBufStr();
                console.log(`[INTERCEPT PRE-APPEND] chunk#${chunk+1} size=${value.byteLength} bufBefore=${bufBefore} ${_parseBoxHeader(value)}`);

                try {
                    audioSb.appendBuffer(value);
                    await _waitAudIdle();
                    chunk++;
                    const bufAfter = _mvaBufStr();
                    const grew = bufBefore !== bufAfter;
                    window.__amlCaptureChunk?.('mv-audio', chunk, value, bufBefore, bufAfter, grew);
                    console.log(`[AML MV-A] chunk#${chunk} size=${value.byteLength} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${bufAfter} +${elapsed}s bufGrew=${grew}`);
                    if (!grew && chunk > 1) {
                        console.warn(`[INTERCEPT] chunk#${chunk} DID NOT grow buffer! Encrypted fragment rejected by browser MSE.`);
                    }
                }
                catch (e) {
                    console.error(`[INTERCEPT APPEND-ERR] chunk#${chunk+1} threw ${e.name}: ${e.message}`);
                    if (e.name === 'InvalidStateError') {
                        console.warn(`[AML MV-A] InvalidStateError chunk#${chunk} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} — retrying`);
                        await _waitAudIdle();
                        if (signal.aborted || audioMs.readyState !== 'open') break;
                        audioSb.appendBuffer(value);
                        await _waitAudIdle();
                        chunk++;
                        console.log(`[AML MV-A] chunk#${chunk} size=${value.byteLength} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()} +${elapsed}s (retry)`);
                    } else if (e.name === 'QuotaExceededError') {
                        console.warn(`[AML MV-A] QuotaExceeded chunk#${chunk} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()} — evicting`);
                        await evictAudio();
                        await _waitAudIdle();
                        if (signal.aborted || audioMs.readyState !== 'open') break;
                        try {
                            audioSb.appendBuffer(value);
                            await _waitAudIdle();
                            chunk++;
                            console.log(`[AML MV-A] chunk#${chunk} size=${value.byteLength} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()} +${elapsed}s (post-evict)`);
                        } catch (_) {}
                    } else { throw e; }
                }
            }
        } finally {
            audioSb.removeEventListener('error', _sbErrListener);
            reader.cancel().catch(() => {});
        }
        await _waitAudIdle().catch(() => {});
        if (!signal.aborted && audioMs.readyState === 'open') {
            try { audioMs.endOfStream(); } catch (_) {}
        }
    };
    runAudioPipe(_audioPipeCtrl.signal)
        .catch(e => { if (!_audioPipeCtrl.signal.aborted) console.error('[AML MV] audio pipe error:', e); });

    // ── Video MSE ─────────────────────────────────────────────────────────────────
    const ms = new MediaSource();
    const msBlobUrl = URL.createObjectURL(ms);
    myVid.src = msBlobUrl;

    try {
        await new Promise((resolve, reject) => {
            const sig = _abortCtrl.signal;
            sig.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            ms.addEventListener('sourceopen', resolve, { once: true });
        });
    } catch (e) {
        console.warn(`[AML MV-V] video MSE sourceopen failed: ${e.message}`);
        _audioPipeCtrl.abort();
        mkAudio.pause(); mkAudio.src = '';
        if (audioMs.readyState === 'open') { try { audioMs.endOfStream(); } catch (_) {} }
        if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
        return;
    }
    URL.revokeObjectURL(msBlobUrl);

    // Extract video-only codec string (manifest may carry "avc1.xxx,mp4a.40.2").
    const rawVideoCodec = _videoCodec || '';
    const videoCodecStr = rawVideoCodec.split(',').map(c => c.trim())
        .find(c => /^(avc1|hvc1|hev1|vp09|av01)/.test(c)) ?? 'avc1.640028';
    const videoMime = `video/mp4; codecs="${videoCodecStr}"`;
    if (!MediaSource.isTypeSupported(videoMime)) {
        console.error(`[AML MV] video codec not supported: ${videoMime}`);
        _audioPipeCtrl.abort();
        mkAudio.pause(); mkAudio.src = '';
        if (audioMs.readyState === 'open') { try { audioMs.endOfStream(); } catch (_) {} }
        if (ms.readyState === 'open') { try { ms.endOfStream(); } catch (_) {} }
        if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
        return;
    }
    console.log(`[AML MV] video codec="${videoCodecStr}"`);

    // segments mode (default) — preserves HLS fMP4 timestamps.
    const videoSb = ms.addSourceBuffer(videoMime);

    const videoEl = myVid;
    let pipeCtrl = new AbortController();
    const videoUrl = `${ENGINE}/api/v1/playback/${_sessionId}/video`;

    // ── Video pipe (with chunk cache for backward seek re-injection) ──────────────
    const _vidCache = [];
    const _waitVidIdle = () => new Promise((res, rej) => {
        if (!videoSb.updating) return res();
        const onEnd = () => { videoSb.removeEventListener('error', onErr); res(); };
        const onErr = () => { videoSb.removeEventListener('updateend', onEnd); rej(new Error('SB error')); };
        videoSb.addEventListener('updateend', onEnd, { once: true });
        videoSb.addEventListener('error',     onErr, { once: true });
    });
    const runVideoPipe = async (url, cache, signal) => {
        const resp = await fetch(url, { signal });
        if (!resp.ok) throw new Error(`video ${resp.status}`);
        const reader = resp.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done || signal.aborted || ms.readyState !== 'open') break;
                if (cache) _vidCache.push(value);
                await _waitVidIdle();
                if (signal.aborted || ms.readyState !== 'open') break;
                try { videoSb.appendBuffer(value); }
                catch (e) {
                    if (e.name === 'InvalidStateError') {
                        await _waitVidIdle();
                        if (signal.aborted || ms.readyState !== 'open') break;
                        videoSb.appendBuffer(value);
                    } else if (e.name !== 'QuotaExceededError') throw e;
                }
            }
        } finally { reader.cancel().catch(() => {}); }
        await _waitVidIdle().catch(() => {});
        if (!signal.aborted && ms.readyState === 'open') ms.endOfStream();
    };
    runVideoPipe(videoUrl, true, pipeCtrl.signal)
        .catch(e => { if (!pipeCtrl.signal.aborted) console.error('[AML MV] video pipe error:', e); });

    // ── Backward seek: re-inject cached chunks for both video and audio ──────────
    let _mvVidSeeking = false;
    const _mvVideoSeek = async (seekSec) => {
        if (_mvVidSeeking || pipeCtrl.signal.aborted) return;
        for (let i = 0; i < videoSb.buffered.length; i++) {
            if (seekSec >= videoSb.buffered.start(i) - 1.0 && seekSec <= videoSb.buffered.end(i) + 1.0) return;
        }
        if (_vidCache.length === 0) return;
        _mvVidSeeking = true;
        try {
            const prev = pipeCtrl;
            pipeCtrl = new AbortController();
            prev.abort();
            const sig = pipeCtrl.signal;
            await _waitVidIdle();
            if (videoSb.buffered.length > 0) { videoSb.remove(0, Infinity); await _waitVidIdle(); }
            videoSb.timestampOffset = 0;
            for (const chunk of [..._vidCache]) {
                if (sig.aborted || ms.readyState !== 'open') return;
                await _waitVidIdle();
                try { videoSb.appendBuffer(chunk); } catch (e) { break; }
            }
            if (sig.aborted || ms.readyState !== 'open') return;
            const bufEnd = videoSb.buffered.length > 0 ? videoSb.buffered.end(videoSb.buffered.length - 1) : 0;
            if (bufEnd < (_durationSec || 1e9) - 1) {
                runVideoPipe(`${videoUrl}?t=${bufEnd.toFixed(3)}`, false, sig)
                    .catch(e => { if (!sig.aborted) console.error('[AML MV] video resume error:', e); });
            }
        } finally { _mvVidSeeking = false; }
    };
    videoEl.addEventListener('seeking', () => { _mvVideoSeek(videoEl.currentTime).catch(() => {}); });

    // Start audio from the exact video frame position on first timeupdate — avoids
    // snapping audio to 0 during FFmpeg startup latency.
    const onVideoPlay  = () => {
        console.log(`[AML MV-V] videoEl play ct=${videoEl.currentTime.toFixed(2)}`);
        if (Math.abs(mkAudio.currentTime - videoEl.currentTime) > 0.5)
            mkAudio.currentTime = videoEl.currentTime;
        mkAudio.play().catch(() => {});
    };
    // Dispatch synthetic 'playing'/'pause' on nativeVidEl so MK's state machine
    // transitions from state=1 (loading) to state=2 (playing) / state=3 (paused).
    // MK observes nativeVidEl events; we never play nativeVidEl so it never fires
    // these on its own. The counter-pause interceptor (Function.prototype.call override)
    // blocks MK's savedPause.call(nativeVidEl) that fires on 'playing'.
    const onVideoPlaying = () => {
        nativeVidEl?.dispatchEvent(new Event('playing', { bubbles: false }));
    };
    const onVideoPause = () => {
        console.log(`[AML MV-V] videoEl pause ct=${videoEl.currentTime.toFixed(2)}`);
        mkAudio.pause();
        nativeVidEl?.dispatchEvent(new Event('pause', { bubbles: false }));
    };
    const onVideoSeek  = () => {
        if (_mvVidSeeking) return; // videoSb.remove() fires a spurious seeked with ct=0
        console.log(`[AML MV-V] videoEl seeked ct=${videoEl.currentTime.toFixed(2)}`);
        if (Math.abs(mkAudio.currentTime - videoEl.currentTime) > 0.5)
            mkAudio.currentTime = videoEl.currentTime;
    };
    const onEnded = () => { console.log(`[AML MV-V] videoEl ended — aborting pipeline`); _abortCtrl.abort(); };
    const onVideoError  = () => {
        const code = videoEl.error?.code;
        console.error(`[AML MV-V] videoEl error code=${code} msg="${videoEl.error?.message}"`);
        if (code === 3 || code === 4) _abortCtrl.abort();
    };
    const onVideoStall  = () => console.warn(`[AML MV-V] videoEl stalled ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
    const onVideoWait   = () => console.warn(`[AML MV-V] videoEl waiting ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
    videoEl.addEventListener('play',    onVideoPlay);
    videoEl.addEventListener('playing', onVideoPlaying);
    videoEl.addEventListener('pause',   onVideoPause);
    videoEl.addEventListener('seeked',  onVideoSeek);
    videoEl.addEventListener('error',   onVideoError);
    videoEl.addEventListener('stalled', onVideoStall);
    videoEl.addEventListener('waiting', onVideoWait);
    mkAudio.addEventListener('ended',   onEnded);
    videoEl.addEventListener('ended',   onEnded);

    videoEl.addEventListener('canplay', () => {
        if (_abortCtrl?.signal.aborted) return;
        console.log(`[AML MV] canplay videoWidth=${videoEl.videoWidth} videoHeight=${videoEl.videoHeight} readyState=${videoEl.readyState}`);
        _iframePlay.call(videoEl).catch(e => console.warn('[AML MV] play rejected:', e.message));
    }, { once: true });

    const cleanup = () => {
        console.log(`[AML MV-V] cleanup gen=${_mvGen} curGen=${_generation}`);
        pipeCtrl.abort(); _audioPipeCtrl.abort();
        mkAudio.pause();
        videoEl.removeEventListener('play',    onVideoPlay);
        videoEl.removeEventListener('playing', onVideoPlaying);
        videoEl.removeEventListener('pause',   onVideoPause);
        videoEl.removeEventListener('seeked',  onVideoSeek);
        // Signal MK's state machine: session ended
        nativeVidEl?.dispatchEvent(new Event('pause', { bubbles: false }));
        videoEl.removeEventListener('error',   onVideoError);
        videoEl.removeEventListener('stalled', onVideoStall);
        videoEl.removeEventListener('waiting', onVideoWait);
        videoEl.removeEventListener('ended',   onEnded);
        videoEl.pause();
        if (ms.readyState === 'open') { try { ms.endOfStream(); } catch (_) {} }
        if (myVid.parentNode) myVid.parentNode.removeChild(myVid);
        mvContainer.removeEventListener('mousemove', _showControls);
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('fullscreenchange', onFullscreenChange);
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        scrimClickable?.removeEventListener('click', onScrimClick, true);
        scrimFooter?.removeEventListener('click', onFooterClick, true);
        // Restore container forced styles.
        for (const p of _containerProps) mvContainer.style.removeProperty(p);
        mvContainer.style.removeProperty('cursor');
        // Restore scrim forced styles.
        _scrimObs?.disconnect();
        _scrimResizeObs?.disconnect();
        myVid.removeEventListener('loadedmetadata', _resizeScrim);
        myVid.removeEventListener('resize', _resizeScrim);
        if (scrimEl)       { ['opacity','visibility','transition','cursor'].forEach(p => scrimEl.style.removeProperty(p)); }
        if (scrimClickable){ ['pointer-events','cursor'].forEach(p => scrimClickable.style.removeProperty(p)); }
        if (scrimFooter)   { ['opacity','visibility','pointer-events'].forEach(p => scrimFooter.style.removeProperty(p)); }
        if (scrimHeader)   { scrimHeader.style.removeProperty('display'); }
        if (scrimInfo)     { ['opacity','visibility'].forEach(p => scrimInfo.style.removeProperty(p)); }
        if (exitBtn)  { exitBtn.removeEventListener('click', onExitClick); exitBtn.style.opacity = ''; exitBtn.style.transition = ''; ['cursor','z-index'].forEach(p => exitBtn.style.removeProperty(p)); }
        if (_qualityBtn.parentNode) _qualityBtn.parentNode.removeChild(_qualityBtn);
        if (_qualityMenu.parentNode) _qualityMenu.parentNode.removeChild(_qualityMenu);
        if (vcDiv) vcDiv.classList.remove('hide-cursor');
        clearTimeout(_hideTimer);
        clearInterval(_seekSyncInterval);
        // Restore avpi / avpEl / vcDiv expansions.
        if (avpi) { for (const p of _avpiProps) avpi.style.removeProperty(p); }
        if (avpEl) { avpEl.style.removeProperty('width'); avpEl.style.removeProperty('height'); avpEl.style.removeProperty('background'); }
        if (vcDiv) { vcDiv.style.removeProperty('width'); vcDiv.style.removeProperty('height'); vcDiv.style.removeProperty('background'); }
        if (gradientDiv) { ['display','opacity','visibility','pointer-events','transition'].forEach(p => gradientDiv.style.removeProperty(p)); }
        mvContainer.style.removeProperty('cursor');
        if (nativeVidInVc) nativeVidInVc.style.removeProperty('display');
        if (nativeVidEl) {
            nativeVidEl.style.opacity = '';
            ['waiting', 'stalled', 'suspend'].forEach(evt =>
                nativeVidEl.removeEventListener(evt, _nativeVidStopEvt, true)
            );
        }
        Element.prototype.requestFullscreen = _origReqFS;
        _mvPlayBtn.remove();
        videoEl.removeEventListener('play',  _syncPlayIcon);
        videoEl.removeEventListener('pause', _syncPlayIcon);
        myVid.removeEventListener('volumechange', _syncVolSlider);
        Function.prototype.call  = _origFnCall;
        Function.prototype.apply = _origFnApply;
        // Subtitle cleanup
        if (_subDiv.parentNode) _subDiv.parentNode.removeChild(_subDiv);
        for (let i = 0; i < myVid.textTracks.length; i++)
            myVid.textTracks[i].removeEventListener('cuechange', _renderSubs);
    };
    _abortCtrl.signal.addEventListener('abort', cleanup, { once: true });
    console.log(`[AML MV] pipeline started session=${_sessionId}`);
}

function startVLCPoll(mkAudio) {
    stopVLCPoll();
    _vlcPrevState = null;
    let _errCount  = 0;
    let _tickCount = 0;
    let _vlcLengthSet = false;
    let _vlcFetching  = false; // skip tick if previous fetch hasn't completed
    _vlcPollTimer = setInterval(async () => {
        if (_vlcFetching) return;
        _vlcFetching = true;
        try {
            const r = await fetch(`${ENGINE}/api/v1/vlc/time`);
            if (!r.ok) return;
            _errCount = 0;
            const { posMs, lengthMs, state } = await r.json();
            if (!_vlcLengthSet && lengthMs > 0) {
                _vlcLengthSet = true;
                _durationSec = lengthMs / 1000;
                bridgeDuration(mk, _durationSec);


        // --- Extracted pipeline functions ---
        async function startAACPipeline() {
            // ── MSE path: native AAC fMP4 piped directly into the browser ──────
            // Seek works via ?t= (SeekableSource on engine side).
            // ALAC/Atmos still go through VLC below.

            _seekable    = sess.capabilities?.seekable ?? false;
            _chunkCache  = { sessionId: _sessionId, chunks: [], byteSize: 0 };
            const audioPath  = sess.streams?.audio ?? `/api/v1/playback/${_sessionId}/audio`;
            const streamBase = `${ENGINE}${audioPath}?raw=1`;
            _activeStreamBase = streamBase;

            const ms      = new MediaSource();
            const blobUrl = URL.createObjectURL(ms);
            _ourBlobUrl   = blobUrl;
            _nativeSrcSet.call(mkAudio, blobUrl);

            delete mkAudio.load;
            HTMLMediaElement.prototype.load.call(mkAudio);
            mkAudio.load = () => {};

            await new Promise((resolve, reject) => {
                ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                ms.addEventListener('sourceopen', resolve, { once: true });
            });
            URL.revokeObjectURL(blobUrl);
            if (_durationSec > 0) { try { ms.duration = _durationSec; } catch (_) {} }

            const sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
            sb.addEventListener('error', e => console.error('[AML MSE] SourceBuffer error', e));
            _activeSb = sb; _activeMs = ms;

            // ── Mirror VLC play/pause pattern ──────────────────────────────────
            // Override pause/paused on the element instance so ALL pause() calls —
            // from MK internals, the proxy, or anywhere — go through one handler.
            // Without this, MK can call audio.pause() directly and bypass our flag.
            const _nativeMSEPause = HTMLMediaElement.prototype.pause.bind(mkAudio);
            _msePaused = false;
            Object.defineProperty(mkAudio, 'paused', {
                get: () => _msePaused,
                configurable: true,
            });
            mkAudio.pause = () => {
                _msePaused = true;
                _nativeMSEPause(); // actually stop audio output
            };

            mkAudio.addEventListener('loadedmetadata', function onMeta() {
                try {
                    if (sb.buffered.length > 0 && sb.buffered.start(0) > mkAudio.currentTime + 0.1)
                        mkAudio.currentTime = sb.buffered.start(0);
                    else if (sb.buffered.length === 0)
                        sb.addEventListener('updateend', () => { try { if (sb.buffered.length > 0 && sb.buffered.start(0) > mkAudio.currentTime + 0.1) mkAudio.currentTime = sb.buffered.start(0); } catch(_){} }, { once: true });
                } catch (_) {}
            }, { once: true });

            _pipeCtrl = new AbortController();
            const pipeCtrl = _pipeCtrl;
            pipeToSourceBuffer(sb, mkAudio, streamBase, pipeCtrl.signal, ms, _durationSec, t0).catch(e => {
                if (!pipeCtrl.signal.aborted) console.error('[AML MSE] pipe error:', e.message);
            });

            const onSeeking = () => {
                if (ctrl.signal.aborted) return;
                if (!_ourSeekPending) return;
                _ourSeekPending = false;
                mseSeekToTime(_ourSeekTarget, mkAudio, sb, ms);
            };

            const tryPlay = () => {
                if (ctrl.signal.aborted) return;
                mkAudio.addEventListener('seeking', onSeeking);
                if (_ourSeekPending) {
                    _ourSeekPending = false;
                    mseSeekToTime(_ourSeekTarget, mkAudio, sb, ms);
                    return;
                }
                _nativePlay().catch(e => console.warn('[AML MSE] play():', e));
            };

            if (mkAudio.readyState >= 3) tryPlay();
            else mkAudio.addEventListener('canplay', tryPlay, { once: true });

            ctrl.signal.addEventListener('abort', () => {
                mkAudio.removeEventListener('seeking', onSeeking);
                mkAudio.removeEventListener('canplay', tryPlay);
                delete mkAudio.paused;
                delete mkAudio.pause;
                _msePaused = false;
            }, { once: true });

            console.log(`[AML MSE] AAC stream open +${((performance.now()-t0)/1000).toFixed(2)}s`);
        }

        async function startVLCPipeline() {
            // ── VLC path: ALAC and Atmos routed through libvlc ──────────────────

            _vlcMode = true;

            // Keep mkAudio in a perpetual loading state via an open MediaSource.
            // MK's state machine reads DOM events (playing, pause, timeupdate, ended)
            // from this element; actual audio comes from libvlc → system sound device.
            const _silentMs  = new MediaSource();
            const _silentUrl = URL.createObjectURL(_silentMs);
            _nativeSrcSet.call(mkAudio, _silentUrl);
            delete mkAudio.load;
            HTMLMediaElement.prototype.load.call(mkAudio);
            mkAudio.load = () => {};

            _vlcPaused = false;
            Object.defineProperty(mkAudio, 'paused', {
                get: () => _vlcPaused,
                configurable: true,
            });

            _vlcPosMs = 0;
            Object.defineProperty(mkAudio, 'currentTime', {
                get: () => _vlcPosMs / 1000,
                set: () => {},
                configurable: true,
            });

            const _volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
            let _vlcVolume = Math.round((_volDesc.get.call(mkAudio) ?? 1) * 100) || 100;
            let _vlcMuted = false;
            let _vlcPreMuteVol = _vlcVolume;
            const _postVlcVol = (vol) => fetch(`${ENGINE}/api/v1/vlc/volume`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ volume: vol }),
            }).catch(() => {});

            Object.defineProperty(mkAudio, 'volume', {
                get: () => _vlcVolume / 100,
                set: (v) => {
                    _vlcVolume = Math.max(0, Math.min(200, Math.round(v * 100)));
                    if (_vlcVolume > 0) _vlcMuted = false;
                    _postVlcVol(_vlcMuted ? 0 : _vlcVolume);
                    mkAudio.dispatchEvent(new Event('volumechange'));
                },
                configurable: true,
            });

            Object.defineProperty(mkAudio, 'muted', {
                get: () => _vlcMuted,
                set: (v) => {
                    _vlcMuted = !!v;
                    if (_vlcMuted) { _vlcPreMuteVol = _vlcVolume || 100; _postVlcVol(0); }
                    else { _vlcVolume = _vlcPreMuteVol; _postVlcVol(_vlcVolume); }
                    mkAudio.dispatchEvent(new Event('volumechange'));
                },
                configurable: true,
            });

            mkAudio.pause = () => {
                console.log(`[AML VLC] pause() → pause`);
                _vlcPaused = true;
                mkAudio.dispatchEvent(new Event('pause'));
                fetch(`${ENGINE}/api/v1/vlc/pause`, { method: 'POST' }).catch(() => {});
            };

            _vlcLoading = true;
            const vlcResp = await fetch(`${ENGINE}/api/v1/vlc/load`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: _sessionId, assetId: adamId, startMs: 0 }),
                signal: ctrl.signal,
            });
            if (!vlcResp.ok) throw new Error(`VLC load: ${await vlcResp.text()}`);

            _postVlcVol(_vlcMuted ? 0 : _vlcVolume);

            if (ctrl.signal.aborted) return;

            mkAudio.addEventListener('canplay', () => {
                if (!ctrl.signal.aborted) {
                    _vlcPaused = false;
                    mkAudio.dispatchEvent(new Event('playing'));
                    if (_vlcLoading) mkAudio.dispatchEvent(new Event('waiting'));
                }
            }, { once: true });
            mkAudio.dispatchEvent(new Event('canplay'));

            startVLCPoll(mkAudio);
            console.log(`[AML Engine] VLC playing +${((performance.now()-t0)/1000).toFixed(2)}s`);

            ctrl.signal.addEventListener('abort', () => {
                unbridgeDuration();
                stopVLCPoll();
                _vlcLoading = false;
                URL.revokeObjectURL(_silentUrl);
                delete mkAudio.paused;
                delete mkAudio.currentTime;
                delete mkAudio.volume;
                delete mkAudio.muted;
                delete mkAudio.pause;
                _vlcPaused = false;
            }, { once: true });
        }

// startMVPipeline is defined at module scope below startVLCPoll

        // --- End of extracted pipeline functions ---



        if (item.type === 'music-videos' || item.type === 'musicVideo') {
        await startMVPipeline();
        return;
        } else if (sess.codec === 'aac') {
        await startAACPipeline();
        return;
        } else {
        await startVLCPipeline();
        return;
        }
            }
            const prevPos = _vlcPosMs;
            // VLC reports absolute fMP4 tfdt timestamps, so posMs is already the
            // correct song-timeline position. Guard posMs > 0: VLC returns -1/0
            // briefly before first decode; keep the snapped seek position during that window.
            if (!_vlcSeekFrozen && posMs > 0) _vlcPosMs = posMs;
            if (_vlcPosMs !== prevPos) mkAudio.dispatchEvent(new Event('timeupdate'));
            // Update MPRIS position every ~1s (every 4 ticks × 250ms).
            if (++_tickCount % 4 === 0) {
                window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1000 }); // ms → µs
            }
            // Burst-log every tick for 15 ticks after a seek so we can diagnose
            // exactly what VLC does immediately after loading the seek stream.
            if (_seekBurstLog > 0) {
                _seekBurstLog--;
                console.log(`[AML VLC seek] tick posMs=${posMs} state=${state} offset=${_vlcSeekOffsetMs} pos=${_vlcPosMs} frozen=${_vlcSeekFrozen}`);
            } else if (_tickCount % 20 === 0) {
                // Log position every ~5 seconds during normal playback.
                console.log(`[AML VLC] pos=${posMs}ms state=${state}`);
            }
            if (state === _vlcPrevState) return;
            const prev = _vlcPrevState;
            _vlcPrevState = state;
            console.log(`[AML VLC] state: ${prev ?? 'null'} → ${state}  posMs=${posMs}  frozen=${_vlcSeekFrozen}`);
            // Suppress playing/pause events while a seek is in-flight.
            // Go's pause→SetMediaTime→resume emits paused/playing transitions that
            // would trigger MK's PlayActivity crash cascade if dispatched mid-seek.
            if (_vlcSeekFrozen) return;
            if (state === 'playing') {
                _vlcPaused = false;
                _vlcLoading = false; // VLC is actually playing; clear pre-warmup guard
                // Only dispatch 'playing' for initial start (null/stopped → playing).
                // Resume from pause is handled by _origMKPlay() — dispatching here
                // causes PlayActivity.play() to be called twice and throws.
                if (prev !== 'paused') mkAudio.dispatchEvent(new Event('playing'));
            }
            if (state === 'paused')  { _vlcPaused = true;  mkAudio.dispatchEvent(new Event('pause')); }
            // VLC goes playing → ended → stopped in quick succession.
            // If the 250ms poll fires after the ended state has already passed,
            // we see playing → stopped and must treat it as a track end too.
            if (state === 'ended' || (state === 'stopped' && (prev === 'playing' || prev === 'ended'))) {
                stopVLCPoll();
                // Snap seek bar to 100% before advancing: VLC may end slightly
                // before the API-reported duration (CMAF duration padding adds
                // metadata-only silence), leaving the bar showing "10s left".
                if (posMs > 2000) {
                    _vlcPosMs = Math.round(_durationSec * 1000);
                    mkAudio.dispatchEvent(new Event('timeupdate'));
                }
                // Premature end: VLC got EOF at posMs≈0 because the cbcs stream failed
                // before delivering enough data. Reload the same session URL and retry
                // rather than skipping. Limit to 2 retries to avoid an infinite loop
                // when the engine is genuinely broken.
                if (posMs < 2000 && _durationSec > 5 && _vlcRetryCount < 2) {
                    _vlcRetryCount++;
                    _vlcSeekOffsetMs = 0;
                    console.log(`[AML VLC] premature end at posMs=${posMs} — reload attempt ${_vlcRetryCount}`);
                    setTimeout(() => {
                        if (!_sessionId) return;
                        fetch(`${ENGINE}/api/v1/vlc/load`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId: _sessionId, assetId: _currentAssetId, startMs: 0 }),
                        }).then(() => startVLCPoll(mkAudio)).catch(() => {});
                    }, 1500);
                    return;
                }
                // skipToNextItem() advances the queue via MK's API without triggering
                // PlayActivity's analytics descriptor (which we never initialise).
                // However, it can silently fail when called from a natural track end
                // (MK's state differs from a user-initiated skip). Guard with:
                //  - .catch: immediate fallback if skipToNextItem rejects
                //  - 3s timer: fallback if it resolves but nowPlayingItemDidChange
                //    never fires (MK internal state stall)
                // Both fallbacks dispatch 'ended' on mkAudio — this may trigger a
                // PlayActivity "no descriptor" error in the console, but the queue
                // still advances correctly.
                const _mkInst = window.MusicKit?.getInstance?.();
                if (_mkInst) {
                    console.log('[AML VLC] ended → skipToNextItem');
                    let _advanced = false;
                    const _clearAdvance = () => { _advanced = true; clearTimeout(_skipTimer); };
                    _mkInst.addEventListener('nowPlayingItemDidChange', _clearAdvance, { once: true });
                    const _skipTimer = setTimeout(() => {
                        if (!_advanced) {
                            console.warn('[AML VLC] skipToNextItem stalled → ended fallback');
                            // Restore native load() so MK can process the ended event and
                            // advance its queue exactly once. Our handleTrackChange will
                            // re-override it for the new track.
                            try { delete mkAudio.load; } catch (_) {}
                            mkAudio.dispatchEvent(new Event('ended'));
                        }
                    }, 3000);
                    _mkInst.skipToNextItem().catch(e => {
                        _clearAdvance();
                        console.warn('[AML VLC] skipToNextItem failed:', e?.message, '→ ended fallback');
                        try { delete mkAudio.load; } catch (_) {}
                        mkAudio.dispatchEvent(new Event('ended'));
                    });
                } else {
                    mkAudio.dispatchEvent(new Event('ended'));
                }
            }
        } catch (_) {
            // Stop polling after 5 consecutive errors (engine exited or unreachable).
            if (++_errCount >= 5) stopVLCPoll();
        } finally {
            _vlcFetching = false;
        }
    }, 250);
}

// Polls _engineCaps.lossless every 100 ms until true or timeoutMs elapses.
// Only waits on the first call after startup (or after a DRM re-auth resets
// _losslessWaitDone). Once it times out once we skip all future waits — CBCS
// state won't flip mid-session and we can't pay +2.5 s per track when unavailable.
function waitForLossless(timeoutMs) {
    if (_engineCaps.lossless || _losslessWaitDone) return Promise.resolve();
    return new Promise(resolve => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (_engineCaps.lossless || Date.now() >= deadline) {
                _losslessWaitDone = true;
                resolve();
            } else {
                setTimeout(tick, 100);
            }
        };
        tick();
    });
}


// ── Core playback handler ─────────────────────────────────────────────────────

async function handleTrackChange(mk) {
    const item = mk.nowPlayingItem;
    if (!item) return;

    const myGen = ++_generation;

    if (_pipeCtrl)  { _pipeCtrl.abort();  _pipeCtrl  = null; }
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    _ourBlobUrl = null;
    // MSE state reset
    _activeSb = null; _activeMs = null; _activeStreamBase = '';
    _seekable = false; _seekTarget = -Infinity; _ourSeekPending = false; _ourSeekTarget = -Infinity;
    _streamComplete = false; _chunkCache = null; _msePaused = false;
    if (_seekFetchCtrl) { _seekFetchCtrl.abort(); _seekFetchCtrl = null; }
    // VLC state reset
    _vlcMode = false; _vlcPosMs = 0; _vlcPaused = false; _vlcSeekFrozen = false; _vlcRetryCount = 0; _vlcSeekOffsetMs = 0; _vlcPrevState = null; _vlcLoading = false; _seekBurstLog = 0;
    if (_vlcSeekTimer) { clearTimeout(_vlcSeekTimer); _vlcSeekTimer = null; }
    stopVLCPoll();
    unbridgeDuration();
    deleteSession(_sessionId);
    _sessionId      = null;
    _currentAssetId = null;
    _durationSec = 0;
    // Do NOT reset _losslessWaitDone here — it's a one-shot per DRM state change,
    // not per track. Resetting it would re-enable the 2.5 s wait on every skip.
    showQualityBadge(null);

    // Library tracks have an `i.` prefixed id; the engine needs the catalog id.
    const adamId = item.playParams?.catalogId
        ?? item.attributes?.playParams?.catalogId
        ?? item.id
        ?? item.playParams?.id
        ?? item.attributes?.playParams?.id;
    const sf     = mk.storefrontId ?? 'us';
    if (!adamId) { console.warn('[AML Engine] No Adam ID'); return; }
    _currentAssetId = adamId;

    // Music videos play natively through MusicKit — don't intercept.

    const t0 = performance.now();
    console.log(`[AML Engine] → ${item.attributes?.name ?? adamId} (id=${adamId} sf=${sf})`);

    const mkAudio = getMKAudio();
    if (mkAudio) {
        if (!mkAudio.paused) mkAudio.pause(); // skip if already paused — avoids poking MK state machine needlessly
        // Absorb MK's load() calls so it can't reset our MSE stream.
        // We lift this shadow for our own controlled _nativeLoad() call below.
        mkAudio.load = () => {};
        // Install play() proxy on first use.
        installPlayProxy(mkAudio);
    }

    // Wait up to 800 ms for DRM to report lossless capability before opening the session.
    // Prevents locking in a degraded AAC session when FairPlay is seconds from ready.
    // With SSE working, the DRM state arrives in <200ms so this rarely waits at all.
    await waitForLossless(800);
    if (myGen !== _generation) return;

    try {
        const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assetId:    adamId,
                storefront: sf,
                capabilities: {
                    lossless: _engineCaps.lossless,
                    atmos:    false,
                    video:    (item.type === 'music-videos' || item.type === 'musicVideo'),
                },
                mvMaxHeight:    _mvMaxHeight,
                token:          mk.developerToken ?? '',
                mediaUserToken: getMUT(),
            }),
        });
        if (!sessResp.ok) throw new Error(`Session ${sessResp.status}: ${await sessResp.text()}`);

        const sess = await sessResp.json();

        if (myGen !== _generation) { deleteSession(sess.sessionId); return; }

        _sessionId      = sess.sessionId;
        _durationSec    = (sess.durationMs ?? 0) / 1000;
        _videoCodec     = sess.capabilities?.videoCodec || null;
        _mvVideoHeights = sess.videoHeights ?? [];
        console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now()-t0)/1000).toFixed(2)}s`);

        showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth, sess.spatialAudio);

        _abortCtrl = new AbortController();
        const ctrl = _abortCtrl;

        // Music video: route to MV pipeline before mkAudio check (MV creates its own audio)
        if (sess.capabilities?.video) {
            bridgeDuration(mk, _durationSec);
            await startMVPipeline();
            return;
        }

        if (!mkAudio) throw new Error('MK audio element not found');

        bridgeDuration(mk, _durationSec);

        if (sess.codec === 'aac') {
            // ── MSE path: native AAC fMP4 piped directly into the browser ──────
            // Seek works via ?t= (SeekableSource on engine side).
            // ALAC/Atmos still go through VLC below.

            _seekable    = sess.capabilities?.seekable ?? false;
            _chunkCache  = { sessionId: _sessionId, chunks: [], byteSize: 0 };
            const audioPath  = sess.streams?.audio ?? `/api/v1/playback/${_sessionId}/audio`;
            const streamBase = `${ENGINE}${audioPath}?raw=1`;
            _activeStreamBase = streamBase;

            const ms      = new MediaSource();
            const blobUrl = URL.createObjectURL(ms);
            _ourBlobUrl   = blobUrl;
            _nativeSrcSet.call(mkAudio, blobUrl);

            delete mkAudio.load;
            HTMLMediaElement.prototype.load.call(mkAudio);
            mkAudio.load = () => {};

            await new Promise((resolve, reject) => {
                ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                ms.addEventListener('sourceopen', resolve, { once: true });
            });
            URL.revokeObjectURL(blobUrl);
            if (_durationSec > 0) { try { ms.duration = _durationSec; } catch (_) {} }

            const sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
            sb.addEventListener('error', e => console.error('[AML MSE] SourceBuffer error', e));
            _activeSb = sb; _activeMs = ms;

            // ── Mirror VLC play/pause pattern ──────────────────────────────────
            // Override pause/paused on the element instance so ALL pause() calls —
            // from MK internals, the proxy, or anywhere — go through one handler.
            // Without this, MK can call audio.pause() directly and bypass our flag.
            const _nativeMSEPause = HTMLMediaElement.prototype.pause.bind(mkAudio);
            _msePaused = false;
            Object.defineProperty(mkAudio, 'paused', {
                get: () => _msePaused,
                configurable: true,
            });
            mkAudio.pause = () => {
                _msePaused = true;
                _nativeMSEPause(); // actually stop audio output
            };

            mkAudio.addEventListener('loadedmetadata', function onMeta() {
                try {
                    if (sb.buffered.length > 0 && sb.buffered.start(0) > mkAudio.currentTime + 0.1)
                        mkAudio.currentTime = sb.buffered.start(0);
                    else if (sb.buffered.length === 0)
                        sb.addEventListener('updateend', () => { try { if (sb.buffered.length > 0 && sb.buffered.start(0) > mkAudio.currentTime + 0.1) mkAudio.currentTime = sb.buffered.start(0); } catch(_){} }, { once: true });
                } catch (_) {}
            }, { once: true });

            _pipeCtrl = new AbortController();
            const pipeCtrl = _pipeCtrl;
            pipeToSourceBuffer(sb, mkAudio, streamBase, pipeCtrl.signal, ms, _durationSec, t0).catch(e => {
                if (!pipeCtrl.signal.aborted) console.error('[AML MSE] pipe error:', e.message);
            });

            const onSeeking = () => {
                if (ctrl.signal.aborted) return;
                if (!_ourSeekPending) return;
                _ourSeekPending = false;
                mseSeekToTime(_ourSeekTarget, mkAudio, sb, ms);
            };

            const tryPlay = () => {
                if (ctrl.signal.aborted) return;
                mkAudio.addEventListener('seeking', onSeeking);
                if (_ourSeekPending) {
                    _ourSeekPending = false;
                    mseSeekToTime(_ourSeekTarget, mkAudio, sb, ms);
                    return;
                }
                _nativePlay().catch(e => console.warn('[AML MSE] play():', e));
            };

            if (mkAudio.readyState >= 3) tryPlay();
            else mkAudio.addEventListener('canplay', tryPlay, { once: true });

            ctrl.signal.addEventListener('abort', () => {
                mkAudio.removeEventListener('seeking', onSeeking);
                mkAudio.removeEventListener('canplay', tryPlay);
                delete mkAudio.paused;
                delete mkAudio.pause;
                _msePaused = false;
                unbridgeDuration();
            }, { once: true });

            console.log(`[AML MSE] AAC stream open +${((performance.now()-t0)/1000).toFixed(2)}s`);

        } else {
            // ── VLC path: ALAC and Atmos routed through libvlc ──────────────────

            _vlcMode = true;

            // Keep mkAudio in a perpetual loading state via an open MediaSource.
            // MK's state machine reads DOM events (playing, pause, timeupdate, ended)
            // from this element; actual audio comes from libvlc → system sound device.
            const _silentMs  = new MediaSource();
            const _silentUrl = URL.createObjectURL(_silentMs);
            _nativeSrcSet.call(mkAudio, _silentUrl);
            delete mkAudio.load;
            HTMLMediaElement.prototype.load.call(mkAudio);
            mkAudio.load = () => {};

            _vlcPaused = false;
            Object.defineProperty(mkAudio, 'paused', {
                get: () => _vlcPaused,
                configurable: true,
            });

            _vlcPosMs = 0;
            Object.defineProperty(mkAudio, 'currentTime', {
                get: () => _vlcPosMs / 1000,
                set: () => {},
                configurable: true,
            });

            const _volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
            let _vlcVolume = Math.round((_volDesc.get.call(mkAudio) ?? 1) * 100) || 100;
            let _vlcMuted = false;
            let _vlcPreMuteVol = _vlcVolume;
            const _postVlcVol = (vol) => fetch(`${ENGINE}/api/v1/vlc/volume`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ volume: vol }),
            }).catch(() => {});
            Object.defineProperty(mkAudio, 'volume', {
                get: () => _vlcVolume / 100,
                set: (v) => {
                    _vlcVolume = Math.max(0, Math.min(200, Math.round(v * 100)));
                    if (_vlcVolume > 0) _vlcMuted = false;
                    _postVlcVol(_vlcMuted ? 0 : _vlcVolume);
                    mkAudio.dispatchEvent(new Event('volumechange'));
                },
                configurable: true,
            });
            Object.defineProperty(mkAudio, 'muted', {
                get: () => _vlcMuted,
                set: (v) => {
                    _vlcMuted = !!v;
                    if (_vlcMuted) { _vlcPreMuteVol = _vlcVolume || 100; _postVlcVol(0); }
                    else { _vlcVolume = _vlcPreMuteVol; _postVlcVol(_vlcVolume); }
                    mkAudio.dispatchEvent(new Event('volumechange'));
                },
                configurable: true,
            });

            mkAudio.pause = () => {
                console.log(`[AML VLC] pause() → pause`);
                _vlcPaused = true;
                mkAudio.dispatchEvent(new Event('pause'));
                fetch(`${ENGINE}/api/v1/vlc/pause`, { method: 'POST' }).catch(() => {});
            };

            _vlcLoading = true;
            const vlcResp = await fetch(`${ENGINE}/api/v1/vlc/load`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: _sessionId, assetId: adamId, startMs: 0 }),
                signal: ctrl.signal,
            });
            if (!vlcResp.ok) throw new Error(`VLC load: ${await vlcResp.text()}`);

            _postVlcVol(_vlcMuted ? 0 : _vlcVolume);

            if (ctrl.signal.aborted) return;

            mkAudio.addEventListener('canplay', () => {
                if (!ctrl.signal.aborted) {
                    _vlcPaused = false;
                    mkAudio.dispatchEvent(new Event('playing'));
                    if (_vlcLoading) mkAudio.dispatchEvent(new Event('waiting'));
                }
            }, { once: true });
            mkAudio.dispatchEvent(new Event('canplay'));

            startVLCPoll(mkAudio);
            console.log(`[AML Engine] VLC playing +${((performance.now()-t0)/1000).toFixed(2)}s`);

            ctrl.signal.addEventListener('abort', () => {
                unbridgeDuration();
                stopVLCPoll();
                _vlcLoading = false;
                URL.revokeObjectURL(_silentUrl);
                delete mkAudio.paused;
                delete mkAudio.currentTime;
                delete mkAudio.volume;
                delete mkAudio.muted;
                delete mkAudio.pause;
                _vlcPaused = false;
            }, { once: true });
        }

    } catch (err) {
        if (!_abortCtrl?.signal.aborted) console.error('[AML Engine] Playback error:', err);
        if (mkAudio) delete mkAudio.load;
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
    if (window.__amlEngineMounted) return;
    window.__amlEngineMounted = true;

    blockAppleCDN();

    // Feature-detect native ALAC MSE support (Chromium 116+ / Electron 38+).
    // Wait for the engine's SSE snapshot instead of polling GET /api/v1/status.
    // _amlEngine is injected by engine-sse-bundle.js which loads before us.
    try {
        const msg = await window._amlEngine?.waitFor('engine.snapshot', 4000);
        const snap = msg?.payload?.snapshot;
        const gen  = msg?.meta?.generation ?? '?';
        const why  = msg?.meta?.reason     ?? '?';
        _snapshotEventId = msg?.meta?.id ?? -1;  // used to filter stale replayed drm events
        if (snap?.capabilities) {
            _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        }
        console.log(`[AML Engine] Engine ready — drm.session=${snap?.drm?.session ?? 'unknown'} lossless=${_engineCaps.lossless} gen=${gen} reason=${why} snapshotId=${_snapshotEventId}`);
    } catch (e) {
        console.warn('[AML Engine] Engine snapshot timeout:', e.message, '— continuing');
    }

    // Push saved cache config to engine now that it's up.
    window.amlBridge?.getPrefs().then(p => {
        const body = {};
        if (p.prewarmLimitMB  != null) body.prewarmLimitMB  = p.prewarmLimitMB;
        if (p.persistLimitMB  != null) body.persistLimitMB  = p.persistLimitMB;
        if (p.persistTTLDays  != null) body.persistTTLDays  = p.persistTTLDays;
        if (Object.keys(body).length)
            fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    }).catch(() => {});

    // React to DRM state changes pushed over SSE (session lost, re-auth, lossless ready).
    // SSE events arrive as {meta:{id,generation,...}, payload:<DRMSnapshot>} — unwrap payload.
    window._amlEngine?.on('drm', (msg) => {
        // Skip events that predate our last engine.snapshot — they are stale ring-buffer
        // replays whose state is already captured in the snapshot. Applying them would
        // overwrite newer snapshot data (e.g. lossless=true → false).
        const eventId = msg?.meta?.id ?? Infinity;
        if (eventId <= _snapshotEventId) {
            console.log(`[AML Engine] DRM event ${eventId} skipped (predates snapshot ${_snapshotEventId})`);
            return;
        }

        const snap = msg?.payload;  // DRMSnapshot: {state:{session,...}, capabilities:{alac,...}}
        const wasLossless = _engineCaps.lossless;
        const sess = snap?.state?.session ?? 'unknown';
        if (snap?.capabilities) {
            _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        }
        console.log(`[AML Engine] DRM state → session=${sess} lossless=${_engineCaps.lossless}`);

        // DRM just became lossless-capable — reset so the next track gets a wait window.
        if (!wasLossless && _engineCaps.lossless) _losslessWaitDone = false;

        // Binary needs credentials but none are stored — open the sign-in form
        // automatically so the user doesn't have to navigate to Settings.
        if (snap?.challenge?.type === 'credentials') {
            console.log('[AML Engine] DRM credential challenge — opening sign-in form');
            window.__amlOpenEngineSettings?.();
        }

        // Note: mid-track seamless lossless upgrade is intentionally not attempted here.
        // FLAC transcode streams start at position 0 with no seek support, making a
        // buffer-safe splice impossible. The next track will start in FLAC via
        // waitForLossless() at the top of handleTrackChange.
    });

    const mk = await waitForMusicKit();
    console.log('[AML Engine] MusicKit ready');

    // Override mk.play() and mk.pause() so VLC handles audio while MK's own
    // state machine and UI stay in sync.  This is the most reliable interception
    // point: the play button always goes through mk.play()/mk.pause() before
    // reaching the audio element, so we never miss a user-initiated play/pause.
    const _origMKPlay  = mk.play.bind(mk);
    const _origMKPause = mk.pause.bind(mk);
    mk.play = function() {
        if (_vlcMode) {
            console.log('[AML VLC] mk.play() → resume');
            _vlcPaused = false;
            fetch(`${ENGINE}/api/v1/vlc/resume`, { method: 'POST' }).catch(() => {});
        } else {
            // Clear the manual-pause guard so the next audio.play() proxy call
            // is allowed through.
            _msePaused = false;
        }
        // Always call original: its internal audio.play() call hits our proxy
        // (which now resolves immediately) so MK's AudioPlayer finishes its
        // state transition and the UI shows the pause button.
        // NOTE: do NOT dispatch 'playing' here — premature dispatch advances
        // PlayActivity to "playing" state before _origMKPlay() runs its own
        // PlayActivity.play(), causing "play() without previous stop/pause" throw.
        return _origMKPlay().catch(() => {});
    };
    mk.pause = function() {
        if (_vlcMode) {
            console.log('[AML VLC] mk.pause() → pause');
            _vlcPaused = true;
            getMKAudio()?.dispatchEvent(new Event('pause'));
            fetch(`${ENGINE}/api/v1/vlc/pause`, { method: 'POST' }).catch(() => {});
        } else {
            // MSE: _origMKPause() updates MK's internal state but may not call
            // audio.pause() directly. Call it explicitly so the native element
            // actually stops, then set the guard so proxy-triggered play() calls
            // (MK internal retries) don't resume it.
            _msePaused = true;
            getMKAudio()?.pause();
        }
        return _origMKPause();
    };

    installMKSeekInterceptor(mk);

    // ── MPRIS helpers ──────────────────────────────────────────────────────────
    function mprisTrackId(item) {
        const id = item?.id ?? item?.playParams?.id ?? item?.attributes?.playParams?.id ?? 'unknown';
        // D-Bus object paths only allow [A-Za-z0-9_/]. Sanitize Apple catalog IDs
        // which can contain hyphens/dots — invalid chars corrupt the dbus-next stream.
        return `/com/apple/music/track/${String(id).replace(/[^A-Za-z0-9_]/g, '_')}`;
    }

    function sendMprisMetadata(item) {
        if (!window.amlBridge?.mprisUpdate || !item) return;
        const a = item.attributes ?? {};
        const artTemplate = a.artwork?.url ?? '';
        const artUrl = artTemplate.replace('{w}', '1000').replace('{h}', '1000');
        window.amlBridge.mprisUpdate({
            metadata: {
                'mpris:trackid': mprisTrackId(item),
                'mpris:length':  Math.round((a.durationInMillis ?? 0) * 1000),
                'xesam:title':   a.name ?? '',
                'xesam:artist':  [a.artistName ?? ''],
                'xesam:album':   a.albumName ?? '',
                'mpris:artUrl':  artUrl,
            },
            shuffle: mk.shuffleMode === 1,
        });
    }

    function sendMprisStatus(status, { isResume = false } = {}) {
        // Emit seeked only on resume-from-pause so clients re-anchor without
        // jumping: on fresh track starts _vlcPosMs is 0/stale until VLC reports
        // its first tick, which causes the seek bar to visibly skip ahead.
        const seeked = isResume && status === 'Playing' && _vlcPosMs > 0;
        window.amlBridge?.mprisUpdate?.({ status, position: _vlcPosMs * 1000, seeked });
    }

    // Handle MPRIS commands from system media controls / media keys.
    // Commands are either plain strings (play/pause/next/previous) or objects
    // { type: 'seek', deltaMs } / { type: 'setPosition', ms } for seek.
    window.amlBridge?.onMprisCmd?.((cmd) => {
        if (cmd && typeof cmd === 'object') {
            if (cmd.type === 'seek') {
                mk.seekToTime(Math.max(0, (_vlcPosMs + cmd.deltaMs) / 1000));
            } else if (cmd.type === 'setPosition') {
                mk.seekToTime(Math.max(0, cmd.ms / 1000));
            } else if (cmd.type === 'shuffle') {
                mk.shuffleMode = cmd.value ? 1 : 0;
            }
            return;
        }
        switch (cmd) {
            case 'play':      mk.play().catch(() => {}); break;
            case 'pause':     mk.pause(); break;
            case 'playpause': mk.playbackState === window.MusicKit?.PlaybackStates?.playing
                ? mk.pause() : mk.play().catch(() => {}); break;
            case 'next':      mk.skipToNextItem().catch(() => {}); break;
            case 'previous':  mk.skipToPreviousItem().catch(() => {}); break;
        }
    });

    mk.addEventListener('shuffleModeDidChange', () => {
        window.amlBridge?.mprisUpdate?.({ shuffle: mk.shuffleMode === 1 });
    });

    // Stable ID from any MusicKit MediaItem regardless of whether the item came
    // from the catalog, library, or a queue insertion (each uses a different path).
    const _qId = (item) =>
        item?.id ?? item?.playParams?.id ?? item?.attributes?.playParams?.id ?? null;

    // ── Track-row play button interceptor ────────────────────────────────────────
    // When a user clicks a track in a playlist, Apple Music inserts it at
    // queue.position+1 ("Play Next") but does NOT fire nowPlayingItemDidChange.
    // We detect the queue mutation and call skipToNextItem() to bridge the gap.
    document.addEventListener('click', (e) => {
        if (e.target.closest('.contextual-menu')) return; // Play Next / Add to Queue — don't interfere

        const PS = window.MusicKit?.PlaybackStates;
        if (mk.playbackState !== PS?.playing) return; // only intercept during active playback

        const pos      = mk.queue?.position ?? 0;
        const snapNext = _qId(mk.queue?.items?.[pos + 1]);
        const snapNow  = _qId(mk.nowPlayingItem); // snapshot current song id at click time

        let cancelled = false;
        const cancel = () => { cancelled = true; };
        mk.addEventListener('nowPlayingItemDidChange', cancel, { once: true });

        const checkAdvance = () => {
            mk.removeEventListener('queueDidChange', checkAdvance);
            mk.removeEventListener('nowPlayingItemDidChange', cancel);
            if (cancelled) return; // MK already fired nowPlayingItemDidChange — existing listener handles it

            const curPos = mk.queue?.position ?? 0;
            if (curPos !== pos) return; // queue position changed (context switch, pos > 0 case)

            // Guard context switch at pos=0: queue.items[0] updates before nowPlayingItemDidChange fires
            if ((_qId(mk.queue?.items?.[curPos]) ?? null) !== snapNow) return;

            const newNext = _qId(mk.queue?.items?.[curPos + 1]);
            if (newNext && newNext !== snapNext) {
                console.log('[aml] track-click: inserted at next, calling skipToNextItem');
                mk.skipToNextItem().catch(() => {});
            }
        };

        mk.addEventListener('queueDidChange', checkAdvance, { once: true });
        setTimeout(() => {
            mk.removeEventListener('queueDidChange', checkAdvance);
            checkAdvance();
        }, 200);
    }, true);

    mk.addEventListener('nowPlayingItemDidChange', () => {
        handleTrackChange(mk);
        // Signal queue context to the prefetch scheduler.
        window._amlSmartCache?.onTrackChange(mk);
        // Track play frequency for startup warming and signal boosting.
        const item = mk.nowPlayingItem;
        if (item) {
            const id = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
            window._amlSmartCache?.recordPlay(id);
            sendMprisMetadata(item);
        } else {
            sendMprisStatus('Stopped');
        }
    });

    mk.addEventListener('playbackStateDidChange', () => {
        const PS = window.MusicKit?.PlaybackStates;
        console.log(`[AML Engine] state=${mk.playbackState} (playing=${PS?.playing})`);

        // Sync MPRIS status.
        const s = mk.playbackState;
        if (s === PS?.playing) {
            // In VLC mode, skip 'Playing' until VLC has actually reported a valid
            // position (_vlcPosMs > 0). This prevents MPRIS showing "Playing" during
            // track pre-warming when VLC is still in "opening" state. The poll
            // dispatches a 'playing' event (triggering this listener again) once VLC
            // actually transitions to playing with posMs > 0.
            if (!_vlcMode || _vlcPosMs > 0) sendMprisStatus('Playing', { isResume: _vlcPaused });
        } else if (s === PS?.paused) {
            sendMprisStatus('Paused');
        } else if (s === PS?.stopped || s === PS?.none) {
            sendMprisStatus('Stopped');
        }

        if (!_vlcMode) return;
        // Sync MK's authoritative playback state to VLC.  MK is the source of truth
        // here — the user clicked play or pause and MK has already committed the
        // transition.  MK's play button click does NOT always call audio.play() (it
        // has its own internal AudioPlayer path), so this listener is more reliable
        // than intercepting audio.play() for user-initiated resumes.
        if (s === PS?.playing) {
            console.log('[AML VLC] playbackStateDidChange → playing → resume');
            _vlcPaused = false;
            fetch(`${ENGINE}/api/v1/vlc/resume`, { method: 'POST' }).catch(() => {});
        } else if (s === PS?.paused) {
            console.log('[AML VLC] playbackStateDidChange → paused → pause');
            _vlcPaused = true;
            fetch(`${ENGINE}/api/v1/vlc/pause`, { method: 'POST' }).catch(() => {});
        }
    });

    // Initialise smart cache: navigation observer + startup warm.
    const cache = window._amlSmartCache;
    if (cache) {
        cache.observeNavigation(() => mk);
        cache.warmOnStartup(mk);
    }

    if (mk.nowPlayingItem) handleTrackChange(mk);
}

setup().catch(e => console.error('[AML Engine] setup:', e));

// MusicKit's PlayActivity analytics throws "play() method was called without a
// previous stop() or pause() call" as an unhandled promise rejection whenever
// our VLC mode resumes playback — its state machine expects a real audio src.
// This is cosmetic noise; suppress it so the console stays readable.
window.addEventListener('unhandledrejection', (e) => {
    if (e.reason?.message?.includes('play() method was called without a previous')) {
        e.preventDefault();
    }
});




// ── Submenu viewport clamp ─────────────────────────────────────────────────
(function clampSubmenus() {
    const PLAYER_BAR = 72;
    const PAD = 8;

    function clamp(el) {
        if (!el.isConnected) return;
        el.style.removeProperty('max-height');
        el.style.removeProperty('overflow-y');
        const rect  = el.getBoundingClientRect();
        const limit = window.innerHeight - PLAYER_BAR - PAD;
        if (rect.bottom <= limit) return;
        const parent = el.parentElement;
        if (parent) {
            const overflow = rect.bottom - limit;
            const headroom = Math.max(0, rect.top - PAD);
            const shift    = Math.min(overflow, headroom);
            if (shift > 0) {
                const curTop = parseFloat(parent.style.top) || 0;
                parent.style.top = (curTop - shift) + 'px';
            }
        }
        const r2 = el.getBoundingClientRect();
        if (r2.bottom > limit) {
            const cap = Math.max(80, limit - r2.top);
            el.style.setProperty('max-height', cap + 'px', 'important');
            el.style.setProperty('overflow-y', 'auto',     'important');
        }
    }

    function clampAll() {
        document.querySelectorAll(
            'div.contextual-menu.contextual-menu--nested, div.contextual-menu.contextual-menu--in-submenu'
        ).forEach(clamp);
    }

    const bodyObs = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const overlay = node.classList?.contains('contextual-menu__overlay')
                    ? node : node.querySelector?.('.contextual-menu__overlay');
                if (!overlay) continue;
                const innerObs = new MutationObserver(() => setTimeout(clampAll, 0));
                innerObs.observe(overlay, { childList: true, subtree: true });
                const cleanupObs = new MutationObserver(() => {
                    if (!overlay.isConnected) { innerObs.disconnect(); cleanupObs.disconnect(); }
                });
                cleanupObs.observe(document.body, { childList: true });
            }
        }
    });
    bodyObs.observe(document.body, { childList: true });
})();


// ── Engine Settings Panel ──────────────────────────────────────────────────
// Adds "Engine Settings" to the account context menu.
// Opens as a native <dialog> (macOS-sheet style).
// All engine state comes from /api/v1/drm/status — no wrapper IPC.
(function setupEngineSettings() {
    if (!window.amlBridge) return;

    let injected = false;
    const FF = 'font-family:-apple-system,SF Pro Text,system-ui,sans-serif;';

    function dot(ok) {
        const d = document.createElement('span');
        d.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;` +
            `flex-shrink:0;background:${ok ? '#34c759' : '#ff3b30'};`;
        return d;
    }

    function makeSection(title) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin-top:32px;';
        const h = document.createElement('h2');
        h.textContent = title;
        h.style.cssText = FF + 'font-size:11px;font-weight:600;text-transform:uppercase;' +
            'letter-spacing:0.06em;color:rgba(255,255,255,0.4);margin:0 0 8px;';
        const body = document.createElement('div');
        body.style.cssText = 'background:rgba(255,255,255,0.08);border-radius:10px;padding:0 14px;';
        wrap.appendChild(h);
        wrap.appendChild(body);
        return { wrap, body };
    }

    function makeRow(label, val, subtitle, isLast) {
        const r = document.createElement('div');
        r.style.cssText = 'display:flex;align-items:center;padding:11px 0;' +
            (isLast ? '' : 'border-bottom:0.5px solid rgba(255,255,255,0.07);');
        const lbl = document.createElement('div');
        lbl.style.cssText = 'flex:1;';
        const m = document.createElement('div');
        m.style.cssText = FF + 'font-size:13px;color:rgba(255,255,255,0.85);';
        m.textContent = label;
        lbl.appendChild(m);
        if (subtitle) {
            const s = document.createElement('div');
            s.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.38);margin-top:2px;';
            s.textContent = subtitle;
            lbl.appendChild(s);
        }
        r.appendChild(lbl);
        r.appendChild(val);
        return r;
    }

    function statusVal(text, ok) {
        const v = document.createElement('div');
        v.style.cssText = FF + 'display:flex;align-items:center;gap:6px;font-size:13px;color:rgba(255,255,255,0.5);';
        if (ok !== undefined) v.appendChild(dot(ok));
        v.appendChild(document.createTextNode(text));
        return v;
    }

    function makeBtn(text) {
        const b = document.createElement('button');
        b.textContent = text;
        b.style.cssText = FF + 'padding:5px 13px;border-radius:6px;border:none;font-size:12px;' +
            'cursor:pointer;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);white-space:nowrap;';
        return b;
    }

    function makeInput(type, placeholder) {
        const inp = document.createElement('input');
        inp.type = type; inp.placeholder = placeholder;
        inp.style.cssText = FF + 'width:100%;box-sizing:border-box;padding:8px 10px;margin-top:8px;' +
            'border-radius:6px;border:0.5px solid rgba(255,255,255,0.2);' +
            'background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.85);font-size:13px;outline:none;';
        return inp;
    }

    async function fetchDRM() {
        const r = await fetch(`${ENGINE}/api/v1/drm/status`);
        return r.json();
    }

    // ── Engine Account section (self-contained, mutates its own body) ─────
    function buildAccountSection(drm, onRefresh) {
        const { wrap, body } = makeSection('Engine Account');
        const drmState = drm?.state ?? drm ?? {};
        const isSignedIn = drmState?.session === 'valid'
            || drmState?.authentication === 'logged_in'
            || drmState?.fairplay === 'ready'
            || drm?.capabilities?.cbcs === true;

        function renderState() {
            body.innerHTML = '';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:11px 0;';
            row.appendChild(dot(isSignedIn));
            const text = document.createElement('div');
            text.style.cssText = 'flex:1;';
            const main = document.createElement('div');
            main.style.cssText = FF + 'font-size:13px;color:rgba(255,255,255,0.85);';
            main.textContent = isSignedIn ? 'Signed in' : 'Not signed in';
            text.appendChild(main);
            if (!isSignedIn) {
                const sub = document.createElement('div');
                sub.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.38);margin-top:2px;';
                sub.textContent = 'Sign in to enable lossless and hi-res playback';
                text.appendChild(sub);
            }
            row.appendChild(text);
            const btn = makeBtn(isSignedIn ? 'Sign Out' : 'Sign In…');
            btn.onclick = isSignedIn ? async () => {
                btn.disabled = true; btn.textContent = 'Signing out…';
                await fetch(`${ENGINE}/api/v1/drm/logout`, { method: 'POST' }).catch(() => {});
                onRefresh();
            } : renderSignIn;
            row.appendChild(btn);
            body.appendChild(row);
        }

        function renderSignIn() {
            body.innerHTML = '';
            const emailInp = makeInput('email', 'Apple ID (email)');
            const passInp  = makeInput('password', 'Password');
            const msgEl    = document.createElement('div');
            msgEl.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.5);padding:4px 0;min-height:16px;';
            const btnRow   = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:8px;padding:10px 0 4px;';
            const cancelBtn = makeBtn('Cancel');
            const goBtn     = makeBtn('Sign In');
            goBtn.style.cssText += 'background:#fc3c44;color:#fff;';
            btnRow.appendChild(cancelBtn); btnRow.appendChild(goBtn);
            body.appendChild(emailInp); body.appendChild(passInp);
            body.appendChild(msgEl); body.appendChild(btnRow);

            cancelBtn.onclick = renderState;
            goBtn.onclick = async () => {
                const email = emailInp.value.trim();
                const password = passInp.value;
                if (!email || !password) { msgEl.textContent = 'Email and password required.'; return; }
                goBtn.disabled = true; goBtn.textContent = 'Signing in…'; msgEl.textContent = '';
                const r = await fetch(`${ENGINE}/api/v1/drm/authenticate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
                }).catch(e => { msgEl.textContent = e.message; });
                if (!r) { goBtn.disabled = false; goBtn.textContent = 'Sign In'; return; }
                if (!r.ok) {
                    msgEl.textContent = await r.text().catch(() => `HTTP ${r.status}`);
                    goBtn.disabled = false; goBtn.textContent = 'Sign In'; return;
                }
                msgEl.textContent = 'Contacting Apple servers…';
                pollForAuth(msgEl);
            };
        }

        function pollForAuth(msgEl) {
            let n = 0;
            const t = setInterval(async () => {
                if (++n > 60) { clearInterval(t); msgEl.textContent = 'Timed out. Refresh to check status.'; return; }
                const status = await fetchDRM().catch(() => null);
                if (!status) return;
                const auth = status.state?.authentication;
                const session = status.state?.session;
                if (session === 'valid' || auth === 'logged_in' || status.state?.fairplay === 'ready' || status.capabilities?.cbcs === true) { clearInterval(t); onRefresh(); return; }
                if (auth === 'challenging') { clearInterval(t); renderChallenge(); return; }
                if (auth === 'failed') { clearInterval(t); msgEl.textContent = status.message || 'Authentication failed.'; return; }
            }, 1000);
        }

        function renderChallenge() {
            body.innerHTML = '';
            const note = document.createElement('div');
            note.style.cssText = FF + 'font-size:13px;color:rgba(255,255,255,0.85);padding:10px 0 4px;';
            note.textContent = 'Two-factor authentication — enter the code sent to your device.';
            const codeInp = makeInput('text', '6-digit code');
            codeInp.maxLength = 8;
            const errEl   = document.createElement('div');
            errEl.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.5);padding:4px 0;min-height:16px;';
            const submitBtn = makeBtn('Submit');
            submitBtn.style.cssText += 'margin-top:6px;';
            body.appendChild(note); body.appendChild(codeInp); body.appendChild(errEl); body.appendChild(submitBtn);
            submitBtn.onclick = async () => {
                const reply = codeInp.value.trim();
                if (!reply) return;
                submitBtn.disabled = true;
                const r = await fetch(`${ENGINE}api/v1/drm/challenge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reply }),
                }).catch(e => { errEl.textContent = e.message; });
                if (!r) { submitBtn.disabled = false; return; }
                if (!r.ok) { errEl.textContent = await r.text().catch(() => `HTTP ${r.status}`); submitBtn.disabled = false; return; }
                pollForAuth(errEl);
            };
        }

        renderState();
        return wrap;
    }

    // ── Dialog (created once, reused) ─────────────────────────────────────
    function getDialog() {
        let dlg = document.getElementById('aml-settings-dialog');
        if (dlg) return dlg;
        dlg = document.createElement('dialog');
        dlg.id = 'aml-settings-dialog';
        const st = document.createElement('style');
        st.textContent = `
            #aml-settings-dialog {
                position:fixed; inset:0; margin:auto;
                width:min(660px,calc(100vw - 48px));
                max-height:min(82vh,760px); overflow-y:auto;
                border:0.5px solid rgba(255,255,255,0.14); border-radius:16px;
                background:rgba(18,18,20,0.93);
                backdrop-filter:blur(48px) saturate(1.9);
                -webkit-backdrop-filter:blur(48px) saturate(1.9);
                box-shadow:0 32px 80px rgba(0,0,0,0.8),0 0 0 0.5px rgba(255,255,255,0.07);
                padding:0 32px 32px; color:rgba(255,255,255,0.9);
                font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
            }
            #aml-settings-dialog::backdrop {
                background:rgba(0,0,0,0.4);
            }
            #aml-settings-dialog::-webkit-scrollbar { width:4px; }
            #aml-settings-dialog::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.18);border-radius:2px; }
            @keyframes _aml-pop-in  { from{opacity:0;transform:scale(0.88)} to{opacity:1;transform:scale(1)} }
            @keyframes _aml-pop-out { from{opacity:1;transform:scale(1)}    to{opacity:0;transform:scale(0.88)} }
            @keyframes _aml-spin    { to{transform:rotate(360deg)} }
            ._aml-spinner { display:inline-block;width:10px;height:10px;border:1.5px solid rgba(255,255,255,0.18);border-top-color:rgba(255,255,255,0.6);border-radius:50%;animation:_aml-spin .7s linear infinite;flex-shrink:0; }
            #aml-settings-dialog.aml-opening { animation:_aml-pop-in  .22s cubic-bezier(.34,1.4,.64,1) forwards; }
            #aml-settings-dialog.aml-closing { animation:_aml-pop-out .16s ease-in forwards; }
        `;
        document.head.appendChild(st);
        document.body.appendChild(dlg);
        return dlg;
    }

    function closeSettings() {
        const dlg = document.getElementById('aml-settings-dialog');
        if (!dlg?.open) return;
        dlg.classList.replace('aml-opening', 'aml-closing') || dlg.classList.add('aml-closing');
        dlg.addEventListener('animationend', () => { dlg.classList.remove('aml-closing'); dlg.close(); }, { once: true });
    }

    // ── Open settings — anchored to the account button ─────────────────────
    async function openSettings() {
        const dlg = getDialog();
        dlg.innerHTML = '';

        const titleBar = document.createElement('div');
        titleBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:18px 0 4px;';
        const title = document.createElement('h1');
        title.textContent = 'AML Settings';
        title.style.cssText = FF + 'font-size:15px;font-weight:600;margin:0;color:rgba(255,255,255,0.95);';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = FF +
            'background:rgba(255,255,255,0.1);border:none;border-radius:50%;width:22px;height:22px;' +
            'cursor:pointer;color:rgba(255,255,255,0.55);font-size:11px;display:flex;align-items:center;justify-content:center;';
        closeBtn.onclick = closeSettings;
        titleBar.appendChild(title); titleBar.appendChild(closeBtn);
        dlg.appendChild(titleBar);

        const drm   = await fetchDRM().catch(() => ({ state: {}, capabilities: {}, backend: {} }));
        const prefs = await window.amlBridge.getPrefs().catch(() => ({}));
        const s     = drm.state ?? {};

        dlg.appendChild(buildAccountSection(drm, openSettings));

        // ── Engine Status ──────────────────────────────────────────────────
        const { wrap: stWrap, body: stBody } = makeSection('Engine Status');

        function spinner() {
            const s = document.createElement('span');
            s.className = '_aml-spinner';
            return s;
        }

        function renderStatusRows(d) {
            const st = d.state ?? {};
            const proc = st.process ?? 'unknown';
            const procOk = proc === 'running';
            const procLoading = proc === 'starting';
            const fp = st.fairplay ?? 'unknown';
            const fpOk = fp === 'ready';
            const fpLoading = fp === 'unknown' && procLoading;
            const cbcs = d?.capabilities?.cbcs === true;
            const sessOk = st.session === 'valid' || cbcs;
            const sessText = st.session === 'valid' ? 'valid' : cbcs ? 'active (cbcs)' : st.session ?? 'unknown';
            const sessLoading = !sessOk && (procLoading || proc === 'running');
            return [
                { label: 'DRM process', ok: procOk, loading: procLoading, text: proc },
                { label: 'FairPlay',    ok: fpOk,   loading: fpLoading,   text: fp },
                { label: 'Session',     ok: sessOk, loading: sessLoading, text: sessText,
                  subtitle: 'Authentication lease with Apple servers' },
                { label: 'Backend',     text: d.backend?.selected ?? 'embedded', noDot: true },
            ];
        }

        function applyStatusRow(v, { ok, loading, text, noDot }) {
            v.innerHTML = '';
            if (!noDot) v.appendChild(loading ? spinner() : dot(ok));
            v.appendChild(document.createTextNode(text));
        }

        const valEls = [];
        renderStatusRows(drm).forEach((row, i, arr) => {
            const v = statusVal('', row.noDot ? undefined : row.ok);
            applyStatusRow(v, row);
            valEls.push({ el: v, noDot: !!row.noDot });
            stBody.appendChild(makeRow(row.label, v, row.subtitle, i === arr.length - 1));
        });

        const refreshRow = document.createElement('div');
        refreshRow.style.cssText = 'padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);margin-top:2px;';
        const refreshBtn = makeBtn('Refresh');
        refreshBtn.onclick = () => openSettings();
        refreshRow.appendChild(refreshBtn);
        stBody.appendChild(refreshRow);
        dlg.appendChild(stWrap);

        // Poll until all statuses resolve or dialog closes
        const isResolved = d => {
            const st = d.state ?? {};
            return (st.process === 'running') && (st.fairplay === 'ready') &&
                   (st.session === 'valid' || d?.capabilities?.cbcs === true);
        };
        if (!isResolved(drm)) {
            const poll = setInterval(async () => {
                if (!dlg.isConnected) { clearInterval(poll); return; }
                const d = await fetchDRM().catch(() => null);
                if (!d) return;
                renderStatusRows(d).forEach((row, i) => applyStatusRow(valEls[i].el, row));
                if (isResolved(d)) clearInterval(poll);
            }, 2000);
        }

        // ── Display ────────────────────────────────────────────────────────
        const { wrap: dWrap, body: dBody } = makeSection('Display');

        const RST = FF+'border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.45);border-radius:4px;padding:2px 6px;font-size:11px;cursor:pointer;margin-left:6px;flex-shrink:0;';
        function makeResetBtn(label, onClick) {
            const b = document.createElement('button'); b.title = `Reset ${label}`; b.textContent = '↺'; b.style.cssText = RST;
            b.onmouseenter = () => b.style.color = 'rgba(255,255,255,0.8)';
            b.onmouseleave = () => b.style.color = 'rgba(255,255,255,0.45)';
            b.onclick = onClick; return b;
        }

        const blurVal = document.createElement('span');
        blurVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;';
        blurVal.textContent = `${prefs.glassBlur ?? 20}px`;
        const blurSl = document.createElement('input');
        blurSl.type = 'range'; blurSl.min = 0; blurSl.max = 80; blurSl.step = 4; blurSl.value = prefs.glassBlur ?? 20;
        blurSl.style.cssText = 'flex:1;accent-color:#fc3c44;margin:0 10px;';
        blurSl.oninput = () => { blurVal.textContent = `${blurSl.value}px`; window.amlBridge.setGlassBlur(+blurSl.value); };
        const blurR = document.createElement('div');
        blurR.style.cssText = 'display:flex;align-items:center;flex:1;';
        blurR.appendChild(blurSl); blurR.appendChild(blurVal);
        blurR.appendChild(makeResetBtn('glass blur', () => { blurSl.value = 20; blurVal.textContent = '20px'; window.amlBridge.setGlassBlur(20); }));
        dBody.appendChild(makeRow('Glass blur', blurR, 'Sidebar and UI element blur intensity', false));

        const bgBlurVal = document.createElement('span');
        bgBlurVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;';
        bgBlurVal.textContent = `${prefs.bgBlur ?? 18}px`;
        const bgBlurSl = document.createElement('input');
        bgBlurSl.type = 'range'; bgBlurSl.min = 0; bgBlurSl.max = 60; bgBlurSl.step = 2; bgBlurSl.value = prefs.bgBlur ?? 18;
        bgBlurSl.style.cssText = 'flex:1;accent-color:#fc3c44;margin:0 10px;';
        bgBlurSl.oninput = () => { bgBlurVal.textContent = `${bgBlurSl.value}px`; window.amlBridge.setBgBlur(+bgBlurSl.value); };
        const bgBlurR = document.createElement('div');
        bgBlurR.style.cssText = 'display:flex;align-items:center;flex:1;';
        bgBlurR.appendChild(bgBlurSl); bgBlurR.appendChild(bgBlurVal);
        bgBlurR.appendChild(makeResetBtn('background blur', () => { bgBlurSl.value = 18; bgBlurVal.textContent = '18px'; window.amlBridge.setBgBlur(18); }));
        dBody.appendChild(makeRow('Background blur', bgBlurR, 'Wallpaper blur behind the window', false));

        const navOpVal = document.createElement('span');
        navOpVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;';
        const initNavAlpha = prefs.themeNavBgAlpha ?? 0.72;
        navOpVal.textContent = Math.round(initNavAlpha * 100) + '%';
        const navOpSl = document.createElement('input');
        navOpSl.type = 'range'; navOpSl.min = 0; navOpSl.max = 1; navOpSl.step = 0.01; navOpSl.value = initNavAlpha;
        navOpSl.style.cssText = 'flex:1;accent-color:#fc3c44;margin:0 10px;';
        navOpSl.oninput = () => { navOpVal.textContent = Math.round(+navOpSl.value * 100) + '%'; window.amlBridge.setNavOpacity(+navOpSl.value); };
        const navOpR = document.createElement('div');
        navOpR.style.cssText = 'display:flex;align-items:center;flex:1;';
        navOpR.appendChild(navOpSl); navOpR.appendChild(navOpVal);
        navOpR.appendChild(makeResetBtn('sidebar opacity', () => { navOpSl.value = 0.72; navOpVal.textContent = '72%'; window.amlBridge.setNavOpacity(0.72); }));
        dBody.appendChild(makeRow('Sidebar opacity', navOpR, 'How opaque the sidebar background is', false));

        const zoomVal = document.createElement('span');
        zoomVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;';
        zoomVal.textContent = `${Math.round((prefs.zoomFactor ?? 1) * 100)}%`;
        const zoomSl = document.createElement('input');
        zoomSl.type = 'range'; zoomSl.min = 75; zoomSl.max = 150; zoomSl.step = 25; zoomSl.value = Math.round((prefs.zoomFactor ?? 1) * 100);
        zoomSl.style.cssText = 'flex:1;accent-color:#fc3c44;margin:0 10px;';
        zoomSl.oninput = () => { zoomVal.textContent = `${zoomSl.value}%`; window.amlBridge.setZoom(+zoomSl.value / 100); };
        const zoomR = document.createElement('div');
        zoomR.style.cssText = 'display:flex;align-items:center;flex:1;';
        zoomR.appendChild(zoomSl); zoomR.appendChild(zoomVal);
        zoomR.appendChild(makeResetBtn('zoom', () => { zoomSl.value = 100; zoomVal.textContent = '100%'; window.amlBridge.setZoom(1); }));
        dBody.appendChild(makeRow('Zoom', zoomR, null, false));

        const toggle = document.createElement('input');
        toggle.type = 'checkbox'; toggle.checked = prefs.hideUpsell !== false;
        toggle.style.cssText = 'width:16px;height:16px;accent-color:#fc3c44;cursor:pointer;';
        toggle.onchange = () => window.amlBridge.setTweak('hideUpsell', toggle.checked);
        dBody.appendChild(makeRow('Hide upsell banners', toggle, null, true));

        dlg.appendChild(dWrap);

        // ── Theme ──────────────────────────────────────────────────────────────
        const { wrap: thWrap, body: thBody } = makeSection('Theme');
        const thInfo = await window.amlBridge.getThemeInfo().catch(() => ({ blurAvailable: false, themeMode: 'accent', themePalette: null, themePresets: [], customCssPath: null, systemAccent: '#fc3c44', themeAppearance: 'dark' }));
        const blurAvail = !!thInfo.blurAvailable;
        let curMode = thInfo.themeMode || (blurAvail ? 'blur' : 'accent');
        let curPalette = thInfo.themePalette;
        let thPresets = thInfo.themePresets || [];
        let curAppearance = thInfo.themeAppearance || 'dark';

        // Palette generation (frontend, no Node) — mirrors main.mjs _generatePalette
        function genPalette(hex, appearance) {
            if (!appearance) appearance = curAppearance;
            hex = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#fc3c44';
            const r=parseInt(hex.slice(1,3),16)/255, g=parseInt(hex.slice(3,5),16)/255, b=parseInt(hex.slice(5,7),16)/255;
            const mx=Math.max(r,g,b), mn=Math.min(r,g,b), l=(mx+mn)/2;
            const d=mx-mn, s=d===0?0:d/(1-Math.abs(2*l-1));
            let h=0; if(d){if(mx===r)h=((g-b)/d+6)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;}
            const hi=Math.round(h), si=Math.round(s*100);
            if (appearance === 'light') {
                return { accent:hex, bgColor:`hsla(${hi},${Math.round(si*.25)}%,96%,1)`, navBg:`hsla(${hi},${Math.round(si*.3)}%,91%,0.95)`, navBorder:`hsla(${hi},${Math.round(si*.6)}%,30%,0.15)`, accentActive:`hsla(${hi},${si}%,45%,0.15)` };
            }
            return { accent:hex, bgColor:`hsla(${hi},${Math.round(si*.5)}%,10%,1)`, navBg:`hsla(${hi},${Math.round(si*.8)}%,14%,0.72)`, navBorder:`hsla(${hi},${Math.round(si*.7)}%,50%,0.25)`, accentActive:`hsla(${hi},${Math.round(si*.9)}%,60%,0.28)` };
        }

        // hex→hsl color value from any CSS color string (for <input type=color>)
        function cssColorToHex(str) {
            if (/^#[0-9a-fA-F]{6}$/.test(str)) return str;
            const m = str.match(/hsla?\((\d+),\s*([\d.]+)%,\s*([\d.]+)%/);
            if (!m) return '#336699';
            const h=+m[1]/360, s=+m[2]/100, l=+m[3]/100, a=s*Math.min(l,1-l);
            const f=n=>{const k=(n+h*12)%12;return l-a*Math.max(-1,Math.min(k-3,9-k,1));};
            return '#'+[f(0),f(8),f(4)].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
        }

        // Mode selector
        const modeRow = document.createElement('div');
        modeRow.style.cssText = 'padding:12px 0;border-bottom:0.5px solid rgba(255,255,255,0.07);';
        const modeSeg = document.createElement('div');
        modeSeg.style.cssText = 'display:flex;background:rgba(255,255,255,0.06);border-radius:8px;padding:2px;gap:2px;';
        const thModes = [
            { label: 'Blur', value: 'blur', disabled: !blurAvail, tip: blurAvail ? '' : 'Only on Hyprland / KDE' },
            { label: 'Accent', value: 'accent', disabled: false, tip: '' },
            { label: 'Custom CSS', value: 'custom', disabled: false, tip: '' },
        ];
        const thContentArea = document.createElement('div');

        function renderThemeContent(mode) {
            thContentArea.innerHTML = '';
            if (mode === 'blur') {
                const info = document.createElement('div');
                info.style.cssText = FF+'font-size:12px;color:rgba(255,255,255,0.4);padding:12px 0;';
                info.textContent = blurAvail
                    ? 'Wallpaper is blurred and shown behind the app. Adjust intensity with the Background blur slider above.'
                    : 'Blur is only available on Hyprland and KDE. Your current desktop does not support it.';
                thContentArea.appendChild(info);
            } else if (mode === 'accent') {
                if (!curPalette) curPalette = genPalette(thInfo.systemAccent || '#fc3c44');
                renderPaletteEditor(thContentArea);
            } else {
                renderCustomCss(thContentArea);
            }
        }

        function renderPaletteEditor(container) {
            container.innerHTML = '';
            const pal = curPalette || genPalette(thInfo.systemAccent || '#fc3c44');

            // Light / Dark appearance toggle
            const appRow = document.createElement('div');
            appRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 0 8px;';
            const appLabel = document.createElement('span');
            appLabel.style.cssText = FF+'font-size:12px;color:rgba(255,255,255,0.5);flex:1;';
            appLabel.textContent = 'Appearance';
            const appSeg = document.createElement('div');
            appSeg.style.cssText = 'display:flex;background:rgba(255,255,255,0.06);border-radius:6px;padding:2px;gap:2px;';
            ['Dark','Light'].forEach(label => {
                const val = label.toLowerCase();
                const btn = document.createElement('button');
                btn.textContent = label;
                const activeStyle = 'background:rgba(255,255,255,0.18);color:rgba(255,255,255,0.95);';
                const inactiveStyle = 'background:transparent;color:rgba(255,255,255,0.4);';
                btn.style.cssText = `${FF}border:none;border-radius:5px;padding:3px 12px;font-size:12px;cursor:pointer;transition:all 0.15s;${curAppearance===val?activeStyle:inactiveStyle}`;
                btn.onclick = async () => {
                    curAppearance = val;
                    window.amlBridge.setThemeAppearance(val);
                    appSeg.querySelectorAll('button').forEach(b => {
                        b.style.background = 'transparent';
                        b.style.color = 'rgba(255,255,255,0.4)';
                    });
                    btn.style.background = 'rgba(255,255,255,0.18)';
                    btn.style.color = 'rgba(255,255,255,0.95)';
                    // setThemeAppearance regenerates+saves palette in main; fetch it back
                    const info = await window.amlBridge.getThemeInfo().catch(() => null);
                    if (info?.themePalette) { curPalette = info.themePalette; renderPaletteEditor(container); }
                };
                appSeg.appendChild(btn);
            });
            appRow.appendChild(appLabel);
            appRow.appendChild(appSeg);
            container.appendChild(appRow);

            const paletteKeys = [
                { key: 'bgColor', label: 'Background' },
                { key: 'accent', label: 'Accent' },
                { key: 'navBg', label: 'Sidebar' },
                { key: 'navBorder', label: 'Border' },
                { key: 'accentActive', label: 'Active' },
            ];
            const grid = document.createElement('div');
            grid.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:12px 0;border-bottom:0.5px solid rgba(255,255,255,0.07);';
            paletteKeys.forEach(({ key, label }) => {
                const cell = document.createElement('div');
                cell.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:4px;';
                const swatchWrap = document.createElement('div');
                swatchWrap.style.cssText = `height:30px;border-radius:6px;background:${pal[key]||'#333'};border:1px solid rgba(255,255,255,0.1);position:relative;overflow:hidden;cursor:pointer;`;
                const picker = document.createElement('input');
                picker.type = 'color';
                picker.value = cssColorToHex(pal[key] || '#336699');
                picker.style.cssText = 'position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;';
                picker.oninput = () => {
                    pal[key] = picker.value;
                    swatchWrap.style.background = picker.value;
                    curPalette = { ...pal };
                    window.amlBridge.setThemePalette(key, picker.value);
                };
                swatchWrap.appendChild(picker);
                const lbl = document.createElement('div');
                lbl.style.cssText = FF+'font-size:10px;color:rgba(255,255,255,0.4);text-align:center;';
                lbl.textContent = label;
                cell.appendChild(swatchWrap);
                cell.appendChild(lbl);
                grid.appendChild(cell);
            });
            container.appendChild(grid);

            const resetBtn = makeBtn('Reset to system accent');
            resetBtn.style.cssText += 'margin:10px 0;display:block;';
            resetBtn.onclick = async () => {
                const newPal = await window.amlBridge.resetThemePalette();
                if (newPal) { curPalette = newPal; renderPaletteEditor(container); }
            };
            container.appendChild(resetBtn);

            // Presets
            const presH = document.createElement('div');
            presH.style.cssText = FF+'font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.4);margin:12px 0 6px;';
            presH.textContent = 'Presets';
            container.appendChild(presH);

            const presetList = document.createElement('div');
            presetList.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;min-height:24px;margin-bottom:10px;';
            function renderPresets() {
                presetList.innerHTML = '';
                if (!thPresets.length) {
                    const none = document.createElement('span');
                    none.style.cssText = FF+'font-size:12px;color:rgba(255,255,255,0.25);';
                    none.textContent = 'No saved presets';
                    presetList.appendChild(none);
                    return;
                }
                thPresets.forEach(({ name, builtin }) => {
                    const chip = document.createElement('div');
                    chip.style.cssText = `display:flex;align-items:center;gap:4px;background:${builtin?'rgba(252,60,68,0.18)':'rgba(255,255,255,0.1)'};border-radius:20px;padding:3px 8px 3px 12px;cursor:default;${builtin?'border:1px solid rgba(252,60,68,0.35);':''}`;
                    const cl = document.createElement('span');
                    cl.style.cssText = FF+'font-size:12px;color:rgba(255,255,255,0.8);cursor:pointer;';
                    cl.textContent = name;
                    cl.onclick = () => {
                        const pr = thPresets.find(x => x.name === name);
                        if (pr) { curPalette = pr.palette; window.amlBridge.applyThemePreset(name); renderPaletteEditor(container); }
                    };
                    chip.appendChild(cl);
                    if (!builtin) {
                        const del = document.createElement('button');
                        del.textContent = '×';
                        del.style.cssText = 'border:none;background:transparent;color:rgba(255,255,255,0.35);cursor:pointer;font-size:14px;padding:0 0 0 4px;line-height:1;';
                        del.onclick = () => {
                            thPresets = thPresets.filter(x => x.name !== name);
                            window.amlBridge.deleteThemePreset(name);
                            renderPresets();
                        };
                        chip.appendChild(del);
                    }
                    presetList.appendChild(chip);
                });
            }
            renderPresets();
            container.appendChild(presetList);

            const actRow = document.createElement('div');
            actRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding-bottom:12px;align-items:center;';

            const saveNameInput = document.createElement('input');
            saveNameInput.type = 'text';
            saveNameInput.placeholder = 'Preset name…';
            saveNameInput.style.cssText = FF + 'display:none;padding:4px 8px;border-radius:6px;border:none;font-size:12px;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);width:110px;';

            const saveBtn = makeBtn('Save preset');
            saveBtn.onclick = () => {
                const showing = saveNameInput.style.display !== 'none';
                saveNameInput.style.display = showing ? 'none' : 'inline-block';
                if (!showing) { saveNameInput.value = ''; saveNameInput.focus(); }
            };

            const saveConfirmBtn = makeBtn('✓');
            saveConfirmBtn.title = 'Confirm save';
            saveConfirmBtn.style.cssText += 'display:none;padding:4px 9px;';
            const doSave = async () => {
                const name = saveNameInput.value.trim();
                if (!name) return;
                const newPresets = await window.amlBridge.saveThemePreset(name);
                if (newPresets) {
                    const builtins = thPresets.filter(x => x.builtin);
                    thPresets = [...builtins, ...newPresets];
                    renderPresets();
                }
                saveNameInput.style.display = 'none';
                saveConfirmBtn.style.display = 'none';
                saveBtn.textContent = 'Save preset';
            };
            saveConfirmBtn.onclick = doSave;
            saveNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); if (e.key === 'Escape') { saveNameInput.style.display = 'none'; saveConfirmBtn.style.display = 'none'; } });
            saveNameInput.addEventListener('input', () => {
                saveConfirmBtn.style.display = saveNameInput.value.trim() ? 'inline-block' : 'none';
            });

            const exportBtn = makeBtn('Export');
            exportBtn.onclick = async () => {
                const name = prompt('Preset name to export (leave blank for current palette):') || 'current';
                await window.amlBridge.exportThemePreset(name);
            };

            const importBtn = makeBtn('Import');
            importBtn.onclick = async () => {
                const preset = await window.amlBridge.importThemePreset();
                if (preset) {
                    thPresets = thPresets.filter(x => x.name !== preset.name);
                    thPresets.push(preset);
                    renderPresets();
                }
            };

            actRow.appendChild(saveBtn); actRow.appendChild(saveNameInput); actRow.appendChild(saveConfirmBtn); actRow.appendChild(exportBtn); actRow.appendChild(importBtn);
            container.appendChild(actRow);
        }

        function renderCustomCss(container) {
            container.innerHTML = '';
            const pathDiv = document.createElement('div');
            pathDiv.style.cssText = FF+'font-size:12px;color:rgba(255,255,255,0.5);padding:10px 0;word-break:break-all;min-height:32px;';
            pathDiv.textContent = thInfo.customCssPath || 'No file selected';
            container.appendChild(pathDiv);
            const btnsRow = document.createElement('div');
            btnsRow.style.cssText = 'display:flex;gap:6px;padding-bottom:10px;';
            const browseBtn = makeBtn('Browse & Import CSS');
            browseBtn.onclick = async () => {
                const fp = await window.amlBridge.importThemeCss();
                if (fp) { pathDiv.textContent = fp; thInfo.customCssPath = fp; }
            };
            const clearBtn = makeBtn('Clear');
            clearBtn.onclick = () => {
                const p = loadPrefs?.() ?? {};
                p.customCssPath = null;
                window.amlBridge.setThemeMode('custom');
                pathDiv.textContent = 'No file selected';
                thInfo.customCssPath = null;
            };
            const hint = document.createElement('div');
            hint.style.cssText = FF+'font-size:11px;color:rgba(255,255,255,0.28);padding-top:4px;';
            hint.textContent = 'See aml-custom.example.css in the project root for the template.';
            btnsRow.appendChild(browseBtn); btnsRow.appendChild(clearBtn);
            container.appendChild(btnsRow);
            container.appendChild(hint);
        }

        thModes.forEach(({ label, value, disabled, tip }) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.disabled = disabled;
            if (tip) btn.title = tip;
            const isActive = value === curMode;
            btn.style.cssText = `flex:1;padding:5px 0;border:none;border-radius:6px;${FF}font-size:12px;` +
                `cursor:${disabled?'not-allowed':'pointer'};transition:background .15s,color .15s;` +
                (isActive ? 'background:rgba(255,255,255,0.18);color:rgba(255,255,255,0.88);font-weight:500;' : 'background:transparent;color:rgba(255,255,255,0.38);') +
                (disabled ? 'opacity:0.3;' : '');
            btn.onclick = () => {
                if (disabled) return;
                curMode = value;
                modeSeg.querySelectorAll('button').forEach((b, i) => {
                    const a = thModes[i].value === curMode;
                    b.style.background = a ? 'rgba(255,255,255,0.18)' : 'transparent';
                    b.style.color = a ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.38)';
                    b.style.fontWeight = a ? '500' : '';
                });
                window.amlBridge.setThemeMode(value);
                renderThemeContent(value);
            };
            modeSeg.appendChild(btn);
        });

        modeRow.appendChild(modeSeg);
        thBody.appendChild(modeRow);
        thBody.appendChild(thContentArea);
        renderThemeContent(curMode);
        dlg.appendChild(thWrap);

        // ── Cache ──────────────────────────────────────────────────────────
        const { wrap: cWrap, body: cBody } = makeSection('Playback Cache');
        const cacheStats = await fetch(`${ENGINE}/api/v1/cache/stats`).then(r => r.json()).catch(() => null);

        // Persistent cache section
        const persist = cacheStats?.persistent;
        if (persist?.available !== false) {
            const usedMB   = Math.round((persist?.sizeBytes ?? 0) / (1024 * 1024));
            const limitMB  = Math.round((persist?.limitBytes ?? 500 * 1024 * 1024) / (1024 * 1024));
            const ttlDays  = persist?.ttlDays ?? 5;

            // Progress bar
            const pct = limitMB > 0 ? Math.min(100, Math.round(usedMB / limitMB * 100)) : 0;
            const barWrap = document.createElement('div');
            barWrap.style.cssText = 'flex:1;';
            const barBg = document.createElement('div');
            barBg.style.cssText = 'height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;';
            const barFill = document.createElement('div');
            barFill.style.cssText = `height:100%;width:${pct}%;background:#fc3c44;border-radius:2px;`;
            barBg.appendChild(barFill);
            const barLabel = document.createElement('div');
            barLabel.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.4);';
            barLabel.textContent = `${usedMB} MB / ${limitMB} MB`;
            barWrap.appendChild(barBg); barWrap.appendChild(barLabel);
            cBody.appendChild(makeRow('Song cache used', barWrap, 'Frequently played songs cached to disk', false));

            // Size slider
            const szVal = document.createElement('span');
            szVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);width:50px;text-align:right;';
            szVal.textContent = `${limitMB} MB`;
            const szSl = document.createElement('input');
            szSl.type = 'range'; szSl.min = 100; szSl.max = 10000; szSl.step = 100; szSl.value = limitMB;
            szSl.style.cssText = 'flex:1;accent-color:#fc3c44;margin:0 10px;';
            szSl.oninput = () => { szVal.textContent = `${szSl.value} MB`; };
            szSl.onchange = () => {
                const v = +szSl.value;
                window.amlBridge?.setPref('persistLimitMB', v);
                fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persistLimitMB: v }) }).catch(() => {});
            };
            const szRow = document.createElement('div');
            szRow.style.cssText = 'display:flex;align-items:center;flex:1;';
            szRow.appendChild(szSl); szRow.appendChild(szVal);
            cBody.appendChild(makeRow('Cache size limit', szRow, null, false));

            // TTL input
            const ttlInp = document.createElement('input');
            ttlInp.type = 'number'; ttlInp.min = 1; ttlInp.max = 365; ttlInp.value = ttlDays;
            ttlInp.style.cssText = FF + 'width:60px;padding:4px 8px;border-radius:6px;border:none;font-size:13px;' +
                'background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);text-align:center;';
            ttlInp.onchange = () => {
                const v = Math.max(1, +ttlInp.value || 5);
                ttlInp.value = v;
                window.amlBridge?.setPref('persistTTLDays', v);
                fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persistTTLDays: v }) }).catch(() => {});
            };
            const ttlWrap = document.createElement('div');
            ttlWrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
            ttlWrap.appendChild(ttlInp);
            const ttlUnit = document.createElement('span');
            ttlUnit.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);';
            ttlUnit.textContent = 'days';
            ttlWrap.appendChild(ttlUnit);
            cBody.appendChild(makeRow('Expiry', ttlWrap, 'Songs unused longer than this are removed', false));

            const clearRow = document.createElement('div');
            clearRow.style.cssText = 'padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);margin-top:2px;display:flex;gap:6px;';
            const clearSongsBtn = makeBtn('Clear Songs');
            clearSongsBtn.onclick = () => {
                fetch(`${ENGINE}/api/v1/cache/playback?what=persistent`, { method: 'DELETE' }).then(() => openSettings()).catch(() => {});
            };
            clearRow.appendChild(clearSongsBtn);
            cBody.appendChild(clearRow);
        }

        // Prewarm cache section
        const prewarm = cacheStats?.prewarm;
        const pwUsedMB  = Math.round((prewarm?.sizeBytes ?? 0) / (1024 * 1024));
        const pwLimitMB = Math.round((prewarm?.limitBytes ?? 1024 * 1024 * 1024) / (1024 * 1024));
        const pwPct = pwLimitMB > 0 ? Math.min(100, Math.round(pwUsedMB / pwLimitMB * 100)) : 0;

        const pwBarWrap = document.createElement('div');
        pwBarWrap.style.cssText = 'flex:1;';
        const pwBarBg = document.createElement('div');
        pwBarBg.style.cssText = 'height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;';
        const pwBarFill = document.createElement('div');
        pwBarFill.style.cssText = `height:100%;width:${pwPct}%;background:#0a84ff;border-radius:2px;`;
        pwBarBg.appendChild(pwBarFill);
        const pwBarLabel = document.createElement('div');
        pwBarLabel.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.4);';
        pwBarLabel.textContent = `${pwUsedMB} MB / ${pwLimitMB} MB`;
        pwBarWrap.appendChild(pwBarBg); pwBarWrap.appendChild(pwBarLabel);
        cBody.appendChild(makeRow('Pre-warm buffer', pwBarWrap, 'Next 2 tracks pre-loaded in memory', false));

        const pwSzVal = document.createElement('span');
        pwSzVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);width:50px;text-align:right;';
        pwSzVal.textContent = `${pwLimitMB} MB`;
        const pwSzSl = document.createElement('input');
        pwSzSl.type = 'range'; pwSzSl.min = 100; pwSzSl.max = 4096; pwSzSl.step = 128; pwSzSl.value = pwLimitMB;
        pwSzSl.style.cssText = 'flex:1;accent-color:#0a84ff;margin:0 10px;';
        pwSzSl.oninput = () => { pwSzVal.textContent = `${pwSzSl.value} MB`; };
        pwSzSl.onchange = () => {
            const v = +pwSzSl.value;
            window.amlBridge?.setPref('prewarmLimitMB', v);
            fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prewarmLimitMB: v }) }).catch(() => {});
        };
        const pwSzRow = document.createElement('div');
        pwSzRow.style.cssText = 'display:flex;align-items:center;flex:1;';
        pwSzRow.appendChild(pwSzSl); pwSzRow.appendChild(pwSzVal);
        cBody.appendChild(makeRow('Pre-warm size limit', pwSzRow, null, true));

        const pwClearRow = document.createElement('div');
        pwClearRow.style.cssText = 'padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);margin-top:2px;';
        const clearPrewarmBtn = makeBtn('Clear Pre-warm');
        clearPrewarmBtn.onclick = () => {
            fetch(`${ENGINE}/api/v1/cache/playback?what=prewarm`, { method: 'DELETE' }).then(() => openSettings()).catch(() => {});
        };
        pwClearRow.appendChild(clearPrewarmBtn);
        cBody.appendChild(pwClearRow);

        dlg.appendChild(cWrap);

        // ── Developer section ──────────────────────────────────────────────────
        const { wrap: devWrap, body: devBody } = makeSection('Developer');
        const debugToggle = document.createElement('input');
        debugToggle.type = 'checkbox';
        debugToggle.checked = !!(prefs.debug);
        debugToggle.style.cssText = 'width:16px;height:16px;accent-color:#0a84ff;cursor:pointer;';
        debugToggle.onchange = () => {
            window.amlBridge?.setPref('debug', debugToggle.checked);
        };
        devBody.appendChild(makeRow('Enable debug mode', debugToggle, 'Opens DevTools and full console on next launch', true));
        dlg.appendChild(devWrap);

        if (!dlg.open) {
            dlg.classList.remove('aml-closing');
            dlg.classList.add('aml-opening');
            dlg.showModal();
            dlg.addEventListener('animationend', () => dlg.classList.remove('aml-opening'), { once: true });
        }
    }

    // ── Settings cog next to account row ──────────────────────────────────
    // Apple SF Symbols–style gearshape.fill — 8-tooth gear with circular centre hole
    const COG_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%" style="display:block;padding:17%"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.05-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;

    function findAccountRow() {
        return (
            document.querySelector('nav.navigation [class*="account"]') ||
            document.querySelector('nav.navigation [class*="Account"]') ||
            document.querySelector('[class*="navigation-account"]') ||
            document.querySelector('[class*="NavigationAccount"]') ||
            document.querySelector('nav.navigation [aria-haspopup="true"]') ||
            document.querySelector('nav.navigation [aria-haspopup="menu"]')
        );
    }

    function mountSettingsCog() {
        if (document.getElementById('aml-settings-cog')) return;
        const accountRow = findAccountRow();
        if (!accountRow) return;

        // Match the avatar circle size
        const avatarEl = accountRow.querySelector('img, [class*="avatar"], [class*="Avatar"], [class*="profile"], [class*="Profile"]');
        const avatarSize = avatarEl ? Math.round(avatarEl.getBoundingClientRect().width) || 28 : 28;
        const sz = Math.max(avatarSize, 28) + 'px';

        const cog = document.createElement('button');
        cog.id = 'aml-settings-cog';
        cog.title = 'AML Settings';
        cog.innerHTML = COG_SVG;
        cog.style.cssText = [
            'position:absolute',
            'right:10px',
            'top:50%',
            'transform:translateY(-50%)',
            'z-index:100',
            `width:${sz}`,
            `height:${sz}`,
            'border-radius:50%',
            'border:none',
            'background:rgba(255,255,255,0.10)',
            'color:rgba(255,255,255,0.55)',
            'cursor:pointer',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'transition:background 0.15s,color 0.15s',
            '-webkit-app-region:no-drag',
            'flex-shrink:0',
            'box-sizing:border-box',
        ].join(';');
        cog.onmouseenter = () => { cog.style.background = 'rgba(255,255,255,0.20)'; cog.style.color = 'rgba(255,255,255,0.9)'; };
        cog.onmouseleave = () => { cog.style.background = 'rgba(255,255,255,0.10)'; cog.style.color = 'rgba(255,255,255,0.55)'; };
        cog.onclick = (e) => { e.stopPropagation(); openSettings(); };

        // Make parent relative so absolute positioning works
        const parent = accountRow.closest('li, [class*="account"], [class*="Account"]') || accountRow;
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
        parent.appendChild(cog);

    }

    // Watch the entire document so the cog re-mounts after SPA navigation
    // replaces the sidebar (observing only parent misses parent-level removals).
    const cogWatcher = new MutationObserver(() => {
        if (findAccountRow() && !document.getElementById('aml-settings-cog')) mountSettingsCog();
    });
    if (findAccountRow()) mountSettingsCog();
    cogWatcher.observe(document.documentElement, { childList: true, subtree: true });

    window.__amlOpenEngineSettings = openSettings;

    // Kill gradient/vignette overlay elements that CSS selectors miss
})();
