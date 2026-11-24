// Link parsing and scheme registration.
//   node --test electron/test/deeplink.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLink, isLinkArg, playsOnOpen, intentPageUrl, storefrontOf, withStorefront, APPLE_SCHEMES, SCHEME_GROUPS } from '../deeplink.mjs';
import { createLinkSchemeManager, removeSchemeAssociations, addSchemeAssociations, defaultHandler, normalizeSelection, linuxDesktopId, OPTIONAL_SCHEMES } from '../link-schemes.mjs';

const intent = (type, id, sf = null) => ({ kind: 'intent', intent: { type, id, sf } });
const nav = (url) => ({ kind: 'navigate', url });

test('https links on music.apple.com resolve to play intents', () => {
    assert.deepEqual(parseLink('https://music.apple.com/us/album/abbey-road/1441164426'), intent('album', '1441164426', 'us'));
    assert.deepEqual(parseLink('https://music.apple.com/in/song/something/1441164430'), intent('song', '1441164430', 'in'));
    assert.deepEqual(parseLink('https://music.apple.com/us/artist/the-beatles/136975'), intent('artist', '136975', 'us'));
    assert.deepEqual(parseLink('https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb'), intent('playlist', 'pl.f4d106fed2bd41149aaacabb233eb5eb', 'us'));
    assert.deepEqual(parseLink('https://music.apple.com/us/music-video/hey-jude/1440123456'), intent('music-video', '1440123456', 'us'));
    assert.deepEqual(parseLink('https://music.apple.com/us/album/1441164426'), intent('album', '1441164426', 'us')); // no slug
});

test('an album link with ?i= means that song', () => {
    assert.deepEqual(parseLink('https://music.apple.com/us/album/abbey-road/1441164426?i=1441164430'), intent('song', '1441164430', 'us'));
    assert.deepEqual(parseLink('https://music.apple.com/us/album/abbey-road/1441164426?i=abc'), intent('album', '1441164426', 'us'));
});

test('every Apple Music host is accepted and tracking parameters are ignored', () => {
    for (const host of ['beta.music.apple.com', 'classical.music.apple.com', 'embed.music.apple.com', 'geo.music.apple.com', 'itunes.apple.com', 'geo.itunes.apple.com']) {
        assert.deepEqual(parseLink(`https://${host}/us/album/x/123?app=music&ls=1&at=abc`), intent('album', '123', 'us'), host);
    }
    assert.deepEqual(parseLink('http://music.apple.com/us/album/x/123'), intent('album', '123', 'us'));
});

test('legacy iTunes ids (id123) are normalised', () => {
    assert.deepEqual(parseLink('https://itunes.apple.com/us/album/abbey-road/id1441164426'), intent('album', '1441164426', 'us'));
    assert.deepEqual(parseLink('https://itunes.apple.com/WebObjects/MZStore.woa/wa/viewAlbum?id=1'), null);
});

const LINK_SCHEMES = ['music', 'musics', 'itms', 'itmss', 'itunes', 'itals', 'italss', 'itvls', 'itvlss'];

test('every Apple Music link scheme (and its Windows alias) carries the same links', () => {
    for (const s of [...LINK_SCHEMES, 'itunes.assocprotocol.itms', 'itunes.assocprotocol.itls', 'itunes.assocprotocol.itlss', 'itunes.assocprotocol.itvls']) {
        assert.deepEqual(parseLink(`${s}://music.apple.com/us/album/x/123`), intent('album', '123', 'us'), s);
        assert.deepEqual(parseLink(`${s}://itunes.apple.com/us/album/x/id123?i=456`), intent('song', '456', 'us'), s);
        assert.deepEqual(parseLink(`${s}://geo.itunes.apple.com/us/album/123`), intent('album', '123', 'us'), s);
        assert.equal(parseLink(`${s}://example.com/us/album/x/123`), null, `${s} with a foreign host`);
    }
    // itls and itlss are registered only as Windows aliases, never as plain schemes
    assert.equal(parseLink('itls://music.apple.com/us/album/x/1'), null);
});

