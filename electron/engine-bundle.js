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
                    // Snap position to the actual segment boundary so UI and audio stay in sync.
                    _vlcPosMs = actualStartMs;
                } catch (e) {
                    console.warn(`[AML VLC] seek ERROR`, e);
                }
                // VLC always reports elapsed time from its first DTS frame, not the
                // absolute tfdt position. Use actualStartMs (the true segment boundary)
                // so _vlcPosMs = actualStartMs + elapsed tracks audio position accurately.
                _vlcSeekOffsetMs = actualStartMs;
                _vlcPrevState = null;          // force poll to re-emit 'playing', cancelling 'waiting'
                _vlcSeekFrozen = false;
                _seekBurstLog = 15;            // log every tick for 15 ticks (3.75s) after seek
                console.log(`[AML VLC] seek UNFREEZE  offset=${_vlcSeekOffsetMs}ms`);
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

// ── Quality badge ─────────────────────────────────────────────────────────────

function showQualityBadge(codec, sampleRate, bitDepth) {
    let badge = document.getElementById('aml-quality-badge');

    if (codec !== 'alac') {
        if (badge) badge.style.display = 'none';
        return;
    }

    const hiRes = sampleRate > 48000 || bitDepth > 16;
    const text  = hiRes
        ? `HI-RES LOSSLESS  ·  ${(sampleRate / 1000).toFixed(0)} kHz / ${bitDepth}-bit`
        : 'LOSSLESS';

    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'aml-quality-badge';
        badge.style.cssText =
            'font-size:8px;font-weight:700;letter-spacing:.07em;' +
            'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;' +
            'color:#30d158;border:1px solid #30d158;border-radius:3px;' +
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

    badge.textContent   = text;
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

        if (ms.readyState !== 'open' || audio.error) throw new Error('MediaSource closed or audio error');

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
        if (ms.readyState !== 'open' || audio.error) throw new Error('MediaSource closed or audio error');
        try {
            sb.appendBuffer(value);
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
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

        const waitIdle = () => new Promise(res => {
            if (!sb.updating) return res();
            sb.addEventListener('updateend', res, { once: true });
            sb.addEventListener('error',     res, { once: true });
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
            }
            const prevPos = _vlcPosMs;
            // VLC counts elapsed time from the start of the current HTTP stream,
            // not absolute PTS. Add _vlcSeekOffsetMs (set at seek UNFREEZE) so the
            // displayed position stays anchored to the song timeline after seeks.
            // Guard posMs > 0: VLC returns -1/0 briefly before first decode.
            if (!_vlcSeekFrozen && posMs > 0) _vlcPosMs = _vlcSeekOffsetMs + posMs;
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

    const isMV = item.type === 'music-videos';

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
                    video:    isMV,
                    atmos:    false,
                },
                token:          mk.developerToken ?? '',
                mediaUserToken: getMUT(),
            }),
        });
        if (!sessResp.ok) throw new Error(`Session ${sessResp.status}: ${await sessResp.text()}`);

        const sess = await sessResp.json();

        if (myGen !== _generation) { deleteSession(sess.sessionId); return; }

        _sessionId   = sess.sessionId;
        _durationSec = (sess.durationMs ?? 0) / 1000;
        console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now()-t0)/1000).toFixed(2)}s`);

        showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);

        if (!mkAudio) throw new Error('MK audio element not found');

        _abortCtrl = new AbortController();
        const ctrl = _abortCtrl;

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
        const artUrl = artTemplate.replace('{w}', '500').replace('{h}', '500');
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
