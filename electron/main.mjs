import * as electronMain from 'electron/main';
const { app, BrowserWindow, ipcMain, session, shell, Menu, Tray, nativeImage, desktopCapturer, dialog, globalShortcut, screen, nativeTheme, safeStorage, protocol, net: electronNet } = electronMain;
import { spawn, execFileSync, execFile } from 'child_process';
import { createEngineLifecycle, recoverOrphanEngine, isPortFree } from './engine-lifecycle.mjs';

// Suppress EPIPE so a closed terminal pipe doesn't crash the main process.
// A terminal that goes away (closed window, SSH drop) surfaces as EPIPE or EIO.
process.stdout.on('error', (e) => { if (!['EPIPE', 'EIO'].includes(e.code)) throw e; });
process.stderr.on('error', (e) => { if (!['EPIPE', 'EIO'].includes(e.code)) throw e; });


import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, existsSync, statSync, readFileSync as readFile, writeFileSync, mkdirSync, unlinkSync, createWriteStream, createReadStream, readdirSync, cpSync } from 'fs';
import { readFile as readFileAsync } from 'fs/promises';
import os from 'os';
import { isatty } from 'tty';
import net from 'net';
import crypto from 'crypto';
import { hasSessionBus, mprisRetryDelay, IS_WIN, IS_LINUX, configRoot, engineFileName, engineLibEnv, discordIpcPaths, yamlStr, migrateLegacyConfig, migrateStoreKeys } from './platform.mjs';
import { createWinIntegration, APP_USER_MODEL_ID } from './win-integration.mjs';
import { parseLink, isLinkArg } from './deeplink.mjs';
import { createLinkSchemeManager } from './link-schemes.mjs';
import { resolveThemeMode } from './theme-mode.mjs';
import { BUILTIN_PRESETS, defaultPalette, migrateThemePrefs, sanitizePalette, sanitizePreset } from './theme-presets.mjs';
import { writeFileAtomicSync, writeFileAtomic } from './atomic-write.mjs';
import { validBackstop, writeBackstop, clearCredentialsFlow } from './drm-signout.mjs';
import { parseByteRange } from './range.mjs';
import { shouldShowOffline, offlineHash } from './load-failure.mjs';
import { runCleanupThrottled, cleanupCache } from './config-cleanup.mjs';
import { gnomeWallpaperPath } from './wallpaper.mjs';
import { acrylicBackend, normalizeAcrylic, acrylicOverlayScript, ACRYLIC_DEFAULTS } from './acrylic.mjs';
import { setCompositionBackdrop, setNativeCaptionDrag, removeCompositionBackdrop } from './composition-backdrop.mjs';
import { cleanBlur, cleanGlassOpacity, sidebarOpacityControl, artNavAlpha } from './src/engine/sidebar-glass.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Persistence ──────────────────────────────────────────────────────────────
// %APPDATA% on Windows; ~/.config elsewhere (or the Flatpak's own XDG_CONFIG_HOME). See platform.mjs.
const CONFIG_DIR = migrateLegacyConfig(configRoot(), 'adam');
const PREF_FILE  = path.join(CONFIG_DIR, 'electron-prefs.json');

// Chromium's profile lives in its own subfolder so it doesn't mix with our prefs/drm data. This must
// run before the app is ready (and before the single-instance lock): set later, part of the profile
// had already been created at the config root, leaving two half-used copies.
app.setPath('userData', path.join(CONFIG_DIR, 'electron-session'));
// Cap the HTTP cache at 256 MB. Chromium reads this once, while it sets up the cache, so it has to be
// on the command line before the session exists; appended after ready it did nothing and the cache
// grew without bound (hundreds of MB past the cap).
app.commandLine.appendSwitch('disk-cache-size', String(256 * 1024 * 1024));

function loadPrefs() {
    try { return JSON.parse(readFile(PREF_FILE, 'utf8')); } catch { return {}; }
}
function savePrefs(p) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileAtomicSync(PREF_FILE, JSON.stringify(p, null, 2));
}

// ── Encrypted store ───────────────────────────────────────────────────────────
// Per-key AES-256-GCM encryption via Electron safeStorage (OS keyring / DPAPI).
// Falls back to plaintext in the same file if safeStorage is unavailable.
const STORE_FILE = path.join(CONFIG_DIR, 'adam-store.enc');
let _storeCache = null;    // in-memory cache to avoid race on rapid writes
let _storeDirty = false;
let _storeFlushTimer = null;

async function _storeLoad() {
    if (_storeCache) return _storeCache;
    try {
        const raw = await readFileAsync(STORE_FILE);
        const enc = safeStorage.isEncryptionAvailable();
        _storeCache = enc
            ? JSON.parse(safeStorage.decryptString(raw))
            : JSON.parse(raw.toString('utf8'));
        if (migrateStoreKeys(_storeCache)) { _storeDirty = true; _storeFlush(); }
    } catch { _storeCache = {}; }
    return _storeCache;
}

let _storeWrite = Promise.resolve(); // serialises flushes: two overlapping writes must not interleave
// _storeFlushNow writes the store now and resolves to whether that write succeeded.
function _storeFlushNow() {
    if (_storeFlushTimer) { clearTimeout(_storeFlushTimer); _storeFlushTimer = null; }
    let ok = false;
    _storeWrite = _storeWrite.then(async () => {
        try {
            if (!_storeCache) { ok = true; return; }
            mkdirSync(CONFIG_DIR, { recursive: true });
            const enc = safeStorage.isEncryptionAvailable();
            const json = JSON.stringify(_storeCache);
            await writeFileAtomic(STORE_FILE, enc ? safeStorage.encryptString(json) : json);
            _storeDirty = false;
            ok = true;
        } catch (e) {
            _storeDirty = true;
            console.warn('[Adam] store flush failed:', e.message);
        }
    });
    return _storeWrite.then(() => ok);
}
function _storeFlush() {
    if (_storeFlushTimer) return;
    _storeFlushTimer = setTimeout(() => {
        _storeFlushTimer = null;
        if (!_storeDirty || !_storeCache) return;
        _storeDirty = false;
        _storeWrite = _storeWrite.then(async () => {
            try {
                mkdirSync(CONFIG_DIR, { recursive: true });
                const enc = safeStorage.isEncryptionAvailable();
                const json = JSON.stringify(_storeCache); // latest state when this step runs
                await writeFileAtomic(STORE_FILE, enc ? safeStorage.encryptString(json) : json);
            } catch (e) {
                _storeDirty = true; // keep the change; the next flush retries
                console.warn('[Adam] store flush failed:', e.message);
            }
        });
    }, 200);
}

// ── Chromium flags ──────────────────────────────────────────────────────────
if (IS_WIN) app.setAppUserModelId(APP_USER_MODEL_ID); // taskbar grouping, toasts and SMTC identity
if (IS_LINUX) {
// Opt-in (Settings → Display → Reduce animations): Chromium's reduced-motion preference makes the
// web player show still artwork instead of animated backgrounds.
if (loadPrefs().reduceMotion === true) app.commandLine.appendSwitch('force-prefers-reduced-motion');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.commandLine.appendSwitch('enable-features',
    'UseOzonePlatform,WaylandWindowDecorations,' +
    // Hardware H.264 decode for MV video. MV runs on the native <video src> path
    // (and optionally WebCodecs), never MSE video — so the Chrome 138 VA-API→
    // FFmpeg mid-stream fallback that surfaced as CHUNK_DEMUXER_ERROR on MSE
    // cannot occur here (no ChunkDemuxer). MSE carries only AAC audio, which a
    // video decoder never touches. Cuts RAM+CPU vs software decode.
    'VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxGL');
// Linux blocklists VA-API decode on many driver/compositor combos; without this
// the enable-features above is silently ignored.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// MediaSessionService: Chromium's built-in MPRIS implementation runs on the
// same D-Bus session bus. When it tears down (e.g. on navigation), it disrupts
// the dbus-next socket that mpris-service owns → EPIPE on every property write.
// AudioServiceOutOfProcess: keep audio in-process so PulseAudio stream identity
// matches the desktop name we set.
app.commandLine.appendSwitch('disable-features',
    'ExplicitSync,MediaSessionService,AudioServiceOutOfProcess');
app.setDesktopName('adam.desktop');
}
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
if (IS_LINUX) app.commandLine.appendSwitch('enable-transparent-visuals');
// Sandbox detection: requires both unprivileged user namespaces AND a non-FUSE
// root. AppImages use FUSE mounts that break the zygote sandbox startup even
// when namespaces work, so we disable it whenever APPIMAGE is set.
let _hasSandbox = IS_LINUX ? !process.env.APPIMAGE : true;
if (IS_LINUX) {
    try { execFileSync('unshare', ['--user', '--pid', 'true'], { stdio: 'ignore' }); }
    catch { _hasSandbox = false; app.commandLine.appendSwitch('no-sandbox'); }
}

let win    = null;
let tray   = null;
const linkSchemes = createLinkSchemeManager({ app, loadPrefs, savePrefs });
// Windows blur theme uses the local Composition Gaussian backend on both supported Windows versions.
const _acrylicBackend = !IS_WIN ? null
    : acrylicBackend(os.release());
const _acrylicSettings = () => normalizeAcrylic(loadPrefs().winAcrylic, _acrylicBackend?.materials);
// Windows window/taskbar icon when running from source: a packaged build's icon is stamped into adam.exe by the installer.
const _devWindowIcon = IS_WIN && !app.isPackaged ? { icon: path.join(__dirname, 'icon.ico') } : {};
if (_acrylicBackend) nativeTheme.on('updated', () => {
    if (_acrylicSettings().theme === 'system') _applyAcrylic();
});
let winIntegration = null; // Windows only: SMTC, taskbar buttons, jump list, login item
const _startHidden = process.argv.includes('--hidden');
let isQuitting = false;

// ── Deep link handling ────────────────────────────────────────────────────────
// Links arrive as adam://…, music://… and the other Apple Music schemes the user opted into
// (Settings → Links), or as music.apple.com URLs passed on the command line. deeplink.mjs
// turns them into either a play/open intent for the page or a music.apple.com page to load.
const _UNSUPPORTED_LINK_TEXT = {
    podcast: ['Podcast subscriptions are not supported', 'Adam is an Apple Music client and cannot subscribe to podcast feeds (itpc:// links).'],
    daap:    ['Shared iTunes libraries are not supported', 'Adam cannot connect to iTunes library shares (daap:// links).'],
};

function _dispatchDeepLink(raw) {
    const link = parseLink(raw);
    if (!link) return;
    console.log('[Adam] deep link:', link);
    if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    }
    if (link.kind === 'intent') {
        win?.webContents.send('adam:open', link.intent);
    } else if (link.kind === 'navigate') {
        if (win && _navigationAllowed(link.url)) win.loadURL(link.url);
    } else if (link.kind === 'unsupported') {
        const [title, detail] = _UNSUPPORTED_LINK_TEXT[link.reason] || ['This link is not supported', `Adam cannot open ${link.scheme}:// links.`];
        dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: 'info', title: 'Adam', message: title, detail });
    }
}

