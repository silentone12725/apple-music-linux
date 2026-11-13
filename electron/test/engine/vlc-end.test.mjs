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

test('exhausted failed reads stop on the current track', () => {
    const end = classifyVlcEnd({ posMs: 190000, trackEndMs: TRACK, reason: 'ended', retryCount: 2, sourceEof: false });
    assert.equal(end.action, 'stop');
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
    assert.equal(classifyVlcEnd({ posMs: 300, trackEndMs: TRACK, reason: 'ended', retryCount: 2, sourceEof: false }).action, 'stop');
});

test('short tracks use a proportionally smaller natural window', () => {
    // 20 s track: the window is 2 s, so an end 3 s short is not natural, but with a clean source end it still advances.
    assert.equal(classifyVlcEnd({ posMs: 17000, trackEndMs: 20000, reason: 'ended', retryCount: 0, sourceEof: false }).action, 'retry');
    assert.equal(classifyVlcEnd({ posMs: 17000, trackEndMs: 20000, reason: 'ended', retryCount: 0, sourceEof: true }).action, 'advance');
});

test('a track with no usable length just advances', () => {
    assert.equal(classifyVlcEnd({ posMs: 5000, trackEndMs: 0, reason: 'ended', retryCount: 0, sourceEof: false }).action, 'advance');
});

test('explicit source failures retry then stop even near the end or without a known length', () => {
    for (const trackEndMs of [0, TRACK]) {
        for (const retryCount of [0, 1, 2]) {
            assert.equal(classifyVlcEnd({ posMs: TRACK - 100, trackEndMs, reason: 'ended', retryCount,
                sourceEof: false, sourceFailed: true }).action, retryCount < 2 ? 'retry' : 'stop');
        }
    }
});

test('a failed first track cannot auto-advance through the rest of a queue', () => {
    let nextCalls = 0;
    for (let retryCount = 0; retryCount <= 2; retryCount++) {
        const end = classifyVlcEnd({ posMs: 0, trackEndMs: TRACK, reason: 'ended', retryCount, sourceEof: false });
        if (end.action === 'advance') nextCalls++;
        assert.equal(end.action, retryCount < 2 ? 'retry' : 'stop');
    }
    assert.equal(nextCalls, 0);
});

test('clean EOF still advances across successive tracks without retries', () => {
    for (const posMs of [190000, 208948, TRACK]) {
        assert.equal(classifyVlcEnd({ posMs, trackEndMs: TRACK, reason: 'ended', retryCount: 0,
            sourceEof: true, sourceFailed: false }).action, 'advance');
    }
});

test('end classification matrix preserves near-end decoder recovery without advancing source failures', () => {
    let cases = 0;
    for (const trackEndMs of [4000, 20000, 240000]) {
        for (const posMs of [0, 800, 2500, trackEndMs / 2, trackEndMs - 500, trackEndMs]) {
            for (const reason of ['ended', 'error']) for (const sourceEof of [false, true]) {
                for (const sourceFailed of [false, true]) for (const retryCount of [0, 1, 2]) {
                    const input = { trackEndMs, posMs, reason, sourceEof, sourceFailed, retryCount };
                    const result = classifyVlcEnd(input);
                    const neverStarted = posMs < 2000 && trackEndMs > 5000;
                    const nearDecoderEnd = reason === 'error' && sourceEof && !sourceFailed &&
                        posMs > 2000 && trackEndMs > 0 && posMs >= trackEndMs - Math.min(3000, trackEndMs * 0.1);
                    const earlyNaturalEnd = posMs > 2000 && trackEndMs > 5000 &&
                        posMs < trackEndMs - Math.min(10000, trackEndMs * 0.1) && !sourceEof;
                    let expected = 'advance';
                    if (neverStarted || sourceFailed || (reason === 'error' && !nearDecoderEnd) ||
                        (reason === 'ended' && earlyNaturalEnd)) expected = retryCount < 2 ? 'retry' : 'stop';
                    assert.equal(result.action, expected, JSON.stringify(input));
                    if (expected === 'retry') {
                        assert.equal(result.delayMs, neverStarted ? 1500 : 500);
                        assert.equal(result.fromMs, neverStarted ? 0 : Math.max(0, posMs));
                    }
                    cases++;
                }
            }
        }
    }
    assert.equal(cases, 432);
});

test('239.5 seconds of a 240 second track advances on clean-EOF decoder error at every retry count', () => {
    for (const retryCount of [0, 1, 2]) {
        assert.equal(classifyVlcEnd({ posMs: 239500, trackEndMs: 240000, reason: 'error',
            sourceEof: true, sourceFailed: false, retryCount }).action, 'advance');
    }
});
