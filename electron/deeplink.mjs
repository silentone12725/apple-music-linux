// Link parsing for everything the app can be asked to open: its own adam:// links and every URL
// form Apple Music uses (https links on any Apple Music host, and the music://, musics://, itms://,
// itmss:// and itunes:// schemes). Pure functions, unit-tested in test/deeplink.test.mjs.
//
// parseLink() returns one of
//   { kind: 'intent',   intent: { type, id, sf } }   play/open one catalog item (handled by the page)
//   { kind: 'navigate', url }                         any other music.apple.com page (browse, radio, search…)
//                                                     (+ storefrontDefaulted when the link named no country: see withStorefront)
//   { kind: 'unsupported', reason, scheme }           a scheme Apple Music registers but a web client can't act on
//   null                                              not a link we handle

export const OWN_SCHEME = 'adam';

// Every URL scheme the Apple Music app registers on Windows, grouped for Settings → Links. Adam
// only claims the ones the user turns on, because claiming a scheme takes the link away from any
// other app that handles it (Apple's own Music app, for one).
//   kind 'link'        a link to Apple Music content, opened like an https link
//   kind 'radio'       an iTunes Radio link, opened on the Radio page
//   kind 'unsupported' Apple Music registers it but a web client cannot act on it (a notice is shown)
export const SCHEME_GROUPS = [
    { id: 'music',   title: 'Apple Music links' },
    { id: 'store',   title: 'iTunes Store and library links' },
    { id: 'radio',   title: 'Radio' },
    { id: 'other',   title: 'Registered by Apple Music but not playable in Adam' },
    { id: 'windows', title: 'Windows legacy aliases' },
];

const APPLE_BASE = { daap: { kind: 'unsupported', reason: 'daap' }, itpc: { kind: 'unsupported', reason: 'podcast' }, itsradio: { kind: 'radio' } };
const LEGACY_ALIASES = ['daap', 'itals', 'italss', 'itls', 'itlss', 'itms', 'itmss', 'itpc', 'itsradio', 'itvls', 'itvlss'];

export const APPLE_SCHEMES = [
    { scheme: 'music',       group: 'music', kind: 'link',  note: 'Includes the "Open in Music" button on music.apple.com' },
    { scheme: 'musics',      group: 'music', kind: 'link',  note: 'Secure variant of music://' },
    { scheme: 'itms',        group: 'music', kind: 'link',  note: 'Older Apple Music and iTunes Store links' },
    { scheme: 'itmss',       group: 'music', kind: 'link',  note: 'Secure variant of itms://' },
    { scheme: 'itunes',      group: 'music', kind: 'link',  note: 'iTunes links' },
    { scheme: 'itals',       group: 'store', kind: 'link',  note: 'iTunes library link' },
    { scheme: 'italss',      group: 'store', kind: 'link',  note: 'Secure variant of itals://' },
    { scheme: 'itvls',       group: 'store', kind: 'link',  note: 'iTunes video link' },
    { scheme: 'itvlss',      group: 'store', kind: 'link',  note: 'Secure variant of itvls://' },
    { scheme: 'itsradio',    group: 'radio', kind: 'radio', note: 'iTunes Radio station links' },
    { scheme: 'itunesradio', group: 'radio', kind: 'radio', note: 'iTunes Radio station links' },
    { scheme: 'daap',        group: 'other', kind: 'unsupported', reason: 'daap', note: 'Shared iTunes libraries on your network (Adam shows a notice)' },
    { scheme: 'itpc',        group: 'other', kind: 'unsupported', reason: 'podcast', note: 'Podcast subscriptions (Adam shows a notice)' },
    ...LEGACY_ALIASES.map(a => ({
        scheme: `itunes.assocprotocol.${a}`, group: 'windows', windowsOnly: true,
        kind: APPLE_BASE[a]?.kind ?? 'link', reason: APPLE_BASE[a]?.reason,
        note: `Windows alias of ${a}://`,
    })),
];

// Resolve a scheme (or its Windows alias) to its base definition.
const BY_SCHEME = new Map(APPLE_SCHEMES.map(s => [s.scheme, s]));
const ALIAS_PREFIX = 'itunes.assocprotocol.';
export const baseScheme = (scheme) => (scheme.startsWith(ALIAS_PREFIX) ? scheme.slice(ALIAS_PREFIX.length) : scheme);
// itls and itlss exist only as Windows aliases, so they have no entry of their own.
const ALIAS_ONLY = { itls: { kind: 'link' }, itlss: { kind: 'link' } };
const schemeKind = (scheme) => BY_SCHEME.get(baseScheme(scheme)) ?? (scheme.startsWith(ALIAS_PREFIX) ? ALIAS_ONLY[baseScheme(scheme)] : undefined);

// Every host Apple serves Apple Music pages from; all of them are opened as music.apple.com.
const APPLE_HOSTS = new Set([
    'music.apple.com', 'beta.music.apple.com', 'classical.music.apple.com', 'embed.music.apple.com',
    'geo.music.apple.com', 'itunes.apple.com', 'geo.itunes.apple.com', 'beta.itunes.apple.com',
]);

const TYPES = new Set(['song', 'album', 'artist', 'playlist', 'music-video']);
// Short type codes in adam://play/<code>/<id> and adam://open/<code>/<id>.
const SHORT = { s: 'song', a: 'album', p: 'playlist', r: 'station', v: 'music-video', ar: 'artist' };

