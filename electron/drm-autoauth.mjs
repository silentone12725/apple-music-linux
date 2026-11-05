// Sign in again on launch with the saved Apple Account when the engine has no session.
// The decision logic lives here, apart from main.mjs, so it can be tested with a fake engine.

const SETUP_PREFIX = 'FairPlay setup: '; // engine/core/drm/fairplay_setup.go: SetupErrorPrefix

/**
 * @param request  async (method, path, body?) => { status, json } | null  (null: engine unreachable)
 * @param creds    { email, password } saved earlier
 * @param forget   async () => void  removes the saved credentials
 * @returns one of 'no-engine' | 'has-session' | 'rejected' | 'kept' | 'signed-in' | 'needs-code' | 'timeout'
 *
 * Saved credentials are removed as soon as Apple turns them down, so a changed password is
 * tried once rather than on every launch (repeated bad attempts can lock the account). They are
 * kept when the failure is about this installation (missing libraries) or the engine was
 * unreachable, because the same password can work later.
 */
export async function autoAuthenticate({ request, creds, forget, sleep = (ms) => new Promise(r => setTimeout(r, ms)),
    now = Date.now, pollMs = 2000, timeoutMs = 8 * 60 * 1000, log = () => {} }) {
    const status = await request('GET', '/api/v1/drm/status');
    if (!status || status.status !== 200 || !status.json) return 'no-engine';
    const st = status.json.state ?? {};
    // A session still loading must not be replaced by a fresh sign-in, which would ask Apple for another code.
    if (st.fairplay === 'ready' || st.session === 'valid') return 'has-session';

    log('Auto-authenticating with saved DRM credentials');
    const sentAt = now();
    const res = await request('POST', '/api/v1/drm/authenticate', { email: creds.email, password: creds.password });
    if (!res) return 'no-engine';
    if (res.status !== 202 && res.status !== 200) {
        if (res.status === 400) { await forget(); return 'rejected'; }
        return 'kept'; // 503: no DRM layer in this build; nothing to retry with
    }

    for (const deadline = sentAt + timeoutMs; now() < deadline; await sleep(pollMs)) {
        const r = await request('GET', '/api/v1/drm/status');
        const snap = r?.json;
        if (!snap) continue;
        // Ignore what the engine reported before it took this attempt.
        const at = Date.parse(snap.timestamp ?? '');
        if (Number.isFinite(at) && at < sentAt - 1000) continue;
        const auth = snap.state?.authentication;
        if (auth === 'logged_in' || snap.state?.fairplay === 'ready') return 'signed-in';
        if (auth === 'challenging') {
            // These details no longer sign in silently (Apple wants a code): drop them so the next
            // launch does not start another unattended sign-in. The sheet takes this attempt from here.
            await forget();
            return 'needs-code';
        }
        if (auth === 'failed') {
            if (String(snap.message ?? '').includes(SETUP_PREFIX)) return 'kept';
            await forget();
            return 'rejected';
        }
    }
    return 'timeout';
}
