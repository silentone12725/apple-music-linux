import { extractItemId } from './catalog.js';

// A library album may contain only its favorited songs; album Play needs the full catalog edition.
export async function resolveAlbumQueue(mk, albumId, startId, fetchAll) {
    const res = await mk.api.music(`/v1/me/library/albums/${encodeURIComponent(albumId)}`, { include: 'catalog' });
    const album = res?.data?.data?.[0];
    const catalogId = album?.relationships?.catalog?.data?.[0]?.id;
    const path = catalogId
        ? `/v1/catalog/${mk.storefrontId || 'us'}/albums/${encodeURIComponent(catalogId)}/tracks`
        : `/v1/me/library/albums/${encodeURIComponent(albumId)}/tracks`;
    const items = await fetchAll(path);
    const ids = items.map(extractItemId).filter(id => /^\d+$/.test(id));
    const libraryItem = album?.relationships?.tracks?.data?.find(i => i.id === startId);
    const target = extractItemId(libraryItem ?? { id: startId });
    if (!ids.length) throw new Error('Album has no playable catalog tracks');
    if (startId && !ids.includes(target)) throw new Error('Album start track could not be resolved');
    return { ids, startId: target };
}
