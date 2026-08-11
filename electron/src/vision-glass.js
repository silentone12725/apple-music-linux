/**
 * vision-glass.js — visionOS glass + event-driven art tinting
 *
 * Improvements applied:
 *  1. Art tinting is MutationObserver-driven (no more 2s poll)
 *  2. All glass values driven by CSS custom properties
 *  3. Single Constructable StyleSheet — no tag duplication after SPA nav
 *  4. Resilient selectors (role/nav tag only — no Svelte hash classes)
 */

// ── Show-when-ready signal ────────────────────────────────────────────────────
(function detectUIReady() {
    if (typeof window.amlReady !== 'function') return;
    if (window._amlReadyFired) return;

    // Poll the engine's DRM status until FairPlay (or Widevine) reports ready.
    // Returns true as soon as either is ready, false after exhausting retries.
    const waitForDRM = async (maxMs = 10000) => {
        const engine = window._amlEngineURL || 'http://127.0.0.1:9823';
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
            try {
                const d = await fetch(`${engine}/api/v1/drm/status`).then(r => r.json());
                const s = d?.state ?? d ?? {};
                if (s.fairplay === 'ready' || s.widevine === 'ready') return true;
            } catch { /* engine not up yet — keep polling */ }
            await new Promise(r => setTimeout(r, 400));
        }
        return false; // timed out — let the 12 s main-process fallback handle it
    };

    const fire = async () => {
        if (window._amlReadyFired) return;
        await waitForDRM(10000);
        if (window._amlReadyFired) return;
        window._amlReadyFired = true;
        window.amlReady();
    };

    const checkPage = () => {
        const nav = document.querySelector('nav.navigation');
        if (!nav || nav.children.length === 0) return false;
        // Also wait for the player bar — confirms MusicKit has initialised
        return !!document.querySelector('.web-chrome-playback-lcd, .player-lcd, [data-testid="lcd-metadata"]');
    };

    if (checkPage()) { fire(); return; }
    const obs = new MutationObserver(() => { if (checkPage()) { obs.disconnect(); fire(); } });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); fire(); }, 10000);
})();

