'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── DRM key-system stub — must run before MusicKit.js initialises ─────────────
// Injected as a <script> tag so it executes in world 0 synchronously at
// document-start, before any page scripts (including musickit.js) are parsed.
// MusicKit probes navigator.requestMediaKeySystemAccess() during init and caches
// the result; our executeJavaScript bundles arrive too late to intercept that.
// This injection runs early enough to patch the probe in place.
;(function injectDRMPatch() {
    if (!location.hostname.includes('apple.com')) return;
    const patchCode = `(function(){
  if (window.__amlDRMPatch) return;
  window.__amlDRMPatch = true;
  // Capture BEFORE MusicKit overrides HTMLMediaElement.prototype.currentTime.set
  window.__amlNativeCTSet = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')?.set;
  var _origRMKSA = navigator.requestMediaKeySystemAccess && navigator.requestMediaKeySystemAccess.bind(navigator);
  navigator.requestMediaKeySystemAccess = function(ks, cfgs) {
    var real = _origRMKSA ? Promise.resolve().then(function(){ return _origRMKSA(ks, cfgs); }) : Promise.reject(new Error('none'));
    return real.catch(function() {
      var fakeSession = {
        sessionId:'', expiration:NaN, closed:Promise.resolve(), keyStatuses:new Map(),
        addEventListener:function(){}, removeEventListener:function(){}, dispatchEvent:function(){return false;},
        generateRequest:function(){return Promise.resolve();},
        load:function(){return Promise.resolve(false);},
        update:function(){return Promise.resolve();},
        close:function(){return Promise.resolve();},
        remove:function(){return Promise.resolve();}
      };
      var fakeKeys = {
        createSession:function(){return fakeSession;},
        setServerCertificate:function(){return Promise.resolve(true);}
      };
      return { keySystem:ks, getConfiguration:function(){return cfgs&&cfgs[0]||{};}, createMediaKeys:function(){return Promise.resolve(fakeKeys);} };
    });
  };
  var _origSMK = HTMLMediaElement.prototype.setMediaKeys;
  HTMLMediaElement.prototype.setMediaKeys = function(keys) {
    if (!keys) { try { return _origSMK.call(this, null); } catch(e) { return Promise.resolve(); } }
    try { if (keys instanceof MediaKeys) return _origSMK.call(this, keys); } catch(e) {}
    return Promise.resolve();
  };
  console.log('[AML] DRM patch active');
})();`;
    function doInject() {
        const s = document.createElement('script');
        s.textContent = patchCode;
        document.documentElement.appendChild(s);
        s.remove();
    }
    if (document.documentElement) {
        doInject();
    } else {
        // documentElement not yet created — observe document for the <html> element
        const obs = new MutationObserver(() => {
            if (document.documentElement) {
                obs.disconnect();
                doInject();
            }
        });
        obs.observe(document, { childList: true });
    }
})();

// ── Bridge: expose IPC channels to the injected main-world renderer ──────────
// Following pear-desktop's pattern: expose a thin IPC bridge via contextBridge
// so the renderer bundle (running in world 0) can call PTY methods and receive
// events without needing nodeIntegration on the page itself.
// Signal that the app UI is ready to show (called from world 0 after DOM is populated).
contextBridge.exposeInMainWorld('amlReady', () => ipcRenderer.send('app:ui-ready'));

contextBridge.exposeInMainWorld('amlBridge', {
    // ── PTY ──────────────────────────────────────────────────────────────────
    ptyStart:       ()          => ipcRenderer.send('pty:start'),
    ptyInput:       (data)      => ipcRenderer.send('pty:input', data),
    ptyResize:      (c, r)      => ipcRenderer.send('pty:resize', c, r),
    ptyLogin:       (login)     => ipcRenderer.send('pty:login', login),
    ptyRestart:     ()          => ipcRenderer.send('pty:restart'),

    // ── Session ───────────────────────────────────────────────────────────────
    hasSession:     ()          => ipcRenderer.invoke('wrapper:has-session'),
    logout:         ()          => ipcRenderer.invoke('wrapper:logout'),

    // ── Health ────────────────────────────────────────────────────────────────
    getHealth:      ()          => ipcRenderer.invoke('wrapper:health'),

    // ── Events ───────────────────────────────────────────────────────────────
    onPtyData:      (cb)        => ipcRenderer.on('pty:data',           (_, d)      => cb(d)),
    onPtyExit:      (cb)        => ipcRenderer.on('pty:exit',           (_, code)   => cb(code)),
    onToggle:       (cb)        => ipcRenderer.on('terminal:toggle',    ()          => cb()),
    onLoggedOut:    (cb)        => ipcRenderer.on('wrapper:logged-out', ()          => cb()),
    onHealthChange: (cb)        => ipcRenderer.on('wrapper:health',     (_, status) => cb(status)),
});

