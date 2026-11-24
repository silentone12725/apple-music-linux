// Launch at login: Linux autostart entry, Windows Run key, MSIX Startup shortcut.
//   node --test electron/test/startup.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    autostartFile, stripFieldCodes, quoteExecArg, installedExec, linuxExec, autostartEntry, parseAutostart,
    createStartupManager, START_HIDDEN_ARG, MSIX_ALIAS,
} from '../startup.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'adam-startup-'));
const memPrefs = (initial = {}) => { let p = { ...initial }; return { loadPrefs: () => ({ ...p }), savePrefs: (n) => { p = { ...n }; }, peek: () => p }; };

test('the autostart entry lives in the XDG config dir', () => {
    assert.equal(autostartFile({}, '/home/u'), '/home/u/.config/autostart/adam.desktop');
    assert.equal(autostartFile({ XDG_CONFIG_HOME: '/cfg' }, '/home/u'), '/cfg/autostart/adam.desktop');
});

test('field codes are dropped and awkward arguments quoted', () => {
    assert.equal(stripFieldCodes('/opt/adam/adam --no-sandbox %u'), '/opt/adam/adam --no-sandbox');
    assert.equal(stripFieldCodes('adam %U %f'), 'adam');
    assert.equal(quoteExecArg('/opt/adam/adam'), '/opt/adam/adam');
    assert.equal(quoteExecArg('/home/u/My Apps/Adam.AppImage'), '"/home/u/My Apps/Adam.AppImage"');
    assert.equal(quoteExecArg('/p/$x"y'), '"/p/\\$x\\"y"');
});

test('the installer\'s Exec line is reused, minus field codes', () => {
    const files = { '/d/applications/adam.desktop': '[Desktop Entry]\nName=Adam\nExec=/home/u/.local/share/adam/adam --no-sandbox %u\n' };
    const read = (f) => { if (f in files) return files[f]; throw new Error('ENOENT'); };
    assert.equal(installedExec({ XDG_DATA_HOME: '/d' }, '/home/u', read), '/home/u/.local/share/adam/adam --no-sandbox');
    assert.equal(installedExec({ XDG_DATA_HOME: '/nowhere' }, '/home/u', () => { throw new Error('x'); }), '');
});

test('how Adam is started from autostart: AppImage, dev run, installer command, then this executable', () => {
    assert.equal(linuxExec({ env: { APPIMAGE: '/a/Adam.AppImage' }, installed: '/i/adam' }), '/a/Adam.AppImage');
    assert.equal(linuxExec({ env: {}, execPath: '/e/electron', defaultApp: true, argv1: '/repo/electron', installed: '/i/adam' }), '/e/electron /repo/electron');
    assert.equal(linuxExec({ env: {}, execPath: '/e/adam', installed: '/i/adam --no-sandbox' }), '/i/adam --no-sandbox');
    assert.equal(linuxExec({ env: {}, execPath: '/e/adam' }), '/e/adam');
});

test('an autostart entry round-trips, with and without --hidden', () => {
    for (const hidden of [false, true]) {
        const text = autostartEntry('/i/adam --no-sandbox', hidden);
        assert.match(text, /^\[Desktop Entry\]\nType=Application\nName=Adam\n/);
        assert.match(text, /X-GNOME-Autostart-enabled=true/);
        assert.deepEqual(parseAutostart(text), { exec: '/i/adam --no-sandbox', hidden });
    }
    assert.equal(parseAutostart('[Desktop Entry]\nName=x\n'), null);
});

function linuxManager(extra = {}) {
    const home = tmp();
    const prefs = memPrefs(extra.prefs);
    const env = { XDG_CONFIG_HOME: path.join(home, 'cfg'), XDG_DATA_HOME: path.join(home, 'data'), ...extra.env };
    const m = createStartupManager({ app: {}, shell: {}, ...prefs, plat: 'linux', env, home, execPath: '/opt/adam/adam' });
    return { m, home, prefs, file: autostartFile(env, home), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('Linux: both options start off and nothing is written', () => {
    const t = linuxManager();
    assert.deepEqual(t.m.get(), { supported: true, reason: '', launchAtLogin: false, startMinimized: false });
    assert.equal(existsSync(t.file), false);
    t.cleanup();
});

test('Linux: turning launch at login on and off writes and removes the entry', () => {
    const t = linuxManager();
    assert.equal(t.m.set('launchAtLogin', true).launchAtLogin, true);
    assert.deepEqual(parseAutostart(readFileSync(t.file, 'utf8')), { exec: '/opt/adam/adam', hidden: false });
    assert.equal(t.m.set('launchAtLogin', false).launchAtLogin, false);
    assert.equal(existsSync(t.file), false);
    t.cleanup();
});

test('Linux: start minimised adds --hidden to an existing entry and is remembered while launch at login is off', () => {
    const t = linuxManager();
    assert.equal(t.m.set('startMinimized', true).startMinimized, true);
    assert.equal(existsSync(t.file), false); // no entry to change yet
    t.m.set('launchAtLogin', true);
    assert.equal(parseAutostart(readFileSync(t.file, 'utf8')).hidden, true);
    t.m.set('startMinimized', false);
    assert.equal(parseAutostart(readFileSync(t.file, 'utf8')).hidden, false);
    assert.equal(t.prefs.peek().startMinimized, false);
    t.cleanup();
});

test('Linux: an entry removed outside Adam shows as off', () => {
    const t = linuxManager();
    t.m.set('launchAtLogin', true);
    rmSync(t.file);
    assert.equal(t.m.get().launchAtLogin, false);
    t.cleanup();
});

test('Linux: the installer\'s command (with --no-sandbox) is used when it exists', () => {
    const t = linuxManager();
    const dir = path.join(t.home, 'data', 'applications');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'adam.desktop'), '[Desktop Entry]\nExec=/home/u/.local/share/adam/adam --no-sandbox %u\n');
    t.m.set('launchAtLogin', true);
    assert.equal(parseAutostart(readFileSync(t.file, 'utf8')).exec, '/home/u/.local/share/adam/adam --no-sandbox');
    t.cleanup();
});

