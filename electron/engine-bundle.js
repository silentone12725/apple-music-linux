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

// ── Power Budget ───────────────────────────────────────────────────────────────
// Classifies runtime into full / reduced / minimal based on battery state and
// measured RAF jitter (proxy for CPU throttle). UI timing constants adapt;
// playback-critical intervals (bufPoll) are fixed regardless of power mode.
const _TIMINGS = {
    full:    { poll: 250,  debounce: 150, losslessWait: 1500,  sseWait: 4000,  qualityRace: 200,  mkCheck: 50  },
    reduced: { poll: 250,  debounce: 350, losslessWait: 3500,  sseWait: 8000,  qualityRace: 500,  mkCheck: 100 },
    minimal: { poll: 250,  debounce: 700, losslessWait: 6000,  sseWait: 12000, qualityRace: 1200, mkCheck: 200 },
};
// MV buffer poll is always 250ms regardless of power mode.
// Downloads happen in the Go engine (out-of-process) and are unaffected by
// Chromium throttling; keeping the poll fixed prevents coarser stall detection
// that would make pauses feel longer on battery.
const BUF_POLL_MS = 250;
let _powerMode = 'full';
// null = unknown (assume plugged in until Battery API resolves)
let _isCharging = null;
function T() { return _TIMINGS[_powerMode]; }

function _setPowerMode(mode) {
    if (mode === _powerMode) return;
    // Never throttle when definitively on AC power.
    if (_isCharging === true && mode !== 'full') return;
    _powerMode = mode;
    console.log(`[AML Power] mode=${mode}`);
    // Restart VLC poll at new interval if one is active
    if (_vlcMode && _vlcPollTimer) { const a = getMKAudio(); if (a) startVLCPoll(a); }
}

// Battery API — reclassify on charge/level changes
navigator.getBattery?.().then(bat => {
    const upd = () => {
        _isCharging = bat.charging;
        if (bat.charging)          _setPowerMode('full');
        else if (bat.level > 0.25) _setPowerMode('reduced');
        else                       _setPowerMode('minimal');
    };
    bat.addEventListener('chargingchange', upd);
    bat.addEventListener('levelchange', upd);
    upd();
}).catch(() => {
    // No Battery API (desktop without battery) — always full.
    _isCharging = true;
});

// RAF jitter probe — delayed 3 s so page-load jitter doesn't falsely trigger.
// Threshold 55 ms (two missed 30fps frames) is a reliable signal of CPU throttle.
// Skipped entirely when charging is confirmed.
;(function probeJitter() {
    setTimeout(() => {
        if (_isCharging === true) return;
        let n = 0, sum = 0, prev = performance.now();
        const probe = now => {
            if (n > 0) sum += now - prev;
            prev = now;
            if (++n < 16) { requestAnimationFrame(probe); return; }
            const avg = sum / (n - 1);
            if (avg > 55 && _powerMode === 'full') _setPowerMode('reduced');
        };
        requestAnimationFrame(probe);
    }, 3000);
})();

// ── Raw audio capture module ──────────────────────────────────────────────────
// Stores raw chunk bytes + deep MP4 parse for every audio append so the
// external debug_app.py inspector can retrieve and analyse them.
// Capped at 64 MB total to avoid OOM.  Gated: set window._amlDebug=true to enable.
if (window._amlDebug) (function installAudioCapture() {
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
    const _suppress = s => typeof s === 'string' && s.includes('eventQueue overflow');
    for (const method of ['log', 'warn', 'error', 'info']) {
        const _orig = console[method];
        console[method] = (...args) => { if (!_suppress(args[0])) _orig.apply(console, args); };
    }
})();

// ── Native handles ─────────────────────────────────────────────────────────────

let _nativeSrcSet = null; // saved by blockAppleCDN() for our own src writes
let _nativeCTSet  = null; // native currentTime setter — used by MSE seek to fire 'seeking'
let _nativePlay   = null; // saved when play() proxy is installed on the element
let _ourBlobUrl   = null; // current blob URL we own; blocks MK from replacing it
let _allowCDNTransition  = false; // temporarily lifted during changeToMediaAtIndex so MK can settle NPIDF
let _externalPlayGateTimer = null; // safety reset timer for _allowCDNTransition

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
let _vlcVolPersist = 100;   // volume (0-200) persisted across track transitions
let _amlTransitioning = false; // true during _amlGoto (set before setQueue, cleared after NPIDF)

// ── Session queue ─────────────────────────────────────────────────────────────
// The session queue is a list of containers. Each container is one play context
// (album, playlist, single) represented as an ordered array of song IDs.
// next/prev traverse within the current container first, then cross into adjacent
// containers. repeat-all loops only the current container — matching Android.
// Cross-container prev gives history navigation Android doesn't have.
let _sessionContainers   = []; // [{items:[songId,...]}, ...]
let _sessionContainerIdx = -1; // which container is active (-1 = nothing yet)
let _sessionItemIdx      = -1; // position within current container
let _amlNavInternal      = false; // true when NPIDF is expected from our _amlGoto call
let _amlPendingCI        = -1;   // container index to apply in NPIDF (set by _amlGoto)
let _amlPendingII        = -1;   // item index to apply in NPIDF

const _extractItemId = (item) =>
    item?.playParams?.catalogId
    ?? item?.attributes?.playParams?.catalogId
    ?? item?.id
    ?? item?.playParams?.id
    ?? item?.attributes?.playParams?.id
    ?? null;

function _sessionFlatIds() {
    return _sessionContainers.flatMap(c => c.items);
}
function _sessionFlatIdx(ci, ii) {
    let n = 0;
    for (let i = 0; i < ci; i++) n += _sessionContainers[i].items.length;
    return n + ii;
}
let _vlcLyricsFreezeTimer = null; // fires timeupdate at frozen pos while VLC paused (keeps karaoke at exact word)

function _startLyricsFreeze(mkAudio) {
    if (_vlcLyricsFreezeTimer) return;
    _vlcLyricsFreezeTimer = setInterval(
        () => mkAudio.dispatchEvent(new Event('timeupdate')), 100);
}
function _stopLyricsFreeze() {
    if (!_vlcLyricsFreezeTimer) return;
    clearInterval(_vlcLyricsFreezeTimer);
    _vlcLyricsFreezeTimer = null;
}
let _vlcPollTimer  = null;  // setInterval handle
let _vlcSeekTimer  = null;  // debounce: actual VLC seek fires after scrubbing stops
let _vlcSeekFrozen    = false; // true during scrub → poll won't overwrite _vlcPosMs
let _vlcSeekOffsetMs  = 0;    // song-position base of current VLC HTTP stream (ms)
let _vlcRetryCount    = 0;    // premature-end retries for current track (reset on track change)
let _vlcPrevState     = null; // last VLC state seen by the poll (null forces re-emit after seek)
let _vlcLoading       = false; // true from VLC.Load until VLC first enters 'playing' state
let _seekBurstLog     = 0;    // ticks remaining in post-seek burst logging window
let _vlcPostSeek      = false; // true after seek fires, clears on next 'playing' tick
let _vlcWasPlaying    = false; // playback state captured at seek initiation
let _vlcSeekTargetMs  = 0;    // requested seek position; used in burst logs to show Δ from actual

// ── Gapless ALAC pre-warm ─────────────────────────────────────────────────────
let _nextAlacSession = null; // { adamId, sess } — pre-warmed session for the next ALAC track
let _nextAlacTried   = false; // prevents re-triggering within the same track
let _nextAlacRetries = 0;    // retry attempts so far for current track (max 3)

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

let _engineCaps       = { lossless: false, atmos: false };
let _streamingQuality  = 'lossless'; // 'high-quality' | 'lossless' | 'hi-res-lossless'
let _downloadsQuality  = 'lossless'; // same options, applied to export requests
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
            if (isAppleCDN(val) && !_allowCDNTransition) { console.log('[AML Engine] Blocked CDN src:', val.slice(0, 80)); return; }
            if (val?.startsWith('blob:') && _ourBlobUrl && val !== _ourBlobUrl) { return; }
            desc.set.call(this, val);
        },
        configurable: true,
        enumerable: desc.enumerable,
    });

    const realSetAttr = HTMLMediaElement.prototype.setAttribute;
    HTMLMediaElement.prototype.setAttribute = function(name, val) {
        if (name === 'src' && isAppleCDN(val) && !_allowCDNTransition) return;
        return realSetAttr.call(this, name, val);
    };

    console.log('[AML Engine] Apple CDN audio blocked');

    // Guard MK's MSE buffer management from crashing when SourceBuffers are detached.
    // In VLC mode we install a silent MediaSource; MK's AudioPlayer keeps stale
    // references to the old session's SourceBuffers and reads .buffered on every
    // timeupdate, throwing InvalidStateError. Return an empty TimeRanges instead.
    const _sbDesc = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, 'buffered');
    if (_sbDesc) {
        const _sbEmptyEl = document.createElement('audio'); // buffered is always empty
        Object.defineProperty(SourceBuffer.prototype, 'buffered', {
            configurable: true,
            get() {
                try { return _sbDesc.get.call(this); }
                catch (e) {
                    if (e instanceof DOMException && e.name === 'InvalidStateError')
                        return _sbEmptyEl.buffered;
                    throw e;
                }
            }
        });
        // Also guard .remove() and .abort() which throw the same error on detached buffers
        for (const method of ['remove', 'abort', 'appendBuffer']) {
            const orig = SourceBuffer.prototype[method];
            if (orig) SourceBuffer.prototype[method] = function(...args) {
                try { return orig.apply(this, args); }
                catch (e) {
                    if (e instanceof DOMException && e.name === 'InvalidStateError') return;
                    throw e;
                }
            };
        }
    }
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
            // Capture playback state on first seek call; MK may pause() during the
            // scrub gesture which would flip _vlcPaused before the timer fires.
            if (!_vlcSeekTimer) _vlcWasPlaying = !_vlcPaused;
            clearTimeout(_vlcSeekTimer);
            _vlcSeekTimer = setTimeout(async () => {
                _vlcSeekTimer = null;
                const seekTarget = _vlcPosMs;
                _vlcSeekTargetMs = seekTarget;
                console.log(`[AML VLC seek] ► SEND  posMs=${seekTarget}ms  wasPlaying=${_vlcWasPlaying}  uiPos=${_vlcPosMs}ms`);
                let actualStartMs = seekTarget;
                try {
                    const t0 = performance.now();
                    const seekResp = await fetch(`${ENGINE}/api/v1/vlc/seek`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ posMs: seekTarget, sessionId: _sessionId }),
                    });
                    const rtt = (performance.now() - t0).toFixed(0);
                    const seekData = await seekResp.json().catch(() => ({}));
                    actualStartMs = seekData.actualStartMs ?? seekTarget;
                    console.log(`[AML VLC seek] ◄ RECV  target=${seekTarget}ms  engine.actualStart=${actualStartMs}ms  rtt=${rtt}ms`);
                    // Snap seek bar to the requested target while VLC reloads.
                    _vlcPosMs = seekTarget;
                } catch (e) {
                    console.warn(`[AML VLC seek] ✗ ERROR`, e);
                }
                _vlcSeekOffsetMs = 0;
                _vlcPrevState = null;
                _vlcSeekFrozen = false;
                _seekBurstLog = 20;            // log every tick for 5s after seek
                if (_vlcWasPlaying) {
                    _vlcPaused   = false;
                    _vlcPostSeek = true;
                    fetch(`${ENGINE}/api/v1/vlc/resume`, { method: 'POST' }).catch(() => {});
                }
                console.log(`[AML VLC seek] ↺ UNFREEZE  uiPos=${_vlcPosMs}ms  postSeek=${_vlcPostSeek}`);
                // Emit Seeked signal so MPRIS clients re-anchor their seek bar.
                window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1000, seeked: true });
            }, T().debounce);
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
            setTimeout(check, T().mkCheck);
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

// Lossless SVG icon (from AMP.UI.Controls, fill switched to white)
const _losslessSVG = `<svg viewBox="0 0 69 44" xmlns="http://www.w3.org/2000/svg" style="height:12px;width:auto;display:block;flex-shrink:0"><path d="M36.8269026,4 C42.3794214,4 45.7184513,10.5183153 48.20334,17.4261699 L48.4450486,18.1066712 L48.6815356,18.788389 L48.9130884,19.4700271 C49.6770268,21.7405814 50.36352,23.9882073 51.0204784,25.9968947 C52.5296562,19.7123189 51.7381954,18.3629096 53.3551269,18.3629096 C53.9565751,18.3629096 54.5652965,18.7717786 54.5652965,19.5168498 C54.5652965,19.8184059 54.0740356,23.0143253 53.391361,26.2165815 L53.2651959,26.7982368 L53.1352128,27.3761743 C52.9156151,28.3341623 52.6817778,29.2605867 52.4420448,30.075084 C59.3914285,48.2833991 64.5514879,24.299737 65.134561,19.3973484 C65.2196627,18.6903693 65.7520794,18.3629223 66.2903224,18.3629223 C67.0092304,18.3629223 67.5985395,18.9043683 67.4862017,19.7191497 C66.2419581,27.647702 64.3284002,40 56.4607867,40 C52.1189889,40 49.6781873,36.6024859 47.7506208,32.7092263 C46.4116896,30.0790205 45.2734117,26.952661 44.2263394,23.8087368 L43.9767371,23.0541028 C43.8940827,22.8026091 43.811956,22.5512479 43.7303009,22.3002645 L43.4866946,21.5486922 C41.1040436,14.1741911 39.0830717,7.34159293 35.9851696,7.34159293 C34.4711899,7.34159293 33.3487598,8.92234593 33.2709954,8.92234593 C33.128169,8.92234593 33.0160746,8.27828447 31.602332,6.51365955 C32.9478242,4.97723054 34.8023002,4 36.8269026,4 Z M11.0614865,4.01937104 C23.4500006,4.01937104 24.5519172,36.7070003 31.5633281,36.7070003 C32.3865195,36.7070003 33.2738509,36.2079668 34.2437613,35.0776923 C34.7806086,35.9871115 35.3308882,36.7945268 35.9004521,37.5054184 C34.500923,39.1028534 32.7595403,39.9988275 30.578884,39.9988275 C22.7448451,39.9977315 19.3788608,26.8790797 16.4819088,18.0220558 C15.7996486,20.8631751 15.4455023,23.434387 15.3068631,24.5887478 C15.2208267,25.3223111 14.6831215,25.6566526 14.1414468,25.6566526 C13.5407541,25.6566526 12.9351571,25.2454896 12.9351571,24.5116332 C12.9351571,24.4569356 12.9385248,24.4004537 12.9455035,24.3422131 C13.346708,21.4307464 14.1551865,17.0196557 15.0604448,13.9441978 C13.8554484,10.7869356 12.3503425,7.33621492 10.1329104,7.33621492 C5.65625092,7.33621492 3.09261157,18.5867088 2.37169324,24.5887478 C2.28565683,25.3223111 1.74795163,25.6566526 1.20627691,25.6566526 C0.605597004,25.6566526 0,25.2454896 0,24.5116332 C0,24.4569356 0.00336770017,24.4004537 0.0103463944,24.3422131 C0.114233957,23.5883333 0.225608359,22.8207923 0.346678477,22.046953 L0.452878843,21.3822914 C0.470991821,21.2713147 0.48931555,21.1602523 0.50785647,21.0491258 L0.621759807,20.3817689 C2.0405473,12.2570738 4.68538356,4.01937104 11.0614865,4.01937104 Z M23.9155499,4.00146557 C26.1404345,4.00146557 28.5270839,5.15921632 30.5844926,7.87545613 C30.6994554,8.00734485 31.8526558,9.79953527 32.2166235,10.4208612 C33.474197,12.6992201 34.5694223,15.4837436 35.5796467,18.378952 L35.8413062,19.1364745 C38.7427747,27.6177062 40.980016,36.7463669 44.4650259,36.7463669 C45.2911112,36.7463669 46.1873164,36.2334422 47.1790849,35.0773864 C47.7158553,35.9867291 48.2660581,36.794068 48.835558,37.5049086 C47.4394606,39.099438 45.6989231,39.9988275 43.5140667,39.9988275 C31.1995909,39.9969924 29.8609621,7.32900175 23.0764932,7.32900175 C21.5454317,7.32900175 20.4138588,8.92244789 20.3357358,8.92244789 C20.1928455,8.92244789 20.0806102,8.27846289 18.6670468,6.51397816 C20.048649,4.9358122 21.9168263,4.00146557 23.9155499,4.00146557 Z" fill="white" fill-rule="nonzero"/></svg>`;

// State shared across showQualityBadge calls (populated by handleTrackChange)
let _qualityBadgeInfo = { codec: null, sampleRate: null, bitDepth: null, spatialAudio: null };

function _buildQualityPopup() {
    let pop = document.getElementById('aml-quality-popup');
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'aml-quality-popup';
        Object.assign(pop.style, {
            position: 'fixed', zIndex: '1000002',
            background: 'rgba(30,30,32,0.92)',
            backdropFilter: 'blur(60px) saturate(200%)',
            WebkitBackdropFilter: 'blur(60px) saturate(200%)',
            border: '0.5px solid rgba(255,255,255,0.11)',
            borderRadius: '12px',
            padding: '9px 13px 10px',
            color: '#fff',
            fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif',
            fontSize: '13px', lineHeight: '1.38',
            display: 'none', pointerEvents: 'none',
            boxShadow: '0 4px 24px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.4)',
            whiteSpace: 'nowrap',
        });
        document.body.appendChild(pop);
    }
    return pop;
}

function _showQualityPopup(anchorEl) {
    const { codec, sampleRate, bitDepth, spatialAudio } = _qualityBadgeInfo;
    const pop = _buildQualityPopup();

    // macOS Music app tooltip style: title + single detail line
    let title = '', detail = '';
    if (spatialAudio === 'binaural-lossless') {
        title  = 'Spatial Audio';
        detail = 'Dolby Atmos · Lossless Binaural';
    } else if (spatialAudio === 'binaural') {
        title  = 'Spatial Audio';
        detail = 'Dolby Atmos · Binaural';
    } else if (codec === 'alac') {
        const hiRes = sampleRate > 48000 || bitDepth > 16;
        const khz   = sampleRate ? `${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz` : '';
        const bits  = bitDepth && bitDepth > 16 ? `${bitDepth}-bit ` : '';
        title  = hiRes ? 'Lossless' : 'Lossless';
        detail = `${bits}${khz} ALAC`.trim();
    }

    pop.innerHTML =
        `<div style="font-size:13px;font-weight:590;letter-spacing:-0.01em;color:#fff;margin-bottom:1px">${title}</div>` +
        `<div style="font-size:12px;font-weight:400;color:rgba(255,255,255,0.55)">${detail}</div>`;

    pop.style.display = 'block';
    const r = anchorEl.getBoundingClientRect();
    // Position above the badge, centered
    const pw = pop.offsetWidth || 130;
    const ph = pop.offsetHeight || 52;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    const top = Math.max(8, r.top - ph - 6);
    pop.style.left = left + 'px';
    pop.style.top  = top + 'px';
}

function showQualityBadge(codec, sampleRate, bitDepth, spatialAudio) {
    _qualityBadgeInfo = { codec, sampleRate, bitDepth, spatialAudio };
    let badge = document.getElementById('aml-quality-badge');

    let color, isHiRes = false, isSpatial = false, label = '';
    if (spatialAudio === 'binaural-lossless' || spatialAudio === 'binaural') {
        color    = '#bf5af2';
        label    = 'SPATIAL AUDIO';
        isSpatial = true;
    } else if (codec === 'alac') {
        isHiRes  = sampleRate > 48000 || bitDepth > 16;
        color    = '#30d158';
        label    = isHiRes ? 'HI-RES' : '';
    } else {
        if (badge) badge.style.display = 'none';
        document.getElementById('aml-quality-popup')?.style && (document.getElementById('aml-quality-popup').style.display = 'none');
        return;
    }

    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'aml-quality-badge';
        badge.style.cssText =
            'display:inline-flex;align-items:center;gap:3px;' +
            'border-radius:3px;padding:1px 4px;' +
            'cursor:pointer;z-index:9999;white-space:nowrap;' +
            'font-size:7.5px;font-weight:700;letter-spacing:.07em;' +
            'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;' +
            'transition:opacity 0.12s;';

        badge.addEventListener('mouseenter', () => { badge.style.opacity = '0.75'; });
        badge.addEventListener('mouseleave', () => {
            badge.style.opacity = '1';
            // Hide popup when mouse leaves badge
            setTimeout(() => {
                const pop = document.getElementById('aml-quality-popup');
                if (pop) pop.style.display = 'none';
            }, 200);
        });
        badge.addEventListener('click', (e) => {
            e.stopPropagation();
            const pop = document.getElementById('aml-quality-popup');
            if (pop && pop.style.display !== 'none') {
                pop.style.display = 'none';
            } else {
                _showQualityPopup(badge);
            }
        });
        // Click anywhere else closes popup
        document.addEventListener('click', () => {
            const pop = document.getElementById('aml-quality-popup');
            if (pop) pop.style.display = 'none';
        }, true);

        // Insert badge directly after the ★ inside marquee__menu-slot-container.
        badge.style.flexShrink = '0';
        badge.style.alignSelf  = 'center';
        badge.style.marginLeft = '2px';

        function _insertBadgeIntoSlot(attempt) {
            const lcd = document.querySelector(
                '[data-testid="lcd-metadata"], .player-lcd, .web-chrome-playback-lcd'
            );
            const slot = lcd?.querySelector('.marquee--primary .marquee__menu-slot-container');
            const favEl = slot?.querySelector('.favorite-badge, [data-testid="favorite-button"]');
            if (slot && favEl) {
                slot.style.display    = 'flex';
                slot.style.alignItems = 'center';
                slot.style.maxHeight  = 'none';
                slot.style.overflow   = 'visible';
                // Do NOT touch marquee-line overflow — breaks the marquee animation.
                favEl.insertAdjacentElement('afterend', badge);

                // Apple Music's JS sets inset-inline-start inline during animation
                // to hide the slot. Override via setProperty 'important' flag which
                // beats plain inline styles. Guard against re-entrancy with a flag.
                let _pinning = false;
                const _pinSlot = () => {
                    if (_pinning) return;
                    const cur = parseFloat(getComputedStyle(slot).insetInlineStart);
                    if (cur > 250) { // pushed off-screen (container is ~282px wide)
                        _pinning = true;
                        slot.style.setProperty('inset-inline-start', 'auto', 'important');
                        slot.style.setProperty('inset-inline-end', '0', 'important');
                        requestAnimationFrame(() => { _pinning = false; });
                    }
                };
                const ml = slot.closest('[data-testid="marquee-line"]');
                new MutationObserver(_pinSlot).observe(slot, { attributes: true, attributeFilter: ['style'] });
                if (ml) new MutationObserver(_pinSlot).observe(ml, { attributes: true, attributeFilter: ['class', 'style'] });
                _pinSlot();
                return;
            }
            if (attempt < 10) {
                setTimeout(() => _insertBadgeIntoSlot(attempt + 1), 200);
            } else {
                badge.style.position  = 'fixed';
                badge.style.bottom    = '14px';
                badge.style.left      = '50%';
                badge.style.transform = 'translateX(-50%)';
                document.body.appendChild(badge);
            }
        }
        _insertBadgeIntoSlot(0);
    }

    badge.style.color  = color;
    badge.style.border = 'none';

    if (isSpatial) {
        badge.innerHTML = `<span>${label}</span>`;
    } else {
        badge.innerHTML = _losslessSVG;
    }

    badge.style.display = 'inline-flex';

    window._syncNpBadge?.();
}

