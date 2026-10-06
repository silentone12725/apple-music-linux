// Run: electron --no-sandbox verification/auth/electron-smoke.mjs
// Isolated, hidden windows and synthetic responses; no Apple account access.
import { app, BrowserWindow, session } from 'electron';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const data = mkdtempSync(path.join(tmpdir(), 'aml-auth-smoke-'));
app.setPath('userData', data);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
try {
    const main = readFileSync(new URL('../../electron/main.mjs', import.meta.url), 'utf8');
    const start = main.indexOf('function configureAuthPopups(');
    const end = main.indexOf('// Hostname of an https:// URL', start);
    const context = { path, __dirname: path.dirname(fileURLToPath(new URL('../../electron/main.mjs', import.meta.url))), _hasSandbox: true, _httpsHost: u => { try { return new URL(u).protocol === 'https:' ? new URL(u).hostname : null; } catch { return null; } }, shell: { openExternal: async () => { throw new Error('unexpected external URL'); } } };
    vm.createContext(context);
    vm.runInContext(main.slice(start, end), context);
    const ses = session.fromPartition('auth-smoke');
    ses.protocol.handle('https', () => new Response('<!doctype html><html><body>auth test</body></html>', { headers: { 'Content-Type': 'text/html' } }));
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    context.configureAuthPopups(win.webContents, u => ['music.apple.com', 'appleid.apple.com'].includes(new URL(u).hostname));
    await win.loadURL('https://music.apple.com/');
    const created = new Promise(resolve => win.webContents.once('did-create-window', child => { child.hide(); resolve(child); }));
    await win.webContents.executeJavaScript("window.authResult = ''; window.addEventListener('message',e=>{window.authResult=e.data}); window.open('https://appleid.apple.com/auth', 'auth'); void 0;");
    const child = await created;
    if (child.webContents.isLoading()) await new Promise(resolve => child.webContents.once('did-finish-load', resolve));
    await child.webContents.executeJavaScript("window.opener.postMessage('complete', 'https://music.apple.com'); window.close(); void 0;");
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await win.webContents.executeJavaScript('window.authResult'), 'complete');
    assert.equal(win.webContents.getURL(), 'https://music.apple.com/');
    console.log('PASS: real Electron popup retains opener, session, and player URL');

    const src = readFileSync(new URL('../../electron/src/engine-playback.js', import.meta.url), 'utf8');
    const helpers = readFileSync(new URL('../../electron/src/engine/auth.js', import.meta.url), 'utf8').replace(/export /g, '');
    const sectionStart = src.indexOf('    let injected = false;', src.indexOf('(function setupEngineSettings()'));
    const sectionEnd = src.indexOf('    // ── Dialog (created once', sectionStart);
    const code = `const ENGINE='https://127.0.0.1:20025'; ${helpers}\n${src.slice(sectionStart, sectionEnd)}\n
      window.testState = {state:{authentication:'logged_out',session:'empty'}};
      window.fetch = async (url,opts) => {
        const p = new URL(url).pathname;
        if (p === '/api/v1/drm/authenticate') window.testState={state:{authentication:'challenging'},challenge:{type:'two_factor'}};
        if (p === '/api/v1/drm/challenge') {
          if (JSON.parse(opts.body).reply !== '123456') throw new Error('incorrect test code');
          window.testState={state:{authentication:'logged_in',process:'running'}};
          window.challengeURL=url;
        }
        return new Response(JSON.stringify(window.testState));
      };
      document.body.replaceChildren(buildAccountSection(window.testState,()=>window.authComplete=true));
      [...document.querySelectorAll('button')].find(b=>b.textContent==='Sign In…').click();
      document.querySelector('input[type=email]').value='test@example.invalid';
      document.querySelector('input[type=password]').value='synthetic-password';
      document.querySelector('input[type=email]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      if (document.activeElement !== document.querySelector('input[type=password]')) throw new Error('Enter did not focus password');
      document.querySelector('input[type=password]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));`;
    await win.webContents.executeJavaScript('window.amlBridge = {};');
    await win.webContents.executeJavaScript(code);
    const waitFor = async expression => {
        for (let i=0;i<40;i++) {
            if (await win.webContents.executeJavaScript(expression)) return;
            await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw new Error('timed out: '+expression);
    };
    await waitFor("!!document.querySelector('input[autocomplete=one-time-code]')");
    await win.webContents.executeJavaScript("document.querySelector('input').value='123456'; document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
    await waitFor('window.authComplete===true');
    assert.equal(await win.webContents.executeJavaScript('window.challengeURL'), 'https://127.0.0.1:20025/api/v1/drm/challenge');
    console.log('PASS: real renderer Enter focuses password, submits credentials and 2FA, and completes');
    win.destroy();
    app.exit(0);
} catch (error) {
    console.error(error);
    app.exit(1);
} finally { rmSync(data, { recursive: true, force: true }); }

});
