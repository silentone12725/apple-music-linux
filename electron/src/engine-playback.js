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
        // MSE has data and session is active — play immediately via native.
        if (_sessionId && mkAudio.readyState >= 3) return _nativePlay();
        // Return a Promise that intentionally never resolves.
        //
        // MK calls audio.play() before our MSE is ready, gets this Promise,
        // and waits.  When our canplay handler fires _nativePlay(), the 'playing'
        // DOM event fires and MK's state machine transitions to "playing" (2)
        // through its own audio-element event listeners — without the Promise
        // ever resolving.
        //
        // If we resolved the Promise, MK's "after play() settled" handler runs
        // and calls audio.pause() because it sees CDN loading never completed.
        // Leaving it pending prevents that handler entirely.
        return new Promise(() => {}); // intentionally never resolves
    };

    console.log('[AML Engine] Play proxy installed');
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
let _abortCtrl   = null;
let _generation  = 0;

function deleteSession(id) {
    if (id) fetch(`${ENGINE}/api/v1/playback/${id}`, { method: 'DELETE' }).catch(() => {});
}

// ── MSE streaming ─────────────────────────────────────────────────────────────

async function pipeToSourceBuffer(sb, audio, streamUrl, signal, ms, durationSec, t0) {
    const resp = await fetch(streamUrl, { signal });
    if (!resp.ok) throw new Error(`Engine stream ${resp.status}`);
    console.log(`[AML Engine] Stream open +${((performance.now()-t0)/1000).toFixed(2)}s`);

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
        const bufEnd   = sb.buffered.end(sb.buffered.length - 1);

        // Cap look-ahead to 60 s so the buffer never fills with future data
        // (critical when ct≈0 and nothing before ct can be evicted).
        const maxAhead = ct + 60;
        if (bufEnd > maxAhead + 5) {
            await sbRemove(maxAhead, bufEnd);
            return;
        }

        // Standard eviction: drop data more than 5 s behind current position.
        const evictEnd = Math.max(0, ct - 5);
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

// ── Core playback handler ─────────────────────────────────────────────────────

async function handleTrackChange(mk) {
    const item = mk.nowPlayingItem;
    if (!item) return;

    const myGen = ++_generation;

    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }
    unbridgeDuration();
    deleteSession(_sessionId);
    _sessionId   = null;
    _durationSec = 0;

    const adamId = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
    const sf     = mk.storefrontId ?? 'us';
    if (!adamId) { console.warn('[AML Engine] No Adam ID'); return; }

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

    try {
        const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                assetId:    adamId,
                storefront: sf,
                capabilities: { lossless: false, video: false, atmos: false },
                token:         mk.developerToken ?? '',
                mediaUserToken: getMUT(),
            }),
        });
        if (!sessResp.ok) throw new Error(`Session ${sessResp.status}: ${await sessResp.text()}`);

        const sess = await sessResp.json();

        if (myGen !== _generation) { deleteSession(sess.sessionId); return; }

        _sessionId   = sess.sessionId;
        _durationSec = (sess.durationMs ?? 0) / 1000;
        console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now()-t0)/1000).toFixed(2)}s`);

        const needsTranscode = sess.codec === 'alac' || sess.codec === 'atmos';
        const audioPath = sess.streams?.audio ?? `/api/v1/playback/${_sessionId}/audio`;
        const streamUrl = `${ENGINE}${audioPath}${needsTranscode ? '?transcode=aac' : '?raw=1'}`;
        const mime      = 'audio/mp4; codecs="mp4a.40.2"';

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

        pipeToSourceBuffer(sb, mkAudio, streamUrl, ctrl.signal, ms, _durationSec, t0).catch(e => {
            if (!ctrl.signal.aborted) console.error('[AML Engine] MSE error:', e.message);
        });

        // _nativePlay() bypasses our play() proxy and starts audio directly.
        // The resulting 'playing' event resolves any pending proxy Promises MK
        // holds from its own audio.play() call earlier — MK transitions to
        // state=2 (playing) without us touching mk.play() at the API level.
        const tryPlay = () => {
            if (ctrl.signal.aborted) return;
            console.log(`[AML Engine] canplay → play() +${((performance.now()-t0)/1000).toFixed(2)}s`);
            _nativePlay().catch(e => console.warn('[AML Engine] play():', e));
        };
        if (mkAudio.readyState >= 3) {
            tryPlay();
        } else {
            mkAudio.addEventListener('canplay', tryPlay, { once: true });
        }

        ctrl.signal.addEventListener('abort', () => { unbridgeDuration(); }, { once: true });

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

    // Wait for the engine's SSE snapshot instead of polling GET /api/v1/status.
    // _amlEngine is injected by engine-sse-bundle.js which loads before us.
    try {
        const msg = await window._amlEngine?.waitFor('engine.snapshot', 8000);
        const snap = msg?.payload?.snapshot;
        const gen  = msg?.meta?.generation ?? '?';
        const why  = msg?.meta?.reason     ?? '?';
        console.log(`[AML Engine] Engine ready — drm.session=${snap?.drm?.session ?? 'unknown'} gen=${gen} reason=${why}`);
    } catch (e) {
        console.warn('[AML Engine] Engine snapshot timeout:', e.message, '— continuing');
    }

    // React to DRM state changes pushed over SSE (session lost, re-auth needed).
    window._amlEngine?.on('drm', (snap) => {
        const sess = snap?.state?.session ?? 'unknown';
        console.log(`[AML Engine] DRM state → session=${sess}`);
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