// ── Now Playing overlay quality badge (fullscreen lyrics + vertical panel) ───
(function () {
    let _npBadge = null;

    function _npContent() {
        const { codec, sampleRate, bitDepth, spatialAudio } = _qualityBadgeInfo;
        if (spatialAudio === 'binaural-lossless' || spatialAudio === 'binaural')
            return { show: true, label: 'Spatial Audio', icon: false };
        if (codec === 'alac') {
            const hi = sampleRate > 48000 || bitDepth > 16;
            return { show: true, label: hi ? 'Hi-Res Lossless' : 'Lossless', icon: true };
        }
        return { show: false };
    }

    function _alignBadge() {
        if (!_npBadge?.isConnected || _npBadge.style.display === 'none') return;
        const sr = _npBadge.parentNode;
        const ref = sr?.querySelector?.('.time.elapsed') || sr?.querySelector?.('.time.remaining');
        if (!ref) return;
        const badgeH = _npBadge.offsetHeight || 19;
        const top = ref.offsetTop + (ref.offsetHeight - badgeH) / 2;
        if (top > 0) _npBadge.style.top = top + 'px';
    }

    function _syncBadge() {
        if (!_npBadge) return;
        const { show, label, icon } = _npContent();
        if (!show) { _npBadge.style.display = 'none'; return; }
        _npBadge.innerHTML = (icon ? _losslessSVG : '') + `<span>${label}</span>`;
        _npBadge.style.display = 'inline-flex';
        _alignBadge();
    }

    function _fmtDur(secs) {
        const m = Math.floor(secs / 60), s = Math.round(secs % 60);
        return `-${m}:${s.toString().padStart(2, '0')}`;
    }

    function _attach(scrubber) {
        if (document.getElementById('aml-np-badge')) return;
        const sr = scrubber.shadowRoot;
        if (!sr) return;

        _npBadge = document.createElement('div');
        _npBadge.id = 'aml-np-badge';
        _npBadge.style.cssText =
            'display:none;align-items:center;gap:5px;' +
            'padding:3.5px 7px;border-radius:5px;' +
            'font-size:11px;font-weight:500;letter-spacing:0em;' +
            'line-height:1;white-space:nowrap;user-select:none;cursor:pointer;' +
            'color:rgba(255,255,255,0.65);' +
            'background:rgba(255,255,255,0.08);' +
            'transition:opacity 0.12s;' +
            'position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:2;';
        _npBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            const pop = document.getElementById('aml-quality-popup');
            if (pop && pop.style.display !== 'none') { pop.style.display = 'none'; }
            else { _showQualityPopup(_npBadge); }
        });
        _npBadge.addEventListener('mouseenter', () => { _npBadge.style.opacity = '0.75'; });
        _npBadge.addEventListener('mouseleave', () => {
            _npBadge.style.opacity = '1';
            setTimeout(() => {
                const pop = document.getElementById('aml-quality-popup');
                if (pop) pop.style.display = 'none';
            }, 200);
        });

        // Make scrubber host a positioning context so absolute badge works
        scrubber.style.position = 'relative';
        // Inject directly into shadow root so badge sits between timestamps
        sr.appendChild(_npBadge);
        _syncBadge();
    }

    function _check() {
        if (_npBadge && !_npBadge.isConnected) _npBadge = null;
        if (_npBadge && _npBadge.isConnected) {
            _syncBadge();
            // Fix "--:--" remaining time for VLC tracks
            const dur = window.MusicKit?.getInstance?.()?.currentPlaybackDuration;
            if (dur > 0) {
                const rem = _npBadge.parentNode?.querySelector?.('.time.remaining');
                if (rem && rem.textContent === '--:--') rem.textContent = _fmtDur(dur);
            }
            return;
        }

        const scrubber =
            document.querySelector('[data-testid="lyrics-fullscreen-modal"] amp-playback-controls-progress') ||
            document.querySelector('div.now-playing-structure amp-playback-controls-progress');
        if (scrubber) _attach(scrubber);
    }

    setInterval(_check, 800);
    window._syncNpBadge = _syncBadge;
})();

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
        // Restore native audio.load() so MK can advance the queue when the
        // audio element fires 'ended'. Without this, MK's queue-advance call
        // to audio.load() hits our no-op shadow and hangs indefinitely —
        // nowPlayingItemDidChange never fires and the next track never starts.
        try { delete audio.load; } catch (_) {}
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
    _subDiv.style.cssText = 'position:absolute;bottom:10%;left:5%;right:5%;text-align:center;z-index:20;pointer-events:none;font-family:-apple-system,SF Pro Text,system-ui,sans-serif;transition:bottom 0.25s ease;';
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
            // Content-aware positioning: shift higher when cues are dense
            _subDiv.style.bottom = lines.length > 2 ? '22%' : '10%';
            const escaped = lines.map(l => l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')).join('\n');
            _subDiv.innerHTML = `<span style="display:inline-block;background:rgba(20,20,22,0.72);backdrop-filter:blur(14px) saturate(1.8);-webkit-backdrop-filter:blur(14px) saturate(1.8);color:#fff;padding:5px 14px 6px;border-radius:7px;font-size:15px;font-weight:500;line-height:1.55;white-space:pre-wrap;max-width:84%;letter-spacing:-0.1px;text-shadow:0 1px 2px rgba(0,0,0,0.3);">${escaped}</span>`;
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

    // ── Lyrics subtitle track ─────────────────────────────────────────────────
    // Fetch lyrics as WebVTT from the engine and inject a <track> element.
    // _attachTrack / _renderSubs already handle any track added to myVid.textTracks,
    // so no extra wiring is needed — just add the element.
    void (async () => {
        const lyricsId = _currentAssetId;
        const lyricsSf = mk.storefrontId ?? 'us';
        if (!lyricsId) return;
        try {
            const r = await fetch(`${ENGINE}/api/v1/lyrics/${encodeURIComponent(lyricsId)}?sf=${encodeURIComponent(lyricsSf)}&format=vtt`);
            if (_generation !== _mvGen || !r.ok) return;
            const vtt = await r.text();
            if (_generation !== _mvGen || !vtt || !vtt.startsWith('WEBVTT')) return;
            const blob = new Blob([vtt], { type: 'text/vtt' });
            const url = URL.createObjectURL(blob);
            const trackEl = document.createElement('track');
            trackEl.kind = 'subtitles';
            trackEl.srclang = 'en';
            trackEl.label = 'Lyrics';
            trackEl.src = url;
            trackEl.default = true;
            myVid.appendChild(trackEl);
            _abortCtrl.signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true });
        } catch (_) {}
    })();

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
            setTimeout(() => { if (_generation === _genSnap && _mkInstance) handleTrackChange(_mkInstance); }, T().qualityRace);
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
    const _seekSyncInterval = setInterval(_updateProgress, T().poll);
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
    // ── A/V sync gate ─────────────────────────────────────────────────────────────
    // Both streams must reach canplay AND video must have ≥2s buffered before either
    // starts. Prevents: (a) audio leading video at the start; (b) A/V drift from
    // hitting the first HLS segment boundary before the buffer is established.
    let _audioCanPlay = false, _videoCanPlay = false, _avStarted = false;
    // _videoStalled: set when video fires 'waiting'; cleared in onVideoPlaying
    let _videoStalled = false;

    // ── Proactive buffer guard ──────────────────────────────────────────────────
    // Every 500ms monitors video buffer lead. When lead drops below LOW_WATER we
    // pre-emptively pause (hidden from MK — onVideoPause is guarded by _bufPaused)
    // and mute audio so MK sees "playing but silent" rather than a pause event.
    // We resume only after buffer reaches HIGH_WATER, giving a clear hysteresis gap
    // that prevents oscillation and ensures smooth play windows between pauses.
    //
    // Why watermarks not fill-rate:
    //   Fill-rate projection is noisy at 500ms — it's 0 between segment deliveries
    //   and spikes on arrival. With marginal bandwidth the pattern is: drain at
    //   -1s/s (playback) then spike when a segment lands. At that exact spike tick
    //   the "resume" condition became true even with only 2s buffered, causing
    //   rapid pause→resume oscillation. Fixed watermarks with a 4s hysteresis gap
    //   are predictable and prevent the churn.
    //
    // Why mute instead of pause mkAudio:
    //   MK owns that element; pausing it triggers state=3 which can cause
    //   track-skip under sustained stalls. Muting keeps MK in "playing" state.
    const BUF_LOW  = 1.0; // pause when lead falls below this
    const BUF_HIGH = 5.0; // resume only when lead rises above this (4s hysteresis gap)

    let _dynBufTimer = null;
    let _bufPaused   = false; // true while hidden-paused for buffering

    const _getVidLead = () => {
        const ct = videoEl.currentTime;
        for (let i = 0; i < videoEl.buffered.length; i++) {
            if (videoEl.buffered.start(i) <= ct + 0.1 && ct <= videoEl.buffered.end(i))
                return videoEl.buffered.end(i) - ct;
        }
        return 0;
    };

    const _startDynBuf = () => {
        if (_dynBufTimer) return;
        _dynBufTimer = setInterval(() => {
            if (!_avStarted || _abortCtrl?.signal.aborted) { clearInterval(_dynBufTimer); _dynBufTimer = null; return; }
            if (ms.readyState === 'ended') return; // stream done — let it drain naturally

            const lead = _getVidLead();

            if (_bufPaused) {
                if (lead >= BUF_HIGH) {
                    _bufPaused = false;
                    mkAudio.currentTime = videoEl.currentTime; // re-anchor while still muted
                    mkAudio.muted = false;
                    _iframePlay.call(videoEl).catch(() => {}); // onVideoPlay → mkAudio.play()
                    console.log(`[AML MV buf:resume] lead=${lead.toFixed(2)}s ct=${videoEl.currentTime.toFixed(2)}`);
                } else {
                    console.debug(`[AML MV buf:waiting] lead=${lead.toFixed(2)}s (need ${BUF_HIGH}s to resume)`);
                }
            } else {
                if (lead < BUF_LOW && !videoEl.paused) {
                    _bufPaused = true;
                    videoEl.pause();      // onVideoPause suppressed via _bufPaused guard
                    mkAudio.muted = true; // silent but still "playing" — MK sees no pause
                    console.warn(`[AML MV buf:pre-pause] lead=${lead.toFixed(2)}s ct=${videoEl.currentTime.toFixed(2)}`);
                } else {
                    console.debug(`[AML MV buf:ok] lead=${lead.toFixed(2)}s`);
                }
            }
        }, BUF_POLL_MS);
    };

    const tryStart = () => {
        if (_avStarted || !_audioCanPlay || !_videoCanPlay || _abortCtrl?.signal.aborted) return;
        _avStarted = true;
        // Sync video time to audio (audio loads faster; set video to audio reference)
        if (Math.abs(videoEl.currentTime - mkAudio.currentTime) > 0.05)
            videoEl.currentTime = mkAudio.currentTime;
        console.log(`[AML MV buf:gate] A/V gate open — starting playback audio=${mkAudio.currentTime.toFixed(2)} video=${videoEl.currentTime.toFixed(2)}`);
        // onVideoPlay fires on the 'play' event and calls mkAudio.play()
        _iframePlay.call(videoEl).catch(e => console.warn('[AML MV] av-gate play rejected:', e.message));
        _startDynBuf();
    };

    mkAudio.addEventListener('canplay', () => { _audioCanPlay = true; tryStart(); }, { once: true });
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
            // Restore native audio.load() before endOfStream so MK can advance
            // the queue when mkAudio fires 'ended'. Same fix as AAC pipeToSourceBuffer.
            try { delete mkAudio.load; } catch (_) {}
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
        if (_videoStalled) {
            _videoStalled = false;
            const drift = mkAudio.currentTime - videoEl.currentTime;
            // Resync while muted — seek is inaudible. Unmute after sync.
            if (Math.abs(drift) > 0.05) {
                console.log(`[AML MV buf:sync] stall recovery drift=${drift.toFixed(2)}s, snapping audio ct=${videoEl.currentTime.toFixed(2)}`);
                mkAudio.currentTime = videoEl.currentTime;
            }
            mkAudio.muted = false;
            console.log(`[AML MV buf:sync] audio unmuted, video resumed ct=${videoEl.currentTime.toFixed(2)}`);
        }
    };
    const onVideoPause = () => {
        if (_bufPaused) return; // buffer management pause — don't tell MK
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
    const onEnded = () => {
        if (_abortCtrl?.signal.aborted) return; // already cleaning up
        console.log(`[AML MV-V] videoEl/audio ended — advancing queue`);
        // Restore native audio.load() so MK's queue-advance machinery can run.
        // The shadow may already be deleted by runAudioPipe (audio-ends-first path),
        // but guard here for the video-ends-first path.
        try { delete mkAudio.load; } catch (_) {}
        _abortCtrl.abort();
        _amlNext().catch(() => {});
        setTimeout(() => exitBtn?.click(), 200);
    };
    const onVideoError  = () => {
        const code = videoEl.error?.code;
        console.error(`[AML MV-V] videoEl error code=${code} msg="${videoEl.error?.message}"`);
        if (code === 3 || code === 4) _abortCtrl.abort();
    };
    const onVideoStall  = () => console.warn(`[AML MV-V] videoEl stalled ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
    const onVideoWait = () => {
        console.warn(`[AML MV buf:stall] videoEl waiting ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
        if (_avStarted && !_videoStalled && !_bufPaused) {
            _videoStalled = true;
            mkAudio.muted = true; // silence without pausing — MK sees "playing", no state=3
            console.warn(`[AML MV buf:stall] audio muted during video stall ct=${mkAudio.currentTime.toFixed(2)}`);
        }
    };
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
        // Wait until ≥4s is buffered before joining the start gate — gives the pipeline
        // enough head-start to survive HLS segment boundaries without stutter.
        const checkBuf = () => {
            if (_abortCtrl?.signal.aborted) return;
            const b = videoEl.buffered;
            const lead = b.length > 0 ? b.end(b.length - 1) : 0;
            if (lead >= 6.0) {
                console.log(`[AML MV buf:gate] video gate satisfied lead=${lead.toFixed(2)}s`);
                _videoCanPlay = true;
                tryStart();
            } else {
                console.log(`[AML MV buf:gate] video gate waiting lead=${lead.toFixed(2)}s (need 6s)`);
                videoEl.addEventListener('progress', checkBuf, { once: true });
            }
        };
        checkBuf();
    }, { once: true });

    const cleanup = () => {
        console.log(`[AML MV-V] cleanup gen=${_mvGen} curGen=${_generation}`);
        // Always clear the load() shadow so the next handleTrackChange or MK queue
        // advance isn't blocked. Harmless if already deleted; re-set by handleTrackChange.
        try { delete mkAudio.load; } catch (_) {}
        clearInterval(_dynBufTimer); _dynBufTimer = null;
        _bufPaused = false;
        _videoStalled = false;
        if (mkAudio.muted) mkAudio.muted = false; // restore mute state on session end
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
    const mySession = _sessionId; // capture — discard responses that arrive after a track skip
    _vlcPollTimer = setInterval(async () => {
        if (_vlcFetching) return;
        _vlcFetching = true;
        try {
            const r = await fetch(`${ENGINE}/api/v1/vlc/time`);
            // Stale check: if track changed while fetch was in-flight, discard silently
            if (!r.ok || _sessionId !== mySession) return;
            _errCount = 0;
            const { posMs, lengthMs, state } = await r.json();
            if (_sessionId !== mySession) return; // second check after JSON parse
            if (!_vlcLengthSet && lengthMs > 0) {
                _vlcLengthSet = true;
                _durationSec = lengthMs / 1000;
                // _mkInstance is set by bridgeDuration in handleTrackChange when the
                // session opens. Use it here since mk is not in scope in startVLCPoll.
                if (_mkInstance) bridgeDuration(_mkInstance, _durationSec);
            }
            // Gapless: pre-warm next ALAC session as soon as VLC reports the duration
            // (first poll after track starts). Maximises time for the background
            // disk-cache download to complete before the track ends.
            if (!_nextAlacTried && !_nextAlacSession && _durationSec > 0) {
                _nextAlacTried = true;
                console.log(`[AML Gapless] trigger at track start (dur=${_durationSec.toFixed(1)}s) — starting ALAC pre-warm`);
                _prewarmNextAlac().catch(() => {});
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
            // Burst-log every tick for 20 ticks (5s) after a seek.
            if (_seekBurstLog > 0) {
                _seekBurstLog--;
                const delta = posMs > 0 ? posMs - _vlcSeekTargetMs : null;
                const deltaStr = delta !== null ? ` Δ=${delta >= 0 ? '+' : ''}${delta}ms` : '';
                console.log(`[AML VLC seek] poll  vlc.posMs=${posMs}ms  ui.pos=${_vlcPosMs}ms  target=${_vlcSeekTargetMs}ms${deltaStr}  state=${state}  frozen=${_vlcSeekFrozen}`);
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
                _stopLyricsFreeze();
                _vlcLoading = false; // VLC is actually playing; clear pre-warmup guard
                // Dispatch 'playing' for initial start OR post-seek resume.
                // Normal pause→play resume is handled by _origMKPlay() to avoid
                // calling PlayActivity.play() twice (which throws).
                const fromSeek = _vlcPostSeek;
                _vlcPostSeek = false;
                if (prev !== 'paused' || fromSeek) mkAudio.dispatchEvent(new Event('playing'));
            }
            if (state === 'paused') {
                // Suppress spurious pause events while waiting for VLC to resume
                // after a seek — the poll may see a transient paused state between
                // SetTime completing and VLC re-entering playing.
                if (!_vlcPostSeek) {
                    _vlcPaused = true;
                    mkAudio.dispatchEvent(new Event('pause'));
                    _startLyricsFreeze(mkAudio);
                }
            }
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
                // Premature end at posMs≈0: cbcs stream failed before delivering data.
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
                // False end: VLC hit EOF well before the expected track duration.
                // Use vlc/seek (SetTime) to resume — avoids CDN re-download.
                // The server will reload from disk cache if available, then SetTime.
                const trackEndMs = Math.round(_durationSec * 1000);
                if (posMs > 2000 && trackEndMs > 5000 && posMs < trackEndMs - 3000 && _vlcRetryCount < 2) {
                    _vlcRetryCount++;
                    const resumeMs = posMs;
                    console.warn(`[AML VLC] false end at ${posMs}ms (track=${trackEndMs}ms) — seeking to resume at ${resumeMs}ms attempt ${_vlcRetryCount}`);
                    setTimeout(() => {
                        if (!_sessionId) return;
                        fetch(`${ENGINE}/api/v1/vlc/seek`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ posMs: resumeMs, sessionId: _sessionId }),
                        }).then(() => {
                            _vlcPosMs = resumeMs;
                            startVLCPoll(mkAudio);
                        }).catch(() => {});
                    }, 500);
                    return;
                }
                console.log('[AML VLC] ended → _amlNext');
                // _amlGoto deletes VLC property overrides from mkAudio before
                // changeToMediaAtIndex so audio.load() executes and MK transitions.
                _amlNext().catch(() => {});
            }
        } catch (_) {
            // Stop polling after 5 consecutive errors (engine exited or unreachable).
            if (++_errCount >= 5) stopVLCPoll();
        } finally {
            _vlcFetching = false;
        }
    }, T().poll);
}

// Polls _engineCaps.lossless every 100 ms until true or timeoutMs elapses.
// Only waits on the first call after startup (or after a DRM re-auth resets
// _losslessWaitDone). Once it times out once we skip all future waits — CBCS
// state won't flip mid-session and we can't pay +2.5 s per track when unavailable.
function waitForLossless(timeoutMs) {
    if (_streamingQuality === 'high-quality') return Promise.resolve(); // user forced AAC
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


// ── Gapless ALAC pre-warm ─────────────────────────────────────────────────────
// Creates an ALAC session for the next queue item and kicks off a background
// disk-cache download on the engine side so VLC can load the track instantly.
async function _prewarmNextAlac() {
    const mk = _mkInstance;
    if (!mk) return;
    const items = mk.queue?.items;
    const pos   = mk.queue?.position ?? -1;
    if (!items || pos < 0 || pos + 1 >= items.length) return;
    const nextItem   = items[pos + 1];
    const nextAdamId = nextItem?.playParams?.catalogId
        ?? nextItem?.attributes?.playParams?.catalogId
        ?? nextItem?.id
        ?? nextItem?.playParams?.id
        ?? nextItem?.attributes?.playParams?.id;
    if (!nextAdamId) return;
    // Skip if next track is a music video — VLC path doesn't apply.
    if (nextItem?.type === 'music-videos' || nextItem?.type === 'musicVideo' ||
        nextItem?.type === 'library-music-videos') return;
    // Skip if user has forced AAC quality — no ALAC session needed.
    if (!_engineCaps.lossless || _streamingQuality === 'high-quality') return;

    const nextName = nextItem?.attributes?.name ?? nextAdamId;
    const attempt  = _nextAlacRetries + 1;
    console.log(`[AML Gapless] opening session for "${nextName}" (${nextAdamId}) attempt=${attempt}`);
    const t0 = performance.now();

    // Schedules a retry in 5s if the user is still on the same track.
    // Only retries transient failures (network errors, 5xx) — not permanent ones
    // (auth errors, codec mismatches).
    const _scheduleRetry = (reason) => {
        if (_nextAlacRetries >= 3) {
            console.warn(`[AML Gapless] ${reason} — max retries reached, giving up`);
            return;
        }
        _nextAlacRetries++;
        console.log(`[AML Gapless] ${reason} — retry ${_nextAlacRetries}/3 in 5s`);
        setTimeout(() => {
            // Don't retry if the track changed or a session was already populated.
            if (_nextAlacSession || !_nextAlacTried) return;
            _nextAlacTried = false; // allow the poll to re-trigger
        }, 5000);
    };

    try {
        const sf = mk.storefrontId ?? 'us';
        const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assetId:    nextAdamId,
                storefront: sf,
                capabilities: { lossless: true, atmos: false, video: false },
                token:          mk.developerToken ?? '',
                mediaUserToken: getMUT(),
            }),
        });
        if (!sessResp.ok) {
            const permanent = sessResp.status === 401 || sessResp.status === 403 || sessResp.status === 404;
            if (permanent) {
                console.warn(`[AML Gapless] session open failed ${sessResp.status} (permanent) — will not retry`);
            } else {
                _scheduleRetry(`session open failed ${sessResp.status}`);
            }
            return;
        }
        const sess = await sessResp.json();
        const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
        // Only store lossless sessions; AAC fallback can't benefit from this path.
        if (sess.codec !== 'alac') {
            console.log(`[AML Gapless] skipped — engine returned ${sess.codec} (not lossless) in ${elapsed}s — will not retry`);
            deleteSession(sess.sessionId);
            return;
        }
        _nextAlacSession = { adamId: nextAdamId, sess };
        console.log(`[AML Gapless] session ready ${sess.sessionId} dur=${(sess.durationMs/1000).toFixed(1)}s in ${elapsed}s — kicking off disk cache download`);
        // Fire precache; response tells us whether the cache was already warm.
        fetch(`${ENGINE}/api/v1/playback/${sess.sessionId}/precache`, { method: 'POST' })
            .then(r => {
                if (r.status === 204) console.log('[AML Gapless] disk cache already populated — gapless ready ✓');
                else if (r.status === 202) console.log('[AML Gapless] disk cache download started in engine background');
                else console.warn(`[AML Gapless] precache returned unexpected ${r.status}`);
            })
            .catch(() => console.warn('[AML Gapless] precache request failed — VLC will download on first play'));
    } catch (e) {
        _scheduleRetry(`pre-warm error: ${e?.message}`);
    }
}

// ── Core playback handler ─────────────────────────────────────────────────────

