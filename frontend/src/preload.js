(function injectAppleMusicStyles() {
    // Only inject once
    if (document.getElementById('wails-custom-style')) return;

    // Check if we are on Apple Music
    if (!window.location.hostname.includes('apple.com')) return;

    // ── Lossless SVG (white-filled) — fill set directly on <path> so WebKit
    //    doesn't inherit fill:none from the original <g fill="none"> group.
    const LOSSLESS_SVG = `<svg viewBox="0 0 69 44" xmlns="http://www.w3.org/2000/svg" style="height:13px;width:auto;vertical-align:middle;flex-shrink:0;" aria-label="Lossless"><path fill="#ffffff" fill-rule="nonzero" d="M36.8269026,4 C42.3794214,4 45.7184513,10.5183153 48.20334,17.4261699 L48.4450486,18.1066712 L48.6815356,18.788389 L48.9130884,19.4700271 C49.6770268,21.7405814 50.36352,23.9882073 51.0204784,25.9968947 C52.5296562,19.7123189 51.7381954,18.3629096 53.3551269,18.3629096 C53.9565751,18.3629096 54.5652965,18.7717786 54.5652965,19.5168498 C54.5652965,19.8184059 54.0740356,23.0143253 53.391361,26.2165815 L53.2651959,26.7982368 L53.1352128,27.3761743 C52.9156151,28.3341623 52.6817778,29.2605867 52.4420448,30.075084 C59.3914285,48.2833991 64.5514879,24.299737 65.134561,19.3973484 C65.2196627,18.6903693 65.7520794,18.3629223 66.2903224,18.3629223 C67.0092304,18.3629223 67.5985395,18.9043683 67.4862017,19.7191497 C66.2419581,27.647702 64.3284002,40 56.4607867,40 C52.1189889,40 49.6781873,36.6024859 47.7506208,32.7092263 C46.4116896,30.0790205 45.2734117,26.952661 44.2263394,23.8087368 L43.9767371,23.0541028 C43.8940827,22.8026091 43.811956,22.5512479 43.7303009,22.3002645 L43.4866946,21.5486922 C41.1040436,14.1741911 39.0830717,7.34159293 35.9851696,7.34159293 C34.4711899,7.34159293 33.3487598,8.92234593 33.2709954,8.92234593 C33.128169,8.92234593 33.0160746,8.27828447 31.602332,6.51365955 C32.9478242,4.97723054 34.8023002,4 36.8269026,4 Z M11.0614865,4.01937104 C23.4500006,4.01937104 24.5519172,36.7070003 31.5633281,36.7070003 C32.3865195,36.7070003 33.2738509,36.2079668 34.2437613,35.0776923 C34.7806086,35.9871115 35.3308882,36.7945268 35.9004521,37.5054184 C34.500923,39.1028534 32.7595403,39.9988275 30.578884,39.9988275 C22.7448451,39.9977315 19.3788608,26.8790797 16.4819088,18.0220558 C15.7996486,20.8631751 15.4455023,23.434387 15.3068631,24.5887478 C15.2208267,25.3223111 14.6831215,25.6566526 14.1414468,25.6566526 C13.5407541,25.6566526 12.9351571,25.2454896 12.9351571,24.5116332 C12.9351571,24.4569356 12.9385248,24.4004537 12.9455035,24.3422131 C13.346708,21.4307464 14.1551865,17.0196557 15.0604448,13.9441978 C13.8554484,10.7869356 12.3503425,7.33621492 10.1329104,7.33621492 C5.65625092,7.33621492 3.09261157,18.5867088 2.37169324,24.5887478 C2.28565683,25.3223111 1.74795163,25.6566526 1.20627691,25.6566526 C0.605597004,25.6566526 -7.10542736e-15,25.2454896 -7.10542736e-15,24.5116332 C-7.10542736e-15,24.4569356 0.00336770017,24.4004537 0.0103463944,24.3422131 C0.114233957,23.5883333 0.225608359,22.8207923 0.346678477,22.046953 L0.452878843,21.3822914 C0.470991821,21.2713147 0.48931555,21.1602523 0.50785647,21.0491258 L0.621759807,20.3817689 C2.0405473,12.2570738 4.68538356,4.01937104 11.0614865,4.01937104 Z M23.9155499,4.00146557 C26.1404345,4.00146557 28.5270839,5.15921632 30.5844926,7.87545613 C30.6994554,8.00734485 31.8526558,9.79953527 32.2166235,10.4208612 C33.474197,12.6992201 34.5694223,15.4837436 35.5796467,18.378952 L35.8413062,19.1364745 C38.7427747,27.6177062 40.980016,36.7463669 44.4650259,36.7463669 C45.2911112,36.7463669 46.1873164,36.2334422 47.1790849,35.0773864 C47.7158553,35.9867291 48.2660581,36.794068 48.835558,37.5049086 C47.4394606,39.099438 45.6989231,39.9988275 43.5140667,39.9988275 C31.1995909,39.9969924 29.8609621,7.32900175 23.0764932,7.32900175 C21.5454317,7.32900175 20.4138588,8.92244789 20.3357358,8.92244789 C20.1928455,8.92244789 20.0806102,8.27846289 18.6670468,6.51397816 C20.048649,4.9358122 21.9168263,4.00146557 23.9155499,4.00146557 Z"/></svg>`;

    // 1. Inject Styles
    const style = document.createElement('style');
    style.id = 'wails-custom-style';
    style.innerHTML = `
        /* Hide the Open in App buttons & Banners (NOT the Sign In button) */
        .native-cta__button, 
        .web-navigation__auth,
        cwc-upsell-banner,
        .locale-switcher-banner { 
            display: none !important; 
        }

        /* ── Hide the PREVIEW pill in the now-playing bar ── */
        /* Selector covers: cwc-badge[kind="preview"], .preview-badge,
           .web-chrome-playback-lcd__preview-badge, and any element whose
           visible text is exactly "PREVIEW" (caught by JS below). */
        cwc-badge[kind="preview"],
        .preview-badge,
        [data-testid="preview-badge"],
        .web-chrome-playback-lcd__preview-badge,
        .playback-preview-badge {
            display: none !important;
        }

        /* ── Lossless icon injected by JS ── */
        #aml-lossless-icon {
            display: inline-flex;
            align-items: center;
            margin-left: 6px;
            opacity: 0.85;
            pointer-events: none;
            /* CSS-level invert fallback for WebKit versions that ignore SVG fill */
            filter: brightness(0) invert(1);
        }
    `;

    const inject = () => {
        document.head.appendChild(style);
    };

    if (document.head) {
        inject();
    } else {
        document.addEventListener('DOMContentLoaded', inject);
    }

    // ── Swap PREVIEW badge → Lossless icon ──────────────────────────────────
    // The Apple Music SPA renders the now-playing bar dynamically; we use a
    // MutationObserver to detect when the PREVIEW badge appears and replace it.
    const LOSSLESS_ID = 'aml-lossless-icon';

    function injectLosslessIcon() {
        // 1. Find and hide any live PREVIEW badge (catches text-based badges
        //    that CSS selectors above may miss).
        document.querySelectorAll(
            'cwc-badge, .preview-badge, [class*="preview-badge"], [class*="PreviewBadge"]'
        ).forEach(el => {
            if (el.textContent.trim().toUpperCase() === 'PREVIEW') {
                el.style.setProperty('display', 'none', 'important');
            }
        });

        // 2. Find the now-playing LCD / track-info container to anchor the icon.
        //    Apple Music web uses several possible selectors across versions.
        const anchor =
            document.querySelector('.web-chrome-playback-lcd__track-name-wrapper') ||
            document.querySelector('.web-chrome-playback-lcd__song-name-wrapper') ||
            document.querySelector('[data-testid="lcd-track-name"]') ||
            document.querySelector('.lcd-track-name') ||
            document.querySelector('.playback-lcd__song') ||
            document.querySelector('.playback-lcd .track-name') ||
            document.querySelector('[class*="lcd"][class*="track"]');

        if (!anchor) return;

        // 3. Inject icon once per anchor (clean up stale copies first).
        if (anchor.querySelector('#' + LOSSLESS_ID)) return;

        const wrapper = document.createElement('span');
        wrapper.id = LOSSLESS_ID;
        wrapper.innerHTML = LOSSLESS_SVG;
        anchor.appendChild(wrapper);
    }

    // Run immediately and on every DOM mutation in the playback bar area.
    if (document.body) {
        injectLosslessIcon();
    }

    // Debounced MutationObserver: coalesce rapid SPA mutations into a single
    // check rather than firing querySelectorAll on every individual mutation.
    // Disconnect once the icon is successfully placed; reconnect only if it
    // disappears (e.g. after an SPA navigation replaces the playback bar).
    let debounceTimer = null;
    const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const iconAlreadyPresent = !!document.getElementById(LOSSLESS_ID);
            if (iconAlreadyPresent) return;
            observer.disconnect();
            injectLosslessIcon();
            // If icon was successfully placed, watch only for its removal.
            const icon = document.getElementById(LOSSLESS_ID);
            if (icon) {
                new MutationObserver((_, obs) => {
                    if (!document.getElementById(LOSSLESS_ID)) {
                        obs.disconnect();
                        startObserver();
                    }
                }).observe(document.body, { childList: true, subtree: true });
            } else {
                // Icon anchor not in DOM yet — keep watching broadly but debounced.
                startObserver();
            }
        }, 80);
    });
    const startObserver = () => {
        observer.observe(document.body, { childList: true, subtree: true });
        injectLosslessIcon();
    };

    if (document.body) {
        startObserver();
    } else {
        document.addEventListener('DOMContentLoaded', startObserver);
    }
})();

