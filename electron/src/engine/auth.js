// Adapted from silentone12725/apple-music-linux PR #1 (https://github.com/silentone12725/apple-music-linux/pull/1), Adam naming.
// A saved account is independent of whether the lazy DRM backend is running.
export function accountSignedIn(status) {
    const state = status?.state ?? {};
    if (state.authentication === 'failed' || state.session === 'expired') return false;
    return status?.capabilities?.cbcs === true || state.fairplay === 'ready' ||
        state.authentication === 'logged_in' || state.session === 'valid';
}

// Whether lossless can play or download right now: FairPlay decryption is live. A saved account alone is not
// enough (accountSignedIn is true for it): the DRM backend starts lazily, and until it is ready, or after it
// failed, only AAC works. Everything that offers or requests lossless asks this, never accountSignedIn.
export function losslessReady(status) {
    return status?.capabilities?.cbcs === true || status?.state?.fairplay === 'ready';
}

// The quality a download should ask for: the Downloads setting, held to what the global Lossless toggle and the
// engine allow. quality is 'high-quality' | 'lossless' | 'hi-res-lossless'. The engine decides again, from its
// own DRM state, so a stale answer here costs a lower quality, never a failed download.
export function downloadQuality({ prefs = {}, fallback = 'lossless', ready = false }) {
    const wanted = prefs['dl-quality'] || prefs['downloads-quality'] || fallback;
    const lossless = ready && prefs['lossless-enabled'] !== false && wanted !== 'high-quality';
    return { lossless, hiRes: lossless && wanted === 'hi-res-lossless' };
}

export function authProgress(status) {
    const state = status?.state ?? {};
    // A retained session must never hide a fresh challenge or failure.
    if (state.authentication === 'challenging' && status.challenge) return 'challenge';
    if (state.authentication === 'failed' || state.manager === 'failed') return 'failed';
    if (state.authentication === 'logging_in' || state.process === 'starting') return 'pending';
    if (state.authentication === 'logged_in' && state.process === 'running' ||
        state.fairplay === 'ready' || status?.capabilities?.cbcs === true) return 'done';
    return 'pending';
}

export function drmURL(base, endpoint) {
    return `${base.replace(/\/+$/, '')}/api/v1/drm/${endpoint}`;
}
