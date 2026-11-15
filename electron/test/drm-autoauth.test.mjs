import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoAuthenticate } from '../drm-autoauth.mjs';

const creds = { email: 'a@b.c', password: 'pw' };

// A fake engine: `statuses` are returned in turn by GET status; the last one repeats.
function engine({ statuses, post = { status: 202, json: {} } }) {
    const calls = [];
    let i = 0, clock = 1_000_000;
    return {
        calls,
        now: () => clock,
        sleep: async (ms) => { clock += ms; },
        request: async (method, path, body) => {
            calls.push(method + ' ' + path);
            if (method === 'POST') { assert.deepEqual(body, { ...creds, unattended: true }); return post; }
            const s = statuses[Math.min(i++, statuses.length - 1)];
            return s === null ? null : { status: 200, json: { timestamp: new Date(clock + 500).toISOString(), ...s } };
        },
    };
}
const run = (e, extra = {}) => {
    let forgotten = 0, passwordDropped = 0;
    return autoAuthenticate({ request: e.request, creds, forget: async () => { forgotten++; }, dropPassword: async () => { passwordDropped++; }, sleep: e.sleep, now: e.now, timeoutMs: 60_000, ...extra })
        .then((outcome) => (passwordDropped ? { outcome, forgotten, passwordDropped } : { outcome, forgotten }));
};

test('engine unreachable: nothing sent, credentials kept', async () => {
    const e = engine({ statuses: [null] });
    assert.deepEqual(await run(e), { outcome: 'no-engine', forgotten: 0 });
    assert.deepEqual(e.calls, ['GET /api/v1/drm/status']);
});

test('an existing or loading session is never replaced', async () => {
    for (const state of [{ fairplay: 'ready' }, { session: 'valid' }]) {
        const e = engine({ statuses: [{ state }] });
        assert.equal((await run(e)).outcome, 'has-session');
        assert.ok(!e.calls.includes('POST /api/v1/drm/authenticate'));
    }
});

test('accepted by Apple: signed in, credentials kept', async () => {
    const e = engine({ statuses: [{ state: {} }, { state: { authentication: 'logging_in' } }, { state: { authentication: 'logged_in' } }] });
    assert.deepEqual(await run(e), { outcome: 'signed-in', forgotten: 0 });
});

test('turned down by Apple: credentials are removed once, not retried every launch', async () => {
    const e = engine({ statuses: [{ state: {} }, { state: { authentication: 'failed' }, message: 'Your Apple Account or password was incorrect.' }] });
    assert.deepEqual(await run(e), { outcome: 'rejected', forgotten: 1 });
});

test('a failure about this installation keeps the saved password', async () => {
    const e = engine({ statuses: [{ state: {} }, { state: { authentication: 'failed' }, message: 'FairPlay setup: the FairPlay libraries are not installed' }] });
    assert.deepEqual(await run(e), { outcome: 'kept', forgotten: 0 });
});

test('a failure reported before this attempt began is ignored', async () => {
    const e = engine({ statuses: [{ state: {} }] });
    let n = 0;
    const base = e.request;
    e.request = async (m, p, b) => {
        const r = await base(m, p, b);
        if (m === 'GET' && r?.json && ++n === 2) return { status: 200, json: { timestamp: new Date(e.now() - 60_000).toISOString(), state: { authentication: 'failed' }, message: 'old' } };
        if (m === 'GET' && r?.json && n >= 3) return { status: 200, json: { timestamp: new Date(e.now()).toISOString(), state: { authentication: 'logged_in' } } };
        return r;
    };
    assert.deepEqual(await run(e), { outcome: 'signed-in', forgotten: 0 });
});

test('a verification-code challenge drops only the password and leaves this attempt to the sign-in sheet', async () => {
    const e = engine({ statuses: [{ state: {} }, { state: { authentication: 'challenging' } }] });
    assert.deepEqual(await run(e), { outcome: 'needs-code', forgotten: 0, passwordDropped: 1 });
});

test('an unattended sign-in that Apple wants a code for ends quietly: no sheet, only the password is dropped', async () => {
    const e = engine({ statuses: [{ state: {} }, { state: { authentication: 'logging_in' } }, { state: { authentication: 'logged_out' }, message: 'sign-in cancelled' }] });
    assert.deepEqual(await run(e), { outcome: 'needs-code', forgotten: 0, passwordDropped: 1 });
    assert.ok(!e.calls.some((c) => c.includes('challenge')), 'no challenge was answered');
});

test('a plain logged-out report without the cancel message is not read as a code request', async () => {
    const e = engine({ statuses: [{ state: {} }, { state: { authentication: 'logged_out' }, message: '' }] });
    assert.deepEqual(await run(e, { timeoutMs: 6000 }), { outcome: 'timeout', forgotten: 0 });
});

test('a rejected request body clears the credentials; an engine without DRM does not', async () => {
    assert.deepEqual(await run(engine({ statuses: [{ state: {} }], post: { status: 400 } })), { outcome: 'rejected', forgotten: 1 });
    assert.deepEqual(await run(engine({ statuses: [{ state: {} }], post: { status: 503 } })), { outcome: 'kept', forgotten: 0 });
});

test('no answer within the time limit ends the wait without touching the credentials', async () => {
    const e = engine({ statuses: [{ state: {} }, { state: { authentication: 'logging_in' } }] });
    assert.deepEqual(await run(e), { outcome: 'timeout', forgotten: 0 });
});
