// Pure catalog-item helpers extracted from engine-playback. No shared state, no
// DOM/MusicKit — plain functions of a MusicKit item object, directly testable.
// esbuild inlines these back into engine-bundle.js at build time.

// extractItemId — the catalog/library id of a MusicKit queue item, trying the
// several shapes MK uses, else null.
export const extractItemId = (item) =>
    item?.playParams?.catalogId
    ?? item?.attributes?.playParams?.catalogId
    ?? item?.id
    ?? item?.playParams?.id
    ?? item?.attributes?.playParams?.id
    ?? null;

// isVideoType — true when a MusicKit type/kind string denotes a music video.
export const isVideoType = (t) =>
    t === 'music-videos' || t === 'musicVideo' || t === 'library-music-videos';

// extractItemType — the type/kind string of an item (song vs music-video), else null.
export const extractItemType = (item) =>
    item?.type ?? item?.attributes?.playParams?.kind ?? item?.playParams?.kind ?? null;
