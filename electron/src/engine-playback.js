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

const ENGINE = 'aml-engine:/';

// ── Native handles ─────────────────────────────────────────────────────────────

let _nativeSrcSet = null; // saved by blockAppleCDN() for our own src writes
let _nativePlay   = null; // saved when play() proxy is installed on the element
let _ourBlobUrl   = null; // current blob URL we own; blocks MK from replacing it

// ── VLC state ─────────────────────────────────────────────────────────────────

let _vlcMode      = false; // true when VLC is handling playback (MSE bypassed)
let _vlcPosMs     = 0;     // last polled VLC position
let _vlcPollTimer = null;  // setInterval handle

// ── Engine capability snapshot (from SSE) ─────────────────────────────────────

let _engineCaps      = { lossless: false, atmos: false };
let _flacSupported    = false;  // MediaSource.isTypeSupported('audio/mp4; codecs="flac"') at setup()
let _losslessWaitDone = false;  // true after waitForLossless has timed out once — skip future waits
let _snapshotEventId  = -1;     // SSE meta.id of the last engine.snapshot — drm events older than this are stale replays

// ── DRM key system stub (prevents MKError mk-140 in Electron) ─────────────────
// Electron doesn't ship Widevine/FairPlay CDM. MusicKit probes for a key system
// via navigator.requestMediaKeySystemAccess() before setting nowPlayingItem;
// if none found it throws CONTENT_UNSUPPORTED and nowPlayingItemDidChange never
// fires. We stub the probe so MusicKit proceeds to change the queue, then our
// MSE pipeline takes over. Since MSE pipes raw AAC (no encryption), no actual
// DRM license is ever requested.

function stubDRM() {
    if (window.__amlDRMStubbed) return;
    window.__amlDRMStubbed = true;

    const _origRMKSA = navigator.requestMediaKeySystemAccess?.bind(navigator);
    navigator.requestMediaKeySystemAccess = async function(keySystem, configs) {
        // Prefer a real CDM if Electron ever gets one.
        if (_origRMKSA) {
            try { return await _origRMKSA(keySystem, configs); } catch (_) {}
        }
        const fakeSession = {
            sessionId: '', expiration: NaN, closed: Promise.resolve(),
            keyStatuses: new Map(),
            addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
            generateRequest: async () => {}, load: async () => false,
            update: async () => {}, close: async () => {}, remove: async () => {},
        };
        const fakeMediaKeys = {
            createSession: () => fakeSession,
            setServerCertificate: async () => true,
        };
        return {
            keySystem,
            getConfiguration: () => (configs && configs[0]) || {},
            createMediaKeys: async () => fakeMediaKeys,
        };
    };

    // Stub setMediaKeys so the browser doesn't reject our fake MediaKeys object.
    const _origSMK = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = async function(keys) {
        if (!keys) { try { return await _origSMK.call(this, null); } catch (_) {} return; }
        // If it's a real browser MediaKeys instance, delegate normally.
        if (typeof MediaKeys !== 'undefined' && keys instanceof MediaKeys) {
            return _origSMK.call(this, keys);
        }
        // Fake keys — accept silently; our MSE stream never generates encrypted events.
    };

    console.log('[AML Engine] DRM stub installed');
}

// ── CDN blocker (prototype-level, runs at parse time) ─────────────────────────

function blockAppleCDN() {
    if (window.__amlCDNBlocked) return;
    window.__amlCDNBlocked = true;

    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    _nativeSrcSet = desc.set;

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
        // Always return a never-resolving Promise so MK's "after play() settled"
        // handler never runs (it would call audio.pause() because it sees CDN
        // loading never completed, breaking every manual resume).
        //
        // When MSE has data (readyState ≥ 3) we call _nativePlay() ourselves to
        // actually start/resume audio; the 'playing' DOM event then advances MK's
        // state machine to "playing" (2) through its own event listeners.
        //
        // Before MSE is ready the canplay handler in handleTrackChange calls
        // _nativePlay() instead, so we leave it pending here too.
        // Always forward to _nativePlay so the user can resume at any readyState.
        if (_vlcMode) {
            fetch(`${ENGINE}/api/v1/vlc/resume`, { method: 'POST' }).catch(() => {});
        }
        if (_sessionId) _nativePlay().catch(() => {});
        return new Promise(() => {}); // intentionally never resolves
    };

    console.log('[AML Engine] Play proxy installed');
}

