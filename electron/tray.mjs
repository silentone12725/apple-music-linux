// Is there a system tray for Adam's tray icon, and if not, what gives the desktop one? Linux only (Windows always has one).
//
// Electron draws its tray icon through the StatusNotifierItem protocol: it needs a host on the session bus that owns
// org.kde.StatusNotifierWatcher. Plasma, MATE, Cinnamon, LXQt, Budgie, Deepin, COSMIC and current Xfce have one; GNOME has
// none without an extension; Wayland compositors need a bar with a tray module. On X11 Electron falls back to the older
// XEmbed tray, which the usual X11 bars (polybar, i3bar, tint2 …) provide, so a missing watcher there is not a problem.
// Pure helpers plus a detector with an injected command runner, unit-tested in test/tray.test.mjs.
import { detectSession } from './session.mjs';

export const WATCHER = 'org.kde.StatusNotifierWatcher';
export const GNOME_EXTENSION = 'appindicatorsupport@rgcjonas.gmail.com'; // GNOME Shell extension 615

// true / false, or null when no tool could answer (then nothing is assumed).
export function detectTrayHost(run) {
    const tries = [
        () => { const r = run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${WATCHER}`]); const m = /boolean\s+(true|false)/.exec(r.stdout || ''); return r.error || !m ? undefined : m[1] === 'true'; },
        () => { const r = run('busctl', ['--user', '--no-pager', 'status', WATCHER]); if (r.error) return undefined; return r.status === 0; },
        () => { const r = run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER]); const m = /\((true|false),?\)/.exec(r.stdout || ''); return r.error || !m ? undefined : m[1] === 'true'; },
    ];
    for (const t of tries) { const v = t(); if (v !== undefined) return v; }
    return null;
}

export function parseOsRelease(text) {
    const get = (k) => { const m = new RegExp(`^${k}=(.*)$`, 'm').exec(text || ''); return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''; };
    return { id: get('ID').toLowerCase(), like: get('ID_LIKE').toLowerCase().split(/\s+/).filter(Boolean) };
}

export function packageManager(osRelease) {
    const ids = [osRelease.id, ...osRelease.like];
    if (ids.some((i) => ['arch', 'cachyos', 'manjaro', 'endeavouros', 'garuda', 'artix'].includes(i))) return 'pacman';
    if (ids.some((i) => ['debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'zorin', 'kali', 'raspbian'].includes(i))) return 'apt';
    if (ids.some((i) => ['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'nobara'].includes(i))) return 'dnf';
    if (ids.some((i) => ['opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'suse', 'sles'].includes(i))) return 'zypper';
    return '';
}

export function installCommand(pm, pkg) {
    return { pacman: `sudo pacman -S --needed ${pkg}`, apt: `sudo apt install ${pkg}`, dnf: `sudo dnf install ${pkg}`, zypper: `sudo zypper install ${pkg}` }[pm] || '';
}

// { likely, host, message, packageName, command, enable, relogin }. `likely` = a tray icon will show.
export function trayAdvice({ env = process.env, hasWatcher, osRelease = { id: '', like: [] }, session = detectSession(env) }) {
    const none = { likely: true, host: hasWatcher === true ? 'present' : 'unknown', message: '', packageName: '', command: '', enable: '', relogin: false };
    if (hasWatcher !== false) return none;
    const gnome = ['gnome', 'gnome-flashback', 'ubuntu'].includes(session.id);
    // On X11 Electron falls back to the XEmbed tray that the usual bars provide; GNOME has neither.
    if (!session.wayland && !gnome) return { ...none, host: 'xembed' };
    const pm = packageManager(osRelease);
    if (gnome) {
        const pkg = 'gnome-shell-extension-appindicator';
        const command = installCommand(pm, pkg);
        return {
            likely: false, host: 'missing', packageName: pkg, command, enable: `gnome-extensions enable ${GNOME_EXTENSION}`, relogin: true,
            message: `GNOME has no system tray by default, so Adam's tray icon is not shown. The AppIndicator extension adds one${command ? `: ${command}` : ` (package ${pkg})`}, then run gnome-extensions enable ${GNOME_EXTENSION} and log in again.`,
        };
    }
    if (['kde', 'plasma', 'x-cinnamon', 'cinnamon', 'mate', 'lxqt', 'budgie', 'budgie-desktop', 'deepin', 'cosmic', 'xfce'].includes(session.id)) {
        return { likely: false, host: 'missing', packageName: '', command: '', enable: '', relogin: false,
            message: 'No system tray is running. Your panel has one built in, so it may be crashed or the tray applet removed.' };
    }
    const pkg = 'waybar';
    const command = installCommand(pm, pkg);
    return {
        likely: false, host: 'missing', packageName: pkg, command, enable: '', relogin: false,
        message: `No system tray was found. A bar with a tray module provides one, for example Waybar${command ? ` (${command})` : ''}: enable its "tray" module and start it.`,
    };
}
