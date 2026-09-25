// Unit tests for album-art palette extraction and role mapping.
// Run: node --test electron/test/engine/artpalette.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPalette, paletteRoles, rgbToHsl } from '../../src/engine/artpalette.js';

// Build RGBA pixel data from [ [r,g,b], count ] runs.
function pixels(...runs) {
    const out = [];
    for (const [[r, g, b], n] of runs) for (let i = 0; i < n; i++) out.push(r, g, b, 255);
    return new Uint8ClampedArray(out);
}
const hueOf = (css) => +/hsla\((\d+)/.exec(css)[1];
const lightOf = (css) => +/,\s*(\d+)%,\s*(\d+)%/.exec(css)[2];

test('rgbToHsl: primaries and grey', () => {
    assert.deepEqual(rgbToHsl(255, 0, 0).map(v => +v.toFixed(2)), [0, 1, 0.5]);
    assert.equal(Math.round(rgbToHsl(0, 0, 255)[0]), 240);
    assert.equal(rgbToHsl(128, 128, 128)[1], 0);
});

test('extractPalette: keeps distinct colours, most prominent first', () => {
    // Sanju-like art: lots of sky blue, some dark navy, a warm skin/orange accent.
    const pal = extractPalette(pixels([[150, 205, 230], 900], [[20, 30, 60], 400], [[220, 120, 60], 200]));
    assert.equal(pal.length, 3);
    assert.ok(pal[0].weight > pal[1].weight && pal[1].weight > pal[2].weight);
    const hues = pal.map(c => Math.round(c.h));
    assert.ok(hues.some(h => h > 180 && h < 220), `blue present: ${hues}`);
    assert.ok(hues.some(h => h > 10 && h < 40), `orange present: ${hues}`);
});

test('extractPalette: merges near-identical shades, drops specks, ignores transparency', () => {
    const data = pixels([[200, 40, 40], 500], [[205, 45, 42], 500], [[0, 255, 0], 5]);
    const pal = extractPalette(data);
    assert.equal(pal.length, 1, 'two reds collapse; a 0.5% green speck is dropped');
    assert.deepEqual(extractPalette(new Uint8ClampedArray([255, 0, 0, 0])), []);
});

test('paletteRoles: roles are distinguishable, accent is the vivid colour', () => {
    const pal = extractPalette(pixels([[150, 205, 230], 900], [[20, 30, 60], 400], [[220, 120, 60], 200]));
    const r = paletteRoles(pal);
    // Surfaces sit in separate lightness bands.
    const bands = [lightOf(r.pageBg), lightOf(r.navBg), lightOf(r.raised), lightOf(r.accent)];
    assert.equal(new Set(bands).size, bands.length, `distinct lightness: ${bands}`);
    assert.ok(lightOf(r.pageBg) < lightOf(r.navBg) && lightOf(r.navBg) < lightOf(r.raised));
    // Page and glows use different hues when the art provides them.
    assert.notEqual(hueOf(r.pageBg), hueOf(r.glowA));
    assert.ok(['#000', '#fff'].includes(r.onAccent));
});

test('paletteRoles: single colour still yields distinct glow hues; greyscale art gets a neutral accent', () => {
    const one = paletteRoles([{ h: 200, s: 0.5, l: 0.4, weight: 1 }]);
    assert.notEqual(hueOf(one.glowA), hueOf(one.glowB));
    const grey = paletteRoles(extractPalette(pixels([[30, 30, 30], 500], [[200, 200, 200], 500])));
    assert.match(grey.accent, /hsla\(\d+, 0%/);
    assert.equal(paletteRoles([]), null);
});
