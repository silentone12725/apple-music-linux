// What kind of Linux session Adam runs in, and how a program is started at login there. Pure helpers, unit-tested in
// test/session.test.mjs; startup.mjs does the writing.
//
// Three ways to start Adam at login, chosen per session (chooseMechanism):
//   xdg      an XDG autostart entry. Full desktop environments run it themselves; so does any session that
//            activates xdg-desktop-autostart.target (uwsm, niri-session), through systemd-xdg-autostart-generator.
//   systemd  a user unit wanted by graphical-session.target. For compositors and window managers that start that
//            target but not the XDG one (a plain Hyprland or Sway session). No dotfile is edited.
//   config   a marked block in the compositor's own config (exec-once, exec, spawn-at-startup …), for sessions that
//            have neither target (i3 started by startx, bspwm, labwc …). It is removed again with the toggle.

// Desktop environments that run XDG autostart entries themselves.
const FULL_DESKTOPS = new Set([
    'gnome', 'gnome-flashback', 'ubuntu', 'kde', 'plasma', 'xfce', 'x-cinnamon', 'cinnamon', 'mate', 'lxqt', 'lxde',
    'budgie', 'budgie-desktop', 'deepin', 'dde', 'pantheon', 'cosmic', 'unity', 'ukui', 'x-ukui', 'enlightenment', 'cde',
]);
const COMPOSITORS = new Set([
    'hyprland', 'sway', 'i3', 'niri', 'river', 'labwc', 'bspwm', 'wayfire', 'openbox', 'awesome', 'qtile', 'dwm',
    'herbstluftwm', 'mango', 'dwl', 'leftwm', 'xmonad', 'icewm', 'fluxbox', 'jwm', 'fvwm', 'sxhkd',
]);
const ALIASES = { 'i3-with-shmlog': 'i3', i3wm: 'i3', swayfx: 'sway', 'sway-session': 'sway', 'hyprland-uwsm': 'hyprland' };

const tokens = (env) => [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
    .filter(Boolean).flatMap((v) => String(v).toLowerCase().split(':')).map((t) => t.trim()).filter(Boolean)
    .map((t) => ALIASES[t] || t);

export function isWayland(env = process.env) {
    return env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY;
}

// { id, kind: 'desktop' | 'compositor' | 'unknown', wayland }
export function detectSession(env = process.env) {
    const wayland = isWayland(env);
    const t = tokens(env);
    const desktop = t.find((x) => FULL_DESKTOPS.has(x));
    if (desktop) return { id: desktop, kind: 'desktop', wayland };
    const comp = t.find((x) => COMPOSITORS.has(x))
        || (env.HYPRLAND_INSTANCE_SIGNATURE ? 'hyprland' : env.SWAYSOCK ? 'sway' : env.NIRI_SOCKET ? 'niri' : env.I3SOCK ? 'i3' : '');
    if (comp) return { id: comp, kind: 'compositor', wayland };
    return { id: t[0] || '', kind: 'unknown', wayland };
}

// ── argument handling ────────────────────────────────────────────────────────

// An Exec line (Desktop Entry quoting) as an argument list.
export function execToArgs(exec) {
    const args = [];
    let cur = '', inQ = false, has = false;
    const s = String(exec);
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQ) {
            if (c === '\\' && i + 1 < s.length) { cur += s[++i]; }
            else if (c === '"') inQ = false;
            else cur += c;
        } else if (c === '"') { inQ = true; has = true; }
        else if (/\s/.test(c)) { if (cur || has) { args.push(cur); cur = ''; has = false; } }
        else { cur += c; has = true; }
    }
    if (cur || has) args.push(cur);
    return args;
}