test('Linux: start-up rewrites an entry that points at a moved executable, but never creates one', () => {
    const t = linuxManager();
    t.m.apply();
    assert.equal(existsSync(t.file), false);
    mkdirSync(path.dirname(t.file), { recursive: true });
    writeFileSync(t.file, autostartEntry('/old/place/adam', true));
    t.m.apply();
    assert.deepEqual(parseAutostart(readFileSync(t.file, 'utf8')), { exec: '/opt/adam/adam', hidden: true });
    t.cleanup();
});

test('Linux: the Flatpak build reports it cannot do this and writes nothing', () => {
    const t = linuxManager({ env: { FLATPAK_ID: 'io.github.silentone12725.Adam' } });
    const s = t.m.get();
    assert.equal(s.supported, false);
    assert.match(s.reason, /Flatpak/);
    assert.equal(t.m.set('launchAtLogin', true).supported, false);
    assert.equal(existsSync(t.file), false);
    t.cleanup();
});

test('only the two known options, with booleans, are accepted', () => {
    const t = linuxManager();
    assert.throws(() => t.m.set('launchAtLogin', 'yes'));
    assert.throws(() => t.m.set('somethingElse', true));
    assert.throws(() => t.m.set('__proto__', true));
    t.cleanup();
});

function winApp({ packaged = true } = {}) {
    const items = []; // { args:[...] }
    const matches = (it, args) => JSON.stringify(it.args) === JSON.stringify(args || []);
    return {
        items, isPackaged: packaged,
        setLoginItemSettings: ({ openAtLogin, args }) => { items.length = 0; if (openAtLogin) items.push({ args: args || [] }); },
        getLoginItemSettings: ({ args } = {}) => ({ openAtLogin: items.some((it) => matches(it, args)) }),
    };
}

test('Windows exe: the Run key entry is created with --hidden only when asked', () => {
    const app = winApp();
    const prefs = memPrefs();
    const m = createStartupManager({ app, shell: {}, ...prefs, plat: 'win32', env: {}, isMsix: false });
    assert.equal(m.get().launchAtLogin, false);
    m.set('launchAtLogin', true);
    assert.deepEqual(app.items, [{ args: [] }]);
    m.set('startMinimized', true);
    assert.deepEqual(app.items, [{ args: [START_HIDDEN_ARG] }]);
    assert.deepEqual(m.get(), { supported: true, reason: '', launchAtLogin: true, startMinimized: true });
    m.set('launchAtLogin', false);
    assert.deepEqual(app.items, []);
    assert.equal(m.get().launchAtLogin, false);
});

test('Windows: an unpackaged dev run is not offered (it would register electron.exe itself)', () => {
    const app = winApp({ packaged: false });
    const m = createStartupManager({ app, shell: {}, ...memPrefs(), plat: 'win32', env: {}, isMsix: false });
    assert.equal(m.get().supported, false);
    m.set('launchAtLogin', true);
    assert.deepEqual(app.items, []);
});

test('Windows MSIX: a Startup-folder shortcut to the app execution alias', () => {
    const dir = tmp();
    const env = { APPDATA: path.join(dir, 'Roaming'), LOCALAPPDATA: path.join(dir, 'Local') };
    const shell = {
        writeShortcutLink: (file, op, opts) => { assert.equal(op, 'create'); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(opts)); return true; },
        readShortcutLink: (file) => JSON.parse(readFileSync(file, 'utf8')),
    };
    const m = createStartupManager({ app: winApp(), shell, ...memPrefs(), plat: 'win32', env, isMsix: true });
    const link = path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Adam.lnk');
    assert.equal(m.get().launchAtLogin, false);
    m.set('launchAtLogin', true);
    assert.deepEqual(JSON.parse(readFileSync(link, 'utf8')), { target: path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', MSIX_ALIAS), args: '', description: 'Adam' });
    m.set('startMinimized', true);
    assert.equal(JSON.parse(readFileSync(link, 'utf8')).args, START_HIDDEN_ARG);
    assert.deepEqual(m.get(), { supported: true, reason: '', launchAtLogin: true, startMinimized: true });
    m.set('launchAtLogin', false);
    assert.equal(existsSync(link), false);
    rmSync(dir, { recursive: true, force: true });
});
