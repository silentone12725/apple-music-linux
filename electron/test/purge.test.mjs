// `adam --purge-data`: which folders, and that nothing else goes.
//   node --test electron/test/purge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { purgeTargets, purgeUserData } from '../purge.mjs';

test('Linux: Adam\'s config and cache folders only, following the XDG variables', () => {
    assert.deepEqual(purgeTargets({ plat: 'linux', env: {}, home: '/home/u' }), ['/home/u/.config/adam', '/home/u/.config/apple-music-linux', '/home/u/.config/aml', '/home/u/.cache/adam']);
    assert.deepEqual(purgeTargets({ plat: 'linux', env: { XDG_CONFIG_HOME: '/c', XDG_CACHE_HOME: '/k' }, home: '/home/u' }), ['/c/adam', '/c/apple-music-linux', '/c/aml', '/k/adam']);
});

test('Windows: the Roaming and Local app-data folders', () => {
    assert.deepEqual(purgeTargets({ plat: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' }).map((p) => p.replace(/\\/g, '/')).filter((p) => p.endsWith('/adam')), ['C:/Users/u/AppData/Roaming/adam', 'C:/Users/u/AppData/Local/adam']);
    assert.deepEqual(purgeTargets({ plat: 'win32', env: {}, home: 'C:\\Users\\u' }), []); // no app-data variable: nothing is guessed
});

test('never a parent folder, and never another project\'s data', () => {
    for (const plat of ['linux', 'win32']) {
        for (const t of purgeTargets({ plat, env: { APPDATA: '/r', LOCALAPPDATA: '/l' }, home: '/h' })) {
            assert.match(path.basename(t), /^(adam|apple-music-linux|aml)$/, t);
            assert.doesNotMatch(t, /musickit/);
        }
    }
});

test('purging removes those folders and leaves the rest', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'adam-purge-'));
    const f = (rel) => { const p = path.join(home, rel); mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, 'x'); };
    f('.config/adam/drm/files/MUSIC_TOKEN'); f('.config/adam/electron-session/Cookies'); f('.cache/adam/playback/a'); f('.config/apple-music-linux/old');
    f('.config/musickit-sdk-linux/keep'); f('.cache/musickit-sdk-linux/keep'); f('.config/other/keep');
    const removed = purgeUserData(purgeTargets({ plat: 'linux', env: {}, home }));
    assert.equal(removed.length, 3);
    for (const rel of ['.config/adam', '.config/apple-music-linux', '.cache/adam']) assert.equal(existsSync(path.join(home, rel)), false, rel);
    for (const rel of ['.config/musickit-sdk-linux/keep', '.cache/musickit-sdk-linux/keep', '.config/other/keep']) assert.equal(existsSync(path.join(home, rel)), true, rel);
    assert.deepEqual(purgeUserData(purgeTargets({ plat: 'linux', env: {}, home })), []); // nothing left: harmless
    rmSync(home, { recursive: true, force: true });
});
