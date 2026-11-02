import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lastfmConfiguration } from '../lastfm-config.mjs';

// Run the actual network entry point with injected, synthetic credentials and
// a recording fetch. No Electron, account, real secrets or network are used.
const main = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const start = main.indexOf('async function _lastfmCall(');
const end = main.indexOf('let _lastfmPendingToken', start);
assert.ok(start >= 0 && end > start);
const createCall = new Function('_lastfmCreds', '_lastfmSign', 'fetch', 'LASTFM_ROOT',
    `${main.slice(start, end)}; return _lastfmCall;`);

for (const [name, store] of [
    ['absent', {}],
    ['key only', { lastfm_api_key: 'test-key' }],
    ['secret only', { lastfm_secret: 'test-secret' }],
    ['blank secret', { lastfm_api_key: 'test-key', lastfm_secret: '  ' }],
    ['invalid type', { lastfm_api_key: {}, lastfm_secret: 'test-secret' }],
    ['oversized', { lastfm_api_key: 'x'.repeat(129), lastfm_secret: 'test-secret' }],
]) {
    test(`Last.fm ${name} configuration sends no requests`, async () => {
        assert.equal(lastfmConfiguration(store).configured, false);
        const forbidden = () => { assert.fail('unconfigured integration must not sign or fetch'); };
        const call = createCall(async () => lastfmConfiguration(store), forbidden, forbidden, 'https://example.invalid');
        for (const method of ['auth.getToken', 'auth.getSession', 'track.updateNowPlaying', 'track.scrobble']) {
            assert.equal((await call({ method, sk: 'test-session' }, 'POST')).error, 'not-configured');
        }
    });
}

test('explicit complete configuration enables the existing request path', async () => {
    const cfg = lastfmConfiguration({ lastfm_api_key: ' test-key ', lastfm_secret: ' test-secret ' });
    assert.deepEqual(cfg, { key: 'test-key', secret: 'test-secret', configured: true });
    const calls = [];
    const call = createCall(async () => cfg, () => 'test-signature', async (...args) => {
        calls.push(args);
        return { json: async () => ({ ok: true }) };
    }, 'https://example.invalid');
    assert.deepEqual(await call({ method: 'track.scrobble' }, 'POST'), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(new URLSearchParams(calls[0][1].body).get('api_key'), 'test-key');
});

test('renderer has no embedded Last.fm credentials or automatic credential write', () => {
    for (const path of ['../src/engine-playback.js', '../engine-bundle.js']) {
        const text = readFileSync(new URL(path, import.meta.url), 'utf8');
        assert.doesNotMatch(text, /LASTFM_API_(?:KEY|SECRET)/);
        assert.doesNotMatch(text, /lastfmSetCredentials/);
        assert.match(text, /Not configured/);
    }
});
