import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { parseLock, fetchFairPlayLibs } from '../fairplay-fetch.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function setup(files) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fp-'));
    const lock = Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}`).join('\n');
    writeFileSync(path.join(dir, 'lock'), `# c\nsource https://a.example/x/\nsource https://b.example/y\n${lock}\n`);
    const stubs = path.join(dir, 'stubs'); 
    return { dir, lockPath: path.join(dir, 'lock'), stubsDir: stubs, dest: path.join(dir, 'lib64') };
}

test('parseLock reads sources and entries', () => {
    const h = 'a'.repeat(64);
    const r = parseLock(`# x\nsource https://a/b/\nsource http://insecure/x\n${h}  libz.so\nbad  line.so\n`);
    assert.deepEqual(r.sources, ['https://a/b']);
    assert.deepEqual(r.entries, [{ sha256: h, name: 'libz.so' }]);
});

test('downloads, verifies and falls back to the second source', async () => {
    const files = { 'libz.so': Buffer.from('zzz') };
    const t = setup(files);
    const fs = await import('node:fs'); fs.mkdirSync(t.stubsDir, { recursive: true });
    for (const n of ['libandroid.so', 'libOpenSLES.so', 'libdl.so']) fs.writeFileSync(path.join(t.stubsDir, n), 'stub');
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        if (url.startsWith('https://a.example')) return { ok: true, arrayBuffer: async () => Buffer.from('tampered') };
        return { ok: true, arrayBuffer: async () => files['libz.so'] };
    };
    const r = await fetchFairPlayLibs({ ...t, fetchImpl });
    assert.equal(r.ok, true);
    assert.equal(readFileSync(path.join(t.dest, 'libz.so'), 'utf8'), 'zzz');
    assert.ok(existsSync(path.join(t.dest, 'libdl.so')));
    assert.deepEqual(calls, ['https://a.example/x/libz.so', 'https://b.example/y/libz.so']);
    assert.equal(readdirSync(t.dest).some(n => n.endsWith('.part')), false);
    // second run downloads nothing
    calls.length = 0;
    assert.equal((await fetchFairPlayLibs({ ...t, fetchImpl })).fetched, 0);
    assert.equal(calls.length, 0);
});

test('reports failure and leaves no file when no source matches', async () => {
    const t = setup({ 'libz.so': Buffer.from('zzz') });
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => Buffer.from('nope') });
    const r = await fetchFairPlayLibs({ ...t, fetchImpl });
    assert.equal(r.ok, false);
    assert.ok(r.failed.includes('libz.so'));
    assert.equal(existsSync(path.join(t.dest, 'libz.so')), false);
});
