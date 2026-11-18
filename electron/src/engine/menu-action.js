// Which action an item of Apple's web-player context menu performs, whatever the page language.
//
// Apple labels each item in the page language (title="Copy Embed Code" / "Copia codice incorporato"),
// so matching the English title only works on English pages. The icon is the same in every language,
// so an item is recognised by a hash of its glyph's path data, with the English title as a fallback
// for when Apple redraws an icon.

// FNV-1a, 32 bit: small, dependency-free, and plenty for telling a handful of icons apart.
export function fnv1a(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
}

// Hashes of the first path's data of Apple's own menu icons. They come from the icon map in Apple's
// script (music.apple.com/assets/index~*.js: AddToLibraryIcon ... HidePronunciationIcon); embed, copy link
// and credits were also checked against the live menu on the it and en-US storefronts, and matched.
// Pin and delete have no icon in that map, so they are not here.
export const GLYPH_ACTIONS = {
    '72557939': 'add-to-library',
    '2ddfd2ba': 'add-to-playlist',
    'c45f9389': 'add-to-calendar',
    '3f03920': 'calendar',
    'fc91e6a': 'create-station',
    'c472d89c': 'credits',
    'd0fdaec1': 'embed',
    '535086c5': 'favorite',
    'd6b3f193': 'folder',
    'aa2cdf75': 'copy-link',
    'd590f040': 'play-later',
    'ce078b17': 'play-next',
    'b439c1b5': 'remove-from-playlist',
    'f02b5d3d': 'share',
    'c5d19254': 'show-album',
    '3c79e931': 'suggest-less',
    '7ce46d0c': 'unfavorite',
    '3e19e401': 'show-translation',
    '7c52d55c': 'show-pronunciation',
    '77ac3a49': 'hide-translation',
    'c6f747d4': 'hide-pronunciation',
};
// 'Download' is what the page shows once Adam has renamed the embed item.
const ENGLISH_TITLE_ACTIONS = {
    'Copy Embed Code': 'embed', 'Download': 'embed', 'Copy Link': 'copy-link', 'Add to Playlist': 'add-to-playlist',
};

export function createMenuActionResolver(glyphActions = GLYPH_ACTIONS, titleActions = ENGLISH_TITLE_ACTIONS) {
    // glyphPath: the `d` attribute of the item's own icon path (empty when it has none); title: the item's title.
    return (glyphPath, title) => {
        if (glyphPath) {
            const byGlyph = glyphActions[fnv1a(glyphPath)];
            if (byGlyph) return byGlyph;
        }
        return titleActions[title] ?? null;
    };
}

export const menuAction = createMenuActionResolver();
