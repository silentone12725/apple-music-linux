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

// ── Engine capability snapshot (from SSE) ─────────────────────────────────────

let _engineCaps      = { lossless: false, atmos: false };
let _alacSupported    = false;  // MediaSource.isTypeSupported('audio/mp4; codecs="alac"') at setup()
let _sessionLossless  = false;  // true when current session is streaming raw ALAC (not transcoded)
let _upgradeInFlight  = false;  // guard: only one seamless lossless upgrade at a time
let _losslessWaitDone = false;  // true after waitForLossless has timed out once — skip future waits

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
        if (_sessionId && mkAudio.readyState >= 3) {
            _nativePlay().catch(() => {});
        }
        return new Promise(() => {}); // intentionally never resolves
    };

    console.log('[AML Engine] Play proxy installed');
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

    const evictPlayed = async () => {
        if (sb.buffered.length === 0) return;
        const ct       = audio.currentTime;
        const bufStart = sb.buffered.start(0);

        // Drop data more than 30 s behind current position.
        // Keeping 30 s allows backward seeks without a re-request.
        // We no longer cap look-ahead: the entire track can buffer ahead,
        // which lets forward seeks find data without restarting the stream.
        const evictEnd = Math.max(0, ct - 30);
        if (evictEnd > bufStart + 1) {
            await sbRemove(bufStart, evictEnd);
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
        await waitUpdate();
        if (sb.updating) await waitUpdate(); // guard against appendBuffer overlap
        try {
            sb.appendBuffer(value);
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                await evictPlayed();
                await waitUpdate();
                sb.appendBuffer(value);
            } else { throw e; }
        }
    }

    await waitUpdate();
    if (ms.readyState === 'open') {
        if (durationSec > 0) { try { ms.duration = durationSec; } catch (_) {} }
        ms.endOfStream();
        console.log(`[AML Engine] Stream complete +${((performance.now()-t0)/1000).toFixed(2)}s`);
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
    // If seek target is already buffered, let the browser handle it natively.
    for (let i = 0; i < sb.buffered.length; i++) {
        if (seekSec >= sb.buffered.start(i) - 0.5 && seekSec < sb.buffered.end(i)) return;
    }

    // Engine advertises whether ?t= restart is supported for this codec.
    // For ALAC/Atmos (transcoded), the engine can't seek mid-stream.
    if (!_seekable) return;

    // Fetch first — before touching the SourceBuffer.
    // If the stream isn't seekable (ALAC/Atmos transcode path), the engine
    // returns a non-2xx response.  In that case we bail out with the buffer
    // intact so the user can still seek within already-buffered data.
    const seekUrl = `${_activeStreamBase}&t=${seekSec.toFixed(3)}`;
    let resp;
    try {
        resp = await fetch(seekUrl, { signal: _abortCtrl?.signal });
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[AML Engine] Seek fetch error:', e.message);
        return;
    }
    if (!resp.ok) {
        console.warn(`[AML Engine] Seek not supported for this stream (${resp.status}) — seeking only within buffered range`);
        return;
    }

    // Guard: track may have changed while the fetch was in flight.
    if (_abortCtrl?.signal.aborted) return;

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
        // Diagnostic: verify engine segment, MSE timeline, and playhead agree.
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
        _nativePlay().catch(e => console.warn('[AML Engine] seek play():', e));
    }, { once: true });
}

