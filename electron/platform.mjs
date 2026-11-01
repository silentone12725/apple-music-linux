// Cross-platform helpers for main.mjs. Everything platform-dependent that can be a pure
// function takes `plat` explicitly so it is unit-testable from any OS.
import path from 'path';
const nodePath = path;
import os from 'os';
import net from 'net';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync } from 'fs';

export const IS_WIN = process.platform === 'win32';
export const IS_LINUX = process.platform === 'linux';

// Directory that holds the `adam` config folder. Windows: %APPDATA%. Inside a
// Flatpak the real ~/.config is invisible and XDG_CONFIG_HOME is the app's own directory.
export function configRoot(plat = process.platform, env = process.env, home = os.homedir()) {
    if (plat === 'win32') return env.APPDATA || path.win32.join(home, 'AppData', 'Roaming');
    return env.FLATPAK_ID && env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config');
}

export const engineFileName = (plat = process.platform) => (plat === 'win32' ? 'engine.exe' : 'engine');

// Environment additions that let the engine find its bundled native libraries.
// Linux uses LD_LIBRARY_PATH; Windows resolves DLLs through PATH (and the exe's own folder).
export function engineLibEnv({ plat = process.platform, env = process.env, vlcDir, ffDir, resDir, hasVlc, hasFfmpeg }) {
    const sep = plat === 'win32' ? ';' : ':';
    const path = plat === 'win32' ? nodePath.win32 : nodePath.posix; // the target's separators, not the host's
    const out = {};
    if (plat === 'win32') {
        const dirs = [];
        if (hasVlc) dirs.push(vlcDir);
        if (hasFfmpeg) dirs.push(path.join(ffDir, 'bin'));
        if (resDir) dirs.push(resDir);
        if (hasVlc) out.VLC_PLUGIN_PATH = path.join(vlcDir, 'plugins');
        out.PATH = [...dirs, env.PATH || env.Path].filter(Boolean).join(sep);
        return out;
    }
    if (hasVlc) {
        out.LD_LIBRARY_PATH = [vlcDir, path.join(ffDir, 'lib'), env.LD_LIBRARY_PATH].filter(Boolean).join(sep);
        out.VLC_PLUGIN_PATH = path.join(vlcDir, 'plugins');
    }
    if (hasFfmpeg) out.PATH = [path.join(ffDir, 'bin'), env.PATH].filter(Boolean).join(sep);
    return out;
}

// Discord Rich Presence IPC endpoints: named pipes on Windows, Unix sockets elsewhere.
export function discordIpcPaths(plat = process.platform, env = process.env) {
    const paths = [];
    if (plat === 'win32') {
        for (let i = 0; i < 10; i++) paths.push(`\\\\.\\pipe\\discord-ipc-${i}`);
        return paths;
    }
    const bases = [env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, '/tmp'].filter(Boolean);
    const subdirs = ['', 'snap.discord/', 'app/com.discordapp.Discord/', 'app/com.discordapp.DiscordCanary/'];
    for (const base of bases)
        for (const sub of subdirs)
            for (let i = 0; i < 10; i++) paths.push(path.posix.join(base, sub + `discord-ipc-${i}`));
    return paths;
}

// pid listening on a TCP port from `netstat -ano` output (Windows).
export function parseNetstatListeningPid(out, port) {
    for (const line of String(out).split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        // TCP  127.0.0.1:20025  0.0.0.0:0  LISTENING  1234
        if (f.length >= 5 && f[0] === 'TCP' && f[3] === 'LISTENING' && f[1].endsWith(':' + port)) {
            const pid = parseInt(f[4], 10);
            if (pid > 0) return pid;
        }
    }
    return 0;
}

// pid listening on a TCP port from `ss -tlnpH` output (Linux).
export function parseSsListeningPid(out) {
    const m = String(out).match(/pid=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

function run(cmd, args, timeout) {
    return new Promise(resolve => {
        execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true },
            (err, stdout) => resolve(err ? '' : stdout));
    });
}

