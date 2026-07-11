'use strict';

// When launched via system electron38, 'electron' resolves via the binary's
// built-in module registry, not npm. No require('electron') needed — the
// global APIs are injected directly by the Electron runtime.
const { app, BrowserWindow, ipcMain, session, shell } = process.type === 'browser'
    ? require('electron')
    : (() => { throw new Error('Run with electron, not node'); })();
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { WrapperProc } = require('./wrapper');

// ── Chromium flags — set before app is ready ─────────────────────────────────
// Native Wayland with hardware acceleration. Electron's Chromium renderer
// handles NVIDIA+Wayland correctly without any of the WebKitGTK workarounds.
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features',
    'UseOzonePlatform,WaylandWindowDecorations,VaapiVideoDecoder');
// Disable NVIDIA explicit sync on Wayland socket (same fix as before, but
// here it's a Chromium switch rather than a system env var).
app.commandLine.appendSwitch('disable-features', 'ExplicitSync');
// Hardware acceleration on — Chromium manages its own GPU process and
// falls back gracefully, unlike WebKitGTK which crashes on bad GBM allocs.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// Required for transparent BrowserWindow on Wayland/X11
app.commandLine.appendSwitch('enable-transparent-visuals');

let win = null;
let wrapper = null;

// ── KWin blur-behind helper ──────────────────────────────────────────────────
// Sets _KDE_NET_WM_BLUR_BEHIND_REGION on the window so KWin composites
// a blur of whatever is behind the window through transparent areas.
// Works on X11 and XWayland. On native Wayland with KWin, KWin 6+ picks up
// the org_kde_kwin_blur protocol automatically when the window is transparent.
function applyKWinBlur(browserWindow) {
    // Get the native X11 window ID (Buffer, little-endian UInt32)
    const handle = browserWindow.getNativeWindowHandle();
    const xid = handle.readUInt32LE(0).toString(16);
    if (!xid || xid === '0') return;

    // Setting region to empty (0 args) tells KWin to blur the entire window.
    execFile('xprop', [
        '-id', `0x${xid}`,
        '-f', '_KDE_NET_WM_BLUR_BEHIND_REGION', '32c',
        '-set', '_KDE_NET_WM_BLUR_BEHIND_REGION', '0',
    ], (err) => {
        if (err) {
            // xprop not available or not on X11 — silent fallback for Wayland
            console.log('KWin blur: xprop unavailable, blur-behind not applied.');
        } else {
            console.log(`KWin blur: applied to window 0x${xid}`);
        }
    });
}

function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        // Transparent background lets KWin blur show through the page.
        // The page body is made transparent via preload CSS injection.
        transparent: true,
        backgroundColor: '#00000000',
        show: false,
        title: 'Apple Music',
        webPreferences: {
            // Preload runs in an isolated context on EVERY page load —
            // no 3-second polling loop, no main-thread saturation.
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Allow cookies and storage from music.apple.com.
            partition: 'persist:apple-music',
        },
    });

    // Navigate directly to Apple Music — no custom login page.
    win.loadURL('https://music.apple.com');

    win.once('ready-to-show', () => {
        win.show();
        // Apply KWin blur after the window is mapped to the compositor
        applyKWinBlur(win);
    });

    // ── Fix Apple ID Sign In popup ──────────────────────────────────────────
    // In WebKitGTK/Wails, window.open() silently failed (no signal hooked),
    // breaking the Apple ID OAuth flow. Here we intercept it and either:
    //  • open Apple auth pages in the SAME window (keeps session/cookies), or
    //  • open external links in the system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('appleid.apple.com') || url.includes('idmsa.apple.com')) {
            // Apple ID OAuth — load in same window so cookies are shared.
            win.loadURL(url);
            return { action: 'deny' };
        }
        if (url.startsWith('https://music.apple.com')) {
            win.loadURL(url);
            return { action: 'deny' };
        }
        // Everything else (support pages, external links) → system browser.
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // Navigate back to Apple Music after Apple ID login completes.
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.includes('apple.com')) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    win.webContents.on('did-navigate', (event, url) => {
        // After Apple ID login redirects back to music.apple.com, show window.
        if (!win.isVisible()) win.show();
    });

    win.on('closed', () => { win = null; });
}

// ── IPC: wrapper terminal ────────────────────────────────────────────────────
ipcMain.handle('wrapper:getLogs', () => wrapper ? wrapper.logs() : []);

ipcMain.handle('wrapper:login', (event, loginStr) => {
    if (wrapper) wrapper.stop();
    wrapper = new WrapperProc((line) => {
        if (win) win.webContents.send('wrapper:log', line);
    });
    return wrapper.start(loginStr);
});

ipcMain.handle('wrapper:start', () => {
    if (wrapper) return;
    wrapper = new WrapperProc((line) => {
        if (win) win.webContents.send('wrapper:log', line);
    });
    wrapper.start('');
});

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
    // Cookie persistence — WebKitGTK required manual patching for this;
    // Electron handles it automatically via the named session partition.
    session.fromPartition('persist:apple-music').setPermissionRequestHandler(
        (webContents, permission, callback) => callback(true)
    );

    createWindow();

    // Start wrapper immediately (uses existing session DB if already logged in).
    ipcMain.emit('wrapper:start');
});

app.on('window-all-closed', () => {
    if (wrapper) wrapper.stop();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (!win) createWindow();
});