test('radio schemes open the Radio page, or a station link when they carry one', () => {
    for (const s of ['itsradio', 'itunesradio', 'itunes.assocprotocol.itsradio']) {
        assert.deepEqual(parseLink(`${s}://`), nav('https://music.apple.com/radio'), s);
        assert.deepEqual(parseLink(`${s}://music.apple.com/us/station/pop/ra.123`), nav('https://music.apple.com/us/station/pop/ra.123'), s);
    }
});

test('schemes a web client cannot act on are reported, not ignored', () => {
    assert.deepEqual(parseLink('itpc://example.com/feed.xml'), { kind: 'unsupported', reason: 'podcast', scheme: 'itpc' });
    assert.deepEqual(parseLink('daap://192.168.1.5:3689/'), { kind: 'unsupported', reason: 'daap', scheme: 'daap' });
    assert.equal(parseLink('itunes.assocprotocol.itpc://x.com/f').reason, 'podcast');
    assert.equal(parseLink('itunes.assocprotocol.daap://x/').reason, 'daap');
});

test('the scheme table is exactly what the Apple Music app registers', () => {
    const base = APPLE_SCHEMES.filter(s => !s.windowsOnly).map(s => s.scheme).sort();
    assert.deepEqual(base, ['daap', 'itals', 'italss', 'itmss', 'itms', 'itpc', 'itsradio', 'itunes', 'itunesradio', 'itvls', 'itvlss', 'music', 'musics'].sort());
    const aliases = APPLE_SCHEMES.filter(s => s.windowsOnly).map(s => s.scheme.replace('itunes.assocprotocol.', '')).sort();
    assert.deepEqual(aliases, ['daap', 'itals', 'italss', 'itls', 'itlss', 'itms', 'itmss', 'itpc', 'itsradio', 'itvls', 'itvlss']);
    assert.equal(APPLE_SCHEMES.length, 24);
    const groups = new Set(SCHEME_GROUPS.map(g => g.id));
    for (const s of APPLE_SCHEMES) assert.ok(groups.has(s.group), `${s.scheme} has a known group`);
});

test('any other Apple Music page opens inside the app', () => {
    assert.deepEqual(parseLink('https://music.apple.com/us/browse'), nav('https://music.apple.com/us/browse'));
    assert.deepEqual(parseLink('https://music.apple.com/us/radio'), nav('https://music.apple.com/us/radio'));
    assert.deepEqual(parseLink('https://music.apple.com/us/search?term=beatles'), nav('https://music.apple.com/us/search?term=beatles'));
    assert.deepEqual(parseLink('https://music.apple.com/us/new'), nav('https://music.apple.com/us/new'));
    assert.deepEqual(parseLink('https://music.apple.com/us/curator/apple-music-pop/976439514'), nav('https://music.apple.com/us/curator/apple-music-pop/976439514'));
    assert.deepEqual(parseLink('https://music.apple.com/us/room/6748797380'), nav('https://music.apple.com/us/room/6748797380'));
    assert.deepEqual(parseLink('https://music.apple.com/library/playlist/p.abc123'), nav('https://music.apple.com/library/playlist/p.abc123'));
    assert.deepEqual(parseLink('https://music.apple.com/us/station/pop/ra.123'), nav('https://music.apple.com/us/station/pop/ra.123'));
    assert.deepEqual(parseLink('https://music.apple.com/us'), nav('https://music.apple.com/us'));
    assert.deepEqual(parseLink('https://music.apple.com/'), nav('https://music.apple.com/'));
    // other hosts are normalised to music.apple.com, and fragments are dropped
    assert.deepEqual(parseLink('https://beta.music.apple.com/us/browse#top'), nav('https://music.apple.com/us/browse'));
});

