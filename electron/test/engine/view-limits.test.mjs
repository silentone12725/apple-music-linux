import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanZoom, cleanBgBlur, cleanTrackReport } from '../../src/engine/view-limits.js';

test('zoom is clamped to a usable range and refuses non-numbers', () => {
    assert.equal(cleanZoom(1), 1);
    assert.equal(cleanZoom('1.25'), 1.25);
    assert.equal(cleanZoom(1e9), 5);
    assert.equal(cleanZoom(0.0001), 0.25);
    assert.equal(cleanZoom(-3), 0.25);
    for (const bad of [NaN, Infinity, 'x', null, undefined, {}]) assert.equal(cleanZoom(bad), null, String(bad));
});

test('background blur is a whole number of px within range', () => {
    assert.equal(cleanBgBlur(18.4), 18);
    assert.equal(cleanBgBlur(1e6), 100);
    assert.equal(cleanBgBlur(-5), 0);
    assert.equal(cleanBgBlur('x'), null);
});

test('track reports keep only well-formed fields', () => {
    const now = Date.UTC(2026, 10, 19);
    const ts = Math.floor(now / 1000);
    assert.deepEqual(cleanTrackReport({ artist: 'A', track: 'T', album: 'Al', duration: 200, junk: 1 }), { artist: 'A', track: 'T', album: 'Al', duration: 200 });
    assert.equal(cleanTrackReport({ artist: 'A' }), null);
    assert.equal(cleanTrackReport({ artist: {}, track: 'T' }), null);
    assert.equal(cleanTrackReport({ artist: 'x'.repeat(513), track: 'T' }), null);
    assert.equal(cleanTrackReport({ artist: 'A', track: 'T', duration: -1 }), null);
    assert.equal(cleanTrackReport(null), null);
    assert.deepEqual(cleanTrackReport({ artist: 'A', track: 'T', timestamp: ts }, { needTimestamp: true, now }), { artist: 'A', track: 'T', timestamp: ts });
    assert.equal(cleanTrackReport({ artist: 'A', track: 'T' }, { needTimestamp: true, now }), null, 'scrobble needs a time');
    assert.equal(cleanTrackReport({ artist: 'A', track: 'T', timestamp: ts + 10 * 86400 }, { needTimestamp: true, now }), null, 'far future');
    assert.equal(cleanTrackReport({ artist: 'A', track: 'T', timestamp: 5 }, { needTimestamp: true, now }), null, 'before 2000');
    assert.equal(cleanTrackReport({ artist: 'A', track: 'T', timestamp: 1.5 }, { needTimestamp: true, now }), null);
});
