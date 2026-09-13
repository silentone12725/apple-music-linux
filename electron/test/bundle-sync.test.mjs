// Guards the injected-bundle build/sync rules.
//
// - vision-bundle.js is a verbatim `cp` of src/vision-glass.js → byte-equal check.
// - engine-bundle.js is now an esbuild bundle of src/engine-playback.js + its
//   src/engine/*.js modules (`npm run build:engine`), NOT a copy. So instead of a
//   byte compare, we assert the two things that actually break the app if wrong:
//     1) correctness — the bundle has NO un-inlined `import`/`export`, which would
//        throw the moment it's injected (it's eval'd as a plain script, not a module).
//     2) freshness — every extracted module's export marker is present in the bundle,
//        so a totally stale bundle (missing a module) is caught.
//   engine-sse-bundle.js / smart-cache-bundle.js are likewise esbuild output.
//
// Run:  node --test electron/test/bundle-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

// ── Verbatim-copy bundles: byte-equal with their source. ──
for (const [src, bundle] of [['src/vision-glass.js', 'vision-bundle.js']]) {
    test(`bundle in sync: ${bundle} matches ${src}`, () => {
        assert.equal(read(bundle), read(src),
            `${bundle} is stale. Re-sync:\n  cp electron/${src} electron/${bundle}\n` +
            `  cp electron/${src} electron/dist/linux-unpacked/resources/${bundle}`);
    });
}

// ── esbuild bundle: correctness + freshness. ──
test('engine-bundle.js is a valid injectable esbuild bundle', () => {
    const b = read('engine-bundle.js');
    // 1) No un-inlined module syntax — the bundle is eval'd as a plain script.
    const badImport = /^\s*import\s.+\sfrom\s/m.test(b) || /^\s*export\s/m.test(b) || /from\s+['"]\.\/engine/.test(b);
    assert.equal(badImport, false,
        'engine-bundle.js has un-inlined import/export — run `npm run build:engine`');
    // 2) Freshness: each extracted src/engine module must appear inlined.
    const markers = ['mp4ParseBoxes', 'extractItemId']; // extend as more modules are extracted
    for (const m of markers) {
        assert.ok(b.includes(m), `engine-bundle.js missing "${m}" — stale; run \`npm run build:engine\``);
    }
});

test('engine-bundle.js matches its dist copy', (t) => {
    const distPath = 'dist/linux-unpacked/resources/engine-bundle.js';
    let distText;
    try {
        distText = read(distPath);
    } catch {
        t.skip('no dist/ (fresh clone — gitignored build output)');
        return;
    }
    assert.equal(read('engine-bundle.js'), distText,
        'dist engine-bundle.js is stale — `npm run build:engine` copies it too');
});
