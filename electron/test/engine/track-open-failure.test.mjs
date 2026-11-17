import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
const start = source.indexOf('async function handleTrackChange(');
const body = source.slice(start, source.indexOf('\n}\n', start) + 2);
function setup() {
    const states = [], messages = [], audio = { paused: true };
    let rejectOpen;
    const context = vm.createContext({
        _generation: 0, _abortCtrl: null, console: { log() {}, error() {} }, performance,
        window: {}, document: { documentElement: { lang: 'it' } },
        PLAY_STATE: { IDLE: 'idle', OPENING: 'opening' },
        _extractItemId: item => item?.id, _closeCDNGate() {}, _htcConfirmDirectPlay: () => false, _resetPlaybackState() {},
        _slInitForTrack() {}, _htcDiscardStalePrewarms() {}, getMKAudio: () => audio,
        installPlayProxy() {}, waitForLossless: async () => {}, T: () => ({ losslessWait: 0 }),
        _resolveSession: () => new Promise((_, reject) => { rejectOpen = reject; }),
        setPlayState: (...args) => states.push(args), _adamToast: text => messages.push(text),
    });
    vm.runInContext('function genStale(g) { return g !== _generation; }\n' + body, context);
    const mk = { nowPlayingItem: { id: 'unavailable', attributes: { name: 'Unavailable song' } }, storefrontId: 'it' };
    return { context, audio, states, messages, mk, reject: () => rejectOpen(new Error('no HLS URL')) };
}
test('an unavailable track reports failure instead of being treated as a ready decoder', async () => {
    const s = setup();
    const pending = s.context.handleTrackChange(s.mk);
    await new Promise(r => setImmediate(r)); s.reject();
    assert.equal(await pending, false);
    assert.equal(Object.hasOwn(s.audio, 'load'), false);
    assert.equal(s.states.at(-1)[0], 'idle');
    assert.equal(s.messages.length, 1, 'the user must see why the skip produced no new audio');
});
test('a late failure must not reset the newer track or show an obsolete error', async () => {
    const s = setup();
    const pending = s.context.handleTrackChange(s.mk);
    await new Promise(r => setImmediate(r));
    s.context._generation++; s.states.length = 0; s.reject();
    await pending;
    assert.deepEqual(s.states, []);
    assert.deepEqual(s.messages, []);
});
test('failed navigation releases queued skips and does not publish playing metadata', () => {
    const a = source.indexOf('        if (ready === false) {');
    const block = source.slice(a, source.indexOf('\n        _adamReadyRevision', a));
    const calls = [];
    const context = vm.createContext({
        ready: false, navigationRevision: 3, _adamNavRevision: 3,
        _clearAdvancing: () => calls.push('release'), _updateTransportButtons() {},
        sendMprisStatus: value => calls.push(value),
    });
    vm.runInContext('(function () {' + block + '})()', context);
    assert.equal(context._adamNavRevision, 4, 'the failed pending MusicKit command is obsolete');
    assert.deepEqual(calls, ['release', 'Stopped']);
});

test('superseded resets still await the old release before reopening the same track', async () => {
    let finishRelease;
    const release = new Promise(resolve => { finishRelease = resolve; });
    const i = source.indexOf('function _resetPlaybackState() {');
    const reset = source.slice(i, source.indexOf('\nasync function _resolveSession', i));
    const ids = [];
    const context = vm.createContext({
        PLAY_STATE: { IDLE: 'idle' }, setPlayState() {},
        _pipeCtrl: null, _abortCtrl: null, _streamComplete: false, _activeMs: null,
        _seekFetchCtrl: null, _vlcSeekTimer: null, _sessionId: 'old-session',
        _sessionReleasePending: Promise.resolve(), window: {},
        _syncVLCControls() {}, _stopLyricsFreeze() {}, stopVLCPoll() {},
        unbridgeDuration() {}, showQualityBadge() {},
        deleteSession: id => { if (id) { ids.push(id); return release; } },
    });
    vm.runInContext(reset, context);
    const first = context._resetPlaybackState();
    let settled = false;
    const second = context._resetPlaybackState().then(() => { settled = true; });
    await new Promise(r => setImmediate(r));
    assert.deepEqual(ids, ['old-session']);
    assert.equal(settled, false, 'the latest reset must not lose an earlier pending DELETE');
    finishRelease();
    await Promise.all([first, second]);
    assert.equal(settled, true);
});