// ── CSS custom properties ─────────────────────────────────────────────────────
// All tuneable values live here. main.mjs writes only these vars when the
// user changes a View menu setting — no style regeneration needed.
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :root {
    --aml-glass-blur:    20px;
    --aml-glass-opacity: 0.07;
    /* Art tint — updated by MutationObserver when album art changes */
    --aml-art-r: 255;
    --aml-art-g: 255;
    --aml-art-b: 255;
    --aml-art-tint: rgba(var(--aml-art-r), var(--aml-art-g), var(--aml-art-b), 0.4);
  }

  html, body { background: transparent !important; }

  /* ── Sidebar glass ──
     Confirmed stable selector. Svelte hash classes change on every deploy;
     nav.navigation (tag + base class) is stable across versions. */
  nav.navigation {
    background: var(--aml-nav-bg, color-mix(
      in srgb,
      rgba(255, 255, 255, var(--aml-glass-opacity)) 80%,
      var(--aml-art-tint) 20%
    )) !important;
    backdrop-filter: blur(var(--aml-glass-blur)) saturate(2.2) brightness(1.08) !important;
    -webkit-backdrop-filter: blur(var(--aml-glass-blur)) saturate(2.2) brightness(1.08) !important;
    border-right: 1px solid var(--aml-nav-border, rgba(255,255,255,0.12)) !important;
    box-shadow: 1px 0 32px rgba(0,0,0,0.18) !important;
    transition: background 1.4s ease !important;
    color: var(--aml-nav-text, inherit) !important;
  }

  /* Strip backgrounds only from layout shells while hovered — :not(:hover)
     yields to Apple Music's native Svelte-scoped hover CSS on hover. */
  nav.navigation > li:not(:hover),
  nav.navigation > ul:not(:hover),
  nav.navigation > div:not(:hover),
  nav.navigation > section:not(:hover) {
    background: transparent !important;
  }
  nav.navigation [class*="active"],
  nav.navigation [class*="selected"] {
    background: var(--aml-accent-active, rgba(255,255,255,0.12)) !important;
    border-radius: 8px !important;
  }


  /* ── Vignette removal — content-scope-bar has a dark solid + gradient that shows as black bar when inactive ── */
  [class*="content-scope-bar"] { background: transparent !important; }

  /* ── Footer removal ── */
  footer, [class*="footer-wrapper"] { display: none !important; }

  /* ── Player bar clearance — pad scrollable page so content never hides under the 54px bar ── */
  [class*="scrollable-page"] { padding-bottom: 72px !important; }

  /* ── Songs library column header bar — glass-themed instead of solid dark ── */
  [class*="library-track--header"] {
    background: rgba(255,255,255,0.05) !important;
    backdrop-filter: blur(20px) saturate(1.8) !important;
    -webkit-backdrop-filter: blur(20px) saturate(1.8) !important;
    border-bottom: 0.5px solid rgba(255,255,255,0.10) !important;
    color: rgba(255,255,255,0.45) !important;
  }
  [class*="library-track--header"] * {
    color: rgba(255,255,255,0.45) !important;
    font-size: 11px !important;
    letter-spacing: 0.04em !important;
    text-transform: uppercase !important;
  }

  /* ── Strip alternating row zebra striping in virtual lists ── */
  [class*="row-zebra-striping"] [class*="virtual-row"],
  [class*="songs-list__item--alternate"],
  [class*="songs-list__item--odd"],
  [class*="songs-list__item--even"] { background: transparent !important; }

  /* Stats injected into headings element by JS (initTracklistStatsInHeader).
     No grid-template-areas override — Apple's native two-column desktop layout
     is preserved; stats flows as a block after the subtitle inside headings. */
  #aml-tracklist-stats {
    display: block;
    font-size: 13px;
    color: rgba(255,255,255,0.52);
    margin: 4px 0 0;
    padding: 0;
    letter-spacing: 0.01em;
  }


  /* ── Library scope bar — glass pill container + selected chip ──
     Selectors use 3 attribute chains (specificity 0,3,0) to beat Apple's
     Svelte-scoped 2-class rules (0,2,0) even with equal !important weight. */
  [class*="pill-container"] {
    background: rgba(255,255,255,0.08) !important;
    backdrop-filter: blur(20px) saturate(1.8) !important;
    -webkit-backdrop-filter: blur(20px) saturate(1.8) !important;
    border: 0.5px solid rgba(255,255,255,0.12) !important;
    border-radius: 9999px !important;
    padding: 3px !important;
  }
  [class*="pill-container"] [class*="pill-option"] {
    position: relative !important;
    border-radius: 9999px !important;
    transition: background 0.18s ease !important;
  }
  /* White glass pill overlay via ::before — unaffected by Apple's background rules */
  [class*="pill-container"] [class*="pill-option--selected"]::before {
    content: '' !important;
    display: block !important;
    position: absolute !important;
    inset: 0 !important;
    border-radius: 9999px !important;
    background: rgba(255,255,255,0.13) !important;
    backdrop-filter: blur(12px) !important;
    -webkit-backdrop-filter: blur(12px) !important;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12), inset 0 0 0 0.5px rgba(255,255,255,0.18) !important;
    pointer-events: none !important;
    z-index: 0 !important;
  }
  /* Keep label text above the overlay */
  [class*="pill-container"] [class*="pill-option"] [class*="pill-label"] {
    position: relative !important;
    z-index: 1 !important;
  }
  [class*="pill-container"] [class*="pill-option"] [class*="pill-label"] {
    color: rgba(255,255,255,0.45) !important;
    transition: color 0.15s !important;
  }
  [class*="pill-container"] [class*="pill-option--selected"] [class*="pill-label"] {
    color: rgba(255,255,255,0.95) !important;
    font-weight: 600 !important;
  }

  /* ── Accessory button select (Playlist Type, Sort dropdowns) — strip dark background ──
     Apple: .select.svelte-XXXX = specificity 0,2,0. Use 3 attr selectors (0,3,0) to win. */
  [class*="accessory-button"] [class*="select"][class*="svelte"],
  [class*="accessory-button"] [class*="select-text"][class*="svelte"],
  [class*="accessory-button"] [class*="select-chevron"][class*="svelte"] {
    background: transparent !important;
    background-color: transparent !important;
  }

  /* ── Sidebar scrollbar fix ──
     Apple sets scrollbar-width:thin on the nav container, which suppresses
     ::-webkit-scrollbar pseudo-elements entirely in Chrome 121+. Force auto
     to restore webkit control, then apply custom styles. */
  [class*="navigation__scrollable"][class*="svelte"] { scrollbar-width: auto !important; }
  [class*="navigation__scrollable"]::-webkit-scrollbar       { width: 3px !important; }
  [class*="navigation__scrollable"]::-webkit-scrollbar-track { background: transparent !important; box-shadow: none !important; }
  [class*="navigation__scrollable"]::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.28) !important; border-radius: 9999px !important; border: none !important; }
  [class*="navigation__scrollable"]::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.55) !important; }
  [class*="navigation__scrollable"]:hover::-webkit-scrollbar { width: 7px !important; }

  /* ── Account button — strip pill, keep context menu ──
     Apple: .account-menu.svelte-XXXX.account-menu--expanded = 3 classes (0,3,0).
     Ancestor + 2 self attr selectors = (0,3,0); adoptedStyleSheets wins the cascade tie. */
  [class*="navigation"] [class*="account-menu"][class*="svelte"] {
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
  }
  [class*="navigation"] [class*="account-menu"][class*="svelte"]:hover {
    background: rgba(255,255,255,0.08) !important;
    border-radius: 8px !important;
  }

  /* ── Search bar glass ──
     JS portal (initSearchSuggestionsPortal in engine-playback.js) moves
     .search-suggestions to <body> when Svelte mounts it, so the wrapper's
     compositing layer no longer traps the dropdown's backdrop-filter.
     Both can now blur independently and always-on. */
  [class*="search-input-wrapper"] {
    background: rgba(255,255,255,0.11) !important;
    backdrop-filter: blur(24px) saturate(1.8) !important;
    -webkit-backdrop-filter: blur(24px) saturate(1.8) !important;
    border: 0.5px solid rgba(255,255,255,0.18) !important;
    border-radius: 9999px !important;
    box-shadow: none !important;
  }
  /* Strip the inner input's own background so it doesn't double-layer */
  [class*="search-input__text-field"],
  [id="search-input__text-field"] {
    background: transparent !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
    border: none !important;
    box-shadow: none !important;
  }

