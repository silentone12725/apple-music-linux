// `adam.run --uninstall`: removes the install and every session file, or with --keep-data keeps the sign-in.
// Runs the real scripts/installer-header.sh against a fake home, with a stub systemctl.
//   node --test electron/test/installer-uninstall.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { putConfigBlock, CONFIG_PROFILES } from '../session.mjs';

const header = fileURLToPath(new URL('../../scripts/installer-header.sh', import.meta.url));
const SWAY_ORIGINAL = 'set $mod Mod4\nbindsym $mod+Return exec foot\n';
const MIME = [
    '[Default Applications]',
    'x-scheme-handler/adam=adam.desktop;',
    'x-scheme-handler/music=adam.desktop;winpodx-adam.desktop;',
    'x-scheme-handler/itms=winpodx-adam.desktop;',
    'x-scheme-handler/http=firefox.desktop;',
    '',
].join('\n');

function fakeHome() {
    const home = mkdtempSync(path.join(tmpdir(), 'adam-uninstall-'));
    const f = (rel, text = 'x') => { const p = path.join(home, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, text); return p; };
    // the install
    f('.local/lib/adam/adam'); f('.local/lib/adam/resources/engine');
    f('.local/bin/adam', `#!/bin/sh\nexec "${home}/.local/lib/adam/adam" --no-sandbox "$@"\n`);
    f('.local/share/applications/adam.desktop', '[Desktop Entry]\nName=Adam\n');
    f('.local/share/icons/hicolor/256x256/apps/adam.png');
    // session files: the DRM session token, the web sign-in, settings, a legacy folder and a cache
    f('.config/adam/drm/files/MUSIC_TOKEN', 'token'); f('.config/adam/drm/files/STOREFRONT_ID', 'in');
    f('.config/adam/electron-session/Cookies', 'web login'); f('.config/adam/electron-prefs.json', '{}'); f('.config/adam/adam-store.enc', 'enc');
    f('.config/apple-music-linux/old-setting', 'old'); f('.cache/adam/playback/1-alac.m4a', 'audio');
    // other projects' data and files that must survive
    f('.config/musickit-sdk-linux/keep.txt'); f('.cache/musickit-sdk-linux/keep.txt'); f('.config/other-app/settings', 'keep');
    // launch at login, in each of its three forms
    f('.config/autostart/adam.desktop', '[Desktop Entry]\nExec=adam\n'); f('.config/autostart/other.desktop', '[Desktop Entry]\nExec=other\n');
    f('.config/systemd/user/adam-autostart.service', '[Service]\nExecStart=/x\n');
    f('.config/sway/config', putConfigBlock(SWAY_ORIGINAL, CONFIG_PROFILES.sway, ['/x/adam', '--hidden']));
    f('.config/i3/config', '# i3, no Adam block\nexec --no-startup-id foo\n');
    f('.config/mimeapps.list', MIME);
    // a stub systemctl that only records
    const bin = path.join(home, 'stubbin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${home}/calls.log"\n`); chmodSync(path.join(bin, 'systemctl'), 0o755);
    return { home, p: (rel) => path.join(home, rel), calls: () => (existsSync(path.join(home, 'calls.log')) ? readFileSync(path.join(home, 'calls.log'), 'utf8') : '') };
}

function uninstall(h, ...args) {
    return spawnSync('sh', [header, '--uninstall', ...args], {
        encoding: 'utf8', env: { PATH: `${h.home}/stubbin:/usr/bin:/bin`, HOME: h.home },
    });
}

test('--uninstall removes the install, every session file, launch at login and the link associations, and nothing else', () => {
    const h = fakeHome();
    const r = uninstall(h);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /including your settings, sign-in and caches/);
    // the install
    for (const rel of ['.local/lib/adam', '.local/bin/adam', '.local/share/applications/adam.desktop', '.local/share/icons/hicolor/256x256/apps/adam.png']) assert.equal(existsSync(h.p(rel)), false, rel);
    // the session: DRM token, web sign-in, settings, the legacy folder, caches
    for (const rel of ['.config/adam', '.config/apple-music-linux', '.cache/adam']) assert.equal(existsSync(h.p(rel)), false, rel);
    // launch at login
    assert.equal(existsSync(h.p('.config/autostart/adam.desktop')), false);
    assert.equal(existsSync(h.p('.config/systemd/user/adam-autostart.service')), false);
    assert.match(h.calls(), /systemctl --user disable adam-autostart.service/);
    assert.match(h.calls(), /systemctl --user daemon-reload/);
    assert.equal(readFileSync(h.p('.config/sway/config'), 'utf8').trim(), SWAY_ORIGINAL.trim());
    assert.equal(readFileSync(h.p('.config/i3/config'), 'utf8'), '# i3, no Adam block\nexec --no-startup-id foo\n');
    // link associations: Adam's own entries go, another application's stay
    const mime = readFileSync(h.p('.config/mimeapps.list'), 'utf8');
    assert.doesNotMatch(mime, /[=;]adam\.desktop/);
    assert.match(mime, /x-scheme-handler\/music=winpodx-adam\.desktop;/);
    assert.match(mime, /x-scheme-handler\/itms=winpodx-adam\.desktop;/);
    assert.match(mime, /x-scheme-handler\/http=firefox\.desktop;/);
    assert.doesNotMatch(mime, /x-scheme-handler\/adam=/);
    // nothing that is not Adam's
    for (const rel of ['.config/musickit-sdk-linux/keep.txt', '.cache/musickit-sdk-linux/keep.txt', '.config/other-app/settings', '.config/autostart/other.desktop']) assert.equal(existsSync(h.p(rel)), true, rel);
    rmSync(h.home, { recursive: true, force: true });
});

