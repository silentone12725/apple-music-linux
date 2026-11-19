// Limits for values the page can send to the main process. A page-supplied number is saved and
// applied again at every start, so an absurd one would leave the window unusable until the
// preferences file is edited by hand.

export const ZOOM_MIN = 0.25, ZOOM_MAX = 5;
export const BG_BLUR_MIN = 0, BG_BLUR_MAX = 100;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Zoom factor, or null when v is not a usable number (the caller then ignores the request).
export function cleanZoom(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? clamp(n, ZOOM_MIN, ZOOM_MAX) : null;
}

// Background blur in px, or null when v is not a number.
export function cleanBgBlur(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.round(clamp(n, BG_BLUR_MIN, BG_BLUR_MAX)) : null;
}

const MAX_TEXT = 512;
const text = v => (typeof v === 'string' && v.trim() && v.length <= MAX_TEXT ? v : null);

// A scrobble or now-playing report from the page, reduced to the fields we send, or null.
// timestamp (seconds) is required when `needTimestamp` and must be a plausible time: after 2000
// and no more than a day ahead.
export function cleanTrackReport(t, { needTimestamp = false, now = Date.now() } = {}) {
    if (!t || typeof t !== 'object') return null;
    const artist = text(t.artist), track = text(t.track);
    if (!artist || !track) return null;
    const out = { artist, track };
    if (t.album != null) { const a = text(t.album); if (a) out.album = a; }
    if (t.albumArtist != null) { const a = text(t.albumArtist); if (a) out.albumArtist = a; }
    if (t.duration != null) {
        if (typeof t.duration !== 'number' || !Number.isFinite(t.duration) || t.duration < 0 || t.duration > 86400) return null;
        out.duration = t.duration;
    }
    if (needTimestamp || t.timestamp != null) {
        const ts = t.timestamp;
        if (!Number.isInteger(ts) || ts < 946684800 || ts > Math.floor(now / 1000) + 86400) return null;
        out.timestamp = ts;
    }
    return out;
}