// Register the custom adam:// URI scheme so `xdg-open adam://song/123` opens Adam. The optional Apple
// Music schemes are registered separately, per the user's choices (linkSchemes below).
if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient('adam', process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient('adam');

// Single-instance lock: if a second instance opens (e.g. user clicked a link
// while Adam is already running), forward the URL to the existing instance.
const _gotLock = app.requestSingleInstanceLock();
if (!_gotLock) {
    // This is the second instance — it will exit immediately. The first instance
    // handles the URL via the second-instance event below.
    app.quit();
}
if (_gotLock) {
    // Housekeeping before Chromium opens its caches: remove what earlier versions left behind and keep
    // regenerable data inside its budget. Throttled to once a day; never fatal.
    try {
        const r = runCleanupThrottled(CONFIG_DIR, { log: (m) => console.log('[Adam cleanup]', m) });
        if (r) cleanupCache(path.join(app.getPath('cache'), 'adam'), { log: (m) => console.log('[Adam cleanup]', m) });
        if (r && r.removed) console.log(`[Adam cleanup] freed ${(r.bytes / 1048576).toFixed(1)} MB (${r.removed} items)`);
    } catch (e) { console.warn('[Adam cleanup] skipped:', e.message); }
}
app.on('second-instance', (_e, argv) => {
    if (winIntegration?.handleArgv(argv)) return; // jump-list transport command
    // The clicked link is one of the arguments (xdg-open and the OS pass it on the command line).
    const url = argv.find(isLinkArg);
    if (url) _dispatchDeepLink(url);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

// ── Engine API server ─────────────────────────────────────────────────────────
// The engine binary decrypts Apple Music streams and exposes them as plain
// AAC/H.264 fMP4 over HTTP so the renderer can pipe them into a MediaSource.
//
// Binary resolution order:
//  1. ADAM_ENGINE_BIN environment variable (manual override / CI)
//  2. <resources>/engine  (packaged Electron — app.isPackaged)
//  3. dist/resources/engine  (dev: electron . from electron/ dir)
const _resPkgBin  = path.join(process.resourcesPath, engineFileName());
const _resDevBin  = path.join(__dirname, 'dist', 'resources', engineFileName());
const ENGINE_BIN  = process.env.ADAM_ENGINE_BIN ||
    (app.isPackaged ? _resPkgBin : (existsSync(_resDevBin) ? _resDevBin : _resPkgBin));

// Bundled VLC libs shipped alongside the engine binary so a system VLC
// upgrade/removal can't break audio playback.
const _vlcPkgDir  = path.join(process.resourcesPath, 'vlc');
const _vlcDevDir  = path.join(__dirname, 'dist', 'resources', 'vlc');
const _vlcDir     = app.isPackaged ? _vlcPkgDir : (existsSync(_vlcDevDir) ? _vlcDevDir : _vlcPkgDir);

// Prebuilt minimal FFmpeg (third_party/ffmpeg on Linux, third_party/ffmpeg-win on Windows): its binary does
// the engine's music-video remux and export work (the engine finds "ffmpeg" on PATH), and on Linux its
// libraries are the ones VLC's libavcodec plugin loads. Bundled so no package depends on the host's FFmpeg.
const _ffDir = app.isPackaged ? path.join(process.resourcesPath, 'ffmpeg')
                              : path.join(__dirname, '..', 'third_party', IS_WIN ? 'ffmpeg-win' : 'ffmpeg');

const ENGINE_DATA_DIR = path.join(CONFIG_DIR, 'engine-data');
const ENGINE_PORT = 20025;

// Debug output (verbose renderer logging and a log file) is on whenever the app was started
// from a terminal, where someone can read it, or with ADAM_DEBUG=1. A launcher-started app has
// no terminal and stays quiet. There is no setting for it.
const DEBUG_OUTPUT = process.env.ADAM_DEBUG === '1' || [0, 1, 2].some((fd) => { try { return isatty(fd); } catch { return false; } });

// ── User DRM dir setup ────────────────────────────────────────────────────────
// DRM runs in-process (AdamplayBackend + libdrm_client.so).
// libdrm_client.so has no Android/hybris dependencies — only OpenSSL + libcurl.
// The only writable state it needs is drm/files/ (MUSIC_TOKEN, STOREFRONT_ID,
// mpl_db/) which lives in the user config dir for packaged builds.
function ensureUserDRM() {
    const userDir = path.join(CONFIG_DIR, 'drm');
    mkdirSync(userDir, { recursive: true });

    // Clean up stale artefacts from the old hybris-based DRM path.
    for (const stale of ['drm-rootless', 'drm-native', 'hybris-linker']) {
        try { unlinkSync(path.join(userDir, stale)); } catch {}
    }

    return path.join(userDir, 'files');
}

function ensureEngineConfig() {
    mkdirSync(ENGINE_DATA_DIR, { recursive: true });
    const cfgPath = path.join(ENGINE_DATA_DIR, 'config.yaml');

    let drmBase;
    if (app.isPackaged) {
        // Session tokens (MUSIC_TOKEN, STOREFRONT_ID, mpl_db/) must survive app updates
        // and live in the user config dir (the AppImage/bundle root may be read-only).
        drmBase = ensureUserDRM();
        const legacyBase = path.join(__dirname, '..', 'drm', 'files');
        if (!existsSync(drmBase) && existsSync(legacyBase)) {
            try { cpSync(legacyBase, drmBase, { recursive: true }); }
            catch (e) { console.error('[Adam] could not migrate the DRM session:', e.message); }
        }
        mkdirSync(drmBase, { recursive: true });
    } else {
        // Dev: use the repo's own drm/files/ directly.
        drmBase = path.join(__dirname, '..', 'drm', 'files');
    }

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
            `drm-base-dir: ${yamlStr(drmBase)}`,
        ].join('\n') + '\n';
        writeFileSync(cfgPath, stub);
        return;
    }

    // Patch existing config: add missing drm-base-dir or update a stale one.
    // Remove stale drm-binary-path lines left by older builds (no longer used).
    let content = readFile(cfgPath, 'utf8');
    content = content.replace(/^drm-binary-path:.*\n?/m, '');
    let changed = content !== readFile(cfgPath, 'utf8');
    for (const [key, val] of [['drm-base-dir', drmBase]]) {
        const line = `${key}: ${yamlStr(val)}`;
        if (!content.includes(`${key}:`)) {
            content += `${line}\n`;
            changed = true;
        } else if (!content.includes(line)) {
            content = content.replace(new RegExp(`${key}:.*`), () => line);
            changed = true;
        }
    }
    if (changed) writeFileSync(cfgPath, content);
}

// The engine's Apple session directory (session files, device trust, session lock).
function drmFilesDirPath() {
    return app.isPackaged
        ? path.join(CONFIG_DIR, 'drm', 'files')
        : path.join(__dirname, '..', 'drm', 'files');
}

const engineLifecycle = createEngineLifecycle({
    isQuitting: () => isQuitting,
    prepare: async () => {
        if (!existsSync(ENGINE_BIN)) {
            throw new Error(`Engine binary not found at ${ENGINE_BIN}`);
        }
        const drmFilesDir = drmFilesDirPath();
        // Only an orphan of this exact engine (binary, data directory, port) is recovered, and
        // the session lock file is never deleted: a replacement inode would let two engines
        // own the session at once.
        await recoverOrphanEngine({
            lockPath: path.join(drmFilesDir, 'engine-session.lock'),
            binary: ENGINE_BIN, dataDir: ENGINE_DATA_DIR, port: ENGINE_PORT,
        });
        let portFree = false;
        for (let i = 0; i < 20 && !isQuitting; i++) {
            if (await isPortFree(ENGINE_PORT)) { portFree = true; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (isQuitting) return;
        if (!portFree) {
            throw new Error(`Engine port ${ENGINE_PORT} is already in use. Close the other player or service and restart Adam.`);
        }
        ensureEngineConfig();
    },
    spawn: () => {
        const libEnv = engineLibEnv({
            vlcDir: _vlcDir, ffDir: _ffDir, resDir: path.dirname(ENGINE_BIN),
            hasVlc: existsSync(_vlcDir),
            hasFfmpeg: existsSync(path.join(_ffDir, 'bin', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')),
        });
        // Windows env names are case-insensitive: spreading process.env keeps "Path", so drop it
        // before adding our PATH or the child would see two competing entries.
        const baseEnv = { ...process.env };
        if (IS_WIN && libEnv.PATH) delete baseEnv.Path;
        return spawn(ENGINE_BIN, ['--api', String(ENGINE_PORT)], {
            cwd: ENGINE_DATA_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            // Force Go's pure-Go DNS resolver to avoid CGO getaddrinfo SIGSEGV
            // when the engine makes HTTP requests to Apple's API servers.
            env: { ...baseEnv, GODEBUG: 'netdns=go', ...libEnv },
        });
    },
    killDelay: 3000, // allow normal VLC teardown before forced termination
    onOutput: data => console.log('[engine]', data.toString().trimEnd()),
    onStderr: data => console.error('[engine]', data.toString().trimEnd()),
    onError: error => {
        console.error('[Adam] Engine startup failed:', error.message);
        // A missing binary is not fatal: the renderer falls back to the Apple CDN without the engine.
        if (!isQuitting && existsSync(ENGINE_BIN)) dialog.showErrorBox('Playback engine could not start', error.message);
    },
});

function startEngine() { return engineLifecycle.start(); }
function stopEngine() { return engineLifecycle.stop(); }

// Apple's FairPlay libraries cannot ship with Adam. The .run installer fetches them; this
// covers the AppImage and system-wide installs (pinned + checksummed, fairplay-libs.lock).
// The engine only loads them at startup, so it is reloaded once they arrive — right away
// when nothing is playing, otherwise at the next pause so playback is never cut.
const FAIRPLAY_LIB64 = path.join(CONFIG_DIR, 'drm', 'rootfs', 'system', 'lib64');
let _reloadEngineOnPause = false;
function ensureFairPlayLibs() {
    if (!IS_LINUX || !app.isPackaged) return;
    if (existsSync(path.join(FAIRPLAY_LIB64, 'libandroidappmusic.so'))) return;
    const script = path.join(process.resourcesPath, 'fetch-fairplay-libs.sh');
    if (!existsSync(script)) return;
    console.log('[Adam] Downloading the FairPlay libraries for lossless playback...');
    const proc = spawn('sh', [script, '--dest', FAIRPLAY_LIB64, '--quiet'], { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', d => console.error('[Adam] fairplay:', String(d).trim()));
    proc.on('error', e => console.error('[Adam] FairPlay download could not start:', e.message));
    proc.on('close', code => {
        if (code !== 0) return console.error('[Adam] FairPlay libraries unavailable; lossless stays off');
        console.log('[Adam] FairPlay libraries ready; enabling lossless');
        if (_lastMprisStatus === 'Playing') _reloadEngineOnPause = true;
        else engineLifecycle.reload();
    });
}

// ── Compositor / blur detection ───────────────────────────────────────────────
const _isWayland = !!process.env.WAYLAND_DISPLAY;
const _desktop   = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
const _isKde      = ['kde', 'plasma'].some(d => _desktop.includes(d));
const _isHyprland = _desktop.includes('hyprland') || !!process.env.HYPRLAND_INSTANCE_SIGNATURE;
console.log(`[Adam] Compositor: desktop=${_desktop || '(unset)'} wayland=${_isWayland} kde=${_isKde} hyprland=${_isHyprland}`);
// KDE X11 gets native compositor blur via _KDE_NET_WM_BLUR_BEHIND_REGION atom.
// KDE Wayland: forcing ozone-platform=x11 crashes the GPU process (Mesa Wayland
// drivers don't support GLX over XWayland). Use CSS dark-tint fallback instead.

// ── Software compositing blur fallback ───────────────────────────────────────
// Used on X11 or Wayland compositors that don't support blur-behind (GNOME/Sway).
// Captures a desktop screenshot, sends it to the renderer as a blurred CSS background.
// KDE is excluded: we use the native _KDE_NET_WM_BLUR_BEHIND_REGION atom instead.
let _useSoftBlur = IS_LINUX && !_isKde && (!_isWayland ||
    ['gnome', 'sway', 'unity', 'cosmic', 'budgie'].some(d => _desktop.includes(d)));

// GPU crash → activate software blur regardless of compositor so the window
// doesn't show a black void.
app.on('gpu-process-crashed', (_event, killed) => {
    if (killed || !IS_LINUX) return;
    console.warn('[Adam] GPU process crashed — activating software blur fallback');
    _useSoftBlur = true;
    refreshBlurBg();
});

// ── KDE Wayland: wallpaper-based software blur ───────────────────────────────
// Reads the current wallpaper path from ~/.config/plasma-org.kde.plasma.desktop-appletsrc
// and injects it as --adam-fallback-bg so the CSS blur ::before renders it blurred.
// No desktopCapturer / xdg-portal dialog needed.
function _kdeWallpaperPath() {
    const cfgPath = path.join(os.homedir(), '.config', 'plasma-org.kde.plasma.desktop-appletsrc');
    try {
        const lines = readFileSync(cfgPath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^Image\s*=\s*(.+)/);
            if (m) return m[1].trim().replace(/^file:\/\//, '');
        }
    } catch (_) {}
    return null;
}

// Inject two fixed divs into body: a blurred wallpaper layer + dark tint.
// position:fixed + prepend means they're behind all app content in DOM order.
// Works on transparent Electron windows — the divs have visible pixels so they paint.
function _injectBlurLayer(bwin, dataUrl) {
    // Position tracking runs inside the renderer via requestAnimationFrame —
    // window.screenX/screenY are standard browser APIs Chromium exposes, updated
    // every frame. This avoids IPC overhead and works on both X11 and Wayland.
    // Math: #_adamBlurBg has inset:-80px, so its origin is (winX-80, winY-80) on
    // screen. background-position = (80-winX, 80-y) + 'px ' + (80 - y) + 'px' keeps wallpaper aligned.
    // The URL has to be spliced into the page script as a literal: the page has no access to this
    // function's variables, and a bare reference threw a ReferenceError that was swallowed, which left
    // an empty layer (and no blur) on every desktop.
    bwin.webContents.executeJavaScript(`(function(){
        const safe = ${JSON.stringify(String(dataUrl))};
        let bg = document.getElementById('_adamBlurBg');
        if (!bg) {
            bg = document.createElement('div');
            bg.id = '_adamBlurBg';
            const tint = document.createElement('div');
            tint.id = '_adamBlurTint';
            // Set styles for the blur layer and the tint
            // 80px of overscan on every side (the position math below assumes it). Do not set width or
            // height here: they override inset's right/bottom and leave an 80px strip uncovered.
            bg.style.position = 'fixed';
            bg.style.inset = '-80px';
            bg.style.zIndex = '-1';
            tint.style.position = 'fixed';
            tint.style.top = '0';
            tint.style.left = '0';
            tint.style.width = '100%';
            tint.style.height = '100%';
            tint.style.background = 'rgba(0,0,0,0.4)';
            tint.style.zIndex = '-1';
            document.body.prepend(tint);
            document.body.prepend(bg);

            let _px = null, _py = null, _lastWPCheck = 0;
            (function tick(ts) {
                // Throttle window-position reads to ~10fps — pure position reads
                // don't need compositor-frame precision and this saves main-thread
                // budget on throttled/battery CPUs.
                if (ts - _lastWPCheck > 100) {
                    _lastWPCheck = ts;
                    const x = window.screenX, y = window.screenY;
                    if (x !== _px || y !== _py) {
                        _px = x; _py = y;
                        bg.style.backgroundSize     = window.screen.width  + 'px ' + window.screen.height + 'px';
                        bg.style.backgroundPosition = (80 - x) + 'px ' + (80 - y) + 'px';
                    }
                }
                requestAnimationFrame(tick);
            })(0);
        }
        bg.style.backgroundImage = 'url("' + safe + '")';
    })()`).catch(() => {});}

function _applyKdeWallpaperBlur(bwin) {
    const wp = _kdeWallpaperPath();
    if (!wp) { console.warn('[Adam] KDE wallpaper blur: no Image= found in plasma config'); return; }
    _injectWallpaperFile(bwin, wp, 'KDE');
}

// The wallpaper currently drawn behind the interface in blur mode.
let _blurWallpaper = '';

// A small copy of the wallpaper as a data: URL. The blur is done here, once: a wallpaper reduced to
// a few dozen pixels and scaled back up is already soft, and it costs nothing per frame, whereas a
// full-window CSS blur() filter made the page crawl on machines without a GPU. The Background blur
// slider sets how far the image is reduced.
function _blurDataUrl(img, refWidth) {
    if (!img || img.isEmpty()) return null;
    const blurPx = Math.max(1, parseFloat(loadPrefs().bgBlur) || 18);
    const width = Math.max(48, Math.min(960, Math.round(refWidth / (blurPx * 1.2))));
    return 'data:image/jpeg;base64,' + img.resize({ width, quality: 'good' }).toJPEG(80).toString('base64');
}

function _blurredWallpaperUrl(wp) {
    return _blurDataUrl(nativeImage.createFromBuffer(readFileSync(wp)), screen.getPrimaryDisplay().size.width || 1920);
}

// Draw a wallpaper file (blurred as above) behind the interface. Used wherever the compositor cannot
// blur what is behind the window: GNOME, Hyprland and KDE Wayland.
function _injectWallpaperFile(bwin, wp, label) {
    try {
        if (!wp || !existsSync(wp)) { console.warn(`[Adam] ${label} wallpaper blur: no wallpaper file`); return false; }
        if (statSync(wp).size > 60 * 1024 * 1024) { console.warn(`[Adam] ${label} wallpaper blur: ${wp} is too large`); return false; }
        const url = _blurredWallpaperUrl(wp);
        if (!url) { console.warn(`[Adam] ${label} wallpaper blur: could not decode ${wp}`); return false; }
        _blurWallpaper = wp;
        _injectBlurLayer(bwin, url);
        console.log(`[Adam] ${label} wallpaper blur applied:`, wp);
        return true;
    } catch (e) { console.warn(`[Adam] ${label} wallpaper blur failed:`, e.message); return false; }
}

// Re-render the blur layer after the Background blur slider moves.
function _refreshWallpaperBlur() {
    if (win && _blurWallpaper) _injectWallpaperFile(win, _blurWallpaper, 'Refreshed');
}

async function _applyPlatformWallpaperBlur(bwin) {
    return _injectWallpaperFile(bwin, await gnomeWallpaperPath(), 'GNOME');
}

function _hyprlandWallpaperPath() {
    try {
        const conf = path.join(os.homedir(), '.config', 'hypr', 'hyprpaper.conf');
        for (const line of readFileSync(conf, 'utf8').split('\n')) {
            const m = line.match(/^wallpaper\s*=\s*[^,]*,\s*(.+)/);
            if (m) return m[1].trim();
        }
    } catch {}
    try {
        const cacheDir = path.join(os.homedir(), '.cache', 'swww');
        if (existsSync(cacheDir)) {
            for (const f of readdirSync(cacheDir)) {
                const fp = path.join(cacheDir, f);
                if (statSync(fp).isFile()) {
                    const content = readFileSync(fp, 'utf8').trim().split('\0')[0];
                    if (content && existsSync(content)) return content;
                }
            }
        }
    } catch {}
    return null;
}

function _applyHyprlandWallpaperBlur(bwin) {
    const wp = _hyprlandWallpaperPath();
    if (!wp) { console.warn('[Adam] Hyprland wallpaper blur: no wallpaper found'); return; }
    _injectWallpaperFile(bwin, wp, 'Hyprland');
}

function _withAlpha(color, alpha) {
    if (!color || typeof color !== 'string') return '';
    const m = color.match(/^hsla?\((.+)\)$/);
    if (m) {
        const parts = m[1].split(',').map(s => s.trim());
        if (parts.length < 3) return color;
        return `hsla(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(color)) {
        const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    return color;
}

function _applyThemeVars(palette) {
    if (!win || !palette) return;
    const p = sanitizePalette(palette) ?? defaultPalette(); // a poisoned saved palette must not break startup
    const isLight = p.appearance === 'light';
    nativeTheme.themeSource = isLight ? 'light' : 'dark';
    const bg = JSON.stringify(p.bgColor || (isLight ? 'hsl(0,0%,96%)' : 'hsl(0,0%,10%)'));
    const navText = JSON.stringify(isLight ? 'rgba(0,0,0,0.85)' : '');
    const navTextSec = JSON.stringify(isLight ? 'rgba(0,0,0,0.5)' : '');
    const prefs = loadPrefs();
    const navAlpha = prefs.themeNavBgAlpha ?? 0.72;
    const navBg = JSON.stringify(_withAlpha(p.navBg || '', navAlpha) || p.navBg || '');
    win.webContents.executeJavaScript(`(function(){
        const r = document.documentElement;
        // Setting a custom property to "" does NOT remove it — the property still
        // exists with an empty value, so var(--x, fallback) skips the fallback and
        // yields an invalid declaration at computed-value time (the whole property
        // becomes unset). Remove the property instead so fallbacks actually apply.
        const setVar = (name, val) => {
            if (val === null || val === undefined || String(val).trim() === '') r.style.removeProperty(name);
            else r.style.setProperty(name, val);
        };
        setVar('--adam-nav-bg', ${navBg});
        setVar('--adam-nav-border', ${JSON.stringify(p.navBorder || '')});
        setVar('--adam-accent', ${JSON.stringify(p.accent || '')});
        setVar('--adam-accent-active', ${JSON.stringify(p.accentActive || '')});
        setVar('--adam-nav-text', ${navText});
        setVar('--adam-nav-text-sec', ${navTextSec});
        setVar('--adam-bg-color', ${bg});
        let bd = document.getElementById('_adamAccentBg');
        if (!bd) {
            bd = document.createElement('div');
            bd.id = '_adamAccentBg';
            bd.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;transition:background 0.6s ease;';
            document.body.prepend(bd);
        }
        bd.style.background = ${bg};
    })()`).catch(() => {});
}

function _clearThemeVars() {
    if (!win) return;
    nativeTheme.themeSource = _acrylicBackend ? _acrylicSettings().theme : 'system';
    win.webContents.executeJavaScript(`(function(){
        const r = document.documentElement;
        ['--adam-nav-bg','--adam-nav-border','--adam-accent','--adam-accent-active','--adam-nav-text','--adam-nav-text-sec','--adam-bg-color']
            .forEach(v => r.style.removeProperty(v));
        document.getElementById('_adamAccentBg')?.remove();
        document.getElementById('_adamCustomBg')?.remove();
    })()`).catch(() => {});
}

function _injectCustomFallbackBg() {
    if (!win) return;
    win.webContents.executeJavaScript(`(function(){
        if (document.getElementById('_adamCustomBg')) return;
        const d = document.createElement('div');
        d.id = '_adamCustomBg';
        d.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;background:#1c1c1e;';
        document.body.prepend(d);
    })()`).catch(() => {});
}

let _customCssKey = null;
async function _injectCustomCss(filePath) {
    if (!win || !filePath || !existsSync(filePath)) return;
    if (_customCssKey) { await win.webContents.removeInsertedCSS(_customCssKey).catch(() => {}); _customCssKey = null; }
    try {
        const css = readFileSync(filePath, 'utf8');
        _customCssKey = await win.webContents.insertCSS(css);
    } catch (e) { console.warn('[Adam] Custom CSS inject failed:', e.message); }
}
async function _clearCustomCss() {
    if (!_customCssKey || !win) return;
    await win.webContents.removeInsertedCSS(_customCssKey).catch(() => {});
    _customCssKey = null;
}

// ── KDE compositor blur-behind (X11 atom) ────────────────────────────────────
// Sets _KDE_NET_WM_BLUR_BEHIND_REGION with an empty region = blur entire window.
// KWin reads this atom when the window is mapped, so we MUST set it before
// win.show() — called from ready-to-show for that reason.
// Retries up to 10×300ms in case the native handle isn't assigned yet;
// falls back to software blur if the atom can never be set.
function applyKdeBlurBehind(bwin) {
    if (!_isKde || _isWayland) return;
    const _trySet = (attempt) => {
        const xid = bwin.getNativeWindowHandle().readUInt32LE(0);
        if (xid <= 1) {
            if (attempt < 10) { setTimeout(() => _trySet(attempt + 1), 300); return; }
            console.warn('[Adam] KDE blur: no valid XID after 10 attempts — falling back to software blur');
            _useSoftBlur = true;
            refreshBlurBg();
            return;
        }
        try {
            const _x11 = require('x11');
            _x11.createClient((err, display) => {
                if (err) {
                    console.warn('[Adam] KDE blur: X11 connect failed:', err.message, '— using software blur');
                    _useSoftBlur = true; refreshBlurBg();
                    return;
                }
                const X = display.client;
                X.on('error', (e) => console.warn('[Adam] KDE blur X11 error:', e.message ?? e));
                X.InternAtom(false, '_KDE_NET_WM_BLUR_BEHIND_REGION', (atomErr, atom) => {
                    if (atomErr) { console.warn('[Adam] KDE blur: InternAtom failed:', atomErr); return; }
                    // Empty data = blur entire window shape.
                    X.ChangeProperty(0 /* PropModeReplace */, xid, atom, 6 /* XA_CARDINAL */, 32, []);
                    console.log('[Adam] KDE blur-behind atom set (xid=0x%s)', xid.toString(16));
                });
            });
        } catch (e) {
            console.warn('[Adam] KDE blur-behind failed:', e.message);
        }
    };
    _trySet(0);
}

let _bgTimer = null;
async function refreshBlurBg() {
    if (!win || !_useSoftBlur) return;
    // Skip desktopCapturer on Wayland — triggers the screen-share portal dialog.
    if (_isWayland) return;
    const { width, height } = win.getBounds();
    const sources = await desktopCapturer.getSources({
        types: ['screen'], thumbnailSize: { width, height }
    }).catch(() => []);
    if (!sources.length) {
        // Screen capture unavailable (GPU disabled/power-saver) — inject a solid
        // dark background so the transparent window isn't an invisible black void.
        win.webContents.executeJavaScript(`(function(){
            if (document.getElementById('_adamBlurBg')) return;
            const bg = document.createElement('div');
            bg.id = '_adamBlurBg';
            bg.style.cssText = 'position:fixed;inset:0;background:rgba(10,10,12,0.97);z-index:0;pointer-events:none';
            document.body.prepend(bg);
        })()`).catch(() => {});
        return;
    }
    const shot = sources[0].thumbnail;
    const url = _blurDataUrl(shot, shot.getSize().width);
    if (url) _injectBlurLayer(win, url);
}

// Debug logs kept in CONFIG_DIR/logs; older ones are pruned.
const DEBUG_LOGS_KEPT = 10;

function pruneDebugLogs(logsDir) {
    try {
        const old = readdirSync(logsDir).filter(f => /^debug-.*\.log$/.test(f)).sort().reverse().slice(DEBUG_LOGS_KEPT);
        for (const f of old) { try { unlinkSync(path.join(logsDir, f)); } catch {} }
    } catch {}
}

// The page logs a lot (playback positions, MusicKit state). All of it goes to the debug log file;
// the terminal only shows its warnings and errors unless ADAM_DEBUG=1.
const PAGE_LEVELS = ['verbose', 'info', 'warning', 'error'];
function pageLogLevel(event) {
    const l = event.level;
    return typeof l === 'number' ? PAGE_LEVELS[l] ?? 'info' : l || 'info';
}

function setupDebugLogging(win) {
    if (!DEBUG_OUTPUT && !process.env.ADAM_DEVTOOLS) return;
    const logsDir = path.join(CONFIG_DIR, 'logs');
    mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logStream = createWriteStream(path.join(logsDir, `debug-${stamp}.log`));
    pruneDebugLogs(logsDir);
    const _write = (tag, args) => logStream.write(`[${new Date().toISOString()}] ${tag} ${args.join(' ')}\n`);
    const origLog = console.log, origError = console.error, origWarn = console.warn;
    console.log   = (...a) => { origLog(...a);   _write('LOG  ', a); };
    console.error = (...a) => { origError(...a); _write('ERROR', a); };
    console.warn  = (...a) => { origWarn(...a);  _write('WARN ', a); };
    // A DevTools window is only opened on request (ADAM_DEVTOOLS); debug output alone must not
    // pop up a window every time the app is started from a terminal.
    if (process.env.ADAM_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
    const verbosePage = process.env.ADAM_DEBUG === '1';
    win.webContents.on('console-message', (event) => {
        const msg = event.message ?? event;
        if (typeof msg !== 'string') return;
        const level = pageLogLevel(event);
        _write(level === 'error' ? 'ERROR' : level === 'warning' ? 'WARN ' : 'PAGE ', ['[renderer]', msg]);
        if (verbosePage) origLog('[renderer]', msg);
        else if (level === 'error') origError('[renderer]', msg);
        else if (level === 'warning') origWarn('[renderer]', msg);
    });
}

ipcMain.on('app:restart', () => { app.relaunch(); app.quit(); });

function createWindow() {
    win = new BrowserWindow({
        width: 1200,
        height: 800,
        // Fully transparent so the compositor (Hyprland/KWin) can render
        // the desktop behind the window with its own blur effect, giving
        // us the visionOS "glass over room" look for free.
        backgroundColor: '#00000000',
        // The compositor backdrop shows through a transparent page, so the window itself must NOT be transparent:
        // Electron strips WS_THICKFRAME and WS_CAPTION from a transparent window, and without them Windows will
        // not snap it by dragging to an edge or animate maximize and restore. Elsewhere the glass is CSS and the
        // window stays transparent.
        transparent: !_acrylicBackend,
        ...(_acrylicBackend ? { frame: false, hasShadow: true, maximizable: true } : {}),
        show: false,
        ..._devWindowIcon,
        title: 'Adam',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: _hasSandbox,
            partition: 'persist:apple-music',
            devTools: !app.isPackaged,
            additionalArguments: DEBUG_OUTPUT ? ['--adam-debug=1'] : [],
        },
    });

    if (_acrylicBackend && IS_WIN) setNativeCaptionDrag(win);
    if (_acrylicBackend) _applyAcrylic();

    win.on('page-title-updated', (e) => e.preventDefault());
    let initialLoadRetried = false;
    const loadAppleMusic = () => win.loadURL('https://music.apple.com').catch(async (e) => {
        if (!initialLoadRetried && e?.message?.includes('ERR_FAILED')) {
            initialLoadRetried = true;
            console.warn('[Adam] Apple Music load hit a Chromium cache failure; clearing the session cache and retrying');
            try {
                await win.webContents.session.clearCache();
                await win.loadURL('https://music.apple.com');
                return;
            } catch (retryError) {
                console.error('[Adam] Apple Music retry failed:', retryError.message);
                return;
            }
        }
        console.error('[Adam] Apple Music load failed:', e.message);
    });
    loadAppleMusic();

    // KDE X11: set the blur atom before the window is mapped.
    // ready-to-show fires after Chromium's first paint but before win.show(),
    // so KWin sees the atom the instant it processes our map request.
    if (_isKde && !_isWayland) {
        // Warn if KWin blur desktop effect appears disabled.
        execFile('kreadconfig5', ['--group', 'Plugins', '--key', 'blurEnabled', '--file', 'kwinrc'], {},
            (_, stdout) => {
                if (stdout.trim() === 'false')
                    console.warn('[Adam] KDE blur: kwinrc shows blurEnabled=false — enable KWin Blur desktop effect in System Settings → Desktop Effects');
                else
                    console.log('[Adam] KDE blur: kwinrc blurEnabled =', stdout.trim() || '(default=true)');
            });
        win.once('ready-to-show', () => applyKdeBlurBehind(win));
    }

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
        if (_startHidden) return; // launched at login: stay in the tray until asked
        win.setOpacity(0);
        win.show();
        // Ramp opacity 0→1 over ~300 ms so it fades in smoothly.
        let op = 0;
        const step = setInterval(() => {
            op = Math.min(1, op + 0.08);
            win.setOpacity(op);
            if (op >= 1) clearInterval(step);
        }, 16);
        // Blur layer (needs executeJavaScript, so it runs after the page is loaded; showWindow fires
        // on app:ui-ready). Hyprland reads its own wallpaper config; Windows and GNOME use the
        // wallpaper file; anything else falls back to a software screenshot blur (X11 / Sway).
        if (_isHyprland) _applyHyprlandWallpaperBlur(win);
        else if (_acrylicBackend) { /* the acrylic window is the blur; the page overlays are applied on load */ }
        else if (_desktop.includes('gnome')) {
            _applyPlatformWallpaperBlur(win).then(ok => { if (!ok && _useSoftBlur) refreshBlurBg(); });
        } else if (_useSoftBlur) refreshBlurBg();
    };
    win.on('move', () => {
        // Position tracking is handled by requestAnimationFrame in the renderer.
        // Only refresh the screenshot-based bg (X11 non-KDE) after drag settles.
        clearTimeout(_bgTimer);
        _bgTimer = setTimeout(refreshBlurBg, 500);
    });
    const showFallback = setTimeout(showWindow, 7000);

    // True while the offline page replaces Apple Music. Chromium's error page still reports the failed
    // Apple URL, so the URL alone cannot tell the injection code to stand down.
    let offlineShown = false;

    // Offline, DNS failure, proxy down: show a page that explains it and retries by itself, instead of
    // the blank window the failed load leaves behind. The page's own load never reports back here.
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!shouldShowOffline({ errorCode, isMainFrame, validatedURL })) return;
        console.warn(`[Adam] Apple Music failed to load: ${errorDescription} (${errorCode})`);
        offlineShown = true;
        win.loadFile(path.join(__dirname, 'offline.html'), { hash: offlineHash(errorCode, errorDescription) })
            .catch(e => console.error('[Adam] offline page failed:', e.message));
        clearTimeout(showFallback);
        showWindow();
    });

    ipcMain.once('app:ui-ready', () => {
        clearTimeout(showFallback);
        showWindow();
    });
    // Debug logging: on when started from a terminal or with ADAM_DEBUG=1; DevTools only with
    // ADAM_DEVTOOLS (see DEBUG_OUTPUT).
    setupDebugLogging(win);

    // Prefer bundles from resourcesPath (outside ASAR) so they can be updated
    // without repacking. Falls back to __dirname (inside ASAR) if not present.
    const _resBundle = (name) => {
        const outside = path.join(process.resourcesPath, name);
        const inside  = path.join(__dirname, name);
        return existsSync(outside) ? outside : inside;
    };
    const visionPath  = _resBundle('vision-bundle.js');
    const visionCode  = existsSync(visionPath) ? readFileSync(visionPath, 'utf8') : '';
    // engine-sse-bundle must load first — it creates window._adamEngine which
    // smart-cache and engine-playback subscribe to in their own constructors.
    const ssePath     = _resBundle('engine-sse-bundle.js');
    const sseCode     = existsSync(ssePath)    ? readFileSync(ssePath,    'utf8') : '';
    const cachePath   = _resBundle('smart-cache-bundle.js');
    const cacheCode   = existsSync(cachePath)  ? readFileSync(cachePath,  'utf8') : '';
    const enginePath  = _resBundle('engine-bundle.js');
    const engineCode  = existsSync(enginePath) ? readFileSync(enginePath, 'utf8') : '';

    // ── Early CSS via insertCSS — fires before first paint, no preload risk ──
    // webContents.insertCSS() is Electron's dedicated API for injecting CSS
    // before the page renders, unlike executeJavaScript which needs dom-ready.
    const { glassBlur = 20, glassOpacity = 0.07, bgBlur = 18 } = loadPrefs();
    const earlyCss = `
        :root { --adam-glass-blur: ${glassBlur}px; --adam-glass-opacity: ${glassOpacity}; --adam-art-tint: rgba(255,255,255,0); --adam-fallback-bg: none; --adam-bg-blur: ${bgBlur}px; }
        html, body { background: transparent !important; overscroll-behavior: none !important; }
        /* Strip grey tint from alternating content sections — let album art / wallpaper show through */
        .section--alternate, [class*="section--alternate"] { background: transparent !important; }
        /* "Also available in the iTunes Store" CTA — hidden everywhere. Matched by
           aria-label (Apple keeps "iTunes" in it across locales) since its classes
           are generic Svelte hashes; the :has() rules drop the wrapper too so no
           empty gap is left behind. */
        button[aria-label*="iTunes"],
        [data-testid="button-base-wrapper"]:has(> button[aria-label*="iTunes"]),
        [class*="native-cta-wrapper"]:has(button[aria-label*="iTunes"]) { display: none !important; }
        nav.navigation {
            background: rgba(255,255,255,var(--adam-glass-opacity)) !important;
            backdrop-filter: blur(var(--adam-glass-blur)) !important;
            -webkit-backdrop-filter: blur(var(--adam-glass-blur)) !important;
            border-right: 1px solid rgba(255,255,255,0.12) !important;
        }
        /* Software blur layer: two real DOM divs injected by _injectBlurLayer().
           #_adamBlurBg  — the (already blurred, see _blurredWallpaperUrl) wallpaper image,
                          prepended to body so it renders behind all app content.
           #_adamBlurTint — dark overlay on top of the blur.
           position:fixed + inset:-80px overflows the viewport to hide blur edge fringing. */
        #_adamBlurBg {
            position: fixed !important;
            inset: -80px !important;
            pointer-events: none !important;
            background-repeat: no-repeat !important;
            z-index: -1 !important;
        }
        #_adamBlurTint {
            position: fixed !important;
            inset: 0 !important;
            pointer-events: none !important;
            background: rgba(10, 10, 12, 0.25) !important;
            z-index: -1 !important;
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
            background: rgba(14, 14, 16, 0.98) !important;
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
            background: #fc3c44 !important;
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

        /* Submenu container: keep overflow visible so border-radius/shadow stay intact.
           JS sets max-height on the inner list, not this element. */
        div.contextual-menu.contextual-menu--nested,
        div.contextual-menu.contextual-menu--in-submenu {
            overflow: visible !important;
        }

        /* Submenu list: this is what actually scrolls. JS sets max-height at runtime. */
        div.contextual-menu.contextual-menu--nested ul.contextual-menu__list,
        div.contextual-menu.contextual-menu--in-submenu ul.contextual-menu__list {
            overflow-y: auto !important;
            overflow-x: hidden !important;
            scrollbar-width: thin;
            scrollbar-color: rgba(255,255,255,0.28) transparent;
        }
        div.contextual-menu.contextual-menu--nested ul.contextual-menu__list::-webkit-scrollbar,
        div.contextual-menu.contextual-menu--in-submenu ul.contextual-menu__list::-webkit-scrollbar {
            width: 5px;
        }
        div.contextual-menu.contextual-menu--nested ul.contextual-menu__list::-webkit-scrollbar-track,
        div.contextual-menu.contextual-menu--in-submenu ul.contextual-menu__list::-webkit-scrollbar-track {
            background: transparent;
        }
        div.contextual-menu.contextual-menu--nested ul.contextual-menu__list::-webkit-scrollbar-thumb,
        div.contextual-menu.contextual-menu--in-submenu ul.contextual-menu__list::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.28);
            border-radius: 3px;
        }
        div.contextual-menu.contextual-menu--nested ul.contextual-menu__list::-webkit-scrollbar-thumb:hover,
        div.contextual-menu.contextual-menu--in-submenu ul.contextual-menu__list::-webkit-scrollbar-thumb:hover {
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
            background: rgba(14, 14, 16, 0.98) !important;
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
        if (offlineShown || _httpsHost(win.webContents.getURL()) !== 'music.apple.com' || bundleInjected) return;
        bundleInjected = true;
        console.log('[Adam] Injecting bundles into world 0');

        // SSE must run first (creates window._adamEngine); cache+engine subscribe to it.
        // Vision is independent. Combine into one executeJavaScript call to avoid
        // 4 separate round-trips adding ~2-3s of sequential injection delay.
        const combined = [
            `window._adamEngineURL='https://127.0.0.1:${ENGINE_PORT}';`,
            sseCode    ? `try{${sseCode}}catch(e){console.error('[Adam sse]',e.message)}`    : '',
            visionCode ? `try{${visionCode}}catch(e){console.error('[Adam vision]',e.message)}` : '',
            cacheCode  ? `try{${cacheCode}}catch(e){console.error('[Adam cache]',e.name,e.message,e.stack)}`  : '',
            engineCode ? `try{${engineCode}}catch(e){console.error('[Adam engine]',e.name,e.message,e.stack)}` : '',
        ].filter(Boolean).join(';');

        await win.webContents.executeJavaScript(combined)
            .catch(e => console.error('[Adam] bundle injection error:', e));

        applyPersistedViewSettings();
    }

    win.webContents.on('did-frame-finish-load', injectBundles);

    // The offline page is ours, not Apple's: leave offline mode when the user (or its own retry) heads
    // back to Apple Music, and keep the glass styling above from making that page transparent.
    win.webContents.on('did-start-navigation', (details) => {
        if (details?.isMainFrame && !details.isSameDocument && _httpsHost(details.url) === 'music.apple.com') offlineShown = false;
    });
    win.webContents.on('did-finish-load', () => {
        if (offlineShown && win.webContents.getURL().startsWith('file:')) {
            win.webContents.insertCSS('html, body { background: #000 !important; }').catch(() => {});
        }
    });

    win.webContents.on('did-navigate', () => {
        if (_httpsHost(win.webContents.getURL()) === 'music.apple.com') bundleInjected = false;
    });

    // A link or script must not take the privileged window to a site that isn't Apple's:
    // it keeps its session and (on the Apple origin) the bridge. Apple hosts, including the
    // sign-in and authorisation subdomains, navigate freely; anything else opens in the browser.
    win.webContents.on('will-navigate', (event, url) => {
        if (_navigationAllowed(url)) return;
        event.preventDefault();
        if (_httpsHost(url)) shell.openExternal(url);
    });

    // Apple's sign-in and authorize pages open as real popups: MusicKit talks back to the page that
    // opened them through window.opener, which navigating the player itself would lose. Ordinary
    // music.apple.com links still load in this window.
    configureAuthPopups(win.webContents, _navigationAllowed, (url) => _httpsHost(url) === 'music.apple.com');

    win.webContents.on('did-navigate', () => {
        // Only show if the initial ready-signal already fired; don't interrupt the
        // first-load sequence where the window stays hidden until content is loaded.
        if (shown && !win.isVisible()) win.show();
    });

    // Hide on close instead of destroying — keeps the page alive in memory so
    win.on('close', (e) => {
        if (!isQuitting) {
            e.preventDefault();
            win.hide();
        } else removeCompositionBackdrop(win);
    });

    win.on('closed', () => { win = null; });
}

// Popups opened for authentication keep their opener and session. No adamBridge is exposed to
// them (see auth-preload.cjs). A blank popup is allowed because sites open first and navigate
// second; every later navigation of a popup is gated by `allowed`. `inWindow` URLs are loaded in
// the opener's own window instead of a popup.
function configureAuthPopups(contents, allowed, inWindow = () => false) {
    contents.setWindowOpenHandler(({ url }) => {
        if (inWindow(url)) {
            contents.loadURL(url).catch(() => {});
            return { action: 'deny' };
        }
        if (url === 'about:blank' || allowed(url)) {
            return { action: 'allow', overrideBrowserWindowOptions: {
                width: 520, height: 760, show: true, autoHideMenuBar: true,
                backgroundColor: '#1c1c1e',
                webPreferences: { preload: path.join(__dirname, 'auth-preload.cjs'), contextIsolation: true,
                    nodeIntegration: false, sandbox: _hasSandbox },
            } };
        }
        // Only open safe https:// URLs externally; drop file://, app://, etc.
        if (_httpsHost(url)) shell.openExternal(url).catch(() => {});
        return { action: 'deny' };
    });
    contents.on('did-create-window', (child) => {
        const gate = (event, url) => {
            if (url === 'about:blank' || allowed(url)) return;
            event.preventDefault();
            if (_httpsHost(url)) shell.openExternal(url).catch(() => {});
        };
        child.webContents.on('will-navigate', gate);
        child.webContents.on('will-redirect', gate);
        configureAuthPopups(child.webContents, allowed);
    });
}

// Hostname of an https:// URL, or null. Origin decisions must compare parsed
// hostnames: substring/prefix tests also accept music.apple.com.attacker.example.
function _httpsHost(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' ? u.hostname : null;
    } catch { return null; }
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
            let s = document.getElementById('adam-tweaks');
            if (!s) { s = document.createElement('style'); s.id = 'adam-tweaks'; document.head.appendChild(s); }
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
        p.hideRadio
            ? '.navigation-item__radio{display:none!important}'
            : '',
    ].join('\n');
}

// ── Glass effect controls (visionOS panels) ───────────────────────────────────
// Writes CSS variables that vision-glass.js reads via var().
// No direct style conflicts — the glass CSS owns its rules, we just tune vars.
function applyGlassEffect(blur, opacity) {
    if (!win) return;
    // Clamp to numbers before JS interpolation — raw prefs strings must not reach executeJavaScript as
    // template-literal values (injection risk). 0 is a real value, so no `x || default`.
    blur    = cleanBlur(blur);
    opacity = cleanGlassOpacity(opacity);
    const p = loadPrefs();
    p.glassBlur    = blur;
    p.glassOpacity = opacity;
    savePrefs(p);
    win.webContents.executeJavaScript(`
        document.documentElement.style.setProperty('--adam-glass-blur', '${blur}px');
        document.documentElement.style.setProperty('--adam-glass-opacity', '${opacity}');
    `).catch(() => {});
}

// Album-art theming colours the sidebar itself (with --adam-nav-bg on <body>), so the Sidebar opacity slider
// reaches it through this variable on <html>: the accent opacity, or the blur veil scaled to the same range.
function _applyNavAlpha() {
    if (!win || win.isDestroyed()) return;
    const p = loadPrefs();
    const alpha = artNavAlpha(_resolveThemeMode(p), p);
    win.webContents.executeJavaScript(`document.documentElement.style.setProperty('--adam-nav-alpha','${alpha}')`).catch(() => {});
}

// ── Theme mode ───────────────────────────────────────────────────────────────
// Whether the page reports a signed-in Apple Music account (see theme-mode.mjs). The last reported
// state is remembered so a signed-in user gets no flash of the signed-out look.
{
    // Earlier versions saved a palette generated from an accent colour; reset it once.
    const prefs = loadPrefs();
    if (migrateThemePrefs(prefs)) savePrefs(prefs);
}
let _signedIn = !!loadPrefs().signedIn;

const _resolveThemeMode = (p) => resolveThemeMode({ signedIn: _signedIn, themeMode: p.themeMode, isHyprland: _isHyprland });

function applyThemeMode() {
    const p = loadPrefs();
    const mode = _resolveThemeMode(p);
    if (mode === 'accent') {
        if (!p.themePalette) {
            p.themePalette = defaultPalette();
            savePrefs(p);
        }
        _applyThemeVars(p.themePalette);
    } else if (mode === 'custom') {
        _injectCustomFallbackBg();
        if (p.customCssPath) _injectCustomCss(p.customCssPath);
    } else {
        _clearThemeVars();
        _clearCustomCss();
    }
    _applyNavAlpha();
}

// Auto-authenticate on startup when saved credentials exist but no engine session.
// Fires once per process after the UI is ready and the engine has had time to emit
// its initial DRM state. Clears stored credentials if they are rejected.
ipcMain.once('app:ui-ready', async () => {
    try {
        const store = await _storeLoad();
        if (!store.drm_email || !store.drm_password) return;
        // Give the engine a moment to load hybris and emit its initial DRM state.
        await new Promise(r => setTimeout(r, 3500));
        const https = await import('https');
        const agent = new https.Agent({ rejectUnauthorized: false });
        const statusRes = await fetch(`https://127.0.0.1:${ENGINE_PORT}/api/v1/drm/status`, { agent }).catch(() => null);
        if (!statusRes?.ok) return;
        const status = await statusRes.json().catch(() => null);
        // Only when the engine has no Apple session. A session it is still loading must not
        // be replaced by a fresh sign-in, which would ask Apple for another verification code.
        if (status?.state?.fairplay === 'ready' || status?.state?.session === 'valid') return;
        console.log('[Adam] Auto-authenticating with saved DRM credentials');
        const authRes = await fetch(`https://127.0.0.1:${ENGINE_PORT}/api/v1/drm/authenticate`, {
            method: 'POST', agent,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: store.drm_email, password: store.drm_password }),
        }).catch(() => null);
        if (!authRes?.ok) {
            console.warn('[Adam] Saved DRM credentials rejected — clearing');
            const s = await _storeLoad();
            delete s.drm_email; delete s.drm_password;
            _storeDirty = true; _storeFlush();
        }
    } catch (e) {
        console.warn('[Adam] DRM auto-auth error:', e.message);
    }
});

ipcMain.on('app:auth-state', (_e, signedIn) => {
    const on = signedIn === true;
    if (on === _signedIn) return;
    _signedIn = on;
    const p = loadPrefs();
    p.signedIn = on;
    savePrefs(p);
    applyThemeMode();
});

function applyPersistedViewSettings() {
    const p = loadPrefs();
    if (p.zoomFactor && p.zoomFactor !== 1.0)
        win?.webContents.setZoomFactor(p.zoomFactor);
    applyGlassEffect(p.glassBlur ?? 20, p.glassOpacity ?? 0.07);
    if (p.bgBlur != null)
        win?.webContents.executeJavaScript(
            `document.documentElement.style.setProperty('--adam-bg-blur','${parseFloat(p.bgBlur) || 18}px')`
        ).catch(() => {});
    applyTweak('__noop', null);
    applyThemeMode();
    _applyAcrylicPage();
}

// ── IPC sender check ─────────────────────────────────────────────────────────
// Every channel below is meant for the main Apple Music window — and only for the page
// itself on the Apple origin (the preload exposes adamBridge nowhere else). The mini player
// sends just the three transport channels. Registering through these wrappers makes that a
// rule instead of a convention: a stray frame, a window opened later, or any other renderer
// that obtained an ipcRenderer cannot reach the privileged handlers.
const _MINI_CHANNELS = new Set(['miniplayer:toggle', 'miniplayer:expand', 'miniplayer:cmd']);
function _senderAllowed(event, channel) {
    const wc = event.sender;
    if (win && !win.isDestroyed() && wc === win.webContents) {
        return _httpsHost(event.senderFrame?.url) === 'music.apple.com';
    }
    return _MINI_CHANNELS.has(channel) && miniWin && !miniWin.isDestroyed() && wc === miniWin.webContents;
}
const _ipcHandle = ipcMain.handle.bind(ipcMain);
const _ipcOn = ipcMain.on.bind(ipcMain);
ipcMain.handle = (channel, fn) => _ipcHandle(channel, (event, ...args) => {
    if (!_senderAllowed(event, channel)) {
        console.warn(`[Adam] refused IPC invoke ${channel} from ${event.senderFrame?.url || 'unknown'}`);
        throw new Error('forbidden');
    }
    return fn(event, ...args);
});
ipcMain.on = (channel, fn) => _ipcOn(channel, (event, ...args) => {
    if (!_senderAllowed(event, channel)) {
        console.warn(`[Adam] refused IPC message ${channel} from ${event.senderFrame?.url || 'unknown'}`);
        return;
    }
    fn(event, ...args);
});

// Argument checks for the handlers a page can reach: a compromised page must not be able to
// fill the disk, smuggle path separators into a dialog's default name, or poison prefs.
function _str(v, max = 256) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function _safeName(v) { return String(v).replace(/[^\w .()-]/g, '_').slice(0, 64) || 'preset'; }
const _PALETTE_KEYS = new Set(['accent', 'bgColor', 'navBg', 'navBorder', 'accentActive', 'appearance']);
const _COLOR_RE = /^[#a-zA-Z0-9(),.%\s/-]{1,64}$/;
function _paletteEntryOk(key, value) {
    if (!_PALETTE_KEYS.has(key) || typeof value !== 'string') return false;
    return key === 'appearance' ? /^[a-z]{1,16}$/.test(value) : _COLOR_RE.test(value);
}
const _STORE_VALUE_MAX = 256 * 1024;   // bytes of JSON per stored value
const _STORE_KEYS_MAX = 2000;
function _storeValueOk(value) {
    let size;
    try { size = JSON.stringify(value)?.length; } catch { return false; }   // not serialisable
    return size !== undefined && size <= _STORE_VALUE_MAX;
}
// May the privileged window navigate to this URL itself? Apple's own hosts only.
function _navigationAllowed(url) {
    const host = _httpsHost(url);
    return !!host && (host === 'apple.com' || host.endsWith('.apple.com'));
}

// ── IPC: prefs + view controls (used by settings panel) ─────────────────────
ipcMain.handle('prefs:get', () => loadPrefs());

// Returns the user-configured system power profile (performance/balanced/cool/quiet/…)
// from the ACPI platform_profile sysfs node, or null if unavailable.
ipcMain.handle('system:powerProfile', async () => {
    try {
        const raw = await readFileAsync('/sys/firmware/acpi/platform_profile', 'utf8');
        return raw.trim() || null;
    } catch { return null; }
});

// Encrypted per-key store (history, play-counts, etc.)
// Keys are restricted to a safe character set to prevent injection or path
// traversal by XSS code running in the Apple Music webview.
const _storeKeyRe = /^[a-zA-Z][a-zA-Z0-9_:.-]{0,127}$/;
ipcMain.handle('store:read',  async (_, key) => {
    if (typeof key !== 'string' || !_storeKeyRe.test(key)) return null;
    const store = await _storeLoad();
    return store[key] ?? null;
});
ipcMain.handle('store:write', async (_, key, value) => {
    if (typeof key !== 'string' || !_storeKeyRe.test(key)) return;
    if (!_storeValueOk(value)) return;
    const store = await _storeLoad();
    if (!(key in store) && Object.keys(store).length >= _STORE_KEYS_MAX) return;
    store[key] = value;
    _storeDirty = true;
    _storeFlush();
});
ipcMain.handle('store:delete', async (_, key) => {
    if (typeof key !== 'string' || !_storeKeyRe.test(key)) return;
    const store = await _storeLoad();
    delete store[key];
    _storeDirty = true;
    _storeFlush();
});
ipcMain.handle('dialog:choose-download-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Choose Download Folder',
        properties: ['openDirectory', 'createDirectory'],
    });
    return { canceled, filePaths };
});
const _VALID_PREF_KEYS = new Set(['persistLimitMB', 'persistTTLDays', 'prewarmLimitMB']);
ipcMain.on('pref:set', (_, k, v) => {
    if (!_VALID_PREF_KEYS.has(k)) return; // allowlist: ignore unknown keys
    if (!(Number.isFinite(v) && v >= 0 && v <= 1e7)) return;
    const p = loadPrefs(); p[k] = v; savePrefs(p);
});
ipcMain.on('view:zoom',       (_, f) => setZoom(parseFloat(f)));
ipcMain.on('view:glass-blur', (_, b) => { applyGlassEffect(b, loadPrefs().glassOpacity); });
ipcMain.on('view:bg-blur',   (_, b) => {
    const p = loadPrefs(); p.bgBlur = parseInt(b); savePrefs(p);
    win?.webContents.executeJavaScript(
        `document.documentElement.style.setProperty('--adam-bg-blur','${parseInt(b)}px')`
    ).catch(() => {});
    _refreshWallpaperBlur();
});
// view:tweak is the settings panel's generic pref writer, reachable from the
// Apple Music page. Keys the main process owns (read from disk, drive theme or
// window state) are set only through their dedicated handlers, never here.
const _MAIN_OWNED_PREFS = new Set([
    'customCssPath', 'themePalette', 'themePresets', 'themeMode', 'themeAppearance',
    'themeNavBgAlpha', 'winAcrylic', 'zoomFactor', 'glassBlur', 'glassOpacity', 'bgBlur', 'linkSchemes', 'linkSchemesApplied', 'signedIn', 'themeVersion',
]);
const _tweakKeyRe = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
function _validTweak(k, v) {
    if (typeof k !== 'string' || !_tweakKeyRe.test(k) || _MAIN_OWNED_PREFS.has(k)) return false;
    return v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ||
        (typeof v === 'string' && v.length <= 1024);
}
ipcMain.on('view:tweak',      (_, k, v) => { if (_validTweak(k, v)) applyTweak(k, v); });
// "Sidebar opacity" edits what the CURRENT theme's sidebar uses (see sidebar-glass.js): the accent colour's
// opacity, or the blur veil. The theme comes from the same rule as everything else (_resolveThemeMode); this
// handler used to treat a saved Blur as Accent off Hyprland, which re-applied the palette and so switched the
// theme, and wrote one pref while driving the other's CSS variable, so the change was never saved.
ipcMain.on('view:nav-opacity', (_, v) => {
    const p = loadPrefs();
    const control = sidebarOpacityControl(_resolveThemeMode(p));
    if (control.pref === 'themeNavBgAlpha') {
        p.themeNavBgAlpha = control.clean(v);
        savePrefs(p);
        if (p.themePalette) _applyThemeVars(p.themePalette);
    } else {
        applyGlassEffect(p.glassBlur, v);
    }
    _applyNavAlpha();
});