test('--uninstall --keep-data keeps the DRM session and the web sign-in, and says how to remove them', () => {
    const h = fakeHome();
    const r = uninstall(h, '--keep-data');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Kept your settings and sign-in in /);
    assert.match(r.stdout, /rm -rf /);
    for (const rel of ['.config/adam/drm/files/MUSIC_TOKEN', '.config/adam/drm/files/STOREFRONT_ID', '.config/adam/electron-session/Cookies', '.config/adam/electron-prefs.json', '.config/adam/adam-store.enc', '.cache/adam/playback/1-alac.m4a']) {
        assert.equal(existsSync(h.p(rel)), true, rel);
    }
    // the program and launch at login are still removed
    for (const rel of ['.local/lib/adam', '.local/bin/adam', '.config/autostart/adam.desktop', '.config/systemd/user/adam-autostart.service']) assert.equal(existsSync(h.p(rel)), false, rel);
    assert.doesNotMatch(readFileSync(h.p('.config/mimeapps.list'), 'utf8'), /[=;]adam\.desktop/);
    rmSync(h.home, { recursive: true, force: true });
});

test('a symlinked compositor config is cleaned through the link', () => {
    const h = fakeHome();
    const real = h.p('dotfiles/sway-config');
    mkdirSync(path.dirname(real), { recursive: true });
    writeFileSync(real, putConfigBlock(SWAY_ORIGINAL, CONFIG_PROFILES.sway, ['/x/adam']));
    rmSync(h.p('.config/sway/config'));
    spawnSync('ln', ['-s', real, h.p('.config/sway/config')]);
    uninstall(h);
    assert.equal(spawnSync('test', ['-L', h.p('.config/sway/config')]).status, 0, 'still a symlink');
    assert.equal(readFileSync(real, 'utf8').trim(), SWAY_ORIGINAL.trim());
    rmSync(h.home, { recursive: true, force: true });
});

test('uninstalling twice, or with nothing set up, is harmless', () => {
    const h = fakeHome();
    assert.equal(uninstall(h).status, 0);
    assert.equal(uninstall(h).status, 0);
    rmSync(h.home, { recursive: true, force: true });
});
