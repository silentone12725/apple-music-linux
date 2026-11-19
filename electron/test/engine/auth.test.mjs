// Adapted from silentone12725/apple-music-linux PR #1 (https://github.com/silentone12725/apple-music-linux/pull/1), Adam naming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountSignedIn, authProgress, drmURL, losslessReady, downloadQuality } from '../../src/engine/auth.js';

test('a saved account survives a lazy backend restart', () => {
    assert.equal(accountSignedIn({ state: { session: 'valid', authentication: 'signed_in', process: 'stopped' } }), true);
    assert.equal(authProgress({ state: { session: 'valid', authentication: 'signing_in', process: 'starting' } }), 'pending');
});
test('a fresh challenge or failure wins over retained session/capabilities', () => {
    const saved = { capabilities: { cbcs: true }, state: { session: 'valid', authentication: 'challenging' }, challenge: { type: '2fa' } };
    assert.equal(authProgress(saved), 'challenge');
    saved.state.authentication = 'failed';
    assert.equal(authProgress(saved), 'failed');
    assert.equal(accountSignedIn(saved), false);
});
test('successful live authentication completes polling', () => {
    assert.equal(authProgress({ state: { authentication: 'signed_in', process: 'running' } }), 'done');
    assert.equal(authProgress({}), 'pending');
});
test('challenge endpoint is valid with and without a trailing slash', () => {
    for (const base of ['https://127.0.0.1:20025', 'https://127.0.0.1:20025/']) {
        assert.equal(new URL(drmURL(base, 'challenge')).pathname, '/api/v1/drm/challenge');
    }
});

test('a saved account is not lossless-ready until FairPlay is live', () => {
    const savedOnly = { state: { session: 'valid', authentication: 'signed_in', process: 'stopped', fairplay: 'unknown' }, capabilities: { cbcs: false } };
    assert.equal(accountSignedIn(savedOnly), true, 'the account is saved');
    assert.equal(losslessReady(savedOnly), false, 'but lossless is not available');
    assert.equal(losslessReady({ state: { fairplay: 'signed_in' } }), true);
    assert.equal(losslessReady({ capabilities: { cbcs: true } }), true);
    for (const empty of [{}, null, undefined, { state: {}, capabilities: {} }]) assert.equal(losslessReady(empty), false);
});

test('downloads ask for the quality the Downloads setting names, held to what is available', () => {
    const q = (prefs, ready = true) => downloadQuality({ prefs, ready });
    assert.deepEqual(q({}), { lossless: true, hiRes: false }, 'default is lossless when it is available');
    assert.deepEqual(q({ 'dl-quality': 'high-quality' }), { lossless: false, hiRes: false }, 'the setting is honoured');
    assert.deepEqual(q({ 'dl-quality': 'hi-res-lossless' }), { lossless: true, hiRes: true });
    assert.deepEqual(q({ 'dl-quality': 'lossless' }), { lossless: true, hiRes: false });
    assert.deepEqual(q({ 'downloads-quality': 'high-quality' }), { lossless: false, hiRes: false }, 'the old key still counts');
    assert.deepEqual(q({ 'dl-quality': 'high-quality', 'downloads-quality': 'lossless' }), { lossless: false, hiRes: false }, 'the current key wins');
});

test('downloads never ask for lossless that is switched off or unavailable', () => {
    assert.deepEqual(downloadQuality({ prefs: { 'dl-quality': 'hi-res-lossless' }, ready: false }), { lossless: false, hiRes: false }, 'signed out or FairPlay not ready');
    assert.deepEqual(downloadQuality({ prefs: { 'dl-quality': 'hi-res-lossless', 'lossless-enabled': false }, ready: true }), { lossless: false, hiRes: false }, 'global Lossless Audio is off');
    assert.deepEqual(downloadQuality({ prefs: {}, ready: false }), { lossless: false, hiRes: false });
    assert.deepEqual(downloadQuality({ prefs: { 'dl-quality': 'hi-res-lossless' } }), { lossless: false, hiRes: false }, 'readiness defaults to not ready');
});