// ── Acrylic window (Windows) ─────────────────────────────────────────────────
// The windows that carry the acrylic: the main window and the mini player share the one setting.
const _acrylicWindows = () => [win, miniWin].filter(w => w && !w.isDestroyed());

function _applyAcrylicPage() {
    if (!_acrylicBackend) return;
    const s = _acrylicSettings();
    for (const w of _acrylicWindows())
        w.webContents.executeJavaScript(acrylicOverlayScript(s, { drag: w === win })).catch(() => {});
}

function _applyAcrylicMaterial(w, s) {
    try {
        setCompositionBackdrop(w, s);
    } catch (e) { console.warn('[Adam] Windows Composition backdrop:', e.message); }
}

// Pushes the saved settings to the windows: the material, and the native theme while the blur theme is on.
function _applyAcrylic() {
    if (!_acrylicBackend) return;
    const s = _acrylicSettings();
    if (_resolveThemeMode(loadPrefs()) === 'blur') nativeTheme.themeSource = s.theme;
    for (const w of _acrylicWindows()) _applyAcrylicMaterial(w, s);
    _applyAcrylicPage();
}

ipcMain.handle('acrylic:set', (_e, patch) => {
    if (!_acrylicBackend) return null;
    const p = loadPrefs();
    p.winAcrylic = normalizeAcrylic({ ..._acrylicSettings(), ...(patch && typeof patch === 'object' ? patch : {}) }, _acrylicBackend.materials);
    savePrefs(p);
    _applyAcrylic();
    return p.winAcrylic;
});

