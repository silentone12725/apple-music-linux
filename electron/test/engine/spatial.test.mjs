import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wantsAtmos } from '../../src/engine/spatial.js';
import { playbackMode, needsVlcStop } from '../../src/engine/handoff.js';

test('spatial requests are opt-in and require native song audio', () => {
    for (const preference of [undefined, '', 'off', 'invalid']) {
        assert.equal(wantsAtmos(preference, true), false);
    }
    assert.equal(wantsAtmos('atmos', true), true);
    assert.equal(wantsAtmos('atmos', false), false);
    assert.equal(wantsAtmos('atmos', true, true), false);
});

test('EC-3 uses the native player and stops when switching to AAC', () => {
    const mode = playbackMode({ codec: 'atmos' });
    assert.equal(mode, 'alac'); // existing internal name for the native VLC route
    assert.equal(needsVlcStop(mode, playbackMode({ codec: 'aac' })), true);
    assert.equal(needsVlcStop(mode, playbackMode({ codec: 'alac' })), false);
});

// Execute the real startup preferences block with a delayed IPC response. No
// MusicKit, DOM, network or account is loaded. This catches startup proceeding
// before the saved setting is available, rather than just testing normalization.
const source = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
const start = source.indexOf('    // Push saved cache config to engine now');
const end = source.indexOf('    // React to DRM state changes', start);
assert.ok(start >= 0 && end > start);
const initializePreferences = new Function('window', `
    let _streamingQuality = 'lossless', _spatialAudio = 'off', _downloadsQuality = 'lossless';
    const _engineCaps = { lossless: true };
    return (async () => {
        ${source.slice(start, end)}
        return { spatial: _spatialAudio, quality: _streamingQuality };
    })();
`);

test('startup waits for saved spatial preferences before proceeding', async () => {
    let resolve;
    const prefs = new Promise(r => { resolve = r; });
    let ready = false;
    const startup = initializePreferences({ adamBridge: { getPrefs: () => prefs } });
    startup.then(() => { ready = true; });
    await new Promise(r => setImmediate(r));
    assert.equal(ready, false);
    resolve({ 'spatial-audio': 'atmos', 'streaming-quality': 'hi-res-lossless' });
    assert.deepEqual(await startup, { spatial: 'atmos', quality: 'hi-res-lossless' });
});

test('unavailable or invalid preferences retain safe defaults', async () => {
    assert.deepEqual(await initializePreferences({}), { spatial: 'off', quality: 'lossless' });
    assert.deepEqual(await initializePreferences({ adamBridge: { getPrefs: async () => { throw new Error('IPC unavailable'); } } }),
        { spatial: 'off', quality: 'lossless' });
    const disabled = await initializePreferences({ adamBridge: { getPrefs: async () => ({ 'spatial-audio': 'invalid', 'lossless-enabled': false }) } });
    assert.deepEqual(disabled, { spatial: 'off', quality: 'high-quality' });
});
