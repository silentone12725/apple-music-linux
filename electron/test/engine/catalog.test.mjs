// Unit tests for the extracted catalog helpers.
// Run: node --test electron/test/engine/catalog.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractItemId, isVideoType, extractItemType } from '../../src/engine/catalog.js';

test('extractItemId: precedence and fallbacks', () => {
    // playParams.catalogId wins over everything.
    assert.equal(extractItemId({ playParams: { catalogId: 'C1', id: 'X' }, id: 'Y' }), 'C1');
    // then attributes.playParams.catalogId
    assert.equal(extractItemId({ attributes: { playParams: { catalogId: 'C2' } }, id: 'Y' }), 'C2');
    // then top-level id
    assert.equal(extractItemId({ id: 'ID3' }), 'ID3');
    // then playParams.id
    assert.equal(extractItemId({ playParams: { id: 'P4' } }), 'P4');
    // then attributes.playParams.id
    assert.equal(extractItemId({ attributes: { playParams: { id: 'A5' } } }), 'A5');
    // nothing → null
    assert.equal(extractItemId({}), null);
    assert.equal(extractItemId(null), null);
    assert.equal(extractItemId(undefined), null);
});

test('isVideoType: only the three video kinds are true', () => {
    for (const t of ['music-videos', 'musicVideo', 'library-music-videos']) {
        assert.equal(isVideoType(t), true, `${t} should be video`);
    }
    for (const t of ['songs', 'song', 'library-songs', '', null, undefined]) {
        assert.equal(isVideoType(t), false, `${t} should not be video`);
    }
});

test('extractItemType: type then kind fallbacks', () => {
    assert.equal(extractItemType({ type: 'music-videos' }), 'music-videos');
    assert.equal(extractItemType({ attributes: { playParams: { kind: 'song' } } }), 'song');
    assert.equal(extractItemType({ playParams: { kind: 'musicVideo' } }), 'musicVideo');
    assert.equal(extractItemType({}), null);
    assert.equal(extractItemType(null), null);
});

test('a favorite/library item keeps the same identity and album position as its catalog track', () => {
    const album = ['6826288475', '6826288476', '6826288477'];
    const favorite = { id: 'a.123', type: 'library-songs', playParams: { catalogId: album[1] } };
    assert.equal(extractItemId({ id: 'a.6826288476' }), 'a.6826288476');
    assert.equal(extractItemId(favorite), album[1]);
    assert.equal(album.indexOf(extractItemId(favorite)), 1);
    assert.deepEqual([album[0], favorite, album[2]].map(i => typeof i === 'string' ? i : extractItemId(i)), album);
    assert.equal(extractItemId({ id: 'i.opaque', relationships: { catalog: { data: [{ id: album[1] }] } } }), album[1]);
    assert.equal(extractItemId({ id: 'i.opaque' }), 'i.opaque', 'opaque library IDs must never be fabricated');
    assert.equal(extractItemId({ id: 'a.not-a-number' }), 'a.not-a-number');
});