// ── Apple Music page setup ────────────────────────────────────────────────────
const LOSSLESS_SVG = `<svg viewBox="0 0 69 44" xmlns="http://www.w3.org/2000/svg" style="height:13px;width:auto;vertical-align:middle;flex-shrink:0;" aria-label="Lossless"><path fill="#ffffff" fill-rule="nonzero" d="M36.8269026,4 C42.3794214,4 45.7184513,10.5183153 48.20334,17.4261699 L48.4450486,18.1066712 L48.6815356,18.788389 L48.9130884,19.4700271 C49.6770268,21.7405814 50.36352,23.9882073 51.0204784,25.9968947 C52.5296562,19.7123189 51.7381954,18.3629096 53.3551269,18.3629096 C53.9565751,18.3629096 54.5652965,18.7717786 54.5652965,19.5168498 C54.5652965,19.8184059 54.0740356,23.0143253 53.391361,26.2165815 L53.2651959,26.7982368 L53.1352128,27.3761743 C52.9156151,28.3341623 52.6817778,29.2605867 52.4420448,30.075084 C59.3914285,48.2833991 64.5514879,24.299737 65.134561,19.3973484 C65.2196627,18.6903693 65.7520794,18.3629223 66.2903224,18.3629223 C67.0092304,18.3629223 67.5985395,18.9043683 67.4862017,19.7191497 C66.2419581,27.647702 64.3284002,40 56.4607867,40 C52.1189889,40 49.6781873,36.6024859 47.7506208,32.7092263 C46.4116896,30.0790205 45.2734117,26.952661 44.2263394,23.8087368 L43.9767371,23.0541028 C43.8940827,22.8026091 43.811956,22.5512479 43.7303009,22.3002645 L43.4866946,21.5486922 C41.1040436,14.1741911 39.0830717,7.34159293 35.9851696,7.34159293 C34.4711899,7.34159293 33.3487598,8.92234593 33.2709954,8.92234593 C33.128169,8.92234593 33.0160746,8.27828447 31.602332,6.51365955 C32.9478242,4.97723054 34.8023002,4 36.8269026,4 Z M11.0614865,4.01937104 C23.4500006,4.01937104 24.5519172,36.7070003 31.5633281,36.7070003 C32.3865195,36.7070003 33.2738509,36.2079668 34.2437613,35.0776923 C34.7806086,35.9871115 35.3308882,36.7945268 35.9004521,37.5054184 C34.500923,39.1028534 32.7595403,39.9988275 30.578884,39.9988275 C22.7448451,39.9977315 19.3788608,26.8790797 16.4819088,18.0220558 C15.7996486,20.8631751 15.4455023,23.434387 15.3068631,24.5887478 C15.2208267,25.3223111 14.6831215,25.6566526 14.1414468,25.6566526 C13.5407541,25.6566526 12.9351571,25.2454896 12.9351571,24.5116332 C12.9351571,24.4569356 12.9385248,24.4004537 12.9455035,24.3422131 C13.346708,21.4307464 14.1551865,17.0196557 15.0604448,13.9441978 C13.8554484,10.7869356 12.3503425,7.33621492 10.1329104,7.33621492 C5.65625092,7.33621492 3.09261157,18.5867088 2.37169324,24.5887478 C2.28565683,25.3223111 1.74795163,25.6566526 1.20627691,25.6566526 C0.605597004,25.6566526 -7.10542736e-15,25.2454896 -7.10542736e-15,24.5116332 C-7.10542736e-15,24.4569356 0.00336770017,24.4004537 0.0103463944,24.3422131 C0.114233957,23.5883333 0.225608359,22.8207923 0.346678477,22.046953 L0.452878843,21.3822914 C0.470991821,21.2713147 0.48931555,21.1602523 0.50785647,21.0491258 L0.621759807,20.3817689 C2.0405473,12.2570738 4.68538356,4.01937104 11.0614865,4.01937104 Z M23.9155499,4.00146557 C26.1404345,4.00146557 28.5270839,5.15921632 30.5844926,7.87545613 C30.6994554,8.00734485 31.8526558,9.79953527 32.2166235,10.4208612 C33.474197,12.6992201 34.5694223,15.4837436 35.5796467,18.378952 L35.8413062,19.1364745 C38.7427747,27.6177062 40.980016,36.7463669 44.4650259,36.7463669 C45.2911112,36.7463669 46.1873164,36.2334422 47.1790849,35.0773864 C47.7158553,35.9867291 48.2660581,36.794068 48.835558,37.5049086 C47.4394606,39.099438 45.6989231,39.9988275 43.5140667,39.9988275 C31.1995909,39.9969924 29.8609621,7.32900175 23.0764932,7.32900175 C21.5454317,7.32900175 20.4138588,8.92244789 20.3357358,8.92244789 C20.1928455,8.92244789 20.0806102,8.27846289 18.6670468,6.51397816 C20.048649,4.9358122 21.9168263,4.00146557 23.9155499,4.00146557 Z"/></svg>`;