test('an invalid id never becomes a play intent', () => {
    assert.deepEqual(parseLink('https://music.apple.com/us/album/x/not-a-number'), nav('https://music.apple.com/us/album/x/not-a-number'));
    assert.deepEqual(parseLink('https://music.apple.com/us/playlist/x/p.library'), nav('https://music.apple.com/us/playlist/x/p.library'));
});

test('adam:// forms', () => {
    assert.deepEqual(parseLink('adam://song/123'), intent('song', '123'));
    assert.deepEqual(parseLink('adam://album/123'), intent('album', '123'));
    assert.deepEqual(parseLink('adam://playlist/pl.abc'), intent('playlist', 'pl.abc'));
    assert.deepEqual(parseLink('adam://play/s/123'), intent('song', '123'));
    assert.deepEqual(parseLink('adam://play/a/123?sf=in'), intent('album', '123', 'in'));
    assert.deepEqual(parseLink('adam://play/p/pl.abc'), intent('playlist', 'pl.abc'));
    assert.deepEqual(parseLink('adam://play/r/ra.123'), { ...nav('https://music.apple.com/us/station/ra.123'), storefrontDefaulted: true });
    assert.deepEqual(parseLink('adam://open/a/123?sf=gb'), nav('https://music.apple.com/gb/album/123'));
    assert.deepEqual(parseLink('adam://music.apple.com/us/album/x/123'), intent('album', '123', 'us'));
    assert.equal(parseLink('adam://song/'), null);
    assert.equal(parseLink('adam://song/abc'), null);
    assert.equal(parseLink('adam://play/x/1'), null);
    assert.equal(parseLink('adam://unknown/1'), null);
});

test('hostile and malformed input is rejected', () => {
    for (const bad of ['', '   ', null, undefined, 42, 'not a url', 'javascript:alert(1)', 'file:///etc/passwd',
        'https://evil.example/music.apple.com/us/album/x/1', 'https://music.apple.com.evil.example/us/album/x/1',
        'https://evil.example/', 'ftp://music.apple.com/us/album/x/1', 'x'.repeat(5000)]) {
        assert.equal(parseLink(bad), null, String(bad).slice(0, 40));
    }
    // navigate targets are always https://music.apple.com
    const r = parseLink('music://geo.itunes.apple.com/us/browse');
    assert.equal(new URL(r.url).origin, 'https://music.apple.com');
});

test('isLinkArg picks links out of an argument list', () => {
    const argv = ['/usr/bin/adam', '--no-sandbox', 'music://music.apple.com/us/album/x/1'];
    assert.equal(argv.find(isLinkArg), argv[2]);
    assert.equal(['--hidden', '--aml-cmd=next'].find(isLinkArg), undefined);
});

test('only adam://play and adam://<type>/<id> start playback; Apple links open the page', () => {
    for (const u of ['adam://play/a/123', 'adam://play/s/9?sf=in', 'adam://song/1', 'adam://album/1', 'adam://playlist/pl.abc'])
        assert.equal(playsOnOpen(u), true, u);
    for (const u of ['music://music.apple.com/us/album/x/1', 'itms://itunes.apple.com/us/album/x/id1?app=music', 'itmss://music.apple.com/us/album/x/1',
        'itunes.assocprotocol.itms://music.apple.com/us/album/x/1', 'adam://music.apple.com/us/album/x/1', 'adam://open/a/123',
        'https://music.apple.com/us/album/x/1', '', null, undefined, 42])
        assert.equal(playsOnOpen(u), false, String(u));
});

test('storefrontOf reads the storefront of an Apple Music page URL', () => {
    assert.equal(storefrontOf('https://music.apple.com/in/album/x/1'), 'in');
    assert.equal(storefrontOf('https://music.apple.com/TW/browse'), 'tw');
    for (const u of ['https://music.apple.com/', 'https://music.apple.com/album/1', 'https://example.com/in/album/1',
        'http://music.apple.com/in/album/1', 'file:///C:/offline.html', 'not a url', '', null, undefined])
        assert.equal(storefrontOf(u), null, String(u));
});