export const shQuote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
export const shLine = (args) => args.map(shQuote).join(' ');
export const kdlString = (a) => `"${a.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// ── compositor config blocks ─────────────────────────────────────────────────

// files: paths relative to $XDG_CONFIG_HOME (or $HOME for the leading-dot ones); the first that exists is used.
export const CONFIG_PROFILES = {
    hyprland: { files: ['hypr/hyprland.conf'], comment: '#', line: (a) => `exec-once = ${shLine(a)}`,
        // A Lua config next to the conf may be the live one: do not guess.
        refuseIfPresent: ['hypr/hyprland.lua'] },
    sway:     { files: ['sway/config', '~/.sway/config'], comment: '#', line: (a) => `exec ${shLine(a)}` },
    i3:       { files: ['i3/config', '~/.i3/config'], comment: '#', line: (a) => `exec --no-startup-id ${shLine(a)}` },
    niri:     { files: ['niri/config.kdl'], comment: '//', line: (a) => `spawn-at-startup ${a.map(kdlString).join(' ')}` },
    labwc:    { files: ['labwc/autostart'], comment: '#', line: (a) => `${shLine(a)} &` },
    bspwm:    { files: ['bspwm/bspwmrc'], comment: '#', line: (a) => `${shLine(a)} &` },
    river:    { files: ['river/init'], comment: '#', line: (a) => `riverctl spawn ${shQuote(shLine(a))}` },
};

const BEGIN = 'Adam launch at login (managed by Adam: Settings → Startup; the toggle removes it)';
const END = 'Adam launch at login';

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const blockRe = (c) => new RegExp(`(?:\\n\\n|\\n|^)[ \\t]*${esc(c)} >>> ${esc(BEGIN)} >>>[^\\n]*\\n[\\s\\S]*?\\n[ \\t]*${esc(c)} <<< ${esc(END)} <<<[^\\n]*(?:\\n|$)`);

export function configBlock(profile, args) {
    const c = profile.comment;
    return `${c} >>> ${BEGIN} >>>\n${profile.line(args)}\n${c} <<< ${END} <<<\n`;
}

export function hasConfigBlock(text, profile) { return blockRe(profile.comment).test(text); }

// The block's launch line, or '' when there is none.
export function readConfigBlock(text, profile) {
    const m = blockRe(profile.comment).exec(text);
    if (!m) return '';
    const lines = m[0].split('\n').map((l) => l.trim()).filter(Boolean);
    return lines[1] || '';
}

export function removeConfigBlock(text, profile) {
    const re = blockRe(profile.comment);
    // Take the blank line put before the block with it; leave one line break where the block was.
    return re.test(text) ? text.replace(re, (m) => (m.startsWith('\n') ? '\n' : '')) : text;
}

// The block replaces an existing one, or is appended with a blank line before it.
export function putConfigBlock(text, profile, args) {
    const base = removeConfigBlock(text, profile).replace(/\s+$/, '');
    return (base ? base + '\n\n' : '') + configBlock(profile, args);
}

// ── choosing ─────────────────────────────────────────────────────────────────

// systemd: { available, xdgTarget: bool, graphicalTarget: bool }; configFile: the profile's config that exists and
// may be edited, or ''. Returns { mechanism, reason } where reason explains a non-obvious choice (shown in Settings).
export function chooseMechanism({ session, systemd, configFile, profile }) {
    if (session.kind === 'desktop') return { mechanism: 'xdg', reason: '' };
    if (systemd.xdgTarget) return { mechanism: 'xdg', reason: '' };
    if (systemd.available && systemd.graphicalTarget) {
        return { mechanism: 'systemd', reason: `${name(session)} does not run autostart entries, so Adam adds a systemd user unit (adam-autostart.service).` };
    }
    if (profile && configFile) {
        return { mechanism: 'config', reason: `${name(session)} has no systemd session here, so Adam adds a marked line to ${configFile}.` };
    }
    return { mechanism: 'xdg', reason: `${name(session) || 'This session'} may not run autostart entries. If Adam does not start, add its command to your session's startup.`, unreliable: true };
}

export function name(session) {
    const n = session.id;
    if (!n) return '';
    return { hyprland: 'Hyprland', sway: 'Sway', i3: 'i3', niri: 'niri', river: 'river', labwc: 'labwc', bspwm: 'bspwm' }[n] || n;
}
