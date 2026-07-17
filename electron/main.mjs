import * as electronMain from 'electron/main';
const { app, BrowserWindow, ipcMain, session, shell, Menu, Tray, nativeImage, protocol, net } = electronMain;
import { spawn, execFileSync } from 'child_process';

// Suppress EPIPE so a closed terminal pipe doesn't crash the main process.
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

// Register aml-engine:// scheme before app is ready.
// This proxies http://127.0.0.1:20025 through a privileged Electron protocol
// so the renderer can reach the engine without hitting Chromium's Private
// Network Access block (public origin → localhost is blocked by default).
protocol.registerSchemesAsPrivileged([{
    scheme: 'aml-engine',
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: true,
        stream: true,
    },
}]);

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync, statSync, readFileSync as readFile, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.config', 'apple-music-linux');
const PREF_FILE  = path.join(CONFIG_DIR, 'electron-prefs.json');

function loadPrefs() {
    try { return JSON.parse(readFile(PREF_FILE, 'utf8')); } catch { return {}; }
}
function savePrefs(p) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(PREF_FILE, JSON.stringify(p, null, 2));
}

// ── Chromium flags ──────────────────────────────────────────────────────────
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features',
    'UseOzonePlatform,WaylandWindowDecorations,VaapiVideoDecoder,CanvasOopRasterization');
app.commandLine.appendSwitch('disable-features', 'ExplicitSync');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// Remove Chromium's internal 60 fps cap — lets the Wayland compositor drive
// the actual display refresh rate (120 Hz, 144 Hz, etc.) instead of 60 Hz.
app.commandLine.appendSwitch('disable-frame-rate-limit');
// Music player: allow audio.play() without a live user gesture. Without this,
// _nativePlay() called from the async canplay handler is blocked by Chromium's
// autoplay policy when the engine takes >5 s to start streaming.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Smooth pixel-level scroll animation for mouse wheel (matches trackpad feel).
app.commandLine.appendSwitch('enable-smooth-scrolling');
// Chromium flag required for transparent windows on Linux.
// Hyprland/KWin handle the compositor-level blur-behind on the desktop
// side; Chromium just needs to render RGBA frames correctly.
app.commandLine.appendSwitch('enable-transparent-visuals');

let win    = null;
let tray   = null;
let engineProc = null;
let isQuitting = false;

// ── Engine API server ─────────────────────────────────────────────────────────
// The engine binary is the apple-music-cli binary run in --api mode.  It
// decrypts Apple Music streams and exposes them as plain AAC fMP4 over HTTP so
// the renderer (engine-playback.js) can pipe them into a MediaSource.
//
// Binary resolution order:
//  1. AML_ENGINE_BIN environment variable (manual override / CI)
//  2. <resources>/apple-music-cli  (packaged Electron — app.isPackaged)
//  3. dist/resources/apple-music-cli  (dev: electron . from electron/ dir)
const _resPkgBin  = path.join(process.resourcesPath, 'apple-music-cli');
const _resDevBin  = path.join(__dirname, 'dist', 'resources', 'apple-music-cli');
const ENGINE_BIN  = process.env.AML_ENGINE_BIN ||
    (app.isPackaged ? _resPkgBin : (existsSync(_resDevBin) ? _resDevBin : _resPkgBin));

const ENGINE_DATA_DIR = path.join(CONFIG_DIR, 'engine-data');
const ENGINE_PORT = 20025;

function ensureEngineConfig() {
    mkdirSync(ENGINE_DATA_DIR, { recursive: true });
    const cfgPath = path.join(ENGINE_DATA_DIR, 'config.yaml');

    // Derive the live credential directory — the engine must know this path to
    // call ReadMusicToken() / ReadStorefrontID() for DRM authentication.
    const wrapperBase = path.join(
        os.homedir(), '.config', 'apple-music-linux', 'wrapper-data',
        'rootfs', 'data', 'data', 'com.apple.android.music', 'files'
    );
    // Wrapper binary: packaged at <resources>/wrapper, dev fallback beside Wrapper.x86_64.latest/
    const wrapperBin = app.isPackaged && existsSync(path.join(process.resourcesPath, 'wrapper'))
        ? path.join(process.resourcesPath, 'wrapper')
        : path.join(__dirname, '..', 'Wrapper.x86_64.latest', 'wrapper-rootless');

    if (!existsSync(cfgPath)) {
        const stub = [
            'storefront: us',
            'media-user-token: ""',
            'authorization-token: ""',
            'decrypt-m3u8-port: 127.0.0.1:10020',
            'get-m3u8-port: 127.0.0.1:20020',
            'get-m3u8-from-device: true',
            'get-m3u8-mode: hires',
            'aac-type: aac-lc',
            'alac-max: 192000',
            `wrapper-binary-path: "${wrapperBin}"`,
            `wrapper-base-dir: "${wrapperBase}"`,
        ].join('\n') + '\n';
        writeFileSync(cfgPath, stub);
        return;
    }

    // Patch existing config: add wrapper paths if absent (old installs lacked them).
    let content = readFile(cfgPath, 'utf8');
    let changed = false;
    for (const [key, val] of [['wrapper-binary-path', wrapperBin], ['wrapper-base-dir', wrapperBase]]) {
        if (!content.includes(`${key}:`)) {
            content += `${key}: "${val}"\n`;
            changed = true;
        }
    }
    if (changed) writeFileSync(cfgPath, content);
}

