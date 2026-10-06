import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSignedIn, authProgress, drmURL } from '../../src/engine/auth.js';

test('a saved account survives a lazy backend restart', () => {
    assert.equal(accountSignedIn({ state: { session: 'valid', authentication: 'logged_in', process: 'stopped' } }), true);
    assert.equal(authProgress({ state: { session: 'valid', authentication: 'logging_in', process: 'starting' } }), 'pending');
});
test('a fresh challenge or failure wins over retained session/capabilities', () => {
    const saved = { capabilities: { cbcs: true }, state: { session: 'valid', authentication: 'challenging' }, challenge: { type: '2fa' } };
    assert.equal(authProgress(saved), 'challenge');
    saved.state.authentication = 'failed';
    assert.equal(authProgress(saved), 'failed');
    assert.equal(accountSignedIn(saved), false);
});
test('successful live authentication completes polling', () => {
    assert.equal(authProgress({ state: { authentication: 'logged_in', process: 'running' } }), 'done');
    assert.equal(authProgress({}), 'pending');
});
test('challenge endpoint is valid with and without a trailing slash', () => {
    for (const base of ['https://127.0.0.1:20025', 'https://127.0.0.1:20025/']) {
        assert.equal(new URL(drmURL(base, 'challenge')).pathname, '/api/v1/drm/challenge');
    }
});
