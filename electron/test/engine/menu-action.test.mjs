import test from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a, createMenuActionResolver, menuAction } from '../../src/engine/menu-action.js';

test('fnv1a matches the published 32-bit FNV-1a vectors', () => {
    assert.equal(fnv1a(''), '811c9dc5');
    assert.equal(fnv1a('a'), 'e40c292c');
    assert.equal(fnv1a('foobar'), 'bf9cf968');
});

test('an item is recognised by its icon whatever language its title is in', () => {
    const glyph = 'M1 2 3 4';
    const resolve = createMenuActionResolver({ [fnv1a(glyph)]: 'embed' }, {});
    for (const title of ['Copy Embed Code', 'Copia codice incorporato', 'Einbettungscode kopieren', '复制嵌入代码', '']) {
        assert.equal(resolve(glyph, title), 'embed', title);
    }
});

test('an unknown icon falls back to the English title, an unknown title to null', () => {
    assert.equal(menuAction('M0 0', 'Copy Embed Code'), 'embed');
    assert.equal(menuAction('', 'Download'), 'embed', 'the renamed item stays recognised');
    assert.equal(menuAction('', 'Copy Link'), 'copy-link');
    assert.equal(menuAction('M0 0', 'Copia codice incorporato'), null);
    assert.equal(menuAction(undefined, undefined), null);
});

test('the glyph beats a title that says something else', () => {
    const resolve = createMenuActionResolver({ [fnv1a('G')]: 'copy-link' }, { 'Copy Embed Code': 'embed' });
    assert.equal(resolve('G', 'Copy Embed Code'), 'copy-link');
});