function killStaleEngine(port) {
    // SIGKILL anything on the port — no graceful shutdown needed for a stale engine.
    try {
        const out = execFileSync('ss', ['-tlnpH', `sport = :${port}`],
            { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/pid=(\d+)/);
        if (m) {
            const pid = parseInt(m[1], 10);
            console.log(`[AML] Killing stale engine on port ${port} (pid ${pid})`);
            try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
    } catch (_) {}

    // Kill the lock-file owner and remove the lock unconditionally.
    const lockPath = path.join(
        os.homedir(), '.config', 'apple-music-linux', 'wrapper-data',
        'rootfs', 'data', 'data', 'com.apple.android.music', 'files', 'engine-session.lock'
    );
    try {
        const pidStr = readFileSync(lockPath, 'utf8').trim();
        const lockPid = parseInt(pidStr, 10);
        if (lockPid > 0) {
            try { process.kill(lockPid, 'SIGKILL'); } catch (_) {}
            unlinkSync(lockPath);
            console.log(`[AML] Removed stale session lock (was held by pid ${lockPid})`);
        }
    } catch (_) {}
}

function isPortFree(port) {
    try {
        const out = execFileSync('ss', ['-tlnH', `sport = :${port}`],
            { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] });
        return out.trim() === '';
    } catch (_) { return true; }
}

async function startEngine() {
    if (engineProc) return;
    if (!existsSync(ENGINE_BIN)) {
        console.log('[AML] Engine binary not found at', ENGINE_BIN, '— skipping engine start');
        return;
    }
    killStaleEngine(ENGINE_PORT);
    // Wait up to 2 s for the port to be released after SIGKILL.
    for (let i = 0; i < 20; i++) {
        if (isPortFree(ENGINE_PORT)) break;
        await new Promise(r => setTimeout(r, 100));
    }
    ensureEngineConfig();
    engineProc = spawn(ENGINE_BIN, ['--api', String(ENGINE_PORT)], {
        cwd: ENGINE_DATA_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Force Go's pure-Go DNS resolver to avoid CGO getaddrinfo SIGSEGV
        // when the engine makes HTTP requests to Apple's API servers.
        env: { ...process.env, GODEBUG: 'netdns=go' },
    });
    const onOut = (d) => console.log('[engine]', d.toString().trimEnd());
    const onErr = (d) => console.error('[engine]', d.toString().trimEnd());
    engineProc.stdout.on('data', onOut);
    engineProc.stderr.on('data', onErr);
    engineProc.on('exit', (code) => {
        console.log('[AML] Engine exited (code', code ?? 0, ')');
        engineProc = null;
    });
    console.log('[AML] Engine started on port', ENGINE_PORT, '(pid', engineProc.pid, ')');
}

function stopEngine() {
    if (!engineProc) return;
    engineProc.kill('SIGTERM');
    engineProc = null;
}

function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        // Fully transparent so the compositor (Hyprland/KWin) can render
        // the desktop behind the window with its own blur effect, giving
        // us the visionOS "glass over room" look for free.
        backgroundColor: '#00000000',
        transparent: true,
        show: false,
        title: 'Apple Music',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            partition: 'persist:apple-music',
        },
    });

    win.loadURL('https://music.apple.com');

    // ── Show-when-ready ───────────────────────────────────────────────────────
    // ready-to-show fires on first paint — far too early for Apple Music's SPA
    // (the user would see a grey shell for another 5-10 s). Instead:
    //   1. Show the window immediately but at opacity 0 (invisible).
    //   2. Inject a small observer that fires when nav.navigation is populated.
    //   3. Fade the window in once the actual UI is rendered.
    // Fallback: force-show after 12 s so a slow network never hangs forever.
    let shown = false;
    const showWindow = () => {
        if (shown) return;
        shown = true;
        win.setOpacity(0);
        win.show();
        // Ramp opacity 0→1 over ~300 ms so it fades in smoothly.
        let op = 0;
        const step = setInterval(() => {
            op = Math.min(1, op + 0.08);
            win.setOpacity(op);
            if (op >= 1) clearInterval(step);
        }, 16);
    };
    const showFallback = setTimeout(showWindow, 12000);

    ipcMain.once('app:ui-ready', () => {
        clearTimeout(showFallback);
        showWindow();
    });
    win.webContents.openDevTools({ mode: 'detach' });

    // Relay renderer [AML Engine] console messages to the terminal for easy debugging.
    win.webContents.on('console-message', (event) => {
        const msg = event.message ?? event;
        if (typeof msg === 'string' && msg.startsWith('[AML')) console.log('[renderer]', msg);
    });

    const visionPath  = path.join(__dirname, 'vision-bundle.js');
    const visionCode  = existsSync(visionPath) ? readFileSync(visionPath, 'utf8') : '';
    // engine-sse-bundle must load first — it creates window._amlEngine which
    // smart-cache and engine-playback subscribe to in their own constructors.
    const ssePath     = path.join(__dirname, 'engine-sse-bundle.js');
    const sseCode     = existsSync(ssePath)    ? readFileSync(ssePath,    'utf8') : '';
    const cachePath   = path.join(__dirname, 'smart-cache-bundle.js');
    const cacheCode   = existsSync(cachePath)  ? readFileSync(cachePath,  'utf8') : '';
    const enginePath  = path.join(__dirname, 'engine-bundle.js');
    const engineCode  = existsSync(enginePath) ? readFileSync(enginePath, 'utf8') : '';

    // ── Early CSS via insertCSS — fires before first paint, no preload risk ──
    // webContents.insertCSS() is Electron's dedicated API for injecting CSS
    // before the page renders, unlike executeJavaScript which needs dom-ready.
    const { glassBlur = 48, glassOpacity = 0.07 } = loadPrefs();
    const earlyCss = `
        :root { --aml-glass-blur: ${glassBlur}px; --aml-glass-opacity: ${glassOpacity}; --aml-art-tint: rgba(255,255,255,0); }
        html, body { background: transparent !important; overscroll-behavior: none !important; }
        /* Strip grey tint from alternating content sections — let album art / wallpaper show through */
        .section--alternate, [class*="section--alternate"] { background: transparent !important; }
        nav.navigation {
            background: rgba(255,255,255,var(--aml-glass-opacity)) !important;
            backdrop-filter: blur(var(--aml-glass-blur)) saturate(2) brightness(1.08) !important;
            -webkit-backdrop-filter: blur(var(--aml-glass-blur)) saturate(2) brightness(1.08) !important;
            border-right: 1px solid rgba(255,255,255,0.12) !important;
        }
    `;

    // macOS Sonoma-style context menus.
    // Selectors discovered via DOM spy — BEM names are stable across app updates.
    // Structure: body > div.contextual-menu__overlay > amp-contextual-menu >
    //   div.contextual-menu > ul.contextual-menu__list > li.contextual-menu-item
    const contextMenuCss = `
        /* ── Context menus ──────────────────────────────────────────────── */

        /* Scrim: transparent (matches macOS — no background dim) */
        amp-contextual-menu-scrim { background: transparent !important; }
        .contextual-menu-scrim { background: transparent !important; border: none !important; }

        /* Let containers grow naturally — no clipping or scroll */
        div.contextual-menu__overlay,
        amp-contextual-menu {
            overflow: visible !important;
            max-height: none !important;
        }

        /* Menu panel — no backdrop-filter (causes 1s render stall on Linux) */
        div.contextual-menu {
            background: rgba(30, 30, 32, 0.97) !important;
            border-radius: 10px !important;
            border: 0.5px solid rgba(255, 255, 255, 0.12) !important;
            box-shadow: 0 8px 36px rgba(0,0,0,0.65), 0 2px 6px rgba(0,0,0,0.4) !important;
            padding: 5px 0 !important;
            min-width: 200px !important;
            height: auto !important;
            max-height: none !important;
            overflow: visible !important;
            scrollbar-width: none !important;
            font-family: -apple-system, "SF Pro Text", system-ui, sans-serif !important;
        }
        div.contextual-menu::-webkit-scrollbar { display: none !important; }

        /* List reset */
        ul.contextual-menu__list {
            margin: 0 !important;
            padding: 0 !important;
            list-style: none !important;
            max-height: none !important;
            overflow: visible !important;
        }
        ul.contextual-menu__list::-webkit-scrollbar { display: none !important; }

        /* Item row */
        li.contextual-menu-item {
            padding: 0 5px !important;
            margin: 0 !important;
            list-style: none !important;
            cursor: default !important;
        }

        /* Visible row content */
        span.contextual-menu-item__option-wrapper {
            display: flex !important;
            align-items: center !important;
            min-height: 26px !important;
            padding: 3px 8px 3px 10px !important;
            border-radius: 5px !important;
            font-size: 13px !important;
            color: rgba(255, 255, 255, 0.9) !important;
            cursor: default !important;
            user-select: none !important;
        }

        /* Hover highlight */
        li.contextual-menu-item:hover > span.contextual-menu-item__option-wrapper,
        li.contextual-menu-item:focus-within > span.contextual-menu-item__option-wrapper {
            background: #0A84FF !important;
            color: #fff !important;
        }

        /* Item icon */
        span.contextual-menu-item__icon-container {
            width: 16px !important;
            min-width: 16px !important;
            height: 16px !important;
            margin-right: 9px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            opacity: 0.75 !important;
            flex-shrink: 0 !important;
        }
        li.contextual-menu-item:hover span.contextual-menu-item__icon-container { opacity: 1 !important; }

        /* Primary text */
        span.contextual-menu-item__option-text {
            flex: 1 !important;
            white-space: nowrap !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
        }

        /* Trailing text (shortcut / arrow / checkmark) */
        span.contextual-menu-item__option-text--after {
            margin-left: auto !important;
            padding-left: 20px !important;
            font-size: 12px !important;
            color: rgba(255, 255, 255, 0.4) !important;
            flex-shrink: 0 !important;
        }
        li.contextual-menu-item:hover span.contextual-menu-item__option-text--after {
            color: rgba(255, 255, 255, 0.65) !important;
        }

        /* Subhead item (section label, non-interactive) */
        li.contextual-menu-item.contextual-menu__subhead { pointer-events: none !important; }
        li.contextual-menu-item.contextual-menu__subhead span.contextual-menu-item__option-wrapper {
            color: rgba(235, 235, 245, 0.38) !important;
            font-size: 11px !important;
            font-weight: 600 !important;
            text-transform: uppercase !important;
            letter-spacing: 0.03em !important;
            min-height: 20px !important;
            padding-top: 6px !important;
            padding-bottom: 2px !important;
        }

        /* Group — thin separator line above each group block */
        div.contextual-menu__group {
            margin-top: 5px !important;
            padding-top: 5px !important;
            border-top: 0.5px solid rgba(255, 255, 255, 0.10) !important;
        }

        /* Group title label */
        span.contextual-menu__group-title {
            display: block !important;
            padding: 2px 14px 4px !important;
            font-size: 11px !important;
            font-weight: 600 !important;
            color: rgba(235, 235, 245, 0.38) !important;
            text-transform: uppercase !important;
            letter-spacing: 0.03em !important;
            user-select: none !important;
            pointer-events: none !important;
        }

        /* Disabled items */
        li.contextual-menu-item[aria-disabled="true"],
        li.contextual-menu-item.is-disabled {
            pointer-events: none !important;
            opacity: 0.35 !important;
        }

        /* Submenu: JS clamps position/height at runtime (page-context aware).
           CSS only provides overflow containment and macOS scrollbar style. */
        div.contextual-menu.contextual-menu--nested,
        div.contextual-menu.contextual-menu--in-submenu {
            overflow-x: hidden !important;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.28) transparent;
        }
        div.contextual-menu.contextual-menu--nested::-webkit-scrollbar,
        div.contextual-menu.contextual-menu--in-submenu::-webkit-scrollbar {
            width: 5px;
        }
        div.contextual-menu.contextual-menu--nested::-webkit-scrollbar-track,
        div.contextual-menu.contextual-menu--in-submenu::-webkit-scrollbar-track {
            background: transparent;
        }
        div.contextual-menu.contextual-menu--nested::-webkit-scrollbar-thumb,
        div.contextual-menu.contextual-menu--in-submenu::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.28);
            border-radius: 3px;
        }
        div.contextual-menu.contextual-menu--nested::-webkit-scrollbar-thumb:hover,
        div.contextual-menu.contextual-menu--in-submenu::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.5);
        }

        /* ── Account/user button in nav sidebar ──────────────────────────── */
        /* Strip app's pill from the outer wrapper — button handles its own look */
        div.account-menu:not(.account-menu--expanded) {
            background: transparent !important;
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
        }
        /* Style the actual trigger button like a proper macOS sidebar item */
        div.account-menu .contextual-menu__trigger {
            display: flex !important;
            align-items: center !important;
            width: 100% !important;
            padding: 7px 10px !important;
            border-radius: 8px !important;
            border: none !important;
            cursor: pointer !important;
            font-family: -apple-system, "SF Pro Text", system-ui, sans-serif !important;
            font-size: 13px !important;
            color: rgba(255, 255, 255, 0.88) !important;
            background: rgba(255, 255, 255, 0.07) !important;
            text-align: left !important;
        }
        div.account-menu:not(.account-menu--expanded) .contextual-menu__trigger:hover {
            background: rgba(255, 255, 255, 0.13) !important;
        }
        div.account-menu.account-menu--expanded .contextual-menu__trigger {
            background: transparent !important;
        }
        /* User avatar + name layout inside the button */
        span.user.svelte-y8jpsp {
            display: flex !important;
            align-items: center !important;
            gap: 8px !important;
            width: 100% !important;
        }
        span.user__name.svelte-y8jpsp {
            font-size: 13px !important;
            font-weight: 500 !important;
            color: rgba(255, 255, 255, 0.88) !important;
        }
        /* Expanded dropdown — same solid dark treatment as context menus */
        div.account-menu.account-menu--expanded {
            background: rgba(30, 30, 32, 0.97) !important;
            border-radius: 10px !important;
            border: 0.5px solid rgba(255, 255, 255, 0.12) !important;
            box-shadow: 0 8px 36px rgba(0,0,0,0.65), 0 2px 6px rgba(0,0,0,0.4) !important;
        }

        /* ── Search / media page vignettes ──────────────────────────────── */
        /* Nuke every gradient/ambient overlay the app may render */
        .media-page__gradient, .media-page__gradient-overlay,
        amp-ambient-video-gradient,
        [class*="ambient-gradient"], [class*="AmbientGradient"],
        [class*="gradient-overlay"], [class*="GradientOverlay"],
        [class*="page-gradient"], [class*="PageGradient"],
        [class*="hero-gradient"], [class*="HeroGradient"],
        [class*="scope-bar"]::before, [class*="scope-bar"]::after,
        [class*="search"] > [class*="gradient"] { display: none !important; background: none !important; }
        /* Search input — transparent + blur */
        [data-testid="search-input"], [class*="search-input-wrapper"] {
            background: rgba(255,255,255,0.08) !important;
            backdrop-filter: blur(12px) !important;
            -webkit-backdrop-filter: blur(12px) !important;
            border: 0.5px solid rgba(255,255,255,0.15) !important;
            border-radius: 10px !important;
            box-shadow: none !important;
        }
        [data-testid="search-input"]:focus-within, [class*="search-input-wrapper"]:focus-within {
            border-color: rgba(255,255,255,0.3) !important;
        }
        /* Remove auto-pink focus rings and selection highlight globally */
        :focus { outline: none !important; box-shadow: none !important; }
        ::selection { background: rgba(255,255,255,0.18) !important; color: inherit !important; }

        /* ── Bubble-tip cards (incl. "Find Concerts Nearby" card) ───────── */
        /* Static page elements: backdrop-filter is safe here (no popup jank) */
        div.bubble-tip {
            background: rgba(0, 0, 0, 0.45) !important;
            backdrop-filter: blur(32px) saturate(1.6) brightness(0.85) !important;
            -webkit-backdrop-filter: blur(32px) saturate(1.6) brightness(0.85) !important;
            border-radius: 14px !important;
            border: 0.5px solid rgba(255, 255, 255, 0.15) !important;
            box-shadow: 0 4px 24px rgba(0,0,0,0.3), 0 1px 4px rgba(0,0,0,0.2) !important;
            color: rgba(255, 255, 255, 0.9) !important;
            font-family: -apple-system, "SF Pro Text", system-ui, sans-serif !important;
            overflow: hidden !important;
        }
        div.bubble-tip__content,
        div.bubble-tip_content { background: transparent !important; padding: 12px !important; }
        h2.bubble-tip-lockup__title {
            font-size: 13px !important;
            font-weight: 600 !important;
            color: rgba(255, 255, 255, 0.95) !important;
            margin: 0 0 2px !important;
        }
        p.bubble-tip-lockup__subtitle {
            font-size: 11px !important;
            color: rgba(255, 255, 255, 0.55) !important;
            margin: 0 !important;
        }
        button.bubble-tip__close {
            background: rgba(255, 255, 255, 0.14) !important;
            border: none !important;
            border-radius: 50% !important;
            width: 20px !important; height: 20px !important;
            color: rgba(255, 255, 255, 0.7) !important;
            cursor: pointer !important;
        }
        button.bubble-tip__close:hover {
            background: rgba(255, 255, 255, 0.25) !important;
            color: rgba(255, 255, 255, 0.95) !important;
        }
        /* Action area (e.g. "Set Location" button row) */
        div.bubble-tip_action { background: transparent !important; }

        /* ── Page footer ─────────────────────────────────────────────────── */
        footer,
        .web-footer,
        .page-footer,
        [class*="web-footer"] {
            background: rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(20px) saturate(1.5) !important;
            -webkit-backdrop-filter: blur(20px) saturate(1.5) !important;
            border-top: 0.5px solid rgba(255, 255, 255, 0.08) !important;
        }
    `;

    // ── Centralized page lifecycle ────────────────────────────────────────────
    // Injection sequence (in order):
    //   did-start-loading → insertCSS (pre-paint glass, no flash)
    //   did-frame-finish-load → wait for body → inject vision + renderer bundles
    //   app:ui-ready IPC → fade window in
    //
    // did-frame-finish-load fires when the main frame finishes loading
    // (after did-finish-load but before sub-frames), giving us a stable
    // document to inject into without the race of dom-ready.

    win.webContents.on('did-start-loading', () => {
        win.webContents.insertCSS(earlyCss).catch(() => {});
        win.webContents.insertCSS(contextMenuCss).catch(() => {});
    });

    let bundleInjected = false;

    async function injectBundles() {
        const url = win.webContents.getURL();
        if (!url.includes('music.apple.com') || bundleInjected) return;
        bundleInjected = true;
        console.log('[AML] Injecting bundles into world 0');

        // SSE must run first (creates window._amlEngine); cache+engine subscribe to it.
        // Vision is independent. Combine into one executeJavaScript call to avoid
        // 4 separate round-trips adding ~2-3s of sequential injection delay.
        const combined = [
            sseCode    ? `try{${sseCode}}catch(e){console.error('[AML sse]',e.message)}`    : '',
            visionCode ? `try{${visionCode}}catch(e){console.error('[AML vision]',e.message)}` : '',
            cacheCode  ? `try{${cacheCode}}catch(e){console.error('[AML cache]',e.name,e.message,e.stack)}`  : '',
            engineCode ? `try{${engineCode}}catch(e){console.error('[AML engine]',e.name,e.message,e.stack)}` : '',
        ].filter(Boolean).join(';');

        await win.webContents.executeJavaScript(combined)
            .catch(e => console.error('[AML] bundle injection error:', e));

        applyPersistedViewSettings();
    }

    win.webContents.on('did-frame-finish-load', injectBundles);

    win.webContents.on('did-navigate', () => {
        const url = win.webContents.getURL();
        if (url.includes('music.apple.com')) bundleInjected = false;
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('appleid.apple.com') || url.includes('idmsa.apple.com')) {
            win.loadURL(url);
            return { action: 'deny' };
        }
        if (url.startsWith('https://music.apple.com')) {
            win.loadURL(url);
            return { action: 'deny' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });

    win.webContents.on('did-navigate', () => {
        if (!win.isVisible()) win.show();
    });

    // Hide on close instead of destroying — keeps the page alive in memory so
    // the next show() is instant (zero load time).
    win.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            win.hide();
        }
    });

    win.on('closed', () => { win = null; });
}

