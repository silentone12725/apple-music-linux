import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealLocal, openLocal } from '../local-secret.mjs';

const dir = () => path.join(mkdtempSync(path.join(tmpdir(), 'adam-secret-')), 'key');

test('a sealed secret opens again and is not readable in the stored text', () => {
    const o = { keyFile: dir(), id: 'machine-a' };
    const blob = sealLocal('hunter2-password', o);
    assert.ok(!blob.includes('hunter2'));
    assert.equal(openLocal(blob, o), 'hunter2-password');
    assert.notEqual(sealLocal('hunter2-password', o), blob, 'a fresh nonce each time');
});

test('the key file is private and reused', () => {
    const o = { keyFile: dir(), id: 'm' };
    const blob = sealLocal('x', o);
    assert.equal(statSync(o.keyFile).mode & 0o077, 0);
    const before = readFileSync(o.keyFile, 'utf8');
    assert.equal(openLocal(blob, o), 'x');
    assert.equal(readFileSync(o.keyFile, 'utf8'), before);
});

test('another machine, another key file, or a changed blob opens nothing', () => {
    const o = { keyFile: dir(), id: 'machine-a' };
    const blob = sealLocal('secret', o);
    assert.equal(openLocal(blob, { ...o, id: 'machine-b' }), null);
    assert.equal(openLocal(blob, { keyFile: dir(), id: 'machine-a' }), null);
    const bytes = Buffer.from(blob.slice(3), 'base64'); bytes[bytes.length - 1] ^= 1;
    assert.equal(openLocal('v1:' + bytes.toString('base64'), o), null);
    assert.equal(openLocal('plain', o), null);
    assert.equal(openLocal(undefined, o), null);
});

test('a damaged key file is refused rather than used', () => {
    const o = { keyFile: dir(), id: 'm' };
    writeFileSync(o.keyFile, 'short');
    assert.throws(() => sealLocal('x', o));
});