// ── Theme IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('theme:get-info', async () => {
    const p = loadPrefs();
    return {
        desktop:        _desktop || 'unknown',
        blurAvailable:  true,
        themeMode:      resolveThemeMode({ signedIn: true, themeMode: p.themeMode, isHyprland: _isHyprland }),
        themePalette:   p.themePalette || null,
        defaultPalette: defaultPalette(),
        themePresets:   [
            ...Object.entries(BUILTIN_PRESETS).map(([name, fn]) => ({ name, palette: fn(), builtin: true })),
            ...(p.themePresets || []),
        ],
        customCssPath:  p.customCssPath || null,
        acrylic:        _acrylicBackend ? { ..._acrylicSettings(), materials: _acrylicBackend.materials, defaults: ACRYLIC_DEFAULTS } : null,
    };
});

ipcMain.on('theme:set-mode', async (_, mode) => {
    if (mode !== 'blur' && mode !== 'accent' && mode !== 'custom') return; // the page picks from three buttons
    const p = loadPrefs();
    p.themeMode = mode;
    if (mode === 'accent') {
        if (!p.themePalette) p.themePalette = defaultPalette();
        savePrefs(p);
        await _clearCustomCss();
        _applyThemeVars(p.themePalette);
    } else if (mode === 'blur') {
        savePrefs(p);
        await _clearCustomCss();
        _clearThemeVars();
    } else if (mode === 'custom') {
        savePrefs(p);
        _clearThemeVars();
        _injectCustomFallbackBg();
        if (p.customCssPath) await _injectCustomCss(p.customCssPath);
    }
    _applyNavAlpha();
});

