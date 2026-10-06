// A packaged build must keep the DRM session in the user's config dir: the bundle can be a
// read-only AppImage mount, /opt or a Flatpak /app, and the engine fails to start when its
// session lock cannot be created.
//
//   node --test electron/test/drm-session-dir.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MAIN = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const body = MAIN.slice(MAIN.indexOf('function ensureEngineConfig'), MAIN.indexOf('// Patch existing config'));

test('packaged builds put drm-base-dir under CONFIG_DIR, not inside the bundle', () => {
    const packaged = body.slice(body.indexOf('if (app.isPackaged)'), body.indexOf('} else {'));
    assert.match(packaged, /drmBase\s*=\s*path\.join\(CONFIG_DIR,\s*'drm',\s*'files'\)/);
    assert.ok(!/drmBase\s*=\s*path\.join\(__dirname/.test(packaged), 'must not point into the bundle');
});

test('a session saved inside the install dir by older builds is migrated once', () => {
    assert.match(body, /cpSync\(legacyBase,\s*drmBase/);
    assert.match(body, /!existsSync\(drmBase\)\s*&&\s*existsSync\(legacyBase\)/);
});

test('CONFIG_DIR follows XDG_CONFIG_HOME only inside a Flatpak', () => {
    assert.match(MAIN, /process\.env\.FLATPAK_ID && process\.env\.XDG_CONFIG_HOME/);
});