/* ── Search suggestions dropdown glass ──
     Dark tint + blur matches the player bar look: blurred wallpaper shows through.
     Apple uses .search-suggestions.svelte-XXXX (specificity 0,2,0).
     Chain two attribute selectors to match; adoptedStyleSheets wins cascade ties. */
  [class*="search-suggestions"][class*="svelte"] {
    background: rgba(14,14,18,0.55) !important;
    backdrop-filter: blur(32px) saturate(1.8) brightness(0.92) !important;
    -webkit-backdrop-filter: blur(32px) saturate(1.8) brightness(0.92) !important;
    border: 0.5px solid rgba(255,255,255,0.10) !important;
    border-radius: 12px !important;
    box-shadow: 0 8px 32px rgba(0,0,0,0.35) !important;
  }
  /* Search hint icons — SVGs inside hint rows are black by default; make them white */
  [class*="search-suggestions"] [class*="search-hint"] > svg,
  [class*="search-suggestions"] [class*="search-hint"] > svg path {
    fill: rgba(255,255,255,0.5) !important;
  }

  /* ── iOS/iPadOS-style back + forward navigation buttons (sidebar header row) ── */
  #aml-nav-buttons {
    position: absolute;
    /* top / height set by JS after measuring the header row */
    right: 8%;
    display: flex;
    gap: 8px;
    align-items: center;
    z-index: 20;
    -webkit-app-region: no-drag;
    min-height: 44px;
  }
  nav.navigation { position: relative !important; overflow: visible !important; }
  .aml-nav-btn {
    /* explicit box model — hit area == visual circle */
    box-sizing: border-box !important;
    width: 30px !important;
    height: 30px !important;
    min-width: 30px !important;
    min-height: 30px !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 50% !important;
    border: none !important;
    cursor: pointer;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    background: rgba(255,255,255,0.13) !important;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.20) !important;
    transition: background 0.15s, transform 0.1s, opacity 0.15s;
    -webkit-app-region: no-drag;
    overflow: visible !important;
    position: relative !important;
  }
  /* extend hit area to fill the full visual circle via pseudo-element */
  .aml-nav-btn::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
  }
  .aml-nav-btn:hover:not(:disabled) {
    background: rgba(255,255,255,0.22) !important;
  }
  .aml-nav-btn:active:not(:disabled) {
    transform: scale(0.88);
  }
  .aml-nav-btn:disabled {
    opacity: 0.25;
    cursor: default;
  }
  .aml-nav-btn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: rgba(255,255,255,0.88);
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
    pointer-events: none;
    position: relative;
    z-index: 1;
  }

  /* Blur-over-blur note: terminal has no backdrop-filter — sidebar blur
     remains active at all times since they never overlap (sidebar=left,
     terminal=right). No :has() override needed. */

  /* ── Page-wide glass scrollbars — border-mask expansion technique ──
     The channel is fixed at 14px. A thick transparent border acts as a mask,
     shrinking the visible pill to ~6px at rest. On hover the border thins to 2px,
     expanding the pill to ~10px. border-width IS transitioable on webkit thumbs
     in Chromium, giving a smooth grow animation without animating width itself.
     display is never set so Apple's display:none rules on internal elements hold. */
  *::-webkit-scrollbar {
    width: 14px;
    height: 14px;
  }
  *::-webkit-scrollbar-track {
    background: transparent;
  }
  *::-webkit-scrollbar-thumb {
    background-color: rgba(255,255,255,0.22);
    border-radius: 9999px;
    border: 4px solid transparent;
    background-clip: padding-box;
    transition: background-color 0.2s ease, border-width 0.2s ease;
  }
  *::-webkit-scrollbar-thumb:hover {
    background-color: rgba(255,255,255,0.50);
    border-width: 2px;
  }
  *::-webkit-scrollbar-corner {
    background: transparent;
  }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

