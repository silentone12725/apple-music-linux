import * as electronMain from 'electron/main';
const { app, BrowserWindow, ipcMain, session, shell, Menu } = electronMain;

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync, statSync, readFileSync as readFile, writeFileSync, mkdirSync } from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { WrapperProc, STATUS } = require('./wrapper.cjs');

// ── Persistence ──────────────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.config', 'apple-music-linux');
const PREF_FILE  = path.join(CONFIG_DIR, 'electron-prefs.json');
const SESSION_DB = path.join(CONFIG_DIR, 'wrapper-data', 'rootfs', 'data',
    'data', 'com.apple.android.music', 'files', 'mpl_db', 'accounts.sqlitedb');

function loadPrefs() {
    try { return JSON.parse(readFile(PREF_FILE, 'utf8')); } catch { return {}; }
}
function savePrefs(p) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(PREF_FILE, JSON.stringify(p, null, 2));
}

// Session detection — two signals required:
//  1. accounts.sqlitedb exists and is >8 KB (has content beyond empty schema)
//  2. WAL file also exists (written only during/after an actual write transaction)
// A corrupt database that's large but never had a real write won't have a WAL,
// making this more robust than size alone.
function hasSession() {
    try {
        if (!existsSync(SESSION_DB)) return false;
        if (statSync(SESSION_DB).size <= 8192) return false;
        // WAL file written only after a successful account write transaction.
        const wal = SESSION_DB + '-wal';
        return existsSync(wal) || statSync(SESSION_DB).size > 32768;
    } catch { return false; }
}

// ── Chromium flags ──────────────────────────────────────────────────────────
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features',
    'UseOzonePlatform,WaylandWindowDecorations,VaapiVideoDecoder');
app.commandLine.appendSwitch('disable-features', 'ExplicitSync');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// Chromium flag required for transparent windows on Linux.
// Hyprland/KWin handle the compositor-level blur-behind on the desktop
// side; Chromium just needs to render RGBA frames correctly.
app.commandLine.appendSwitch('enable-transparent-visuals');

