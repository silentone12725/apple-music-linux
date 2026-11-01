// Keeping a music video's picture in step with its sound.
//
// Run: node --test electron/test/engine/av-sync.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avSyncAction, AV_MAX_RATE_DELTA, AV_SNAP_COOLDOWN_MS } from '../../src/engine/av-sync.js';

const LONG_AGO = 1e9;

test('a drift inside the dead band is left alone', () => {
    assert.deepEqual(avSyncAction({ driftSec: 0.02, sinceSnapMs: LONG_AGO }), { action: 'none', rate: 1 });
    assert.deepEqual(avSyncAction({ driftSec: -0.039, sinceSnapMs: LONG_AGO }), { action: 'none', rate: 1 });
});

test('audio behind the picture slows the video, audio ahead speeds it up', () => {
    const behind = avSyncAction({ driftSec: -0.2, sinceSnapMs: LONG_AGO });
    assert.equal(behind.action, 'rate');
    assert.ok(behind.rate < 1 && behind.rate > 1 - AV_MAX_RATE_DELTA - 1e-9);
    const ahead = avSyncAction({ driftSec: 0.2, sinceSnapMs: LONG_AGO });
    assert.equal(ahead.action, 'rate');
    assert.ok(ahead.rate > 1 && ahead.rate < 1 + AV_MAX_RATE_DELTA + 1e-9);
});

// The drift that logs showed on a real 1080p play: audio about half a second behind, every half second.
test('the half-second drift seen in practice is corrected without seeking the audio', () => {
    for (const driftSec of [-0.378, -0.482, -0.544, -0.501]) {
        const a = avSyncAction({ driftSec, sinceSnapMs: 550 });
        assert.equal(a.action, 'rate', `drift ${driftSec}`);
        assert.equal(a.rate, 1 - AV_MAX_RATE_DELTA);
    }
});

test('the rate change is capped', () => {
    assert.equal(avSyncAction({ driftSec: 1.4, sinceSnapMs: LONG_AGO }).rate, 1 + AV_MAX_RATE_DELTA);
    assert.equal(avSyncAction({ driftSec: -1.4, sinceSnapMs: LONG_AGO }).rate, 1 - AV_MAX_RATE_DELTA);
});

test('only a large drift is snapped, and not again within the cooldown', () => {
    assert.deepEqual(avSyncAction({ driftSec: -2.5, sinceSnapMs: LONG_AGO }), { action: 'snap', rate: 1 });
    assert.deepEqual(avSyncAction({ driftSec: 3, sinceSnapMs: AV_SNAP_COOLDOWN_MS + 1 }), { action: 'snap', rate: 1 });
    // Inside the cooldown the large drift is still worked on at the capped rate instead of being seeked again.
    const soon = avSyncAction({ driftSec: -2.5, sinceSnapMs: 500 });
    assert.equal(soon.action, 'rate');
    assert.equal(soon.rate, 1 - AV_MAX_RATE_DELTA);
});

test('a missing or broken drift does nothing', () => {
    assert.equal(avSyncAction({ driftSec: NaN, sinceSnapMs: LONG_AGO }).action, 'none');
    assert.equal(avSyncAction({ driftSec: Infinity, sinceSnapMs: LONG_AGO }).action, 'none');
});