// ── Seamless lossless upgrade ─────────────────────────────────────────────────
//
// When DRM becomes valid after an AAC session is already playing, splice in a
// native ALAC stream at a future "seam" point via SourceBuffer.changeType().
// The existing AAC data before the seam keeps playing without interruption;
// ALAC replaces everything from the seam onward.
//
// Requires: _alacSupported (Chromium 116+), an active MSE session, and enough
// track remaining (≥20 s). The ALAC session's CBCSSeekableSource supports ?t=
// (same as AAC's HLSSeekableSource), so we can pre-fetch from the exact segment
// boundary reported in X-Actual-Start before touching the SourceBuffer.
async function scheduleLosslessUpgrade(mk) {
    if (_upgradeInFlight) return;
    _upgradeInFlight = true;

    const myGen = _generation;
    const ctrl  = _abortCtrl;
    const audio = getMKAudio();
    const sb    = _activeSb;
    const ms    = _activeMs;

    if (!audio || !sb || !ms || ms.readyState !== 'open') {
        _upgradeInFlight = false; return;
    }

    // Need ≥20 s of track remaining so the splice is worth the overhead.
    const seam = audio.currentTime + 10;
    if (!_durationSec || seam >= _durationSec - 10) {
        _upgradeInFlight = false; return;
    }

    const item = mk.nowPlayingItem;
    if (!item) { _upgradeInFlight = false; return; }
    const adamId = item.playParams?.catalogId
        ?? item.attributes?.playParams?.catalogId
        ?? item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
    const sf = mk.storefrontId ?? 'us';

    console.log(`[AML Engine] Lossless upgrade: opening ALAC session, seam=${seam.toFixed(1)}s`);

    // Open a parallel lossless session for the same track.
    let newSess;
    try {
        const r = await fetch(`${ENGINE}/api/v1/playback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assetId: adamId, storefront: sf,
                capabilities: { lossless: true, video: false, atmos: false },
                token: mk.developerToken ?? '',
                mediaUserToken: getMUT(),
            }),
            signal: ctrl?.signal,
        });
        if (!r.ok) throw new Error(`Session ${r.status}: ${await r.text()}`);
        newSess = await r.json();
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[AML Engine] Lossless upgrade: session failed:', e.message);
        _upgradeInFlight = false; return;
    }

    if (myGen !== _generation || ctrl?.signal.aborted) {
        deleteSession(newSess.sessionId); _upgradeInFlight = false; return;
    }

    // If the engine still returned AAC (DRM not fully ready despite the SSE event),
    // there's nothing to upgrade to — bail out cleanly.
    if (newSess.codec !== 'alac') {
        console.log('[AML Engine] Lossless upgrade: engine returned non-ALAC codec — skipping');
        deleteSession(newSess.sessionId); _upgradeInFlight = false; return;
    }

    const audioPath = newSess.streams?.audio ?? `/api/v1/playback/${newSess.sessionId}/audio`;
    const newBase   = `${ENGINE}${audioPath}?raw=1`;
    const seamUrl   = `${newBase}&t=${seam.toFixed(3)}`;

    // Pre-fetch the ALAC stream starting at the seam BEFORE touching the SourceBuffer.
    // If this fetch fails the existing AAC session remains intact.
    // X-Actual-Start carries the real HLS segment boundary the engine started from.
    let seamResp;
    try {
        seamResp = await fetch(seamUrl, { signal: ctrl?.signal });
        if (!seamResp.ok) throw new Error(`Stream ${seamResp.status}`);
    } catch (e) {
        if (e.name !== 'AbortError') console.warn('[AML Engine] Lossless upgrade: seam fetch failed:', e.message);
        deleteSession(newSess.sessionId); _upgradeInFlight = false; return;
    }

    const actualStart = parseFloat(seamResp.headers.get('X-Actual-Start') ?? seam);
    console.log(`[AML Engine] Lossless upgrade: ALAC stream starts at actualStart=${actualStart.toFixed(2)}s`);

    // Wait until playback is within 2 s of the splice point.
    await new Promise(resolve => {
        const check = () => {
            if (myGen !== _generation || ctrl?.signal.aborted || audio.currentTime >= actualStart - 2) resolve();
            else setTimeout(check, 200);
        };
        check();
    });

    if (myGen !== _generation || ctrl?.signal.aborted) {
        seamResp.body?.cancel();
        deleteSession(newSess.sessionId); _upgradeInFlight = false; return;
    }

    const oldSessionId = _sessionId;
    const waitSBIdle = () => new Promise((res, rej) => {
        if (!sb.updating) return res();
        sb.addEventListener('updateend', res, { once: true });
        sb.addEventListener('error', rej, { once: true });
    });

    // Abort the current AAC pipe; clear the SourceBuffer from actualStart onward.
    if (_pipeCtrl) { _pipeCtrl.abort(); _pipeCtrl = null; }
    try {
        await waitSBIdle();
        if (ms.readyState === 'open') sb.remove(actualStart, Infinity);
        await waitSBIdle();
    } catch (_) {}

    if (myGen !== _generation || ctrl?.signal.aborted) {
        seamResp.body?.cancel();
        deleteSession(newSess.sessionId); _upgradeInFlight = false; return;
    }

    // Switch the SourceBuffer decoder context to ALAC.
    // Existing AAC data before actualStart stays buffered and decodable; the browser
    // transitions cleanly at the segment boundary when it encounters the ALAC init segment.
    try {
        sb.changeType('audio/mp4; codecs="alac"');
    } catch (e) {
        console.warn('[AML Engine] changeType("alac") failed:', e.message, '— resuming AAC');
        seamResp.body?.cancel();
        deleteSession(newSess.sessionId);
        // Resume the old AAC stream from actualStart so playback isn't interrupted.
        if (_activeStreamBase && ms.readyState === 'open') {
            _pipeCtrl = new AbortController();
            pipeToSourceBuffer(sb, audio, `${_activeStreamBase}&t=${actualStart.toFixed(3)}`,
                _pipeCtrl.signal, ms, _durationSec, performance.now()).catch(() => {});
        }
        _upgradeInFlight = false; return;
    }

    // Promote the new ALAC session to be the active session.
    // seekToTime() reads _activeStreamBase and _sessionId, so update them now.
    _sessionId        = newSess.sessionId;
    _sessionLossless  = true;
    _activeStreamBase = newBase;
    _seekable         = true;  // CBCSSeekableSource supports ?t=

    // Pipe the pre-fetched response body — avoids a second round-trip to the engine.
    _pipeCtrl = new AbortController();
    const pipeCtrl = _pipeCtrl;
    pipeToSourceBuffer(sb, audio, seamResp, pipeCtrl.signal, ms, _durationSec, performance.now()).catch(e => {
        if (!pipeCtrl.signal.aborted) console.error('[AML Engine] ALAC upgrade pipe error:', e.message);
    });

    showQualityBadge('alac', newSess.sampleRate, newSess.bitDepth);
    console.log(`[AML Engine] Lossless upgrade complete → ALAC ${newSess.sampleRate}Hz/${newSess.bitDepth}bit`);

    deleteSession(oldSessionId);
    _upgradeInFlight = false;
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
    unbridgeDuration();
    deleteSession(_sessionId);
    _sessionId        = null;
    _durationSec      = 0;
    _seekable         = false;
    _sessionLossless  = false;
    _upgradeInFlight  = false;
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
        mkAudio.pause();
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
        console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s seekable=${_seekable} +${((performance.now()-t0)/1000).toFixed(2)}s`);

        showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);

        // Native ALAC path: Chromium 116+ (Electron 38) can decode ALAC fMP4 in MSE
        // without transcoding. ?raw=1 passes the encrypted-then-decrypted ALAC fMP4
        // straight to the SourceBuffer; CBCSSeekableSource also supports ?t= seeking.
        // Fall back to ?transcode=aac when ALAC MSE is not available.
        const useRawLossless = sess.codec === 'alac' && _alacSupported;
        const needsTranscode = (sess.codec === 'alac' || sess.codec === 'atmos') && !useRawLossless;
        const audioPath  = sess.streams?.audio ?? `/api/v1/playback/${_sessionId}/audio`;
        const streamBase = `${ENGINE}${audioPath}${needsTranscode ? '?transcode=aac' : '?raw=1'}`;
        const mime       = useRawLossless ? 'audio/mp4; codecs="alac"' : 'audio/mp4; codecs="mp4a.40.2"';
        _sessionLossless = useRawLossless;
        if (useRawLossless) _seekable = true;  // CBCSSeekableSource always supports ?t=

        _abortCtrl = new AbortController();
        const ctrl = _abortCtrl;

        if (!mkAudio) throw new Error('MK audio element not found');

        const ms      = new MediaSource();
        const blobUrl = URL.createObjectURL(ms);
        _nativeSrcSet.call(mkAudio, blobUrl);

        // Lift load() shadow for our one controlled call, then re-block.
        delete mkAudio.load;
        HTMLMediaElement.prototype.load.call(mkAudio);
        mkAudio.load = () => {};

        await new Promise((resolve, reject) => {
            ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            ms.addEventListener('sourceopen', resolve, { once: true });
        });
        URL.revokeObjectURL(blobUrl);
        console.log(`[AML Engine] MSE sourceopen +${((performance.now()-t0)/1000).toFixed(2)}s`);

        if (_durationSec > 0) { try { ms.duration = _durationSec; } catch (_) {} }

        const sb = ms.addSourceBuffer(mime);
        bridgeDuration(mk, _durationSec);

        // Apple Music HLS fMP4 segments carry a non-zero initial baseMediaDecodeTime.
        // MSE won't advance readyState past HAVE_METADATA (1) until currentTime is
        // inside the buffered range. After loadedmetadata (init segment processed,
        // no media data yet), wait for the first media segment to land, then snap
        // currentTime to the buffer start if it would otherwise sit below it.
        // Log SourceBuffer errors — these fire when appendBuffer data is rejected
        // (wrong codec string, malformed fMP4, etc.) but don't throw to caller.
        sb.addEventListener('error', (e) => {
            console.error(`[AML Engine] SourceBuffer error readyState=${mkAudio.readyState} buffered.length=${sb.buffered.length}`, e);
        });

        mkAudio.addEventListener('loadedmetadata', function onMeta() {
            const snapToBuffer = (attempt) => {
                if (ctrl.signal.aborted) return;
                const blen = sb.buffered.length;
                if (blen > 0) {
                    const bufStart = sb.buffered.start(0);
                    if (bufStart > mkAudio.currentTime + 0.1) {
                        mkAudio.currentTime = bufStart;
                    }
                } else {
                    sb.addEventListener('updateend', () => snapToBuffer(attempt + 1), { once: true });
                }
            };
            snapToBuffer(0);
        }, { once: true });

        // Expose MSE state for seekToTime().
        _activeSb = sb; _activeMs = ms; _activeStreamBase = streamBase;

        // Create a pipe-level controller (separate from the session controller).
        // seekToTime() aborts only _pipeCtrl; track changes abort both.
        _pipeCtrl = new AbortController();
        const pipeCtrl = _pipeCtrl;
        pipeToSourceBuffer(sb, mkAudio, streamBase, pipeCtrl.signal, ms, _durationSec, t0).catch(e => {
            if (!pipeCtrl.signal.aborted) console.error('[AML Engine] MSE error:', e.message);
        });

        // MV: inject video stream concurrently with audio.
        if (sess.type === 'mv' && sess.streams?.video) {
            startMVVideoInjection(sess.streams.video, ctrl, mkAudio, t0).catch(e => {
                if (!ctrl.signal.aborted) console.error('[AML Engine] MV video error:', e.message);
            });
        }

        // Seeking handler — installed only after canplay so that MK's internal
        // currentTime adjustments during MSE setup never abort the initial pipe.
        const onSeeking = () => {
            if (ctrl.signal.aborted) return;
            seekToTime(mkAudio.currentTime, mkAudio, sb, ms);
        };

        // _nativePlay() bypasses our play() proxy and starts audio directly.
        const tryPlay = () => {
            console.log(`[AML Engine] tryPlay aborted=${ctrl.signal.aborted} readyState=${mkAudio.readyState} +${((performance.now()-t0)/1000).toFixed(2)}s`);
            if (ctrl.signal.aborted) return;
            console.log(`[AML Engine] canplay → play() +${((performance.now()-t0)/1000).toFixed(2)}s`);
            // Safe to handle seeks now that we have an established buffer.
            mkAudio.addEventListener('seeking', onSeeking);
            _nativePlay().catch(e => console.warn('[AML Engine] play():', e));
        };
        if (mkAudio.readyState >= 3) {
            tryPlay();
        } else {
            mkAudio.addEventListener('canplay', tryPlay, { once: true });
        }

        ctrl.signal.addEventListener('abort', () => {
            mkAudio.removeEventListener('seeking', onSeeking);
            unbridgeDuration();
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
    _alacSupported = MediaSource.isTypeSupported('audio/mp4; codecs="alac"');
    console.log(`[AML Engine] ALAC MSE: ${_alacSupported ? 'native (no transcode)' : 'not supported — will transcode to AAC'}`);

    // Wait for the engine's SSE snapshot instead of polling GET /api/v1/status.
    // _amlEngine is injected by engine-sse-bundle.js which loads before us.
    try {
        const msg = await window._amlEngine?.waitFor('engine.snapshot', 8000);
        const snap = msg?.payload?.snapshot;
        const gen  = msg?.meta?.generation ?? '?';
        const why  = msg?.meta?.reason     ?? '?';
        if (snap?.capabilities) {
            _engineCaps = { lossless: !!snap.capabilities.lossless, atmos: !!snap.capabilities.atmos };
        }
        console.log(`[AML Engine] Engine ready — drm.session=${snap?.drm?.session ?? 'unknown'} lossless=${_engineCaps.lossless} gen=${gen} reason=${why}`);
    } catch (e) {
        console.warn('[AML Engine] Engine snapshot timeout:', e.message, '— continuing');
    }

    // React to DRM state changes pushed over SSE (session lost, re-auth, lossless ready).
    window._amlEngine?.on('drm', (snap) => {
        const wasLossless = _engineCaps.lossless;
        const sess = snap?.state?.session ?? 'unknown';
        if (snap?.capabilities) {
            // SSE drm events carry the raw DRMSnapshot: field is "alac", not "lossless"
            _engineCaps = { lossless: !!(snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        }
        console.log(`[AML Engine] DRM state → session=${sess} lossless=${_engineCaps.lossless}`);

        // DRM just became lossless-capable — reset so the next track gets a wait window.
        if (!wasLossless && _engineCaps.lossless) _losslessWaitDone = false;

        // Seamless lossless upgrade: DRM just became valid while an AAC session is live.
        // Schedule the changeType() splice only when native ALAC MSE is available —
        // the transcode path doesn't support mid-track switching (no ?t= on the AAC output).
        if (!wasLossless && _engineCaps.lossless && _sessionId && !_sessionLossless && _alacSupported && !_upgradeInFlight) {
            const mkInst = window.MusicKit?.getInstance?.();
            if (mkInst) {
                scheduleLosslessUpgrade(mkInst).catch(e => {
                    if (e.name !== 'AbortError') console.warn('[AML Engine] Upgrade error:', e.message);
                    _upgradeInFlight = false;
                });
            }
        }
    });

    const mk = await waitForMusicKit();
    console.log('[AML Engine] MusicKit ready');

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