ipcMain.on('theme:set-palette', (_, key, value) => {
    if (!_paletteEntryOk(key, value)) return;
    const p = loadPrefs();
    if (!p.themePalette) p.themePalette = {};
    p.themePalette[key] = value;
    savePrefs(p);
    _applyThemeVars(p.themePalette);
});

ipcMain.handle('theme:reset-palette', async () => {
    const p = loadPrefs();
    p.themePalette = defaultPalette();
    savePrefs(p);
    _applyThemeVars(p.themePalette);
    return p.themePalette;
});

ipcMain.handle('theme:import-css', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Import Custom CSS',
        filters: [{ name: 'CSS files', extensions: ['css'] }],
        properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return null;
    const p = loadPrefs();
    p.customCssPath = filePaths[0];
    savePrefs(p);
    await _injectCustomCss(filePaths[0]);
    return filePaths[0];
});

ipcMain.handle('theme:save-preset', (_, name) => {
    if (!_str(name, 64)) return loadPrefs().themePresets || [];
    const p = loadPrefs();
    p.themePresets = (p.themePresets || []).filter(x => x.name !== name);
    p.themePresets.push({ name, palette: p.themePalette });
    savePrefs(p);
    return p.themePresets;
});

ipcMain.on('theme:delete-preset', (_, name) => {
    if (!_str(name, 64)) return;
    const p = loadPrefs();
    p.themePresets = (p.themePresets || []).filter(x => x.name !== name);
    savePrefs(p);
});

ipcMain.on('theme:apply-preset', (_, name) => {
    if (!_str(name, 64)) return;
    const p = loadPrefs();
    const palette = BUILTIN_PRESETS[name]
        ? BUILTIN_PRESETS[name]()
        : (p.themePresets || []).find(x => x.name === name)?.palette;
    if (!palette) return;
    p.themePalette = palette;
    savePrefs(p);
    _applyThemeVars(palette);
});

