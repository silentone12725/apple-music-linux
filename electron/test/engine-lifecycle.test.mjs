// Adapted from silentone12725/apple-music-linux PR #1 (https://github.com/silentone12725/apple-music-linux/pull/1), Adam naming.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngineLifecycle, isOwnedOrphan, isOwnedOrphanWindows, isPortFree, pidAlive, recoverOrphanEngine } from '../engine-lifecycle.mjs';

const noop = () => {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeChild() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.signals = [];
    proc.kill = signal => {
        proc.signals.push(signal);
        proc.signalCode = signal;
        proc.emit('exit', null, signal);
        proc.emit('close', null, signal);
    };
    return proc;
}

test('concurrent starts share one preparation and one child', async () => {
    let prepareCount = 0;
    let spawnCount = 0;
    const proc = fakeChild();
    const lifecycle = createEngineLifecycle({
        prepare: async () => { prepareCount++; await wait(10); },
        spawn: () => { spawnCount++; return proc; }, log: noop,
    });
    await Promise.all([lifecycle.start(), lifecycle.start(), lifecycle.start()]);
    assert.equal(prepareCount, 1);
    assert.equal(spawnCount, 1);
    await lifecycle.stop();
    assert.deepEqual(proc.signals, ['SIGTERM']);
});

test('quit during async preparation prevents spawning', async () => {
    let finishPrepare;
    let spawnCount = 0;
    const lifecycle = createEngineLifecycle({
        prepare: () => new Promise(resolve => { finishPrepare = resolve; }),
        spawn: () => { spawnCount++; return fakeChild(); }, log: noop,
    });
    const starting = lifecycle.start();
    const stopping = lifecycle.stop();
    finishPrepare();
    await Promise.all([starting, stopping]);
    await lifecycle.start();
    assert.equal(spawnCount, 0);
});

test('stop cancels pending crash restart', async () => {
    let spawnCount = 0;
    const proc = fakeChild();
    const lifecycle = createEngineLifecycle({
        prepare: async () => {}, spawn: () => { spawnCount++; return proc; },
        restartDelay: 5, log: noop,
    });
    await lifecycle.start();
    proc.emit('exit', 1, null);
    await lifecycle.stop();
    await wait(25);
    assert.equal(spawnCount, 1);
});

test('runtime crash restarts once, duplicate exit does not schedule another child', async () => {
    let spawnCount = 0;
    const first = fakeChild();
    const lifecycle = createEngineLifecycle({
        prepare: async () => {}, spawn: () => { spawnCount++; return spawnCount === 1 ? first : fakeChild(); },
        restartDelay: 5, log: noop,
    });
    await lifecycle.start();
    first.emit('exit', 1, null);
    first.emit('exit', 1, null);
    await wait(25);
    assert.equal(spawnCount, 2);
    await lifecycle.stop();
});

test('real spawn ENOENT is caught and reported without repeated retries', async () => {
    const errors = [];
    let spawnCount = 0;
    const lifecycle = createEngineLifecycle({
        prepare: async () => {},
        spawn: () => { spawnCount++; return spawn('/nonexistent/aml-test-engine'); },
        onError: error => errors.push(error), restartDelay: 5, log: noop,
    });
    await lifecycle.start();
    await wait(30);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'ENOENT');
    assert.equal(spawnCount, 1);
    await lifecycle.stop();
});

test('shutdown waits for SIGTERM and escalates only for an unresponsive child', async () => {
    const proc = fakeChild();
    proc.kill = signal => {
        proc.signals.push(signal);
        if (signal === 'SIGKILL') {
            proc.signalCode = signal;
            proc.emit('exit', null, signal);
            proc.emit('close', null, signal);
        }
    };
    const lifecycle = createEngineLifecycle({
        prepare: async () => {}, spawn: () => proc, log: noop, killDelay: 5,
    });
    await lifecycle.start();
    await lifecycle.stop();
    assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
});

test('occupied localhost port is detected without external ss command', async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try { assert.equal(await isPortFree(port), false); }
    finally { await new Promise(resolve => server.close(resolve)); }
    assert.equal(await isPortFree(port), true);
});

