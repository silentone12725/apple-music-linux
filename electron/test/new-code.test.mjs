// Unit tests for the pure logic added to engine-playback.js and main.mjs.
// These files are a browser bundle / Electron main and can't be imported wholesale,
// so we extract each function's REAL source by name and eval it in a sandbox with
// only the constants/stubs it needs. That tests the shipped code, not a copy.
//
// Run:  node --test electron/test/new-code.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';

const dir = path.dirname(fileURLToPath(import.meta.url));
const PB  = readFileSync(path.join(dir, '..', 'src', 'engine-playback.js'), 'utf8');
const MAIN = readFileSync(path.join(dir, '..', 'main.mjs'), 'utf8');

// Extract a `function NAME(...) {...}` by brace-matching from the source.
function extractFn(src, name) {
    const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
    if (!m) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
        const ch = src[j];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
    }
    throw new Error('unbalanced braces: ' + name);
}

// Build a sandbox with the given prelude + extracted functions, return the context.
function sandbox(prelude, fnNames, src) {
    const code = prelude + '\n' + fnNames.map(n => extractFn(src, n)).join('\n');
    const ctx = { crypto, Buffer, DataView, Uint8Array, Float32Array, String, Math, Number, console };
    vm.createContext(ctx);
    vm.runInContext(code + '\n;globalThis.__ok=true;', ctx);
    return ctx;
}

// ── _xfAreSequential ──────────────────────────────────────────────────────────
test('_xfAreSequential: consecutive same-album tracks are sequential', () => {
    const ctx = sandbox('', ['_xfAreSequential'], PB);
    const A = { albumName: 'X', artistName: 'Q', discNumber: 1, trackNumber: 3 };
    const B = { albumName: 'X', artistName: 'Q', discNumber: 1, trackNumber: 4 };
    assert.equal(ctx._xfAreSequential(A, B), true);
    assert.equal(ctx._xfAreSequential(A, { ...B, albumName: 'Y' }), false, 'different album');
    assert.equal(ctx._xfAreSequential(A, { ...B, trackNumber: 5 }), false, 'gap >1');
    assert.equal(ctx._xfAreSequential(A, { ...B, artistName: 'Z' }), false, 'different artist');
    assert.equal(ctx._xfAreSequential(A, { ...B, trackNumber: undefined }), false, 'missing track#');
    assert.equal(ctx._xfAreSequential(null, B), false);
});

// ── _hotkeyActionFor ──────────────────────────────────────────────────────────
test('_hotkeyActionFor: matches bindings case-insensitively', () => {
    const ctx = sandbox("let _hotkeyBindings={playPause:' ',love:'l',seekForward:'ArrowRight'};",
        ['_hotkeyNormalize', '_hotkeyActionFor'], PB);
    assert.equal(ctx._hotkeyActionFor(' '), 'playPause');
    assert.equal(ctx._hotkeyActionFor('L'), 'love', 'letter case-insensitive');
    assert.equal(ctx._hotkeyActionFor('l'), 'love');
    assert.equal(ctx._hotkeyActionFor('ArrowRight'), 'seekForward');
    assert.equal(ctx._hotkeyActionFor('x'), null, 'unbound key');
});

// ── _xfAnalyzeEnding (adaptive fade length) ───────────────────────────────────
test('_xfAnalyzeEnding: abrupt ending → long fade, fade-out → short', () => {
    const ctx = sandbox('const XF_AUTO_SEC=6, XF_ADAPT_MAX=10, XF_ADAPT_MIN=2;', ['_xfAnalyzeEnding'], PB);
    const mk = (fill) => ({ sampleRate: 1000, duration: 4, getChannelData: () => fill });
    const abrupt = new Float32Array(4000).fill(0.5);
    assert.equal(ctx._xfAnalyzeEnding(mk(abrupt)), 10, 'constant-loud ending → max fade');

    const silent = new Float32Array(4000); // all zeros
    assert.equal(ctx._xfAnalyzeEnding(mk(silent)), 2, 'silent tail → min fade');

    const faded = new Float32Array(4000);
    for (let i = 0; i < faded.length; i++) faded[i] = 0.5 * (1 - i / faded.length); // ramp to ~0
    const d = ctx._xfAnalyzeEnding(mk(faded));
    assert.ok(d >= 2 && d < 10, `fading tail → shorter than max (got ${d})`);
});

