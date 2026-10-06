import { readFileSync, statSync } from 'node:fs';
import net from 'node:net';

// A PID in a lock file (or a process listening on our port) is not proof of
// ownership. Recover only an orphan of this exact executable and data directory.
export function isOwnedOrphan(pid, binary, dataDir, port, fs = { readFileSync, statSync }) {
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        if (!/^PPid:\s+1$/m.test(status)) return false;
        const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
        if (uid !== process.getuid()) return false;
        const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
        if (!sameFile(fs.statSync(`/proc/${pid}/exe`), fs.statSync(binary))) return false;
        if (!sameFile(fs.statSync(`/proc/${pid}/cwd`), fs.statSync(dataDir))) return false;
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        const index = args.indexOf('--api');
        return index > 0 && args[index + 1] === String(port);
    } catch { return false; }
}

export async function recoverOrphanEngine({ lockPath, binary, dataDir, port, log = console.log }) {
    let pid;
    try {
        const owner = readFileSync(lockPath, 'utf8').trim();
        if (!/^\d+$/.test(owner)) return;
        pid = Number(owner);
    } catch { return; }
    if (!isOwnedOrphan(pid, binary, dataDir, port)) return;
    log(`[AML] Stopping orphan engine (pid ${pid})`);
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!isOwnedOrphan(pid, binary, dataDir, port)) return;
    }
    // Recheck ownership immediately before escalation; never unlink the flock
    // file, since a replacement inode would allow concurrent session owners.
    if (isOwnedOrphan(pid, binary, dataDir, port)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
    }
}

export function isPortFree(port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
            server.close(() => resolve(true));
        });
    });
}

// Keep async preparation, child events and restart timers under one owner.
export function createEngineLifecycle({ prepare, spawn, onOutput = () => {}, onStderr = () => {},
    onError = console.error, log = console.log, isQuitting = () => false,
    restartDelay = 1000, killDelay = 800 }) {
    let child = null;
    let starting = null;
    let stopped = false;
    let restartTimer = null;
    let backoff = restartDelay;
    const quitting = () => stopped || isQuitting();
    const restart = (startedAt) => {
        if (quitting() || restartTimer) return;
        backoff = Date.now() - startedAt > 30_000 ? restartDelay : Math.min(backoff * 2, 30_000);
        log(`[AML] Restarting engine in ${backoff} ms`);
        restartTimer = setTimeout(() => {
            restartTimer = null;
            if (!quitting()) void start();
        }, backoff);
    };
    function start() {
        if (quitting() || child) return Promise.resolve();
        if (starting) return starting;
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        starting = (async () => {
            try {
                await prepare();
                if (quitting()) return;
                const proc = spawn();
                child = proc;
                const startedAt = Date.now();
                let finished = false;
                const finish = (retry = true) => {
                    if (finished) return;
                    finished = true;
                    if (child === proc) child = null;
                    if (retry) restart(startedAt);
                };
                // Failed exec (ENOENT/EACCES) needs a user-visible error, not an
                // endless series of retry dialogs. Runtime exits still restart.
                proc.once('error', error => { onError(error); finish(false); });
                proc.once('exit', (code, signal) => {
                    log(`[AML] Engine exited (code ${code}, signal ${signal})`);
                    finish();
                });
                proc.once('spawn', () => log(`[AML] Engine started (pid ${proc.pid})`));
                proc.stdout?.on('data', onOutput);
                proc.stderr?.on('data', onStderr);
            } catch (error) { onError(error); }
        })().finally(() => { starting = null; });
        return starting;
    }
    async function stop() {
        stopped = true;
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        if (starting) await starting;
        const proc = child;
        if (!proc) return;
        child = null;
        await new Promise(resolve => {
            let timer;
            let deadline;
            const done = () => {
                clearTimeout(timer);
                clearTimeout(deadline);
                resolve();
            };
            proc.once('close', done);
            timer = setTimeout(() => {
                if (proc.exitCode == null && proc.signalCode == null) {
                    try { proc.kill('SIGKILL'); } catch {}
                }
            }, killDelay);
            deadline = setTimeout(done, killDelay + 800);
            try { proc.kill('SIGTERM'); } catch { done(); }
        });
    }
    return { start, stop };
}