/**
 * Intercept mk.seekToTime() because MK's own implementation crashes in
 * PlayActivity.scrub ("A method was called without a previous descriptor")
 * before it ever sets audio.currentTime — so the native 'seeking' DOM event
 * never fires and our onSeeking listener is never called.
 *
 * Fix: wrap mk.seekToTime to set audio.currentTime via the native prototype
 * setter (bypassing any MK-level Object.defineProperty shims), which fires
 * the 'seeking' event and triggers our existing onSeeking handler.
 */
function installMKSeekInterceptor(mk) {
    if (mk.__amlSeekIntercepted) return;
    mk.__amlSeekIntercepted = true;

    const _origSeek    = mk.seekToTime.bind(mk);
    // Use the setter captured before MK had a chance to override
    // HTMLMediaElement.prototype.currentTime — if MK overrides it, our captured
    // version would be MK's setter which silently drops backward seeks.
    const _nativeCTSet = window.__amlNativeCTSet
        || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')?.set;

    mk.seekToTime = async function(seekSec) {
        const audio = getMKAudio();
        if (_vlcMode) {
            // VLC path: fire synthetic seeking/seeked events so MK's UI updates,
            // then restart VLC at the new position.
            _vlcPosMs = Math.round(seekSec * 1000);
            if (audio) {
                audio.dispatchEvent(new Event('seeking'));
                audio.dispatchEvent(new Event('seeked'));
            }
            fetch(`${ENGINE}/api/v1/vlc/seek`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ posMs: _vlcPosMs }),
            }).catch(() => {});
        } else if (audio && _nativeCTSet && _activeSb && _activeMs) {
            // MSE path: set currentTime via native setter to fire 'seeking' event,
            // which onSeeking picks up to run the MSE seekToTime pipeline.
            _ourSeekPending = true;
            _ourSeekTarget  = seekSec;
            _nativeCTSet.call(audio, seekSec);
        } else {
            return _origSeek(seekSec).catch(() => {});
        }
    };

    console.log('[AML Engine] MK seek interceptor installed');
}

// ── MusicKit helpers ──────────────────────────────────────────────────────────

function getMKAudio() {
    return document.getElementById('apple-music-player') || document.querySelector('audio') || null;
}

// Returns a non-editorial <video> element — i.e. MK's MV player, not the
// looping ambient background videos Apple Music puts in .editorial-video.
function getMKVideo() {
    for (const v of document.querySelectorAll('video')) {
        if (!v.closest('.editorial-video')) return v;
    }
    return null;
}

