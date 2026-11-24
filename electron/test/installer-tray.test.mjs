// The installer's optional system-tray step (scripts/installer-header.sh), run for real with stub dbus-send and sudo.
//   node --test electron/test/installer-tray.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = readFileSync(new URL('../../scripts/installer-header.sh', import.meta.url), 'utf8');
const block = script.slice(script.indexOf('# >>> tray functions'), script.indexOf('# <<< tray functions'));

// watcher: 'true' | 'false' | 'broken' | 'absent' (no dbus-send at all)
function run({ watcher, desktop = '', session = 'wayland', osRelease = 'ID=arch\n', tray = 'ask', tty = false, answer = '', sudoExit = 0 }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'adam-installer-'));
    const bin = path.join(dir, 'bin'); const log = path.join(dir, 'calls.log');
    spawnSync('mkdir', ['-p', bin]);
    const stub = (name, body) => { writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
    if (watcher !== 'absent') stub('dbus-send', watcher === 'broken' ? 'exit 1' : `echo "method return time=1"; echo "   boolean ${watcher}"`);
    stub('sudo', `echo "sudo $*" >> "${log}"; exit ${sudoExit}`); // the install commands run through `sh -c`, so give them a sudo that only records
    stub('gnome-extensions', `echo "gnome-extensions $*" >> "${log}"`);
    writeFileSync(path.join(dir, 'os-release'), osRelease);
    // `[ -t 0 ]` is true only on a terminal, so the interactive path is driven through `script`-less stdin: ADAM_TEST_TTY
    const harness = `TRAY=${tray}\n${block.replace(/\[ -t 0 \]/g, '[ "$ADAM_TEST_TTY" = 1 ]')}\ntray_offer\n`;
    writeFileSync(path.join(dir, 'h.sh'), harness);
    const r = spawnSync('sh', [path.join(dir, 'h.sh')], {
        encoding: 'utf8', input: answer + '\n',
        env: { PATH: `${bin}:/usr/bin:/bin`, XDG_CURRENT_DESKTOP: desktop, XDG_SESSION_TYPE: session, ADAM_OS_RELEASE: path.join(dir, 'os-release'), ADAM_TEST_TTY: tty ? '1' : '0', HOME: dir },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    rmSync(dir, { recursive: true, force: true });
    return { out: r.stdout, err: r.stderr, status: r.status, calls };
}

test('a tray host present, unknown, or a desktop with its own panel tray: nothing said, nothing run', () => {
    for (const o of [{ watcher: 'true', desktop: 'GNOME' }, { watcher: 'broken', desktop: 'GNOME' }, { watcher: 'absent', desktop: 'GNOME' },
        { watcher: 'false', desktop: 'KDE' }, { watcher: 'false', desktop: 'X-Cinnamon' }, { watcher: 'false', desktop: 'i3', session: 'x11' }]) {
        const r = run(o);
        assert.equal(r.out, '', JSON.stringify(o));
        assert.deepEqual(r.calls, []);
        assert.equal(r.status, 0);
    }
});

test('--no-tray-check skips it entirely', () => {
    assert.equal(run({ watcher: 'false', desktop: 'GNOME', tray: 'no' }).out, '');
});

test('GNOME without a tray: non-interactive prints the command and installs nothing', () => {
    const r = run({ watcher: 'false', desktop: 'ubuntu:GNOME', osRelease: 'ID=ubuntu\nID_LIKE=debian\n' });
    assert.match(r.out, /No system tray was found/);
    assert.match(r.out, /To install it:\s+sudo apt install gnome-shell-extension-appindicator/);
    assert.match(r.out, /Then:\s+gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com/);
    assert.deepEqual(r.calls, []);
});

test('GNOME, asked at a terminal: no is the default, y installs and enables the extension', () => {
    const no = run({ watcher: 'false', desktop: 'GNOME', tty: true, answer: '' });
    assert.match(no.out, /Install it now with: sudo pacman -S --needed gnome-shell-extension-appindicator \? \[y\/N\]/);
    assert.match(no.out, /Skipped\./);
    assert.deepEqual(no.calls, []);
    const yes = run({ watcher: 'false', desktop: 'GNOME', tty: true, answer: 'y' });
    assert.deepEqual(yes.calls, ['sudo pacman -S --needed gnome-shell-extension-appindicator', 'gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com']);
    assert.match(yes.out, /Log out and back in/);
});

test('--tray-support installs without asking', () => {
    const r = run({ watcher: 'false', desktop: 'GNOME', tray: 'yes', osRelease: 'ID=fedora\n' });
    assert.deepEqual(r.calls[0], 'sudo dnf install gnome-shell-extension-appindicator');
});

test('a bare Wayland compositor is offered Waybar; X11 is left alone', () => {
    const r = run({ watcher: 'false', desktop: 'Hyprland', osRelease: 'ID=cachyos\nID_LIKE=arch\n' });
    assert.match(r.out, /Waybar/);
    assert.match(r.out, /sudo pacman -S --needed waybar/);
    assert.deepEqual(r.calls, []);
    assert.equal(run({ watcher: 'false', desktop: 'openbox', session: 'x11' }).out, '');
});

test('an unknown distribution gets the package name, and a failing install never fails the installer', () => {
    assert.match(run({ watcher: 'false', desktop: 'sway', osRelease: 'ID=nixos\n' }).out, /Package to install: waybar/);
    const bad = run({ watcher: 'false', desktop: 'GNOME', tray: 'yes', sudoExit: 1 });
    assert.deepEqual(bad.calls, ['sudo pacman -S --needed gnome-shell-extension-appindicator']);
    assert.match(bad.out, /That did not work; the tray is optional, Adam is installed\./);
    assert.equal(bad.status, 0);
});
