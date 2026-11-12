import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { reconcileVlcMprisStatus } from '../../src/engine/mpris-status.js';
import { lengthAfterOverrun } from '../../src/engine/track-end.js';

// Exercise the actual renderer poll and its IPC output, including cached position.
const source = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
const start = source.indexOf('function _vlcUpdatePosition(');
const poll = source.slice(start, source.indexOf('\n}\n', start) + 2);
function setup(extra = {}) {
    const updates = [];
    const context = vm.createContext({
        _vlcPosMs: 0, _vlcSeekFrozen: false, _durationSec: 240, _vlcTickCount: 3,
        _vlcPaused: false, _vlcLoading: false, _rendererMprisStatus: 'Stopped',
        _seekBurstLog: 0, _mkInstance: null, reconcileVlcMprisStatus, lengthAfterOverrun,
        Event, console, window: { adamBridge: { mprisUpdate: data => updates.push({ ...data }) } },
        ...extra,
    });
    vm.runInContext(poll, context);
    return { context, updates, tick: (pos, state = 'playing') => context._vlcUpdatePosition(pos, state, { dispatchEvent() {} }) };
}
test('VLC poll publishes Playing and position after a missed MusicKit event, once', () => {
    const { context, updates, tick } = setup();
    tick(1200);
    assert.deepEqual(updates[0], { position: 1200000, status: 'Playing' });
    context._vlcTickCount = 7;
    tick(2200);
    assert.deepEqual(updates[1], { position: 2200000 });
});
test('VLC poll cannot infer playback from a cached seek position when the decoder reports zero', () => {
    const { updates, tick } = setup({ _vlcPosMs: 60000 });
    tick(0);
    assert.deepEqual(updates[0], { position: 60000000 });
});
test('VLC poll preserves pause, opening and seek guards', () => {
    for (const extra of [{ _vlcLoading: true }, { _vlcSeekFrozen: true }, { _vlcPaused: true }]) {
        const { updates, tick } = setup(extra);
        tick(1200);
        assert.equal(updates[0].status, undefined);
    }
    const { updates, tick } = setup({ _vlcPaused: true, _rendererMprisStatus: 'Playing' });
    tick(1200, 'paused');
    assert.equal(updates[0].status, 'Paused');
});
