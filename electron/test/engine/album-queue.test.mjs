import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAlbumQueue } from '../../src/engine/album-queue.js';

const ids = ['6826288464', '6826288474', '6826288477'];
const libraryTrack = { id: 'i.favorite', attributes: { playParams: { catalogId: ids[1] } } };
function setup(catalog = true) {
    const paths = [];
    const mk = { storefrontId: 'it', api: { music: async () => ({ data: { data: [{ relationships: {
        catalog: { data: catalog ? [{ id: '6826288271' }] : [] }, tracks: { data: [libraryTrack] },
    } }] } }) } };
    const fetchAll = async path => { paths.push(path); return ids.map(id => ({ id })); };
    return { mk, fetchAll, paths };
}
test('album Play includes the first track and the favorite second track in catalog order', async () => {
    const { mk, fetchAll, paths } = setup();
    assert.deepEqual(await resolveAlbumQueue(mk, 'l.partial', undefined, fetchAll), { ids, startId: null });
    assert.deepEqual(paths, ['/v1/catalog/it/albums/6826288271/tracks']);
});
test('clicking the favorite resolves its library ID without changing the album order', async () => {
    const { mk, fetchAll } = setup();
    assert.deepEqual(await resolveAlbumQueue(mk, 'l.partial', 'i.favorite', fetchAll), { ids, startId: ids[1] });
});
test('an album absent from the catalog retains its library track endpoint', async () => {
    const { mk, fetchAll, paths } = setup(false);
    await resolveAlbumQueue(mk, 'l.local', undefined, fetchAll);
    assert.deepEqual(paths, ['/v1/me/library/albums/l.local/tracks']);
});
test('a missing start track or failed fetch cannot silently play the wrong song', async () => {
    const { mk, fetchAll } = setup();
    await assert.rejects(resolveAlbumQueue(mk, 'l.partial', 'i.missing', fetchAll), /could not be resolved/);
    await assert.rejects(resolveAlbumQueue(mk, 'l.partial', undefined, async () => { throw new Error('offline'); }), /offline/);
});
