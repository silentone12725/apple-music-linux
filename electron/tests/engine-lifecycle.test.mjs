import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngineLifecycle, isOwnedOrphan, isPortFree, recoverOrphanEngine } from '../engine-lifecycle.mjs';

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

function processFixture({ parent = 1, uid = process.getuid(), inode = 100, cwd = 200, args = 'engine\x00--api\x0020025\x00' } = {}) {
    return {
        readFileSync: filename => {
            if (filename.endsWith('/status')) return `PPid:\t${parent}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
            if (filename.endsWith('/cmdline')) return args;
            throw new Error('missing');
        },
        statSync: filename => ({ dev: 1, ino: filename.endsWith('/exe') ? inode : filename.endsWith('/cwd') ? cwd : filename === '/engine' ? 100 : 200 }),
    };
}

test('recovery accepts only our exact orphan and rejects active or unrelated owners', () => {
    const check = fs => isOwnedOrphan(123456, '/engine', '/data', 20025, fs);
    assert.equal(check(processFixture()), true);
    assert.equal(check(processFixture({ parent: process.pid })), false);
    assert.equal(check(processFixture({ uid: process.getuid() + 1 })), false);
    assert.equal(check(processFixture({ inode: 999 })), false);
    assert.equal(check(processFixture({ cwd: 999 })), false);
    assert.equal(check(processFixture({ args: 'engine\x00--api\x0010000\x00' })), false);
    assert.equal(isOwnedOrphan(process.pid, '/engine', '/data', 20025, processFixture()), false);
    assert.equal(isOwnedOrphan(0, '/engine', '/data', 20025, processFixture()), false);
});

test('recovery leaves an active owner and the flock inode untouched', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'aml-lock-test-'));
    const lockPath = path.join(directory, 'engine-session.lock');
    writeFileSync(lockPath, `${process.pid}\n`);
    const inode = statSync(lockPath).ino;
    try {
        await recoverOrphanEngine({ lockPath, binary: process.execPath, dataDir: process.cwd(), port: 20025, log: noop });
        assert.equal(readFileSync(lockPath, 'utf8'), `${process.pid}\n`);
        assert.equal(statSync(lockPath).ino, inode);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