// ─── Credential Interception ───────────────────────────────────────────────
// Poll document.cookie every 2s for the media-user-token.
// Once found, securely store it via the Go keyring binding and stop polling.
// REQUIRED: apple-music-cli needs this token to stream lossless audio.
(function startCredentialPoller() {
    // Only run on the Apple Music origin
    if (!window.location.hostname.includes('apple.com')) return;

    // Avoid starting multiple pollers if the preload script is re-injected
    if (window.__wailsCredentialPollerActive) return;
    window.__wailsCredentialPollerActive = true;

    console.log('[Apple Music Linux] Credential poller started for CLI player.');

    const intervalId = setInterval(async () => {
        // Parse document.cookie for media-user-token
        const match = document.cookie
            .split('; ')
            .find(row => row.startsWith('media-user-token='));

        if (!match) return;

        const token = decodeURIComponent(match.split('=')[1]);
        if (!token) return;

        console.log('[Apple Music Linux] media-user-token detected! Storing securely for CLI player...');
        clearInterval(intervalId);
        window.__wailsCredentialPollerActive = false;

        try {
            // window.go.main.App is injected by Wails when
            // BindingsAllowedOrigins includes music.apple.com
            await window.go.main.App.StoreCredentials(token);
            console.log('[Apple Music Linux] Token stored successfully in OS keyring.');
        } catch (err) {
            console.error('[Apple Music Linux] Failed to store token:', err);
        }
    }, 2000);
})();


