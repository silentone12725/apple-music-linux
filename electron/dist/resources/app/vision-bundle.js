(() => {
  (function detectUIReady() {
    if (typeof window.amlReady !== "function") return;
    const fire = () => window.amlReady();
    const check = () => {
      const nav = document.querySelector("nav.navigation");
      if (nav && nav.children.length > 0) {
        fire();
        return true;
      }
      return false;
    };
    if (check()) return;
    const obs = new MutationObserver(() => {
      if (check()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      obs.disconnect();
      fire();
    }, 1e4);
  })();
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
  :root {
    --aml-glass-blur:    48px;
    --aml-glass-opacity: 0.07;
    /* Art tint \u2014 updated by MutationObserver when album art changes */
    --aml-art-r: 255;
    --aml-art-g: 255;
    --aml-art-b: 255;
    --aml-art-tint: rgba(var(--aml-art-r), var(--aml-art-g), var(--aml-art-b), 0.4);
  }

  html, body { background: transparent !important; }

  /* \u2500\u2500 Sidebar glass \u2500\u2500
     Confirmed stable selector. Svelte hash classes change on every deploy;
     nav.navigation (tag + base class) is stable across versions. */
  nav.navigation {
    background: color-mix(
      in srgb,
      rgba(255, 255, 255, var(--aml-glass-opacity)) 80%,
      var(--aml-art-tint) 20%
    ) !important;
    backdrop-filter: blur(var(--aml-glass-blur)) saturate(2.2) brightness(1.08) !important;
    -webkit-backdrop-filter: blur(var(--aml-glass-blur)) saturate(2.2) brightness(1.08) !important;
    border-right: 1px solid rgba(255,255,255,0.12) !important;
    box-shadow: 1px 0 32px rgba(0,0,0,0.18) !important;
    transition: background 1.4s ease !important;
  }

  /* Strip backgrounds only from layout shells while hovered \u2014 :not(:hover)
     yields to Apple Music's native Svelte-scoped hover CSS on hover. */
  nav.navigation > li:not(:hover),
  nav.navigation > ul:not(:hover),
  nav.navigation > div:not(:hover),
  nav.navigation > section:not(:hover) {
    background: transparent !important;
  }
  nav.navigation [class*="active"],
  nav.navigation [class*="selected"] {
    background: rgba(255,255,255,0.12) !important;
    border-radius: 8px !important;
  }


  /* \u2500\u2500 Vignette / upsell removal \u2500\u2500 */
  body::before, body::after { display: none !important; }
  /* Only hide page-level background overlays, not card gradients */
  [class*="PageBackground"] [class*="gradient"],
  [class*="page-background"] [class*="gradient"],
  [class*="page-gradient"],
  [class*="app-header"] > [class*="background"] { display: none !important; }
  [class*="upsell"], [class*="commerce-message"],
  [class*="subscribe-banner"] { display: none !important; }

  /* \u2500\u2500 Search bar glass \u2500\u2500 */
  [role="search"], header [class*="search"] {
    background: rgba(255,255,255,0.10) !important;
    backdrop-filter: blur(20px) saturate(1.6) !important;
    -webkit-backdrop-filter: blur(20px) saturate(1.6) !important;
    border: 1px solid rgba(255,255,255,0.15) !important;
    border-radius: 12px !important;
  }

  /* \u2500\u2500 iOS/iPadOS-style back + forward navigation buttons (sidebar header row) \u2500\u2500 */
  #aml-nav-buttons {
    position: absolute;
    /* top / height set by JS after measuring the header row */
    right: 8%;
    display: flex;
    gap: 8px;
    align-items: center;
    z-index: 20;
    -webkit-app-region: no-drag;
  }
  nav.navigation { position: relative !important; }
  .aml-nav-btn {
    /* explicit box model \u2014 hit area == visual circle */
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

  /* Blur-over-blur note: terminal has no backdrop-filter \u2014 sidebar blur
     remains active at all times since they never overlap (sidebar=left,
     terminal=right). No :has() override needed. */
`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const _canvas = document.createElement("canvas");
  _canvas.width = 8;
  _canvas.height = 8;
  const _ctx = _canvas.getContext("2d", { willReadFrequently: true });
  let _lastSrc = "";
  async function sampleArtwork(img) {
    if (!img || img.src === _lastSrc || !img.src) return;
    _lastSrc = img.src;
    try {
      await img.decode().catch(() => {
      });
      _ctx.drawImage(img, 0, 0, 8, 8);
      const data = _ctx.getImageData(0, 0, 8, 8).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum < 20 || lum > 235) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      if (n === 0) return;
      const root = document.documentElement;
      root.style.setProperty("--aml-art-r", Math.round(r / n));
      root.style.setProperty("--aml-art-g", Math.round(g / n));
      root.style.setProperty("--aml-art-b", Math.round(b / n));
    } catch (_) {
    }
  }
  function findPlayerArt() {
    return document.querySelector('[class*="playback"] img[src]') || document.querySelector('[class*="lcd"] img[src]') || document.querySelector('[class*="player"] img[src]');
  }
  const artObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "src") {
        sampleArtwork(m.target);
      }
    }
  });
  const barObserver = new MutationObserver(() => {
    const img = findPlayerArt();
    if (!img) return;
    artObserver.observe(img, { attributes: true, attributeFilter: ["src"] });
    sampleArtwork(img);
    barObserver.disconnect();
  });
  barObserver.observe(document.documentElement, { childList: true, subtree: true });
  (function mountNavButtons() {
    if (document.getElementById("aml-nav-buttons")) return;
    const HOME = "https://music.apple.com/";
    let stack = [HOME];
    let cursor = 0;
    const _pushState = history.pushState.bind(history);
    const _replaceState = history.replaceState.bind(history);
    history.pushState = function(state, title, url) {
      _pushState(state, title, url);
      const href = location.href;
      if (href === stack[cursor]) return;
      stack = stack.slice(0, cursor + 1);
      stack.push(href);
      cursor = stack.length - 1;
      syncButtons();
    };
    history.replaceState = function(state, title, url) {
      _replaceState(state, title, url);
      stack[cursor] = location.href;
    };
    window.addEventListener("popstate", () => {
      const href = location.href;
      for (let i = cursor - 1; i >= 0; i--) {
        if (stack[i] === href) {
          cursor = i;
          syncButtons();
          return;
        }
      }
      for (let i = cursor + 1; i < stack.length; i++) {
        if (stack[i] === href) {
          cursor = i;
          syncButtons();
          return;
        }
      }
      stack = stack.slice(0, cursor + 1);
      stack.push(href);
      cursor = stack.length - 1;
      syncButtons();
    });
    const wrap = document.createElement("div");
    wrap.id = "aml-nav-buttons";
    const chevronLeft = `<svg viewBox="0 0 14 14"><polyline points="9,2 4,7 9,12"/></svg>`;
    const chevronRight = `<svg viewBox="0 0 14 14"><polyline points="5,2 10,7 5,12"/></svg>`;
    const back = document.createElement("button");
    back.className = "aml-nav-btn";
    back.innerHTML = chevronLeft;
    back.title = "Back";
    back.setAttribute("aria-label", "Go back");
    back.disabled = true;
    const fwd = document.createElement("button");
    fwd.className = "aml-nav-btn";
    fwd.innerHTML = chevronRight;
    fwd.title = "Forward";
    fwd.setAttribute("aria-label", "Go forward");
    fwd.disabled = true;
    function syncButtons() {
      back.disabled = cursor <= 0;
      fwd.disabled = cursor >= stack.length - 1;
    }
    back.addEventListener("click", () => {
      if (cursor > 0) history.back();
    });
    fwd.addEventListener("click", () => {
      if (cursor < stack.length - 1) history.forward();
    });
    wrap.appendChild(back);
    wrap.appendChild(fwd);
    function findHeader() {
      return document.querySelector('nav.navigation [class*="navigation-header"]') || document.querySelector('nav.navigation [class*="sidebar-header"]') || document.querySelector('nav.navigation [class*="NavigationHeader"]') || document.querySelector("nav.navigation header") || // Fallback: first direct child div that contains the Apple logo img
      (() => {
        const nav = document.querySelector("nav.navigation");
        if (!nav) return null;
        for (const child of nav.children) {
          if (child.querySelector('img[src*="apple"], [aria-label*="Music"], [class*="logo"], [class*="brand"]'))
            return child;
        }
        return nav.firstElementChild || null;
      })();
    }
    const attach = () => {
      if (document.getElementById("aml-nav-buttons")) return;
      const nav = document.querySelector("nav.navigation");
      const header = findHeader();
      if (!nav || !header) return;
      nav.appendChild(wrap);
      const positionButtons = () => {
        const navRect = nav.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const top = headerRect.top - navRect.top;
        const height = headerRect.height;
        wrap.style.top = `${top}px`;
        wrap.style.height = `${height}px`;
      };
      positionButtons();
      new ResizeObserver(positionButtons).observe(header);
      syncButtons();
    };
    const navWatcher = new MutationObserver(() => {
      if (findHeader()) {
        attach();
        navWatcher.disconnect();
      }
    });
    if (findHeader()) attach();
    else navWatcher.observe(document.documentElement, { childList: true, subtree: true });
  })();
})();
