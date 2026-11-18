import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_SELECTOR, skipDirection, footerAction } from '../../src/engine/transport-skip.js';

const el = (localName, { classes = [], attrs = {} } = {}) => ({
    localName, classList: { contains: c => classes.includes(c) }, getAttribute: k => attrs[k] ?? null,
});

test("the player bar's skip controls are told apart by class, whatever language their hidden label is in", () => {
    // as captured from the live Italian page: INDIETRO / AVANTI
    assert.equal(skipDirection(el('div', { classes: ['skip', 'svelte-1xlebv7', 'previous'] })), 'previous');
    assert.equal(skipDirection(el('div', { classes: ['skip', 'svelte-1xlebv7', 'next'] })), 'next');
    assert.equal(skipDirection(el('div', { classes: ['skip'] })), null);
});

test('the MusicKit skip component is told apart by its direction attribute', () => {
    assert.equal(skipDirection(el('amp-playback-controls-skip', { attrs: { direction: 'back' } })), 'previous');
    assert.equal(skipDirection(el('amp-playback-controls-skip', { attrs: { direction: 'forward' } })), 'next');
    assert.equal(skipDirection(el('amp-playback-controls-skip', { attrs: { direction: 'sideways' } })), null);
    assert.equal(skipDirection(null), null);
});

test('the selector names both shapes and nothing language-dependent', () => {
    assert.match(SKIP_SELECTOR, /playback-control-item-skip/);
    assert.match(SKIP_SELECTOR, /amp-playback-controls-skip/);
    assert.doesNotMatch(SKIP_SELECTOR, /aria-label/);
});

test('footer buttons act by element and direction, not by label', () => {
    const inside = (map) => (sel) => map[sel] ?? null;
    const skipBack = el('amp-playback-controls-skip', { attrs: { direction: 'back' } });
    const skipFwd = el('amp-playback-controls-skip', { attrs: { direction: 'forward' } });
    assert.deepEqual(footerAction('skip-control button--back duration10', inside({ 'amp-playback-controls-skip': skipBack })), { action: 'skip', delta: -10 });
    assert.deepEqual(footerAction('skip-control button--forward duration10', inside({ 'amp-playback-controls-skip': skipFwd })), { action: 'skip', delta: 10 });
    assert.deepEqual(footerAction('skip-control button--back', inside({})), { action: 'skip', delta: -10 }, 'the class alone is enough');
    assert.deepEqual(footerAction('playback-play__pause', inside({ 'amp-playback-controls-play': el('amp-playback-controls-play') })), { action: 'play' });
    assert.deepEqual(footerAction('x', inside({ 'amp-playback-controls-play': el('amp-playback-controls-play') })), { action: 'play' }, 'the element alone is enough');
    assert.deepEqual(footerAction('x', inside({ 'amp-playback-controls-full-screen': el('amp-playback-controls-full-screen') })), { action: 'fullscreen' });
    assert.equal(footerAction('captions-button', inside({})), null, 'anything else is left to Apple');
});