// ─── Playback Hijack ───────────────────────────────────────────────────────
(function startPlaybackHijack() {
    if (!window.location.hostname.includes('apple.com')) return;
    if (window.__wailsPlaybackHijackActive) return;
    window.__wailsPlaybackHijackActive = true;

    const overlay = document.createElement('div');
    overlay.id = 'aml-buffering-overlay';
    overlay.style.cssText = [
        'position: fixed',
        'inset: 0',
        'display: none',
        'align-items: center',
        'justify-content: center',
        'background: rgba(10, 10, 12, 0.55)',
        'backdrop-filter: blur(6px)',
        'z-index: 2147483647',
        'color: #fff',
        'font: 600 16px/1.2 "Nunito", system-ui, sans-serif',
        'letter-spacing: 0.02em'
    ].join(';');
    overlay.textContent = 'Buffering lossless playback...';

    const ensureOverlay = () => {
        if (!document.body) return;
        if (!document.getElementById(overlay.id)) {
            document.body.appendChild(overlay);
        }
    };

    const showOverlay = () => {
        ensureOverlay();
        overlay.style.display = 'flex';
    };

    const hideOverlay = () => {
        overlay.style.display = 'none';
    };

    const withBindings = () => window.go && window.go.main && window.go.main.App;

    let lastTrackId = '';
    let hijackInFlight = false;
    let hijackActive = false;
    let webVolume = null;

    const getKind = (item) => {
        if (!item) return '';
        const playParams = item.attributes && item.attributes.playParams ? item.attributes.playParams : {};
        const rawKind = (item.type || playParams.kind || item.attributes?.kind || '').toString();
        return rawKind.toLowerCase();
    };

    const isSongKind = (kind) => kind === 'song' || kind === 'songs';

    const setWebVolume = (music, value) => {
        try {
            if (music.player && typeof music.player.volume === 'number') {
                music.player.volume = value;
                return true;
            }
            if (typeof music.volume === 'number') {
                music.volume = value;
                return true;
            }
            if (typeof music.setVolume === 'function') {
                music.setVolume(value);
                return true;
            }
        } catch (e) {
            // ignore
        }
        return false;
    };

    const muteWebAudio = (music) => {
        if (webVolume === null) {
            webVolume = music.player && typeof music.player.volume === 'number' ? music.player.volume : music.volume;
        }
        setWebVolume(music, 0);
    };

    const restoreWebAudio = (music) => {
        if (webVolume === null) return;
        setWebVolume(music, webVolume);
        webVolume = null;
    };

    const stopHijack = async (music) => {
        if (!hijackActive) return;
        hijackActive = false;
        lastTrackId = '';
        try {
            await window.go.main.App.StopStreamPlayback();
        } catch (e) {
            // ignore
        }
        restoreWebAudio(music);
    };

    const tryHijack = async () => {
        if (hijackInFlight) return;
        if (!window.MusicKit || !window.MusicKit.getInstance) return;
        if (!withBindings()) return;

        const music = window.MusicKit.getInstance();
        const now = music.nowPlayingItem;
        if (!now || !now.attributes) return;

        const kind = getKind(now);
        if (!isSongKind(kind)) return;

        const trackId = now.id || (now.attributes.playParams && now.attributes.playParams.id) || '';
        if (!trackId || trackId === lastTrackId) return;

        // attributes.url is the canonical Apple Music song URL. When absent
        // (radio, curated streams, library-only items), build a /song/ URL from
        // the catalog ID so the CLI's ripSong path handles single-song lookup.
        const storefront = (music.storefrontId || 'us').toLowerCase().slice(0, 2);
        const trackUrl = now.attributes.url ||
            (trackId ? `https://music.apple.com/${storefront}/song/${trackId}` : '');
        if (!trackUrl) return;

        hijackInFlight = true;
        showOverlay();

        try {
            await window.go.main.App.StartStreamPlayback(trackUrl);
            lastTrackId = trackId;
            hijackActive = true;
            muteWebAudio(music);
        } catch (err) {
            console.error('[Apple Music Linux] Failed to start stream playback:', err);
        } finally {
            hideOverlay();
            hijackInFlight = false;
        }
    };

    const poll = setInterval(() => {
        if (!window.MusicKit || !window.MusicKit.getInstance) return;
        const music = window.MusicKit.getInstance();

        if (music.playbackState === 2) { // playing
            const now = music.nowPlayingItem;
            const kind = getKind(now);

            if (isSongKind(kind)) {
                tryHijack();
            } else {
                stopHijack(music);
            }
        } else if (music.playbackState === 1 || music.playbackState === 0) { // paused/stopped
            stopHijack(music);
        }
    }, 1000);

    window.addEventListener('beforeunload', () => clearInterval(poll));
})();

