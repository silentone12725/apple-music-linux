// System-tray detection and the advice for desktops that have none.
//   node --test electron/test/tray.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTrayHost, parseOsRelease, packageManager, installCommand, trayAdvice, WATCHER, GNOME_EXTENSION } from '../tray.mjs';

const ok = (stdout, status = 0) => ({ status, stdout, stderr: '', error: null });
const missing = { status: null, stdout: '', stderr: '', error: new Error('ENOENT') };

test('the watcher is read from dbus-send, then busctl, then gdbus; null when no tool answers', () => {
    assert.equal(detectTrayHost(() => ok('method return time=1\n   boolean true\n')), true);
    assert.equal(detectTrayHost(() => ok('method return time=1\n   boolean false\n')), false);
    assert.equal(detectTrayHost((c) => (c === 'dbus-send' ? missing : ok('NAME=org.kde.StatusNotifierWatcher\n', 0))), true);
    assert.equal(detectTrayHost((c) => (c === 'dbus-send' ? missing : ok('Failed to get\n', 1))), false);
    assert.equal(detectTrayHost((c) => (c === 'gdbus' ? ok('(true,)\n') : missing)), true);
    assert.equal(detectTrayHost((c) => (c === 'gdbus' ? ok('(false,)\n') : missing)), false);
    assert.equal(detectTrayHost(() => missing), null);
    const asked = []; detectTrayHost((c, a) => { asked.push(a.join(' ')); return missing; });
    assert.ok(asked.some((a) => a.includes(WATCHER)));
});

test('os-release names the package manager, through ID_LIKE too', () => {
    const pm = (t) => packageManager(parseOsRelease(t));
    assert.equal(pm('ID=arch\n'), 'pacman');
    assert.equal(pm('ID=cachyos\nID_LIKE="arch"\n'), 'pacman');
    assert.equal(pm('ID=ubuntu\nID_LIKE=debian\n'), 'apt');
    assert.equal(pm('ID=linuxmint\nID_LIKE="ubuntu debian"\n'), 'apt');
    assert.equal(pm('ID=fedora\n'), 'dnf');
    assert.equal(pm('ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\n'), 'zypper');
    assert.equal(pm('ID=nixos\n'), '');
    assert.equal(installCommand('pacman', 'waybar'), 'sudo pacman -S --needed waybar');
    assert.equal(installCommand('apt', 'waybar'), 'sudo apt install waybar');
    assert.equal(installCommand('', 'waybar'), '');
});

const ARCH = { id: 'arch', like: [] };
const wl = (XDG_CURRENT_DESKTOP) => ({ XDG_CURRENT_DESKTOP, XDG_SESSION_TYPE: 'wayland' });

test('a watcher, or no way to tell, means the tray is assumed to work and nothing is said', () => {
    for (const hasWatcher of [true, null]) {
        const a = trayAdvice({ env: wl('Hyprland'), hasWatcher, osRelease: ARCH });
        assert.equal(a.likely, true);
        assert.equal(a.message, '');
    }
});

test('X11 without a watcher still has the XEmbed tray, except on GNOME', () => {
    const x11 = (d) => ({ XDG_CURRENT_DESKTOP: d, XDG_SESSION_TYPE: 'x11' });
    for (const d of ['i3', 'bspwm', 'openbox', 'XFCE']) {
        const a = trayAdvice({ env: x11(d), hasWatcher: false, osRelease: ARCH });
        assert.equal(a.likely, true, d);
        assert.equal(a.host, 'xembed');
    }
    assert.equal(trayAdvice({ env: x11('GNOME'), hasWatcher: false, osRelease: ARCH }).likely, false);
});

test('GNOME is told about the AppIndicator extension, with the package for its distribution', () => {
    for (const [os, cmd] of [[ARCH, 'sudo pacman -S --needed gnome-shell-extension-appindicator'], [{ id: 'ubuntu', like: ['debian'] }, 'sudo apt install gnome-shell-extension-appindicator'],
        [{ id: 'fedora', like: [] }, 'sudo dnf install gnome-shell-extension-appindicator'], [{ id: 'opensuse-leap', like: [] }, 'sudo zypper install gnome-shell-extension-appindicator']]) {
        const a = trayAdvice({ env: wl('GNOME'), hasWatcher: false, osRelease: os });
        assert.equal(a.likely, false);
        assert.equal(a.packageName, 'gnome-shell-extension-appindicator');
        assert.equal(a.command, cmd);
        assert.equal(a.enable, `gnome-extensions enable ${GNOME_EXTENSION}`);
        assert.equal(a.relogin, true);
        assert.match(a.message, /AppIndicator/);
    }
    assert.equal(trayAdvice({ env: wl('GNOME'), hasWatcher: false, osRelease: { id: 'nixos', like: [] } }).command, '');
});

test('a Wayland compositor is pointed at a bar with a tray module', () => {
    for (const d of ['Hyprland', 'sway', 'niri', 'river', 'labwc']) {
        const a = trayAdvice({ env: wl(d), hasWatcher: false, osRelease: ARCH });
        assert.equal(a.likely, false, d);
        assert.equal(a.packageName, 'waybar');
        assert.match(a.message, /Waybar.*sudo pacman -S --needed waybar.*"tray" module/);
    }
});

test('a desktop that has its own tray says the panel is not running it, with nothing to install', () => {
    for (const d of ['KDE', 'X-Cinnamon', 'COSMIC']) {
        const a = trayAdvice({ env: wl(d), hasWatcher: false, osRelease: ARCH });
        assert.equal(a.likely, false, d);
        assert.equal(a.packageName, '');
        assert.match(a.message, /built in/);
    }
});
