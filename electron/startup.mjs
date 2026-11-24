// Launch at login (Settings → Startup). Off by default; "start minimised" only matters while it is on.
//   Linux          an XDG autostart entry, ~/.config/autostart/adam.desktop. Electron has no login-item API there.
//   Windows (exe)  app.setLoginItemSettings, the per-user Run key (shows in Task Manager → Startup).
//   Windows (MSIX) a Startup-folder shortcut to the package's app execution alias: a packaged app's Run key writes
//                  never reach Windows (electron/electron#42016), and an alias is how arguments reach a package.
// "Start minimised" adds --hidden: the window is not shown and Adam waits in the tray (main.mjs, _startHidden).
// Pure helpers and a manager with injected dependencies, unit-tested in test/startup.test.mjs.
import path from 'path';
import os from 'os';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'fs';

export const START_HIDDEN_ARG = '--hidden';
export const MSIX_ALIAS = 'adam.exe'; // uap3:AppExecutionAlias in the MSIX manifest (scripts/build-msix.ps1)
const KEYS = ['launchAtLogin', 'startMinimized'];

// ── Linux ────────────────────────────────────────────────────────────────────

export function autostartFile(env = process.env, home = os.homedir()) {
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'adam.desktop');
}

// Field codes (%u, %F …) stand for files and URLs: an autostart entry has none.
export function stripFieldCodes(exec) {
    return String(exec).replace(/\s%[a-zA-Z]/g, '').trim();
}

// One argument of an Exec line, quoted as the Desktop Entry spec asks when it needs to be.
export function quoteExecArg(arg) {
    if (!/[\s"'\\><~|&;$*?#()`]/.test(arg)) return arg;
    return `"${arg.replace(/(["`$\\])/g, '\\$1')}"`;
}

// The Exec line of the desktop entry the installer wrote, if any (it carries the right flags, e.g. --no-sandbox).
export function installedExec(env = process.env, home = os.homedir(), read = (f) => readFileSync(f, 'utf8')) {
    const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const dirs = [path.join(dataHome, 'applications'), '/usr/local/share/applications', '/usr/share/applications'];
    for (const dir of dirs) {
        try {
            const m = /^Exec=(.*)$/m.exec(read(path.join(dir, 'adam.desktop')));
            if (m) return stripFieldCodes(m[1]);
        } catch { /* not there */ }
    }
    return '';
}

// How to start Adam from autostart: the AppImage itself, the installer's command, or this very executable.
export function linuxExec({ env = process.env, execPath = process.execPath, defaultApp = false, argv1 = '', installed = '' }) {
    if (env.APPIMAGE) return quoteExecArg(env.APPIMAGE);
    if (defaultApp && argv1) return [quoteExecArg(execPath), quoteExecArg(path.resolve(argv1))].join(' ');
    return installed || quoteExecArg(execPath);
}

export function autostartEntry(exec, hidden) {
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Adam',
        'Comment=Apple Music desktop client',
        `Exec=${exec}${hidden ? ' ' + START_HIDDEN_ARG : ''}`,
        'Icon=adam',
        'Terminal=false',
        'X-GNOME-Autostart-enabled=true',
        '',
    ].join('\n');
}

// The Exec line and --hidden flag of an existing entry.
export function parseAutostart(text) {
    const m = /^Exec=(.*)$/m.exec(text);
    if (!m) return null;
    const line = m[1].trim();
    const hidden = line.endsWith(' ' + START_HIDDEN_ARG);
    return { exec: hidden ? line.slice(0, -START_HIDDEN_ARG.length - 1) : line, hidden };
}

function writeAtomic(file, text) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file + '.adam-tmp', text);
    renameSync(file + '.adam-tmp', file);
}

// ── manager ──────────────────────────────────────────────────────────────────

