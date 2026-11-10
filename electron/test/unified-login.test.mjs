import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UnifiedLogin, submittedAppleCredentials, captureSubmittedAppleLogin } from '../unified-login.mjs';

const creds = { accountName: 'synthetic@example.test', password: 'SYNTHETIC' };
const submission = (extra = {}) => ({ url: 'https://idmsa.apple.com/appleauth/auth/signin', method: 'POST',
    uploadData: [{ bytes: Buffer.from(JSON.stringify(creds)) }], ...extra });
function setup(state = {}) {
    const calls = [];
    const login = new UnifiedLogin({ request: async (method, path, body) => {
        calls.push({ method, path, body: body && { ...body } });
        return method === 'GET' ? { status: 200, json: { state } } : { status: 202 };
    } });
    return { login, calls };
}

test('only the exact Apple sign-in endpoint with bounded JSON credentials is accepted', () => {
    assert.deepEqual(submittedAppleCredentials(submission()), { email: creds.accountName, password: creds.password });
    for (const extra of [
        { url: 'https://idmsa.apple.com.attacker.test/appleauth/auth/signin' },
        { url: 'http://idmsa.apple.com/appleauth/auth/signin' },
        { url: 'https://music.apple.com/appleauth/auth/signin' },
        { url: 'https://idmsa.apple.com/account/password' },
        { method: 'GET' }, { uploadData: [{ file: '/tmp/password' }] },
        { uploadData: [{ bytes: Buffer.from('{') }] },
        { uploadData: [{ bytes: Buffer.alloc(16385) }] },
    ]) assert.equal(submittedAppleCredentials(submission(extra)), null);
});

test('web submission waits for authorization, signs in only once, clears its secret', async () => {
    const { login, calls } = setup();
    try {
        login.capture(submission());
        const pending = login.pending;
        assert.equal(calls.length, 0);
        assert.equal(await login.complete(), 'submitted');
        assert.deepEqual(calls[1], { method: 'POST', path: '/api/v1/drm/authenticate', body: { email: creds.accountName, password: creds.password } });
        assert.equal(pending.password, '');
        assert.equal(login.pending, null);
        assert.equal(await login.complete(), 'no-credentials');
        assert.equal(calls.length, 2);
    } finally { login.clear(); }
});

test('restoring sessions and active native sign-ins including 2FA are preserved', async () => {
    for (const state of [{ fairplay: 'ready' }, { session: 'valid' },
        ...['logging_in', 'challenging', 'logged_in'].map(authentication => ({ authentication }))]) {
        const { login, calls } = setup(state);
        login.capture(submission());
        assert.equal(await login.complete(), 'has-session');
        assert.equal(calls.length, 1);
    }
});

test('expired, cancelled and failed attempts retain no password and never retry', async () => {
    const { login, calls } = setup();
    login.capture(submission());
    login.now = () => Infinity;
    assert.equal(await login.complete(), 'expired');
    assert.equal(calls.length, 0);
    login.capture(submission());
    const pending = login.pending;
    login.clear();
    assert.equal(pending.password, '');
    assert.equal(await login.complete(), 'no-credentials');
    login.now = Date.now;
    login.capture(submission());
    const failed = login.pending;
    login.request = async () => { throw new Error('unavailable'); };
    await assert.rejects(login.complete(), /unavailable/);
    assert.equal(failed.password, '');
    assert.equal(login.running, false);
    assert.equal(await login.complete(), 'no-credentials');
});

test('concurrent authorization events cannot submit twice', async () => {
    const { login, calls } = setup();
    login.capture(submission());
    const first = login.complete();
    assert.equal(login.capture(submission()), false);
    assert.equal(await login.complete(), 'no-credentials');
    assert.equal(await first, 'submitted');
    assert.equal(calls.length, 2);
});

test('Apple form capture supports email then password and removes listeners after submission', async () => {
    const handlers = new Map();
    let email = creds.accountName, password = '';
    const doc = {
        querySelector: selector => selector === 'input[type=password]' ? { value: password } : { value: email },
        addEventListener: (type, fn) => handlers.set(type, fn),
        removeEventListener: type => handlers.delete(type),
    };
    const promise = vm.runInNewContext(`(${captureSubmittedAppleLogin.toString()})()`, { document: doc, setTimeout, clearTimeout });
    handlers.get('keydown')({ isTrusted: true, key: 'Enter' });
    email = ''; // Apple's second step can remove the email input.
    password = creds.password;
    handlers.get('click')({ isTrusted: false, target: { closest: () => true } });
    assert.equal(handlers.size, 3);
    handlers.get('keydown')({ isTrusted: true, key: 'Enter' });
    const result = await promise;
    assert.equal(result.email, creds.accountName);
    assert.equal(result.password, creds.password);
    assert.equal(handlers.size, 0);
});

test('sign-out during the status request cancels native credential submission', async () => {
    const { login, calls } = setup();
    let release;
    login.request = () => new Promise(resolve => { release = resolve; });
    login.capture(submission());
    const pending = login.complete();
    login.clear();
    release({ status: 200, json: { state: {} } });
    assert.equal(await pending, 'cancelled');
    assert.equal(calls.length, 0);
});
