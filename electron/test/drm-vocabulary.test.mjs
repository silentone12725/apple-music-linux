import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The DRM snapshot says the ACCOUNT is "signed_in" (authentication) and a SERVICE is "ready"
// (fairplay, manager). Each word may only be compared with the field it belongs to.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['src/engine/auth.js', 'src/engine/verification-code.js', 'src/engine/account-sheet.js',
    'src/engine-playback.js', 'drm-autoauth.mjs', 'main.mjs'];

const comparisons = (text, word) => [...text.matchAll(new RegExp(`([\\w.?\\[\\]'"]+)\\s*[!=]==?\\s*'${word}'`, 'g'))].map(m => m[1]);

test('"signed_in" is only ever compared with the authentication field', () => {
    for (const f of FILES) {
        for (const lhs of comparisons(readFileSync(path.join(root, f), 'utf8'), 'signed_in')) {
            assert.match(lhs, /authentication$|^auth$/, `${f}: ${lhs} === 'signed_in'`);
        }
    }
});

test('"ready" is only ever compared with the fairplay or manager field', () => {
    for (const f of FILES) {
        for (const lhs of comparisons(readFileSync(path.join(root, f), 'utf8'), 'ready')) {
            if (/^(status|state)$/.test(lhs)) continue; // not a DRM snapshot field
            assert.match(lhs, /fairplay$|manager$|^fp$/, `${f}: ${lhs} === 'ready'`);
        }
    }
});

test('the old split vocabulary is gone', () => {
    for (const f of FILES) {
        const text = readFileSync(path.join(root, f), 'utf8');
        assert.doesNotMatch(text, /'logged_(in|out)'|'logging_in'/, f);
    }
});
