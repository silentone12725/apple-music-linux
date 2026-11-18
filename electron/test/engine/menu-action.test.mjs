import test from 'node:test';
import assert from 'node:assert/strict';
import { fnv1a, createMenuActionResolver, menuAction, normalizeTitle, TRANSLATED_TITLE_ACTIONS } from '../../src/engine/menu-action.js';

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

test("the icon table covers Apple's menu icons and is well-formed", async () => {
    const { GLYPH_ACTIONS } = await import('../../src/engine/menu-action.js');
    const hashes = Object.keys(GLYPH_ACTIONS), names = Object.values(GLYPH_ACTIONS);
    assert.equal(new Set(hashes).size, hashes.length, 'no hash twice');
    assert.equal(new Set(names).size, names.length, 'no action twice');
    for (const h of hashes) assert.match(h, /^[0-9a-f]{1,8}$/, `${h} is a 32-bit hex hash`);
    for (const wanted of ['embed', 'copy-link', 'credits', 'add-to-playlist', 'add-to-library', 'play-next', 'play-later']) {
        assert.ok(names.includes(wanted), `${wanted} is in the table`);
    }
    // These three were checked against the live menu (it and en-US storefronts).
    assert.equal(GLYPH_ACTIONS.d0fdaec1, 'embed');
    assert.equal(GLYPH_ACTIONS.aa2cdf75, 'copy-link');
    assert.equal(GLYPH_ACTIONS.c472d89c, 'credits');
});

test('Add to Playlist is found by title on English pages, and by its icon in any language', () => {
    assert.equal(menuAction('', 'Add to Playlist'), 'add-to-playlist');
    assert.equal(menuAction('', 'Aggiungi alla playlist'), 'add-to-playlist', 'Apple ships the Italian title too');
});

test('pin, unpin and delete are recognised by title in every language Apple ships', async () => {
    const { MENU_TITLES } = await import('../../src/engine/menu-titles.js');
    assert.equal(menuAction('', 'Pin Album'), 'pin');
    assert.equal(menuAction('', 'Unpin Song'), 'unpin');
    assert.equal(menuAction('', 'Delete from Library'), 'delete-from-library');
    assert.equal(menuAction('', 'Remove from Library'), 'delete-from-library');
    assert.equal(menuAction('', 'Album rögzítése'), 'pin');
    assert.equal(menuAction('', 'Kiinnitä albumi'), 'pin');
    for (const action of ['pin', 'unpin', 'delete-from-library', 'add-to-playlist']) {
        assert.ok(MENU_TITLES[action].length >= 20, `${action} has titles from many languages`);
        for (const t of MENU_TITLES[action]) {
            assert.equal(t, normalizeTitle(t), 'stored titles are normalised');
            assert.equal(TRANSLATED_TITLE_ACTIONS[t], action, `${t} is not claimed by another action`);
        }
    }
});

test('titles match through Apple\'s soft hyphens, non-breaking spaces and case', () => {
    assert.equal(normalizeTitle('Delete\u00a0from\u00ad Library '), 'delete from library');
    assert.equal(menuAction('', 'Dele\u00adte\u00a0from Library'), 'delete-from-library');
    assert.equal(menuAction('', 'UNPIN ALBUM'), 'unpin');
    assert.equal(menuAction('', 'Something else'), null);
});

test('no title is shared by two actions', async () => {
    const { MENU_TITLES } = await import('../../src/engine/menu-titles.js');
    const seen = new Map();
    for (const [action, titles] of Object.entries(MENU_TITLES)) for (const t of titles) {
        assert.ok(!seen.has(t) || seen.get(t) === action, `${t}: ${seen.get(t)} vs ${action}`);
        seen.set(t, action);
    }
});
