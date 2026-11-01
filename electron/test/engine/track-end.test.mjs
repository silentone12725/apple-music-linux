// The audio that will actually play decides where a track ends.
//
// Run: node --test electron/test/engine/track-end.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actualDurationSec, lengthDiffers, lengthAfterOverrun } from '../../src/engine/track-end.js';

test('the buffered stream\'s own end wins once it is known', () => {
    // Reported 210 s, the audio really ends at 187 s (shorter): fades and prefetch must follow 187.
    assert.equal(actualDurationSec({ elementDurationSec: 187.4, streamComplete: true, reportedSec: 210 }), 187.4);
    // Reported 210 s, the audio really runs 218 s (longer): nothing may fade out or cut at 210.
    assert.equal(actualDurationSec({ elementDurationSec: 218.2, streamComplete: true, reportedSec: 210 }), 218.2);
});

test('before the stream has ended the reported length is used', () => {
    assert.equal(actualDurationSec({ elementDurationSec: 210, streamComplete: false, reportedSec: 210 }), 210);
    assert.equal(actualDurationSec({ elementDurationSec: Infinity, streamComplete: false, reportedSec: 205 }), 205);
});

test('an unusable element duration falls back to the reported length', () => {
    for (const elementDurationSec of [NaN, Infinity, 0, -1, undefined]) {
        assert.equal(actualDurationSec({ elementDurationSec, streamComplete: true, reportedSec: 200 }), 200);
    }
});

test('only a real difference replaces the length', () => {
    assert.equal(lengthDiffers(210.4, 210), false);
    assert.equal(lengthDiffers(209.1, 210), false);
    assert.equal(lengthDiffers(187, 210), true);
    assert.equal(lengthDiffers(218, 210), true);
    assert.equal(lengthDiffers(NaN, 210), false);
    assert.equal(lengthDiffers(0, 210), false);
});

test('playing past the reported length grows it instead of ending the track', () => {
    assert.equal(lengthAfterOverrun(150, 210), 210);      // normal playback
    assert.equal(lengthAfterOverrun(210.6, 210), 210);    // inside the tolerance
    assert.equal(lengthAfterOverrun(213.5, 210), 213.5);  // the audio is longer than reported
    assert.equal(lengthAfterOverrun(50, 0), 0);           // no length known: nothing to grow
});
