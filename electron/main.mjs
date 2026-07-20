import * as electronMain from 'electron/main';
const { app, BrowserWindow, ipcMain, session, shell, Menu, Tray, nativeImage, desktopCapturer, dialog } = electronMain;
import { spawn, execFileSync, execFile } from 'child_process';

// Suppress EPIPE so a closed terminal pipe doesn't crash the main process.
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });


import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync, statSync, readFileSync as readFile, writeFileSync, mkdirSync, unlinkSync, createWriteStream } from 'fs';
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
    'UseOzonePlatform,WaylandWindowDecorations');
// MediaSessionService: Chromium's built-in MPRIS implementation runs on the
// same D-Bus session bus. When it tears down (e.g. on navigation), it disrupts
// the dbus-next socket that mpris-service owns → EPIPE on every property write.
// AudioServiceOutOfProcess: keep audio in-process so PulseAudio stream identity
// matches the desktop name we set.
app.commandLine.appendSwitch('disable-features',
    'ExplicitSync,MediaSessionService,AudioServiceOutOfProcess');
app.setDesktopName('apple-music-linux.desktop');
app.commandLine.appendSwitch('enable-gpu-rasterization');
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
// On kernels where unprivileged user namespaces are restricted (Ubuntu 23.10+,
// Debian 12+ with AppArmor), Electron's sandbox also fails to start.
// Detect and disable sandbox only when namespaces are unavailable.
try { execFileSync('unshare', ['--user', '--pid', 'true'], { stdio: 'ignore' }); }
catch { app.commandLine.appendSwitch('no-sandbox'); }

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

// Bundled VLC libs shipped alongside the engine binary so a system VLC
// upgrade/removal can't break audio playback.
const _vlcPkgDir  = path.join(process.resourcesPath, 'vlc');
const _vlcDevDir  = path.join(__dirname, 'dist', 'resources', 'vlc');
const _vlcDir     = app.isPackaged ? _vlcPkgDir : (existsSync(_vlcDevDir) ? _vlcDevDir : _vlcPkgDir);

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
    // Wrapper binary: packaged at <resources>/wrapper, dev fallback beside wrapper/
    const wrapperBin = app.isPackaged && existsSync(path.join(process.resourcesPath, 'wrapper'))
        ? path.join(process.resourcesPath, 'wrapper')
        : path.join(__dirname, '..', 'wrapper', 'wrapper-rootless');

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

    // Patch existing config: add missing wrapper paths or update stale ones.
    let content = readFile(cfgPath, 'utf8');
    let changed = false;
    for (const [key, val] of [['wrapper-binary-path', wrapperBin], ['wrapper-base-dir', wrapperBase]]) {
        const line = `${key}: "${val}"`;
        if (!content.includes(`${key}:`)) {
            content += `${line}\n`;
            changed = true;
        } else if (!content.includes(line)) {
            content = content.replace(new RegExp(`${key}:.*`), line);
            changed = true;
        }
    }
    if (changed) writeFileSync(cfgPath, content);
}

function execFileAsync(cmd, args, opts = {}) {
    return new Promise(resolve => {
        execFile(cmd, args, { encoding: 'utf8', ...opts }, (err, stdout) => resolve(err ? '' : stdout));
    });
}