test('intentPageUrl is the item page on music.apple.com; a missing storefront keeps the current one, then US', () => {
    assert.equal(intentPageUrl({ type: 'album', id: '123', sf: 'tw' }, 'in'), 'https://music.apple.com/tw/album/123');
    assert.equal(intentPageUrl({ type: 'song', id: '9', sf: null }, 'in'), 'https://music.apple.com/in/song/9');
    assert.equal(intentPageUrl({ type: 'song', id: '9', sf: null }), 'https://music.apple.com/us/song/9');
    for (const u of ['itms://itunes.apple.com/in/album/x/id123?app=music', 'adam://play/p/pl.abc'])
        assert.equal(new URL(intentPageUrl(parseLink(u).intent)).origin, 'https://music.apple.com', u);
});

test('adam://open and station links without a country are marked, so the window can use its own', () => {
    assert.deepEqual(parseLink('adam://open/a/123'), { ...nav('https://music.apple.com/us/album/123'), storefrontDefaulted: true });
    assert.deepEqual(parseLink('adam://open/s/9'), { ...nav('https://music.apple.com/us/song/9'), storefrontDefaulted: true });
    assert.deepEqual(parseLink('adam://open/a/123?sf=in'), nav('https://music.apple.com/in/album/123')); // named: not marked
    assert.equal('storefrontDefaulted' in parseLink('adam://open/a/123?sf=in'), false);
    assert.equal('storefrontDefaulted' in parseLink('https://music.apple.com/us/browse'), false);
});

test('withStorefront swaps the storefront and leaves everything else alone', () => {
    assert.equal(withStorefront('https://music.apple.com/us/album/123', 'in'), 'https://music.apple.com/in/album/123');
    assert.equal(withStorefront('https://music.apple.com/us/album/x/123?i=9', 'TW'), 'https://music.apple.com/tw/album/x/123?i=9');
    assert.equal(withStorefront('https://music.apple.com/us/album/123', null), 'https://music.apple.com/us/album/123');
    assert.equal(withStorefront('https://music.apple.com/us/album/123', 'india'), 'https://music.apple.com/us/album/123');
    assert.equal(withStorefront('https://music.apple.com/browse', 'in'), 'https://music.apple.com/browse'); // no storefront to swap
    assert.equal(withStorefront('not a url', 'in'), 'not a url');
});

// ── scheme registration ──────────────────────────────────────────────────────

function fakeApp() {
    const reg = new Set();
    return {
        reg,
        setAsDefaultProtocolClient: (s) => { reg.add(s); return true; },
        removeAsDefaultProtocolClient: (s) => reg.delete(s),
        isDefaultProtocolClient: (s) => reg.has(s),
    };
}
function prefsStore(initial = {}) {
    let p = { ...initial };
    return { load: () => JSON.parse(JSON.stringify(p)), save: (v) => { p = JSON.parse(JSON.stringify(v)); }, get: () => p };
}

test('normalizeSelection keeps only known schemes, once each', () => {
    assert.deepEqual(normalizeSelection(['music', 'music', 'evil', 5, 'itms']), ['music', 'itms']);
    assert.deepEqual(normalizeSelection('music'), []);
    assert.equal(OPTIONAL_SCHEMES.length, 24);
});

test('nothing optional is claimed until the user turns it on', () => {
    const app = fakeApp(), st = prefsStore();
    const m = createLinkSchemeManager({ app, loadPrefs: st.load, savePrefs: st.save, plat: 'win32' });
    m.apply();
    assert.equal(app.reg.size, 0);
    assert.ok(m.list().every(s => !s.enabled && !s.active));
});

