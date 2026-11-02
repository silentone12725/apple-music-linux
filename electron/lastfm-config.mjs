// Last.fm is optional. No application credentials are shipped or auto-seeded.
export function lastfmConfiguration(store = {}) {
    const field = value => typeof value === 'string' && value.length <= 128 ? value.trim() : '';
    const key = field(store.lastfm_api_key);
    const secret = field(store.lastfm_secret);
    return { key, secret, configured: !!(key && secret) };
}