let win = null;
let wrapper = null;

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

    // Inject the terminal renderer bundle directly from the main process into
    // world 0 — webContents.executeJavaScript() is guaranteed to target the
    // page's main world, unlike webFrame.executeJavaScriptInIsolatedWorld
    // which behaves inconsistently across Electron versions.
    const bundlePath  = path.join(__dirname, 'renderer-bundle.js');
    const bundleCode  = readFileSync(bundlePath, 'utf8');
    const visionPath  = path.join(__dirname, 'vision-bundle.js');
    const visionCode  = existsSync(visionPath) ? readFileSync(visionPath, 'utf8') : '';

    // ── Early CSS via insertCSS — fires before first paint, no preload risk ──
    // webContents.insertCSS() is Electron's dedicated API for injecting CSS
    // before the page renders, unlike executeJavaScript which needs dom-ready.
    const { glassBlur = 48, glassOpacity = 0.07 } = loadPrefs();
    const earlyCss = `
        :root { --aml-glass-blur: ${glassBlur}px; --aml-glass-opacity: ${glassOpacity}; --aml-art-tint: rgba(255,255,255,0); }
        html, body { background: transparent !important; }
        nav.navigation {
            background: rgba(255,255,255,var(--aml-glass-opacity)) !important;
            backdrop-filter: blur(var(--aml-glass-blur)) saturate(2) brightness(1.08) !important;
            -webkit-backdrop-filter: blur(var(--aml-glass-blur)) saturate(2) brightness(1.08) !important;
            border-right: 1px solid rgba(255,255,255,0.12) !important;
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
    });

    let bundleInjected = false;

    async function injectBundles() {
        const url = win.webContents.getURL();
        if (!url.includes('music.apple.com') || bundleInjected) return;
        bundleInjected = true;
        console.log('[AML] Injecting bundles into world 0');

        if (visionCode) {
            await win.webContents.executeJavaScript(visionCode)
                .catch(e => console.error('[AML] vision bundle error:', e));
        }

        await win.webContents.executeJavaScript(bundleCode)
            .then(() => applyPersistedViewSettings())
            .catch((err) => {
                if (String(err).includes('__aml:already_mounted'))
                    applyPersistedViewSettings();
                else
                    console.error('[AML] bundle inject error:', err);
            });
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

    win.on('closed', () => { win = null; });
}

// ── Dynamic view settings ─────────────────────────────────────────────────────

function setZoom(factor) {
    if (!win) return;
    win.webContents.setZoomFactor(factor);
    const p = loadPrefs(); p.zoomFactor = factor; savePrefs(p);
    // Update the radio group checked state without rebuilding the whole menu.
    const menu = Menu.getApplicationMenu();
    for (const f of [0.75, 1.0, 1.25, 1.5]) {
        const item = menu?.getMenuItemById(`zoom-${f}`);
        if (item) item.checked = Math.abs(f - factor) < 0.01;
    }
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

// ── Terminal appearance (opacity + blur, configurable from View menu) ─────────

const OPACITY_STEPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
const BLUR_STEPS    = [0, 10, 20, 30, 40, 50];

function applyTerminalAppearance(opacity, blur) {
    if (!win) return;
    const p = loadPrefs();
    p.termOpacity = opacity;
    p.termBlur    = blur;
    savePrefs(p);

    // Update checked state on all appearance menu items live.
    const menu = Menu.getApplicationMenu();
    for (const s of OPACITY_STEPS) {
        const item = menu?.getMenuItemById(`term-opacity-${s}`);
        if (item) item.checked = Math.abs(s - opacity) < 0.01;
    }
    for (const b of BLUR_STEPS) {
        const item = menu?.getMenuItemById(`term-blur-${b}`);
        if (item) item.checked = b === blur;
    }

    // Terminal is translucent-only (no backdrop-filter) to avoid
    // blur-over-blur with the page content behind it. Only opacity is live.
    win.webContents.executeJavaScript(`
        (function() {
            const el = document.getElementById('aml-term-overlay');
            if (!el) return;
            el.style.background = 'rgba(255,255,255,' + ${opacity} + ')';
            el.style.backdropFilter = 'none';
            el.style.webkitBackdropFilter = 'none';
        })();
    `).catch(() => {});
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

    const menu = Menu.getApplicationMenu();
    for (const b of BLUR_STEPS) {
        const item = menu?.getMenuItemById(`glass-blur-${b}`);
        if (item) item.checked = b === blur;
    }
    for (const s of OPACITY_STEPS) {
        const item = menu?.getMenuItemById(`glass-opacity-${s}`);
        if (item) item.checked = Math.abs(s - opacity) < 0.01;
    }

    win.webContents.executeJavaScript(`
        document.documentElement.style.setProperty('--aml-glass-blur', '${blur}px');
        document.documentElement.style.setProperty('--aml-glass-opacity', '${opacity}');
    `).catch(() => {});
}

function applyPersistedViewSettings() {
    const p = loadPrefs();
    if (p.zoomFactor && p.zoomFactor !== 1.0)
        win?.webContents.setZoomFactor(p.zoomFactor);
    applyTerminalAppearance(p.termOpacity ?? 0.88, p.termBlur ?? 50);
    applyGlassEffect(p.glassBlur ?? 48, p.glassOpacity ?? 0.07);
    applyTweak('__noop', null);
}

function makeWrapper() {
    return new WrapperProc(
        // onData
        (data) => { if (win) win.webContents.send('pty:data', data); },
        // onExit — keep xterm alive, notify renderer with exit code
        (code) => { if (win) win.webContents.send('pty:exit', code); buildAppMenu(); },
        // onHealth — update menu label + notify renderer
        (status) => {
            if (win) win.webContents.send('wrapper:health', status);
            buildAppMenu();
        }
    );
}

function startWrapper(login = '') {
    wrapper = makeWrapper();
    wrapper.start(login);
}

// ── IPC: terminal overlay ────────────────────────────────────────────────────
ipcMain.handle('wrapper:has-session', () => hasSession());
ipcMain.handle('wrapper:health',      () => wrapper?.status ?? STATUS.OFFLINE);

function doLogout() {
    if (wrapper) { wrapper.stop(); wrapper = null; }
    clearSession();
    if (win) win.webContents.send('wrapper:logged-out');
}
ipcMain.handle('wrapper:logout', doLogout);

// ── Input validation ──────────────────────────────────────────────────────────
function validateLogin(raw) {
    if (typeof raw !== 'string') return null;
    const login = raw.trim().slice(0, 256); // max 256 chars
    const colonIdx = login.indexOf(':');
    if (colonIdx < 1 || colonIdx === login.length - 1) return null; // must have email:pass
    return login;
}

function validateResize(cols, rows) {
    return (
        Number.isInteger(cols) && cols >= 10 && cols <= 300 &&
        Number.isInteger(rows) && rows >= 5  && rows <= 100
    );
}

ipcMain.on('pty:start', () => { if (!wrapper) startWrapper(); });

ipcMain.on('pty:input', (event, data) => {
    if (typeof data !== 'string' || data.length > 4096) return;
    if (!wrapper) startWrapper();
    wrapper.write(data);
});

ipcMain.on('pty:resize', (event, cols, rows) => {
    if (!validateResize(cols, rows)) return;
    if (wrapper) wrapper.resize(cols, rows);
});

ipcMain.on('pty:restart', () => {
    if (wrapper) wrapper.stop();
    startWrapper();
});

ipcMain.on('pty:login', (event, raw) => {
    const login = validateLogin(raw);
    if (!login) return; // silently drop invalid format
    if (wrapper) wrapper.stop();
    startWrapper(login);
});

function buildAppMenu() {
    const prefs = loadPrefs();
    const autoLaunch    = prefs.autoLaunch    !== false;
    const curOpacity    = prefs.termOpacity   ?? 0.4;
    const curBlur       = prefs.termBlur      ?? 30;

    const isMac = process.platform === 'darwin';
    const template = [
        ...(isMac ? [{ role: 'appMenu' }] : []),
        { role: 'fileMenu' },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { type: 'separator' },

                // ── Zoom (radio group, persisted, checked state auto-syncs) ──
                { label: 'Zoom', enabled: false },   // section header
                ...[0.75, 1.0, 1.25, 1.5].map((factor) => ({
                    id: `zoom-${factor}`,
                    label: `${Math.round(factor * 100)}%`,
                    type: 'radio',
                    checked: Math.abs((prefs.zoomFactor ?? 1.0) - factor) < 0.01,
                    click: () => setZoom(factor),
                })),
                { type: 'separator' },

                // ── Visual tweaks (checkboxes, applied via CSS injection) ────
                { label: 'Visual Tweaks', enabled: false },
                {
                    id: 'hide-upsell',
                    label: 'Hide "Open in App" Banners',
                    type: 'checkbox',
                    checked: prefs.hideUpsell !== false,
                    click: (item) => applyTweak('hideUpsell', item.checked),
                },
                {
                    id: 'hide-preview-badge',
                    label: 'Hide Preview Badge',
                    type: 'checkbox',
                    checked: prefs.hidePreviewBadge !== false,
                    click: (item) => applyTweak('hidePreviewBadge', item.checked),
                },
                { type: 'separator' },

                // ── Terminal panel: opacity + blur with 10-step submenus ──────
                {
                    label: 'Terminal Panel',
                    submenu: [
                        {
                            label: 'Background Opacity',
                            submenu: OPACITY_STEPS.map((s) => ({
                                id: `term-opacity-${s}`,
                                label: `${Math.round(s * 100)}%`,
                                type: 'radio',
                                checked: Math.abs(curOpacity - s) < 0.01,
                                click: () => applyTerminalAppearance(
                                    s, loadPrefs().termBlur ?? 30),
                            })),
                        },
                        {
                            label: 'Blur Strength',
                            submenu: BLUR_STEPS.map((b) => ({
                                id: `term-blur-${b}`,
                                label: b === 0 ? 'None' : `${b}px`,
                                type: 'radio',
                                checked: curBlur === b,
                                click: () => applyTerminalAppearance(
                                    loadPrefs().termOpacity ?? 0.4, b),
                            })),
                        },
                    ],
                },

                // ── Glass Effect — tunes CSS vars read by vision-glass.js ─────
                // Separate from Terminal Panel so the two don't fight each other.
                {
                    label: 'Glass Effect',
                    submenu: [
                        {
                            label: 'Blur Strength',
                            submenu: BLUR_STEPS.map((b) => ({
                                id: `glass-blur-${b}`,
                                label: b === 0 ? 'None' : `${b}px`,
                                type: 'radio',
                                checked: (prefs.glassBlur ?? 48) === b,
                                click: () => applyGlassEffect(
                                    b, loadPrefs().glassOpacity ?? 0.07),
                            })),
                        },
                        {
                            label: 'Panel Opacity',
                            submenu: OPACITY_STEPS.map((s) => ({
                                id: `glass-opacity-${s}`,
                                label: `${Math.round(s * 100)}%`,
                                type: 'radio',
                                checked: Math.abs((prefs.glassOpacity ?? 0.07) - s) < 0.01,
                                click: () => applyGlassEffect(
                                    loadPrefs().glassBlur ?? 48, s),
                            })),
                        },
                    ],
                },

                { type: 'separator' },
                { role: 'togglefullscreen' },
                { type: 'separator' },
                {
                    label: 'Developer Tools',
                    accelerator: 'CmdOrCtrl+Shift+I',
                    click: () => win?.webContents.toggleDevTools(),
                },
            ],
        },
        { role: 'windowMenu' },
        {
            label: 'Wrapper',
            submenu: [
                {
                    label: 'Toggle Terminal',
                    accelerator: 'CmdOrCtrl+`',
                    click: () => { if (win) win.webContents.send('terminal:toggle'); },
                },
                { type: 'separator' },
                // Health status — label updates via buildAppMenu() on every change.
                {
                    label: (() => {
                        const icons = { [STATUS.RUNNING]: '🟢', [STATUS.STARTING]: '🟡', [STATUS.OFFLINE]: '🔴' };
                        const s = wrapper?.status ?? STATUS.OFFLINE;
                        return `${icons[s] ?? '⚪'} ${s.charAt(0).toUpperCase() + s.slice(1)}`;
                    })(),
                    enabled: false,
                },
                { type: 'separator' },
                {
                    label: 'Auto-launch on Startup',
                    type: 'checkbox',
                    checked: autoLaunch,
                    click: (menuItem) => {
                        const p = loadPrefs();
                        p.autoLaunch = menuItem.checked;
                        savePrefs(p);
                    },
                },
                { type: 'separator' },
                {
                    label: 'Log Out / Switch Account',
                    click: () => { doLogout(); if (win) win.webContents.send('terminal:toggle'); },
                },
                { type: 'separator' },
                {
                    label: 'Restart Wrapper',
                    click: () => { if (wrapper) wrapper.stop(); startWrapper(); },
                },
                {
                    label: 'Kill Wrapper',
                    click: () => { if (wrapper) { wrapper.stop(); wrapper = null; } },
                },
            ],
        },
        { role: 'help' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
    console.log('[AML] Electron ready, process.type:', process.type);
    // Keep Chromium session data in its own subfolder so it doesn't
    // pollute the same directory as our app prefs/wrapper data.
    app.setPath('userData', path.join(CONFIG_DIR, 'electron-session'));

    const s = session.fromPartition('persist:apple-music');
    s.setPermissionRequestHandler((wc, perm, cb) => cb(true));

    // Increase disk cache to 512 MB so Apple Music's heavy JS/CSS bundles
    // survive across restarts — dramatically cuts repeat-visit load time.
    s.getCacheSize().then(size =>
        console.log('[AML] Cache size:', Math.round(size / 1024 / 1024) + ' MB'));
    // Note: Chromium's default cache limit can be tuned via command-line flag.
    app.commandLine.appendSwitch('disk-cache-size', String(512 * 1024 * 1024));

    // ── Strip Content-Security-Policy from all HTTPS responses ───────────────
    // Apple Music's CSP would block our injected renderer bundle (xterm.js,
    // adoptedStyleSheets, etc.). Following pear-desktop's exact approach:
    // delete the CSP header before the page sees it so our world-0 injection
    // runs without restrictions.
    s.webRequest.onHeadersReceived((details, callback) => {
        const h = details.responseHeaders ?? {};
        delete h['content-security-policy'];
        delete h['Content-Security-Policy'];
        delete h['content-security-policy-report-only'];
        delete h['Content-Security-Policy-Report-Only'];
        callback({ cancel: false, responseHeaders: h });
    });

    buildAppMenu();
    createWindow();

    // Auto-launch: if a stored session exists AND auto-launch is enabled,
    // start the wrapper silently in the background on every launch.
    // First-time users have no session yet — the renderer detects this and
    // opens the terminal automatically with a login prompt instead.
    const prefs = loadPrefs();
    if (prefs.autoLaunch !== false && hasSession()) {
        console.log('[AML] Session found — auto-launching wrapper');
        startWrapper();
    } else if (!hasSession()) {
        console.log('[AML] No session — terminal will prompt for login');
    }
});

app.on('window-all-closed', () => {
    if (wrapper) wrapper.stop();
    if (process.platform !== 'darwin') app.quit();
});
