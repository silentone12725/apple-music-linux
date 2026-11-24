// Launch at login (Settings → Startup). Off by default; "start minimised" only matters while it is on.
//   Linux          one of three mechanisms, chosen for the session (session.mjs): an XDG autostart entry, a systemd user
//                  unit, or a marked block in the compositor's config. Electron has no login-item API there.
//   Windows (exe)  app.setLoginItemSettings, the per-user Run key (shows in Task Manager → Startup).
//   Windows (MSIX) a Startup-folder shortcut to the package's app execution alias: a packaged app's Run key writes
//                  never reach Windows (electron/electron#42016), and an alias is how arguments reach a package.
// "Start minimised" adds --hidden: the window is not shown and Adam waits in the tray (main.mjs, _startHidden).
// Pure helpers and a manager with injected dependencies, unit-tested in test/startup.test.mjs.
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, renameSync, realpathSync } from 'fs';
import { detectSession, execToArgs, CONFIG_PROFILES, putConfigBlock, removeConfigBlock, readConfigBlock, hasConfigBlock, chooseMechanism } from './session.mjs';

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

// ── systemd user unit ────────────────────────────────────────────────────────

export const UNIT_NAME = 'adam-autostart.service';

export function unitFile(env = process.env, home = os.homedir()) {
    return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', UNIT_NAME);
}