function injectAppleMusicStyles() {
    if (document.getElementById('aml-style')) return;
    const style = document.createElement('style');
    style.id = 'aml-style';
    style.textContent = `
        .native-cta__button, .web-navigation__auth,
        cwc-upsell-banner, .locale-switcher-banner { display: none !important; }
        cwc-badge[kind="preview"], .preview-badge,
        [data-testid="preview-badge"],
        .web-chrome-playback-lcd__preview-badge,
        .playback-preview-badge { display: none !important; }
        #aml-lossless-icon {
            display: inline-flex; align-items: center;
            margin-left: 6px; opacity: 0.85; pointer-events: none;
            filter: brightness(0) invert(1);
        }
    `;
    document.head.appendChild(style);
}

function injectLosslessIcon() {
    const LOSSLESS_ID = 'aml-lossless-icon';
    document.querySelectorAll('cwc-badge, .preview-badge, [class*="preview-badge"]')
        .forEach(el => {
            if (el.textContent.trim().toUpperCase() === 'PREVIEW')
                el.style.setProperty('display', 'none', 'important');
        });
    const anchor =
        document.querySelector('.web-chrome-playback-lcd__track-name-wrapper') ||
        document.querySelector('.web-chrome-playback-lcd__song-name-wrapper') ||
        document.querySelector('[data-testid="lcd-track-name"]') ||
        document.querySelector('[class*="lcd"][class*="track"]');
    if (!anchor || anchor.querySelector('#' + LOSSLESS_ID)) return;
    const span = document.createElement('span');
    span.id = LOSSLESS_ID;
    span.innerHTML = LOSSLESS_SVG;
    anchor.appendChild(span);
}

// ── Renderer bundle injection ─────────────────────────────────────────────────
// Read the pre-built IIFE bundle (xterm.js + terminal overlay) and execute it
// directly in world 0 — the page's own JS context — following pear-desktop's
// approach. This sidesteps all isolated-world event-proxy issues.

function setupAppleMusicPage() {
    if (!location.hostname.includes('apple.com')) return;

    injectAppleMusicStyles();

    // Debounced MutationObserver for lossless icon.
    const LOSSLESS_ID = 'aml-lossless-icon';
    let debounce = null;
    const observer = new MutationObserver(() => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            if (document.getElementById(LOSSLESS_ID)) return;
            observer.disconnect();
            injectLosslessIcon();
            if (document.getElementById(LOSSLESS_ID)) {
                new MutationObserver((_, obs) => {
                    if (!document.getElementById(LOSSLESS_ID)) {
                        obs.disconnect(); startObserver();
                    }
                }).observe(document.body, { childList: true, subtree: true });
            } else {
                startObserver();
            }
        }, 80);
    });
    const startObserver = () => {
        observer.observe(document.body, { childList: true, subtree: true });
        injectLosslessIcon();
    };
    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver);

    // Terminal bundle injected from main process via webContents.executeJavaScript()
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAppleMusicPage);
} else {
    setupAppleMusicPage();
}