export function createStartupManager({
    app, shell, loadPrefs, savePrefs,
    plat = process.platform, env = process.env, home = os.homedir(),
    execPath = process.execPath, defaultApp = !!process.defaultApp, argv1 = process.argv[1] || '',
    isMsix = !!process.windowsStore,
}) {
    const prefs = () => {
        const p = loadPrefs();
        return { launchAtLogin: p.launchAtLogin === true, startMinimized: p.startMinimized === true };
    };

    // ---- Linux
    const linuxFile = () => autostartFile(env, home);
    const linuxCommand = () => linuxExec({ env, execPath, defaultApp, argv1, installed: installedExec(env, home) });
    const linuxState = () => {
        try { return existsSync(linuxFile()) ? parseAutostart(readFileSync(linuxFile(), 'utf8')) : null; } catch { return null; }
    };
    function linuxWrite(on, hidden) {
        if (!on) { try { unlinkSync(linuxFile()); } catch { /* already gone */ } return; }
        writeAtomic(linuxFile(), autostartEntry(linuxCommand(), hidden));
    }

    // ---- Windows, exe installer
    const winArgs = (hidden) => (hidden ? [START_HIDDEN_ARG] : []);

    // ---- Windows, MSIX
    const msixLink = () => path.join(env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Adam.lnk');
    const msixAlias = () => path.join(env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', MSIX_ALIAS);
    function msixState() {
        try {
            if (!existsSync(msixLink())) return null;
            const l = shell.readShortcutLink(msixLink());
            return { hidden: String(l.args || '').includes(START_HIDDEN_ARG) };
        } catch { return null; }
    }
    function msixWrite(on, hidden) {
        if (!on) { try { unlinkSync(msixLink()); } catch { /* already gone */ } return; }
        mkdirSync(path.dirname(msixLink()), { recursive: true });
        shell.writeShortcutLink(msixLink(), 'create', { target: msixAlias(), args: hidden ? START_HIDDEN_ARG : '', description: 'Adam' });
    }

    // What the OS holds right now; null when launch at login is off.
    function current() {
        if (plat === 'linux') return linuxState();
        if (plat === 'win32' && isMsix) return msixState();
        if (plat === 'win32') {
            const on = app.getLoginItemSettings({ args: winArgs(true) }).openAtLogin || app.getLoginItemSettings({ args: winArgs(false) }).openAtLogin;
            if (!on) return null;
            return { hidden: app.getLoginItemSettings({ args: winArgs(true) }).openAtLogin };
        }
        return null;
    }

    // Why this build cannot do it (shown in Settings), or '' when it can.
    function unsupportedReason() {
        if (plat === 'linux') return env.FLATPAK_ID ? 'Not available in the Flatpak build: use the system\'s background-apps settings.' : '';
        if (plat === 'win32') return (!isMsix && !app.isPackaged) ? 'Available in the installed app.' : '';
        return 'Not supported on this system.';
    }

    function write(on, hidden) {
        if (plat === 'linux') return linuxWrite(on, hidden);
        if (plat === 'win32' && isMsix) return msixWrite(on, hidden);
        if (plat === 'win32') { app.setLoginItemSettings({ openAtLogin: on, args: winArgs(hidden) }); return; }
    }

    function get() {
        const reason = unsupportedReason();
        const p = prefs();
        if (reason) return { supported: false, reason, launchAtLogin: false, startMinimized: p.startMinimized };
        const cur = current();
        // The OS is the truth for "on": the user can remove the entry outside Adam (Task Manager, the desktop's settings).
        return { supported: true, reason: '', launchAtLogin: !!cur, startMinimized: cur ? cur.hidden : p.startMinimized };
    }

    function set(key, value) {
        if (!KEYS.includes(key) || typeof value !== 'boolean') throw new Error('invalid startup setting');
        if (unsupportedReason()) return get();
        const p = loadPrefs();
        p[key] = value;
        savePrefs(p);
        const state = prefs();
        // "Start minimised" is remembered even while launch at login is off; it only changes the entry when one exists.
        if (key === 'launchAtLogin') write(value, state.startMinimized);
        else if (current()) write(true, state.startMinimized);
        return get();
    }

    // On start: an entry that points at a moved or updated executable is rewritten (Linux). Never creates one, and
    // never re-enables an entry the user switched off in Task Manager.
    function apply() {
        if (plat !== 'linux' || unsupportedReason()) return;
        const cur = linuxState();
        if (!cur) return;
        const want = linuxCommand();
        if (cur.exec !== want) { try { linuxWrite(true, cur.hidden); } catch { /* leave it */ } }
    }

    return { get, set, apply };
}
