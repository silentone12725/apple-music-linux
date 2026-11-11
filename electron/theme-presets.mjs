// The built-in theme. Palettes are fixed colour sets, never derived from an accent colour (neither
// the system's nor a picked one): derived palettes tinted the whole interface.
export const DEFAULT_PRESET = 'Apple Music';

export const BUILTIN_PRESETS = {
    'Apple Music': () => ({
        accent:       '#fc3c44',
        appearance:   'dark',
        bgColor:      '#000000',
        navBg:        '#303030',
        navBorder:    '#3b3b3b',
        accentActive: 'hsla(358, 87%, 60%, 0.28)',
    }),
    // The blue the current Apple Music web UI tints its sidebar icons with (its --keyAccentColor, #5ac8f5).
    'New Blue': () => ({
        accent:       '#5ac8f5',
        appearance:   'dark',
        bgColor:      '#000000',
        navBg:        '#303030',
        navBorder:    '#3b3b3b',
        accentActive: 'hsla(198, 89%, 65%, 0.28)',
    }),
};

export const defaultPalette = () => BUILTIN_PRESETS[DEFAULT_PRESET]();

// Bump when saved theme data needs a one-time reset.
export const THEME_VERSION = 2;

// Earlier versions generated a palette from an accent colour on first run and saved it, so
// every existing profile holds one. Drop it once (user presets and the chosen mode are kept):
// the default Apple Music palette applies instead. Returns true when prefs changed.
export function migrateThemePrefs(prefs) {
    if (prefs.themeVersion === THEME_VERSION) return false;
    delete prefs.themePalette;
    delete prefs.themeAppearance;
    prefs.themeVersion = THEME_VERSION;
    return true;
}

const PALETTE_COLOR_KEYS = ['accent', 'bgColor', 'navBg', 'navBorder', 'accentActive'];
// Colour syntax only: no quotes, semicolons, braces, url() or backslashes can get through.
const SAFE_COLOR = /^[#\w\s().,%/+-]{0,100}$/;

// Reduce an untrusted palette (imported file, old prefs) to known keys with string colour
// values. Anything else is dropped, so a hostile or corrupt preset cannot throw during
// theme application at startup or smuggle extra CSS. Returns null if nothing usable remains.
export function sanitizePalette(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const k of PALETTE_COLOR_KEYS) {
        const v = raw[k];
        if (typeof v === 'string' && SAFE_COLOR.test(v) && !/url\s*\(|expression\s*\(/i.test(v)) out[k] = v.trim();
    }
    if (raw.appearance === 'light' || raw.appearance === 'dark') out.appearance = raw.appearance;
    return Object.keys(out).length ? out : null;
}

// Validate an imported preset file's contents. Returns { name, palette } or null.
export function sanitizePreset(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > 64 || Object.hasOwn(BUILTIN_PRESETS, name)) return null;
    const palette = sanitizePalette(raw.palette);
    return palette ? { name, palette } : null;
}