// Resolves when a non-editorial <video> element appears, or null on timeout/abort.
function waitForMKVideo(signal, timeoutMs = 10000) {
    const immediate = getMKVideo();
    if (immediate) return Promise.resolve(immediate);
    return new Promise(resolve => {
        const obs = new MutationObserver(() => {
            const el = getMKVideo();
            if (el) { obs.disconnect(); resolve(el); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        signal.addEventListener('abort', () => { obs.disconnect(); resolve(null); }, { once: true });
        setTimeout(() => { obs.disconnect(); resolve(null); }, timeoutMs);
    });
}

function waitForMusicKit() {
    return new Promise(resolve => {
        const check = () => {
            try {
                const mk = window.MusicKit?.getInstance?.();
                if (mk && 'nowPlayingItem' in mk) return resolve(mk);
            } catch (_) {}
            setTimeout(check, 300);
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

let _sessionId   = null;
let _durationSec = 0;
let _abortCtrl   = null;   // session-level abort — killed on track change
let _pipeCtrl    = null;   // pipe-level abort — killed on seek OR track change
let _generation  = 0;
let _seekable    = false;  // whether the engine stream supports ?t= restart
let _seekTarget      = -Infinity; // target of in-progress seek; guards re-entrant seeking events
let _ourSeekPending  = false;     // true only when OUR interceptor set currentTime; clears after onSeeking fires
let _ourSeekTarget   = -Infinity; // exact seekSec from our interceptor (avoids stale MK getter in onSeeking)
let _streamComplete  = false;     // true after endOfStream(); cleared when a new engine fetch starts
let _seekFetchCtrl   = null;      // aborted when a newer seek starts; ensures only one seek pipeline runs
let _chunkCache      = null;      // { sessionId, chunks: Uint8Array[], byteSize: number } — re-injected on backward seeks

// Live MSE state — needed by seekToTime() which runs outside handleTrackChange.
let _activeSb          = null;  // current SourceBuffer
let _activeMs          = null;  // current MediaSource
let _activeStreamBase  = '';    // stream URL base (without ?t= param)

// MV video element state
let _videoPipeCtrl = null;  // video-pipe abort — killed on track change

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

function stopVLCPoll() {
    if (_vlcPollTimer) { clearInterval(_vlcPollTimer); _vlcPollTimer = null; }
}

function startVLCPoll(mkAudio) {
    stopVLCPoll();
    _vlcPollTimer = setInterval(async () => {
        try {
            const r = await fetch(`${ENGINE}/api/v1/vlc/time`);
            if (!r.ok) return;
            const { posMs, state } = await r.json();
            _vlcPosMs = posMs;
            mkAudio.dispatchEvent(new Event('timeupdate'));
            if (state === 'ended') {
                stopVLCPoll();
                mkAudio.dispatchEvent(new Event('ended'));
            }
        } catch (_) {}
    }, 50);
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

// ── MSE streaming ─────────────────────────────────────────────────────────────

// streamUrlOrResp can be a URL string (normal playback) or a pre-fetched
// Response object (seek path, where we need to inspect headers before clearing
// the SourceBuffer).
async function pipeToSourceBuffer(sb, audio, streamUrlOrResp, signal, ms, durationSec, t0) {
    // Capture at pipe-start so cross-session upgrades or track changes cannot
    // corrupt the new session's chunk cache with stale data from this pipe.
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

    // Large buffer targets — keep the whole song (and neighbours) in the SourceBuffer
    // so backward seeking hits the buffer and requires no engine re-fetch.
    // ffmpeg transcodes at 2-4× realtime, so the song is fully buffered well before
    // it finishes playing.  If the MSE quota is exhausted (system-dependent; typically
    // 100-150 MB for audio in modern Chromium/Electron), the two-tier QuotaExceeded
    // handler below falls back gracefully: first tries to evict only very old data
    // (> BACKWARD_SECS behind), and if still over quota, drops to a 30 s window.
    const FORWARD_SECS  = 900;  // buffer up to 15 min ahead (~3 songs)
    const BACKWARD_SECS = 900;  // preserve up to 15 min behind for backward seeks

    const evictPlayed = async (aggressiveSecs = BACKWARD_SECS) => {
        if (ms.readyState !== 'open' || sb.buffered.length === 0) return;
        const evictEnd = Math.max(0, audio.currentTime - aggressiveSecs);
        if (evictEnd > sb.buffered.start(0) + 1) {
            await sbRemove(sb.buffered.start(0), evictEnd);
        }
    };

    while (true) {
        if (signal.aborted) throw new Error('aborted');
        const { done, value } = await reader.read();
        if (done) {
            console.log(`[AML Engine] Stream done (${chunks} chunks) +${((performance.now()-t0)/1000).toFixed(2)}s`);
            break;
        }
        chunks++;

        // Early-exit if the MediaSource was closed while the read was in-flight.
        // This guards all sb.buffered accesses below (eviction, throttle, appendBuffer).
        if (ms.readyState !== 'open' || audio.error) throw new Error('MediaSource closed or audio error');

        // Store a copy in the session chunk cache (80 MB cap) so backward seeks
        // outside the MSE buffer can be satisfied without a new engine round-trip.
        // localSessionId (captured at pipe-start) prevents old-pipe chunks from
        // leaking into a new session's cache after a track change or upgrade.
        if (_chunkCache && _chunkCache.sessionId === localSessionId &&
                _chunkCache.byteSize < 80 * 1024 * 1024) {
            const copy = new Uint8Array(value.byteLength);
            copy.set(value);
            _chunkCache.chunks.push(copy);
            _chunkCache.byteSize += value.byteLength;
        }

        // Proactive backward eviction — only removes data older than BACKWARD_SECS.
        if (sb.buffered.length > 0 && audio.currentTime > sb.buffered.start(0) + BACKWARD_SECS + 1) {
            await evictPlayed();
        }

        // Throttle: pause piping when the forward buffer exceeds FORWARD_SECS.
        // ffmpeg finishes the whole song in ~durationSec/3 wall seconds, so without
        // the throttle the buffer would fill to the MSE quota instantly.
        while (ms.readyState === 'open' && sb.buffered.length > 0 &&
               (sb.buffered.end(sb.buffered.length - 1) - audio.currentTime) > FORWARD_SECS) {
            if (signal.aborted) throw new Error('aborted');
            await new Promise(r => setTimeout(r, 500));
        }

        await waitUpdate();
        if (sb.updating) await waitUpdate();
        if (signal.aborted) throw new Error('aborted');
        if (ms.readyState !== 'open' || audio.error) throw new Error('MediaSource closed or audio error');
        try {
            sb.appendBuffer(value);
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                // Two-tier recovery:
                //   Attempt 1-2: evict only data older than BACKWARD_SECS (preserves seeks).
                //   Attempt 3+:  fall back to aggressive 30 s eviction so the pipe
                //                never stalls permanently on constrained systems.
                let appended = false;
                for (let attempt = 0; !appended; attempt++) {
                    await new Promise(r => setTimeout(r, 300));
                    if (signal.aborted) throw new Error('aborted');
                    const fallbackSecs = attempt >= 2 ? 30 : BACKWARD_SECS;
                    await evictPlayed(fallbackSecs);
                    await waitUpdate();
                    try { sb.appendBuffer(value); appended = true; } catch (e2) {
                        if (e2.name !== 'QuotaExceededError') throw e2;
                    }
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

// ── Seek handler ──────────────────────────────────────────────────────────────

/**
 * Seek to seekSec seconds.  Called from the 'seeking' DOM event.
 *
 * If the target is already in the SourceBuffer we do nothing — the browser
 * resumes from the buffer on its own.  Otherwise we abort the current pipe,
 * flush the SourceBuffer, and restart the stream from the engine's ?t= endpoint.
 */
async function seekToTime(seekSec, audio, sb, ms) {
    if (ms.readyState === 'closed') return; // MS was closed by MK before seek arrived
    const bufferedRanges = Array.from({length: sb.buffered.length}, (_, i) =>
        `[${sb.buffered.start(i).toFixed(1)},${sb.buffered.end(i).toFixed(1)}]`).join(' ');
    console.log(`[AML Engine] seekToTime(${seekSec.toFixed(2)}) ct=${audio.currentTime.toFixed(2)} buffered=${bufferedRanges||'(empty)'} seekable=${_seekable} seekTarget=${_seekTarget}`);

    // If seek target is already buffered, let the browser handle it natively.
    // 1 s tolerance on both ends: catches segment-boundary rounding and the common
    // case where a lyric seek lands just before the start of a freshly-evicted window.
    for (let i = 0; i < sb.buffered.length; i++) {
        if (seekSec >= sb.buffered.start(i) - 1.0 && seekSec < sb.buffered.end(i) + 1.0) {
            console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s → native (buffered)`);
            _seekTarget = -Infinity; // target is now buffered, seek complete
            // After the native seek resolves, resume playback if the element ended up
            // paused (MK may pause during seeking and our play proxy must restart it).
            const wasPlaying = !audio.paused;
            audio.addEventListener('seeked', () => {
                if (wasPlaying && audio.paused) _nativePlay().catch(() => {});
            }, { once: true });
            return;
        }
    }

    // If the seek target missed the MSE buffer but we have cached chunks for this
    // session, re-inject them directly — no engine round-trip, no re-transcode.
    // Works for both seekable and non-seekable (FLAC) streams.
    if (_chunkCache && _chunkCache.sessionId === _sessionId && _chunkCache.chunks.length > 0) {
        if (Math.abs(_seekTarget - seekSec) < 0.5) {
            console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s → cache guard (in-progress)`);
            return;
        }
        _seekTarget = seekSec;

        const wasPlaying        = !audio.paused;
        const cacheSnap         = _chunkCache;
        const wasStreamComplete = _streamComplete;
        _streamComplete = false;

        if (_seekFetchCtrl) { _seekFetchCtrl.abort(); }
        _seekFetchCtrl = new AbortController();
        const mySC = _seekFetchCtrl;

        if (_pipeCtrl) { _pipeCtrl.abort(); _pipeCtrl = null; }
        _pipeCtrl = new AbortController();
        const pipeCtrl = _pipeCtrl;

        console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s → cache re-inject (${(cacheSnap.byteSize / 1e6).toFixed(1)} MB, ${cacheSnap.chunks.length} chunks)`);

        const waitSBIdleC = () => new Promise((res) => {
            if (!sb.updating) return res();
            sb.addEventListener('updateend', res, { once: true });
            sb.addEventListener('error',     res, { once: true });
        });

        (async () => {
            try {
                await waitSBIdleC();
                if (pipeCtrl.signal.aborted || ms.readyState !== 'open') return;
                if (sb.buffered.length > 0) sb.remove(0, Infinity);
                await waitSBIdleC();

                for (const chunk of cacheSnap.chunks) {
                    if (pipeCtrl.signal.aborted) return;
                    await waitSBIdleC();
                    if (pipeCtrl.signal.aborted || ms.readyState !== 'open') return;
                    try { sb.appendBuffer(chunk); } catch (e) {
                        if (e.name === 'QuotaExceededError') {
                            console.warn('[AML Engine] Cache re-inject: quota exceeded, stopping');
                        }
                        return;
                    }
                }

                if (pipeCtrl.signal.aborted || _seekFetchCtrl !== mySC) return;
                await waitSBIdleC();

                if (wasStreamComplete) {
                    if (ms.readyState === 'open') {
                        if (_durationSec > 0) { try { ms.duration = _durationSec; } catch (_) {} }
                        ms.endOfStream();
                        _streamComplete = true;
                        console.log('[AML Engine] Cache re-inject: re-applied endOfStream');
                    }
                } else if (_seekable && _activeStreamBase) {
                    const bufEnd = sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : seekSec;
                    console.log(`[AML Engine] Cache re-inject done → resuming engine from ${bufEnd.toFixed(2)}s`);
                    let resumeResp;
                    try {
                        resumeResp = await fetch(`${_activeStreamBase}&t=${bufEnd.toFixed(3)}`, { signal: pipeCtrl.signal });
                    } catch (_) { return; }
                    if (!resumeResp.ok || pipeCtrl.signal.aborted || _seekFetchCtrl !== mySC) {
                        resumeResp?.body?.cancel(); return;
                    }
                    await pipeToSourceBuffer(sb, audio, resumeResp, pipeCtrl.signal, ms, _durationSec, performance.now());
                }
            } catch (e) {
                if (!pipeCtrl.signal.aborted) console.error('[AML Engine] Cache re-inject error:', e.message);
            }
        })();

        audio.addEventListener('canplay', () => {
            if (pipeCtrl.signal.aborted) return;
            _seekTarget = -Infinity;
            if (wasPlaying) _nativePlay().catch(() => {});
        }, { once: true });

        return;
    }

    if (!_seekable) { console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s → not seekable`); return; }

    // Stream-complete mode: endOfStream() was called and no pipe is active.
    // The re-entrancy guard may hold a stale _seekTarget from the last mid-stream
    // seek that triggered the final download; clear it so any position is reachable.
    // Also clear the flag so it re-arms once the re-fetch pipe completes.
    if (_streamComplete) {
        console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s → completed-mode re-fetch`);
        _seekTarget     = -Infinity;
        _streamComplete = false;
    }

    // Guard against re-entrant seeks for the same target.  When the SourceBuffer
    // is cleared mid-seek the browser re-fires 'seeking' with the same currentTime;
    // without this guard we'd abort our own in-progress pipe and loop forever.
    if (Math.abs(_seekTarget - seekSec) < 0.5) { console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s → guard (in-progress)`); return; }
    _seekTarget = seekSec;

    const wasPlaying = !audio.paused;

    // Abort any previous in-flight seek fetch so only ONE seek pipeline runs at a time.
    // Two seeks with different targets both pass the |_seekTarget-seekSec|<0.5 guard and
    // can race to write the SourceBuffer concurrently, causing "SB error chunk N".
    if (_seekFetchCtrl) { _seekFetchCtrl.abort(); }
    _seekFetchCtrl = new AbortController();
    const mySeekCtrl = _seekFetchCtrl;

    const seekUrl = `${_activeStreamBase}&t=${seekSec.toFixed(3)}`;
    let resp;
    try {
        const signals = [mySeekCtrl.signal];
        if (_abortCtrl?.signal) signals.push(_abortCtrl.signal);
        resp = await fetch(seekUrl, { signal: AbortSignal.any(signals) });
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[AML Engine] Seek fetch error:', e.message);
        return;
    }
    if (!resp.ok) {
        console.warn(`[AML Engine] Seek not supported for this stream (${resp.status}) — seeking only within buffered range`);
        return;
    }

    // Guard: track changed OR a newer seek started while this fetch was in flight.
    if (_abortCtrl?.signal.aborted || _seekFetchCtrl !== mySeekCtrl) {
        resp.body?.cancel();
        return;
    }

    // Engine may start at a slightly earlier segment boundary.
    const actualStartHdr = resp.headers.get('X-Actual-Start');
    const actualStart = actualStartHdr ? parseFloat(actualStartHdr) : seekSec;
    console.log(`[AML Engine] Seek → ${seekSec.toFixed(2)}s (actual=${actualStart.toFixed(2)}s)`);

    // Only NOW abort the old pipe and clear the SourceBuffer.
    if (_pipeCtrl) { _pipeCtrl.abort(); _pipeCtrl = null; }

    const waitSBIdle = () => new Promise((res, rej) => {
        if (!sb.updating) return res();
        const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); res(); };
        const fail = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', fail); rej(new Error('SB error during seek')); };
        sb.addEventListener('updateend', done, { once: true });
        sb.addEventListener('error',     fail, { once: true });
    });

    try {
        await waitSBIdle();
        if (ms.readyState === 'open') sb.remove(0, Infinity);
        await waitSBIdle();
    } catch (_) {}

    _pipeCtrl = new AbortController();
    const pipeCtrl = _pipeCtrl;

    // Pass the already-in-flight response body directly to avoid a second fetch.
    pipeToSourceBuffer(sb, audio, resp, pipeCtrl.signal, ms, _durationSec, performance.now()).catch(e => {
        if (!pipeCtrl.signal.aborted) console.error('[AML Engine] Seek pipe error:', e.message);
    });

    audio.addEventListener('canplay', () => {
        if (pipeCtrl.signal.aborted) return;
        _seekTarget = -Infinity; // seek complete
        const buf = sb.buffered;
        const bStart = buf.length > 0 ? buf.start(0).toFixed(2) : '?';
        const bEnd   = buf.length > 0 ? buf.end(buf.length - 1).toFixed(2) : '?';
        console.log(
            `[AML Engine] Seek ready — requested=${seekSec.toFixed(2)}s` +
            ` actualStart=${actualStart.toFixed(2)}s` +
            ` buffered=[${bStart},${bEnd}]` +
            ` currentTime=${audio.currentTime.toFixed(2)}s` +
            ` readyState=${audio.readyState} networkState=${audio.networkState}`
        );
        // Only resume playback if audio was playing before the seek.
        if (wasPlaying) _nativePlay().catch(e => console.warn('[AML Engine] seek play():', e));
    }, { once: true });
}

// ── MV video injection ────────────────────────────────────────────────────────

// Injects the engine's video stream into the MK video element using the same
// MSE technique as the audio path: native src-set bypass, load() shadow, and
// a separate SourceBuffer on a new MediaSource.
//
// The video element is muted — audio comes from mkAudio as usual — so MK's
// state machine is unaffected.  We sync play/pause/seek events from mkAudio.
async function startMVVideoInjection(videoStreamPath, ctrl, mkAudio, t0) {
    const VIDEO_MIME = 'video/mp4; codecs="avc1.42E01E"';

    // Wait up to 10 s for MK to create its video player element.
    const videoEl = await waitForMKVideo(ctrl.signal, 10000);
    if (!videoEl || ctrl.signal.aborted) {
        console.log('[AML Engine] MV: no video element found — video stream skipped');
        return;
    }
    console.log(`[AML Engine] MV: injecting video +${((performance.now()-t0)/1000).toFixed(2)}s`);

    videoEl.muted        = true;
    videoEl.defaultMuted = true;
    // Block MK's own load() calls so it can't reset our MSE src.
    videoEl.load = () => {};

    const ms      = new MediaSource();
    const blobUrl = URL.createObjectURL(ms);
    _nativeSrcSet.call(videoEl, blobUrl);

    // One controlled load() to trigger sourceopen, then re-block.
    delete videoEl.load;
    HTMLMediaElement.prototype.load.call(videoEl);
    videoEl.load = () => {};

    await new Promise((resolve, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        ms.addEventListener('sourceopen', resolve, { once: true });
    });
    URL.revokeObjectURL(blobUrl);

    const sb = ms.addSourceBuffer(VIDEO_MIME);

    // Pipe video stream.
    _videoPipeCtrl = new AbortController();
    const pipeCtrl = _videoPipeCtrl;
    pipeToSourceBuffer(sb, videoEl, `${ENGINE}${videoStreamPath}?raw=1`, pipeCtrl.signal, ms, _durationSec, t0).catch(e => {
        if (!pipeCtrl.signal.aborted) console.error('[AML Engine] Video pipe error:', e.message);
    });

    // Sync video element with mkAudio play/pause/seek events.
    const onPlaying = () => videoEl.paused && videoEl.play().catch(() => {});
    const onPause   = () => !videoEl.paused && videoEl.pause();
    const onSeeking = () => { videoEl.currentTime = mkAudio.currentTime; };

    mkAudio.addEventListener('playing', onPlaying);
    mkAudio.addEventListener('pause',   onPause);
    mkAudio.addEventListener('seeking', onSeeking);

    ctrl.signal.addEventListener('abort', () => {
        mkAudio.removeEventListener('playing', onPlaying);
        mkAudio.removeEventListener('pause',   onPause);
        mkAudio.removeEventListener('seeking', onSeeking);
        videoEl.pause();
        delete videoEl.load;
        if (_videoPipeCtrl) { _videoPipeCtrl.abort(); _videoPipeCtrl = null; }
    }, { once: true });

    // Kick video playback if audio is already playing by the time video is ready.
    videoEl.addEventListener('canplay', () => {
        if (ctrl.signal.aborted) return;
        if (!mkAudio.paused) videoEl.play().catch(() => {});
    }, { once: true });
}

// ── Core playback handler ─────────────────────────────────────────────────────

async function handleTrackChange(mk) {
    const item = mk.nowPlayingItem;
    if (!item) return;

    const myGen = ++_generation;

    if (_videoPipeCtrl) { _videoPipeCtrl.abort(); _videoPipeCtrl = null; }
    if (_pipeCtrl)      { _pipeCtrl.abort();      _pipeCtrl      = null; }
    if (_abortCtrl)     { _abortCtrl.abort();     _abortCtrl     = null; }
    _activeSb = null; _activeMs = null; _activeStreamBase = '';
    _ourBlobUrl = null;
    _vlcMode = false; _vlcPosMs = 0; stopVLCPoll();
    unbridgeDuration();
    deleteSession(_sessionId);
    _sessionId        = null;
    _durationSec      = 0;
    _seekable         = false;
    _seekTarget       = -Infinity;
    _ourSeekPending   = false;
    _ourSeekTarget    = -Infinity;
    _streamComplete   = false;
    if (_seekFetchCtrl) { _seekFetchCtrl.abort(); _seekFetchCtrl = null; }
    _chunkCache       = null;
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

    // Wait up to 2.5 s for DRM to report lossless capability before opening the session.
    // Prevents locking in a degraded AAC session when FairPlay is seconds from ready
    // (common on first startup and after re-auth). No-op if already lossless or AAC-only track.
    await waitForLossless(2500);
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
        _seekable    = sess.capabilities?.seekable ?? false;
        _chunkCache  = { sessionId: _sessionId, chunks: [], byteSize: 0 };
        console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s seekable=${_seekable} +${((performance.now()-t0)/1000).toFixed(2)}s`);

        showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);

        if (!mkAudio) throw new Error('MK audio element not found');

        _abortCtrl = new AbortController();
        const ctrl = _abortCtrl;

        showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);
        bridgeDuration(mk, _durationSec);

        // ── VLC path: bypass MSE, pipe raw ALAC to libvlc in the engine process ──

        _vlcMode = true;

        // Give mkAudio a valid (silent) src so _nativePlay() / DOM events work.
        // MK's state machine reads DOM events (playing, pause, timeupdate, ended)
        // from this element; actual audio comes from libvlc → system sound device.
        // 44-byte silent WAV (1 channel, 44100 Hz, 0 samples).
        const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        _nativeSrcSet.call(mkAudio, SILENT_WAV);
        delete mkAudio.load;
        HTMLMediaElement.prototype.load.call(mkAudio);
        mkAudio.load = () => {};

        // Override currentTime getter so MK's UI and lyrics sync see VLC's position.
        _vlcPosMs = 0;
        Object.defineProperty(mkAudio, 'currentTime', {
            get: () => _vlcPosMs / 1000,
            set: () => {}, // seeks routed through mk.seekToTime interceptor
            configurable: true,
        });

        // Forward volume changes to VLC (MK sets mkAudio.volume on mute/unmute).
        const _volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
        let _vlcVolume = Math.round((_volDesc.get.call(mkAudio) ?? 1) * 100);
        Object.defineProperty(mkAudio, 'volume', {
            get: () => _vlcVolume / 100,
            set: (v) => {
                _vlcVolume = Math.max(0, Math.min(200, Math.round(v * 100)));
                fetch(`${ENGINE}/api/v1/vlc/volume`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ vol: _vlcVolume }),
                }).catch(() => {});
            },
            configurable: true,
        });

        // Intercept mkAudio.pause() so MK pausing pauses VLC too.
        const _origPause = HTMLMediaElement.prototype.pause.bind(mkAudio);
        mkAudio.pause = () => {
            _origPause();
            fetch(`${ENGINE}/api/v1/vlc/pause`, { method: 'POST' }).catch(() => {});
        };

        // Load session into VLC and start playback.
        const vlcResp = await fetch(`${ENGINE}/api/v1/vlc/load`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: _sessionId, startMs: 0 }),
            signal: ctrl.signal,
        });
        if (!vlcResp.ok) throw new Error(`VLC load: ${await vlcResp.text()}`);

        if (ctrl.signal.aborted) return;

        // Advance MK's state machine: canplay → _nativePlay() → 'playing' event.
        mkAudio.addEventListener('canplay', () => {
            if (!ctrl.signal.aborted) _nativePlay().catch(e => console.warn('[AML Engine] play():', e));
        }, { once: true });
        mkAudio.dispatchEvent(new Event('canplay'));

        startVLCPoll(mkAudio);
        console.log(`[AML Engine] VLC playing +${((performance.now()-t0)/1000).toFixed(2)}s`);

        ctrl.signal.addEventListener('abort', () => {
            unbridgeDuration();
            stopVLCPoll();
        }, { once: true });

    } catch (err) {
        if (!_abortCtrl?.signal.aborted) console.error('[AML Engine] Playback error:', err);
        if (mkAudio) delete mkAudio.load;
    }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
    if (window.__amlEngineMounted) return;
    window.__amlEngineMounted = true;

    stubDRM();
    blockAppleCDN();

    // Feature-detect native ALAC MSE support (Chromium 116+ / Electron 38+).
    // When available we feed raw ALAC fMP4 directly to the SourceBuffer instead of
    // transcoding through ffmpeg, which preserves true lossless quality and enables
    // ?t= seeking via CBCSSeekableSource.
    _flacSupported = MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
    console.log(`[AML Engine] FLAC MSE: ${_flacSupported ? 'supported — lossless via FLAC transcode' : 'not supported — will transcode to AAC'}`);

    // Wait for the engine's SSE snapshot instead of polling GET /api/v1/status.
    // _amlEngine is injected by engine-sse-bundle.js which loads before us.
    try {
        const msg = await window._amlEngine?.waitFor('engine.snapshot', 8000);
        const snap = msg?.payload?.snapshot;
        const gen  = msg?.meta?.generation ?? '?';
        const why  = msg?.meta?.reason     ?? '?';
        _snapshotEventId = msg?.meta?.id ?? -1;  // used to filter stale replayed drm events
        if (snap?.capabilities) {
            _engineCaps = { lossless: !!snap.capabilities.lossless, atmos: !!snap.capabilities.atmos };
        }
        console.log(`[AML Engine] Engine ready — drm.session=${snap?.drm?.session ?? 'unknown'} lossless=${_engineCaps.lossless} gen=${gen} reason=${why} snapshotId=${_snapshotEventId}`);
    } catch (e) {
        console.warn('[AML Engine] Engine snapshot timeout:', e.message, '— continuing');
    }

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
            _engineCaps = { lossless: !!(snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        }
        console.log(`[AML Engine] DRM state → session=${sess} lossless=${_engineCaps.lossless}`);

        // DRM just became lossless-capable — reset so the next track gets a wait window.
        if (!wasLossless && _engineCaps.lossless) _losslessWaitDone = false;

        // Note: mid-track seamless lossless upgrade is intentionally not attempted here.
        // FLAC transcode streams start at position 0 with no seek support, making a
        // buffer-safe splice impossible. The next track will start in FLAC via
        // waitForLossless() at the top of handleTrackChange.
    });

    const mk = await waitForMusicKit();
    console.log('[AML Engine] MusicKit ready');

    installMKSeekInterceptor(mk);

    mk.addEventListener('nowPlayingItemDidChange', () => {
        handleTrackChange(mk);
        // Signal queue context to the prefetch scheduler.
        window._amlSmartCache?.onTrackChange(mk);
        // Track play frequency for startup warming and signal boosting.
        const item = mk.nowPlayingItem;
        if (item) {
            const id = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
            window._amlSmartCache?.recordPlay(id);
        }
    });

    mk.addEventListener('playbackStateDidChange', () => {
        const PS = window.MusicKit?.PlaybackStates;
        console.log(`[AML Engine] state=${mk.playbackState} (playing=${PS?.playing})`);
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



// ── Block native title tooltips ────────────────────────────────────────────
(function blockTitleTooltips() {
    const _sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        if (name === 'title') return;
        return _sa.call(this, name, value);
    };
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'title');
    if (desc) {
        Object.defineProperty(HTMLElement.prototype, 'title', {
            get: desc.get, set() {}, configurable: true,
        });
    }
    document.querySelectorAll('[title]').forEach(el => el.removeAttribute('title'));
})();

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
