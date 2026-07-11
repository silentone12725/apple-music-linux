(() => {
  // src/vision-glass.js
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
  var sheet = new CSSStyleSheet();
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
  [class*="vignette"], [class*="gradient-overlay"],
  [class*="background-gradient"] { display: none !important; }
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

  /* Blur-over-blur note: terminal has no backdrop-filter \u2014 sidebar blur
     remains active at all times since they never overlap (sidebar=left,
     terminal=right). No :has() override needed. */
`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  var _canvas = document.createElement("canvas");
  _canvas.width = 8;
  _canvas.height = 8;
  var _ctx = _canvas.getContext("2d", { willReadFrequently: true });
  var _lastSrc = "";
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
  var artObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "src") {
        sampleArtwork(m.target);
      }
    }
  });
  var barObserver = new MutationObserver(() => {
    const img = findPlayerArt();
    if (!img) return;
    artObserver.observe(img, { attributes: true, attributeFilter: ["src"] });
    sampleArtwork(img);
    barObserver.disconnect();
  });
  barObserver.observe(document.documentElement, { childList: true, subtree: true });
})();
