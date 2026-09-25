// Album-art palette extraction + role mapping for page theming. Pure functions
// of RGBA pixel data — no DOM — so they are directly testable; esbuild inlines
// them into engine-bundle.js.
//
// Why a palette and not one colour: averaging the artwork (or using Apple's
// single --artwork-bg-color) tints every surface the same hue, so the sidebar,
// page, tracklist and buttons blur into one wash. Instead we bucket the pixels,
// keep the most prominent *visually distinct* colours, and give each UI role
// its own colour and lightness band so elements stay distinguishable.

export function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
}

const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (v) => `${Math.round(v * 100)}%`;
const hsla = (h, s, l, a = 1) => `hsla(${Math.round(h)}, ${pct(s)}, ${pct(l)}, ${a})`;

// extractPalette — up to `max` prominent, mutually distinct colours from RGBA
// pixel data (e.g. a small canvas getImageData().data), most prominent first.
// Each entry: { h, s, l, weight } with weight = share of counted pixels.
export function extractPalette(data, max = 5) {
    const buckets = new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;                       // transparent
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        // Coarse bins: 15 hue sectors × 3 saturation × 5 lightness bands.
        // Near-greys collapse into hue sector 0 so they don't fragment.
        const sb = s < 0.12 ? 0 : s < 0.45 ? 1 : 2;
        const hb = sb === 0 ? 0 : Math.floor(h / 24) % 15;
        const lb = Math.min(4, Math.floor(l * 5));
        const key = hb * 100 + sb * 10 + lb;
        let bk = buckets.get(key);
        if (!bk) buckets.set(key, bk = { r: 0, g: 0, b: 0, n: 0 });
        bk.r += data[i]; bk.g += data[i + 1]; bk.b += data[i + 2]; bk.n++;
        total++;
    }
    if (!total) return [];
    const colors = [...buckets.values()]
        .map(bk => {
            const [h, s, l] = rgbToHsl(bk.r / bk.n, bk.g / bk.n, bk.b / bk.n);
            return { h, s, l, weight: bk.n / total };
        })
        .sort((a, b) => b.weight - a.weight);

    const picked = [];
    for (const c of colors) {
        if (c.weight < 0.01) break;                             // specks
        const distinct = picked.every(p =>
            (c.s > 0.12 && p.s > 0.12 ? hueDist(c.h, p.h) >= 30 : false) ||
            Math.abs(c.l - p.l) >= 0.22 ||
            Math.abs(c.s - p.s) >= 0.35);
        if (distinct) picked.push(c);
        if (picked.length === max) break;
    }
    return picked;
}

// Relative luminance of an HSL colour (0..1), for picking readable text.
function luminance(h, s, l) {
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const lin = v => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}

// paletteRoles — map extracted colours to UI roles for a dark layout. Each role
// sits in its own lightness band so surfaces stay distinguishable even when the
// artwork is nearly monochrome; hues come from different palette entries when
// the art has them. Returns CSS colour strings, or null for an empty palette.
export function paletteRoles(palette) {
    if (!palette?.length) return null;
    const base = palette[0];
    // Accent: the most vivid, mid-lightness colour (not necessarily dominant).
    const vivid = c => c.s * (1 - Math.abs(c.l - 0.55)) * (0.35 + Math.sqrt(c.weight));
    const accent = [...palette].sort((a, b) => vivid(b) - vivid(a))[0];
    const others = palette.filter(c => c !== base && c !== accent);
    // Secondary hues for the background glows; synthesise neighbours of the
    // base hue when the art does not provide enough distinct colours.
    const second = others[0] ?? { h: (base.h + 35) % 360, s: base.s, l: base.l };
    const third = others[1] ?? { h: (base.h + 325) % 360, s: base.s, l: base.l };

    const tone = (c, cap) => clamp(c.s, 0, cap);
    const mono = accent.s < 0.15;                               // greyscale art
    const accentS = mono ? 0 : clamp(accent.s, 0.55, 0.85);
    const accentL = mono ? 0.82 : 0.62;
    const onAccent = luminance(accent.h, accentS, accentL) > 0.36 ? '#000' : '#fff';

    return {
        pageBg:       hsla(base.h, tone(base, 0.45), 0.08),
        glowA:        hsla(second.h, tone(second, 0.6), 0.24, 0.55),
        glowB:        hsla(third.h, tone(third, 0.6), 0.2, 0.45),
        navBg:        hsla(base.h, tone(base, 0.35) * 0.8, 0.13, 0.60),
        raised:       hsla(second.h, tone(second, 0.3), 0.22, 0.5),
        border:       hsla(accent.h, mono ? 0 : 0.4, 0.55, 0.22),
        accent:       hsla(accent.h, accentS, accentL),
        accentActive: hsla(accent.h, accentS, accentL, 0.26),
        onAccent,
    };
}