ipcMain.handle('theme:export-preset', async (_, name) => {
    if (!_str(name, 64)) return false;
    const p = loadPrefs();
    const preset = (p.themePresets || []).find(x => x.name === name) || { name: 'current', palette: p.themePalette };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: `adam-theme-${_safeName(preset.name)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return false;
    writeFileSync(filePath, JSON.stringify(preset, null, 2));
    return true;
});

ipcMain.handle('theme:import-preset', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: 'Import Theme Preset',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return null;
    try {
        const preset = sanitizePreset(JSON.parse(readFileSync(filePaths[0], 'utf8')));
        if (!preset) return null;
        const p = loadPrefs();
        p.themePresets = (p.themePresets || []).filter(x => x.name !== preset.name);
        p.themePresets.push(preset);
        savePrefs(p);
        return preset;
    } catch { return null; }
});

// ── EQ file I/O ──────────────────────────────────────────────────────────────
ipcMain.handle('eq:save-file', async (_, arg) => {
    const { filename, content } = arg || {};
    if (typeof content !== 'string' || content.length > 5 * 1024 * 1024) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: _safeName(path.basename(String(filename || 'eq.txt'))),
        filters: [
            { name: 'EqualizerAPO config', extensions: ['txt'] },
            { name: 'JSON', extensions: ['json'] },
            { name: 'All files', extensions: ['*'] },
        ],
    });
    if (canceled || !filePath) return false;
    writeFileSync(filePath, content, 'utf8');
    return true;
});

ipcMain.handle('eq:open-file', async (_, arg) => {
    const { filters } = arg || {};
    const okFilters = Array.isArray(filters) && filters.length <= 8 && filters.every(f =>
        _str(f?.name, 64) && Array.isArray(f.extensions) && f.extensions.length <= 16 &&
        f.extensions.every(e => typeof e === 'string' && /^[A-Za-z0-9*]{1,10}$/.test(e)));
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: okFilters ? filters : [
            { name: 'EqualizerAPO / text / JSON', extensions: ['txt', 'json', 'csv'] },
            { name: 'All files', extensions: ['*'] },
        ],
    });
    if (canceled || !filePaths.length) return null;
    return readFileSync(filePaths[0], 'utf8');
});

// ── MPRIS2 media integration ─────────────────────────────────────────────────
// Exposes Now Playing info to the system (taskbars, media keys, GNOME shell,
// KDE Connect, etc.) via the org.mpris.MediaPlayer2 D-Bus interface.
let mprisPlayer = null;
let _MprisService = null;
if (IS_LINUX) {
    try {
        const _require = createRequire(import.meta.url);
        _MprisService = _require('mpris-service');
    } catch (e) {
        console.warn('[Adam] mpris-service not available:', e.message);
    }
}

// dbus-next throws "Cannot send message, stream is closed" asynchronously from
// inside its socket data handler — outside any try/catch. Intercept it here
// so it doesn't crash the app, and null mprisPlayer so the next update reconnects.
process.on('uncaughtException', (err) => {
    if (err?.message?.includes('stream is closed') || err?.code === 'EPIPE') {
        console.warn('[Adam] MPRIS D-Bus uncaught (suppressed):', err.message);
        _destroyMprisPlayer();
        return;
    }
    // x11 package throws X11 protocol errors (BadWindow etc.) from socket
    // data handlers — outside any try/catch. Suppress them so they don't exit.
    if (err?.error != null && err?.badParam != null) {
        console.warn('[Adam] X11 protocol error (suppressed):', err.message ?? err);
        return;
    }
    // Re-throw anything unrelated to D-Bus / X11.
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
    // A D-Bus session bus must actually exist (Linux only); the env vars alone do not prove it.
    return IS_LINUX && hasSessionBus();
}

let _mprisRetryTimer = null;
let _mprisFailures = 0; // consecutive D-Bus errors, for the retry backoff
let _mprisNotBefore = 0; // no reconnect attempt (timer or mpris:update) before this time
function createMprisPlayer() {
    if (!_MprisService || !_mprisReady() || Date.now() < _mprisNotBefore) return null;
    try {
        const player = _MprisService({
            name: 'adam',
            identity: 'Adam',
            supportedUriSchemes: [],
            supportedMimeTypes: ['audio/mpeg', 'audio/flac'],
            supportedInterfaces: ['player'],
            desktopEntry: 'adam',
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
        player.on('shuffle',   (val) => sendCmd({ type: 'shuffle', value: Boolean(val) }));

        // MPRIS2 § LoopStatus: client (e.g. KDE media widget) sets loop mode.
        player.on('loopStatus', (status) => sendCmd({ type: 'setLoopStatus', value: status }));

        // MPRIS2 § Volume: client changes volume (0.0–1.0 → 0–100 for renderer).
        player.on('volume', (val) => sendCmd({ type: 'setVolume', value: Math.round(Number(val) * 100) }));

        // MPRIS2 § Rate: we only support 1.0x; reject attempts to change it.
        player.on('rate', () => { try { player.rate = 1.0; } catch (_) {} });

        // MPRIS2 § OpenUri: forward to the deep-link dispatcher (https:// only).
        player.on('open-uri', (uri) => {
            const s = String(uri ?? '');
            if (isLinkArg(s)) _dispatchDeepLink(s);
        });

        // MPRIS → app: Seek (delta µs) and SetPosition (absolute µs).
        // dbus-next returns int64 as BigInt; convert to Number before dividing.
        // The renderer emits Seeked back after the seek settles.
        player.on('seek', (offset) => {
            win?.webContents.send('mpris:cmd', { type: 'seek', deltaMs: Number(offset) / 1000 });
        });
        player.on('position', (event) => {
            win?.webContents.send('mpris:cmd', { type: 'setPosition', ms: Number(event.position) / 1000 });
        });

        // When D-Bus signals an error, null the player and schedule a reconnect
        // so the next mpris:update (or the retry timer) re-registers the service.
        player.on('error', (err) => {
            console.warn('[Adam] MPRIS D-Bus error:', err?.message ?? err);
            // Disconnect the old bus before nulling so D-Bus releases the name.
            // Without this, retries are rejected (EPIPE) because the zombie
            // player still holds org.mpris.MediaPlayer2.adam.
            if (mprisPlayer === player) _destroyMprisPlayer();
            if (!_mprisRetryTimer) {
                const delay = mprisRetryDelay(++_mprisFailures);
                _mprisNotBefore = Date.now() + delay;
                _mprisRetryTimer = setTimeout(() => {
                    _mprisRetryTimer = null;
                    if (!mprisPlayer) {
                        mprisPlayer = createMprisPlayer();
                        if (mprisPlayer) replayMprisState();
                    }
                }, delay);
            }
        });

        console.log('[Adam] MPRIS2 service registered');
        // A player that is still up after 10 s is healthy: forget earlier failures.
        setTimeout(() => { if (mprisPlayer === player) _mprisFailures = 0; }, 10_000).unref?.();
        return player;
    } catch (e) {
        console.warn('[Adam] MPRIS2 init failed:', e.message);
        return null;
    }
}

let _lastMprisStatus   = null;
let _lastMprisMetadata = null;
let _lastMprisPosition = 0; // µs
let _lastMprisShuffle  = false;
let _lastMprisRepeat   = null; // 0=none, 1=all, 2=one

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
        // that prepends /org/node/mediaplayer/adam/ whose
        // "adam" segment contains hyphens, which are illegal
        // in D-Bus object path elements ([A-Za-z0-9_] only). The daemon
        // rejects the malformed message and closes the socket, causing every
        // subsequent write to EPIPE.
        p.metadata = meta;
        p.canSeek = true;
    }
    // Do NOT set p.position here — that would emit PropertiesChanged for
    // Position every 1s tick, causing applet jitter. getPosition() is already
    // overridden to return _lastMprisPosition on every D-Bus GetPosition call.
    if (data.shuffle != null) {
        try { p.shuffle = data.shuffle; } catch (_) {}
    }
    if (data.repeat != null) {
        // MusicKit repeatMode: 0=none, 1=one, 2=all → MPRIS LoopStatus.
        // (Was ['None','Playlist','Track'], which swapped one↔all.)
        const loopMap = ['None', 'Track', 'Playlist'];
        try { p.loopStatus = loopMap[data.repeat] ?? 'None'; } catch (_) {}
    }
    // Propagate volume from renderer (0–100) to MPRIS (0.0–1.0).
    if (data.volume != null) try { p.volume = Math.max(0, Math.min(1, data.volume / 100)); } catch (_) {}
}

function replayMprisState() {
    if (!mprisPlayer) return;
    // Give the D-Bus auth handshake a moment to complete before the first write.
    setTimeout(() => {
        const p = mprisPlayer;
        if (!p) return;
        try {
            // MPRIS2 § Rate constraints — we do not support playback rate changes.
            p.minimumRate = 1.0;
            p.maximumRate = 1.0;
            p.rate = 1.0;
            // MPRIS2 § Control capabilities (static — we always allow control).
            p.canControl  = true;
            p.canGoNext   = true;
            p.canGoPrevious = true;
            p.canPlay  = true;
            p.canPause = true;
        } catch (_) {}
        try {
            if (_lastMprisStatus)        applyMprisData({ status: _lastMprisStatus });
            if (_lastMprisMetadata)      applyMprisData({ metadata: _lastMprisMetadata });
            if (_lastMprisPosition)      applyMprisData({ position: _lastMprisPosition });
            applyMprisData({ shuffle: _lastMprisShuffle });
            if (_lastMprisRepeat != null) applyMprisData({ repeat: _lastMprisRepeat });
        } catch (_) {}
    }, 400);
}

ipcMain.on('mpris:update', (_, data) => {
    // Track each field independently so all survive across reconnects.
    if (data.status)           _lastMprisStatus   = data.status;
    if (_reloadEngineOnPause && data.status && data.status !== 'Playing') {
        _reloadEngineOnPause = false;
        engineLifecycle.reload();
    }
    if (data.metadata)         _lastMprisMetadata = data.metadata;
    if (data.position != null) _lastMprisPosition = data.position;
    if (data.shuffle != null)  _lastMprisShuffle  = data.shuffle;
    if (data.repeat  != null)  _lastMprisRepeat   = data.repeat;

    // Mirror now-playing to the mini player if it's open.
    sendMiniState(data);
    winIntegration?.update(data);

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
        console.warn('[Adam] MPRIS update failed, will reconnect:', e.message);
        _destroyMprisPlayer();
    }
});

// Settings → Links: which URL schemes Adam claims. The scheme list and the choices live in
// link-schemes.mjs; the page can only toggle schemes that module offers.
ipcMain.handle('links:get', () => linkSchemes.list());
ipcMain.handle('links:set', (_e, scheme, enabled) => {
    if (typeof scheme !== 'string' || typeof enabled !== 'boolean') throw new Error('bad arguments');
    return linkSchemes.set(scheme, enabled);
});

// Transport commands from the page's navigator.mediaSession handlers (Windows SMTC).
// Only a fixed set of commands is forwarded; the renderer already handles them for MPRIS.
const _MEDIA_CMDS = new Set(['play', 'pause', 'playpause', 'next', 'previous']);
ipcMain.on('media:cmd', (_e, c) => {
    const ok = typeof c === 'string' ? _MEDIA_CMDS.has(c)
        : !!c && c.type === 'setPosition' && Number.isFinite(c.ms) && c.ms >= 0;
    if (ok) win?.webContents.send('mpris:cmd', c);
});

// ── Discord Rich Presence ─────────────────────────────────────────────────────
// Native Discord IPC — framed JSON over the discord-ipc-N Unix socket (a named pipe on Windows), no
// external dependency. Shows the current track as your Discord status.
// REQUIRES a Discord application client ID: register an app at
// https://discord.com/developers/applications and paste its Application ID
// below. Presence stays inert until a real ID is set.
const DISCORD_CLIENT_ID = '1545304879441121320'; // Discord application (client) ID for adam

let _discordSocket = null;
let _discordReady = false;
let _discordConnecting = false;
let _discordEnabled = false;
let _discordPendingActivity = null;
let _discordReconnectTimer = null;
let _discordBuf = Buffer.alloc(0);

function _discordSocketPaths() { return discordIpcPaths(); }

function _discordEncode(op, payload) {
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    const header = Buffer.alloc(8);
    header.writeInt32LE(op, 0);
    header.writeInt32LE(json.length, 4);
    return Buffer.concat([header, json]);
}

function _discordConnect() {
    if (!DISCORD_CLIENT_ID || _discordConnecting || _discordReady) return;
    const paths = _discordSocketPaths();
    let idx = 0;
    _discordConnecting = true;
    const tryNext = () => {
        if (idx >= paths.length) { _discordConnecting = false; return; }
        const sock = net.createConnection(paths[idx++]);
        sock.once('error', () => { try { sock.destroy(); } catch (_) {} tryNext(); });
        sock.once('connect', () => {
            _discordSocket = sock;
            _discordConnecting = false;
            _discordBuf = Buffer.alloc(0);
            sock.on('data', _discordOnData);
            sock.on('close', _discordOnClose);
            sock.on('error', _discordOnClose);
            sock.write(_discordEncode(0, { v: 1, client_id: DISCORD_CLIENT_ID }));
        });
    };
    tryNext();
}

function _discordOnData(chunk) {
    _discordBuf = Buffer.concat([_discordBuf, chunk]);
    while (_discordBuf.length >= 8) {
        const len = _discordBuf.readInt32LE(4);
        // Guard against a malformed/negative length desyncing the parser.
        if (len < 0 || len > (1 << 24)) { _discordBuf = Buffer.alloc(0); break; }
        if (_discordBuf.length < 8 + len) break;
        const payload = _discordBuf.slice(8, 8 + len).toString('utf8');
        _discordBuf = _discordBuf.slice(8 + len);
        try {
            const msg = JSON.parse(payload);
            if (msg.evt === 'READY') {
                _discordReady = true;
                if (_discordPendingActivity) _discordSendActivity(_discordPendingActivity);
            }
        } catch (_) {}
    }
}

function _discordOnClose() {
    _discordReady = false;
    _discordConnecting = false;
    if (_discordSocket) { try { _discordSocket.destroy(); } catch (_) {} _discordSocket = null; }
    if (_discordEnabled && DISCORD_CLIENT_ID && !_discordReconnectTimer) {
        _discordReconnectTimer = setTimeout(() => { _discordReconnectTimer = null; _discordConnect(); }, 5000);
    }
}

function _discordSendActivity(activity) {
    if (!_discordSocket || !_discordReady) return;
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try { _discordSocket.write(_discordEncode(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce })); } catch (_) {}
}

function _discordClearActivity() {
    if (!_discordSocket || !_discordReady) return;
    try { _discordSocket.write(_discordEncode(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: `${Date.now()}-clear` })); } catch (_) {}
}

ipcMain.on('discord:update', (_, data) => {
    _discordEnabled = true;
    if (!DISCORD_CLIENT_ID) return; // inert until a client ID is configured
    const activity = {
        type: 2, // "Listening to …"
        details: (data.name || '').slice(0, 128) || undefined,
        state:   (data.artist || '').slice(0, 128) || undefined,
    };
    // Artwork + play/pause badge.
    // small_image keys ("play" / "pause") must be uploaded as assets in the
    // Discord Developer Portal under this application (client ID 1545304879441121320).
    if (data.artworkUrl) {
        activity.assets = {
            large_image: data.artworkUrl,
            large_text:  (data.album || '').slice(0, 128) || undefined,
            small_image: data.playing ? 'play' : 'pause',
            small_text:  data.playing ? 'Playing' : 'Paused',
        };
    }
    if (data.playing && data.startedAtMs) {
        activity.timestamps = { start: Math.round(data.startedAtMs / 1000) };
        if (data.endsAtMs) activity.timestamps.end = Math.round(data.endsAtMs / 1000);
    } else {
        // Explicitly null timestamps so Discord clears the running timer.
        // Omitting the key leaves the previous timestamps cached in the client.
        activity.timestamps = null;
    }
    // "Open in Apple Music" button — opens the song/MV page in the user's browser.
    // Buttons are visible to everyone viewing the user's profile except the user themselves.
    if (data.appleUrl) {
        activity.buttons = [{ label: data.isVideo ? 'Open Music Video' : 'Open in Apple Music', url: data.appleUrl }];
    }
    _discordPendingActivity = activity;
    if (!_discordSocket && !_discordConnecting) _discordConnect();
    else if (_discordReady) _discordSendActivity(activity);
});

ipcMain.on('discord:clear', () => {
    _discordPendingActivity = null;
    _discordClearActivity();
});

ipcMain.on('discord:disable', () => {
    _discordEnabled = false;
    _discordPendingActivity = null;
    _discordClearActivity();
    if (_discordReconnectTimer) { clearTimeout(_discordReconnectTimer); _discordReconnectTimer = null; }
    if (_discordSocket) { try { _discordSocket.destroy(); } catch (_) {} _discordSocket = null; }
    _discordReady = false;
});

// ── Last.fm scrobbling ────────────────────────────────────────────────────────
// The API key + shared secret are configured from Adam Settings (create an API
// account at https://www.last.fm/api/account/create). Both, and the user's
// session key, live ONLY in the main process (encrypted store) — the secret is
// never returned to the renderer.
const LASTFM_ROOT = 'https://ws.audioscrobbler.com/2.0/';

async function _lastfmCreds() {
    const store = await _storeLoad();
    return { key: store.lastfm_api_key || '', secret: store.lastfm_secret || '' };
}

function _lastfmSign(params, secret) {
    // api_sig = md5( concat(sorted key+value, excluding format/callback) + secret )
    const keys = Object.keys(params).filter(k => k !== 'format' && k !== 'callback').sort();
    let s = '';
    for (const k of keys) s += k + params[k];
    s += secret;
    return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

async function _lastfmCall(params, httpMethod = 'GET') {
    const { key, secret } = await _lastfmCreds();
    const full = { ...params, api_key: key };
    full.api_sig = _lastfmSign(full, secret);
    full.format  = 'json';
    const body = new URLSearchParams(full).toString();
    const resp = httpMethod === 'POST'
        ? await fetch(LASTFM_ROOT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
        : await fetch(`${LASTFM_ROOT}?${body}`);
    return resp.json();
}

let _lastfmPendingToken = null;

ipcMain.handle('lastfm:set-credentials', async (_, c) => {
    const store = await _storeLoad();
    if (typeof c?.apiKey === 'string' && c.apiKey.length <= 128) store.lastfm_api_key = c.apiKey.trim();
    // Only overwrite the secret when a non-empty one is provided — a blank field
    // means "keep the saved secret".
    if (typeof c?.secret === 'string' && c.secret.trim() && c.secret.length <= 128) store.lastfm_secret = c.secret.trim();
    _storeDirty = true; _storeFlush();
    return { ok: true };
});

ipcMain.handle('drm:save-credentials', async (_, c) => {
    if (typeof c?.email !== 'string' || typeof c?.password !== 'string') return { ok: false };
    if (c.email.length > 256 || c.password.length > 256) return { ok: false };
    const store = await _storeLoad();
    store.drm_email    = c.email.trim();
    store.drm_password = c.password;
    _storeDirty = true; _storeFlush();
    return { ok: true };
});

// Sign-out ({ reload: true }, the default) or an abandoned sign-in ({ reload: false }).
// backstop ('account' | 'device') is passed only when the engine route failed; it is
// recorded first, and if that fails nothing else happens (drm-signout.mjs).
ipcMain.handle('drm:clear-credentials', async (_, opts) => {
    const backstop = opts?.backstop ?? null;
    if (backstop !== null && !validBackstop(backstop)) console.warn('[Adam] Ignoring invalid sign-out scope:', backstop);
    const res = await clearCredentialsFlow({
        reload: opts?.reload !== false,
        backstop,
        record: (scope) => {
            const r = writeBackstop(drmFilesDirPath(), scope);
            if (!r.committed || !r.durable) console.warn('[Adam] Sign-out backstop:', r);
            return r;
        },
        deleteCredentials: async () => {
            const store = await _storeLoad();
            delete store.drm_email;
            delete store.drm_password;
            _storeDirty = true;
            return _storeFlushNow();
        },
        // A fresh engine process: Apple's libraries keep the signed-out account in
        // memory otherwise, and a recorded backstop is completed on start.
        reloadEngine: () => engineLifecycle.reload(),
    });
    if (!res.ok) console.warn('[Adam] Sign-out did not complete:', res.error);
    return res;
});

ipcMain.handle('lastfm:status', async () => {
    const store = await _storeLoad();
    const configured = !!(store.lastfm_api_key && store.lastfm_secret);
    // apiKey is public → returned for prefill; the secret is never returned.
    return { configured, apiKey: store.lastfm_api_key || '', secretSet: !!store.lastfm_secret,
             connected: !!store.lastfm_sk, username: store.lastfm_user || null };
});

// Open Last.fm's authorize page IN-APP so we control the theme and avoid the
// external browser's white flash. Dark window background + show-on-ready kills
// the "flashbang"; a non-destructive color-scheme hint lets the page render dark
// where it supports it (we never restyle Last.fm's form — that would wreck
// contrast if their page is light).
let _lastfmAuthWin = null;
function openLastfmAuthWindow(url) {
    if (_lastfmAuthWin && !_lastfmAuthWin.isDestroyed()) { _lastfmAuthWin.focus(); _lastfmAuthWin.loadURL(url); return; }
    _lastfmAuthWin = new BrowserWindow({
        width: 480, height: 760, show: false,
        backgroundColor: '#1c1c1e',           // dark ground painted before first frame
        title: 'Last.fm — Authorize Adam',
        parent: win, autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true, nodeIntegration: false, sandbox: _hasSandbox,
            partition: 'persist:lastfm-auth',  // isolated from the Apple Music session
            devTools: !app.isPackaged,
        },
    });
    _lastfmAuthWin.once('ready-to-show', () => _lastfmAuthWin.show());
    _lastfmAuthWin.webContents.on('dom-ready', () => {
        // Prefer dark UA rendering (scrollbars, form controls, default canvas) and
        // hint the page toward dark — without overriding its own colors.
        _lastfmAuthWin.webContents.insertCSS('html{color-scheme:dark light;background:#1c1c1e;}').catch(() => {});
        _lastfmAuthWin.webContents.executeJavaScript(
            "try{document.documentElement.style.colorScheme='dark';}catch(e){}").catch(() => {});
    });
    _lastfmAuthWin.on('closed', () => { _lastfmAuthWin = null; });
    configureAuthPopups(_lastfmAuthWin.webContents, (u) => {
        const host = _httpsHost(u);
        return host === 'last.fm' || host?.endsWith('.last.fm') ||
            host === 'accounts.google.com' || host === 'www.facebook.com';
    });
    _lastfmAuthWin.loadURL(url).catch(e => console.error('[Adam] Last.fm login load failed:', e.message));
}

ipcMain.handle('lastfm:auth', async () => {
    const { key, secret } = await _lastfmCreds();
    if (!key || !secret) return { error: 'not-configured' };
    try {
        const r = await _lastfmCall({ method: 'auth.getToken' });
        if (!r.token) return { error: r.message || 'token request failed' };
        _lastfmPendingToken = r.token;
        openLastfmAuthWindow(`https://www.last.fm/api/auth/?api_key=${key}&token=${r.token}`);
        return { token: r.token };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('lastfm:session', async (_, token) => {
    const { key, secret } = await _lastfmCreds();
    if (!key || !secret) return { error: 'not-configured' };
    const t = token || _lastfmPendingToken;
    if (!t) return { error: 'no-token' };
    try {
        const r = await _lastfmCall({ method: 'auth.getSession', token: t });
        if (!r.session?.key) return { error: r.message || 'not authorized yet — approve in the browser first' };
        const store = await _storeLoad();
        store.lastfm_sk = r.session.key;
        store.lastfm_user = r.session.name;
        _storeDirty = true; _storeFlush();
        _lastfmPendingToken = null;
        return { username: r.session.name };
    } catch (e) { return { error: e.message }; }
});

ipcMain.handle('lastfm:disconnect', async () => {
    const store = await _storeLoad();
    delete store.lastfm_sk; delete store.lastfm_user;
    _storeDirty = true; _storeFlush();
    return { ok: true };
});

ipcMain.on('lastfm:nowplaying', async (_, t) => {
    if (!t?.artist || !t?.track) return;
    const store = await _storeLoad();
    if (!store.lastfm_sk || !store.lastfm_api_key) return;
    const p = { method: 'track.updateNowPlaying', artist: t.artist, track: t.track, sk: store.lastfm_sk };
    if (t.album)       p.album       = t.album;
    if (t.albumArtist) p.albumArtist = t.albumArtist;
    if (t.duration)    p.duration    = String(Math.round(t.duration));
    try { await _lastfmCall(p, 'POST'); } catch (_) {}
});

ipcMain.on('lastfm:scrobble', async (_, t) => {
    if (!t?.artist || !t?.track || !t?.timestamp) return;
    const store = await _storeLoad();
    if (!store.lastfm_sk || !store.lastfm_api_key) return;
    const p = { method: 'track.scrobble', artist: t.artist, track: t.track, timestamp: String(t.timestamp), sk: store.lastfm_sk };
    if (t.album)       p.album       = t.album;
    if (t.albumArtist) p.albumArtist = t.albumArtist;
    if (t.duration)    p.duration    = String(Math.round(t.duration));
    try { await _lastfmCall(p, 'POST'); } catch (_) {}
});

// ── ListenBrainz scrobbling ───────────────────────────────────────────────────
// Simpler than Last.fm: a single user token (from https://listenbrainz.org/settings/)
// authenticates via an Authorization header — no app key/secret, no signing.
// The token lives only in the main process (encrypted store).
const LB_ROOT = 'https://api.listenbrainz.org';

async function _lbToken() { return (await _storeLoad()).lb_token || ''; }

function _lbTrackMeta(t) {
    const md = { artist_name: t.artist, track_name: t.track };
    if (t.album) md.release_name = t.album;
    return md;
}

async function _lbSubmit(body) {
    const token = await _lbToken();
    if (!token) return;
    try {
        await fetch(`${LB_ROOT}/1/submit-listens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Token ${token}` },
            body: JSON.stringify(body),
        });
    } catch (_) {}
}

