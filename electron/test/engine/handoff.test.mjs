// Mode handoff: which player has to be stopped when the next track uses another path.
//
// Run: node --test electron/test/engine/handoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { playbackMode, needsVlcStop, leaveLossless } from '../../src/engine/handoff.js';

test('playbackMode picks the path from the engine session', () => {
    assert.equal(playbackMode({ codec: 'aac', capabilities: { audio: true } }), 'aac');
    assert.equal(playbackMode({ codec: 'alac', capabilities: { audio: true } }), 'alac');
    assert.equal(playbackMode({ codec: 'ec-3', capabilities: { audio: true } }), 'alac');
    // a music video wins whatever its audio codec says
    assert.equal(playbackMode({ codec: 'aac', capabilities: { audio: true, video: true } }), 'mv');
    assert.equal(playbackMode(null), 'alac');
});

test('every transition: libvlc is stopped only when leaving the lossless path', () => {
    const modes = [null, 'aac', 'alac', 'mv'];
    for (const prev of modes) {
        for (const next of ['aac', 'alac', 'mv']) {
            const want = prev === 'alac' && next !== 'alac';
            assert.equal(needsVlcStop(prev, next), want, `${prev} -> ${next}`);
        }
    }
});

test('lossless to lossless never stops libvlc (the next load replaces the media)', () => {
    assert.equal(needsVlcStop('alac', 'alac'), false);
});

const tick = () => new Promise(r => setImmediate(r));

test('leaveLossless waits for the stop to finish before resolving', async () => {
    const log = [];
    let release;
    const stop = () => new Promise(res => { release = () => { log.push('stopped'); res(); }; });
    const p = leaveLossless({ live: true, nextMode: 'aac', stop }).then(r => { log.push('resolved'); return r; });
    await tick();
    assert.deepEqual(log, [], 'must not resolve while the stop is still pending');
    release();
    assert.deepEqual(await p, { stopped: true, ok: true });
    assert.deepEqual(log, ['stopped', 'resolved']);
});

test('leaveLossless does not call stop when not needed', async () => {
    let calls = 0;
    const stop = async () => { calls++; };
    assert.deepEqual(await leaveLossless({ live: false, nextMode: 'aac', stop }), { stopped: false, ok: true });
    assert.deepEqual(await leaveLossless({ live: true, nextMode: 'alac', stop }), { stopped: false, ok: true });
    assert.equal(calls, 0);
});

test('leaveLossless reports a rejected stop without throwing', async () => {
    const r = await leaveLossless({ live: true, nextMode: 'mv', stop: async () => { throw new Error('engine down'); } });
    assert.deepEqual(r, { stopped: true, ok: false });
});

test('leaveLossless gives up after the timeout instead of hanging the next track', async () => {
    const r = await leaveLossless({ live: true, nextMode: 'aac', stop: () => new Promise(() => {}), timeoutMs: 20 });
    assert.deepEqual(r, { stopped: true, ok: false });
});

test('a lossless to AAC to MV to lossless run stops libvlc exactly once', async () => {
    let live = false, stops = 0;
    const stop = async () => { stops++; };
    for (const next of ['alac', 'aac', 'mv', 'alac', 'alac', 'mv']) {
        const r = await leaveLossless({ live, nextMode: next, stop });
        if (r.stopped && r.ok) live = false;
        if (next === 'alac') live = true;
    }
    assert.equal(stops, 2, 'once leaving each lossless run (alac->aac, alac->mv)');
    assert.equal(live, false);
});

test('handleTrackChange wiring: libvlc liveness is tracked, the stop is awaited, nothing is fire-and-forget', () => {
    const src = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
    const i = src.indexOf('async function handleTrackChange');
    const body = src.slice(i, src.indexOf('\n}\n', i));
    assert.ok(body.includes('await leaveLossless({'), 'the stop is awaited');
    assert.ok(body.indexOf('await leaveLossless({') < body.indexOf('await _setupMSEPath'), 'stop precedes the AAC path');
    assert.ok(body.indexOf('await leaveLossless({') < body.indexOf('await startMVPipeline'), 'stop precedes the MV path');
    assert.ok(body.indexOf('_vlcLive = true') < body.indexOf('await _setupVLCPath'), '_vlcLive is set when the ALAC path starts');
    // the only other /vlc/stop (the MusicKit handoff) goes through leaveLossless too
    assert.equal(src.split('/api/v1/vlc/stop').length - 1, 2);
    assert.ok(!/vlc\/stop`?'?, \{ method: 'POST' \}\)\.catch/.test(src), 'no fire-and-forget /vlc/stop');
});
