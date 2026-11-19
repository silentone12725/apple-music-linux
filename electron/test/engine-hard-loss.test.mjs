// Hard loss: the app disappears without any chance to run its quit code (kill -9 on Linux,
// TerminateProcess on Windows, a crash). The engine must still notice and stop by itself, because it
// holds the read end of a pipe whose write end is the app's. These run the real engine binary; they are
// skipped when none is built (set ADAM_TEST_ENGINE to point at one, e.g. engine.exe on Windows).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngineLifecycle } from '../engine-lifecycle.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';
const BIN = process.env.ADAM_TEST_ENGINE ||
    path.join(here, '..', 'dist', 'resources', IS_WIN ? 'engine.exe' : 'engine');
const skip = existsSync(BIN) ? false : `no engine binary at ${BIN}`;

const wait = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function until(cond, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await wait(100); } return false; }
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const listening = port => new Promise(res => { const c = net.connect(port, '127.0.0.1'); c.once('connect', () => { c.destroy(); res(true); }); c.once('error', () => res(false)); });

// A scratch home so the engine never touches the real configuration or caches.
function sandbox() {
    const home = mkdtempSync(path.join(os.tmpdir(), 'adam-hard-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'c'), XDG_CACHE_HOME: path.join(home, 'k'),
        APPDATA: path.join(home, 'a'), LOCALAPPDATA: path.join(home, 'l'), ADAM_EXIT_ON_STDIN_EOF: '1' };
    const cwd = path.join(home, 'cwd'); mkdirSync(cwd);
    return { home, env, cwd, done: () => rmSync(home, { recursive: true, force: true }) };
}
const startEngine = (sb, port, opts = {}) => spawn(BIN, ['--api', String(port)], { cwd: sb.cwd, env: sb.env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, ...opts });
const kill = pid => IS_WIN ? spawnSync('taskkill', ['/F', '/PID', String(pid)]) : process.kill(pid, 'SIGKILL');

test('closing the engine\'s stdin stops it cleanly', { skip }, async () => {
    const sb = sandbox(), port = await freePort();
    const engine = startEngine(sb, port);
    try {
        assert.ok(await until(() => listening(port), 20000), 'engine did not start listening');
        const code = new Promise(res => engine.once('exit', c => res(c)));
        engine.stdin.end();
        const result = await Promise.race([code, wait(15000).then(() => 'timeout')]);
        assert.equal(result, 0, 'engine must exit 0 after its stdin closes');
    } finally { try { engine.kill('SIGKILL'); } catch {} sb.done(); }
});

test('the engine stops by itself when the app is killed outright', { skip }, async () => {
    const sb = sandbox(), port = await freePort();
    // The "app": a process that starts the engine with a pipe on its stdin and then idles.
    const app = spawn(process.execPath, ['-e', `
        const { spawn } = require('child_process');
        const e = spawn(${JSON.stringify(BIN)}, ['--api', ${JSON.stringify(String(port))}], { cwd: ${JSON.stringify(sb.cwd)}, env: process.env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
        console.log('PID ' + e.pid);
        setInterval(() => {}, 1000);`], { env: sb.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let enginePid = null;
    try {
        enginePid = await new Promise((res, rej) => {
            app.stdout.on('data', d => { const m = /PID (\d+)/.exec(String(d)); if (m) res(Number(m[1])); });
            setTimeout(() => rej(new Error('the stand-in app never reported the engine pid')), 10000);
        });
        assert.ok(await until(() => listening(port), 20000), 'engine did not start listening');
        kill(app.pid); // no quit code runs
        assert.ok(await until(() => !alive(enginePid), 20000), 'the engine outlived its killed parent');
    } finally { if (enginePid && alive(enginePid)) { try { kill(enginePid); } catch {} } try { kill(app.pid); } catch {} sb.done(); }
});

test('a start after a hard kill sweeps the dead run\'s unfinished downloads', { skip }, async () => {
    const sb = sandbox(), port = await freePort();
    const cacheRoot = IS_WIN ? sb.env.LOCALAPPDATA : sb.env.XDG_CACHE_HOME;
    const playback = path.join(cacheRoot, 'adam', 'playback');
    mkdirSync(playback, { recursive: true });
    writeFileSync(path.join(playback, '111-alac.m4a.tmp'), 'partial');
    writeFileSync(path.join(playback, '222-aac.m4a'), 'finished');
    const engine = startEngine(sb, port);
    try {
        assert.ok(await until(() => listening(port), 20000), 'engine did not start listening');
        const left = readdirSync(playback);
        assert.ok(!left.includes('111-alac.m4a.tmp'), `orphaned download kept: ${left}`);
        assert.ok(left.includes('222-aac.m4a'), 'a finished entry must stay');
    } finally { try { engine.stdin.end(); } catch {} await wait(500); try { engine.kill('SIGKILL'); } catch {} sb.done(); }
});

test('a normal quit through the lifecycle lets the engine exit by itself (no forced kill)', { skip }, async () => {
    const sb = sandbox(), port = await freePort();
    let engine, exit;
    const lifecycle = createEngineLifecycle({
        prepare: async () => {}, log: () => {}, killDelay: 8000,
        spawn: () => {
            engine = startEngine(sb, port);
            exit = new Promise(res => engine.once('exit', (code, signal) => res({ code, signal })));
            return engine;
        },
    });
    try {
        await lifecycle.start();
        assert.ok(await until(() => listening(port), 20000), 'engine did not start listening');
        await lifecycle.stop();
        // A forced kill gives a signal on Linux and a non-zero code on Windows: only its own stop gives 0.
        assert.deepEqual(await Promise.race([exit, wait(5000).then(() => 'timeout')]), { code: 0, signal: null });
    } finally { try { engine.kill('SIGKILL'); } catch {} sb.done(); }
});
