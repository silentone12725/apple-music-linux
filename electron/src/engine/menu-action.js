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

// Hashes of the icon path data of Apple's own glyphs, checked on the it and en-US storefronts.
const GLYPH_ACTIONS = { d0fdaec1: 'embed', aa2cdf75: 'copy-link' };
// 'Download' is what the page shows once Adam has renamed the embed item.
const ENGLISH_TITLE_ACTIONS = { 'Copy Embed Code': 'embed', 'Download': 'embed', 'Copy Link': 'copy-link' };

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
