// Mode handoff: which player has to be stopped when the next track uses another path.
//
// Run: node --test electron/test/engine/handoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { playbackMode, needsVlcStop } from '../../src/engine/handoff.js';

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

test('handleTrackChange records the previous mode before the reset and stops libvlc once', () => {
    const src = readFileSync(new URL('../../src/engine-playback.js', import.meta.url), 'utf8');
    const i = src.indexOf('async function handleTrackChange');
    const body = src.slice(i, src.indexOf('\n}\n', i));
    const prev = body.indexOf("const _prevMode = _vlcMode ? 'alac' : null");
    const reset = body.indexOf('_resetPlaybackState()');
    assert.ok(prev > 0 && reset > prev, '_prevMode must be captured before _resetPlaybackState() clears _vlcMode');
    assert.equal(body.split('needsVlcStop(_prevMode, playbackMode(sess))').length - 1, 1);
    assert.equal(body.split('/api/v1/vlc/stop').length - 1, 1);
});
