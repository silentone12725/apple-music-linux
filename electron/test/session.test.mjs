// Session detection, argument handling, compositor config blocks and the autostart mechanism choice.
//   node --test electron/test/session.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    detectSession, isWayland, execToArgs, shQuote, shLine, kdlString, CONFIG_PROFILES,
    configBlock, hasConfigBlock, readConfigBlock, removeConfigBlock, putConfigBlock, chooseMechanism,
} from '../session.mjs';

test('full desktop environments are recognised from any of the three variables', () => {
    for (const [env, id] of [
        [{ XDG_CURRENT_DESKTOP: 'GNOME' }, 'gnome'], [{ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, 'ubuntu'],
        [{ XDG_CURRENT_DESKTOP: 'KDE' }, 'kde'], [{ DESKTOP_SESSION: 'plasma' }, 'plasma'],
        [{ XDG_CURRENT_DESKTOP: 'XFCE' }, 'xfce'], [{ XDG_CURRENT_DESKTOP: 'X-Cinnamon' }, 'x-cinnamon'],
        [{ XDG_SESSION_DESKTOP: 'mate' }, 'mate'], [{ XDG_CURRENT_DESKTOP: 'LXQt' }, 'lxqt'],
        [{ XDG_CURRENT_DESKTOP: 'COSMIC' }, 'cosmic'], [{ XDG_CURRENT_DESKTOP: 'Budgie:GNOME' }, 'budgie'],
    ]) {
        const s = detectSession(env);
        assert.equal(s.kind, 'desktop', JSON.stringify(env));
        assert.equal(s.id, id, JSON.stringify(env));
    }
});

test('compositors and window managers are recognised, with their socket variables as a fallback', () => {
    for (const [env, id] of [
        [{ XDG_CURRENT_DESKTOP: 'Hyprland' }, 'hyprland'], [{ XDG_CURRENT_DESKTOP: 'sway' }, 'sway'],
        [{ XDG_CURRENT_DESKTOP: 'i3' }, 'i3'], [{ DESKTOP_SESSION: 'i3-with-shmlog' }, 'i3'],
        [{ XDG_CURRENT_DESKTOP: 'niri' }, 'niri'], [{ XDG_CURRENT_DESKTOP: 'river' }, 'river'],
        [{ XDG_CURRENT_DESKTOP: 'labwc:wlroots' }, 'labwc'], [{ DESKTOP_SESSION: 'bspwm' }, 'bspwm'],
        [{ HYPRLAND_INSTANCE_SIGNATURE: 'abc' }, 'hyprland'], [{ SWAYSOCK: '/run/sway.sock', I3SOCK: '/run/sway.sock' }, 'sway'],
        [{ NIRI_SOCKET: '/run/niri.sock' }, 'niri'], [{ I3SOCK: '/run/i3.sock' }, 'i3'],
    ]) {
        const s = detectSession(env);
        assert.equal(s.kind, 'compositor', JSON.stringify(env));
        assert.equal(s.id, id, JSON.stringify(env));
    }
});

test('an unrecognised session is unknown, and wayland comes from the session type or the socket', () => {
    assert.deepEqual(detectSession({}), { id: '', kind: 'unknown', wayland: false });
    assert.equal(detectSession({ XDG_CURRENT_DESKTOP: 'weirdwm' }).kind, 'unknown');
    assert.equal(isWayland({ XDG_SESSION_TYPE: 'wayland' }), true);
    assert.equal(isWayland({ WAYLAND_DISPLAY: 'wayland-1' }), true);
    assert.equal(isWayland({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), false);
});

test('Exec lines turn into argument lists and back into shell and KDL text', () => {
    assert.deepEqual(execToArgs('/opt/adam/adam --no-sandbox --hidden'), ['/opt/adam/adam', '--no-sandbox', '--hidden']);
    assert.deepEqual(execToArgs('"/home/u/My Apps/Adam.AppImage" --hidden'), ['/home/u/My Apps/Adam.AppImage', '--hidden']);
    assert.deepEqual(execToArgs('"/p/\\$x\\"y" a'), ['/p/$x"y', 'a']);
    assert.deepEqual(execToArgs('""'), ['']);
    assert.equal(shQuote('/opt/adam/adam'), '/opt/adam/adam');
    assert.equal(shQuote('/home/u/My Apps/a'), "'/home/u/My Apps/a'");
    assert.equal(shQuote("it's"), "'it'\\''s'");
    assert.equal(shLine(['/a b/adam', '--hidden']), "'/a b/adam' --hidden");
    assert.equal(kdlString('a"b\\c'), '"a\\"b\\\\c"');
});

const ARGS = ['/home/u/.local/lib/adam/adam', '--no-sandbox', '--hidden'];

test('every compositor profile writes its own launch line', () => {
    assert.equal(CONFIG_PROFILES.hyprland.line(ARGS), 'exec-once = /home/u/.local/lib/adam/adam --no-sandbox --hidden');
    assert.equal(CONFIG_PROFILES.sway.line(ARGS), 'exec /home/u/.local/lib/adam/adam --no-sandbox --hidden');
    assert.equal(CONFIG_PROFILES.i3.line(ARGS), 'exec --no-startup-id /home/u/.local/lib/adam/adam --no-sandbox --hidden');
    assert.equal(CONFIG_PROFILES.niri.line(ARGS), 'spawn-at-startup "/home/u/.local/lib/adam/adam" "--no-sandbox" "--hidden"');
    assert.equal(CONFIG_PROFILES.labwc.line(ARGS), '/home/u/.local/lib/adam/adam --no-sandbox --hidden &');
    assert.equal(CONFIG_PROFILES.bspwm.line(ARGS), '/home/u/.local/lib/adam/adam --no-sandbox --hidden &');
    assert.equal(CONFIG_PROFILES.river.line(ARGS), "riverctl spawn '/home/u/.local/lib/adam/adam --no-sandbox --hidden'");
    assert.match(CONFIG_PROFILES.river.line(['/a b/adam', '--hidden']), /^riverctl spawn '/);
});

for (const [id, profile] of Object.entries(CONFIG_PROFILES)) {
    test(`${id}: a managed block is added, found, replaced and removed, leaving the rest of the file alone`, () => {
        const original = id === 'niri' ? 'input {\n    keyboard { }\n}\n// my own note\n' : '# my config\nsomething = 1\n\nexec-once = waybar\n';
        const added = putConfigBlock(original, profile, ARGS);
        assert.equal(hasConfigBlock(added, profile), true);
        assert.ok(added.startsWith(original.replace(/\s+$/, '')), 'the original text is untouched');
        assert.match(readConfigBlock(added, profile), /--hidden/);
        const replaced = putConfigBlock(added, profile, ARGS.slice(0, 2));
        assert.equal((replaced.match(/Adam launch at login \(managed/g) || []).length, 1, 'one block only');
        assert.doesNotMatch(readConfigBlock(replaced, profile), /--hidden/);
        const removed = removeConfigBlock(replaced, profile);
        assert.equal(hasConfigBlock(removed, profile), false);
        assert.equal(removed.trim(), original.trim());
    });
}

test('config blocks work on an empty or block-only file and ignore a lookalike', () => {
    const p = CONFIG_PROFILES.sway;
    const t = putConfigBlock('', p, ARGS);
    assert.equal(t, configBlock(p, ARGS));
    assert.equal(removeConfigBlock(t, p), '');
    assert.equal(hasConfigBlock('# >>> something else >>>\nexec x\n# <<< something else <<<\n', p), false);
    assert.equal(removeConfigBlock('exec-once = adam\n', CONFIG_PROFILES.hyprland), 'exec-once = adam\n');
});

test('the mechanism: XDG for desktops and sessions that run it, a systemd unit for plain compositor sessions, then config', () => {
    const comp = { id: 'hyprland', kind: 'compositor', wayland: true };
    const desk = { id: 'gnome', kind: 'desktop', wayland: true };
    const sd = (o = {}) => ({ available: true, xdgTarget: false, graphicalTarget: false, ...o });
    assert.equal(chooseMechanism({ session: desk, systemd: sd(), configFile: '', profile: null }).mechanism, 'xdg');
    assert.equal(chooseMechanism({ session: comp, systemd: sd({ xdgTarget: true }), configFile: '', profile: null }).mechanism, 'xdg');
    const viaSystemd = chooseMechanism({ session: comp, systemd: sd({ graphicalTarget: true }), configFile: '/c', profile: CONFIG_PROFILES.hyprland });
    assert.equal(viaSystemd.mechanism, 'systemd');
    assert.match(viaSystemd.reason, /Hyprland does not run autostart entries/);
    const viaConfig = chooseMechanism({ session: { id: 'i3', kind: 'compositor', wayland: false }, systemd: sd({ available: false }), configFile: '/h/.config/i3/config', profile: CONFIG_PROFILES.i3 });
    assert.equal(viaConfig.mechanism, 'config');
    assert.match(viaConfig.reason, /i3/);
    const nothing = chooseMechanism({ session: { id: 'dwm', kind: 'compositor', wayland: false }, systemd: sd({ available: false }), configFile: '', profile: null });
    assert.equal(nothing.mechanism, 'xdg');
    assert.equal(nothing.unreliable, true);
    assert.equal(chooseMechanism({ session: { id: '', kind: 'unknown', wayland: false }, systemd: sd({ graphicalTarget: true }), configFile: '', profile: null }).mechanism, 'systemd');
});