// ── Event-driven art tinting ──────────────────────────────────────────────────
// Instead of polling every 2 seconds, watch for the player thumbnail img
// src to change via MutationObserver. On change → image.decode() → canvas
// sample → update CSS custom properties. Zero continuous CPU cost at idle.

const _canvas = document.createElement('canvas');
_canvas.width = 8; _canvas.height = 8;
const _ctx = _canvas.getContext('2d', { willReadFrequently: true });
let _lastSrc = '';

async function sampleArtwork(img) {
    if (!img || img.src === _lastSrc || !img.src) return;
    _lastSrc = img.src;
    try {
        // Wait for image to be fully decoded before sampling.
        await img.decode().catch(() => {});
        _ctx.drawImage(img, 0, 0, 8, 8);
        const data = _ctx.getImageData(0, 0, 8, 8).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            const lum = (data[i] + data[i+1] + data[i+2]) / 3;
            // Skip near-black and near-white — they flatten the tint.
            if (lum < 20 || lum > 235) continue;
            r += data[i]; g += data[i+1]; b += data[i+2]; n++;
        }
        if (n === 0) return;
        const root = document.documentElement;
        root.style.setProperty('--aml-art-r', Math.round(r / n));
        root.style.setProperty('--aml-art-g', Math.round(g / n));
        root.style.setProperty('--aml-art-b', Math.round(b / n));
    } catch (_) {}
}

function findPlayerArt() {
    return (
        document.querySelector('[class*="playback"] img[src]') ||
        document.querySelector('[class*="lcd"] img[src]') ||
        document.querySelector('[class*="player"] img[src]')
    );
}

// Observe src attribute changes on player art images — fires instantly
// when the user starts a new track, with no polling overhead at idle.
const artObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'src') {
            sampleArtwork(m.target);
        }
    }
});

// Attach observer once the player bar area appears in the DOM.
const barObserver = new MutationObserver(() => {
    const img = findPlayerArt();
    if (!img) return;
    artObserver.observe(img, { attributes: true, attributeFilter: ['src'] });
    sampleArtwork(img);
    barObserver.disconnect();
});
barObserver.observe(document.documentElement, { childList: true, subtree: true });

