import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { classifyVlcEnd } from '../../src/engine/vlc-end.js';

const source = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
function fn(name, next) {
    return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`function ${next}(`));
}
const handler = fn('_vlcHandleEnded', '_vlcHandleStateChange');

function setup(extra = {}, code = handler) {
    const calls = { next: 0, retry: 0, stop: 0, pause: 0, toast: 0 };
    const context = vm.createContext({
        _durationSec: 240, _vlcRetryCount: 0, _vlcSourceEof: false, _vlcSourceFailed: false,
        _vlcSeekOffsetMs: 0, _vlcPaused: false, _vlcLoading: true, _allowCDNTransition: false,
        ENGINE: 'https://127.0.0.1:20025', classifyVlcEnd, VLC_MAX_RETRIES: 2, Event, console,
        stopVLCPoll() {}, _vlcRetryFrom() { calls.retry++; },
        _adamNextRef() { calls.next++; return Promise.resolve(); },
        _adamToast() { calls.toast++; },
        fetch() { calls.stop++; throw new Error('unexpected command after a terminal state'); },
        audio: { dispatchEvent(event) { assert.equal(event.type, 'pause'); calls.pause++; } },
        ...extra,
    });
    vm.runInContext(code, context);
    return { context, calls, end(pos, reason = 'ended') {
        context._vlcHandleEnded(pos, context.audio, reason);
    } };
}

test('the real end handler retries twice and stops without advancing the queue', () => {
    const { context, calls, end } = setup();
    end(0); end(0); end(0);
    assert.deepEqual(calls, { next: 0, retry: 2, stop: 0, pause: 1, toast: 1 });
    assert.equal(context._vlcPaused, true);
    assert.equal(context._vlcLoading, false);
    assert.equal(context._durationSec, 240);
});

test('natural ends still advance multiple tracks, including a short clean data end', () => {
    const { calls, end } = setup({ _vlcSourceEof: true });
    for (const pos of [210000, 237000, 240000]) end(pos);
    assert.deepEqual(calls, { next: 3, retry: 0, stop: 0, pause: 0, toast: 0 });
});

test('a source failure near the reported end is retried and stops instead of becoming natural EOF', () => {
    const { calls, end } = setup({ _vlcSourceFailed: true });
    end(239900); end(239900); end(239900);
    assert.equal(calls.next, 0);
    assert.equal(calls.retry, 2);
    assert.equal(calls.stop, 0);
});

test('the real track reset and poll startup clear the prior failure and retry budget', () => {
    const { context, calls, end } = setup({
        _vlcSourceFailed: true, _vlcRetryCount: 2, _vlcPaused: true,
        _pipeCtrl: null, _abortCtrl: null, _streamComplete: false,
        _seekFetchCtrl: null, _vlcSeekTimer: null, _sessionId: 'failed',
        window: {}, PLAY_STATE: { IDLE: 'idle' },
        setPlayState() {}, _syncVLCControls() {}, _stopLyricsFreeze() {},
        unbridgeDuration() {}, deleteSession() {}, showQualityBadge() {},
        _vlcPollGeneration: 1, T: () => ({ poll: 250 }), setInterval: () => 1,
    });
    for (const name of ['_resetPlaybackState', 'startVLCPoll']) {
        const start = source.indexOf(`function ${name}(`);
        vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 2), context);
    }
    context._resetPlaybackState();
    assert.equal(context._vlcRetryCount, 0);
    assert.equal(context._vlcPaused, false);
    context._sessionId = 'next';
    context._durationSec = 240;
    context.startVLCPoll(context.audio);
    assert.equal(context._vlcSourceFailed, false);
    end(0);
    assert.equal(calls.retry, 1);
    assert.equal(calls.pause, 0);
    context._vlcSourceEof = true;
    end(239000);
    assert.equal(calls.next, 1);
});

test('the generated bundle executes the same failure stop and natural end behavior', () => {
    const bundle = readFileSync(new URL('../../engine-bundle.js', import.meta.url), 'utf8');
    const start = bundle.indexOf('function classifyVlcEnd(');
    assert.ok(start >= 0);
    const classifier = bundle.slice(start, bundle.indexOf('\n  }\n', start) + 4);
    const endHandler = bundle.slice(bundle.indexOf('function _vlcHandleEnded('),
        bundle.indexOf('function _vlcHandleStateChange('));
    const { context, calls, end } = setup({}, classifier + '\n' + endHandler);
    end(0); end(0); end(0);
    assert.deepEqual(calls, { next: 0, retry: 2, stop: 0, pause: 1, toast: 1 });
    context._vlcSourceEof = true;
    context._vlcRetryCount = 0;
    end(239000);
    assert.equal(calls.next, 1);
});