// ── Dynamic view settings ─────────────────────────────────────────────────────

function setZoom(factor) {
    if (!win) return;
    win.webContents.setZoomFactor(factor);
    const p = loadPrefs(); p.zoomFactor = factor; savePrefs(p);
}

function applyTweak(key, value) {
    const p = loadPrefs(); p[key] = value; savePrefs(p);
    const css = buildTweakCSS(loadPrefs());
    win?.webContents.executeJavaScript(`
        (function() {
            let s = document.getElementById('aml-tweaks');
            if (!s) { s = document.createElement('style'); s.id = 'aml-tweaks'; document.head.appendChild(s); }
            s.textContent = ${JSON.stringify(css)};
        })();
    `).catch(() => {});
}

function buildTweakCSS(p) {
    return [
        p.hideUpsell !== false
            ? '.native-cta__button,.web-navigation__auth,cwc-upsell-banner,.locale-switcher-banner{display:none!important}'
            : '',
        p.hidePreviewBadge !== false
            ? 'cwc-badge[kind="preview"],.preview-badge,.web-chrome-playback-lcd__preview-badge{display:none!important}'
            : '',
    ].join('\n');
}

// ── Glass effect controls (visionOS panels) ───────────────────────────────────
// Writes CSS variables that vision-glass.js reads via var().
// No direct style conflicts — the glass CSS owns its rules, we just tune vars.
function applyGlassEffect(blur, opacity) {
    if (!win) return;
    const p = loadPrefs();
    p.glassBlur    = blur;
    p.glassOpacity = opacity;
    savePrefs(p);
    win.webContents.executeJavaScript(`
        document.documentElement.style.setProperty('--aml-glass-blur', '${blur}px');
        document.documentElement.style.setProperty('--aml-glass-opacity', '${opacity}');
    `).catch(() => {});
}

