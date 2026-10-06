import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const src = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function configureAuthPopups(');
const end = src.indexOf('// Hostname of an https:// URL', start);
const ctx = { path: { join: (...parts) => parts.join('/') }, __dirname: '/app', _hasSandbox: true, _httpsHost: (url) => { try { const u = new URL(url); return u.protocol === 'https:' ? u.hostname : null; } catch { return null; } }, shell: { openExternal: async () => {} } };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);
function contents() { return { session: {}, listeners: {}, setWindowOpenHandler(fn) { this.handler = fn; }, on(event, fn) { this.listeners[event] = fn; } }; }
test('Apple sign-in preserves opener and partition and does not navigate the player', () => {
    const wc = contents();
    const allowed = (url) => new URL(url).hostname === 'appleid.apple.com';
    ctx.configureAuthPopups(wc, allowed);
    for (const url of ['https://appleid.apple.com/auth', 'about:blank']) {
        const result = wc.handler({ url });
        assert.equal(result.action, 'allow');
        assert.equal(result.overrideBrowserWindowOptions.webPreferences.session, undefined);
        assert.equal(result.overrideBrowserWindowOptions.webPreferences.preload, '/app/auth-preload.cjs');
        assert.equal(result.overrideBrowserWindowOptions.webPreferences.nodeIntegration, false);
    }
    assert.equal(wc.handler({ url: 'https://attacker.example/' }).action, 'deny');
    const child = contents();
    wc.listeners['did-create-window']({ webContents: child });
    let blocked = false;
    child.listeners['will-redirect']({ preventDefault() { blocked = true; } }, 'https://attacker.example/');
    assert.equal(blocked, true);
});
test('terminal detachment EIO is handled without recursively logging an exception', () => {
    const handlers = [];
    const code = src.slice(src.indexOf("process.stdout.on('error'"), src.indexOf("import { createRequire"));
    vm.runInNewContext(code, { process: { stdout: { on(_, fn) { handlers.push(fn); } }, stderr: { on(_, fn) { handlers.push(fn); } } } });
    for (const handler of handlers) {
        assert.doesNotThrow(() => handler({ code: 'EIO' }));
        assert.doesNotThrow(() => handler({ code: 'EPIPE' }));
        assert.throws(() => handler({ code: 'EACCES' }));
    }
});