// ── _scFindBox / _scParseLoudnessBase (ludt loudness parse) ───────────────────
test('ludt parser: extracts program loudness (V/4 − 57.75)', () => {
    const ctx = sandbox('', ['_scFindBox', '_scFindPath', '_scParseLoudnessBase'], PB);
    // Build moov > udta > ludt > tlou with methodValue=167 → -16.0 LKFS.
    const box = (type, payload) => {
        const size = 8 + payload.length;
        const b = new Uint8Array(size);
        new DataView(b.buffer).setUint32(0, size);
        for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
        b.set(payload, 8);
        return b;
    };
    // tlou payload: version(0)+flags(0,0,0), then 3 peak bytes, measCount=1, [methodDef=1, methodVal=167, reliability=0]
    const tlouPayload = new Uint8Array([0, 0, 0, 0,  0, 0, 0,  1,  1, 167, 0]);
    const tlou = box('tlou', tlouPayload);
    const ludt = box('ludt', tlou);
    const udta = box('udta', ludt);
    const moov = box('moov', udta);
    const dv = new DataView(moov.buffer);
    const path = ctx._scFindPath(dv, 0, dv.byteLength, ['moov', 'udta', 'ludt']);
    assert.ok(path, 'found ludt via path');
    const leaf = ctx._scFindBox(dv, path.start, path.end, 'tlou');
    assert.ok(leaf, 'found tlou');
    const lkfs = ctx._scParseLoudnessBase(dv, leaf.start, leaf.end);
    assert.ok(Math.abs(lkfs - (-16.0)) < 0.001, `expected -16.0, got ${lkfs}`);
});

test('ludt parser: 64-bit largesize near EOF does not throw', () => {
    const ctx = sandbox('', ['_scFindBox'], PB);
    // A box header claiming size===1 (64-bit) but truncated before the largesize.
    const b = new Uint8Array([0, 0, 0, 1, 0x6c, 0x75, 0x64, 0x74]); // size=1, 'ludt', nothing after
    const dv = new DataView(b.buffer);
    assert.doesNotThrow(() => ctx._scFindBox(dv, 0, dv.byteLength, 'ludt'));
    assert.equal(ctx._scFindBox(dv, 0, dv.byteLength, 'ludt'), null);
});

// ── _lastfmSign (Last.fm api_sig algorithm) ───────────────────────────────────
test('_lastfmSign: sorted, secret-suffixed md5; excludes format/callback', () => {
    const ctx = sandbox('', ['_lastfmSign'], MAIN);
    const sig = (p, s) => ctx._lastfmSign(p, s);
    // Independent reference implementation of the documented algorithm.
    const ref = (p, s) => {
        const keys = Object.keys(p).filter(k => k !== 'format' && k !== 'callback').sort();
        return crypto.createHash('md5').update(keys.map(k => k + p[k]).join('') + s, 'utf8').digest('hex');
    };
    const p = { method: 'auth.getToken', api_key: 'K' };
    assert.equal(sig(p, 'SEC'), ref(p, 'SEC'), 'matches documented algorithm');
    assert.match(sig(p, 'SEC'), /^[0-9a-f]{32}$/, '32 hex chars');
    // Order-independent (keys are sorted).
    assert.equal(sig({ a: '1', b: '2' }, 'S'), sig({ b: '2', a: '1' }, 'S'));
    // format/callback excluded from the signature.
    assert.equal(sig({ a: '1', format: 'json' }, 'S'), sig({ a: '1' }, 'S'));
    // Secret affects the result.
    assert.notEqual(sig(p, 'SEC'), sig(p, 'OTHER'));
});

// ── _discordEncode (Discord IPC framing) ──────────────────────────────────────
test('_discordEncode: [op LE][len LE][json]', () => {
    const ctx = sandbox('', ['_discordEncode'], MAIN);
    const payload = { v: 1, client_id: '123' };
    const frame = ctx._discordEncode(0, payload);
    assert.ok(Buffer.isBuffer(frame));
    assert.equal(frame.readInt32LE(0), 0, 'opcode');
    const len = frame.readInt32LE(4);
    const json = frame.slice(8).toString('utf8');
    assert.equal(len, Buffer.byteLength(json), 'length header matches body');
    assert.deepEqual(JSON.parse(json), payload, 'round-trips');
});

// ── _lbTrackMeta (ListenBrainz payload) ───────────────────────────────────────
test('_lbTrackMeta: maps fields; release only when present', () => {
    const ctx = sandbox('', ['_lbTrackMeta'], MAIN);
    // JSON-normalize: the object is built in the VM realm, so its prototype differs
    // from the test realm's — compare structure, not prototype identity.
    const norm = (o) => JSON.parse(JSON.stringify(o));
    assert.deepEqual(norm(ctx._lbTrackMeta({ artist: 'A', track: 'T', album: 'Al' })),
        { artist_name: 'A', track_name: 'T', release_name: 'Al' });
    assert.deepEqual(norm(ctx._lbTrackMeta({ artist: 'A', track: 'T' })),
        { artist_name: 'A', track_name: 'T' }, 'no release_name when album absent');
});