// ─── Settings: collapsible wrapper terminal ────────────────────────────────
// The wrapper process's Apple ID login is a startup flag, not a stdin
// prompt, so this panel doubles as the login form: typing "email:password"
// and pressing Enter relaunches the wrapper with that login. Its log output
// streams in here too, replacing the old custom login page. Modeled after
// pear-desktop's collapsible menu bar: a slim tab that drops an overlay down
// over the page only while open.
(function setupWrapperSettings() {
    if (!window.location.hostname.includes('apple.com')) return;
    if (window.__wailsWrapperSettingsActive) return;
    window.__wailsWrapperSettingsActive = true;

    const withBindings = () => window.go && window.go.main && window.go.main.App;

    const bar = document.createElement('button');
    bar.id = 'aml-settings-bar';
    bar.textContent = '⚙ Wrapper';
    bar.style.cssText = [
        'position: fixed', 'top: 0', 'right: 24px', 'z-index: 2147483647',
        'padding: 6px 14px', 'border: 1px solid rgba(255,255,255,0.1)', 'border-top: none',
        'border-radius: 0 0 10px 10px', 'background: rgba(20,20,22,0.92)',
        'color: rgba(255,255,255,0.65)', 'font: 600 11px -apple-system, sans-serif',
        'letter-spacing: 0.02em', 'cursor: pointer', 'backdrop-filter: blur(8px)',
        'transition: color 0.15s, background 0.15s'
    ].join(';');

    const panel = document.createElement('div');
    panel.id = 'aml-settings-panel';
    panel.style.cssText = [
        'position: fixed', 'top: 28px', 'right: 24px', 'z-index: 2147483646',
        'width: 440px', 'max-height: 0', 'opacity: 0', 'pointer-events: none',
        'display: flex', 'flex-direction: column', 'overflow: hidden',
        'background: rgba(18,18,20,0.97)', 'border: 1px solid rgba(255,255,255,0.1)',
        'border-radius: 0 0 12px 12px', 'box-shadow: 0 16px 48px rgba(0,0,0,0.55)',
        'font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        'transition: max-height 0.22s ease, opacity 0.18s ease'
    ].join(';');

    const logEl = document.createElement('div');
    logEl.id = 'aml-settings-log';
    logEl.style.cssText = [
        'flex: 1', 'min-height: 220px', 'max-height: 280px', 'overflow-y: auto',
        'padding: 10px 12px', 'color: rgba(255,255,255,0.8)',
        'white-space: pre-wrap', 'word-break: break-all'
    ].join(';');

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;border-top:1px solid rgba(255,255,255,0.08);';

    const input = document.createElement('input');
    input.placeholder = 'Apple ID:Password — press Enter to log in';
    input.style.cssText = [
        'flex: 1', 'padding: 9px 12px', 'background: transparent', 'border: none',
        'outline: none', 'color: #fff', 'font: inherit'
    ].join(';');

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.style.cssText = [
        'padding: 9px 14px', 'background: transparent', 'border: none',
        'color: #fc3c44', 'cursor: pointer', 'font: 600 12px inherit'
    ].join(';');

    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);
    panel.appendChild(logEl);
    panel.appendChild(inputRow);

    let renderedCount = 0;
    const renderLines = (lines) => {
        if (!lines || lines.length <= renderedCount) return;
        const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
        const fresh = lines.slice(renderedCount);
        logEl.textContent += (logEl.textContent ? '\n' : '') + fresh.join('\n');
        renderedCount = lines.length;
        if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    };
    const sendInput = async () => {
        const text = input.value;
        if (!text || !withBindings()) return;
        input.value = '';
        try {
            await window.go.main.App.WrapperSendInput(text);
        } catch (err) {
            logEl.textContent += (logEl.textContent ? '\n' : '') + '[settings] failed to send input: ' + err;
            logEl.scrollTop = logEl.scrollHeight;
        }
    };

    sendBtn.addEventListener('click', sendInput);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendInput();
    });

    let open = false;
    let pollHandle = null;
    const poll = async () => {
        if (!withBindings()) return;
        try {
            renderLines(await window.go.main.App.WrapperLogs());
        } catch (e) {
            // wrapper not running yet
        }
    };

    const setOpen = (next) => {
        open = next;
        panel.style.maxHeight = open ? '360px' : '0';
        panel.style.opacity = open ? '1' : '0';
        panel.style.pointerEvents = open ? 'auto' : 'none';
        if (open) {
            poll();
            if (!pollHandle) pollHandle = setInterval(poll, 1000);
        } else if (pollHandle) {
            clearInterval(pollHandle);
            pollHandle = null;
        }
    };

    bar.addEventListener('click', () => setOpen(!open));

    const mount = () => {
        document.body.appendChild(bar);
        document.body.appendChild(panel);
    };
    if (document.body) {
        mount();
    } else {
        document.addEventListener('DOMContentLoaded', mount);
    }

    // Best-effort live push in addition to the polling above.
    const subscribeToLogs = () => {
        if (!window.runtime || !window.runtime.EventsOnMultiple) return false;
        window.runtime.EventsOnMultiple('wrapper:log', (line) => {
            renderedCount++;
            logEl.textContent += (logEl.textContent ? '\n' : '') + line;
            logEl.scrollTop = logEl.scrollHeight;
        }, -1);
        return true;
    };
    if (!subscribeToLogs()) {
        let attempts = 0;
        const retry = setInterval(() => {
            if (subscribeToLogs() || ++attempts > 60) clearInterval(retry);
        }, 500);
    }
})();
