// Guards the CLAUDE.md sync rule: electron/*-bundle.js must be verbatim copies
// of their electron/src/ source. A missed `cp` after editing the source ships
// stale UI/playback code silently — this test fails the moment they diverge.
//
// Only the verbatim-copy bundles are checked here. engine-sse-bundle.js and
// smart-cache-bundle.js are esbuild output (not byte-equal to source), so they
// are excluded — rebuild those with the esbuild commands in CLAUDE.md.
//
// Run:  node --test electron/test/bundle-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, '..');

// [source of truth, verbatim bundle copy]
const pairs = [
    ['src/engine-playback.js', 'engine-bundle.js'],
    ['src/vision-glass.js', 'vision-bundle.js'],
];

for (const [src, bundle] of pairs) {
    test(`bundle in sync: ${bundle} matches ${src}`, () => {
        const srcText = readFileSync(path.join(root, src), 'utf8');
        const bundleText = readFileSync(path.join(root, bundle), 'utf8');
        assert.equal(
            bundleText,
            srcText,
            `${bundle} is stale. Re-sync it:\n` +
            `  cp electron/${src} electron/${bundle}\n` +
            `  cp electron/${src} electron/dist/linux-unpacked/resources/${bundle}`,
        );
    });
}
