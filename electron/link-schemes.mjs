// Which URL schemes Adam claims as the system handler. adam:// is always registered; the Apple
// Music schemes (music://, itms://, …) are opt-in and chosen in Settings → Links, because
// claiming them takes the link away from any other app that handles it (Apple's own Music app
// on Windows, for one).
import path from 'path';
import os from 'os';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, realpathSync } from 'fs';
import { APPLE_SCHEMES, SCHEME_GROUPS } from './deeplink.mjs';

const GROUP_TITLE = Object.fromEntries(SCHEME_GROUPS.map(g => [g.id, g.title]));

export const OPTIONAL_SCHEMES = APPLE_SCHEMES.map(s => s.scheme);

// Keep only known optional schemes, once each.
export function normalizeSelection(list) {
    const known = new Set(OPTIONAL_SCHEMES);
    return [...new Set((Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && known.has(s)))];
}

// The desktop file Linux associates with our schemes.
export function linuxDesktopId(env = process.env) {
    return env.FLATPAK_ID ? `${env.FLATPAK_ID}.desktop` : 'adam.desktop';
}

// Drop `x-scheme-handler/<scheme>=…` associations that point at `desktopId` from the text of a
// mimeapps.list, leaving every other application's entry untouched.
export function removeSchemeAssociations(text, desktopId, schemes) {
    const wanted = new Set(schemes.map(s => `x-scheme-handler/${s}`));
    const out = [];
    for (const line of text.split('\n')) {
        const m = /^([^=#[][^=]*)=(.*)$/.exec(line);
        if (!m || !wanted.has(m[1].trim())) { out.push(line); continue; }
        const kept = m[2].split(';').map(s => s.trim()).filter(s => s && s !== desktopId);
        if (kept.length) out.push(`${m[1]}=${kept.join(';')};`);
        // no entries left: drop the line
    }
    return out.join('\n');
}

// Replace a mimeapps.list through a temp file. A list kept in a dotfiles repo is a symlink, and renaming over the
// link would turn it into a plain file and leave the repo's copy stale, so the write goes to the link's target.
function writeReplacing(f, text) {
    let target = f;
    try { target = realpathSync(f); } catch { /* does not exist yet */ }
    writeFileSync(target + '.adam-tmp', text);
    renameSync(target + '.adam-tmp', target);
}

const DEFAULTS_SECTION = '[Default Applications]';

// Make `desktopId` the first handler for each scheme in the [Default Applications] section,
// keeping any other handlers after it. Creates the section when it is missing.
export function addSchemeAssociations(text, desktopId, schemes) {
    let lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    let start = lines.findIndex(l => l.trim() === DEFAULTS_SECTION);
    if (start < 0) {
        if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
        lines.push(DEFAULTS_SECTION);
        start = lines.length - 1;
    }
    let end = lines.findIndex((l, i) => i > start && /^\s*\[.*\]\s*$/.test(l));
    if (end < 0) end = lines.length;
    for (const scheme of schemes) {
        const key = `x-scheme-handler/${scheme}`;
        let idx = -1;
        for (let i = start + 1; i < end; i++) if (lines[i].split('=')[0].trim() === key) { idx = i; break; }
        if (idx >= 0) {
            const others = lines[idx].slice(lines[idx].indexOf('=') + 1).split(';').map(x => x.trim()).filter(x => x && x !== desktopId);
            lines[idx] = `${key}=${[desktopId, ...others].join(';')};`;
        } else {
            lines.splice(end, 0, `${key}=${desktopId};`);
            end++;
        }
    }
    return lines.join('\n') + '\n';
}

// The handler a mimeapps.list names first for a scheme ('' when none).
export function defaultHandler(text, scheme) {
    const key = `x-scheme-handler/${scheme}`;
    let inDefaults = false;
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (/^\[.*\]$/.test(t)) { inDefaults = t === DEFAULTS_SECTION; continue; }
        if (inDefaults && t.split('=')[0].trim() === key) return t.slice(t.indexOf('=') + 1).split(';')[0].trim();
    }
    return '';
}

function mimeappsFiles(env, home) {
    const cfg = env.XDG_CONFIG_HOME || path.join(home, '.config');
    return [path.join(cfg, 'mimeapps.list'), path.join(home, '.local', 'share', 'applications', 'mimeapps.list')];
}

export function createLinkSchemeManager({ app, loadPrefs, savePrefs, plat = process.platform, env = process.env, home = os.homedir() }) {
    // Dev runs launch `electron <app path>`; the registered command has to repeat that.
    const regArgs = () => (process.defaultApp && process.argv[1] ? [process.execPath, [path.resolve(process.argv[1])]] : []);

    const primaryMimeapps = () => mimeappsFiles(env, home)[0];

    function register(scheme) {
        if (plat === 'linux') {
            // Electron's Linux registration depends on xdg-settings and fails quietly without it, so
            // write the association ourselves.
            try {
                const f = primaryMimeapps();
                const before = existsSync(f) ? readFileSync(f, 'utf8') : '';
                const after = addSchemeAssociations(before, linuxDesktopId(env), [scheme]);
                if (after !== before) {
                    mkdirSync(path.dirname(f), { recursive: true });
                    writeReplacing(f, after);
                }
                return true;
            } catch { return false; }
        }
        try { return !!app.setAsDefaultProtocolClient(scheme, ...regArgs()); } catch { return false; }
    }

    function isActive(scheme) {
        if (plat === 'linux') {
            try {
                const f = primaryMimeapps();
                return existsSync(f) && defaultHandler(readFileSync(f, 'utf8'), scheme) === linuxDesktopId(env);
            } catch { return false; }
        }
        try { return !!app.isDefaultProtocolClient(scheme, ...regArgs()); } catch { return false; }
    }

    function unregister(scheme) {
        if (plat !== 'linux') {
            try { return !!app.removeAsDefaultProtocolClient(scheme, ...regArgs()); } catch { return false; }
        }
        // Electron cannot unregister on Linux: edit the association files ourselves.
        const id = linuxDesktopId(env);
        for (const f of mimeappsFiles(env, home)) {
            if (!existsSync(f)) continue;
            try {
                const before = readFileSync(f, 'utf8');
                const after = removeSchemeAssociations(before, id, [scheme]);
                if (after !== before) {
                    writeReplacing(f, after);
                }
            } catch { /* leave the file alone */ }
        }
        return true;
    }

    const selection = () => normalizeSelection(loadPrefs().linkSchemes);

    // Make the system match the saved choices. Only schemes we registered ourselves are ever
    // unregistered, so another app's claim is never removed.
    function apply() {
        const prefs = loadPrefs();
        const want = new Set(normalizeSelection(prefs.linkSchemes));
        const applied = new Set(normalizeSelection(prefs.linkSchemesApplied));
        for (const s of want) if (register(s)) applied.add(s);
        for (const s of [...applied]) {
            if (want.has(s)) continue;
            if (unregister(s)) applied.delete(s);
        }
        const fresh = loadPrefs();
        fresh.linkSchemesApplied = [...applied];
        savePrefs(fresh);
    }

    // Schemes offered on this platform (the Windows aliases are meaningless elsewhere).
    const offered = () => APPLE_SCHEMES.filter(s => !s.windowsOnly || plat === 'win32');

    function list() {
        const want = new Set(selection());
        return offered().map(({ scheme, note, group, kind }) => {
            return { scheme, note, group, groupTitle: GROUP_TITLE[group], kind, enabled: want.has(scheme), active: isActive(scheme) };
        });
    }

    function set(scheme, enabled) {
        if (!offered().some(s => s.scheme === scheme)) throw new Error('unknown scheme');
        const prefs = loadPrefs();
        const want = new Set(normalizeSelection(prefs.linkSchemes));
        if (enabled) want.add(scheme); else want.delete(scheme);
        prefs.linkSchemes = [...want];
        savePrefs(prefs);
        apply();
        return list();
    }

    return { apply, list, set, selection };
}
