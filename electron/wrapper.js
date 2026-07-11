'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAPPER_SRC = path.join(__dirname, '..', 'Wrapper.x86_64.latest', 'wrapper-rootless');
const DATA_DIR = path.join(os.homedir(), '.config', 'apple-music-linux', 'wrapper-data');
const MAX_LOG_LINES = 1000;

class WrapperProc {
    constructor(onLog) {
        this._onLog = onLog;
        this._proc = null;
        this._logBuf = [];
    }

    start(login = '') {
        fs.mkdirSync(DATA_DIR, { recursive: true });

        const args = ['-H', '127.0.0.1'];
        if (login) args.push('-L', login);

        const wrapperBin = fs.existsSync(WRAPPER_SRC) ? WRAPPER_SRC : null;
        if (!wrapperBin) {
            this._append('[WrapperProc] wrapper-rootless binary not found');
            return;
        }

        this._proc = spawn(wrapperBin, args, {
            cwd: DATA_DIR,
            detached: true,
        });

        this._append(`[WrapperProc] Started PID ${this._proc.pid}`);

        const pipe = (prefix, stream) => {
            stream.setEncoding('utf8');
            stream.on('data', (chunk) => {
                chunk.split('\n').filter(Boolean).forEach(line =>
                    this._append(`${prefix} ${line}`)
                );
            });
        };

        pipe('[wrapper stdout]', this._proc.stdout);
        pipe('[wrapper stderr]', this._proc.stderr);

        this._proc.on('exit', (code) => {
            this._append(`[WrapperProc] Process exited (code ${code ?? 0})`);
            this._proc = null;
        });
    }

    stop() {
        if (this._proc) {
            this._proc.kill('SIGTERM');
            this._proc = null;
        }
    }

    logs() {
        return [...this._logBuf];
    }

    _append(line) {
        console.log(line);
        this._logBuf.push(line);
        if (this._logBuf.length > MAX_LOG_LINES) {
            this._logBuf = this._logBuf.slice(-MAX_LOG_LINES);
        }
        if (this._onLog) this._onLog(line);
    }
}

module.exports = { WrapperProc };