ipcMain.handle('lb:set-token', async (_, token) => {
    if (token != null && !(typeof token === 'string' && token.length <= 256)) return { ok: false };
    const store = await _storeLoad();
    store.lb_token = (token || '').trim();
    _storeDirty = true; _storeFlush();
    return { ok: true };
});

ipcMain.handle('lb:status', async () => {
    const token = await _lbToken();
    if (!token) return { connected: false };
    // Validate the token to surface the linked username.
    try {
        const r = await fetch(`${LB_ROOT}/1/validate-token`, { headers: { Authorization: `Token ${token}` } });
        const j = await r.json();
        return { connected: !!j.valid, username: j.user_name || null };
    } catch (_) { return { connected: true, username: null }; }
});

ipcMain.handle('lb:disconnect', async () => {
    const store = await _storeLoad();
    delete store.lb_token;
    _storeDirty = true; _storeFlush();
    return { ok: true };
});

ipcMain.on('lb:nowplaying', async (_, t) => {
    if (!t?.artist || !t?.track) return;
    await _lbSubmit({ listen_type: 'playing_now', payload: [{ track_metadata: _lbTrackMeta(t) }] });
});

ipcMain.on('lb:scrobble', async (_, t) => {
    if (!t?.artist || !t?.track || !t?.timestamp) return;
    await _lbSubmit({ listen_type: 'single', payload: [{ listened_at: t.timestamp, track_metadata: _lbTrackMeta(t) }] });
});

// Open a vetted external link (settings help links) in the system browser.
ipcMain.on('app:open-external', (_, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});


// ── Mini player (compact always-on-top now-playing window) ────────────────────
let miniWin = null;