const UID = process.getuid ? process.getuid() : 0; // /proc checks are Linux-only
function processFixture({ parent = 1, uid = UID, inode = 100, cwd = 200, args = 'engine\x00--api\x0020025\x00' } = {}) {
    return {
        readFileSync: filename => {
            if (filename.endsWith('/status')) return `PPid:\t${parent}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
            if (filename.endsWith('/cmdline')) return args;
            throw new Error('missing');
        },
        statSync: filename => ({ dev: 1, ino: filename.endsWith('/exe') ? inode : filename.endsWith('/cwd') ? cwd : filename === '/engine' ? 100 : 200 }),
    };
}

test('recovery accepts only our exact orphan and rejects active or unrelated owners', { skip: process.platform === 'win32' }, () => {
    const check = fs => isOwnedOrphan(123456, '/engine', '/data', 20025, fs);
    assert.equal(check(processFixture()), true);
    assert.equal(check(processFixture({ parent: process.pid })), false);
    assert.equal(check(processFixture({ uid: UID + 1 })), false);
    assert.equal(check(processFixture({ inode: 999 })), false);
    assert.equal(check(processFixture({ cwd: 999 })), false);
    assert.equal(check(processFixture({ args: 'engine\x00--api\x0010000\x00' })), false);
    assert.equal(isOwnedOrphan(process.pid, '/engine', '/data', 20025, processFixture()), false);
    assert.equal(isOwnedOrphan(0, '/engine', '/data', 20025, processFixture()), false);
});

test('recovery leaves an active owner and the lock file untouched', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'adam-lock-test-'));
    const lockPath = path.join(directory, 'engine-session.lock');
    writeFileSync(lockPath, `${process.pid}\n`);
    const inode = statSync(lockPath).ino;
    try {
        await recoverOrphanEngine({ lockPath, binary: process.execPath, dataDir: process.cwd(), port: 20025, log: noop });
        assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
        assert.equal(statSync(lockPath).ino, inode);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('windows recovery accepts only our exact engine image and port', async () => {
    const bin = 'C:\\Program Files\\Adam\\resources\\engine.exe';
    const q = info => async () => info;
    const ok = { exe: bin.toLowerCase(), cmdline: `"${bin}" --api 20025` };
    assert.equal(await isOwnedOrphanWindows(4242, bin, 20025, q(ok)), true);
    assert.equal(await isOwnedOrphanWindows(4242, bin, 20025, q({ ...ok, exe: 'C:\\Windows\\notepad.exe' })), false);
    assert.equal(await isOwnedOrphanWindows(4242, bin, 20025, q({ ...ok, cmdline: `"${bin}" --api 20026` })), false);
    assert.equal(await isOwnedOrphanWindows(4242, bin, 20025, q({ ...ok, cmdline: `"${bin}" --api 200250` })), false);
    assert.equal(await isOwnedOrphanWindows(4242, bin, 20025, q(null)), false);
    assert.equal(await isOwnedOrphanWindows(process.pid, bin, 20025, q(ok)), false);
    assert.equal(await isOwnedOrphanWindows(4, bin, 20025, q(ok)), false);
});

test('windows recovery never touches an unowned lock holder', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'adam-lock-win-'));
    const lockPath = path.join(directory, 'engine-session.lock');
    writeFileSync(lockPath, '4242\n');
    try {
        await recoverOrphanEngine({ lockPath, binary: 'C:\\x\\engine.exe', dataDir: directory, port: 20025, log: noop,
            plat: 'win32', query: async () => ({ exe: 'C:\\other.exe', cmdline: 'other --api 20025' }) });
        assert.equal(readFileSync(lockPath, 'utf8'), '4242\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('reload restarts a running engine and is a no-op once stopped', async () => {
    const children = [];
    const lifecycle = createEngineLifecycle({
        prepare: async () => {},
        spawn: () => { const c = fakeChild(); children.push(c); return c; },
        log: noop, restartDelay: 5,
    });
    await lifecycle.start();
    lifecycle.reload();
    assert.deepEqual(children[0].signals, ['SIGTERM']);
    await wait(30);
    assert.equal(children.length, 2, 'the engine must come back after a reload');

    await lifecycle.stop();
    lifecycle.reload();
    await wait(30);
    assert.equal(children.length, 2, 'reload after stop must not start a new engine');
});

test('reload restarts at once instead of with the crash backoff', async () => {
    const children = [];
    const lifecycle = createEngineLifecycle({
        prepare: async () => {},
        spawn: () => { const c = fakeChild(); children.push(c); return c; },
        log: noop, restartDelay: 200,
    });
    await lifecycle.start();
    lifecycle.reload();
    await wait(60);
    assert.equal(children.length, 2, 'a reload must not wait for the restart delay');
    lifecycle.reload();
    await wait(60);
    assert.equal(children.length, 3, 'a second reload of a young engine must not back off either');

    children[2].emit('exit', 1, null);   // a crash still waits for the backoff
    await wait(60);
    assert.equal(children.length, 3, 'a crash must still wait for the backoff');
    await lifecycle.stop();
});

test('pidAlive treats a missing process as gone and a foreign one as alive', () => {
    const throwing = code => () => { const e = new Error(code); e.code = code; throw e; };
    assert.equal(pidAlive(4242, () => true), true);
    assert.equal(pidAlive(4242, throwing('ESRCH')), false);
    assert.equal(pidAlive(4242, throwing('EPERM')), true);
});

test('recovery skips the ownership check when the recorded engine is gone', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'adam-lock-gone-'));
    const lockPath = path.join(directory, 'engine-session.lock');
    writeFileSync(lockPath, '4242\n');
    let queried = false;
    try {
        await recoverOrphanEngine({ lockPath, binary: 'C:\\x\\engine.exe', dataDir: directory, port: 20025, log: noop,
            plat: 'win32', alive: () => false, query: async () => { queried = true; return null; } });
        assert.equal(queried, false, 'a dead pid must not start a PowerShell query');
        assert.equal(readFileSync(lockPath, 'utf8'), '4242\n');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
