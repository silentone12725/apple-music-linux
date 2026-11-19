import { extractItemId } from './catalog.js';

const catalogId = id => typeof id === 'string' && /^\d+$/.test(id);

export async function resolveAlbumQueue(mk, albumId, startId, fetchAll, { clickedId, cachedTracks = [] } = {}) {
    const encodedId = encodeURIComponent(albumId);
    const res = await mk.api.music(`/v1/me/library/albums/${encodedId}`, { include: 'catalog' });
    if (res?.data?.errors?.length) throw new Error('Album lookup failed');
    const album = res?.data?.data?.[0];
    if (!album) throw new Error('Library album not found');
    const catalog = album.relationships?.catalog?.data?.[0];
    const count = catalog?.attributes?.trackCount;
    const libraryItems = album.relationships?.tracks?.data ?? [];
    const path = catalog?.id
        ? `/v1/catalog/${encodeURIComponent(mk.storefrontId || 'us')}/albums/${encodeURIComponent(catalog.id)}/tracks`
        : `/v1/me/library/albums/${encodedId}/tracks`;

    // A library album can contain only favorites. Trust the local DB only when the
    // catalog's track count independently confirms that we have a complete edition.
    const cachedIds = cachedTracks.map(track => track.cid);
    const completeCache = count > 0 && cachedIds.length === count && new Set(cachedIds).size === count && cachedIds.every(catalogId);
    const items = completeCache ? [] : await fetchAll(path);
    const ids = completeCache ? cachedIds : items.map(extractItemId);
    if (!ids.length || ids.some(id => !catalogId(id)) || (count > 0 && ids.length !== count)) {
        throw new Error('Album queue is incomplete or contains a track without a catalog ID');
    }
    const libraryItem = [...libraryItems, ...items].find(item => item.id === startId);
    const cached = cachedTracks.find(item => item.lid === startId);
    const start = [extractItemId(libraryItem), startId, clickedId, cached?.cid].find(id => ids.includes(id));
    if (startId && !start) throw new Error('Album start track could not be resolved');
    return { ids, startId: start ?? null };
}
