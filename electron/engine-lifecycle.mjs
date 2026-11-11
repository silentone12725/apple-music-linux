// Engine process ownership and lifecycle. Originally from the pull request by Flavio Giacchetti
// (silentone12725/apple-music-linux#1), adapted for Adam: Windows ownership check, Adam naming.
import { readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

// A PID in a lock file (or a process listening on our port) is not proof of
// ownership. Recover only an orphan of this exact executable and data directory.
// Linux: reads /proc.
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

// Windows: the image path and command line must be ours. `query` returns
// { exe, cmdline } for a pid, or null when the process is gone.
export function queryWindowsProcess(pid) {
    return new Promise(resolve => {
        const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; ` +
            `if ($p) { ConvertTo-Json -Compress @{ exe = $p.ExecutablePath; cmdline = $p.CommandLine } }`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', timeout: 8000, windowsHide: true }, (err, out) => {
                if (err || !out.trim()) return resolve(null);
                try { resolve(JSON.parse(out)); } catch { resolve(null); }
            });
    });
}

export async function isOwnedOrphanWindows(pid, binary, port, query = queryWindowsProcess) {
    if (!Number.isSafeInteger(pid) || pid <= 4 || pid === process.pid) return false;
    const info = await query(pid);
    if (!info?.exe || !info.cmdline) return false;
    if (path.resolve(info.exe).toLowerCase() !== path.resolve(binary).toLowerCase()) return false;
    return new RegExp(`--api\\s+"?${Number(port)}"?(\\s|$)`).test(info.cmdline);
}

// Signal 0 checks existence only. EPERM means the process exists but is not ours.
export function pidAlive(pid, kill = process.kill.bind(process)) {
    try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

export async function recoverOrphanEngine({ lockPath, binary, dataDir, port, log = console.log,
    plat = process.platform, query = queryWindowsProcess, alive = pidAlive }) {
    let pid;
    try {
        const owner = readFileSync(lockPath, 'utf8').trim();
        if (!/^\d+$/.test(owner)) return;
        pid = Number(owner);
    } catch { return; }
    // The lock file keeps the last engine's pid after a clean exit, so this runs on
    // almost every launch. A gone process needs no ownership check (on Windows that
    // check starts PowerShell: ~0.2 s, more when cold).
    if (!alive(pid)) return;
    const owned = async () => (plat === 'win32'
        ? isOwnedOrphanWindows(pid, binary, port, query)
        : isOwnedOrphan(pid, binary, dataDir, port));
    if (!(await owned())) return;
    log(`[Adam] Stopping orphan engine (pid ${pid})`);
    // Windows has no SIGTERM: Node maps any signal to TerminateProcess.
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!(await owned())) return;
    }
    // Recheck ownership immediately before escalation; never unlink the lock
    // file, since a replacement inode would allow concurrent session owners.
    if (await owned()) {
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
    let reloading = false;
    const quitting = () => stopped || isQuitting();
    const restart = (startedAt) => {
        if (quitting() || restartTimer) return;
        // A reload asked for this exit: come back at once. The backoff is for crashes,
        // and it doubled for every reload of an engine younger than 30 s.
        let delay = 0;
        if (reloading) {
            reloading = false;
        } else {
            backoff = Date.now() - startedAt > 30_000 ? restartDelay : Math.min(backoff * 2, 30_000);
            delay = backoff;
            log(`[Adam] Restarting engine in ${delay} ms`);
        }
        restartTimer = setTimeout(() => {
            restartTimer = null;
            if (!quitting()) void start();
        }, delay);
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
                    log(`[Adam] Engine exited (code ${code}, signal ${signal})`);
                    finish();
                });
                proc.once('spawn', () => log(`[Adam] Engine started (pid ${proc.pid})`));
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
    // Restart a running engine (e.g. so it picks up newly installed libraries): the
    // exit handler's normal restart path brings it back.
    function reload() {
        if (quitting() || !child) return;
        reloading = true;
        try { child.kill('SIGTERM'); } catch { reloading = false; }
    }
    return { start, stop, reload };
}
