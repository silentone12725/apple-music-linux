import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
const start = source.indexOf('async function _setupVLCPath(');
const body = source.slice(start, source.indexOf('\n}\n', start) + 2);

function setup() {
    let finishLoad;
    const requests = [], revoked = [], polls = [];
    const audio = new EventTarget();
    const context = vm.createContext({
        console, performance, Event, AbortSignal, setTimeout, clearTimeout, MediaSource: class {},
        URL: { createObjectURL: () => 'blob:old', revokeObjectURL: u => revoked.push(u) },
        HTMLMediaElement: { prototype: { load() {} } },
        window: {}, ENGINE: 'https://engine', _sessionId: 'old',
        _vlcTransport: { reset() {} }, _syncVLCControls() {},
        _nativeSrcSet: function () {}, _vlcVolPersist: 37, _scFactor: 1,
        _rememberVlcVolume() {}, _startLyricsFreeze() {}, _stopLyricsFreeze() {},
        unbridgeDuration() {}, stopVLCPoll() {}, startVLCPoll: () => polls.push('start'),
        _pendingVLCIntent: null,
        fetch: (url) => {
            requests.push(url);
            if (url.endsWith('/load')) return new Promise(r => { finishLoad = r; });
            return Promise.resolve({ ok: true });
        },
    });
    vm.runInContext(body, context);
    const ctrl = new AbortController();
    const loading = context._setupVLCPath(audio, {}, 'old', ctrl, performance.now());
    return { context, audio, ctrl, loading, requests, revoked, polls, finishLoad: r => finishLoad(r) };
}

test('skipping during VLC load removes the old overrides before the next track starts', async () => {
    const { audio, ctrl, loading, requests, revoked, polls, finishLoad } = setup();
    assert.equal(Object.hasOwn(audio, 'paused'), true);
    ctrl.abort();
    for (const key of ['paused', 'currentTime', 'volume', 'muted', 'pause']) {
        assert.equal(Object.hasOwn(audio, key), false, `${key} cleaned while fetch is pending`);
    }
    Object.defineProperty(audio, 'paused', { value: true, configurable: true });
    finishLoad({ ok: true });
    await loading;
    assert.equal(audio.paused, true, 'the superseded load leaves the new track alone');
    assert.deepEqual(requests, ['https://engine/api/v1/vlc/load'], 'no stale volume POST');
    assert.deepEqual(polls, [], 'no stale poll');
    assert.deepEqual(revoked, ['blob:old']);
});


test('queued navigation waits for decoded playback, not merely the load response', async () => {
    const s = setup();
    let ready = false;
    s.loading.then(() => { ready = true; });
    s.finishLoad({ ok: true });
    await new Promise(r => setImmediate(r));
    assert.deepEqual(s.polls, ['start']);
    assert.equal(ready, false, 'the synthetic canplay event is not decoder readiness');
    s.context._vlcLoading = false;
    s.audio.dispatchEvent(new Event('playing'));
    await s.loading;
    assert.equal(ready, true);
    s.ctrl.abort();
});