const STOREFRONT = /^[a-z]{2}$/i;
const ID_NUMERIC = /^\d{1,20}$/;
const ID_PLAYLIST = /^pl\.[\w.-]{1,80}$/;
const ID_STATION = /^ra\.[\w.-]{1,80}$/;

function validId(type, id) {
    if (type === 'playlist') return ID_PLAYLIST.test(id);
    if (type === 'station') return ID_STATION.test(id) || ID_NUMERIC.test(id);
    return ID_NUMERIC.test(id);
}

const intent = (type, id, sf) => ({ kind: 'intent', intent: { type, id, sf: sf || null } });

function navigate(pathAndQuery) {
    const url = new URL('https://music.apple.com' + pathAndQuery);
    url.hash = '';
    return { kind: 'navigate', url: url.href };
}

// A URL whose host is one of APPLE_HOSTS (whatever its scheme).
function fromAppleUrl(u) {
    // Old iTunes store routes (WebObjects/MZStore.woa/...) have no music.apple.com equivalent.
    if (/webobjects/i.test(u.pathname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return navigate('/');
    let i = 0, sf = null;
    if (STOREFRONT.test(parts[0])) { sf = parts[0].toLowerCase(); i = 1; }
    const type = parts[i];
    const rest = parts.slice(i + 1);
    if (TYPES.has(type) && rest.length >= 1) {
        const id = rest[rest.length - 1].replace(/^id(?=\d)/, '');
        const track = u.searchParams.get('i');
        // An album link with ?i=<id> points at one song on that album.
        if (type === 'album' && track && ID_NUMERIC.test(track)) return intent('song', track, sf);
        if (validId(type, id)) return intent(type, id, sf);
    }
    return navigate(u.pathname + u.search);
}

function fromOwnUrl(u) {
    const host = u.hostname.toLowerCase();
    if (APPLE_HOSTS.has(host)) return fromAppleUrl(u); // adam://music.apple.com/us/album/…
    const parts = u.pathname.split('/').filter(Boolean);
    const sfParam = u.searchParams.get('sf');
    const sf = sfParam && STOREFRONT.test(sfParam) ? sfParam.toLowerCase() : null;
    if (host === 'play' || host === 'open') {
        const type = SHORT[(parts[0] || '').toLowerCase()];
        const id = parts[1] || '';
        if (!type || !validId(type, id)) return null;
        if (host === 'play' && type !== 'station') return intent(type, id, sf);
        const link = navigate(`/${sf || 'us'}/${type}/${id}`);
        // No country in the link: "us" is only a placeholder, and the window swaps in the storefront it is on.
        return sf ? link : { ...link, storefrontDefaulted: true };
    }
    // adam://<type>/<id> — hostname is the type
    if (TYPES.has(host)) {
        const id = parts[0] || '';
        return validId(host, id) ? intent(host, id, null) : null;
    }
    return null;
}

export function parseLink(raw) {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text || text.length > 2048) return null;
    let u;
    try { u = new URL(text); } catch { return null; }
    const proto = u.protocol.slice(0, -1).toLowerCase();
    const host = u.hostname.toLowerCase();
    if (proto === OWN_SCHEME) return fromOwnUrl(u);
    if (proto === 'https' || proto === 'http') return APPLE_HOSTS.has(host) ? fromAppleUrl(u) : null;
    const def = schemeKind(proto);
    if (!def) return null;
    // Apple Music registers these schemes but a web client cannot act on them: report it.
    if (def.kind === 'unsupported') return { kind: 'unsupported', reason: def.reason, scheme: proto };
    if (APPLE_HOSTS.has(host)) return fromAppleUrl(u);
    if (def.kind === 'radio') return navigate('/radio');
    return null;
}

// True for a command-line argument that is a link we handle.
export const isLinkArg = (a) => parseLink(a) !== null;

// Only adam://play/<code>/<id> and adam://<type>/<id> start playback. Every other link (Apple's "Open in Music" button,
// an Apple Music URL, adam://music.apple.com/…) opens the item's page, as Apple's own app does.
export function playsOnOpen(raw) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { return false; }
    const host = u.hostname.toLowerCase();
    return u.protocol === `${OWN_SCHEME}:` && (host === 'play' || TYPES.has(host));
}

// The storefront of a music.apple.com page URL (the first path segment, like "in" or "tw"), or null.
export function storefrontOf(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol !== 'https:' || !APPLE_HOSTS.has(u.hostname.toLowerCase())) return null;
        const first = u.pathname.split('/').filter(Boolean)[0] || '';
        return STOREFRONT.test(first) ? first.toLowerCase() : null;
    } catch { return null; }
}

// The music.apple.com page of a catalog item. A link without a storefront keeps the one the window is on
// (`current`), so Apple does not offer to switch country; "us" is only the last resort.
export const intentPageUrl = ({ type, id, sf }, current = null) => `https://music.apple.com/${sf || current || 'us'}/${type}/${id}`;

// The URL with its storefront (the first path segment) replaced by `sf`; unchanged when there is none to swap or no sf.
export function withStorefront(url, sf) {
    if (!sf || !STOREFRONT.test(sf)) return url;
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/');
        if (!STOREFRONT.test(parts[1] || '')) return url;
        parts[1] = sf.toLowerCase();
        u.pathname = parts.join('/');
        return u.href;
    } catch { return url; }
}
