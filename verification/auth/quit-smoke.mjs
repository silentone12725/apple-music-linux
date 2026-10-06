// Real Electron quit with a page that vetoes unload; engine/storage use stubs.
import { app, BrowserWindow } from 'electron';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const data = mkdtempSync(path.join(tmpdir(), 'aml-quit-smoke-'));
app.setPath('userData', data);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await window.loadURL('data:text/html,<p>quit regression</p>');
    await window.webContents.executeJavaScript('window.onbeforeunload = () => false; void 0;');
    const steps = [];
    const src = readFileSync(new URL('../../electron/main.mjs', import.meta.url), 'utf8');
    const start = src.indexOf("app.on('before-quit', (e) => {");
    const end = src.indexOf('// window-all-closed', start);
    const context = {
        isQuitting: false, win: window, setTimeout, clearTimeout,
        globalShortcut: { unregisterAll() {} },
        _storeFlushSync: () => steps.push('store'),
        session: { fromPartition: () => ({
            flushStorageData: () => steps.push('storage'),
            cookies: { flushStore: async () => {
                steps.push('cookies');
                if (process.env.AML_TEST_STALLED_FLUSH === '1') await new Promise(() => {});
            } },
        }) },
        stopEngine: async () => { await new Promise(r => setTimeout(r, 20)); steps.push('engine'); },
        app: {
            on: (event, handler) => app.on(event, handler),
            quit: () => app.quit(),
            exit: code => {
                assert.deepEqual(steps, ['store', 'storage', 'cookies', 'engine']);
                assert.equal(code, 0);
                console.log('PASS: production quit flushes storage and stops engine before exiting despite unload veto');
                rmSync(data, { recursive: true, force: true });
                app.exit(code);
            },
        },
    };
    vm.runInNewContext(src.slice(start, end), context);
    app.quit();
}).catch(error => { console.error(error); rmSync(data, { recursive: true, force: true }); app.exit(1); });
