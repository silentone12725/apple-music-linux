'use strict';

const pty  = require('node-pty');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const net  = require('net');

const WRAPPER_SRC = (() => {
    const pkgBin = path.join(process.resourcesPath, 'wrapper');
    if (fs.existsSync(pkgBin)) return pkgBin;
    return path.join(__dirname, '..', 'Wrapper.x86_64.latest', 'wrapper-rootless');
})();

const DATA_DIR    = path.join(os.homedir(), '.config', 'apple-music-linux', 'wrapper-data');
const PROXY_PORT = 10020;

// Health statuses exposed to the menu and renderer.
const STATUS = { STARTING: 'starting', RUNNING: 'running', OFFLINE: 'offline' };

class WrapperProc {
    /**
     * @param {(data: string) => void} onData   - PTY output callback
     * @param {(code: number) => void} onExit   - process exit callback
     * @param {(status: string) => void} onHealth - health-change callback
     */
    constructor(onData, onExit, onHealth) {
        this._onData   = onData;
        this._onExit   = onExit;
        this._onHealth = onHealth;
        this._pty      = null;
        this._status   = STATUS.OFFLINE;
        this._healthTimer = null;
    }

    get status() { return this._status; }
    get alive()  { return this._pty !== null; }

    start(login = '') {
        fs.mkdirSync(DATA_DIR, { recursive: true });

        if (!fs.existsSync(WRAPPER_SRC)) {
            this._emit(`[WrapperProc] binary not found at ${WRAPPER_SRC}\r\n`);
            return;
        }

        const args = ['-H', '127.0.0.1'];
        if (login) args.push('-L', login);

        this._setStatus(STATUS.STARTING);
        this._pty = pty.spawn(WRAPPER_SRC, args, {
            name: 'xterm-256color', cols: 80, rows: 24,
            cwd: DATA_DIR, env: process.env,
        });

        this._emit(`[WrapperProc] Started PID ${this._pty.pid}\r\n`);
        this._pty.onData((data) => this._emit(data));

        this._pty.onExit(({ exitCode }) => {
            this._emit(`\r\n[WrapperProc] Process exited (code ${exitCode ?? 0})\r\n`);
            this._pty = null;
            this._stopHealthCheck();
            this._setStatus(STATUS.OFFLINE);
            if (this._onExit) this._onExit(exitCode ?? 0);
        });

        // Start health monitoring after a short startup grace period.
        setTimeout(() => this._startHealthCheck(), 3000);
    }

    write(data) { if (this._pty) this._pty.write(data); }

    resize(cols, rows) {
        // Validated by IPC handler — just clamp as extra safety.
        if (this._pty)
            this._pty.resize(
                Math.max(10, Math.min(300, cols)),
                Math.max(5,  Math.min(100, rows))
            );
    }

    stop() {
        this._stopHealthCheck();
        if (this._pty) { this._pty.kill(); this._pty = null; }
        this._setStatus(STATUS.OFFLINE);
    }

    // ── Health check ────────────────────────────────────────────────────────
    // Periodically probe the wrapper's HTTP proxy ports.  A successful TCP
    // connection means the proxy is up and accepting connections.
    _startHealthCheck() {
        if (this._healthTimer) return;
        this._healthTimer = setInterval(() => this._checkHealth(), 5000);
        this._checkHealth();
    }

    _stopHealthCheck() {
        if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    }

    async _checkHealth() {
        if (!this._pty) return;
        const alive = await probePort(PROXY_PORT);
        this._setStatus(alive ? STATUS.RUNNING : STATUS.STARTING);
    }

    _setStatus(s) {
        if (s === this._status) return;
        this._status = s;
        if (this._onHealth) this._onHealth(s);
    }

    _emit(data) { if (this._onData) this._onData(data); }
}

// TCP probe — resolves true if port accepts a connection within 400 ms.
function probePort(port) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        const done = (v) => { sock.destroy(); resolve(v); };
        sock.setTimeout(400);
        sock.once('connect', () => done(true));
        sock.once('error',   () => done(false));
        sock.once('timeout', () => done(false));
        sock.connect(port, '127.0.0.1');
    });
}

module.exports = { WrapperProc, STATUS };