async function killStaleEngine(port) {
    // SIGKILL anything on the port — no graceful shutdown needed for a stale engine.
    const out = await execFileAsync('ss', ['-tlnpH', `sport = :${port}`],
        { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/pid=(\d+)/);
    if (m) {
        const pid = parseInt(m[1], 10);
        console.log(`[AML] Killing stale engine on port ${port} (pid ${pid})`);
        try { process.kill(pid, 'SIGKILL'); } catch (_) {}
    }

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

async function isPortFree(port) {
    const out = await execFileAsync('ss', ['-tlnH', `sport = :${port}`], { timeout: 1000 });
    return out.trim() === '';
}

async function startEngine() {
    if (engineProc) return;
    if (!existsSync(ENGINE_BIN)) {
        console.log('[AML] Engine binary not found at', ENGINE_BIN, '— skipping engine start');
        return;
    }
    await killStaleEngine(ENGINE_PORT);
    // Wait up to 2 s for the port to be released after SIGKILL.
    for (let i = 0; i < 20; i++) {
        if (await isPortFree(ENGINE_PORT)) break;
        await new Promise(r => setTimeout(r, 100));
    }
    ensureEngineConfig();
    const vlcEnv = existsSync(_vlcDir) ? {
        LD_LIBRARY_PATH: [_vlcDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
        VLC_PLUGIN_PATH: path.join(_vlcDir, 'plugins'),
    } : {};
    engineProc = spawn(ENGINE_BIN, ['--api', String(ENGINE_PORT)], {
        cwd: ENGINE_DATA_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Force Go's pure-Go DNS resolver to avoid CGO getaddrinfo SIGSEGV
        // when the engine makes HTTP requests to Apple's API servers.
        env: { ...process.env, GODEBUG: 'netdns=go', ...vlcEnv },
    });
    const onOut = (d) => console.log('[engine]', d.toString().trimEnd());
    const onErr = (d) => {
        const line = d.toString().trimEnd();
        console.error('[engine]', line);
        // Unprivileged user namespaces disabled (Ubuntu 23.10+, Debian 12+ with AppArmor).
        // The wrapper needs clone(CLONE_NEWUSER|CLONE_NEWPID) — surface this clearly.
        if (line.includes('operation not permitted') || line.includes('unshare') ||
            line.includes('clone') || line.includes('user namespace')) {
            dialog.showErrorBox(
                'Kernel restriction detected',
                'The FairPlay wrapper requires unprivileged user namespaces, which are disabled on this system.\n\n' +
                'To fix:\n  sudo sysctl -w kernel.unprivileged_userns_clone=1\n\n' +
                'Or permanently in /etc/sysctl.d/99-userns.conf:\n  kernel.unprivileged_userns_clone = 1'
            );
        }
    };
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

// ── Software compositing blur fallback ───────────────────────────────────────
// Used on X11 or Wayland compositors that don't support blur-behind (GNOME/Sway).
// Captures a desktop screenshot, sends it to the renderer as a blurred CSS background.
const _isWayland = !!process.env.WAYLAND_DISPLAY;
const _desktop   = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
const _useSoftBlur = !_isWayland ||
    ['gnome', 'sway', 'unity', 'cosmic', 'budgie'].some(d => _desktop.includes(d));

let _bgTimer = null;
async function refreshBlurBg() {
    if (!win || !_useSoftBlur) return;
    // Always activate the class — dark tint + CSS backdrop-filter works even
    // without a screenshot. Background URL is best-effort on top.
    win.webContents.executeJavaScript(
        `document.documentElement.classList.add('aml-sw-blur');`
    ).catch(() => {});
    const { width, height } = win.getBounds();
    const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: { width, height }
    }).catch(() => []);
    if (!sources.length) return;
    const dataUrl = sources[0].thumbnail.toDataURL();
    win.webContents.executeJavaScript(
        `document.documentElement.style.setProperty('--aml-fallback-bg','url("${dataUrl.replace(/\\/g,'\\\\').replace(/"/g,'\\"')}") ');`
    ).catch(() => {});
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
            devTools: true,
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
        // Capture desktop behind window for software blur fallback (X11 / GNOME).
        if (_useSoftBlur) refreshBlurBg();
    };
    win.on('move', () => {
        clearTimeout(_bgTimer);
        _bgTimer = setTimeout(refreshBlurBg, 500);
    });
    const showFallback = setTimeout(showWindow, 12000);

    ipcMain.once('app:ui-ready', () => {
        clearTimeout(showFallback);
        showWindow();
    });
    // DevTools: open when AML_DEVTOOLS env var is set OR when debug pref is true.
    // Toggle via AML Settings → Developer → Enable debug mode (persists across restarts).
    const { debug: debugPref = false } = loadPrefs();
    if (process.env.AML_DEVTOOLS || debugPref) {
        // Log file: new file per run, in ~/.config/apple-music-linux/logs/
        const logsDir = path.join(CONFIG_DIR, 'logs');
        mkdirSync(logsDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const logStream = createWriteStream(path.join(logsDir, `debug-${stamp}.log`));
        const _write = (tag, args) => logStream.write(`[${new Date().toISOString()}] ${tag} ${args.join(' ')}\n`);
        const origLog = console.log, origError = console.error, origWarn = console.warn;
        console.log   = (...a) => { origLog(...a);   _write('LOG  ', a); };
        console.error = (...a) => { origError(...a); _write('ERROR', a); };
        console.warn  = (...a) => { origWarn(...a);  _write('WARN ', a); };

        win.webContents.openDevTools({ mode: 'detach' });
        win.webContents.on('console-message', (event) => {
            const msg = event.message ?? event;
            if (typeof msg === 'string') console.log('[renderer]', msg);
        });
    }

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
        :root { --aml-glass-blur: ${glassBlur}px; --aml-glass-opacity: ${glassOpacity}; --aml-art-tint: rgba(255,255,255,0); --aml-fallback-bg: none; }
        html, body { background: transparent !important; overscroll-behavior: none !important; }
        /* Strip grey tint from alternating content sections — let album art / wallpaper show through */
        .section--alternate, [class*="section--alternate"] { background: transparent !important; }
        nav.navigation {
            background: rgba(255,255,255,var(--aml-glass-opacity)) !important;
            backdrop-filter: blur(var(--aml-glass-blur)) !important;
            -webkit-backdrop-filter: blur(var(--aml-glass-blur)) !important;
            border-right: 1px solid rgba(255,255,255,0.12) !important;
        }
        /* Software compositing blur fallback (X11 / GNOME / Sway).
           Activated by adding .aml-sw-blur to <html> and setting --aml-fallback-bg. */
        html.aml-sw-blur::before {
            content: '';
            position: fixed;
            inset: -40px;
            background: var(--aml-fallback-bg) center / cover no-repeat;
            filter: blur(var(--aml-glass-blur));
            z-index: -1;
            pointer-events: none;
        }
        html.aml-sw-blur body::before {
            content: '';
            position: fixed;
            inset: 0;
            background: rgba(10, 10, 12, 0.5);
            z-index: -1;
            pointer-events: none;
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
            backdrop-filter: blur(32px) !important;
            -webkit-backdrop-filter: blur(32px) !important;
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
            backdrop-filter: blur(20px) !important;
            -webkit-backdrop-filter: blur(20px) !important;
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
            `window._amlEngineURL='http://127.0.0.1:${ENGINE_PORT}';`,
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
ipcMain.on('pref:set',        (_, k, v) => { const p = loadPrefs(); p[k] = v; savePrefs(p); });
ipcMain.on('view:zoom',       (_, f) => setZoom(parseFloat(f)));
ipcMain.on('view:glass-blur', (_, b) => { const p = loadPrefs(); applyGlassEffect(parseInt(b), p.glassOpacity ?? 0.07); });
ipcMain.on('view:tweak',      (_, k, v) => applyTweak(k, v));

// ── MPRIS2 media integration ─────────────────────────────────────────────────
// Exposes Now Playing info to the system (taskbars, media keys, GNOME shell,
// KDE Connect, etc.) via the org.mpris.MediaPlayer2 D-Bus interface.
let mprisPlayer = null;
let _MprisService = null;
try {
    const _require = createRequire(import.meta.url);
    _MprisService = _require('mpris-service');
} catch (e) {
    console.warn('[AML] mpris-service not available:', e.message);
}

// dbus-next throws "Cannot send message, stream is closed" asynchronously from
// inside its socket data handler — outside any try/catch. Intercept it here
// so it doesn't crash the app, and null mprisPlayer so the next update reconnects.
process.on('uncaughtException', (err) => {
    if (err?.message?.includes('stream is closed') || err?.code === 'EPIPE') {
        console.warn('[AML] MPRIS D-Bus uncaught (suppressed):', err.message);
        _destroyMprisPlayer();
        return;
    }
    // Re-throw anything unrelated to D-Bus.
    console.error('Uncaught exception:', err);
    app.exit(1);
});

// Properly release the D-Bus service name before nulling the player.
// Without this, the old player holds the name and retries are rejected (EPIPE).
function _destroyMprisPlayer() {
    const old = mprisPlayer;
    mprisPlayer = null;
    if (!old) return;
    try { old._bus?.disconnect(); } catch (_) {}
}

function _mprisReady() {
    // D-Bus session bus must be available.
    return !!process.env.DBUS_SESSION_BUS_ADDRESS || !!process.env.XDG_RUNTIME_DIR;
}

let _mprisRetryTimer = null;
function createMprisPlayer() {
    if (!_MprisService || !_mprisReady()) return null;
    try {
        const player = _MprisService({
            name: 'apple-music-linux',
            identity: 'Apple Music',
            supportedUriSchemes: [],
            supportedMimeTypes: ['audio/mpeg', 'audio/flac'],
            supportedInterfaces: ['player'],
            desktopEntry: 'apple-music-linux',
        });
        // Don't set any properties here. Every setter emits PropertiesChanged
        // over D-Bus. sessionBus() connects synchronously but the D-Bus auth
        // handshake completes asynchronously — writing before it finishes
        // causes EPIPE / "stream is closed". Defaults are already correct
        // (Stopped, can*=true, empty metadata).

        // Override getPosition() so D-Bus GetPosition returns the live position.
        // _lastMprisPosition is updated by mpris:update IPC every ~1s.
        player.getPosition = () => _lastMprisPosition;

        const sendCmd = (cmd) => win?.webContents.send('mpris:cmd', cmd);
        player.on('play',      () => sendCmd('play'));
        player.on('pause',     () => sendCmd('pause'));
        player.on('playpause', () => sendCmd('playpause'));
        player.on('next',      () => sendCmd('next'));
        player.on('previous',  () => sendCmd('previous'));
        player.on('stop',      () => sendCmd('pause'));

        // MPRIS → app: Seek (delta µs) and SetPosition (absolute µs).
        // dbus-next returns int64 as BigInt; convert to Number before dividing.
        player.on('seek', (offset) => {
            win?.webContents.send('mpris:cmd', { type: 'seek', deltaMs: Number(offset) / 1000 });
        });
        player.on('position', (event) => {
            win?.webContents.send('mpris:cmd', { type: 'setPosition', ms: Number(event.position) / 1000 });
        });

        // When D-Bus signals an error, null the player and schedule a reconnect
        // so the next mpris:update (or the retry timer) re-registers the service.
        player.on('error', (err) => {
            console.warn('[AML] MPRIS D-Bus error:', err?.message ?? err);
            // Disconnect the old bus before nulling so D-Bus releases the name.
            // Without this, retries are rejected (EPIPE) because the zombie
            // player still holds org.mpris.MediaPlayer2.apple-music-linux.
            if (mprisPlayer === player) _destroyMprisPlayer();
            if (!_mprisRetryTimer) {
                _mprisRetryTimer = setTimeout(() => {
                    _mprisRetryTimer = null;
                    if (!mprisPlayer) {
                        mprisPlayer = createMprisPlayer();
                        if (mprisPlayer) replayMprisState();
                    }
                }, 2000);
            }
        });

        console.log('[AML] MPRIS2 service registered');
        return player;
    } catch (e) {
        console.warn('[AML] MPRIS2 init failed:', e.message);
        return null;
    }
}

let _lastMprisStatus   = null;
let _lastMprisMetadata = null;
let _lastMprisPosition = 0; // µs

function applyMprisData(data) {
    // Snapshot player — the error event handler may null mprisPlayer
    // synchronously during a property set, causing null-dereference below.
    const p = mprisPlayer;
    if (!p) return;
    if (data.status) {
        p.playbackStatus = data.status;
        p.canSeek = true;
    }
    if (data.metadata) {
        const meta = { ...data.metadata };
        // mprisTrackId() already returns a valid D-Bus object path
        // (/com/apple/music/track/…). Do NOT pass through p.objectPath() —
        // that prepends /org/node/mediaplayer/apple-music-linux/ whose
        // "apple-music-linux" segment contains hyphens, which are illegal
        // in D-Bus object path elements ([A-Za-z0-9_] only). The daemon
        // rejects the malformed message and closes the socket, causing every
        // subsequent write to EPIPE.
        p.metadata = meta;
        p.canSeek = true;
    }
    if (data.position != null) {
        try { p.position = data.position; } catch (_) {}
    }
}

function replayMprisState() {
    if (!mprisPlayer) return;
    // Give the D-Bus auth handshake a moment to complete before the first write.
    setTimeout(() => {
        if (!mprisPlayer) return;
        try {
            if (_lastMprisStatus)   applyMprisData({ status: _lastMprisStatus });
            if (_lastMprisMetadata) applyMprisData({ metadata: _lastMprisMetadata });
            if (_lastMprisPosition) applyMprisData({ position: _lastMprisPosition });
        } catch (_) {}
    }, 400);
}

ipcMain.on('mpris:update', (_, data) => {
    // Track each field independently so all survive across reconnects.
    if (data.status)     _lastMprisStatus   = data.status;
    if (data.metadata)   _lastMprisMetadata = data.metadata;
    if (data.position != null) _lastMprisPosition = data.position;

    const wasNull = !mprisPlayer;
    if (!mprisPlayer) mprisPlayer = createMprisPlayer();
    if (!mprisPlayer) return;

    if (wasNull) {
        // Fresh player — D-Bus handshake is async; defer all property writes.
        replayMprisState();
        return;
    }
    try {
        applyMprisData(data);
        // Emit the Seeked signal whenever the renderer requests it (after an
        // actual seek or on resume so clients re-anchor their position display).
        if (data.seeked && _lastMprisPosition) {
            try { mprisPlayer.seeked(_lastMprisPosition); } catch (_) {}
        }
    } catch (e) {
        console.warn('[AML] MPRIS update failed, will reconnect:', e.message);
        _destroyMprisPlayer();
    }
});


function createTray() {
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'tray-icon.png')
        : path.join(__dirname, '..', 'tray-icon.png');
    const icon = nativeImage.createFromPath(iconPath);

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
    // Defer MPRIS init by 1.5 s — Electron's D-Bus socket access isn't
    // reliable the instant app is ready; a short delay avoids the EPIPE
    // that fires when the auth handshake races the first property write.
    setTimeout(() => { if (!mprisPlayer) mprisPlayer = createMprisPlayer(); }, 1500);

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

// Ctrl+C in the launch terminal sends SIGINT. Without this handler Electron
// ignores it (the window-close override keeps the process alive).
process.on('SIGINT', () => {
    isQuitting = true;
    stopEngine();
    app.quit();
});