test('Windows aliases are only offered on Windows', () => {
    const mk = (plat) => { const st = prefsStore(); return createLinkSchemeManager({ app: fakeApp(), loadPrefs: st.load, savePrefs: st.save, plat, home: tmpdir() }); };
    assert.equal(mk('win32').list().length, 24);
    assert.equal(mk('linux').list().length, 13);
    assert.ok(mk('linux').list().every(s => !s.scheme.startsWith('itunes.assocprotocol.')));
    assert.throws(() => mk('linux').set('itunes.assocprotocol.itms', true), /unknown scheme/);
    assert.doesNotThrow(() => mk('win32').set('itunes.assocprotocol.itms', true));
});

test('enabling and disabling registers and unregisters, and remembers the choice', () => {
    const app = fakeApp(), st = prefsStore();
    const m = createLinkSchemeManager({ app, loadPrefs: st.load, savePrefs: st.save, plat: 'win32' });
    let list = m.set('music', true);
    assert.ok(app.reg.has('music'));
    assert.deepEqual(st.get().linkSchemes, ['music']);
    assert.deepEqual(st.get().linkSchemesApplied, ['music']);
    assert.equal(list.find(s => s.scheme === 'music').active, true);
    list = m.set('music', false);
    assert.ok(!app.reg.has('music'));
    assert.deepEqual(st.get().linkSchemes, []);
    assert.deepEqual(st.get().linkSchemesApplied, []);
    assert.throws(() => m.set('https', true), /unknown scheme/);
    assert.throws(() => m.set('adam', false), /unknown scheme/);
});

test('apply() restores saved choices on startup but never unregisters what we did not register', () => {
    const app = fakeApp(); app.reg.add('itunes'); // claimed by someone else, never by us
    const st = prefsStore({ linkSchemes: ['music'], linkSchemesApplied: [] });
    createLinkSchemeManager({ app, loadPrefs: st.load, savePrefs: st.save, plat: 'win32' }).apply();
    assert.ok(app.reg.has('music'));
    assert.ok(app.reg.has('itunes'), 'a foreign registration must be left alone');
});

test('removeSchemeAssociations edits only our entries', () => {
    const text = [
        '[Default Applications]',
        'x-scheme-handler/music=adam.desktop',
        'x-scheme-handler/itms=other.desktop;adam.desktop;',
        'x-scheme-handler/itmss=other.desktop',
        'x-scheme-handler/https=firefox.desktop',
        '[Added Associations]',
        'x-scheme-handler/music=adam.desktop;',
        '',
    ].join('\n');
    const out = removeSchemeAssociations(text, 'adam.desktop', ['music', 'itms', 'itmss']);
    assert.ok(!out.includes('x-scheme-handler/music='));
    assert.ok(out.includes('x-scheme-handler/itms=other.desktop;'));
    assert.ok(out.includes('x-scheme-handler/itmss=other.desktop'));
    assert.ok(out.includes('x-scheme-handler/https=firefox.desktop'));
    assert.ok(out.includes('[Default Applications]') && out.includes('[Added Associations]'));
    assert.equal(removeSchemeAssociations(text, 'adam.desktop', ['itunes']), text);
});

test('on Linux, disabling removes our mimeapps.list entries and keeps the others', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'adam-mime-'));
    mkdirSync(path.join(home, '.config'), { recursive: true });
    const f = path.join(home, '.config', 'mimeapps.list');
    writeFileSync(f, '[Default Applications]\nx-scheme-handler/music=adam.desktop\nx-scheme-handler/https=firefox.desktop\n');
    const app = fakeApp(), st = prefsStore({ linkSchemes: ['music'], linkSchemesApplied: ['music'] });
    const m = createLinkSchemeManager({ app, loadPrefs: st.load, savePrefs: st.save, plat: 'linux', env: {}, home });
    m.set('music', false);
    const after = readFileSync(f, 'utf8');
    assert.ok(!after.includes('x-scheme-handler/music'));
    assert.ok(after.includes('x-scheme-handler/https=firefox.desktop'));
    assert.ok(!existsSync(f + '.adam-tmp'));
});

