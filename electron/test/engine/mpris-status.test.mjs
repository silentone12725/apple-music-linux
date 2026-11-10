import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileVlcMprisStatus } from '../../src/engine/mpris-status.js';

const vlc = (overrides = {}) => ({
    state: 'playing',
    positionMs: 1200,
    reportedStatus: 'Stopped',
    paused: false,
    loading: false,
    seeking: false,
    ...overrides,
});

test('recovers Stopped when VLC confirms actual playback with position', () => {
    assert.equal(reconcileVlcMprisStatus(vlc()), 'Playing');
});

test('recovers Paused after resume when a MusicKit state event was missed', () => {
    assert.equal(reconcileVlcMprisStatus(vlc({ reportedStatus: 'Paused' })), 'Playing');
});

test('does not repeatedly emit an unchanged Playing state', () => {
    assert.equal(reconcileVlcMprisStatus(vlc({ reportedStatus: 'Playing' })), null);
});

test('does not report Playing during VLC startup or seek', () => {
    for (const blocked of [
        { positionMs: 0 },
        { state: 'opening' },
        { loading: true },
        { seeking: true },
        { paused: true },
        { positionMs: Number.NaN },
    ]) {
        assert.equal(reconcileVlcMprisStatus(vlc(blocked)), null, JSON.stringify(blocked));
    }
});

test('does not report Playing when VLC is stopped or ended', () => {
    for (const state of ['stopped', 'ended', 'error']) {
        assert.equal(reconcileVlcMprisStatus(vlc({ state })), null, state);
    }
});

test('reconciles a real paused VLC state once, not transient loading', () => {
    assert.equal(reconcileVlcMprisStatus(vlc({
        state: 'paused', reportedStatus: 'Playing', paused: true,
    })), 'Paused');
    assert.equal(reconcileVlcMprisStatus(vlc({
        state: 'paused', reportedStatus: 'Paused', paused: true,
    })), null);
    assert.equal(reconcileVlcMprisStatus(vlc({
        state: 'paused', reportedStatus: 'Playing', paused: true, seeking: true,
    })), null);
});