async function handleTrackChange(mk) {
    let item = mk.nowPlayingItem;
    if (!item) {
        if (_allowCDNTransition) {
            // _amlGoto is in a controlled changeToMediaAtIndex call with the CDN block
            // lifted. MK fires a null NPIDF first; the real item follows once MK's
            // audio pipeline has set src + load. Don't block audio.load here — doing so
            // prevents MK from completing the transition and the settled NPIDF never fires.
            return;
        }
        // MK fires a null NPIDF during queue transitions (external play button clicks).
        // In VLC mode the audio element's load() is overridden to a no-op so VLC
        // owns the element. That no-op blocks MK from resetting the element for the
        // new track — real NPIDF never fires. Delete the instance override so MK
        // can call load() and proceed to real NPIDF.
        if (_vlcMode) {
            const tmpAudio = getMKAudio();
            if (tmpAudio) { try { delete tmpAudio.load; } catch (_) {} }
        }
        const genSnapshot = _generation;
        await new Promise(r => setTimeout(r, 200));
        if (_generation !== genSnapshot) return;  // real NPIDF handler already took over
        item = mk.nowPlayingItem;
        if (!item) return;
    }

    // Close CDN gate opened by external play-button click (now we own the transition).
    if (_allowCDNTransition) {
        _allowCDNTransition = false;
        if (_externalPlayGateTimer) { clearTimeout(_externalPlayGateTimer); _externalPlayGateTimer = null; }
    }

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
    _vlcMode = false; _vlcPosMs = 0; _vlcPaused = false; _stopLyricsFreeze(); _vlcSeekFrozen = false; _vlcRetryCount = 0; _vlcSeekOffsetMs = 0; _vlcPrevState = null; _vlcLoading = false; _seekBurstLog = 0; _vlcPostSeek = false; _vlcWasPlaying = false; _vlcSeekTargetMs = 0;
    _nextAlacTried = false; _nextAlacRetries = 0;
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

    // Discard stale ALAC pre-warm if it's for a different track (user skipped).
    if (_nextAlacSession && _nextAlacSession.adamId !== adamId) {
        console.log(`[AML Gapless] MISS — pre-warm was for ${_nextAlacSession.adamId}, playing ${adamId} — discarding`);
        deleteSession(_nextAlacSession.sess.sessionId);
        _nextAlacSession = null;
    }

    // Music videos play natively through MusicKit — don't intercept.

    const t0 = performance.now();
    console.log(`[AML Engine] → ${item.attributes?.name ?? adamId} (id=${adamId} sf=${sf})`);

    const mkAudio = getMKAudio();
    if (mkAudio) {
        // Skip pause if audio already ended (natural track end): calling pause() on an ended
        // MediaSource element re-fires 'ended', causing a spurious double-advance through the queue.
        if (!mkAudio.paused && !mkAudio.ended) mkAudio.pause();
        // Absorb MK's load() calls so it can't reset our MSE stream.
        // We lift this shadow for our own controlled _nativeLoad() call below.
        mkAudio.load = () => {};
        // Install play() proxy on first use.
        installPlayProxy(mkAudio);
    }

    // Wait for DRM to report lossless capability before opening the session.
    // Timeout scales with power mode: throttled CPUs need more time for DRM to report in.
    await waitForLossless(T().losslessWait);
    if (myGen !== _generation) return;

    try {
        // Gapless: reuse the pre-warmed ALAC session if available, skipping the
        // webplayback API round-trip (~1–2 s) and CDN download (~2–5 s).
        const isVideo = item.type === 'music-videos' || item.type === 'musicVideo' || item.type === 'library-music-videos';
        const losslessWanted = _engineCaps.lossless && _streamingQuality !== 'high-quality';
        let sess;
        if (!isVideo && losslessWanted && _nextAlacSession?.adamId === adamId) {
            sess = _nextAlacSession.sess;
            _nextAlacSession = null;
            console.log(`[AML Gapless] ✓ HIT — using pre-warmed ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs/1000).toFixed(1)}s (saved ~2–5s webplayback+CDN)`);
        } else {
            const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assetId:    adamId,
                    storefront: sf,
                    capabilities: {
                        lossless: losslessWanted,
                        atmos:    false,
                        video:    isVideo,
                    },
                    mvMaxHeight:    _mvMaxHeight,
                    token:          mk.developerToken ?? '',
                    mediaUserToken: getMUT(),
                }),
            });
            if (!sessResp.ok) throw new Error(`Session ${sessResp.status}: ${await sessResp.text()}`);
            sess = await sessResp.json();
        }

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
            // Re-enable CDN block now that VLC has taken over — any CDN URLs set by
            // MK after this point should be blocked (we own the audio element).
            _allowCDNTransition = false;
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

            let _vlcVolume = _vlcVolPersist; // restore volume from previous track
            let _vlcMuted = false;
            let _vlcPreMuteVol = _vlcVolume;
            let _vlcVolSetting = false; // re-entry guard: prevents setter→volumechange→setter loop
            const _postVlcVol = (vol) => fetch(`${ENGINE}/api/v1/vlc/volume`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ volume: vol }),
            }).catch(() => {});
            const _dispatchVolChange = () => {
                if (_vlcVolSetting) return;
                _vlcVolSetting = true;
                try { mkAudio.dispatchEvent(new Event('volumechange')); }
                finally { _vlcVolSetting = false; }
            };
            Object.defineProperty(mkAudio, 'volume', {
                get: () => _vlcVolume / 100,
                set: (v) => {
                    if (_vlcVolSetting) return;
                    const newVol = Math.max(0, Math.min(200, Math.round(v * 100)));
                    if (newVol === _vlcVolume) return; // MK sync no-op — value unchanged
                    _vlcVolume = newVol;
                    _vlcVolPersist = newVol; // save for next track
                    if (_vlcVolume > 0) _vlcMuted = false;
                    _postVlcVol(_vlcMuted ? 0 : _vlcVolume);
                    _dispatchVolChange();
                },
                configurable: true,
            });
            Object.defineProperty(mkAudio, 'muted', {
                get: () => _vlcMuted,
                set: (v) => {
                    _vlcMuted = !!v;
                    if (_vlcMuted) { _vlcPreMuteVol = _vlcVolume || 100; _postVlcVol(0); }
                    else { _vlcVolume = _vlcPreMuteVol; _vlcVolPersist = _vlcVolume; _postVlcVol(_vlcVolume); }
                    _dispatchVolChange();
                },
                configurable: true,
            });

            mkAudio.pause = () => {
                console.log(`[AML VLC] pause() → pause`);
                _vlcPaused = true;
                mkAudio.dispatchEvent(new Event('pause'));
                _startLyricsFreeze(mkAudio);
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
                _stopLyricsFreeze();
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

// ── Queue History Panel ───────────────────────────────────────────────────────

const _HIST_KEY = 'aml_play_history';
const _HIST_MAX = 50;

let _queueHistory = [];

// Load from encrypted store (async). Falls back to legacy localStorage on first run.
async function _histLoadAsync() {
    try {
        const raw = await window.amlBridge?.storeRead(_HIST_KEY);
        if (raw) { _queueHistory = JSON.parse(raw); return; }
    } catch (_) {}
    // Migration: read legacy plaintext localStorage and re-save encrypted
    try {
        const legacy = localStorage.getItem(_HIST_KEY);
        if (legacy) {
            _queueHistory = JSON.parse(legacy);
            await window.amlBridge?.storeWrite(_HIST_KEY, legacy);
            localStorage.removeItem(_HIST_KEY);
        }
    } catch (_) {}
}

async function _histSaveAsync() {
    try {
        await window.amlBridge?.storeWrite(_HIST_KEY, JSON.stringify(_queueHistory));
    } catch (_) {}
}

function _histArtUrl(artwork, size = 48) {
    if (!artwork?.url) return null;
    return artwork.url.replace('{w}', size).replace('{h}', size);
}

function _histEscape(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _histFmtDur(ms) {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function _histPush(item) {
    if (!item) return;
    const entry = {
        name:       item.attributes?.name       || '',
        artist:     item.attributes?.artistName || '',
        artworkUrl: _histArtUrl(item.attributes?.artwork),
        duration:   _histFmtDur(item.attributes?.durationInMillis),
        id:         item.id,
        catalogId:  item.playParams?.catalogId  || item.attributes?.playParams?.catalogId || item.id,
        ts:         Date.now(),
    };
    if (!entry.name || _queueHistory[0]?.id === entry.id) return;
    _queueHistory.unshift(entry);
    if (_queueHistory.length > _HIST_MAX) _queueHistory.length = _HIST_MAX;
    _histSaveAsync();
    _histRender();
}

function _histClear() {
    _queueHistory = [];
    window.amlBridge?.storeDelete(_HIST_KEY).catch(() => {});
    _histRender();
}

function _histRender() {
    const section = document.getElementById('aml-history-section');
    if (!section) return;
    if (_queueHistory.length === 0) { section.style.display = 'none'; return; }
    section.style.display = '';
    // Use data attrs — inline onclick is blocked by Apple Music's CSP.
    // Event delegation listener lives on the section div (set once in _histInject).
    section.innerHTML = `
        <div class="aml-hs-header">
            <span class="aml-hs-title">History</span>
        </div>
        <div class="aml-hs-list">
        ${_queueHistory.slice(0, 30).map(h => `
            <div class="aml-hs-item" data-catalog-id="${_histEscape(h.catalogId)}">
                ${h.artworkUrl
                    ? `<img class="aml-hs-art" src="${_histEscape(h.artworkUrl)}" loading="lazy">`
                    : `<div class="aml-hs-art aml-hs-art-ph"></div>`}
                <div class="aml-hs-meta">
                    <div class="aml-hs-name">${_histEscape(h.name)}</div>
                    <div class="aml-hs-artist">${_histEscape(h.artist)}</div>
                </div>
                ${h.duration ? `<span class="aml-hs-dur">${_histEscape(h.duration)}</span>` : ''}
            </div>`).join('')}
        </div>`;
}

function _histInjectStyles() {
    if (document.getElementById('aml-hist-css')) return;
    const s = document.createElement('style');
    s.id = 'aml-hist-css';
    s.textContent = `
#aml-history-section {
    border-bottom: 1px solid var(--separator, rgba(128,128,128,.18));
    padding-bottom: 8px;
    margin-bottom: 4px;
}
.aml-hs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px var(--side-panel-horizontal-padding, 20px) 8px;
}
.aml-hs-title {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: normal;
    text-transform: none;
    opacity: 1;
}
.aml-hs-list { padding-bottom: 4px; max-height: 300px; overflow-y: auto; scrollbar-width: thin; }
.aml-hs-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px var(--side-panel-horizontal-padding, 20px);
    min-height: 44px;
    cursor: pointer;
    border-radius: 6px;
    transition: background .12s;
    box-sizing: border-box;
}
.aml-hs-item:hover { background: var(--systemFillTertiary, rgba(128,128,128,.14)); }
.aml-hs-art {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
    background: rgba(128,128,128,.18);
}
.aml-hs-art-ph { background: rgba(128,128,128,.18); }
.aml-hs-meta { min-width: 0; flex: 1; }
.aml-hs-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.aml-hs-artist {
    font-size: 11px;
    opacity: .55;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.aml-hs-dur {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    opacity: .55;
    flex-shrink: 0;
    padding-left: 6px;
}`;
    document.head.appendChild(s);
}

let _histEnabled = true;

function _histInject() {
    const panel = document.querySelector('.side-panel');
    if (!panel) return;
    // Remove section if history was disabled.
    if (!_histEnabled) {
        panel.querySelector('#aml-history-section')?.remove();
        return;
    }
    // Guard: do NOT call _histRender() here — that triggers another mutation,
    // which re-fires this observer, causing an infinite loop.
    if (panel.querySelector('#aml-history-section')) return;
    const div = document.createElement('div');
    div.id = 'aml-history-section';
    // Event delegation: set once on the container div, survives innerHTML updates.
    // Inline onclick is blocked by Apple Music's CSP — data attrs + delegation is the fix.
    div.addEventListener('click', (e) => {
        const item = e.target.closest('.aml-hs-item');
        if (item?.dataset.catalogId) window._amlHistPlay(item.dataset.catalogId);
    });
    panel.prepend(div);
    _histRender();
}

async function setupQueueHistory(mk) {
    _histInjectStyles();

    window._amlHistClear = _histClear;
    window._amlHistPlay  = (catalogId) => {
        if (!catalogId) return;
        mk.setQueue({ song: catalogId }).then(() => mk.play()).catch(() => {});
    };

    // Load history-enabled pref and history from encrypted store before first render.
    try {
        const pref = await window.amlBridge?.storeRead('historyEnabled');
        if (pref !== null && pref !== undefined) _histEnabled = pref !== 'false' && pref !== false;
    } catch (_) {}
    await _histLoadAsync();

    // Push current song to history the moment it changes away.
    mk.addEventListener('nowPlayingItemWillChange', () => _histPush(mk.nowPlayingItem));

    // Watch body for the side-panel to appear (renders at ≥1000px viewport,
    // conditionally mounted by Svelte based on playback state + viewport).
    // Also re-inject when Svelte re-renders wipe the panel children.
    const obs = new MutationObserver(_histInject);
    obs.observe(document.body, { childList: true, subtree: true });
    _histInject();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
    if (window.__amlEngineMounted) return;
    window.__amlEngineMounted = true;

    blockAppleCDN();

    // Suppress Apple Music's spurious error dialog triggered by PlayActivity.stop()
    // throwing "A method was called without a previous descriptor" during setQueue.
    // Two issues to handle:
    //   1. Apple Music opens the dialog with showModal(), not setAttribute('open'),
    //      so a setAttribute intercept alone is insufficient.
    //   2. React defers rendering, so the dialog can open AFTER _amlTransitioning is
    //      already cleared by NPIDF — use a 1s timestamp window instead.
    let _amlLastGotoMs = 0; // updated each time _amlGoto starts
    const _inGotoWindow = () => performance.now() - _amlLastGotoMs < 1000;
    const _isSpuriousDialog = (el) =>
        el?.tagName === 'DIALOG' &&
        el?.dataset?.testid === 'dialog' &&
        el?.classList?.contains('error');

    const _origShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function() {
        if (_isSpuriousDialog(this) && _inGotoWindow()) {
            console.log('[AML] Suppressed error dialog showModal (goto window)');
            return;
        }
        return _origShowModal.call(this);
    };

    // Fallback: MutationObserver catches dialogs that slip through (e.g. show() path).
    new MutationObserver(() => {
        if (!_inGotoWindow()) return;
        const dlg = document.querySelector('dialog[data-testid="dialog"].error[open]');
        if (dlg) { dlg.close(); console.log('[AML] Closed spurious error dialog (goto window)'); }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });

    // Feature-detect native ALAC MSE support (Chromium 116+ / Electron 38+).
    // Wait for the engine's SSE snapshot instead of polling GET /api/v1/status.
    // _amlEngine is injected by engine-sse-bundle.js which loads before us.
    try {
        const msg = await window._amlEngine?.waitFor('engine.snapshot', T().sseWait);
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

    // Push saved cache config to engine now that it's up; also load quality pref.
    window.amlBridge?.getPrefs().then(p => {
        if (p['streaming-quality']) _streamingQuality = p['streaming-quality'];
        if (p['downloads-quality']) _downloadsQuality  = p['downloads-quality'];
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

    // ── Owned queue advancement ────────────────────────────────────────────────
    // MK's skipToNextItem/skipToPreviousItem are unreliable wrappers — they can
    // stall, reject, or double-fire. We block them entirely and own the logic:
    // compute the target index ourselves, call changeToMediaAtIndex directly.
    // changeToMediaAtIndex always fires nowPlayingItemDidChange with a settled item.
    //
    // _amlAdvancing prevents concurrent invocations from double-advancing.
    // The nowPlayingItemDidChange listener resets it once a change is confirmed.

    let _amlAdvancing = false;
    let _amlAdvancingTimer = null;
    let _amlGotoTarget = null; // queue index we're transitioning TO (set by _amlGoto)

    function _clearAdvancing() {
        _amlAdvancing = false;
        // NOTE: do NOT clear _amlGotoTarget here. It stays set until the target
        // track's NPIDF fires (or the 6s timeout), so the NPIDF filter can still
        // block spurious events for the old track after the null NPIDF clears _amlAdvancing.
        clearTimeout(_amlAdvancingTimer);
        _amlAdvancingTimer = null;
    }

    // Navigate to container ci, item ii within that container.
    async function _amlGoto(ci, ii) {
        if (_amlAdvancing) { console.log('[AML] _amlGoto busy, ignoring ci=', ci, 'ii=', ii); return; }
        _amlAdvancing = true;
        _amlTransitioning = true;
        _amlLastGotoMs = performance.now(); // open 1s suppression window for error dialog
        _amlNavInternal = true;
        _amlPendingCI = ci;
        _amlPendingII = ii;
        const targetFlat = _sessionFlatIdx(ci, ii);
        _amlGotoTarget = targetFlat;
        console.log('[AML] _amlGoto ci=', ci, 'ii=', ii, 'flat=', targetFlat);

        // Stop the VLC poll first — it dispatches timeupdate events that cause MK's
        // AudioPlayer to access its detached SourceBuffer (InvalidStateError) on
        // every tick. Must stop before changeToMediaAtIndex so MK gets a clean run.
        stopVLCPoll();

        // Reset the audio element src to empty using the native setter so MK gets
        // a clean HAVE_NOTHING state before changeToMediaAtIndex. The silent MediaSource
        // URL (from VLC mode) has no data, so MK's internal state machine would wait
        // forever for audio to be playable. Setting src='' fires 'emptied' cleanly
        // (no 'error' event) so MK resets state without losing the queue context.
        // We do NOT revoke _silentUrl here — the abort will happen in handleTrackChange.
        const _gotoAudio = getMKAudio();
        if (_gotoAudio && _nativeSrcSet) {
            _nativeSrcSet.call(_gotoAudio, '');
            HTMLMediaElement.prototype.load.call(_gotoAudio);
        }
        if (_gotoAudio) {
            try { delete _gotoAudio.load;        } catch (_) {}
            try { delete _gotoAudio.paused;      } catch (_) {}
            try { delete _gotoAudio.currentTime; } catch (_) {}
            try { delete _gotoAudio.volume;      } catch (_) {}
            try { delete _gotoAudio.muted;       } catch (_) {}
            try { delete _gotoAudio.pause;       } catch (_) {}
            // Delete the play proxy so MK's internal audio.play() call during
            // changeToMediaAtIndex uses native play. The VLC-mode proxy would
            // dispatch 'playing' for the OLD track and call vlc/resume, causing
            // MK's AudioPlayer to crash before nowPlayingItemDidChange fires.
            try { delete _gotoAudio.play;        } catch (_) {}
        }
        // Allow handleTrackChange to reinstall the proxy for the next track.
        _proxyInstalled = false;
        // Clear VLC mode so the mk.play()/mk.pause() overrides use MSE paths during
        // the transition. While in VLC mode, mk.play() calls vlc/resume for the OLD
        // track, which prevents MK's changeToMediaAtIndex from advancing the queue.
        _vlcMode = false;

        // MPRIS pre-update: find target item in current MK queue by song ID.
        const targetSongId = _sessionContainers[ci]?.items[ii];
        const targetItem = targetSongId
            ? (mk.queue?.items ?? []).find(it => _extractItemId(it) === targetSongId)
            : null;
        if (targetItem) sendMprisMetadata(targetItem);

        // Safety valve: if NPIDF never fires (ctmi failed silently), reset NPIDF state after 6s.
        // _amlAdvancing itself is released right after ctmi below, so this only cleans up
        // the remaining NPIDF-tracking flags (_amlGotoTarget, _amlNavInternal, pending coords).
        _amlAdvancingTimer = setTimeout(() => {
            _amlGotoTarget = null;
            _allowCDNTransition = false;
            _amlTransitioning = false;
            _amlNavInternal = false;
            _amlPendingCI = -1;
            _amlPendingII = -1;
            // Belt-and-suspenders: also clear advancing in case ctmi truly never fired.
            _clearAdvancing();
        }, 6000);

        // Build the flat queue: all containers in order (history + upcoming in current container).
        const allIds = _sessionFlatIds();
        if (!allIds.length) {
            clearTimeout(_amlAdvancingTimer);
            _clearAdvancing();
            _amlGotoTarget = null;
            _allowCDNTransition = false;
            _amlTransitioning = false;
            _amlNavInternal = false;
            _amlPendingCI = -1;
            _amlPendingII = -1;
            return;
        }
        const targetIdx = Math.max(0, Math.min(targetFlat, allIds.length - 1));
        _amlGotoTarget = targetIdx;
        await mk.setQueue({ songs: allIds }).catch(() => {});
        await mk.changeToMediaAtIndex(targetIdx).catch(() => {});

        // ctmi has been sent — release the advancing lock immediately so rapid prev/next
        // clicks aren't swallowed. The NPIDF filter (_amlGotoTarget) and session-state
        // tracking (_amlNavInternal, _amlPendingCI/II) continue independently.
        _clearAdvancing();

        // Show MK's native loading spinner on the MSE path. Not needed for VLC —
        // that path has its own loading state via _vlcLoading.
        const mkAudio = document.querySelector('audio');
        if (mkAudio && !_vlcMode) mkAudio.dispatchEvent(new Event('waiting'));
    }

    // manual=false → auto-advance (respects repeat-one: restarts same track)
    // manual=true  → explicit user skip (always advances past current track)
    async function _amlNext(manual = false) {
        const repeat = mk.repeatMode ?? 0; // 0=none, 1=one, 2=all
        const ci = _sessionContainerIdx, ii = _sessionItemIdx;
        const cur = _sessionContainers[ci];

        if (repeat === 1 && !manual) {
            // Repeat-one: restart same track (ci/ii unchanged).
            if (ci >= 0) await _amlGoto(ci, ii);
            return;
        }

        if (!cur) return; // no container yet

        if (ii + 1 < cur.items.length) {
            // Next item within the same container.
            await _amlGoto(ci, ii + 1);
        } else if (repeat === 2) {
            // Repeat-all: wrap to start of current container only (Android-matching).
            await _amlGoto(ci, 0);
        } else if (ci + 1 < _sessionContainers.length) {
            // Cross into the next container.
            await _amlGoto(ci + 1, 0);
        }
        // else: end of all containers, nothing to do
    }

    async function _amlPrev() {
        const ci = _sessionContainerIdx, ii = _sessionItemIdx;
        if (ci < 0) return; // no container yet
        if (ii > 0) {
            // Previous item within the same container.
            await _amlGoto(ci, ii - 1);
        } else if (ci > 0) {
            // Cross back into the previous container, land at its last item.
            await _amlGoto(ci - 1, _sessionContainers[ci - 1].items.length - 1);
        }
        // else: at the very beginning of the session
    }

    // Block MK's native skip functions — UI skip buttons and all external callers
    // now go through our owned logic.
    mk.skipToNextItem     = () => _amlNext(true);  // UI skip: always advances
    mk.skipToPreviousItem = _amlPrev;

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
            case 'next':      _amlNext(true).catch(() => {}); break;
            case 'previous':
                // Android GoBackAsync: restart if past 3s, else go to previous item.
                if (mk.currentPlaybackTime > 3) mk.seekToTime(0);
                else _amlPrev().catch(() => {});
                break;
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
    // We detect the queue mutation via queueItemsDidChange (MK v3) or queueDidChange
    // (older), fall back to a 200ms timeout if neither fires, then call _amlNext.
    document.addEventListener('click', (e) => {
        // Exclude context-menu clicks ("Play Next", "Add to Queue" etc.) — those
        // insert at pos+1 intentionally without immediate playback advance.
        if (e.target.closest('.contextual-menu')) return;

        // When VLC is playing and the user clicks a play button for a new track,
        // MK calls audio.load() BEFORE changing the queue or firing NPIDF. Our VLC
        // no-op blocks it, MK bails out, nothing happens. Delete the override here
        // (capture phase, before MK's handler) so MK can reset the audio element.
        // Also clear _ourBlobUrl so MK's subsequent blob src assignment isn't blocked.
        // handleTrackChange restores everything once the real NPIDF fires.
        const _dbgPlaySel = e.target.closest(
            '[data-testid="play-button"], ' +      // track-row play button
            '[data-testid="click-action"], ' +     // album/playlist pill play button
            '.primary-actions__button--play, ' +   // pill wrapper (ancestor match)
            '[class*="play-button"]'               // any play-button class variant
            // NOTE: [aria-label*="Play"] removed — matches product-lockup nav links (false positive)
        );
        if (_vlcMode && _dbgPlaySel) {
            // MK's setQueue reuses the existing mkAudio element. It calls:
            //   mkAudio.src = ''  → fine
            //   mkAudio.load()    → BLOCKED by our instance override → Promise hangs, NPIDF never fires
            //   mkAudio.src = CDN → would be blocked by CDN gate too
            // Fix: delete the load override and open the CDN gate so MK can complete setQueue.
            // handleTrackChange reinstalls mkAudio.load for the new track.
            const mkAudioEl = getMKAudio();
            if (mkAudioEl) { try { delete mkAudioEl.load; } catch (_) {} }
            console.log('[AML click] external play while VLC active — opening CDN gate');
            _allowCDNTransition = true;
            _ourBlobUrl = null;
            if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
            _externalPlayGateTimer = setTimeout(() => {
                // No track change happened — restore load override to protect VLC stream.
                const el = getMKAudio();
                if (el && _vlcMode) el.load = () => {};
                _allowCDNTransition = false;
                _externalPlayGateTimer = null;
                console.log('[AML click] CDN gate reset (safety timeout)');
            }, 15000);
        }

        const PS = window.MusicKit?.PlaybackStates;
        // Only intercept during active playback. Other states use setQueue/changeToMediaAtIndex
        // which fires nowPlayingItemDidChange directly — no interception needed.
        if (mk.playbackState !== PS?.playing && mk.playbackState !== PS?.paused) return;

        const pos      = mk.queue?.position ?? 0;
        const snapNext = _qId(mk.queue?.items?.[pos + 1]);
        const snapNow  = _qId(mk.nowPlayingItem);

        let done = false;

        // Called once — either by a queue event or the 200ms fallback, never both.
        const check = (itemChangeFired) => {
            if (done) return;
            done = true;
            mk.removeEventListener('queueItemsDidChange', onQueue);
            mk.removeEventListener('queueDidChange',      onQueue);
            mk.removeEventListener('nowPlayingItemDidChange', onItem);

            if (itemChangeFired) return; // MK handled it; our main listener fires handleTrackChange.

            const curPos = mk.queue?.position ?? 0;
            if (curPos !== pos) return; // position already advanced (context switch)

            // Guard pos=0 context switch: queue.items[0] updates before nowPlayingItemDidChange.
            if ((_qId(mk.queue?.items?.[curPos]) ?? null) !== snapNow) return;

            const newNext = _qId(mk.queue?.items?.[curPos + 1]);
            if (newNext && newNext !== snapNext) {
                console.log('[aml] track-click: inserted at next, calling _amlNext');
                _amlNext(true).catch(() => {});
            }
        };

        const onItem  = () => check(true);
        const onQueue = () => check(false);

        mk.addEventListener('nowPlayingItemDidChange', onItem,  { once: true });
        mk.addEventListener('queueItemsDidChange',     onQueue, { once: true });
        mk.addEventListener('queueDidChange',          onQueue, { once: true });
        setTimeout(() => check(false), 200);
    }, true);

    setupQueueHistory(mk); // async; fire-and-forget: loads history, then enables listener + inject

    mk.addEventListener('nowPlayingItemDidChange', async () => {
        // During a controlled _amlGoto transition, filter out spurious NPIDFs.
        // setQueue fires a null NPIDF (item === null) that must be fully suppressed —
        // if we let it through, _clearAdvancing() releases the lock early and
        // _amlNavInternal is consumed before the real NPIDF arrives from ctmi().
        // Spurious non-null NPIDFs (old track, different ID) are also dropped.
        if (_amlGotoTarget !== null) {
            const item = mk.nowPlayingItem;
            if (!item) return; // null NPIDF from setQueue — suppress entirely, wait for ctmi NPIDF
            const itemId = item?.id ?? item?.playParams?.id;
            const targetItem = mk.queue?.items?.[_amlGotoTarget];
            const targetId = targetItem?.id ?? targetItem?.playParams?.id;
            if (targetId && itemId !== targetId) {
                // Spurious NPIDF for the OLD track during transition — drop it.
                console.log('[AML] NPIDF filtered: spurious event for', item?.attributes?.name, '(advancing to idx', _amlGotoTarget, ')');
                return;
            }
            // Target track arrived (or target ID indeterminate) — clear filter and cancel safety timer.
            _amlGotoTarget = null; _amlTransitioning = false;
            clearTimeout(_amlAdvancingTimer); _amlAdvancingTimer = null;
        }
        // Confirm the track change and release any residual advance lock.
        // (_amlAdvancing is normally already false — released right after ctmi in _amlGoto.)
        _clearAdvancing();
        // MK briefly fires null during queue transitions. Poll up to 250 ms for the
        // item to settle so handleTrackChange always sees a real item, and MPRIS
        // never gets a spurious Stopped between tracks.
        let item = mk.nowPlayingItem;
        if (!item) {
            for (let i = 0; i < 5; i++) {
                await new Promise(r => setTimeout(r, 50));
                item = mk.nowPlayingItem;
                if (item) break;
            }
        }
        // Maintain session container state so next/prev navigate correctly.
        const wasInternal = _amlNavInternal;
        _amlNavInternal = false;
        if (item) {
            const songId = _extractItemId(item);
            if (wasInternal && _amlPendingCI >= 0) {
                // Internal navigation (_amlGoto): apply the pre-computed coordinates.
                _sessionContainerIdx = _amlPendingCI;
                _sessionItemIdx      = _amlPendingII;
                _amlPendingCI = -1;
                _amlPendingII = -1;
            } else if (songId) {
                // External NPIDF (user clicked a new playlist/album, or MK auto-advanced AAC).
                const cur = _sessionContainers[_sessionContainerIdx];
                if (cur && cur.items[_sessionItemIdx] === songId) {
                    // Same track (repeat-one, restart) — no change.
                } else if (cur && cur.items[_sessionItemIdx + 1] === songId) {
                    // Auto-advance within the current container (MK-driven for AAC).
                    _sessionItemIdx++;
                } else {
                    // New play context: seed a fresh container from the current MK queue.
                    // mk.queue.items holds the full new queue; mk.queue.position is where we are.
                    const mkItems2 = mk.queue?.items ?? [];
                    const mkPos2   = mk.queue?.position ?? 0;
                    const newIds   = mkItems2.map(_extractItemId).filter(Boolean);
                    if (newIds.length) {
                        _sessionContainers.push({ items: newIds });
                        _sessionContainerIdx = _sessionContainers.length - 1;
                        _sessionItemIdx      = mkPos2;
                    }
                }
            }
        }
        handleTrackChange(mk);
        // Signal queue context to the prefetch scheduler.
        window._amlSmartCache?.onTrackChange(mk);
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

// ── Search suggestions portal ──────────────────────────────────────────────
// backdrop-filter on search-input-wrapper creates a compositing layer that traps
// descendants' blur. Portal moves .search-suggestions to <body> so both blur
// independently. Two triggers:
//   1. MutationObserver (synchronous, no rAF) — catches Svelte's DOM insertion
//   2. Input/focus listeners on the search field — proactively poll as soon as
//      the user types, before Svelte finishes rendering the suggestions node
(function initSearchSuggestionsPortal() {
    let portaled = null;

    function positionPortal(el) {
        const bar = document.querySelector('[class*="search-input-wrapper"]');
        if (!bar) return;
        const r = bar.getBoundingClientRect();
        el.style.setProperty('position', 'fixed', 'important');
        el.style.setProperty('top', (r.bottom + 6) + 'px', 'important');
        el.style.setProperty('left', r.left + 'px', 'important');
        el.style.setProperty('width', r.width + 'px', 'important');
        el.style.setProperty('z-index', '9999', 'important');
    }

    function doPortal(sugg) {
        if (portaled === sugg) return;
        portaled = sugg;
        sugg.remove();
        positionPortal(sugg);
        document.body.appendChild(sugg);
    }

    // Try to portal whatever suggestions exist inside the wrapper right now.
    // Returns true if portaled, false if not found yet.
    function tryScan() {
        const bar = document.querySelector('[class*="search-input-wrapper"]');
        if (!bar) return false;
        const sugg = bar.querySelector('[class*="search-suggestions"]');
        if (!sugg) return false;
        doPortal(sugg);
        return true;
    }

    // Synchronous MutationObserver — no rAF, fires before browser paint
    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const sugg = node.matches('[class*="search-suggestions"]') ? node
                    : node.querySelector('[class*="search-suggestions"]');
                if (sugg && sugg.closest('[class*="search-input-wrapper"]')) {
                    doPortal(sugg);
                    return;
                }
            }
            for (const node of m.removedNodes) {
                if (node.nodeType !== 1) continue;
                const gone = node.matches('[class*="search-suggestions"]') ? node
                    : node.querySelector('[class*="search-suggestions"]');
                if (gone === portaled) portaled = null;
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Wire input/focus listeners onto the search field so we poll immediately
    // on text change — Svelte renders suggestions a microtask after input fires,
    // so a tight poll (30 ms × 20 attempts = 600 ms window) catches it early.
    function wireSearchInput(input) {
        if (!input || input._amlPortalWired) return;
        input._amlPortalWired = true;

        function startPoll() {
            if (tryScan()) return;
            let attempts = 0;
            const t = setInterval(() => {
                if (tryScan() || ++attempts >= 20) clearInterval(t);
            }, 30);
        }

        input.addEventListener('input', startPoll);
        input.addEventListener('focus', startPoll);
    }

    // Attach to the search field now, and re-attach after SPA navigations
    function attachToSearchInput() {
        wireSearchInput(document.querySelector(
            '#search-input__text-field, [class*="search-input__text-field"]'
        ));
    }

    attachToSearchInput();
    // Re-wire whenever the DOM mutates (SPA page changes swap the input out)
    new MutationObserver(attachToSearchInput)
        .observe(document.documentElement, { childList: true, subtree: true });

    window.addEventListener('resize', () => { if (portaled) positionPortal(portaled); }, { passive: true });
})();

// ── Tracklist stats in detail header ─────────────────────────────────────────
// Appends "N songs, X hr Y min" inside the headings grid area (after subtitle)
// so it flows naturally in Apple's native two-column desktop layout without
// overriding grid-template-areas and breaking the artwork/content split.
(function initTracklistStatsInHeader() {
    let statsEl = null;
    let lastText = '';

    function sync() {
        const header = document.querySelector('[class*="container-detail-header"]:not([class*="wrapper"])');

        if (!header) {
            if (statsEl) { statsEl.remove(); statsEl = null; lastText = ''; }
            return;
        }

        // Target: the headings grid cell (contains title + subtitle)
        const headings = header.querySelector('[class*="headings"]:not([class*="primary"]):not([class*="secondary"])');
        if (!headings) return;

        const src = document.querySelector('[data-testid="tracklist-footer-description"]')
            || document.querySelector('[class*="tracklist-footer"] p[class*="description"]');
        const text = src?.textContent?.trim() ?? '';

        if (!statsEl || !headings.contains(statsEl)) {
            statsEl?.remove();
            statsEl = document.createElement('p');
            statsEl.id = 'aml-tracklist-stats';
            headings.appendChild(statsEl);
            lastText = '';
        }

        if (text !== lastText) {
            statsEl.textContent = text;
            lastText = text;
        }

        if (src?.parentElement) src.parentElement.style.display = 'none';
    }

    new MutationObserver(sync).observe(document.body, { childList: true, subtree: true });
    sync();
})();

// MusicKit's PlayActivity analytics throws "play() method was called without a
// previous stop() or pause() call" as an unhandled promise rejection whenever
// our VLC mode resumes playback — its state machine expects a real audio src.
// This is cosmetic noise; suppress it so the console stays readable.
window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message ?? '';
    if (msg.includes('play() method was called without a previous') ||
        msg.includes('lyrics are not being displayed') ||
        msg.includes('lyrics are already being displayed')) {
        e.preventDefault();
    }
});

// ── Debug / console helpers ────────────────────────────────────────────────
// Exposed on window so they can be called from DevTools or CDP.

// Stop all playback (VLC, MSE, MK) and release the engine session.
// After this the UI is idle and a fresh handleTrackChange is needed to resume.
window.amlClearSession = function () {
    stopVLCPoll();
    if (_pipeCtrl)  { _pipeCtrl.abort();  _pipeCtrl  = null; }
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    if (_seekFetchCtrl) { _seekFetchCtrl.abort(); _seekFetchCtrl = null; }
    deleteSession(_sessionId);
    _sessionId = null; _currentAssetId = null; _durationSec = 0;
    _vlcMode = false; _vlcPosMs = 0; _ourBlobUrl = null;
    if (_nextAlacSession) { deleteSession(_nextAlacSession.sess.sessionId); _nextAlacSession = null; }
    _nextAlacTried = false; _nextAlacRetries = 0;
    unbridgeDuration();
    try { _mkInstance?.pause?.(); } catch (_) {}
    console.log('[AML] amlClearSession: all playback stopped and session released');
};

// Open a fresh engine session for adamId and return the session object.
// Does not start playback — call handleTrackChange or pipe manually.
window.amlStartSession = async function (adamId, sf) {
    const mk = _mkInstance;
    if (!mk) { console.warn('[AML] amlStartSession: no MK instance'); return null; }
    const storefront = sf ?? mk.storefrontId ?? 'us';
    const losslessWanted = _engineCaps.lossless && _streamingQuality !== 'high-quality';
    console.log(`[AML] amlStartSession adamId=${adamId} sf=${storefront} lossless=${losslessWanted}`);
    const r = await fetch(`${ENGINE}/api/v1/playback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            assetId: adamId, storefront,
            capabilities: { lossless: losslessWanted, atmos: false, video: false },
            token: mk.developerToken ?? '',
            mediaUserToken: getMUT(),
        }),
    });
    if (!r.ok) { console.error(`[AML] amlStartSession: engine ${r.status}`); return null; }
    const sess = await r.json();
    console.log(`[AML] amlStartSession: session=${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs/1000).toFixed(1)}s`);
    return sess;
};

// Return current MK queue snapshot — useful for debugging from DevTools.
window.amlGetQueueInfo = function () {
    const mk = _mkInstance;
    return {
        items:       mk?.queue?.items       ?? [],
        position:    mk?.queue?.position    ?? -1,
        nowPlaying:  mk?.nowPlayingItem     ?? null,
        storefrontId: mk?.storefrontId      ?? 'us',
        sessionId:   _sessionId,
        codec:       _vlcMode ? 'alac/vlc' : 'aac/mse',
        durationSec: _durationSec,
        posMs:       _vlcPosMs,
    };
};




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
        // session:valid only means mpl_db credentials exist — it stays true even
        // when the DRM process has failed (stale cache). Only count it when the
        // process is actually running. authentication/fairplay/cbcs are live signals.
        const processOk = drmState?.process === 'running';
        const isSignedIn = (processOk && drmState?.session === 'valid')
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
            #aml-settings-close {
                position:sticky; top:18px; float:right; z-index:10;
                margin-left:auto; flex-shrink:0;
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
        // Single capture-phase listener closes all dropdowns and handles backdrop click.
        // Wired once here so dlDropdown/makeQualityDropdown don't each add their own.
        dlg.addEventListener('click', e => {
            document.querySelectorAll('.aml-qdrop-menu').forEach(m => { m.style.display = 'none'; });
            if (e.target === dlg) closeSettings();
        }, true);
        return dlg;
    }

    function closeSettings() {
        const dlg = document.getElementById('aml-settings-dialog');
        if (!dlg?.open) return;
        dlg.classList.replace('aml-opening', 'aml-closing') || dlg.classList.add('aml-closing');
        dlg.addEventListener('animationend', () => { dlg.classList.remove('aml-closing'); dlg.close(); }, { once: true });
    }

    // ── Open settings — anchored to the account button ─────────────────────
    // Generation counter: each openSettings() call gets a unique ID.
    // After each await, stale callers (whose ID was superseded by a newer call)
    // bail out — preventing concurrent renders from appending duplicate sections.
    let _settingsGen = 0;
    async function openSettings() {
        const myGen = ++_settingsGen;
        const dlg = getDialog();
        dlg.innerHTML = '';

        // Floating close button — sticky so it stays visible while scrolling
        const closeBtn = document.createElement('button');
        closeBtn.id = 'aml-settings-close';
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = FF +
            'background:rgba(30,30,32,0.85);border:0.5px solid rgba(255,255,255,0.13);border-radius:50%;' +
            'width:26px;height:26px;cursor:pointer;color:rgba(255,255,255,0.6);font-size:12px;' +
            'display:flex;align-items:center;justify-content:center;margin-top:16px;' +
            'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
            'transition:background 0.15s,color 0.15s;';
        closeBtn.onmouseenter = () => { closeBtn.style.background = 'rgba(255,255,255,0.14)'; closeBtn.style.color = '#fff'; };
        closeBtn.onmouseleave = () => { closeBtn.style.background = 'rgba(30,30,32,0.85)'; closeBtn.style.color = 'rgba(255,255,255,0.6)'; };
        closeBtn.onclick = closeSettings;
        dlg.appendChild(closeBtn);

        const titleBar = document.createElement('div');
        titleBar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:4px 0 4px;margin-top:-26px;';
        const title = document.createElement('h1');
        title.textContent = 'AML Settings';
        title.style.cssText = FF + 'font-size:15px;font-weight:600;margin:0;color:rgba(255,255,255,0.95);';
        const savedBadge = document.createElement('span');
        savedBadge.style.cssText = FF + 'font-size:10px;color:#30d158;opacity:0;transition:opacity 0.3s;flex-shrink:0;';
        savedBadge.textContent = '✓ Saved';
        let _savedTimer = null;
        titleBar.append(title, savedBadge);
        dlg.appendChild(titleBar);

        // Wrap setTweak so every save flashes the badge.
        // Restore any prior open's proxy first (handles re-opens while open and bail paths).
        const _bridge = window.amlBridge;
        if (_bridge._settingsRestore) _bridge._settingsRestore();
        const _realSetTweak = _bridge.setTweak.bind(_bridge);
        const _restoreProxy = () => { _bridge.setTweak = _realSetTweak; _bridge._settingsRestore = null; };
        _bridge._settingsRestore = _restoreProxy;
        _bridge.setTweak = (k, v) => {
            _realSetTweak(k, v);
            savedBadge.style.opacity = '1';
            clearTimeout(_savedTimer);
            _savedTimer = setTimeout(() => { savedBadge.style.opacity = '0'; }, 1400);
        };
        dlg.addEventListener('close', _restoreProxy, { once: true });


        const [drm, tools] = await Promise.all([
            fetchDRM().catch(() => ({ state: {}, capabilities: {}, backend: {} })),
            fetch(`${ENGINE}/api/v1/tools`).then(r => r.json()).catch(() => ({})),
        ]);
        if (myGen !== _settingsGen) { _restoreProxy(); return; }
        const prefs = await window.amlBridge.getPrefs().catch(() => ({}));
        if (myGen !== _settingsGen) { _restoreProxy(); return; }
        const s     = drm.state ?? {};

        // Shared icon reset button — same style used throughout all sections
        const makeMiniBtn = (label, onClick) => {
            const b = document.createElement('button');
            b.textContent = '↺';
            b.title = 'Reset to default';
            b.style.cssText = FF + 'width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;' +
                'background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.12);border-radius:5px;' +
                'color:rgba(255,255,255,0.35);font-size:13px;cursor:pointer;transition:all 0.15s;';
            b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,0.12)'; b.style.color = 'rgba(255,255,255,0.7)'; };
            b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,0.06)'; b.style.color = 'rgba(255,255,255,0.35)'; };
            b.onclick = onClick;
            return b;
        };

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
        dBody.appendChild(makeRow('Background blur', bgBlurR, 'Wallpaper blur (requires a wallpaper to be set)', false));

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

            // Appearance: dark only for now

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

        // ── Audio Quality ──────────────────────────────────────────────────
        const { wrap: aqWrap, body: aqBody } = makeSection('Audio Quality');

        // iOS-style toggle: label wraps a hidden checkbox + styled track + thumb
        function makeIOSToggle(on, onChange) {
            const label = document.createElement('label');
            label.style.cssText = 'position:relative;display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0;width:44px;height:26px;';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = on;
            cb.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none;';
            const track = document.createElement('span');
            track.style.cssText = `position:absolute;inset:0;border-radius:13px;transition:background 0.22s;` +
                `background:${on ? '#fc3c44' : 'rgba(255,255,255,0.18)'};`;
            const thumb = document.createElement('span');
            thumb.style.cssText = `position:absolute;top:3px;left:${on ? '21px' : '3px'};` +
                `width:20px;height:20px;border-radius:50%;background:#fff;` +
                `box-shadow:0 1px 4px rgba(0,0,0,0.4);transition:left 0.22s;`;
            label.append(cb, track, thumb);
            cb.addEventListener('change', () => {
                track.style.background = cb.checked ? '#fc3c44' : 'rgba(255,255,255,0.18)';
                thumb.style.left = cb.checked ? '21px' : '3px';
                onChange(cb.checked);
            });
            return label;
        }

        const losslessOn = prefs['lossless-enabled'] !== false;
        aqBody.appendChild(makeRow('Lossless Audio',
            makeIOSToggle(losslessOn, v => window.amlBridge?.setTweak('lossless-enabled', v)),
            'Stream lossless audio (ALAC) when available', false));

        // Custom macOS-style dropdown
        const qualityOpts = [
            { value: 'high-quality',    label: 'High Quality (AAC 256 kbps)' },
            { value: 'lossless',        label: 'Lossless (ALAC up to 24-bit / 48 kHz)' },
            { value: 'hi-res-lossless', label: 'Hi-Res Lossless (ALAC up to 24-bit / 192 kHz)' },
        ];

        // Inject shared dropdown styles once
        if (!document.getElementById('aml-quality-dropdown-style')) {
            const ds = document.createElement('style');
            ds.id = 'aml-quality-dropdown-style';
            ds.textContent = `
                .aml-qdrop-btn {
                    display:flex;align-items:center;justify-content:space-between;gap:8px;
                    padding:6px 10px 6px 12px;
                    background:rgba(255,255,255,0.10);
                    border:0.5px solid rgba(255,255,255,0.18);
                    border-radius:8px;cursor:pointer;
                    font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
                    font-size:11px;color:rgba(255,255,255,0.88);
                    transition:background 0.15s;user-select:none;white-space:nowrap;
                }
                .aml-qdrop-btn:hover { background:rgba(255,255,255,0.15); }
                .aml-qdrop-chevron { font-size:8px;color:rgba(255,255,255,0.45);flex-shrink:0; }
                .aml-qdrop-menu {
                    background:rgba(32,32,34,0.97);
                    border:0.5px solid rgba(255,255,255,0.12);
                    border-radius:10px;
                    box-shadow:0 8px 32px rgba(0,0,0,0.7),0 1px 0 rgba(255,255,255,0.06) inset;
                    backdrop-filter:blur(32px) saturate(1.8);
                    -webkit-backdrop-filter:blur(32px) saturate(1.8);
                    overflow:hidden;padding:4px 0;
                }
                .aml-qdrop-item {
                    display:flex;align-items:center;gap:0;
                    padding:0;cursor:pointer;
                    font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
                    font-size:11px;color:rgba(255,255,255,0.88);
                    transition:background 0.1s;
                    border-radius:0;position:relative;white-space:nowrap;
                }
                .aml-qdrop-item:hover { background:rgba(255,255,255,0.07); }
                .aml-qdrop-accent {
                    width:3px;align-self:stretch;flex-shrink:0;
                    background:transparent;border-radius:0;
                    transition:background 0.15s;
                }
                .aml-qdrop-item.selected .aml-qdrop-accent { background:#fc3c44; }
                .aml-qdrop-item-label {
                    flex:1;padding:8px 16px 8px 10px;
                }
                .aml-qdrop-item.selected .aml-qdrop-item-label { color:#fff;font-weight:500; }
            `;
            document.head.appendChild(ds);
        }

        function makeQualityDropdown(prefKey) {
            const saved = prefs[prefKey] ?? 'lossless';
            let current = saved;

            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;display:inline-block;';

            const btn = document.createElement('div');
            btn.className = 'aml-qdrop-btn';
            const btnLabel = document.createElement('span');
            btnLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            const chevron = document.createElement('span');
            chevron.className = 'aml-qdrop-chevron';
            chevron.innerHTML = '&#9660;';
            btn.append(btnLabel, chevron);

            // Menu lives inside the wrap (which is inside the dialog top-layer)
            const menu = document.createElement('div');
            menu.className = 'aml-qdrop-menu';
            menu.style.cssText += 'display:none;position:absolute;top:calc(100% + 4px);right:0;left:auto;z-index:10;';

            function setOption(value, save) {
                current = value;
                const opt = qualityOpts.find(o => o.value === value);
                btnLabel.textContent = opt ? opt.label : value;
                const sv = String(value);
                menu.querySelectorAll('.aml-qdrop-item').forEach(el => {
                    el.classList.toggle('selected', el.dataset.value === sv);
                });
                if (save) {
                    window.amlBridge?.setTweak(prefKey, value);
                    if (prefKey === 'streaming-quality') _streamingQuality = value;
                }
            }

            qualityOpts.forEach(({ value, label }) => {
                const item = document.createElement('div');
                item.className = 'aml-qdrop-item';
                item.dataset.value = value;
                const accent = document.createElement('div');
                accent.className = 'aml-qdrop-accent';
                const lbl = document.createElement('div');
                lbl.className = 'aml-qdrop-item-label';
                lbl.textContent = label;
                item.append(accent, lbl);
                item.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    setOption(value, true);
                    menu.style.display = 'none';
                });
                menu.appendChild(item);
            });

            setOption(current, false);
            wrap.append(btn, menu);

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = menu.style.display !== 'none';
                // Close any other open dropdowns first
                document.querySelectorAll('.aml-qdrop-menu').forEach(m => { m.style.display = 'none'; });
                if (!open) {
                    menu.style.display = 'block';
                    const sel = menu.querySelector('.selected');
                    if (sel) sel.scrollIntoView({ block: 'nearest' });
                }
            });

            return { wrap, setValue: v => setOption(v, false) };
        }

        const { wrap: sqWrap, setValue: setSQ } = makeQualityDropdown('streaming-quality');
        const sqResetBtn = makeMiniBtn('Reset', () => {
            setSQ('lossless');
            window.amlBridge?.setTweak('streaming-quality', 'lossless');
            _streamingQuality = 'lossless';
        });
        const sqCtrl = document.createElement('div');
        sqCtrl.style.cssText = 'display:flex;align-items:center;gap:8px;';
        sqCtrl.append(sqWrap, sqResetBtn);
        aqBody.appendChild(makeRow('Streaming', sqCtrl, null, false));
        dlg.appendChild(aqWrap);

        // ── Cache ──────────────────────────────────────────────────────────
        const { wrap: cWrap, body: cBody } = makeSection('Playback Cache');
        const cacheStats = await fetch(`${ENGINE}/api/v1/cache/stats`).then(r => r.json()).catch(() => null);
        const mvCacheInfo = await fetch(`${ENGINE}/api/v1/cache/mv`).then(r => r.json()).catch(() => null);

        // Persistent cache section
        const persist = cacheStats?.persistent;
        if (persist?.available !== false) {
            const usedMB   = Math.round((persist?.sizeBytes ?? 0) / (1024 * 1024));
            const limitMB  = Math.round((persist?.limitBytes ?? 500 * 1024 * 1024) / (1024 * 1024));
            const ttlDays  = persist?.ttlDays ?? 5;

            const songsSubhead = document.createElement('div');
            songsSubhead.style.cssText = FF + 'font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:12px 0 4px;text-transform:uppercase;';
            songsSubhead.textContent = 'Songs';
            cBody.appendChild(songsSubhead);

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
            szVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);min-width:62px;text-align:right;white-space:nowrap;flex-shrink:0;';
            szVal.textContent = `${limitMB} MB`;
            const szSl = document.createElement('input');
            szSl.type = 'range'; szSl.min = 100; szSl.max = 10000; szSl.step = 100; szSl.value = limitMB;
            szSl.style.cssText = 'flex:1;accent-color:#fc3c44;';
            szSl.oninput = () => { szVal.textContent = `${szSl.value} MB`; };
            szSl.onchange = () => {
                const v = +szSl.value;
                window.amlBridge?.setPref('persistLimitMB', v);
                fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persistLimitMB: v }) }).catch(() => {});
            };
            const szResetBtn = makeMiniBtn('Reset', () => {
                szSl.value = 500; szVal.textContent = '500 MB';
                window.amlBridge?.setPref('persistLimitMB', 500);
                fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persistLimitMB: 500 }) }).catch(() => {});
            });
            const szRow = document.createElement('div');
            szRow.style.cssText = 'display:flex;align-items:center;flex:1;gap:8px;';
            szRow.append(szSl, szVal, szResetBtn);
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
            const ttlResetBtn = makeMiniBtn('Reset', () => {
                ttlInp.value = 5;
                window.amlBridge?.setPref('persistTTLDays', 5);
                fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ persistTTLDays: 5 }) }).catch(() => {});
            });
            ttlWrap.appendChild(ttlResetBtn);
            cBody.appendChild(makeRow('Expiry', ttlWrap, 'Songs unused longer than this are removed', false));

            const clearRow = document.createElement('div');
            clearRow.style.cssText = 'padding:10px 0;display:flex;gap:6px;';
            const clearSongsBtn = makeBtn('Clear Songs');
            clearSongsBtn.onclick = () => {
                fetch(`${ENGINE}/api/v1/cache/playback?what=persistent`, { method: 'DELETE' }).then(() => openSettings()).catch(() => {});
            };
            clearRow.appendChild(clearSongsBtn);
            cBody.appendChild(clearRow);
        }

        // ── MV cache — inlined inside Playback Cache card ──────────────────────
        const mvSubhead = document.createElement('div');
        mvSubhead.style.cssText = FF + 'font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:14px 0 4px;text-transform:uppercase;border-top:0.5px solid rgba(255,255,255,0.1);margin-top:2px;';
        mvSubhead.textContent = 'Music Video';
        cBody.appendChild(mvSubhead);

        const mvEnabled = mvCacheInfo?.enabled ?? true;
        const mvMaxBytes = mvCacheInfo?.maxBytes ?? (2 * 1024 * 1024 * 1024);
        const mvSizeBytes = mvCacheInfo?.sizeBytes ?? 0;
        const mvMaxGB = +(mvMaxBytes / (1024 * 1024 * 1024)).toFixed(1);
        const mvUsedMB = Math.round(mvSizeBytes / (1024 * 1024));
        const mvMaxMBLabel = Math.round(mvMaxBytes / (1024 * 1024));
        const mvPct = mvMaxBytes > 0 ? Math.min(100, Math.round(mvSizeBytes / mvMaxBytes * 100)) : 0;

        // MV cache used bar
        const mvBarWrap = document.createElement('div');
        mvBarWrap.style.cssText = 'flex:1;';
        const mvBarBg = document.createElement('div');
        mvBarBg.style.cssText = 'height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;';
        const mvBarFill = document.createElement('div');
        mvBarFill.style.cssText = `height:100%;width:${mvPct}%;background:#fc3c44;border-radius:2px;`;
        mvBarBg.appendChild(mvBarFill);
        const mvBarLabel = document.createElement('div');
        mvBarLabel.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.4);';
        const mvQuality = mvCacheInfo?.quality;
        mvBarLabel.textContent = mvQuality
            ? `${mvUsedMB} MB / ${mvMaxMBLabel} MB · ${mvQuality}`
            : `${mvUsedMB} MB / ${mvMaxMBLabel} MB`;
        mvBarWrap.appendChild(mvBarBg); mvBarWrap.appendChild(mvBarLabel);
        cBody.appendChild(makeRow('Cache used', mvBarWrap, null, false));

        const mvToggle = makeIOSToggle(mvEnabled, v => {
            mvCapSl.disabled = !v;
            fetch(`${ENGINE}/api/v1/cache/mv`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: v }),
            }).catch(() => {});
        });
        cBody.appendChild(makeRow('Cache MV segments', mvToggle, 'Stores downloaded video segments so replays start instantly', false));

        const mvMaxMB = Math.round(mvMaxGB * 1024);
        const mvCapVal = document.createElement('span');
        mvCapVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);min-width:62px;text-align:right;white-space:nowrap;flex-shrink:0;';
        mvCapVal.textContent = `${mvMaxMB} MB`;
        const mvCapSl = document.createElement('input');
        mvCapSl.type = 'range'; mvCapSl.min = 512; mvCapSl.max = 20480; mvCapSl.step = 512;
        mvCapSl.value = mvMaxMB;
        mvCapSl.style.cssText = 'flex:1;accent-color:#fc3c44;';
        mvCapSl.disabled = !mvEnabled;
        mvCapSl.oninput = () => { mvCapVal.textContent = `${mvCapSl.value} MB`; };
        mvCapSl.onchange = () => {
            fetch(`${ENGINE}/api/v1/cache/mv`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ maxBytes: Math.round(+mvCapSl.value * 1024 * 1024) }),
            }).catch(() => {});
        };
        const mvCapResetBtn = makeMiniBtn('Reset', () => {
            mvCapSl.value = 2048; mvCapVal.textContent = '2048 MB';
            fetch(`${ENGINE}/api/v1/cache/mv`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxBytes: 2 * 1024 * 1024 * 1024 }) }).catch(() => {});
        });
        const mvCapRow = document.createElement('div');
        mvCapRow.style.cssText = 'display:flex;align-items:center;flex:1;gap:8px;';
        mvCapRow.append(mvCapSl, mvCapVal, mvCapResetBtn);
        cBody.appendChild(makeRow('Capacity limit', mvCapRow, 'LRU eviction — oldest segments removed when limit is reached', false));

        const mvClearRow = document.createElement('div');
        mvClearRow.style.cssText = 'padding:10px 0;display:flex;gap:6px;';
        const mvClearBtn = makeBtn('Clear MV Cache');
        mvClearBtn.onclick = () => {
            fetch(`${ENGINE}/api/v1/cache/mv`, { method: 'DELETE' }).then(() => openSettings()).catch(() => {});
        };
        mvClearRow.appendChild(mvClearBtn);
        cBody.appendChild(mvClearRow);

        // ── Pre-warm section divider ───────────────────────────────────────────
        const pwSubhead = document.createElement('div');
        pwSubhead.style.cssText = FF + 'font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:14px 0 4px;text-transform:uppercase;border-top:0.5px solid rgba(255,255,255,0.1);margin-top:2px;';
        pwSubhead.textContent = 'Pre-warm';
        cBody.appendChild(pwSubhead);

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
        pwBarFill.style.cssText = `height:100%;width:${pwPct}%;background:#fc3c44;border-radius:2px;`;
        pwBarBg.appendChild(pwBarFill);
        const pwBarLabel = document.createElement('div');
        pwBarLabel.style.cssText = FF + 'font-size:11px;color:rgba(255,255,255,0.4);';
        pwBarLabel.textContent = `${pwUsedMB} MB / ${pwLimitMB} MB`;
        pwBarWrap.appendChild(pwBarBg); pwBarWrap.appendChild(pwBarLabel);
        cBody.appendChild(makeRow('Pre-warm buffer', pwBarWrap, 'Next 2 tracks pre-loaded in memory', false));

        const pwSzVal = document.createElement('span');
        pwSzVal.style.cssText = FF + 'font-size:12px;color:rgba(255,255,255,0.5);min-width:62px;text-align:right;white-space:nowrap;flex-shrink:0;';
        pwSzVal.textContent = `${pwLimitMB} MB`;
        const pwSzSl = document.createElement('input');
        pwSzSl.type = 'range'; pwSzSl.min = 100; pwSzSl.max = 4096; pwSzSl.step = 128; pwSzSl.value = pwLimitMB;
        pwSzSl.style.cssText = 'flex:1;accent-color:#fc3c44;';
        pwSzSl.oninput = () => { pwSzVal.textContent = `${pwSzSl.value} MB`; };
        pwSzSl.onchange = () => {
            const v = +pwSzSl.value;
            window.amlBridge?.setPref('prewarmLimitMB', v);
            fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prewarmLimitMB: v }) }).catch(() => {});
        };
        const pwSzResetBtn = makeMiniBtn('Reset', () => {
            pwSzSl.value = 1024; pwSzVal.textContent = '1024 MB';
            window.amlBridge?.setPref('prewarmLimitMB', 1024);
            fetch(`${ENGINE}/api/v1/cache/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prewarmLimitMB: 1024 }) }).catch(() => {});
        });
        const pwSzRow = document.createElement('div');
        pwSzRow.style.cssText = 'display:flex;align-items:center;flex:1;gap:8px;';
        pwSzRow.append(pwSzSl, pwSzVal, pwSzResetBtn);
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

        // ── Downloads section ──────────────────────────────────────────────────
        const { wrap: dlWrap, body: dlBody } = makeSection('Downloads');

        // Known template variables for validation
        const DL_KNOWN_VARS = new Set([
            'title','song','artist','album_artist','album','track_number','track',
            'disc_number','disc','year','genre','codec','ext','quality','tag',
            'release_date','releasedate','isrc','id','song_id','url_artist','urlartist',
        ]);

        // Sub-section heading helper
        function dlSubhead(text) {
            const h = document.createElement('div');
            h.style.cssText = FF + 'font-size:10px;font-weight:600;letter-spacing:0.06em;' +
                'color:rgba(255,255,255,0.35);padding:14px 0 4px;text-transform:uppercase;';
            h.textContent = text;
            return h;
        }

        // Shared small-dropdown builder (reuses .aml-qdrop-* styles already injected)
        function dlDropdown(options, savedValue, onSave) {
            let current = savedValue;
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;display:inline-block;min-width:180px;';
            const btn = document.createElement('div');
            btn.className = 'aml-qdrop-btn';
            btn.style.cssText += 'font-size:12px;';
            const btnLabel = document.createElement('span');
            btnLabel.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            const chevron = document.createElement('span');
            chevron.className = 'aml-qdrop-chevron';
            chevron.innerHTML = '&#9660;';
            btn.append(btnLabel, chevron);
            const menu = document.createElement('div');
            menu.className = 'aml-qdrop-menu';
            menu.style.cssText += 'display:none;position:absolute;top:calc(100% + 4px);right:0;left:auto;z-index:20;min-width:100%;';
            function setOpt(v, save) {
                current = v;
                const opt = options.find(o => o.value === v);
                btnLabel.textContent = opt ? opt.label : v;
                const sv = String(v);
                menu.querySelectorAll('.aml-qdrop-item').forEach(el =>
                    el.classList.toggle('selected', el.dataset.value === sv));
                if (save) onSave(v);
            }
            options.forEach(({ value, label }) => {
                const item = document.createElement('div');
                item.className = 'aml-qdrop-item';
                item.dataset.value = value;
                const accent = document.createElement('div'); accent.className = 'aml-qdrop-accent';
                const lbl = document.createElement('div'); lbl.className = 'aml-qdrop-item-label';
                lbl.textContent = label;
                item.append(accent, lbl);
                item.addEventListener('mousedown', e => { e.preventDefault(); setOpt(value, true); menu.style.display = 'none'; });
                menu.appendChild(item);
            });
            setOpt(current, false);
            wrap.append(btn, menu);
            btn.addEventListener('click', e => {
                e.stopPropagation();
                const open = menu.style.display !== 'none';
                document.querySelectorAll('.aml-qdrop-menu').forEach(m => { m.style.display = 'none'; });
                if (!open) { menu.style.display = 'block'; menu.querySelector('.selected')?.scrollIntoView({ block: 'nearest' }); }
            });
            return { wrap, getValue: () => current, setValue: v => setOpt(v, false) };
        }

        // ── Save Location ────────────────────────────────────────────────────
        dlBody.appendChild(dlSubhead('Save Location'));

        // Save-to directory
        const dlDirCurrent = prefs['download-dir'] || '';
        const dlSaveRow = document.createElement('div');
        dlSaveRow.style.cssText = 'display:flex;align-items:center;gap:10px;padding:4px 0 8px;';
        const dlDirDisplay = document.createElement('span');
        dlDirDisplay.style.cssText = FF + 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            'color:rgba(255,255,255,0.45);font-size:12px;min-width:0;';
        dlDirDisplay.textContent = dlDirCurrent || '~/Music/AML-Downloads (default)';
        const dlDirBtn = document.createElement('button');
        dlDirBtn.textContent = 'Choose…';
        dlDirBtn.style.cssText = FF + 'padding:3px 10px;background:rgba(255,255,255,0.10);' +
            'border:0.5px solid rgba(255,255,255,0.15);border-radius:5px;color:rgba(255,255,255,0.82);' +
            'font-size:12px;cursor:pointer;flex-shrink:0;transition:background 0.15s;';
        dlDirBtn.onmouseenter = () => { dlDirBtn.style.background = 'rgba(255,255,255,0.18)'; };
        dlDirBtn.onmouseleave = () => { dlDirBtn.style.background = 'rgba(255,255,255,0.10)'; };
        dlDirBtn.onclick = async () => {
            const result = await window.amlBridge?.chooseDownloadDir();
            if (result && !result.canceled && result.filePaths?.[0]) {
                const dir = result.filePaths[0];
                dlDirDisplay.textContent = dir;
                window.amlBridge?.setTweak('download-dir', dir);
                updatePreview();
            }
        };
        const dlDirResetBtn = makeMiniBtn('Reset', () => {
            prefs['download-dir'] = '';
            dlDirDisplay.textContent = '~/Music/AML-Downloads (default)';
            window.amlBridge?.setTweak('download-dir', null);
            dlDirResetBtn.style.display = 'none';
            updatePreview();
        });
        dlDirResetBtn.style.display = dlDirCurrent ? '' : 'none';
        dlSaveRow.append(dlDirDisplay, dlDirBtn, dlDirResetBtn);
        dlBody.appendChild(makeRow('Save to', dlSaveRow, null, false));

        // Album folder presets
        const ALBUM_PRESETS = [
            { value: '{album_artist}/{album}',                       label: '{album_artist}/{album}' },
            { value: '{album_artist}/{year} - {album}',              label: '{album_artist}/{year} - {album}' },
            { value: '{album_artist}/{album} ({year})',               label: '{album_artist}/{album} ({year})' },
            { value: '{album_artist}/{album} [{codec}]',             label: '{album_artist}/{album} [{codec}]' },
            { value: '{album_artist}/{year} - {album} [{quality}]',  label: '{album_artist}/{year} - {album} [{quality}]' },
            { value: '{year} - {album}',                             label: '{year} - {album}' },
            { value: '{album}',                                      label: '{album}' },
            { value: '{url_artist}/{album}',                         label: '{url_artist}/{album}' },
        ];
        const SONG_PRESETS = [
            { value: '{track_number:02d} - {title}',                       label: '{track_number:02d} - {title}' },
            { value: '{track_number:02d}. {title}',                        label: '{track_number:02d}. {title}' },
            { value: '{track_number:02d} - {title} {tag}',                 label: '{track_number:02d} - {title} {tag}' },
            { value: '{track_number:02d} - {artist} - {title}',            label: '{track_number:02d} - {artist} - {title}' },
            { value: '{track_number:02d} - {title} [{quality}]',           label: '{track_number:02d} - {title} [{quality}]' },
            { value: '{track_number:02d} - {title} [{codec}]',             label: '{track_number:02d} - {title} [{codec}]' },
            { value: '{disc_number}-{track_number:02d} - {title}',         label: '{disc_number}-{track_number:02d} - {title}' },
            { value: '{disc_number}-{track_number:02d} - {title} {tag}',   label: '{disc_number}-{track_number:02d} - {title} {tag}' },
            { value: '{title}',                                            label: '{title}' },
            { value: '{id} - {title}',                                     label: '{id} - {title}' },
        ];

        // Read from the same keys that controls write to
        const savedAlbumFolder = prefs['download-album-folder'] || '{album_artist}/{album}';
        const savedSongPart    = (prefs['download-song-file']   || '{track_number:02d} - {title}').replace(/\.\{ext\}$/, '');

        // Validate a template string — returns '' (valid) or error message
        const validateTemplate = tmpl => {
            const matches = tmpl.match(/\{([^}:]+)(?::[^}]+)?\}/g) || [];
            const unknown = matches
                .map(m => m.match(/\{([^}:]+)/)[1].toLowerCase())
                .filter(n => !DL_KNOWN_VARS.has(n));
            return unknown.length ? `Unknown variables: ${unknown.map(n => '{'+n+'}').join(', ')}` : '';
        };

        // Example renderers — substitute placeholder values for display
        const EX = {
            album_artist: 'Artist Name', artist: 'Artist Name', album: 'Album Title',
            year: '2024', codec: 'alac', quality: 'Lossless', url_artist: 'artist-name',
            'track_number:02d': '01', track_number: '1', disc_number: '1',
            title: 'Song Title', tag: '[E]', ext: 'm4a',
            id: '1234567890', isrc: 'USRC12345678', release_date: '2024-01-15',
        };
        const renderTemplate = val =>
            (val || '').replace(/\{([^}:]+)(?::[^}]+)?\}/g, (_, k) => EX[k] || EX[k.toLowerCase()] || `{${k}}`);

        // Live path preview — declared before makeTemplateRow so updatePreview is
        // accessible when syncMode fires during row construction.
        const previewEl = document.createElement('div');
        previewEl.style.cssText = FF + 'font-size:10.5px;color:rgba(255,255,255,0.35);padding:4px 0 2px;' +
            'word-break:break-all;font-family:ui-monospace,monospace;line-height:1.5;';

        const updatePreview = () => {
            const baseDir = (prefs['download-dir'] || '~/Music/AML-Downloads').replace(/\/$/, '');
            const af = renderTemplate(prefs['download-album-folder'] || savedAlbumFolder);
            const sf = renderTemplate(prefs['download-song-file'] || savedSongPart);
            previewEl.textContent = `${baseDir}/${af}/${sf}.m4a`;
        };

        // Template row: dropdown + Custom toggle + per-row example + Reset button
        const makeTemplateRow = (label, presets, savedValue, prefKey, suffix) => {
            const isCustom = !presets.some(p => p.value === savedValue);
            const rowWrap = document.createElement('div');
            rowWrap.style.cssText = 'display:flex;flex-direction:column;gap:5px;';

            const topRow = document.createElement('div');
            topRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

            const customLbl = document.createElement('label');
            customLbl.style.cssText = FF + 'display:flex;align-items:center;gap:5px;color:rgba(255,255,255,0.4);font-size:11px;cursor:pointer;flex-shrink:0;';
            const customCb = document.createElement('input');
            customCb.type = 'checkbox'; customCb.checked = isCustom;
            customCb.style.cssText = 'accent-color:#fc3c44;cursor:pointer;';
            customLbl.append(customCb, document.createTextNode('Custom'));

            const resetBtn = document.createElement('button');
            resetBtn.textContent = 'Reset';
            resetBtn.title = 'Restore default';
            resetBtn.style.cssText = FF + 'padding:2px 8px;background:rgba(255,255,255,0.06);' +
                'border:0.5px solid rgba(255,255,255,0.12);border-radius:5px;' +
                'color:rgba(255,255,255,0.38);font-size:10.5px;cursor:pointer;flex-shrink:0;' +
                'transition:all 0.15s;';
            resetBtn.onmouseenter = () => { resetBtn.style.background = 'rgba(255,255,255,0.12)'; resetBtn.style.color = 'rgba(255,255,255,0.7)'; };
            resetBtn.onmouseleave = () => { resetBtn.style.background = 'rgba(255,255,255,0.06)'; resetBtn.style.color = 'rgba(255,255,255,0.38)'; };

            const { wrap: ddWrap, getValue, setValue } = dlDropdown(presets, isCustom ? presets[0].value : savedValue, v => {
                window.amlBridge?.setTweak(prefKey, v);
                exampleEl.textContent = renderTemplate(v) + (suffix || '');
                updatePreview();
            });

            // Per-row example preview
            const exampleEl = document.createElement('div');
            exampleEl.style.cssText = FF + 'font-size:10.5px;color:rgba(255,255,255,0.32);' +
                'font-family:ui-monospace,monospace;padding:1px 0;min-height:14px;';

            // Custom input + validator
            const customWrap = document.createElement('div');
            customWrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
            const customInp = document.createElement('input');
            customInp.type = 'text';
            customInp.value = isCustom ? savedValue : (getValue() || '');
            customInp.placeholder = prefKey.includes('album') ? '{album_artist}/{year} - {album}' : '{track_number:02d} - {title}';
            customInp.style.cssText = FF + 'width:100%;padding:5px 10px;border-radius:7px;' +
                'background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.15);' +
                'color:rgba(255,255,255,0.88);font-size:12px;box-sizing:border-box;outline:none;transition:border-color 0.15s;';
            customInp.onfocus = () => { customInp.style.borderColor = 'rgba(252,60,68,0.45)'; };
            customInp.onblur  = () => {
                const err = validateTemplate(customInp.value);
                customInp.style.borderColor = err ? 'rgba(255,69,58,0.5)' : customInp.value ? 'rgba(48,209,88,0.4)' : 'rgba(255,255,255,0.15)';
            };
            const validMsg = document.createElement('div');
            validMsg.style.cssText = FF + 'font-size:10.5px;min-height:14px;';

            const applyCustom = val => {
                const err = validateTemplate(val);
                if (err) {
                    validMsg.style.color = '#ff453a';
                    validMsg.textContent = '⚠ ' + err;
                    customInp.style.borderColor = 'rgba(255,69,58,0.5)';
                    exampleEl.textContent = '';
                } else {
                    validMsg.style.color = '#30d158';
                    validMsg.textContent = val ? '✓ Valid' : '';
                    customInp.style.borderColor = val ? 'rgba(48,209,88,0.4)' : 'rgba(255,255,255,0.15)';
                    window.amlBridge?.setTweak(prefKey, val);
                    exampleEl.textContent = val ? (renderTemplate(val) + (suffix || '')) : '';
                    updatePreview();
                }
            };
            customInp.oninput = () => applyCustom(customInp.value);
            customWrap.append(customInp, validMsg);

            const syncMode = () => {
                const custom = customCb.checked;
                ddWrap.style.display = custom ? 'none' : 'inline-block';
                customWrap.style.display = custom ? 'block' : 'none';
                resetBtn.style.display = (custom || getValue() === presets[0].value) ? 'none' : 'inline-block';
                if (custom) {
                    customInp.value = getValue();
                    applyCustom(customInp.value);
                } else {
                    window.amlBridge?.setTweak(prefKey, getValue());
                    exampleEl.textContent = renderTemplate(getValue()) + (suffix || '');
                    updatePreview();
                }
            };

            resetBtn.onclick = () => {
                customCb.checked = false;
                setValue(presets[0].value);
                window.amlBridge?.setTweak(prefKey, presets[0].value);
                exampleEl.textContent = renderTemplate(presets[0].value) + (suffix || '');
                updatePreview();
                syncMode();
            };

            customCb.onchange = syncMode;
            syncMode();

            topRow.append(ddWrap, customLbl, resetBtn);
            rowWrap.append(topRow, customWrap, exampleEl);
            return rowWrap;
        };

        const albumFolderRow = makeTemplateRow('Album folder', ALBUM_PRESETS, savedAlbumFolder, 'download-album-folder', '');
        const songFileRow    = makeTemplateRow('Song filename', SONG_PRESETS,  savedSongPart,         'download-song-file',    '.m4a');
        dlBody.appendChild(makeRow('Album folder', albumFolderRow, null, false));
        dlBody.appendChild(makeRow('Song filename', songFileRow, null, false));
        updatePreview();
        dlBody.appendChild(previewEl);

        // ── Quality & Format ─────────────────────────────────────────────────
        dlBody.appendChild(dlSubhead('Quality & Format'));

        const { wrap: dqWrap, setValue: setDQ } = makeQualityDropdown('downloads-quality');
        const dqResetBtn = makeMiniBtn('Reset', () => {
            setDQ('lossless');
            window.amlBridge?.setTweak('downloads-quality', 'lossless');
        });
        const dqCtrl = document.createElement('div');
        dqCtrl.style.cssText = 'display:flex;align-items:center;gap:8px;';
        dqCtrl.append(dqWrap, dqResetBtn);
        dlBody.appendChild(makeRow('Audio quality', dqCtrl, null, false));

        // ── MV video quality segmented control ───────────────────────────────
        const MV_QUALITY_OPTS = [
            { value: 0,    label: 'Best' },
            { value: 2160, label: '4K'   },
            { value: 1080, label: '1080p' },
            { value: 720,  label: '720p'  },
            { value: 480,  label: '480p'  },
        ];
        const savedMVH = parseInt(prefs['mv-max-height'] ?? '0', 10) || 0;

        const mvSeg = document.createElement('div');
        mvSeg.style.cssText = 'display:flex;align-items:center;border-radius:8px;overflow:hidden;' +
            'border:0.5px solid rgba(255,255,255,0.14);background:rgba(255,255,255,0.06);flex-shrink:0;';

        MV_QUALITY_OPTS.forEach(({ value, label }) => {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.dataset.val = value;
            const active = value === savedMVH;
            btn.style.cssText = FF + `padding:4px 10px;font-size:12px;border:none;border-radius:0;cursor:pointer;` +
                `background:${active ? '#fc3c44' : 'transparent'};` +
                `color:${active ? '#fff' : 'rgba(255,255,255,0.55)'};` +
                `transition:background 0.15s,color 0.15s;border-right:0.5px solid rgba(255,255,255,0.1);`;
            btn.onmouseenter = () => { if (btn.dataset.val != mvSeg.dataset.active) btn.style.background = 'rgba(255,255,255,0.1)'; };
            btn.onmouseleave = () => { if (btn.dataset.val != mvSeg.dataset.active) btn.style.background = 'transparent'; };
            btn.onclick = () => {
                mvSeg.dataset.active = value;
                mvSeg.querySelectorAll('button').forEach(b => {
                    const sel = b.dataset.val == value;
                    b.style.background = sel ? '#fc3c44' : 'transparent';
                    b.style.color = sel ? '#fff' : 'rgba(255,255,255,0.55)';
                });
                const v = parseInt(value, 10);
                window.amlBridge?.setTweak('mv-max-height', v === 0 ? null : v);
            };
            if (active) mvSeg.dataset.active = value;
            mvSeg.appendChild(btn);
        });
        // Remove last right border
        mvSeg.lastChild.style.borderRight = 'none';
        dlBody.appendChild(makeRow('Video quality', mvSeg, null, false));

        const OVERWRITE_OPTS = [
            { value: 'skip',      label: 'Skip — keep existing file' },
            { value: 'overwrite', label: 'Overwrite — replace existing file' },
            { value: 'rename',    label: 'Rename — append (1), (2)…' },
        ];
        const { wrap: owDd } = dlDropdown(OVERWRITE_OPTS, prefs['download-overwrite'] || 'skip',
            v => window.amlBridge?.setTweak('download-overwrite', v));
        dlBody.appendChild(makeRow('If file exists', owDd, null, false));

        const ffmpegOk   = !!(tools.ffmpeg?.available);
        const ffmpegPath = tools.ffmpeg?.path || '';

        const flacToggle = makeIOSToggle(!!(prefs['convert-to-flac']), v => {
            window.amlBridge?.setTweak('convert-to-flac', v);
            keepRow.style.display = v ? '' : 'none';
        });
        dlBody.appendChild(makeRow('Convert to FLAC', flacToggle, null, false));

        // FFmpeg status row
        const ffStatusWrap = document.createElement('div');
        ffStatusWrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const ffDot = document.createElement('span');
        ffDot.style.cssText = `width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${ffmpegOk ? '#30d158' : '#ff453a'};`;
        const ffLabel = document.createElement('span');
        ffLabel.style.cssText = FF + `font-size:11.5px;color:${ffmpegOk ? 'rgba(255,255,255,0.6)' : 'rgba(255,69,58,0.85)'};font-family:ui-monospace,monospace;`;
        ffLabel.textContent = ffmpegOk ? ffmpegPath : 'not found in PATH';
        ffStatusWrap.append(ffDot, ffLabel);

        // Custom binary path toggle
        const ffCustomOn = !!(prefs['ffmpeg-path']);
        const ffCustomLbl = document.createElement('label');
        ffCustomLbl.style.cssText = FF + 'display:flex;align-items:center;gap:5px;color:rgba(255,255,255,0.4);font-size:11px;cursor:pointer;';
        const ffCustomCb = document.createElement('input');
        ffCustomCb.type = 'checkbox'; ffCustomCb.checked = ffCustomOn;
        ffCustomCb.style.cssText = 'accent-color:#fc3c44;cursor:pointer;';
        ffCustomLbl.append(ffCustomCb, document.createTextNode('Custom path'));
        ffStatusWrap.appendChild(ffCustomLbl);

        const ffPathInp = document.createElement('input');
        ffPathInp.type = 'text';
        ffPathInp.value = prefs['ffmpeg-path'] || '';
        ffPathInp.placeholder = '/usr/local/bin/ffmpeg';
        ffPathInp.style.cssText = FF + 'width:100%;padding:5px 10px;border-radius:7px;margin-top:4px;' +
            'background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.15);' +
            'color:rgba(255,255,255,0.88);font-size:12px;font-family:ui-monospace,monospace;' +
            'box-sizing:border-box;outline:none;transition:border-color 0.15s;' +
            (ffCustomOn ? '' : 'display:none;');
        ffPathInp.onfocus = () => { ffPathInp.style.borderColor = 'rgba(252,60,68,0.45)'; };
        ffPathInp.onblur  = () => { ffPathInp.style.borderColor = 'rgba(255,255,255,0.15)'; };
        ffPathInp.oninput = () => window.amlBridge?.setTweak('ffmpeg-path', ffPathInp.value || null);

        ffCustomCb.onchange = () => {
            ffPathInp.style.display = ffCustomCb.checked ? '' : 'none';
            if (!ffCustomCb.checked) window.amlBridge?.setTweak('ffmpeg-path', null);
        };

        const ffWrap = document.createElement('div');
        ffWrap.style.cssText = 'display:flex;flex-direction:column;gap:0;';
        ffWrap.append(ffStatusWrap, ffPathInp);
        dlBody.appendChild(makeRow('FFmpeg', ffWrap, null, false));

        const keepToggle = makeIOSToggle(!!(prefs['keep-original']), v => window.amlBridge?.setTweak('keep-original', v));
        const keepRow = makeRow('Keep original M4A', keepToggle, null, false);
        keepRow.style.display = prefs['convert-to-flac'] ? '' : 'none';
        dlBody.appendChild(keepRow);

        // ── Artwork ──────────────────────────────────────────────────────────
        dlBody.appendChild(dlSubhead('Artwork'));

        const artToggle = makeIOSToggle(prefs['embed-artwork'] !== false, v => window.amlBridge?.setTweak('embed-artwork', v));
        dlBody.appendChild(makeRow('Embed cover art', artToggle, null, false));
        const ART_SIZE_OPTS = [
            { value: '600',  label: '600 × 600' },
            { value: '1200', label: '1200 × 1200' },
            { value: '3000', label: '3000 × 3000 (default)' },
            { value: '5000', label: '5000 × 5000' },
        ];
        const savedArtSize = String(prefs['artwork-size'] || '3000');
        const artSzIsCustom = !ART_SIZE_OPTS.some(o => o.value === savedArtSize);
        const { wrap: artSzDd, getValue: getArtSzVal } = dlDropdown(ART_SIZE_OPTS, artSzIsCustom ? '3000' : savedArtSize,
            v => window.amlBridge?.setTweak('artwork-size', v));

        const artSzCustomInp = document.createElement('input');
        artSzCustomInp.type = 'number';
        artSzCustomInp.min = '100';
        artSzCustomInp.max = '10000';
        artSzCustomInp.step = '100';
        artSzCustomInp.value = artSzIsCustom ? savedArtSize : '3000';
        artSzCustomInp.placeholder = 'e.g. 4000';
        artSzCustomInp.style.cssText = FF + 'width:90px;padding:4px 8px;border-radius:7px;' +
            'background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.15);' +
            'color:rgba(255,255,255,0.88);font-size:12px;outline:none;' +
            'transition:border-color 0.15s;display:none;';
        artSzCustomInp.onfocus = () => { artSzCustomInp.style.borderColor = 'rgba(252,60,68,0.5)'; };
        artSzCustomInp.onblur  = () => { artSzCustomInp.style.borderColor = 'rgba(255,255,255,0.15)'; };
        artSzCustomInp.oninput = () => {
            const v = parseInt(artSzCustomInp.value, 10);
            if (v >= 100 && v <= 10000) window.amlBridge?.setTweak('artwork-size', String(v));
        };

        const artSzCustomLbl = document.createElement('label');
        artSzCustomLbl.style.cssText = FF + 'display:flex;align-items:center;gap:5px;color:rgba(255,255,255,0.45);font-size:11px;cursor:pointer;flex-shrink:0;';
        const artSzCustomCb = document.createElement('input');
        artSzCustomCb.type = 'checkbox';
        artSzCustomCb.checked = artSzIsCustom;
        artSzCustomCb.style.cssText = 'accent-color:#fc3c44;cursor:pointer;';
        artSzCustomLbl.append(artSzCustomCb, document.createTextNode('Custom'));

        artSzCustomCb.onchange = () => {
            const custom = artSzCustomCb.checked;
            artSzDd.style.display = custom ? 'none' : 'inline-block';
            artSzCustomInp.style.display = custom ? 'inline-block' : 'none';
            if (custom) {
                artSzCustomInp.value = getArtSzVal();
                window.amlBridge?.setTweak('artwork-size', artSzCustomInp.value);
            } else {
                window.amlBridge?.setTweak('artwork-size', getArtSzVal());
            }
        };
        if (artSzIsCustom) { artSzDd.style.display = 'none'; artSzCustomInp.style.display = 'inline-block'; }

        const artSzWrap = document.createElement('div');
        artSzWrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        artSzWrap.append(artSzDd, artSzCustomInp, artSzCustomLbl);
        dlBody.appendChild(makeRow('Artwork size', artSzWrap, null, false));

        // ── Lyrics ───────────────────────────────────────────────────────────
        dlBody.appendChild(dlSubhead('Lyrics'));

        const lyrToggle = makeIOSToggle(prefs['embed-lyrics'] !== false, v => window.amlBridge?.setTweak('embed-lyrics', v));
        dlBody.appendChild(makeRow('Embed lyrics', lyrToggle, null, false));
        const LYR_TYPE_OPTS = [
            { value: 'lyrics',           label: 'Standard (time-synced)' },
            { value: 'syllable-lyrics',  label: 'Syllable (word-level)' },
        ];
        const { wrap: lyrTypeDd } = dlDropdown(LYR_TYPE_OPTS, prefs['lyrics-type'] || 'lyrics',
            v => window.amlBridge?.setTweak('lyrics-type', v));
        dlBody.appendChild(makeRow('Lyrics type', lyrTypeDd, null, false));
        const LYR_FMT_OPTS = [
            { value: 'lrc',  label: 'LRC' },
            { value: 'ttml', label: 'TTML' },
        ];
        const { wrap: lyrFmtDd } = dlDropdown(LYR_FMT_OPTS, prefs['lyrics-format'] || 'lrc',
            v => window.amlBridge?.setTweak('lyrics-format', v));
        dlBody.appendChild(makeRow('Lyrics format', lyrFmtDd, null, false));
        const sidecarToggle = makeIOSToggle(!!(prefs['save-lrc-sidecar']), v => window.amlBridge?.setTweak('save-lrc-sidecar', v));
        dlBody.appendChild(makeRow('Save .lrc sidecar', sidecarToggle, 'Writes a .lrc file alongside the audio', false));

        // ── Content & Tags ───────────────────────────────────────────────────
        dlBody.appendChild(dlSubhead('Content & Tags'));

        // Helper: small inline marker text input
        const makeMarkerInput = (prefKey, defaultVal) => {
            const inp = document.createElement('input');
            inp.type = 'text';
            inp.value = prefs[prefKey] || defaultVal;
            inp.maxLength = 8;
            inp.style.cssText = FF + 'width:60px;padding:4px 8px;border-radius:7px;text-align:center;' +
                'background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.15);' +
                'color:rgba(255,255,255,0.88);font-size:12.5px;font-family:ui-monospace,monospace;outline:none;' +
                'transition:border-color 0.15s;';
            inp.onfocus = () => { inp.style.borderColor = 'rgba(252,60,68,0.5)'; };
            inp.onblur  = () => { inp.style.borderColor = 'rgba(255,255,255,0.15)'; };
            inp.oninput = () => window.amlBridge?.setTweak(prefKey, inp.value);
            return inp;
        };

        // Helper: marker input + inline reset button
        const makeMarkerControl = (prefKey, defaultVal) => {
            const inp = makeMarkerInput(prefKey, defaultVal);
            const resetBtn = makeMiniBtn('Reset', () => {
                inp.value = defaultVal;
                window.amlBridge?.setTweak(prefKey, defaultVal);
            });
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
            wrap.append(inp, resetBtn);
            return wrap;
        };

        // Helper: indented sub-row (shown/hidden by parent toggle)
        const makeDependentRow = (label, control) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;align-items:center;padding:9px 0 9px 14px;' +
                'border-bottom:0.5px solid rgba(255,255,255,0.07);';
            const lbl = document.createElement('div');
            lbl.style.cssText = FF + 'flex:1;font-size:13px;color:rgba(255,255,255,0.45);';
            lbl.textContent = label;
            if (control.style) control.style.marginLeft = 'auto';
            wrap.append(lbl, control);
            return wrap;
        };

        // Explicit content
        const explicitOn = prefs['explicit-enabled'] !== false;
        const explicitInpRow = makeDependentRow('Marker text', makeMarkerControl('explicit-marker', '[E]'));
        explicitInpRow.style.display = explicitOn ? '' : 'none';
        dlBody.appendChild(makeRow('Explicit content',
            makeIOSToggle(explicitOn, v => {
                window.amlBridge?.setTweak('explicit-enabled', v);
                explicitInpRow.style.display = v ? '' : 'none';
            }),
            'Add [E] to filenames of explicit tracks', false));
        dlBody.appendChild(explicitInpRow);

        // Clean content (off by default — most users don't want [C] in filenames)
        const cleanOn = !!(prefs['clean-enabled']);
        const cleanInpRow = makeDependentRow('Marker text', makeMarkerControl('clean-marker', '[C]'));
        cleanInpRow.style.display = cleanOn ? '' : 'none';
        dlBody.appendChild(makeRow('Clean content',
            makeIOSToggle(cleanOn, v => {
                window.amlBridge?.setTweak('clean-enabled', v);
                cleanInpRow.style.display = v ? '' : 'none';
            }),
            'Add [C] to filenames of clean/censored tracks', false));
        dlBody.appendChild(cleanInpRow);

        // Apple Digital Masters
        const admOn = prefs['adm-enabled'] !== false;
        const admInpRow = makeDependentRow('Marker text', makeMarkerControl('adm-marker', '[M]'));
        admInpRow.style.display = admOn ? '' : 'none';
        dlBody.appendChild(makeRow('Apple Digital Masters',
            makeIOSToggle(admOn, v => {
                window.amlBridge?.setTweak('adm-enabled', v);
                admInpRow.style.display = v ? '' : 'none';
            }),
            'Add [M] to filenames of tracks mastered for Apple Music', false));
        dlBody.appendChild(admInpRow);

        // Playlist metadata
        dlBody.appendChild(makeRow('Playlist metadata',
            makeIOSToggle(!!(prefs['use-songinfo-for-playlist']), v =>
                window.amlBridge?.setTweak('use-songinfo-for-playlist', v)),
            'Use original album track number and album name instead of playlist position when downloading a playlist',
            true));

        // ── Queue ────────────────────────────────────────────────────────────
        dlBody.appendChild(dlSubhead('Queue'));

        // Retry on fail toggle
        const retryToggle = makeIOSToggle(!!(prefs['retry-on-fail'] !== false), v => window.amlBridge?.setTweak('retry-on-fail', v));
        dlBody.appendChild(makeRow('Retry on fail', retryToggle, 'Automatically retry a failed download', false));

        // Retry timeout dropdown
        const RETRY_TIMEOUT_OPTS = [
            { value: 15,  label: '15 seconds' },
            { value: 30,  label: '30 seconds' },
            { value: 60,  label: '1 minute' },
            { value: 300, label: '5 minutes' },
        ];
        const { wrap: retryToDd } = dlDropdown(RETRY_TIMEOUT_OPTS, parseInt(prefs['retry-timeout'] ?? '30', 10),
            v => window.amlBridge?.setTweak('retry-timeout', parseInt(v, 10)));
        dlBody.appendChild(makeRow('Retry after', retryToDd, null, false));

        dlg.appendChild(dlWrap);

        // ── History section ────────────────────────────────────────────────────
        const { wrap: histWrap, body: histBody } = makeSection('History');
        const histEnabledRaw = await window.amlBridge?.storeRead('historyEnabled').catch(() => null);
        const histIsEnabled = histEnabledRaw !== 'false' && histEnabledRaw !== false;
        const histToggle = makeIOSToggle(histIsEnabled, async (v) => {
            _histEnabled = v;
            await window.amlBridge?.storeWrite('historyEnabled', String(v)).catch(() => {});
            _histInject();
        });
        histBody.appendChild(makeRow('Show in Up Next panel', histToggle, 'Display recently played tracks above the queue', false));
        const histClearRow = document.createElement('div');
        histClearRow.style.cssText = 'padding:10px 0;display:flex;gap:6px;';
        const histClearBtn = makeBtn('Clear History');
        histClearBtn.onclick = () => { _histClear(); openSettings(); };
        histClearRow.appendChild(histClearBtn);
        histBody.appendChild(histClearRow);
        dlg.appendChild(histWrap);

        // ── Developer section ──────────────────────────────────────────────────
        const { wrap: devWrap, body: devBody } = makeSection('Developer');
        const debugToggle = document.createElement('input');
        debugToggle.type = 'checkbox';
        debugToggle.checked = !!(prefs.debug);
        debugToggle.style.cssText = 'width:16px;height:16px;accent-color:#fc3c44;cursor:pointer;';
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

    // ── Settings cog + downloads button next to account row ───────────────
    // Apple SF Symbols–style gearshape.fill — 8-tooth gear with circular centre hole
    const COG_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%" style="display:block;padding:17%"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.05-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;
    // Apple Music Android ic_swipe_download — bold solid downward arrow
    const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%" style="display:block;padding:19%"><path d="M11.9952,21.1159C12.3277,21.1159 12.6697,20.9829 12.8977,20.7359L19.12,14.5136C19.3765,14.2571 19.5,13.9531 19.5,13.6396C19.5,12.9462 19.006,12.4522 18.341,12.4522C17.9801,12.4522 17.6856,12.6042 17.4671,12.8322L15.3011,14.9791L13.1352,17.4395L13.2112,15.3781L13.2112,4.254C13.2112,3.5035 12.7172,3 11.9952,3C11.2733,3 10.7793,3.5035 10.7793,4.254L10.7793,15.3781L10.8648,17.4395L8.6894,14.9791L6.5329,12.8322C6.3049,12.6042 6.0199,12.4522 5.659,12.4522C4.994,12.4522 4.5,12.9462 4.5,13.6396C4.5,13.9531 4.6235,14.2571 4.88,14.5136L11.0928,20.7359C11.3303,20.9829 11.6628,21.1159 11.9952,21.1159Z"/></svg>`;

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
        const szN = Math.max(avatarSize, 28);
        const sz = szN + 'px';

        function makeNavBtn(id, title, svg, rightPx) {
            const btn = document.createElement('button');
            btn.id = id;
            btn.title = title;
            btn.innerHTML = svg;
            btn.style.cssText = [
                'position:absolute',
                `right:${rightPx}px`,
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
            btn.onmouseenter = () => { btn.style.background = 'rgba(255,255,255,0.20)'; btn.style.color = 'rgba(255,255,255,0.9)'; };
            btn.onmouseleave = () => { btn.style.background = 'rgba(255,255,255,0.10)'; btn.style.color = 'rgba(255,255,255,0.55)'; };
            return btn;
        }

        // Make parent relative so absolute positioning works
        const parent = accountRow.closest('li, [class*="account"], [class*="Account"]') || accountRow;
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

        const gap = 8;
        const cog = makeNavBtn('aml-settings-cog', 'AML Settings', COG_SVG, 10);
        cog.onclick = (e) => { e.stopPropagation(); openSettings(); };

        const dlBtn = makeNavBtn('aml-downloads-btn', 'Downloads', DOWNLOAD_SVG, 10 + szN + gap);
        dlBtn.onclick = (e) => { e.stopPropagation(); window.__amlToggleDownloads?.(); };

        parent.appendChild(cog);
        parent.appendChild(dlBtn);
    }

    // Watch the entire document so the cog re-mounts after SPA navigation
    // replaces the sidebar (observing only parent misses parent-level removals).
    const cogWatcher = new MutationObserver(() => {
        if (findAccountRow() && (!document.getElementById('aml-settings-cog') || !document.getElementById('aml-downloads-btn'))) mountSettingsCog();
    });
    if (findAccountRow()) mountSettingsCog();
    cogWatcher.observe(document.documentElement, { childList: true, subtree: true });

    window.__amlOpenEngineSettings = openSettings;

    // Kill gradient/vignette overlay elements that CSS selectors miss
})();

// ── Downloads: context menu injection + panel + export API ────────────────────
(function initAMLDownloads() {
    // ── SVG icon injection — direct DOM + per-container observer ─────────────
    // Never mutate button title/text (breaks Glimmer's VDOM reconciliation).
    // Instead: inject our <svg> as a sibling inside the icon container, hide
    // Apple's native svg via inline style, and re-inject immediately if Glimmer
    // blows our node away.  CSS handles the "Copy Embed Code → Download" rename
    // via ::before so the real title attribute stays untouched.

    const PIN_PATH   = 'M12.219,22.208C12.281,22.208 12.361,22.137 12.46,21.994C12.558,21.851 12.658,21.664 12.758,21.432C12.859,21.199 12.943,20.945 13.012,20.668C13.08,20.391 13.115,20.119 13.115,19.853L13.115,15.075L11.32,15.075L11.32,19.853C11.32,20.119 11.353,20.391 11.421,20.668C11.489,20.945 11.573,21.199 11.674,21.432C11.776,21.664 11.876,21.851 11.975,21.994C12.073,22.137 12.155,22.208 12.219,22.208ZM6.926,15.874L17.506,15.874C17.919,15.874 18.249,15.753 18.496,15.512C18.744,15.271 18.868,14.951 18.868,14.553C18.868,13.91 18.7,13.287 18.364,12.684C18.028,12.082 17.558,11.543 16.953,11.067C16.349,10.59 15.644,10.211 14.838,9.93C14.032,9.649 13.159,9.508 12.219,9.508C11.278,9.508 10.405,9.649 9.597,9.93C8.789,10.211 8.084,10.59 7.481,11.067C6.878,11.543 6.408,12.082 6.07,12.684C5.733,13.287 5.564,13.91 5.564,14.553C5.564,14.951 5.689,15.271 5.938,15.512C6.187,15.753 6.517,15.874 6.926,15.874ZM7.35,14.334C7.202,14.334 7.141,14.248 7.167,14.078C7.22,13.709 7.379,13.342 7.644,12.978C7.909,12.613 8.264,12.282 8.709,11.985C9.153,11.687 9.671,11.449 10.264,11.27C10.856,11.091 11.508,11.001 12.219,11.001C12.926,11.001 13.576,11.091 14.169,11.27C14.762,11.449 15.281,11.687 15.724,11.985C16.168,12.282 16.523,12.613 16.789,12.978C17.055,13.342 17.214,13.709 17.267,14.078C17.293,14.248 17.231,14.334 17.082,14.334L7.35,14.334ZM6.621,3.2C6.621,3.503 6.737,3.802 6.97,4.097C7.109,4.28 7.304,4.483 7.556,4.707C7.808,4.93 8.096,5.163 8.418,5.406C8.741,5.648 9.082,5.89 9.441,6.131L9.129,10.756L10.749,10.756L11.064,5.425C11.071,5.278 11.021,5.176 10.912,5.118C10.66,4.985 10.424,4.852 10.202,4.718C9.981,4.583 9.783,4.456 9.607,4.335C9.431,4.215 9.284,4.107 9.166,4.013C9.048,3.918 8.965,3.847 8.919,3.799C8.884,3.754 8.875,3.716 8.893,3.684C8.911,3.651 8.941,3.635 8.984,3.635L15.45,3.635C15.491,3.635 15.52,3.651 15.538,3.684C15.556,3.716 15.549,3.754 15.515,3.799C15.467,3.847 15.385,3.918 15.269,4.013C15.152,4.107 15.006,4.215 14.83,4.335C14.654,4.456 14.456,4.583 14.233,4.718C14.011,4.852 13.773,4.985 13.519,5.118C13.413,5.176 13.365,5.278 13.376,5.425L13.683,10.756L15.305,10.756L14.99,6.131C15.351,5.89 15.694,5.648 16.019,5.406C16.343,5.163 16.63,4.93 16.88,4.707C17.129,4.483 17.323,4.28 17.461,4.097C17.698,3.802 17.817,3.503 17.817,3.2C17.817,2.907 17.714,2.665 17.507,2.474C17.301,2.282 17.036,2.186 16.711,2.186L7.726,2.186C7.398,2.186 7.131,2.282 6.927,2.474C6.723,2.665 6.621,2.907 6.621,3.2Z';
    const TRASH_PATH = 'M16.4187,22.4626C17.571,22.4626 18.2679,21.8214 18.3144,20.6691L18.9091,7.0924L20.303,7.0924C20.684,7.0924 21,6.7672 21,6.3862C21,6.0052 20.684,5.6892 20.303,5.6892L16.1585,5.6892L16.1585,4.2674C16.1585,2.8642 15.2385,2 13.7517,2L10.2297,2C8.7429,2 7.8229,2.8642 7.8229,4.2674L7.8229,5.6892L3.697,5.6892C3.3252,5.6892 3,6.0052 3,6.3862C3,6.7765 3.3252,7.0924 3.697,7.0924L5.1002,7.0924L5.6949,20.6691C5.7414,21.8214 6.4383,22.4626 7.5813,22.4626L16.4187,22.4626ZM14.4858,5.6892L9.5049,5.6892L9.5049,4.3604C9.5049,3.8957 9.8301,3.5798 10.332,3.5798L13.6588,3.5798C14.1606,3.5798 14.4858,3.8957 14.4858,4.3604L14.4858,5.6892ZM9.0589,19.8049C8.7243,19.8049 8.492,19.5911 8.4827,19.2566L8.1946,9.1368C8.1853,8.8116 8.4177,8.5885 8.7801,8.5885C9.1053,8.5885 9.3469,8.8023 9.3562,9.1275L9.635,19.2566C9.6443,19.5818 9.412,19.8049 9.0589,19.8049ZM12.0046,19.8049C11.6515,19.8049 11.4006,19.5818 11.4006,19.2566L11.4006,9.1368C11.4006,8.8116 11.6515,8.5885 12.0046,8.5885C12.3578,8.5885 12.5994,8.8116 12.5994,9.1368L12.5994,19.2566C12.5994,19.5818 12.3578,19.8049 12.0046,19.8049ZM14.9411,19.8049C14.588,19.8049 14.3557,19.5818 14.365,19.2566L14.6438,9.1368C14.6531,8.8023 14.8947,8.5885 15.2199,8.5885C15.5731,8.5885 15.8147,8.8116 15.8054,9.1368L15.5173,19.2566C15.508,19.5911 15.2757,19.8049 14.9411,19.8049Z';
    const DL_PATH    = 'M11.9952,21.1159C12.3277,21.1159 12.6697,20.9829 12.8977,20.7359L19.12,14.5136C19.3765,14.2571 19.5,13.9531 19.5,13.6396C19.5,12.9462 19.006,12.4522 18.341,12.4522C17.9801,12.4522 17.6856,12.6042 17.4671,12.8322L15.3011,14.9791L13.1352,17.4395L13.2112,15.3781L13.2112,4.254C13.2112,3.5035 12.7172,3 11.9952,3C11.2733,3 10.7793,3.5035 10.7793,4.254L10.7793,15.3781L10.8648,17.4395L8.6894,14.9791L6.5329,12.8322C6.3049,12.6042 6.0199,12.4522 5.659,12.4522C4.994,12.4522 4.5,12.9462 4.5,13.6396C4.5,13.9531 4.6235,14.2571 4.88,14.5136L11.0928,20.7359C11.3303,20.9829 11.6628,21.1159 11.9952,21.1159Z';

    // Build inline SVG strings (no URL-encoding needed — straight DOM injection).
    const mkSvg = (path, transform) => {
        const inner = transform ? `<g transform="${transform}"><path d="${path}"/></g>` : `<path d="${path}"/>`;
        return `<svg viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg" width="16" height="16" style="display:block;flex-shrink:0">${inner}</svg>`;
    };
    const _PIN  = mkSvg(PIN_PATH,   'rotate(-45 12 12)');
    const _TRASH = mkSvg(TRASH_PATH, '');
    const ICON_SVG = {
        'Pin Album':             _PIN,
        'Unpin Album':           _PIN,
        'Pin Music Video':       _PIN,
        'Unpin Music Video':     _PIN,
        'Pin Song':              _PIN,
        'Unpin Song':            _PIN,
        'Pin Playlist':          _PIN,
        'Unpin Playlist':        _PIN,
        'Delete from Library':   _TRASH,
        'Remove from Library':   _TRASH,
        'Copy Embed Code':       mkSvg(DL_PATH, ''),
    };

    // One-time CSS: hides Apple's native SVGs and renames "Copy Embed Code".
    // All hiding is CSS-only so we never touch Glimmer-managed element styles
    // (inline style mutations on Glimmer nodes trigger its reconciler and can
    // drop orphan <li> nodes into the menu list).
    ;(function injectContextMenuCSS() {
        if (document.getElementById('aml-ctx-icons')) return;
        // Build FULL selectors (including descendant) inside the map — joining
        // comma-separated parent-only selectors then appending a descendant
        // suffix only attaches it to the last item, making earlier items match
        // the bare li and get the rule applied to the entire row.
        const li = t => `li.contextual-menu-item:has(button[title='${t}'])`;
        const con = t => `${li(t)} .contextual-menu-item__icon-container`;
        const svg = t => `${con(t)} > svg`;

        const PIN_TITLES   = ['Pin Album','Unpin Album','Pin Music Video','Unpin Music Video','Pin Song','Unpin Song','Pin Playlist','Unpin Playlist'];
        const TRASH_TITLES = ['Delete from Library','Remove from Library'];
        const EMBED_TITLE  = 'Copy Embed Code';

        const ALL_CON = [...PIN_TITLES, ...TRASH_TITLES, EMBED_TITLE].map(con).join(',\n');
        const ALL_SVG = [...PIN_TITLES, ...TRASH_TITLES, EMBED_TITLE].map(svg).join(',\n');
        const EMBED_LI  = li(EMBED_TITLE);
        const EMBED_CON = con(EMBED_TITLE);

        const s = document.createElement('style');
        s.id = 'aml-ctx-icons';
        s.textContent = `
/* position:relative so our absolute span is clipped to the container */
${ALL_CON} { position:relative !important; }

/* hide Apple's SVG via CSS — never touch inline styles on Glimmer elements */
${ALL_SVG} { opacity:0 !important; }

/* rename "Copy Embed Code" → "Download" purely via CSS */
${EMBED_LI} .contextual-menu-item__option-text { font-size:0 !important; }
${EMBED_LI} .contextual-menu-item__option-text::before { content:'Download'; font-size:13px !important; }`;
        document.head.appendChild(s);
    })();

    // Inject our SVG into one icon container and set up a guard observer that
    // re-injects the moment Glimmer replaces the container's children.
    // We NEVER mutate Apple's existing elements — CSS handles hiding the native SVG.
    function _armContainer(container, svgHtml) {
        if (container._amlArmed) return;
        container._amlArmed = true;

        const inject = () => {
            if (container.querySelector('[data-aml]')) return;
            const span = document.createElement('span');
            span.setAttribute('data-aml', '1');
            span.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;';
            span.innerHTML = svgHtml;
            container.appendChild(span);
        };

        inject();

        // Re-inject after every Glimmer reconciliation pass on this container.
        const obs = new MutationObserver(() => {
            obs.disconnect();
            inject();
            obs.observe(container, { childList: true, subtree: true });
        });
        obs.observe(container, { childList: true, subtree: true });
    }

    // Walk every button in `menu` and arm matching icon containers.
    function injectMenuIcons(menu) {
        if (!menu) return;
        menu.querySelectorAll('button').forEach(btn => {
            const title = btn.title
                || btn.querySelector('.contextual-menu-item__option-text')?.textContent?.trim()
                || '';
            const svgHtml = ICON_SVG[title];
            if (!svgHtml) return;
            // Container may be inside the button OR elsewhere in the same li.
            const container = btn.querySelector('.contextual-menu-item__icon-container')
                || btn.closest('li')?.querySelector('.contextual-menu-item__icon-container');
            if (container) _armContainer(container, svgHtml);
        });
    }

    // ── Capture contextmenu target for track resolution ────────────────────
    // mousedown captures ⋯ button clicks (no contextmenu event); contextmenu
    // covers right-click. Both update _ctxTarget before the menu opens.
    // Guard: don't overwrite _ctxTarget when the click is inside amp-contextual-menu
    // itself — that would replace the song element with the Download button.
    let _ctxTarget = null;
    document.addEventListener('mousedown', e => {
        if (!e.target.closest('amp-contextual-menu')) _ctxTarget = e.target;
    }, true);
    document.addEventListener('contextmenu', e => { _ctxTarget = e.target; }, true);

    function _parseAMHref(href) {
        if (!href || !href.includes('music.apple.com')) return null;
        const sfM = href.match(/\/([a-z]{2,3})\//);
        const sf  = sfM?.[1] || 'us';
        // Song in album: ?i=catalogId
        const songM = href.match(/[?&]i=(\d+)/);
        if (songM) return { type: 'song', id: songM[1], storefront: sf };
        // Direct song page: /song/name/id
        const songD = href.match(/\/song\/[^/?#]+\/(\d+)/);
        if (songD) return { type: 'song', id: songD[1], storefront: sf };
        // Music video: /music-video/name/id
        const mvM = href.match(/\/music-video\/[^/?#]+\/(\d+)/);
        if (mvM) return { type: 'video', id: mvM[1], storefront: sf };
        // Playlist: /playlist/name/pl.xxx
        const plM = href.match(/\/playlist\/[^/?#]+(\/pl\.[a-f0-9]+)/i);
        if (plM) return { type: 'playlist', id: plM[1].slice(1), storefront: sf };
        // Library playlist: /library/playlists/p.xxx  (user's personal playlists)
        const libPlM = href.match(/\/library\/playlists\/(p\.[A-Za-z0-9]+)/);
        if (libPlM) return { type: 'playlist', id: libPlM[1], storefront: sf, isLibrary: true };
        // Album: /album/name/id
        const albumM = href.match(/\/album\/[^/?#]+\/(\d+)/);
        if (albumM) return { type: 'album', id: albumM[1], storefront: sf };
        return null;
    }

    // Ask the open amp-contextual-menu for the authoritative URL by intercepting
    // its "Copy Link" action before the clipboard write completes.
    // Returns the URL string, or null if "Copy Link" isn't present or times out.
    // This is more reliable than DOM walking because Apple's code already knows
    // exactly which item was right-clicked, regardless of whether the row has an <a> tag.
    function _resolveViaMenuLink(menuNode) {
        return new Promise(resolve => {
            const copyBtn = Array.from(menuNode.querySelectorAll('button')).find(b => {
                const t = b.querySelector('.contextual-menu-item__option-text')?.textContent?.trim()
                    || b.title || b.getAttribute('aria-label') || '';
                return t === 'Copy Link';
            });
            if (!copyBtn) return resolve(null);

            const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
            const timer = setTimeout(() => {
                navigator.clipboard.writeText = orig;
                resolve(null);
            }, 1000);

            navigator.clipboard.writeText = async text => {
                clearTimeout(timer);
                navigator.clipboard.writeText = orig;
                resolve(text);
                // Do NOT write to clipboard — this is an internal URL extraction,
                // not a user-initiated copy. Reject so Apple's copied UI doesn't fire.
                return Promise.reject(new DOMException('', 'NotAllowedError'));
            };

            copyBtn.click();
        });
    }

    function resolveTrackInfo(target) {
        // The ⋯ button and its catalog <a> are siblings, not ancestor/descendant.
        // Walk up parent chain; at each level also search children for catalog links.
        let el = target;
        for (let i = 0; i < 25 && el && el !== document.body; i++) {
            // Check the element itself
            const directHref = el.href || el.getAttribute?.('href') || '';
            if (directHref) {
                const info = _parseAMHref(directHref);
                if (info) return info;
            }
            // Search within this ancestor for any catalog link (catches sibling <a>)
            const childLink = el.querySelector?.('a[href*="music.apple.com"]');
            if (childLink) {
                const info = _parseAMHref(childLink.href);
                if (info) return info;
            }
            el = el.parentElement;
        }
        // Fallback: page URL (works when on an album/song detail page)
        return _parseAMHref(location.href);
    }

    // Try to find metadata for an ID in the MusicKit queue/nowPlaying (synchronous).
    function _mkMetaForId(id) {
        try {
            const mk = window.MusicKit?.getInstance?.();
            const candidates = [mk?.nowPlayingItem, ...(mk?.queue?.items || [])].filter(Boolean);
            for (const item of candidates) {
                const pid = String(item.id || item.attributes?.playParams?.id || '');
                if (pid === String(id)) {
                    return {
                        title:   item.attributes?.name        || '',
                        artist:  item.attributes?.artistName  || '',
                        artwork: item.attributes?.artwork?.url || '',
                    };
                }
            }
        } catch (_) {}
        return null;
    }

    // ── Post a download job to the engine ─────────────────────────────────
    async function startDownload(info) {
        if (!info) { console.warn('[AML] startDownload: no track info'); return; }
        const mk = window.MusicKit?.getInstance?.();
        const prefs = await window.amlBridge?.getPrefs().catch(() => ({})) || {};
        const qual = prefs['downloads-quality'] || _downloadsQuality || 'lossless';
        const isLossless = qual !== 'high-quality';

        // Pre-fetch metadata so the download row shows title/artwork immediately.
        // Try MusicKit first (synchronous), then engine catalog (async, ~200-400ms).
        let hintTitle = '', hintArtist = '', hintArtwork = '';
        const mkMeta = _mkMetaForId(info.id);
        if (mkMeta && mkMeta.title) {
            hintTitle = mkMeta.title; hintArtist = mkMeta.artist; hintArtwork = mkMeta.artwork;
        } else {
            try {
                const sf = encodeURIComponent(info.storefront || 'us');
                const meta = await fetch(`${ENGINE}/api/v1/metadata/${info.id}?sf=${sf}`, {
                    signal: AbortSignal.timeout(6000),
                }).then(r => r.ok ? r.json() : null).catch(() => null);
                if (meta) {
                    hintTitle   = meta.title      || '';
                    hintArtist  = meta.artistName || '';
                    hintArtwork = meta.artworkUrl || '';
                }
            } catch (_) {}
        }

        // Build combined filename template from saved folder + song parts
        const _af = prefs['download-album-folder'] || '{album_artist}/{album}';
        const _sf = prefs['download-song-file']    || '{track_number:02d} - {title}';
        const filenameTemplate = `${_af}/${_sf}`;

        const body = {
            AssetID:          info.id,
            Storefront:       info.storefront,
            Token:            mk?.developerToken || '',
            MUT:              mk?.musicUserToken  || '',
            Language:         navigator.language || 'en-US',
            Capabilities: {
                Lossless:        isLossless,
                Atmos:           false,
                Video:           info.type === 'video',
                Playlist:        info.type === 'playlist',
                LibraryPlaylist: !!(info.isLibrary),
            },
            MVMaxHeight:  parseInt(prefs['mv-max-height'] ?? '0', 10) || 0,
            OutputDir:        prefs['download-dir'] || '',
            FilenameTemplate: filenameTemplate,
            Options: {
                EmbedArtwork:  prefs['embed-artwork']   !== false,
                ArtworkSize:   parseInt(prefs['artwork-size'] || '3000', 10),
                EmbedLyrics:   prefs['embed-lyrics']    !== false,
                LrcType:       prefs['lyrics-type']     || 'lyrics',
                LrcFormat:     prefs['lyrics-format']   || 'lrc',
                SaveLrcSidecar: !!(prefs['save-lrc-sidecar']),
                OverwritePolicy: prefs['download-overwrite'] || 'skip',
                ConvertToFLAC: !!(prefs['convert-to-flac']),
                FFmpegPath:    prefs['ffmpeg-path'] || '',
                KeepOriginal:  !!(prefs['keep-original']),
                ExplicitChoice: prefs['explicit-enabled'] !== false ? (prefs['explicit-marker'] || '[E]') : '',
                CleanChoice:    prefs['clean-enabled']              ? (prefs['clean-marker']    || '[C]') : '',
                MasterChoice:   prefs['adm-enabled']    !== false   ? (prefs['adm-marker']      || '[M]') : '',
            },
            HintTitle:   hintTitle,
            HintArtist:  hintArtist,
            HintArtwork: hintArtwork,
        };

        try {
            const res = await fetch(`${ENGINE}/api/v1/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(`engine ${res.status}`);
            const job = await res.json();
            openDownloadsPanel();
            return job;
        } catch (e) {
            console.error('[AML] download error:', e);
        }
    }

    // ── Context menu injection ─────────────────────────────────────────────
    // Icons: CSS pseudo-elements in #aml-ctx-icons (Glimmer-proof, no DOM writes).
    // Download: rename text+title on every render; click handled by delegation on
    // the amp-contextual-menu node so Glimmer button replacement can't remove it.

    // Clamp any open submenu lists to stop just above the player bar (72 px from bottom).
    // Targets ul.contextual-menu__list so the container div keeps its border/shadow intact.
    function clampSubmenus(root) {
        const PLAYER_BAR_H = 72;
        const maxBottom = window.innerHeight - PLAYER_BAR_H;
        root.querySelectorAll(
            'div.contextual-menu.contextual-menu--nested, div.contextual-menu.contextual-menu--in-submenu'
        ).forEach(sub => {
            const list = sub.querySelector('ul.contextual-menu__list');
            if (!list) return;
            const top = sub.getBoundingClientRect().top;
            if (top <= 0) return; // not yet positioned — skip
            const available = maxBottom - top - 10; // 10 px breathing room above bar
            if (available > 0) {
                list.style.setProperty('max-height', `${available}px`, 'important');
                list.style.setProperty('overflow-y', 'auto', 'important');
            }
        });
    }

    // Watch body (childList only, no subtree) for amp-contextual-menu insertion.
    // Apple creates it fresh per open (both ⋯ click and right-click) as a direct body child.
    const _menuObservers = new Map();

    new MutationObserver(muts => {
        for (const m of muts) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1 || node.tagName !== 'AMP-CONTEXTUAL-MENU') continue;

                // Event delegation: one listener on the stable amp-contextual-menu node.
                // Survives all Glimmer button replacements. Title stays 'Copy Embed Code'
                // (we never mutate it), so check for both names for robustness.
                node.addEventListener('click', async e => {
                    const btn = e.target.closest('button');
                    if (!btn) return;
                    const title = btn.title || btn.querySelector('.contextual-menu-item__option-text')?.textContent?.trim() || '';
                    if (title !== 'Download' && title !== 'Copy Embed Code' && !title.includes('Embed Code')) return;
                    e.stopPropagation();
                    e.preventDefault();

                    // Get authoritative URL from Apple's "Copy Link" action in the same menu.
                    // This bypasses DOM walking and handles artist-page top songs, library items,
                    // and any context where the row has no direct <a href> to the song.
                    let trackInfo = null;
                    try {
                        const clipUrl = await _resolveViaMenuLink(node);
                        if (clipUrl) trackInfo = _parseAMHref(clipUrl);
                    } catch (_) {}

                    // Fallback: DOM walk (works on album/song detail pages with direct links).
                    if (!trackInfo) trackInfo = resolveTrackInfo(_ctxTarget);

                    document.body.click(); // close menu (may already be closed by Copy Link click)
                    if (trackInfo) startDownload(trackInfo);
                }, true);

                const inner = new MutationObserver(() => {
                    injectMenuIcons(node.querySelector('.contextual-menu'));
                    clampSubmenus(node);
                });
                inner.observe(node, { childList: true, subtree: true });
                _menuObservers.set(node, inner);
                // Initial injection — buttons may not be in DOM yet; retry once after paint.
                setTimeout(() => injectMenuIcons(node.querySelector('.contextual-menu')), 80);
            }
            for (const node of m.removedNodes) {
                if (node.nodeType !== 1 || node.tagName !== 'AMP-CONTEXTUAL-MENU') continue;
                const obs = _menuObservers.get(node);
                if (obs) { obs.disconnect(); _menuObservers.delete(node); }
            }
        }
    }).observe(document.body, { childList: true });

    // ── Downloads panel ────────────────────────────────────────────────────
    let _panelEl   = null;
    // Inject download panel CSS once
    if (!document.getElementById('aml-dl-kf')) {
        const _kfs = document.createElement('style');
        _kfs.id = 'aml-dl-kf';
        _kfs.textContent = `
@keyframes aml-dl-pulse{0%,100%{opacity:0.55}50%{opacity:1}}
@keyframes aml-dl-dot{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes aml-dl-skel{0%{opacity:.4}50%{opacity:.8}100%{opacity:.4}}
.aml-dl-pill{display:inline-flex;align-items:center;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.1px;flex-shrink:0}
.aml-dl-pill-q{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.38)}
.aml-dl-pill-r{background:rgba(255,214,10,0.13);color:rgba(255,210,80,0.85)}
.aml-dl-pill-dl{background:rgba(255,255,255,0.10);color:rgba(255,255,255,0.60)}
.aml-dl-pill-ok{background:rgba(48,209,88,0.14);color:#30d158}
.aml-dl-pill-err{background:rgba(255,69,58,0.15);color:#ff453a}
.aml-dl-pill-x{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.25)}
.aml-dl-skel-line{border-radius:3px;background:rgba(255,255,255,0.10);animation:aml-dl-skel 1.4s ease-in-out infinite}
.aml-dl-art-skel{background:linear-gradient(135deg,rgba(255,255,255,0.08) 0%,rgba(255,255,255,0.04) 100%);animation:aml-dl-skel 1.4s ease-in-out infinite}`;
        document.head.appendChild(_kfs);
    }

    let _pollTimer      = null;
    let _countdownTimer = null; // 1-s ticker to refresh auto-retry countdown labels
    const _failedAt = new Map(); // jobId → { timer, deadline }

    function openDownloadsPanel() {
        if (!_panelEl) _panelEl = buildDownloadsPanel();
        if (!document.body.contains(_panelEl)) document.body.appendChild(_panelEl);
        _panelEl.style.display = 'flex';
        startPolling();
    }

    function closeDownloadsPanel() {
        if (_panelEl) _panelEl.style.display = 'none';
        stopPolling();
    }

    window.__amlToggleDownloads = () => {
        if (!_panelEl || _panelEl.style.display === 'none') openDownloadsPanel();
        else closeDownloadsPanel();
    };

    function _sidebarWidth() {
        const nav = document.querySelector('nav.navigation') ||
                    document.querySelector('[class*="web-navigation"]') ||
                    document.querySelector('.side-panel');
        const w = nav ? nav.offsetWidth : 0;
        return w > 160 ? w : 240;
    }

    function buildDownloadsPanel() {
        const panel = document.createElement('div');
        panel.id = 'aml-downloads-panel';
        panel.style.cssText = [
            'position:fixed',
            'bottom:72px',
            'left:8px',
            'width:320px',
            'max-height:520px',
            'background:rgba(24,24,26,0.92)',
            'backdrop-filter:blur(40px) saturate(1.8)',
            '-webkit-backdrop-filter:blur(40px) saturate(1.8)',
            'border:0.5px solid rgba(255,255,255,0.12)',
            'border-radius:14px',
            'box-shadow:0 16px 48px rgba(0,0,0,0.75),0 1px 0 rgba(255,255,255,0.06) inset',
            'z-index:99999',
            'display:flex',
            'flex-direction:column',
            'overflow:hidden',
            'font-family:-apple-system,SF Pro Text,system-ui,sans-serif',
        ].join(';');

        // Header
        const hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:15px 16px 13px;border-bottom:0.5px solid rgba(255,255,255,0.09);flex-shrink:0;gap:8px;';

        const titleGroup = document.createElement('div');
        titleGroup.style.cssText = 'display:flex;align-items:baseline;gap:8px;flex:1;min-width:0;';
        const title = document.createElement('span');
        title.textContent = 'Downloads';
        title.style.cssText = 'color:#fff;font-size:15px;font-weight:600;letter-spacing:-0.3px;';
        const countBadge = document.createElement('span');
        countBadge.id = 'aml-dl-count';
        countBadge.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.30);font-weight:400;display:none;';
        titleGroup.append(title, countBadge);

        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0;';

        const clearBtn = document.createElement('button');
        clearBtn.id = 'aml-dl-cleardone';
        clearBtn.textContent = 'Clear done';
        clearBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.32);cursor:pointer;font-size:12px;padding:3px 7px;border-radius:5px;transition:color 0.15s,background 0.15s;display:none;';
        clearBtn.onmouseenter = () => { clearBtn.style.color = 'rgba(255,255,255,0.75)'; clearBtn.style.background = 'rgba(255,255,255,0.07)'; };
        clearBtn.onmouseleave = () => { clearBtn.style.color = 'rgba(255,255,255,0.32)'; clearBtn.style.background = 'none'; };
        clearBtn.onclick = clearDoneJobs;

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="currentColor" width="14" height="14"><path d="M1.4 1.4a1 1 0 0 1 1.414 0L7 5.586l4.186-4.186a1 1 0 1 1 1.414 1.414L8.414 7l4.186 4.186a1 1 0 1 1-1.414 1.414L7 8.414 2.814 12.6A1 1 0 0 1 1.4 11.186L5.586 7 1.4 2.814A1 1 0 0 1 1.4 1.4z"/></svg>`;
        closeBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.40);cursor:pointer;padding:4px;display:flex;align-items:center;border-radius:50%;transition:color 0.15s,background 0.15s;';
        closeBtn.onmouseenter = () => { closeBtn.style.color = '#fff'; closeBtn.style.background = 'rgba(255,255,255,0.10)'; };
        closeBtn.onmouseleave = () => { closeBtn.style.color = 'rgba(255,255,255,0.40)'; closeBtn.style.background = 'none'; };
        closeBtn.onclick = closeDownloadsPanel;

        btnGroup.append(clearBtn, closeBtn);
        hdr.append(titleGroup, btnGroup);
        panel.appendChild(hdr);

        // Job list
        const list = document.createElement('div');
        list.id = 'aml-downloads-list';
        list.style.cssText = 'flex:1;overflow-y:auto;padding:6px 0;';
        panel.appendChild(list);

        return panel;
    }

    function renderJobs(jobs) {
        const list = document.getElementById('aml-downloads-list');
        if (!list) return;

        const countEl = document.getElementById('aml-dl-count');
        const clearEl = document.getElementById('aml-dl-cleardone');

        if (!jobs?.length) {
            list.innerHTML = '';
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:44px 20px;text-align:center;color:rgba(255,255,255,0.28);font-size:12.5px;letter-spacing:-0.1px;';
            empty.textContent = 'No downloads yet';
            list.appendChild(empty);
            if (countEl) { countEl.textContent = ''; countEl.style.display = 'none'; }
            if (clearEl) clearEl.style.display = 'none';
            return;
        }

        // Update count badge
        const active = jobs.filter(j => j.phase !== 'done' && j.phase !== 'failed' && j.phase !== 'cancelled').length;
        const done   = jobs.filter(j => j.phase === 'done' || j.phase === 'failed' || j.phase === 'cancelled').length;
        if (countEl) {
            countEl.textContent = active > 0 ? `${active} active` : `${jobs.length}`;
            countEl.style.display = '';
        }
        if (clearEl) clearEl.style.display = done > 0 ? '' : 'none';

        // FIFO order — sort by createdAt ascending (enqueue order = artist/playlist order)
        jobs.sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0));

        // Remove rows for jobs that no longer exist
        const newIds = new Set(jobs.map(j => j.jobId));
        list.querySelectorAll('[data-job-id]').forEach(el => {
            if (!newIds.has(el.dataset.jobId)) el.remove();
        });

        // Update existing rows in-place; insert new rows at the correct sorted position.
        // Existing rows are NEVER moved — that causes visible jumping on every poll tick.
        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            let row = list.querySelector(`[data-job-id="${job.jobId}"]`);
            if (row) {
                updateJobRow(row, job);
            } else {
                row = buildJobRow(job);
                // Find the first already-rendered row that belongs after this one
                let anchor = null;
                for (let j = i + 1; j < jobs.length; j++) {
                    anchor = list.querySelector(`[data-job-id="${jobs[j].jobId}"]`);
                    if (anchor) break;
                }
                list.insertBefore(row, anchor); // anchor=null → appendChild
            }
        }

        // Auto-retry failed jobs after the configured timeout
        const retryEnabled = prefs['retry-on-fail'] !== false;
        const retryDelay   = (parseInt(prefs['retry-timeout'] ?? '30', 10) || 30) * 1000;
        for (const job of jobs) {
            if (job.phase === 'failed' && retryEnabled) {
                if (!_failedAt.has(job.jobId)) {
                    const deadline = Date.now() + retryDelay;
                    const t = setTimeout(() => {
                        _failedAt.delete(job.jobId);
                        retryJob(job.jobId);
                    }, retryDelay);
                    _failedAt.set(job.jobId, { timer: t, deadline });
                }
            } else {
                const entry = _failedAt.get(job.jobId);
                if (entry !== undefined) { clearTimeout(entry.timer); _failedAt.delete(job.jobId); }
            }
        }
    }

    const PHASE_LABEL = {
        queued:      'Queued',
        resolving:   'Resolving…',
        downloading: 'Downloading',
        tagging:     'Tagging…',
        moving:      'Saving…',
        done:        'Done',
        failed:      'Failed',
        cancelled:   'Cancelled',
    };

    function _fmtBytes(n) {
        if (!n) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
        return (n / 1073741824).toFixed(2) + ' GB';
    }

    function _artThumb(url, size) {
        if (!url) return '';
        return url.replace('{w}', size).replace('{h}', size);
    }

    const PILL_CLASS = {
        queued:      'aml-dl-pill aml-dl-pill-q',
        resolving:   'aml-dl-pill aml-dl-pill-r',
        downloading: 'aml-dl-pill aml-dl-pill-dl',
        tagging:     'aml-dl-pill aml-dl-pill-dl',
        moving:      'aml-dl-pill aml-dl-pill-dl',
        done:        'aml-dl-pill aml-dl-pill-ok',
        failed:      'aml-dl-pill aml-dl-pill-err',
        cancelled:   'aml-dl-pill aml-dl-pill-x',
    };

    function buildJobRow(job) {
        const row = document.createElement('div');
        row.dataset.jobId = job.jobId;
        row.style.cssText = 'padding:12px 16px;border-bottom:0.5px solid rgba(255,255,255,0.06);display:flex;gap:13px;align-items:flex-start;';

        // Artwork thumbnail
        const art = document.createElement('div');
        art.className = 'aml-dl-art';
        art.style.cssText = 'width:48px;height:48px;border-radius:9px;flex-shrink:0;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.5);margin-top:1px;';
        const artImg = document.createElement('img');
        artImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:none;';
        art.appendChild(artImg);
        // Skeleton fills art until image loads
        const artSkel = document.createElement('div');
        artSkel.className = 'aml-dl-art-skel';
        artSkel.style.cssText = 'width:100%;height:100%;';
        art.appendChild(artSkel);

        // Right column
        const col = document.createElement('div');
        col.className = 'aml-dl-col';
        col.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;';

        // Row 1: title + cancel
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display:flex;align-items:center;gap:6px;';

        const name = document.createElement('span');
        name.className = 'aml-dl-name';
        name.style.cssText = 'flex:1;color:rgba(255,255,255,0.92);font-size:13px;font-weight:590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-0.2px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'aml-dl-cancel';
        cancelBtn.innerHTML = `<svg viewBox="0 0 10 10" width="9" height="9"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
        cancelBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.20);cursor:pointer;padding:3px;display:flex;align-items:center;flex-shrink:0;border-radius:4px;transition:color 0.15s;';
        cancelBtn.onmouseenter = () => { cancelBtn.style.color = 'rgba(255,255,255,0.65)'; };
        cancelBtn.onmouseleave = () => { cancelBtn.style.color = 'rgba(255,255,255,0.20)'; };
        cancelBtn.onclick = () => cancelJob(job.jobId);
        titleRow.append(name, cancelBtn);

        // Row 2: artist + pill
        const metaRow = document.createElement('div');
        metaRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;';

        const artist = document.createElement('span');
        artist.className = 'aml-dl-artist';
        artist.style.cssText = 'color:rgba(255,255,255,0.40);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';

        const pill = document.createElement('span');
        pill.className = 'aml-dl-pill aml-dl-pill-q';
        metaRow.append(artist, pill);

        // Row 3: progress bar + size (hidden for non-active)
        const progRow = document.createElement('div');
        progRow.className = 'aml-dl-prog-row';
        progRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

        const bar = document.createElement('div');
        bar.style.cssText = 'flex:1;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;';
        const fill = document.createElement('div');
        fill.className = 'aml-dl-fill';
        fill.style.cssText = 'height:100%;border-radius:2px;width:0%;transition:width 0.4s ease;background:rgba(255,255,255,0.85);';
        bar.appendChild(fill);

        const sizeLabel = document.createElement('span');
        sizeLabel.className = 'aml-dl-size';
        sizeLabel.style.cssText = 'font-size:10.5px;color:rgba(255,255,255,0.28);flex-shrink:0;font-variant-numeric:tabular-nums;min-width:52px;text-align:right;';
        progRow.append(bar, sizeLabel);

        col.append(titleRow, metaRow, progRow);
        row.append(art, col);
        updateJobRow(row, job);
        return row;
    }

    function updateJobRow(row, job) {
        const name      = row.querySelector('.aml-dl-name');
        const artist    = row.querySelector('.aml-dl-artist');
        const pill      = row.querySelector('.aml-dl-pill');
        const fill      = row.querySelector('.aml-dl-fill');
        const size      = row.querySelector('.aml-dl-size');
        const artEl     = row.querySelector('.aml-dl-art');
        const artImg    = artEl?.querySelector('img');
        const artSkel   = artEl?.querySelector('.aml-dl-art-skel');
        const cancelBtn = row.querySelector('.aml-dl-cancel');
        const progRow   = row.querySelector('.aml-dl-prog-row');
        const phase     = job.phase || '';
        const hasTitle  = !!(job.title || job.output);
        const isTerminal = phase === 'done' || phase === 'failed' || phase === 'cancelled';
        const isActive   = phase === 'downloading' || phase === 'tagging' || phase === 'moving' || phase === 'resolving';

        // Title: skeleton lines when unresolved, real text otherwise
        if (name) {
            if (hasTitle) {
                name.textContent = job.title || job.output.split('/').pop();
                name.style.cssText = 'flex:1;color:rgba(255,255,255,0.92);font-size:13px;font-weight:590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-0.2px;';
            } else {
                name.textContent = '';
                name.style.cssText = 'flex:1;height:11px;margin:1px 0;border-radius:3px;background:rgba(255,255,255,0.10);animation:aml-dl-skel 1.4s ease-in-out infinite;max-width:70%;';
            }
        }

        // Artist: skeleton when unresolved
        if (artist) {
            if (hasTitle) {
                artist.textContent = job.artistName || '';
                artist.style.cssText = 'color:rgba(255,255,255,0.40);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
            } else {
                artist.textContent = '';
                artist.style.cssText = 'flex:1;height:9px;margin:1px 0;border-radius:3px;background:rgba(255,255,255,0.07);animation:aml-dl-skel 1.4s ease-in-out infinite;max-width:45%;';
            }
        }

        // Status pill
        if (pill) {
            pill.className = PILL_CLASS[phase] || 'aml-dl-pill aml-dl-pill-q';
            pill.textContent = PHASE_LABEL[phase] || phase;
        }

        // Progress fill — determinate bar for all phases
        if (fill) {
            const BG = { done: '#30d158', failed: '#ff453a', cancelled: 'rgba(255,255,255,0.10)' };
            const pct = isTerminal ? 100 : (job.percent ?? 0);
            const bg  = BG[phase] || 'rgba(255,255,255,0.85)';
            if (phase === 'downloading') {
                // Real byte-based fill — smooth transition, no animation
                fill.style.cssText = `height:100%;border-radius:2px;width:${pct}%;transition:width 0.6s ease;background:${bg};animation:none;`;
            } else if (isActive) {
                // Indeterminate pulse for resolving/tagging/moving
                fill.style.cssText = `height:100%;border-radius:2px;width:${pct}%;transition:width 0.4s ease;background:${bg};animation:aml-dl-pulse 1.2s ease-in-out infinite;`;
            } else {
                fill.style.cssText = `height:100%;border-radius:2px;width:${pct}%;transition:width 0.4s ease;background:${bg};animation:none;`;
            }
        }

        // Size label — show "done / total" when total is known
        if (size) {
            if (phase === 'downloading' && job.bytesTotal && job.bytesDone) {
                size.textContent = `${_fmtBytes(job.bytesDone)} / ${_fmtBytes(job.bytesTotal)}`;
            } else {
                size.textContent = _fmtBytes(job.bytesDone);
            }
        }

        // Progress row visibility: hide for queued/done/cancelled
        if (progRow) progRow.style.display = (phase === 'queued' || phase === 'cancelled') ? 'none' : 'flex';

        // Artwork: reveal once URL resolves; hide skeleton
        if (artImg && job.artworkUrl) {
            if (artImg.style.display === 'none') {
                artImg.src = _artThumb(job.artworkUrl, 84);
                artImg.style.display = 'block';
            }
            if (artSkel) artSkel.style.display = 'none';
        }

        // Cancel button: hide for terminal phases
        if (cancelBtn) cancelBtn.style.display = isTerminal ? 'none' : 'flex';

        // Retry button + auto-retry countdown for failed/cancelled
        const col        = row.querySelector('.aml-dl-col');
        let retryBtn     = row.querySelector('.aml-dl-retry');
        let countdownEl  = row.querySelector('.aml-dl-countdown');

        if (phase === 'failed' || phase === 'cancelled') {
            if (!retryBtn && col) {
                retryBtn = document.createElement('button');
                retryBtn.className = 'aml-dl-retry';
                retryBtn.style.cssText = 'margin-top:2px;padding:3px 10px;background:rgba(252,60,68,0.13);border:0.5px solid rgba(252,60,68,0.30);border-radius:5px;color:#fc3c44;font-size:10px;cursor:pointer;font-weight:500;transition:background 0.15s;align-self:flex-start;';
                retryBtn.onmouseenter = () => { retryBtn.style.background = 'rgba(252,60,68,0.28)'; };
                retryBtn.onmouseleave = () => { retryBtn.style.background = 'rgba(252,60,68,0.13)'; };
                retryBtn.onclick = () => {
                    // Cancel any pending auto-retry, then retry now
                    const entry = _failedAt.get(job.jobId);
                    if (entry) { clearTimeout(entry.timer); _failedAt.delete(job.jobId); }
                    retryBtn.textContent = 'Retrying…';
                    retryBtn.disabled = true;
                    if (countdownEl) countdownEl.textContent = '';
                    retryJob(job.jobId);
                };
                col.appendChild(retryBtn);
            }
            if (retryBtn) retryBtn.textContent = retryBtn.disabled ? 'Retrying…' : 'Retry';

            // Countdown label for auto-retry
            const entry = _failedAt.get(job.jobId);
            if (entry && phase === 'failed') {
                if (!countdownEl && col) {
                    countdownEl = document.createElement('span');
                    countdownEl.className = 'aml-dl-countdown';
                    countdownEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.28);margin-top:1px;align-self:flex-start;';
                    col.appendChild(countdownEl);
                }
                if (countdownEl) {
                    const secs = Math.max(0, Math.ceil((entry.deadline - Date.now()) / 1000));
                    countdownEl.textContent = secs > 0 ? `Auto-retry in ${secs}s` : 'Retrying…';
                }
            } else {
                countdownEl?.remove();
            }
        } else {
            retryBtn?.remove();
            countdownEl?.remove();
        }
    }

    async function clearDoneJobs() {
        const res = await fetch(`${ENGINE}/api/v1/export`).then(r => r.json()).catch(() => []);
        const terminal = (Array.isArray(res) ? res : []).filter(j => j.phase === 'done' || j.phase === 'failed' || j.phase === 'cancelled');
        await Promise.all(terminal.map(j => fetch(`${ENGINE}/api/v1/export/${j.jobId}`, { method: 'DELETE' }).catch(() => {})));
        pollJobs();
    }

    async function cancelJob(id) {
        await fetch(`${ENGINE}/api/v1/export/${id}`, { method: 'DELETE' }).catch(() => {});
        pollJobs();
    }

    async function retryJob(id) {
        await fetch(`${ENGINE}/api/v1/export/${id}/retry`, { method: 'POST' }).catch(() => {});
        pollJobs();
    }

    let _pollSeq = 0;
    async function pollJobs() {
        const seq = ++_pollSeq;
        try {
            const jobs = await fetch(`${ENGINE}/api/v1/export`).then(r => r.json());
            if (seq === _pollSeq) renderJobs(Array.isArray(jobs) ? jobs : []);
        } catch (_) {}
    }

    function _tickCountdowns() {
        document.querySelectorAll('.aml-dl-countdown').forEach(el => {
            const jobId = el.closest('[data-job-id]')?.dataset.jobId;
            if (!jobId) return;
            const entry = _failedAt.get(jobId);
            if (!entry) { el.textContent = ''; return; }
            const secs = Math.max(0, Math.ceil((entry.deadline - Date.now()) / 1000));
            el.textContent = secs > 0 ? `Auto-retry in ${secs}s` : 'Retrying…';
        });
    }

    function startPolling() {
        if (_pollTimer) return;
        pollJobs();
        _pollTimer = setInterval(pollJobs, 2000);
        _countdownTimer = setInterval(_tickCountdowns, 1000);
    }

    function stopPolling() {
        if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
        if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    }
})();