test('linuxDesktopId follows Flatpak', () => {
    assert.equal(linuxDesktopId({}), 'adam.desktop');
    assert.equal(linuxDesktopId({ FLATPAK_ID: 'io.github.silentone12725.Adam' }), 'io.github.silentone12725.Adam.desktop');
});

test('addSchemeAssociations puts Adam first, keeps others, and is idempotent', () => {
    const text = '[Default Applications]\nx-scheme-handler/https=firefox.desktop\nx-scheme-handler/itms=other.desktop;\n[Added Associations]\nfoo/bar=x.desktop;\n';
    const once = addSchemeAssociations(text, 'adam.desktop', ['music', 'itms']);
    assert.ok(once.includes('x-scheme-handler/music=adam.desktop;'));
    assert.ok(once.includes('x-scheme-handler/itms=adam.desktop;other.desktop;'));
    assert.ok(once.includes('x-scheme-handler/https=firefox.desktop'));
    assert.ok(once.includes('foo/bar=x.desktop;'));
    assert.ok(once.indexOf('x-scheme-handler/music') < once.indexOf('[Added Associations]'), 'new entry stays in the defaults section');
    assert.equal(addSchemeAssociations(once, 'adam.desktop', ['music', 'itms']), once);
    assert.equal(defaultHandler(once, 'music'), 'adam.desktop');
    assert.equal(defaultHandler(once, 'itms'), 'adam.desktop');
    assert.equal(defaultHandler(once, 'https'), 'firefox.desktop');
    assert.equal(defaultHandler(once, 'itunes'), '');
    // removing again restores the other app as the default
    const back = removeSchemeAssociations(once, 'adam.desktop', ['music', 'itms']);
    assert.equal(defaultHandler(back, 'itms'), 'other.desktop');
    assert.equal(defaultHandler(back, 'music'), '');
});

test('addSchemeAssociations creates the file content and the section from nothing', () => {
    const out = addSchemeAssociations('', 'adam.desktop', ['music']);
    assert.equal(out, '[Default Applications]\nx-scheme-handler/music=adam.desktop;\n');
    assert.equal(addSchemeAssociations('[Added Associations]\na/b=c.desktop;\n', 'adam.desktop', ['music']),
        '[Added Associations]\na/b=c.desktop;\n\n[Default Applications]\nx-scheme-handler/music=adam.desktop;\n');
});

test('on Linux the full enable/disable cycle writes and then cleans mimeapps.list', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'adam-cycle-'));
    const f = path.join(home, '.config', 'mimeapps.list');
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, '[Default Applications]\nx-scheme-handler/music=other.desktop;\n');
    const st = prefsStore();
    const m = createLinkSchemeManager({ app: fakeApp(), loadPrefs: st.load, savePrefs: st.save, plat: 'linux', env: {}, home });
    let l = m.set('music', true);
    assert.equal(l.find(s => s.scheme === 'music').active, true);
    assert.equal(defaultHandler(readFileSync(f, 'utf8'), 'music'), 'adam.desktop');
    assert.ok(readFileSync(f, 'utf8').includes('other.desktop'), 'the previous handler is kept as a fallback');
    l = m.set('music', false);
    assert.equal(l.find(s => s.scheme === 'music').active, false);
    assert.equal(defaultHandler(readFileSync(f, 'utf8'), 'music'), 'other.desktop');
    // a fresh manager restores the saved state at startup
    m.set('itms', true);
    const m2 = createLinkSchemeManager({ app: fakeApp(), loadPrefs: st.load, savePrefs: st.save, plat: 'linux', env: {}, home });
    writeFileSync(f, '');
    m2.apply();
    assert.equal(defaultHandler(readFileSync(f, 'utf8'), 'itms'), 'adam.desktop');
});
