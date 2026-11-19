import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensurePrivateDir, isWithin } from '../private-fs.mjs';

const posix = process.platform !== 'win32';
const mode = p => statSync(p).mode & 0o777;

test('creates a missing directory for this user only, parents included', { skip: !posix }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'adam-pfs-'));
    const dir = path.join(root, 'a', 'b');
    ensurePrivateDir(dir);
    assert.equal(mode(dir), 0o700);
});

test('tightens a directory an older version left open', { skip: !posix }, () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'adam-pfs-')), 'logs');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    assert.equal(mode(dir), 0o700);
});

test('does not follow a symlink to change another directory', { skip: !posix }, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'adam-pfs-'));
    const target = path.join(root, 'target');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    const link = path.join(root, 'link');
    symlinkSync(target, link);
    ensurePrivateDir(link);
    assert.equal(mode(target), 0o755);
});

test('isWithin accepts files under the root and refuses anything that resolves outside it', { skip: !posix }, () => {
    const base = mkdtempSync(path.join(tmpdir(), 'adam-pfs-'));
    const root = path.join(base, 'cache'), outside = path.join(base, 'secret.txt');
    mkdirSync(root);
    writeFileSync(path.join(root, 'a.mp4'), 'x');
    writeFileSync(outside, 'x');
    symlinkSync(outside, path.join(root, 'link.mp4'));
    assert.equal(isWithin(root, path.join(root, 'a.mp4')), true);
    assert.equal(isWithin(root, path.join(root, 'link.mp4')), false, 'a symlink out of the cache');
    assert.equal(isWithin(root, path.join(root, '..', 'secret.txt')), false);
    assert.equal(isWithin(root, root), false, 'the root itself is not a file in it');
    assert.equal(isWithin(root, path.join(root, 'missing.mp4')), false);
    assert.equal(isWithin(root + '-evil', path.join(root, 'a.mp4')), false);
});
