// Tests for the argument validators and the IPC sender rule in main.mjs. As in
// new-code.test.mjs, each function's real source is extracted and run in a sandbox.
//   node --test electron/test/ipc-hardening.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(path.join(dir, '..', 'main.mjs'), 'utf8');

function extractFn(src, name) {
    const m = new RegExp('function\\s+' + name + '\\s*\\(').exec(src);
    if (!m) throw new Error('function not found: ' + name);
    const open = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
    }
    throw new Error('unbalanced braces: ' + name);
}
function extractConst(src, name) {
    const m = new RegExp('const\\s+' + name + '\\s*=').exec(src);
    if (!m) throw new Error('const not found: ' + name);
    return src.slice(m.index, src.indexOf('\n', m.index) + 1);
}
function load(prelude, fns, consts = []) {
    const code = prelude + '\n' + consts.map(c => extractConst(MAIN, c)).join('') +
        fns.map(n => extractFn(MAIN, n)).join('\n') + '\n;globalThis.__ok = true;';
    const ctx = { URL, JSON, String, Number, Set, Object, console };
    vm.createContext(ctx);
    vm.runInContext(code, ctx);
    return ctx;
}

const helpers = () => load('', ['_httpsHost', '_str', '_safeName', '_paletteEntryOk', '_storeValueOk', '_navigationAllowed'],
    ['_PALETTE_KEYS', '_COLOR_RE', '_STORE_VALUE_MAX']);

test('_str accepts only non-empty strings within the limit', () => {
    const { _str } = helpers();
    assert.equal(_str('x'), true);
    assert.equal(_str(''), false);
    assert.equal(_str('x'.repeat(65), 64), false);
    assert.equal(_str(42), false);
    assert.equal(_str(null), false);
    assert.equal(_str({ toString: () => 'x' }), false);
});

test('_safeName strips path separators and caps the length', () => {
    const { _safeName } = helpers();
    assert.equal(_safeName('../../etc/passwd'), '.._.._etc_passwd');
    assert.equal(_safeName('My Theme (v2).json'), 'My Theme (v2).json');
    assert.equal(_safeName('a/b\\c'), 'a_b_c');
    assert.equal(_safeName('x'.repeat(200)).length, 64);
    assert.equal(_safeName(''), 'preset');
});

test('palette entries: known keys with colour-looking values only', () => {
    const { _paletteEntryOk } = helpers();
    assert.equal(_paletteEntryOk('accent', '#fc3c44'), true);
    assert.equal(_paletteEntryOk('accentActive', 'hsla(358, 87%, 60%, 0.28)'), true);
    assert.equal(_paletteEntryOk('appearance', 'dark'), true);
    assert.equal(_paletteEntryOk('__proto__', '#fff'), false);
    assert.equal(_paletteEntryOk('accent', 'red; background:url(//evil)'), false);
    assert.equal(_paletteEntryOk('accent', '#fff'.repeat(30)), false);
    assert.equal(_paletteEntryOk('accent', 42), false);
    assert.equal(_paletteEntryOk('appearance', 'dark; x'), false);
});

test('store values are bounded and must serialise', () => {
    const { _storeValueOk } = helpers();
    assert.equal(_storeValueOk({ plays: [1, 2, 3] }), true);
    assert.equal(_storeValueOk('x'.repeat(300 * 1024)), false);
    assert.equal(_storeValueOk(undefined), false);
    const cyclic = {}; cyclic.self = cyclic;
    assert.equal(_storeValueOk(cyclic), false);
    assert.equal(_storeValueOk(() => 1), false);
});

test('the privileged window may only navigate to Apple hosts', () => {
    const { _navigationAllowed } = helpers();
    for (const ok of ['https://music.apple.com/us/browse', 'https://authorize.music.apple.com/x', 'https://appleid.apple.com/', 'https://apple.com/'])
        assert.equal(_navigationAllowed(ok), true, ok);
    for (const bad of ['https://evil.example/', 'https://music.apple.com.evil.example/', 'https://notapple.com/', 'http://music.apple.com/',
        'https://evilapple.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url'])
        assert.equal(_navigationAllowed(bad), false, bad);
});

// IPC sender rule: the main window's Apple page may call anything; the mini player only its
// three channels; every other sender is refused.
test('_senderAllowed: main window on the Apple origin, mini player only for transport', () => {
    const mainWc = { id: 'main' }, miniWc = { id: 'mini' }, otherWc = { id: 'other' };
    const code = `
        const win = { isDestroyed: () => false, webContents: __mainWc };
        const miniWin = { isDestroyed: () => false, webContents: __miniWc };
    `;
    const ctx = { URL, Set, __mainWc: mainWc, __miniWc: miniWc };
    vm.createContext(ctx);
    vm.runInContext(code + extractConst(MAIN, '_MINI_CHANNELS') + extractFn(MAIN, '_httpsHost') +
        extractFn(MAIN, '_senderAllowed') + ';globalThis.f=_senderAllowed;', ctx);
    const ev = (sender, url) => ({ sender, senderFrame: { url } });

    assert.equal(ctx.f(ev(mainWc, 'https://music.apple.com/us'), 'store:write'), true);
    assert.equal(ctx.f(ev(mainWc, 'https://evil.example/'), 'store:write'), false, 'main window, wrong origin');
    assert.equal(ctx.f(ev(mainWc, 'https://music.apple.com.evil.example/'), 'store:write'), false);
    assert.equal(ctx.f(ev(mainWc, undefined), 'store:write'), false, 'no frame url');
    assert.equal(ctx.f(ev(miniWc, 'file:///x/miniplayer.html'), 'miniplayer:cmd'), true);
    assert.equal(ctx.f(ev(miniWc, 'file:///x/miniplayer.html'), 'store:write'), false, 'mini player may not use other channels');
    assert.equal(ctx.f(ev(otherWc, 'https://music.apple.com/us'), 'miniplayer:cmd'), false, 'unknown window');
});