function createMiniPlayer() {
    if (miniWin && !miniWin.isDestroyed()) { miniWin.show(); miniWin.focus(); return; }
    miniWin = new BrowserWindow({
        width: 360,
        height: 150,
        useContentSize: true,
        frame: false,
        // Both windows expose the same per-window Composition host backdrop.
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        ..._devWindowIcon,
        title: 'Adam — Mini Player',
        webPreferences: {
            preload: path.join(__dirname, 'miniplayer-preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            // sandbox: false keeps the sandbox off to avoid the preload
            // bootstrap crash ("binding.startupData is null") seen on some
            // Linux FUSE/AppImage setups — contextIsolation provides the
            // security boundary instead.
            sandbox: false,
            devTools: !app.isPackaged,
        },
    });
    miniWin.setAlwaysOnTop(true, 'floating');
    if (_acrylicBackend) {
        _applyAcrylicMaterial(miniWin, _acrylicSettings());
        miniWin.webContents.on('did-finish-load', _applyAcrylicPage);
    }
    miniWin.loadFile(path.join(__dirname, 'miniplayer.html'));
    miniWin.once('ready-to-show', () => {
        miniWin.show();
        // Hide the main window (Apple's MiniPlayer replaces it) and ask the
        // renderer to push a full now-playing snapshot to the mini.
        if (win && !win.isDestroyed()) win.hide();
        sendMiniState({ metadata: _lastMprisMetadata, status: _lastMprisStatus, position: _lastMprisPosition });
        try { win?.webContents.send('miniplayer:sync'); } catch (_) {}
    });
    miniWin.on('close', () => removeCompositionBackdrop(miniWin));
    miniWin.on('closed', () => { miniWin = null; restoreMainFromMini(); });
}

function restoreMainFromMini() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

function toggleMiniPlayer() {
    if (miniWin && !miniWin.isDestroyed()) { miniWin.close(); miniWin = null; } // 'closed' restores main
    else createMiniPlayer();
}

function sendMiniState(data) {
    if (miniWin && !miniWin.isDestroyed()) {
        try { miniWin.webContents.send('miniplayer:state', data); } catch (_) {}
    }
}

ipcMain.on('miniplayer:toggle', () => toggleMiniPlayer());
ipcMain.on('miniplayer:expand', () => {          // back to the full window
    restoreMainFromMini();
    if (miniWin && !miniWin.isDestroyed()) { miniWin.close(); miniWin = null; }
});
ipcMain.on('miniplayer:cmd', (_, payload) => {
    // Forward transport commands (string or {type,...}) to the main window's
    // MPRIS command channel, which the injected renderer already handles.
    win?.webContents.send('mpris:cmd', payload);
});


function createTray() {
    const iconPath = app.isPackaged
        ? path.join(process.resourcesPath, 'tray-icon.png')
        : path.join(__dirname, '..', 'assets', 'tray-icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (IS_WIN) icon = icon.resize({ width: 16, height: 16 });

    tray = new Tray(icon);
    tray.setToolTip('Adam');

    const sendPlayback = (cmd) => win?.webContents.send('mpris:cmd', cmd);

    // Toggle on visibility alone. Clicking the tray moves focus off the window
    // first (and isFocused() is unreliable on Wayland/KDE), so gating hide on
    // isFocused() made the hide branch unreachable — it always raised instead.
    const toggleWindow = () => {
        if (!win) return;
        if (win.isVisible()) { win.hide(); } else { win.show(); win.focus(); }
    };

    const buildTrayMenu = () => Menu.buildFromTemplate([
        { label: 'Show/Hide Window', click: toggleWindow },
        {
            label: 'Maximise/Restore',
            click: () => {
                if (!win || win.isDestroyed()) return;
                if (win.isMaximized()) win.unmaximize(); else win.maximize();
            },
        },
        { type: 'separator' },
        { label: 'Play/Pause', click: () => sendPlayback('playpause') },
        { label: 'Next', click: () => sendPlayback('next') },
        { label: 'Previous', click: () => sendPlayback('previous') },
        { type: 'separator' },
        { label: (miniWin && !miniWin.isDestroyed()) ? 'Hide Mini Player' : 'Mini Player', click: toggleMiniPlayer },
        { type: 'separator' },
        {
            label: 'Restart App',
            click: async () => {
                // Clear the resume state so a deliberate restart starts fresh,
                // not with a "resume from X" chip confusingly appearing on boot.
                try {
                    const store = await _storeLoad();
                    delete store['adam_resume_state'];
                    _storeDirty = true;
                    _storeFlushSync();
                } catch (_) {}
                app.relaunch(); app.quit();
            },
        },
        { label: 'Exit', click: () => app.quit() },
    ]);

    tray.setContextMenu(buildTrayMenu());
    tray.on('right-click', () => tray.setContextMenu(buildTrayMenu()));

    // Left-click toggles the window. (Note: many Linux tray hosts —
    // StatusNotifierItem on KDE/GNOME — do not deliver 'click' at all and only
    // open the context menu; the "Show/Hide Window" menu item is the reliable
    // path there. double-click is delivered by some DEs, so wire it too.)
    tray.on('click', toggleWindow);
    tray.on('double-click', toggleWindow);
}

// Register before app.ready — required by Electron's privileged scheme API.
// adam-video:// proxies to the local engine over https://127.0.0.1:ENGINE_PORT,
// bypassing Chrome's mixed-content auto-upgrade which blocks <video src="http://...">
// on HTTPS pages even for loopback addresses.
protocol.registerSchemesAsPrivileged([{
    scheme: 'adam-video',
    privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true },
}]);

// Resolved faststart cache path per video-dl pathname, so range requests skip the
// engine info round-trip. Entries are session-scoped URLs; harmless to let grow.
const _mvPathCache = new Map();

// Serve a local media file with proper Range → 206 handling for <video>.
// Parses `bytes=a-b` / `bytes=a-` / `bytes=-n`, slices with createReadStream, and
// returns 206 + Content-Range + Accept-Ranges (200 for no Range, 416 unsatisfiable).
// This is the seekable-media contract Chrome's <video> requires; proxying ranges
// through electronNet.fetch does not satisfy it (→ MEDIA_ERR_SRC_NOT_SUPPORTED).
function serveLocalMediaRange(filePath, rangeHeader, method = 'GET') {
    let size;
    try {
        size = statSync(filePath).size;
    } catch (e) {
        console.error(`[adam-video] serveLocal 404 path=${filePath} err=${e.message}`);
        return new Response('media not found', { status: 404 });
    }
    const base = { 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' };
    const isHead = (method || 'GET').toUpperCase() === 'HEAD';

    // Single byte range only; multi-range and malformed headers fall back to a full 200 (RFC 7233).
    const parsed = parseByteRange(rangeHeader, size);
    if (parsed.kind === 'unsatisfiable') {
        console.warn(`[adam-video] serveLocal 416 unsatisfiable range=${rangeHeader} size=${size}`);
        return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
    }
    const start = parsed.kind === 'range' ? parsed.start : undefined;
    const end = parsed.kind === 'range' ? parsed.end : undefined;

    // Build a web ReadableStream from a bounded file read with explicit cancel
    // handling. Chrome aborts range requests constantly while seeking; if that
    // abort surfaces as an unhandled stream error the demuxer reports
    // PIPELINE_ERROR_READ (code=2). cancel() quietly destroys the fs stream, and
    // 'error' is logged rather than thrown.
    // Pull-based bridge: read the next chunk only when Chrome asks for more (paused
    // mode). Flowing-mode pause()/resume() wedges — the forward buffer stops
    // refilling past ~30s, the video underflows, audio races ahead, and the sync
    // logic forces a seek into unbuffered bytes → PIPELINE_ERROR_READ. Pull-based
    // backpressure tracks Chrome's demand exactly, so the buffer keeps refilling.
    const fileWebStream = (opts, tag) => {
        const ns = createReadStream(filePath, { highWaterMark: 1 << 20, ...opts });
        let ended = false, errored = null;
        ns.on('end', () => { ended = true; });
        ns.on('error', (err) => { errored = err; console.warn(`[adam-video] ${tag} read error: ${err.message}`); });
        return new ReadableStream({
            async pull(controller) {
                for (;;) {
                    if (errored) { controller.error(errored); return; }
                    const chunk = ns.read();
                    if (chunk) { controller.enqueue(new Uint8Array(chunk)); return; }
                    if (ended) { controller.close(); return; }
                    await new Promise((res) => {
                        const done = () => { ns.off('readable', done); ns.off('end', done); ns.off('error', done); res(); };
                        ns.once('readable', done);
                        ns.once('end', done);
                        ns.once('error', done);
                    });
                }
            },
            cancel(reason) {
                console.log(`[adam-video] ${tag} cancelled (client abort/seek): ${reason ?? ''}`);
                ns.destroy();
            },
        });
    };

    if (start === undefined) {
        // No usable Range → full file (200).
        const headers = { ...base, 'Content-Length': String(size) };
        console.log(`[adam-video] serveLocal 200 full method=${method} size=${size} rangeHdr=${rangeHeader || '(none)'}`);
        if (isHead || size === 0) return new Response(null, { status: 200, headers });
        return new Response(fileWebStream({}, '200'), { status: 200, headers });
    }

    const length = end - start + 1;
    const headers = { ...base, 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${end}/${size}` };
    console.log(`[adam-video] serveLocal 206 method=${method} bytes ${start}-${end}/${size} len=${length}`);
    if (isHead) return new Response(null, { status: 206, headers });
    return new Response(fileWebStream({ start, end }, `206 ${start}-${end}`), { status: 206, headers });
}

app.whenReady().then(() => {
    // A second instance can reach whenReady before app.quit() finishes. Do not
    // create windows or start services after failing to acquire the lock.
    if (!_gotLock) return;

    // Defer MPRIS init by 1.5 s — Electron's D-Bus socket access isn't
    // reliable the instant app is ready; a short delay avoids the EPIPE
    // that fires when the auth handshake races the first property write.
    setTimeout(() => { if (!mprisPlayer) mprisPlayer = createMprisPlayer(); }, 1500);

    console.log('[Adam] Electron ready, process.type:', process.type);
    const s = session.fromPartition('persist:apple-music');
    // This session loads remote pages, so the default of "yes to everything" would hand a
    // compromised page the camera, microphone, location, USB and the clipboard. Deny the
    // capabilities Apple Music has no use for; everything else it asks for is still granted.
    const DENIED_PERMISSIONS = new Set([
        'media', 'geolocation', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'bluetooth',
        'display-capture', 'clipboard-read', 'idle-detection', 'fileSystem', 'window-management',
        'openExternal', 'speaker-selection',
    ]);
    // Sign-in embeds third-party storage from Apple pages, so storage access is granted to Apple
    // origins only and denied everywhere else.
    const isStorage = (perm) => perm === 'storage-access' || perm === 'top-level-storage-access';
    s.setPermissionRequestHandler((wc, perm, cb) => {
        const deny = DENIED_PERMISSIONS.has(perm) || (isStorage(perm) && !_navigationAllowed(wc?.getURL()));
        if (deny) console.warn(`[Adam] denied permission request: ${perm}`);
        cb(!deny);
    });
    s.setPermissionCheckHandler((wc, perm, origin) => {
        if (isStorage(perm)) return _navigationAllowed(origin) && _navigationAllowed(wc?.getURL());
        return !DENIED_PERMISSIONS.has(perm);
    });

    // Trust the engine's self-signed loopback cert so <video src="https://127.0.0.1:PORT/…">
    // loads. This lets MV video use a real HTTPS origin → Chrome's native, reliable
    // byte-range seeking (the custom adam-video:// protocol has a Chromium seek bug on
    // Linux, electron#38749). Scoped strictly to 127.0.0.1: every other host falls
    // through to Chromium's default verification (return -3).
    s.setCertificateVerifyProc((request, callback) => {
        if (request.hostname === '127.0.0.1') { callback(0); return; } // trust loopback engine
        callback(-3); // use Chromium's default verification for everything else
    });

    // Proxy adam-video://localhost/<path> → http://127.0.0.1:ENGINE_PORT/<path>.
    // Must be registered on the Apple Music session (not defaultSession) since the
    // BrowserWindow uses persist:apple-music. Range headers pass through so the
    // browser's native byte-range seeking works on cached video replays.
    s.protocol.handle('adam-video', async (request) => {
        try {
            const u = new URL(request.url);
            const engineUrl = `https://127.0.0.1:${ENGINE_PORT}${u.pathname}${u.search}`;

            // For a committed cache file, serve it DIRECTLY from disk with proper
            // Range → 206 handling. Proxying byte ranges through electronNet.fetch
            // mangles Range semantics for <video> (Chrome reports
            // MEDIA_ERR_SRC_NOT_SUPPORTED, code=4) — the engine's 206 does not
            // survive the fetch round-trip. Reading the local file ourselves is the
            // known-good pattern for seekable media over a custom protocol.
            const reqRange = request.headers.get('range');
            if (u.pathname.endsWith('/video-dl')) {
                // Once we know the on-disk faststart path for this session, cache it
                // and serve every subsequent range request straight from disk — no
                // per-request info round-trip to the engine (that latency starves
                // Chrome's buffer during seeking → stalls → PIPELINE_ERROR_READ).
                let cachedPath = _mvPathCache.get(u.pathname);
                if (!cachedPath) {
                    const info = await electronNet.fetch(engineUrl + '-info')
                        .then(r => r.ok ? r.json() : null).catch(e => { console.error(`[adam-video] info fetch err=${e.message}`); return null; });
                    if (info && info.cached && info.path) {
                        cachedPath = info.path;
                        _mvPathCache.set(u.pathname, cachedPath);
                        console.log(`[adam-video] resolved path for ${u.pathname} → ${cachedPath}`);
                    } else {
                        console.log(`[adam-video] not cached yet (preparing) → 503`);
                    }
                }
                if (cachedPath) {
                    return serveLocalMediaRange(cachedPath, reqRange, request.method);
                }
                // Not cached yet → fall through to the streaming proxy (returns 503).
            }

            const headers = {};
            for (const [k, v] of request.headers) headers[k] = v;
            const upstream = await electronNet.fetch(engineUrl, { method: request.method, headers });
            console.log(`[adam-video] proxy upstream status=${upstream.status} ct=${upstream.headers.get('content-type')} cl=${upstream.headers.get('content-length')} cr=${upstream.headers.get('content-range')}`);
            return upstream;
        } catch (e) {
            return new Response(`engine proxy error: ${e.message}`, { status: 502 });
        }
    });

    // The 256 MB cache cap is set at the top of this file, before the session is created.
    s.getCacheSize().then(size =>
        console.log('[Adam] Cache size:', Math.round(size / 1024 / 1024) + ' MB'));

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
    linkSchemes.apply(); // claim the Apple Music schemes the user turned on (none by default)
    if (IS_WIN) {
        winIntegration = createWinIntegration({
            app, getWin: () => win, nativeImage,
            sendCmd: (c) => win?.webContents.send('mpris:cmd', c),
        });
    }
    createWindow();
    if (winIntegration) {
        winIntegration.init();
        win.on('show', () => winIntegration.refresh());
    }
    createTray();

    // Global media key shortcuts — catches Bluetooth AVRCP play/pause/next/prev
    // which arrive as kernel input events (KEY_PLAYPAUSE etc.) regardless of focus.
    const sendMediaCmd = (cmd) => win?.webContents.send('mpris:cmd', cmd);
    const _mkShortcuts = [
        ['MediaPlayPause',    () => sendMediaCmd('playpause')],
        ['MediaNextTrack',    () => sendMediaCmd('next')],
        ['MediaPreviousTrack',() => sendMediaCmd('previous')],
        ['MediaStop',         () => sendMediaCmd('pause')],
    ];
    // Windows routes hardware media keys through the SMTC session (win-integration.mjs); a global
    // shortcut on top would deliver every key press twice and cancel itself out.
    if (!IS_WIN) for (const [key, fn] of _mkShortcuts) {
        if (!globalShortcut.register(key, fn))
            console.warn('[Adam] media key shortcut already taken by another app:', key);
    }

    // Always attempt to start the engine API server.  engine-playback.js checks
    // reachability at startup and silently falls back to the Apple CDN if the
    // engine isn't running, so a missing binary is not a hard failure.
    startEngine();
    ensureFairPlayLibs();

    // Cold-start deep link: if Adam was launched with a URL argument (e.g. from
    // xdg-open or a browser "Open in Adam" prompt), dispatch it after the window
    // is ready. The renderer registers its adam:open listener inside waitForMusicKit,
    // so we defer until ui-ready has fired (listener installed in main.mjs).
    const coldUrl = process.argv.find(isLinkArg);
    if (coldUrl) {
        ipcMain.once('app:ui-ready', () => {
            // Give MusicKit ~2 s to fully initialise after ui-ready before
            // dispatching the navigation so mk.setQueue() has a valid instance.
            setTimeout(() => _dispatchDeepLink(coldUrl), 2000);
        });
    }
});

// Sync-write the encrypted store to disk, cancelling any pending timer.
// Called from before-quit so in-flight IPC writes (resume state, play counts,
// etc.) are not lost when the process exits before the deferred writeFile fires.
function _storeFlushSync() {
    if (_storeFlushTimer) { clearTimeout(_storeFlushTimer); _storeFlushTimer = null; }
    if (!_storeDirty || !_storeCache) return;
    try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        const enc = safeStorage.isEncryptionAvailable();
        const json = JSON.stringify(_storeCache);
        writeFileAtomicSync(STORE_FILE, enc ? safeStorage.encryptString(json) : json);
        _storeDirty = false;
    } catch (_) {}
}

// Stop engine and mark quitting before any window closes so the close handler
// allows the window to actually be destroyed.
app.on('before-quit', (e) => {
    if (isQuitting) return; // prevent re-entry from the app.quit() we call below
    e.preventDefault();
    isQuitting = true;
    // Ask the renderer to flush its in-memory resume state to IPC immediately.
    // We then wait 300ms for the IPC round-trip + store update to land before
    // sync-writing to disk and really quitting.
    try { win?.webContents?.send('app:flush-and-quit'); } catch (_) {}
    globalShortcut.unregisterAll();
    setTimeout(async () => {
        _storeFlushSync();
        // Bound the cookie flush: a stalled promise must not hold the quit open.
        const part = session.fromPartition('persist:apple-music');
        part.flushStorageData();
        await Promise.race([part.cookies.flushStore().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
        await stopEngine();
        if (tray) { tray.destroy(); tray = null; }
        // Cleanup is complete: the web player's unload handlers must not be able to veto the quit
        // and leave a window open with a stopped engine.
        app.exit(0);
    }, 300);
});

// window-all-closed fires only when all windows are destroyed (not hidden).
// On Linux Electron would quit automatically here, but we override it so the
// hidden-window tray pattern works. The actual quit is already in progress
// (triggered by app.quit() from the tray or SIGINT), so do nothing.
app.on('window-all-closed', () => {});

// Ctrl+C in the launch terminal sends SIGINT. Without this handler Electron
// ignores it (the window-close override keeps the process alive).
// SIGINT from terminal — before-quit will call stopEngine().
process.on('SIGINT', () => { app.quit(); });
