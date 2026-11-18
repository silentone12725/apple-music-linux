// Theme presets, migration and wallpaper lookup.
//   node --test electron/test/theme.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PRESETS, DEFAULT_PRESET, defaultPalette, migrateThemePrefs, THEME_VERSION } from '../theme-presets.mjs';
import { parseGsettingsUri, gnomeWallpaperPath, imageMime } from '../wallpaper.mjs';

test('the built-in presets are fixed neutral palettes, the default with red as the accent', () => {
    assert.deepEqual(Object.keys(BUILTIN_PRESETS), ['Apple Music', 'New Blue']);
    assert.equal(BUILTIN_PRESETS['New Blue']().accent, '#5ac8f5');
    assert.equal(DEFAULT_PRESET, 'Apple Music');
    const p = defaultPalette();
    assert.equal(p.accent, '#fc3c44');
    assert.equal(p.bgColor, '#000000');
    assert.equal(p.navBg, '#303030');
    assert.equal(p.appearance, 'dark');
    assert.notEqual(defaultPalette(), p, 'every call returns a fresh object');
});

test('migrateThemePrefs drops the old generated palette once and keeps everything else', () => {
    const prefs = { themeMode: 'accent', themePalette: { accent: '#00ff00', navBg: 'hsla(120,80%,14%,0.72)' }, themeAppearance: 'dark', themePresets: [{ name: 'mine' }], zoomFactor: 1.1 };
    assert.equal(migrateThemePrefs(prefs), true);
    assert.equal(prefs.themePalette, undefined);
    assert.equal(prefs.themeAppearance, undefined);
    assert.equal(prefs.themeVersion, THEME_VERSION);
    assert.equal(prefs.themeMode, 'accent');
    assert.deepEqual(prefs.themePresets, [{ name: 'mine' }]);
    assert.equal(prefs.zoomFactor, 1.1);
    // a palette chosen after the migration is never touched again
    prefs.themePalette = { accent: '#123456' };
    assert.equal(migrateThemePrefs(prefs), false);
    assert.deepEqual(prefs.themePalette, { accent: '#123456' });
});

test('parseGsettingsUri accepts file URIs only', () => {
    assert.equal(parseGsettingsUri("'file:///home/a/Pictures/my%20wall.jpg'\n"), '/home/a/Pictures/my wall.jpg');
    assert.equal(parseGsettingsUri("'none'"), '');
    assert.equal(parseGsettingsUri("'https://example.com/x.jpg'"), '');
    assert.equal(parseGsettingsUri(''), '');
});

test('gnomeWallpaperPath prefers the dark variant and needs an existing file', async () => {
    const calls = [];
    const runner = async (_c, args) => { calls.push(args[2]); return args[2] === 'picture-uri-dark' ? "'file:///w/dark.png'" : "'file:///w/light.png'"; };
    assert.equal(await gnomeWallpaperPath(() => true, runner), '/w/dark.png');
    assert.equal(await gnomeWallpaperPath((p) => p === '/w/light.png', runner), '/w/light.png');
    assert.equal(await gnomeWallpaperPath(() => false, runner), '');
});

test('imageMime handles the extensionless Windows cache and jpg', () => {
    assert.equal(imageMime('C:\\x\\TranscodedWallpaper'), 'jpeg');
    assert.equal(imageMime('/a/b.JPG'), 'jpeg');
    assert.equal(imageMime('/a/b.png'), 'png');
    assert.equal(imageMime('/a/b.bmp'), 'bmp');
});