export async function listeningPid(port, plat = process.platform) {
    if (plat === 'win32') return parseNetstatListeningPid(await run('netstat', ['-ano', '-p', 'tcp'], 4000), port);
    return parseSsListeningPid(await run('ss', ['-tlnpH', `sport = :${port}`], 2000));
}

// True when nothing accepts connections on the loopback port. Works on every OS.
export function isPortFree(port, host = '127.0.0.1') {
    return new Promise(resolve => {
        const s = net.createServer();
        s.once('error', () => resolve(false));
        s.once('listening', () => s.close(() => resolve(true)));
        s.listen(port, host);
    });
}

// A YAML double-quoted scalar. JSON string syntax is a subset of it, so backslashes in Windows
// paths and any quotes are escaped correctly.
export const yamlStr = (v) => JSON.stringify(String(v));

// ── Migration from the app's earlier names ───────────────────────────────────

const LEGACY_DIR_NAMES = ['apple-music-linux', 'aml'];

function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// Move src into dst without overwriting: rename the whole directory when dst is absent,
// otherwise entry by entry (recursing into directories present on both sides).
function mergeDir(src, dst) {
    if (!isDir(src)) return;
    if (!existsSync(dst)) {
        try { mkdirSync(path.dirname(dst), { recursive: true }); renameSync(src, dst); return; } catch { /* fall through */ }
    }
    try { mkdirSync(dst, { recursive: true, mode: 0o700 }); } catch { return; }
    let names = [];
    try { names = readdirSync(src); } catch { return; }
    for (const n of names) {
        const s = path.join(src, n), d = path.join(dst, n);
        if (!existsSync(d)) { try { renameSync(s, d); } catch { /* leave it */ } }
        else if (isDir(s) && isDir(d)) mergeDir(s, d);
    }
    try { rmdirSync(src); } catch { /* not empty: something could not move */ }
}

// Fold the config directories earlier versions used into `<root>/<name>`, and give the
// `aml-*` files inside it their new `adam-*` names.
export function migrateLegacyConfig(root, name = 'adam', legacy = LEGACY_DIR_NAMES) {
    const dir = path.join(root, name);
    for (const old of legacy) mergeDir(path.join(root, old), dir);
    let names = [];
    try { names = readdirSync(dir); } catch { return dir; }
    for (const n of names) {
        if (!/^aml-/.test(n)) continue;
        const to = path.join(dir, 'adam-' + n.slice(4));
        if (!existsSync(to)) { try { renameSync(path.join(dir, n), to); } catch { /* ignore */ } }
    }
    return dir;
}

// Keys the encrypted store used before the rename: aml_x -> adam_x.
export function migrateStoreKeys(store) {
    let changed = false;
    for (const k of Object.keys(store)) {
        if (!k.startsWith('aml_')) continue;
        const n = 'adam_' + k.slice(4);
        if (!(n in store)) store[n] = store[k];
        delete store[k];
        changed = true;
    }
    return changed;
}

// Is there a D-Bus session bus to talk to? Having DBUS_SESSION_BUS_ADDRESS or XDG_RUNTIME_DIR set is not
// enough (sandboxes and minimal sessions set them with no bus behind them), and connecting anyway made
// the MPRIS service retry forever. Unix socket paths are checked for existence; abstract and non-unix
// transports cannot be checked from here, so they count as available.
export function hasSessionBus(env = process.env, exists = existsSync) {
    const addr = env.DBUS_SESSION_BUS_ADDRESS;
    if (addr) {
        for (const entry of addr.split(';')) {
            const m = /^unix:(?:[^,]*,)*path=([^,;]+)/.exec(entry);
            if (m) { if (exists(decodeURIComponent(m[1]))) return true; continue; }
            if (/^unix:/.test(entry)) return true; // abstract=... or runtime=...: not checkable
            if (entry.trim()) return true;         // tcp:, nonce-tcp:, ...
        }
        return false;
    }
    return !!env.XDG_RUNTIME_DIR && exists(path.posix.join(env.XDG_RUNTIME_DIR, 'bus'));
}

// Delay before the next MPRIS reconnect: 2 s, doubling to a 60 s ceiling.
export const mprisRetryDelay = (failures) => Math.min(2000 * 2 ** Math.max(0, failures - 1), 60000);
