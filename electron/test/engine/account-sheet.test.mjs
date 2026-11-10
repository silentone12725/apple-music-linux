import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountSheet } from '../../src/engine/account-sheet.js';

// A just-enough DOM for the sheet: elements with children, properties, listeners and a modal <dialog>.
class El {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.attrs = {}; this.className = ''; this.value = ''; this.open = false; this.classList = { remove() {}, add() {} }; this.style = {}; this._text = ''; }
    append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? Object.assign(new El('#text'), { _text: k }) : k); }
    appendChild(k) { this.children.push(k); return k; }
    replaceChildren(...kids) { this.children = []; this.append(...kids); }
    insertAdjacentHTML() {}
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
    click() { (this.listeners.click ?? []).forEach(f => f({})); }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    set textContent(t) { this._text = t; this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set innerHTML(h) { this._text = ''; this.children = []; }
    find(pred, out = []) { if (pred(this)) out.push(this); this.children.forEach(c => c.find(pred, out)); return out; }
}
const makeDoc = () => {
    const body = new El('body'), head = new El('head'), ids = {};
    return { body, head, createElement: (t) => new El(t), getElementById: (id) => ids[id] ?? null, _ids: ids };
};
const setup = (extra = {}) => {
    const doc = makeDoc(), calls = [];
    const sheet = createAccountSheet({
        doc, signIn: async (...a) => { calls.push(['signIn', ...a]); return { ok: true }; },
        submitCode: async () => true, openUrl: (u) => calls.push(['open', u]), ...extra,
    });
    const dlg = () => doc.body.children[0];
    return { sheet, calls, dlg, doc };
};
const inputs = (dlg) => dlg().find(e => e.tag === 'input');
const tick = () => new Promise(r => setImmediate(r));

test('a known account pre-fills the form and asks for the password only', async () => {
    const { sheet, dlg } = setup({ savedEmail: async () => 'me@example.com' });
    await sheet.openSignIn();
    const [email, pass] = inputs(dlg);
    assert.equal(email.value, 'me@example.com');
    assert.equal(pass.focused, true, 'the password field takes the focus');
    assert.match(dlg().textContent, /Sign-In Required/);
    assert.match(dlg().textContent, /Enter the password for your Apple Account me@example\.com/);
});

test('with no known account the plain form is shown', async () => {
    const { sheet, dlg } = setup();
    await sheet.openSignIn();
    assert.match(dlg().textContent, /Sign in with your Apple Account/);
    assert.equal(inputs(dlg)[0].value, '');
});

test('the password is only remembered when the box is ticked', async () => {
    for (const ticked of [false, true]) {
        const { sheet, calls, dlg } = setup();
        await sheet.openSignIn();
        const [email, pass, box] = inputs(dlg);
        email.value = ' me@example.com '; pass.value = 'secret'; box.checked = ticked;
        (email.listeners.input ?? []).forEach(f => f({}));
        dlg().find(e => e.tag === 'button' && e.className === 'primary')[0].click();
        await tick();
        assert.deepEqual(calls[0], ['signIn', 'me@example.com', 'secret', ticked]);
    }
});

test('a classified failure shows Apple’s reason and a link to fix it', async () => {
    const { sheet, calls, dlg } = setup();
    await sheet.openSignIn();
    const [email, pass] = inputs(dlg);
    email.value = 'me@example.com'; pass.value = 'secret';
    dlg().find(e => e.tag === 'button' && e.className === 'primary')[0].click();
    await tick();
    sheet.onSnapshot({ state: { authentication: 'failed' }, message: 'raw',
        failure: { kind: 'locked', message: 'Apple has blocked sign-ins for now.', url: 'https://iforgot.apple.com' } });
    assert.match(dlg().textContent, /Apple has blocked sign-ins for now\./);
    assert.doesNotMatch(dlg().textContent, /raw/);
    const link = dlg().find(e => e.className === 'link')[0];
    assert.match(link.textContent, /iforgot\.apple\.com/);
    link.click();
    assert.deepEqual(calls.at(-1), ['open', 'https://iforgot.apple.com']);
});

test('the code page tells where a missing code can be found', async () => {
    const { sheet, dlg } = setup();
    sheet.onSnapshot({ state: { authentication: 'challenging' }, challenge: { type: 'two_factor', id: 1 } });
    assert.match(dlg().textContent, /Enter Verification Code/);
    assert.match(dlg().textContent, /No code\?/);
});

test('a sign-in that fails while the code is asked for goes back to the form with the reason', async () => {
    const { sheet, dlg } = setup();
    sheet.onSnapshot({ state: { authentication: 'challenging' }, challenge: { type: 'two_factor', id: 1 } });
    sheet.onSnapshot({ state: { authentication: 'failed' }, failure: { kind: 'timeout', message: 'Apple did not answer in time.' } });
    assert.match(dlg().textContent, /Sign in with your Apple Account/);
    assert.match(dlg().textContent, /Apple did not answer in time\./);
});