function applyPersistedViewSettings() {
    const p = loadPrefs();
    if (p.zoomFactor && p.zoomFactor !== 1.0)
        win?.webContents.setZoomFactor(p.zoomFactor);
    applyGlassEffect(p.glassBlur ?? 48, p.glassOpacity ?? 0.07);
    applyTweak('__noop', null);
}

// ── IPC: prefs + view controls (used by settings panel) ─────────────────────
ipcMain.handle('prefs:get', () => loadPrefs());
ipcMain.on('view:zoom',       (_, f) => setZoom(parseFloat(f)));
ipcMain.on('view:glass-blur', (_, b) => { const p = loadPrefs(); applyGlassEffect(parseInt(b), p.glassOpacity ?? 0.07); });
ipcMain.on('view:tweak',      (_, k, v) => applyTweak(k, v));


function createTray() {
    // White music-note icon — works on dark and light system trays.
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
        <path d="M8 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm9-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM8 16.5V6l9-2v8.5" stroke="white" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`);
    const icon = nativeImage.createFromBuffer(svg, { scaleFactor: 1 });

    tray = new Tray(icon);
    tray.setToolTip('Apple Music');

    const buildTrayMenu = () => Menu.buildFromTemplate([
        {
            label: win?.isVisible() ? 'Hide Apple Music' : 'Show Apple Music',
            click: () => {
                if (!win) return;
                if (win.isVisible() && win.isFocused()) { win.hide(); }
                else { win.show(); win.focus(); }
            },
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(buildTrayMenu());

    // Rebuild menu on each right-click so Show/Hide label is current.
    tray.on('right-click', () => tray.setContextMenu(buildTrayMenu()));

    // Left-click toggles the window.
    tray.on('click', () => {
        if (!win) return;
        if (win.isVisible() && win.isFocused()) { win.hide(); }
        else { win.show(); win.focus(); }
    });
}

app.whenReady().then(() => {
    console.log('[AML] Electron ready, process.type:', process.type);
    // Keep Chromium session data in its own subfolder so it doesn't
    // pollute the same directory as our app prefs/wrapper data.
    app.setPath('userData', path.join(CONFIG_DIR, 'electron-session'));

    const s = session.fromPartition('persist:apple-music');
    s.setPermissionRequestHandler((wc, perm, cb) => cb(true));

    // 1 GB disk cache — Apple Music loads ~80 MB of JS/CSS/fonts per session;
    // images from mzstatic.com add up fast. A larger cache means fewer network
    // round-trips on repeat visits. The flag must be set before the session
    // allocates its cache, so we set it on app.commandLine (takes effect on
    // next launch) AND rely on the header overrides below for this session.
    s.getCacheSize().then(size =>
        console.log('[AML] Cache size:', Math.round(size / 1024 / 1024) + ' MB'));
    app.commandLine.appendSwitch('disk-cache-size', String(1024 * 1024 * 1024));

    // ── Response header overrides ─────────────────────────────────────────────
    // Two jobs in one hook (single hook per session):
    //   1. Strip CSP so our injected bundles run without restrictions.
    //   2. Override cache headers so Chromium stores assets across restarts.
    //
    // Why aggressive image caching is safe:
    //   mzstatic.com URLs are content-addressed — the image hash is part of
    //   the path, so a given URL always returns the same bytes. Apple often
    //   sends Cache-Control: no-store on these (probably for analytics), which
    //   forces a full re-download every session. We flip that to 7 days.
    //
    // Why JS/CSS caching is safe:
    //   music.apple.com static bundles are fingerprinted (e.g. main.abc123.js).
    //   Extending their cache lifetime from Apple's conservative value to 24 h
    //   avoids re-validating ~80 MB of bundles on every launch.
    s.webRequest.onHeadersReceived((details, callback) => {
        const h = details.responseHeaders ?? {};

        // 1. Strip CSP
        delete h['content-security-policy'];
        delete h['Content-Security-Policy'];
        delete h['content-security-policy-report-only'];
        delete h['Content-Security-Policy-Report-Only'];

        // 2. Cache override
        const url = details.url || '';

        if (/mzstatic\.com/i.test(url)) {
            // Album art, artist photos — all URLs are content-addressed (hash in path).
            // Only extend the cache if Apple's own max-age is shorter than our target.
            // Never shorten a good value (album art already ships with ~187-day max-age).
            const MIN_GOOD = 7 * 24 * 3600; // 7 days in seconds
            const rawCC = (h['cache-control'] || h['Cache-Control'] || [''])[0];
            const m = rawCC.match(/max-age=(\d+)/i);
            const currentMaxAge = m ? parseInt(m[1], 10) : 0;

            if (currentMaxAge < MIN_GOOD) {
                // Extend: replace the short/missing directive.
                // `immutable` is safe because URLs are content-addressed.
                h['cache-control'] = [`public, max-age=${MIN_GOOD}, immutable`];
                delete h['Cache-Control'];
                delete h['pragma'];
                delete h['Pragma'];
                delete h['expires'];
                delete h['Expires'];
            }
            // If currentMaxAge >= MIN_GOOD, leave Apple's headers untouched.
        } else if (/music\.apple\.com/i.test(url) &&
                   /\.(js|mjs|css|woff2?|ttf|otf|eot|svg|png|jpg|jpeg|webp|avif|gif)(\?|$)/i.test(url)) {
            // Fingerprinted static assets — safe to cache for 24 h.
            // Only override if Apple is preventing caching (no-store / no-cache / max-age=0).
            const cc = (h['cache-control'] || h['Cache-Control'] || [''])[0];
            if (!cc || /no-store|no-cache|max-age=0/i.test(cc)) {
                h['cache-control'] = ['public, max-age=86400'];
                delete h['Cache-Control'];
                delete h['pragma'];
                delete h['Pragma'];
            }
        }

        callback({ cancel: false, responseHeaders: h });
    });

    // ── aml-engine:// protocol — proxies to the local engine API ─────────────
    // Protocol handlers are per-session. The global protocol.handle() only covers
    // the default session; BrowserWindows on a named partition (persist:apple-music)
    // must register on that session explicitly.
    const amlEngineHandler = async (request) => {
        // CORS preflight: browser sends OPTIONS before non-simple requests.
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin':  '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Accept, Cache-Control, Last-Event-ID',
                    'Access-Control-Max-Age':       '86400',
                },
            });
        }

        try {
            // URL is aml-engine://host/path?query. With standard:true the URL is
            // parsed normally: host = first path component (e.g. "api"),
            // pathname = the rest. Reconstruct the full engine path from both.
            const parsed = new URL(request.url);
            const engineUrl = `http://127.0.0.1:20025/${parsed.host}${parsed.pathname}${parsed.search}`;
            console.log(`[AML Protocol] ${request.method} ${engineUrl.replace('http://127.0.0.1:20025', '')}`);
            const body = ['GET', 'HEAD'].includes(request.method)
                ? undefined
                : await request.arrayBuffer();
            const upstream = await net.fetch(engineUrl, {
                method:  request.method,
                headers: Object.fromEntries(request.headers),
                body,
            });
            // Inject CORS header so the renderer (https://music.apple.com) can
            // read the response — required when corsEnabled:true on the scheme.
            const headers = new Headers(upstream.headers);
            headers.set('Access-Control-Allow-Origin', '*');
            return new Response(upstream.body, {
                status:     upstream.status,
                statusText: upstream.statusText,
                headers,
            });
        } catch (e) {
            console.error(`[AML Protocol] ERROR: ${e.message}`);
            return new Response(JSON.stringify({ error: e.message }), {
                status:  502,
                headers: {
                    'Content-Type':                'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }
    };

    protocol.handle('aml-engine', amlEngineHandler);
    s.protocol.handle('aml-engine', amlEngineHandler);

    Menu.setApplicationMenu(null);
    createWindow();
    createTray();

    // Always attempt to start the engine API server.  engine-playback.js checks
    // reachability at startup and silently falls back to the Apple CDN if the
    // engine isn't running, so a missing binary is not a hard failure.
    startEngine();
});

// window-all-closed fires when the window is hidden too, but we don't want
// to quit in that case — the window is just hidden, not destroyed.
// Actual quit goes through the tray "Quit" item which sets isQuitting = true.
app.on('window-all-closed', () => {
    if (isQuitting) {
        stopEngine();
        app.quit();
    }
    // Otherwise: window was hidden, keep the process alive.
});

app.on('before-quit', () => { isQuitting = true; });
