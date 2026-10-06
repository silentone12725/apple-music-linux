// A saved account is independent of whether the lazy DRM backend is running.
export function accountSignedIn(status) {
    const state = status?.state ?? {};
    if (state.authentication === 'failed' || state.session === 'expired') return false;
    return status?.capabilities?.cbcs === true || state.fairplay === 'ready' ||
        state.authentication === 'logged_in' || state.session === 'valid';
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
