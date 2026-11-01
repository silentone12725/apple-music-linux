import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validBackstop, writeBackstop, clearCredentialsFlow } from '../drm-signout.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'adam-signout-'));
const backstops = (dir) => fs.readdirSync(dir).filter(n => n.startsWith('logout-pending.backstop-'));

test('validBackstop accepts only the two scopes', () => {
    assert.equal(validBackstop('account'), 'account');
    assert.equal(validBackstop('device'), 'device');
    for (const v of [null, undefined, '', '1', 'Device', {}, 7]) assert.equal(validBackstop(v), null);
});

test('writeBackstop commits a uniquely named request durably', () => {
    const dir = tmpDir();
    // Directory handles cannot be fsynced on Windows, so stand one in for the directory fd.
    const DIR_FD = -7;
    const fakeFs = { ...fs,
        openSync(p, flags, mode) { return p === dir ? DIR_FD : fs.openSync(p, flags, mode); },
        fsyncSync(fd) { if (fd !== DIR_FD) fs.fsyncSync(fd); },
        closeSync(fd) { if (fd !== DIR_FD) fs.closeSync(fd); } };
    const r = writeBackstop(dir, 'device', { fs: fakeFs, platform: 'linux' });
    assert.deepEqual(r, { committed: true, durable: true });
    const [name] = backstops(dir);
    assert.match(name, /^logout-pending\.backstop-[0-9a-f]{32}$/);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'device');
});

test('Windows cannot fsync a directory: committed but not durable', () => {
    assert.deepEqual(writeBackstop(tmpDir(), 'account', { platform: 'win32' }), { committed: true, durable: false });
});

test('concurrent backstops never share a temp file', async () => {
    const dir = tmpDir();
    await Promise.all([
        Promise.resolve().then(() => writeBackstop(dir, 'account')),
        Promise.resolve().then(() => writeBackstop(dir, 'device')),
    ]);
    const files = backstops(dir);
    assert.equal(files.length, 2);
    assert.ok(files.every(n => !n.endsWith('.tmp')));
    assert.deepEqual(files.map(n => fs.readFileSync(path.join(dir, n), 'utf8')).sort(), ['account', 'device']);
});

test('a failure before the rename leaves nothing and reports not committed', () => {
    const dir = tmpDir();
    const r = writeBackstop(dir, 'account', { fs: { ...fs, renameSync() { throw new Error('EIO'); } } });
    assert.equal(r.committed, false);
    assert.deepEqual(fs.readdirSync(dir), []);
});

test('a directory fsync failure after the rename is committed but not durable', () => {
    const dir = tmpDir();
    let dirOpened = false;
    const fakeFs = { ...fs, openSync(p, flags, mode) { if (p === dir) { dirOpened = true; throw new Error('EIO'); } return fs.openSync(p, flags, mode); } };
    const r = writeBackstop(dir, 'account', { fs: fakeFs, platform: 'linux' });
    assert.ok(dirOpened);
    assert.equal(r.committed, true);
    assert.equal(r.durable, false);
    assert.equal(backstops(dir).length, 1);
});

function flowSpies({ committed = true, durable = true, deleteOk = true } = {}) {
    const calls = [];
    return {
        calls,
        record: (scope) => { calls.push(`record:${scope}`); return { committed, durable }; },
        deleteCredentials: async () => { calls.push('delete'); return deleteOk; },
        reloadEngine: () => calls.push('reload'),
    };
}

test('engine route ok: no backstop, credentials removed, then reload', async () => {
    const s = flowSpies();
    assert.deepEqual(await clearCredentialsFlow({ backstop: null, ...s }), { ok: true });
    assert.deepEqual(s.calls, ['delete', 'reload']);
});

test('engine route failed: backstop recorded first, then credentials, then reload', async () => {
    const s = flowSpies();
    assert.deepEqual(await clearCredentialsFlow({ backstop: 'device', ...s }), { ok: true });
    assert.deepEqual(s.calls, ['record:device', 'delete', 'reload']);
});

test('an unrecorded backstop stops everything', async () => {
    const s = flowSpies({ committed: false });
    assert.deepEqual(await clearCredentialsFlow({ backstop: 'account', ...s }), { ok: false, error: 'marker' });
    assert.deepEqual(s.calls, ['record:account']);
});

test('a committed but not durable backstop proceeds with a warning', async () => {
    const s = flowSpies({ durable: false });
    assert.deepEqual(await clearCredentialsFlow({ backstop: 'account', ...s }), { ok: true, warning: 'durability' });
    assert.deepEqual(s.calls, ['record:account', 'delete', 'reload']);
});

test('credentials that cannot be removed: no reload', async () => {
    const s = flowSpies({ deleteOk: false });
    assert.deepEqual(await clearCredentialsFlow({ backstop: null, ...s }), { ok: false, error: 'credentials' });
    assert.deepEqual(s.calls, ['delete']);
});

test('an abandoned sign-in (reload false) only forgets credentials', async () => {
    const s = flowSpies();
    assert.deepEqual(await clearCredentialsFlow({ reload: false, backstop: 'device', ...s }), { ok: true });
    assert.deepEqual(s.calls, ['delete']);
});

test('an invalid backstop scope is ignored', async () => {
    const s = flowSpies();
    await clearCredentialsFlow({ backstop: '1', ...s });
    assert.deepEqual(s.calls, ['delete', 'reload']);
});