// ── iOS/iPadOS-style back + forward buttons ───────────────────────────────────
(function mountNavButtons() {
    if (document.getElementById('aml-nav-buttons')) return;

    // ── Browser-style history stack ───────────────────────────────────────────
    // Home is the initial entry. pushState appends and truncates forward entries
    // exactly like a browser. popstate fires when back/forward actually lands,
    // so cursor is ONLY moved there — never in the click handler itself.
    const HOME = 'https://music.apple.com/';
    let stack  = [HOME];   // index 0 = home (oldest)
    let cursor = 0;        // points at current position in stack

    const _pushState    = history.pushState.bind(history);
    const _replaceState = history.replaceState.bind(history);

    history.pushState = function(state, title, url) {
        _pushState(state, title, url);
        const href = location.href;
        // Ignore if it's the same page (replaceState semantics leak in sometimes)
        if (href === stack[cursor]) return;
        // Truncate any forward entries, push new entry
        stack = stack.slice(0, cursor + 1);
        stack.push(href);
        cursor = stack.length - 1;
        syncButtons();
    };

    history.replaceState = function(state, title, url) {
        _replaceState(state, title, url);
        stack[cursor] = location.href;
        // replaceState never changes back/forward availability
    };

    window.addEventListener('popstate', () => {
        // The browser has already moved — find where we landed in our stack.
        const href = location.href;
        // Search backward first (most common: user pressed Back)
        for (let i = cursor - 1; i >= 0; i--) {
            if (stack[i] === href) { cursor = i; syncButtons(); return; }
        }
        // Search forward (user pressed Forward)
        for (let i = cursor + 1; i < stack.length; i++) {
            if (stack[i] === href) { cursor = i; syncButtons(); return; }
        }
        // Unknown location (external navigation / reload) — treat as new entry
        stack = stack.slice(0, cursor + 1);
        stack.push(href);
        cursor = stack.length - 1;
        syncButtons();
    });

    // ── DOM ───────────────────────────────────────────────────────────────────
    const wrap = document.createElement('div');
    wrap.id = 'aml-nav-buttons';

    const chevronLeft  = `<svg viewBox="0 0 14 14"><polyline points="9,2 4,7 9,12"/></svg>`;
    const chevronRight = `<svg viewBox="0 0 14 14"><polyline points="5,2 10,7 5,12"/></svg>`;

    const back = document.createElement('button');
    back.className = 'aml-nav-btn';
    back.innerHTML = chevronLeft;
    back.title = 'Back';
    back.setAttribute('aria-label', 'Go back');
    back.disabled = true;

    const fwd = document.createElement('button');
    fwd.className = 'aml-nav-btn';
    fwd.innerHTML = chevronRight;
    fwd.title = 'Forward';
    fwd.setAttribute('aria-label', 'Go forward');
    fwd.disabled = true;

    function syncButtons() {
        back.disabled = cursor <= 0;
        fwd.disabled  = cursor >= stack.length - 1;
    }

    // Click handlers only call the browser API — popstate updates the cursor.
    back.addEventListener('click', () => { if (cursor > 0) history.back(); });
    fwd.addEventListener('click',  () => { if (cursor < stack.length - 1) history.forward(); });

    wrap.appendChild(back);
    wrap.appendChild(fwd);

    function findHeader() {
        // Try progressively broader selectors until one matches the logo row
        return (
            document.querySelector('nav.navigation [class*="navigation-header"]') ||
            document.querySelector('nav.navigation [class*="sidebar-header"]') ||
            document.querySelector('nav.navigation [class*="NavigationHeader"]') ||
            document.querySelector('nav.navigation header') ||
            // Fallback: first direct child div that contains the Apple logo img
            (() => {
                const nav = document.querySelector('nav.navigation');
                if (!nav) return null;
                for (const child of nav.children) {
                    if (child.querySelector('img[src*="apple"], [aria-label*="Music"], [class*="logo"], [class*="brand"]'))
                        return child;
                }
                // Last resort: first direct child that has display:flex or is a div
                return nav.firstElementChild || null;
            })()
        );
    }

    const attach = () => {
        if (document.getElementById('aml-nav-buttons')) return;
        const nav = document.querySelector('nav.navigation');
        const header = findHeader();
        if (!nav || !header) return;

        // Append to nav (position:relative), then align to header row via JS measurement
        nav.appendChild(wrap);

        // Position buttons to sit inside the header row
        const positionButtons = () => {
            const navRect    = nav.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            const top    = headerRect.top - navRect.top;
            const height = headerRect.height || 44; // fallback if not yet laid out
            wrap.style.top    = `${top}px`;
            wrap.style.height = `${height}px`;
        };

        positionButtons();
        // Re-measure if the header changes size (e.g. on zoom/resize or deferred layout)
        new ResizeObserver(positionButtons).observe(header);

        syncButtons();
    };

    // Initial attach (or watch for nav to appear on SPA first paint)
    const navWatcher = new MutationObserver(() => {
        if (findHeader()) { attach(); navWatcher.disconnect(); }
    });
    if (findHeader()) attach();
    else navWatcher.observe(document.documentElement, { childList: true, subtree: true });

    // Re-attach if SPA navigation removes and recreates the nav element
    new MutationObserver(() => {
        if (!document.getElementById('aml-nav-buttons') && findHeader()) attach();
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
