// What to do when VLC reports the end of a lossless track.
//
// Run: node --test electron/test/engine/vlc-end.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVlcEnd } from '../../src/engine/vlc-end.js';

const TRACK = 212310; // reported length of a real ALAC track whose data ends at 208948

test('a natural end close to the reported length advances', () => {
    assert.equal(classifyVlcEnd({ posMs: 208948, trackEndMs: TRACK, reason: 'ended', retryCount: 0, sourceEof: true }).action, 'advance');
    assert.equal(classifyVlcEnd({ posMs: 208948, trackEndMs: TRACK, reason: 'ended', retryCount: 0, sourceEof: false }).action, 'advance');
});

test('a data end far short of the reported length advances instead of replaying the tail', () => {
    const end = classifyVlcEnd({ posMs: 190000, trackEndMs: TRACK, reason: 'ended', retryCount: 0, sourceEof: true });
    assert.equal(end.action, 'advance');
    assert.equal(end.shortOfReported, true);
});

test('an end short of the length without a clean source end is a failed read and reloads at that position', () => {
    assert.deepEqual(
        classifyVlcEnd({ posMs: 190000, trackEndMs: TRACK, reason: 'ended', retryCount: 0, sourceEof: false }),
        { action: 'retry', fromMs: 190000, delayMs: 500 });
});

test('reloads are bounded', () => {
    const end = classifyVlcEnd({ posMs: 190000, trackEndMs: TRACK, reason: 'ended', retryCount: 2, sourceEof: false });
    assert.equal(end.action, 'advance');
});

test('a decoder error is recovered even when the source had reached its end', () => {
    // 5 s short is inside the 10 s natural window but outside the stricter 3 s error window.
    assert.equal(classifyVlcEnd({ posMs: TRACK - 5000, trackEndMs: TRACK, reason: 'error', retryCount: 0, sourceEof: true }).action, 'retry');
    assert.equal(classifyVlcEnd({ posMs: 190000, trackEndMs: TRACK, reason: 'error', retryCount: 0, sourceEof: true }).action, 'retry');
});

test('a stream that never started is retried from zero, with or without a source end', () => {
    for (const sourceEof of [true, false]) {
        assert.deepEqual(
            classifyVlcEnd({ posMs: 300, trackEndMs: TRACK, reason: 'ended', retryCount: 0, sourceEof }),
            { action: 'retry', fromMs: 0, delayMs: 1500 });
    }
    assert.equal(classifyVlcEnd({ posMs: 300, trackEndMs: TRACK, reason: 'ended', retryCount: 2, sourceEof: false }).action, 'advance');
});

test('short tracks use a proportionally smaller natural window', () => {
    // 20 s track: the window is 2 s, so an end 3 s short is not natural, but with a clean source end it still advances.
    assert.equal(classifyVlcEnd({ posMs: 17000, trackEndMs: 20000, reason: 'ended', retryCount: 0, sourceEof: false }).action, 'retry');
    assert.equal(classifyVlcEnd({ posMs: 17000, trackEndMs: 20000, reason: 'ended', retryCount: 0, sourceEof: true }).action, 'advance');
});

test('a track with no usable length just advances', () => {
    assert.equal(classifyVlcEnd({ posMs: 5000, trackEndMs: 0, reason: 'ended', retryCount: 0, sourceEof: false }).action, 'advance');
});