// One argument in a unit's ExecStart=: quoted when it needs it, with % and $ doubled (systemd expands both).
export function systemdArg(a) {
    const e = a.replace(/%/g, '%%').replace(/\$/g, '$$$$');
    return /[\s"'\\]/.test(e) || e === '' ? `"${e.replace(/(["\\])/g, '\\$1')}"` : e;
}

export function unitText(args) {
    return [
        '[Unit]',
        'Description=Adam (Apple Music) at login',
        'After=graphical-session.target',
        'PartOf=graphical-session.target',
        // The display may not be in the user manager's environment the instant the target is reached: retry briefly.
        'StartLimitIntervalSec=60',
        'StartLimitBurst=3',
        '',
        '[Service]',
        `ExecStart=${args.map(systemdArg).join(' ')}`,
        'Restart=on-failure',
        'RestartSec=5',
        '',
        '[Install]',
        'WantedBy=graphical-session.target',
        '',
    ].join('\n');
}

export function parseUnit(text) {
    const m = /^ExecStart=(.*)$/m.exec(text);
    if (!m) return null;
    const line = m[1].trim();
    const hidden = line.endsWith(' ' + START_HIDDEN_ARG);
    return { exec: hidden ? line.slice(0, -START_HIDDEN_ARG.length - 1) : line, hidden };
}

// ── manager ──────────────────────────────────────────────────────────────────

const defaultRun = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
};

// A symlinked config (dotfiles kept in a repo) is written through the link, so the repo's copy changes with it.
function writeThrough(f, text) {
    let target = f;
    try { target = realpathSync(f); } catch { /* not there */ }
    writeFileSync(target + '.adam-tmp', text);
    renameSync(target + '.adam-tmp', target);
}

export function createStartupManager({
    app, shell, loadPrefs, savePrefs,
    plat = process.platform, env = process.env, home = os.homedir(),
    execPath = process.execPath, defaultApp = !!process.defaultApp, argv1 = process.argv[1] || '',
    isMsix = !!process.windowsStore, run = defaultRun,
}) {
    const prefs = () => {
        const p = loadPrefs();
        return { launchAtLogin: p.launchAtLogin === true, startMinimized: p.startMinimized === true };
    };

    // ---- Linux
    const linuxFile = () => autostartFile(env, home);
    const linuxCommand = () => linuxExec({ env, execPath, defaultApp, argv1, installed: installedExec(env, home) });
    const cfgHome = () => env.XDG_CONFIG_HOME || path.join(home, '.config');

    function systemdInfo() {
        const active = (t) => run('systemctl', ['--user', 'is-active', t]);
        const g = active('graphical-session.target');
        const available = !g.error && /^(active|inactive|activating|deactivating|failed)$/.test(g.stdout.trim());
        return { available, graphicalTarget: available && g.stdout.trim() === 'active', xdgTarget: available && active('xdg-desktop-autostart.target').stdout.trim() === 'active' };
    }
    // The session's config file that exists and may be edited ('' when there is none).
    function configFor(session) {
        const profile = CONFIG_PROFILES[session.id];
        if (!profile) return { profile: null, file: '' };
        const abs = (f) => (f.startsWith('~/') ? path.join(home, f.slice(2)) : path.join(cfgHome(), f));
        if ((profile.refuseIfPresent || []).some((f) => existsSync(abs(f)))) return { profile, file: '' };
        return { profile, file: profile.files.map(abs).find((f) => existsSync(f)) || '' };
    }
    function plan() {
        const session = detectSession(env);
        const { profile, file } = configFor(session);
        return { session, profile, file, ...chooseMechanism({ session, systemd: systemdInfo(), configFile: file, profile }) };
    }

    const xdgState = () => { try { return existsSync(linuxFile()) ? parseAutostart(readFileSync(linuxFile(), 'utf8')) : null; } catch { return null; } };
    const unitState = () => {
        try {
            if (!existsSync(unitFile(env, home))) return null;
            if (run('systemctl', ['--user', 'is-enabled', UNIT_NAME]).stdout.trim() !== 'enabled') return null;
            return parseUnit(readFileSync(unitFile(env, home), 'utf8'));
        } catch { return null; }
    };
    const configState = (pl) => {
        try {
            if (!pl.profile || !pl.file) return null;
            const line = readConfigBlock(readFileSync(pl.file, 'utf8'), pl.profile);
            return line ? { exec: line, hidden: /\s--hidden['"]?(?:\s*&)?\s*$/.test(line) || line.includes('"--hidden"') } : null;
        } catch { return null; }
    };

    function removeXdg() { try { unlinkSync(linuxFile()); } catch { /* already gone */ } }
    function removeUnit() {
        if (!existsSync(unitFile(env, home))) return;
        run('systemctl', ['--user', 'disable', UNIT_NAME]);
        try { unlinkSync(unitFile(env, home)); } catch { /* already gone */ }
        run('systemctl', ['--user', 'daemon-reload']);
    }
    function removeConfig(pl) {
        if (!pl.profile || !pl.file) return;
        try {
            const text = readFileSync(pl.file, 'utf8');
            if (hasConfigBlock(text, pl.profile)) writeThrough(pl.file, removeConfigBlock(text, pl.profile));
        } catch { /* leave the file alone */ }
    }

    function linuxWrite(on, hidden, pl = plan()) {
        if (!on) { removeXdg(); removeUnit(); removeConfig(pl); return; }
        const args = [...execToArgs(linuxCommand()), ...(hidden ? [START_HIDDEN_ARG] : [])];
        if (pl.mechanism === 'xdg') {
            writeAtomic(linuxFile(), autostartEntry(linuxCommand(), hidden));
            removeUnit(); removeConfig(pl);
        } else if (pl.mechanism === 'systemd') {
            writeAtomic(unitFile(env, home), unitText(args));
            run('systemctl', ['--user', 'daemon-reload']);
            const r = run('systemctl', ['--user', 'enable', UNIT_NAME]);
            if (r.status !== 0) throw new Error(`systemctl enable failed: ${(r.stderr || r.stdout).trim() || 'unknown error'}`);
            removeXdg(); removeConfig(pl);
        } else {
            writeThrough(pl.file, putConfigBlock(readFileSync(pl.file, 'utf8'), pl.profile, args));
            removeXdg(); removeUnit();
        }
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
    function current(pl) {
        if (plat === 'linux') return xdgState() || unitState() || configState(pl || plan());
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
        if (reason) return { supported: false, reason, launchAtLogin: false, startMinimized: p.startMinimized, mechanism: '', note: '' };
        const pl = plat === 'linux' ? plan() : null;
        const cur = current(pl);
        // The OS is the truth for "on": the user can remove the entry outside Adam (Task Manager, the desktop's settings).
        return {
            supported: true, reason: '', launchAtLogin: !!cur, startMinimized: cur ? cur.hidden : p.startMinimized,
            mechanism: pl ? pl.mechanism : (isMsix ? 'startup-shortcut' : 'run-key'), note: pl ? pl.reason : '',
        };
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

    // On start (Linux): an entry that points at a moved or updated executable, or sits in a mechanism the session no
    // longer uses, is rewritten. Never creates one, and never re-enables an entry the user switched off.
    function apply() {
        if (plat !== 'linux' || unsupportedReason()) return;
        const pl = plan();
        const cur = current(pl);
        if (!cur) return;
        const via = xdgState() ? 'xdg' : unitState() ? 'systemd' : 'config';
        const want = via === 'xdg' ? linuxCommand() : null;
        const stale = via === 'xdg' ? cur.exec !== want : via === 'systemd' ? cur.exec !== execToArgs(linuxCommand()).map(systemdArg).join(' ') : false;
        if (via !== pl.mechanism || stale) { try { linuxWrite(true, cur.hidden, pl); } catch { /* leave it */ } }
    }

    return { get, set, apply };
}
