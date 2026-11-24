// Windows shell integration: SMTC (system media transport controls), taskbar thumbnail
// buttons and progress and jump-list tasks. (Launch at login is startup.mjs.) main.mjs creates one instance on
// win32 and feeds it the same now-playing updates the MPRIS bridge receives on Linux.
import path from 'path';
import zlib from 'zlib';

export const APP_USER_MODEL_ID = 'io.github.silentone12725.Adam';

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

// White-on-transparent transport glyph as a PNG, for the taskbar thumbnail buttons.
export function makeIconPng(shape, size = 32) {
    const px = Buffer.alloc(size * size * 4);
    const inTri = (x, y, ax, ay, bx, by, cx, cy) => {
        const d = (px1, py1, px2, py2, px3, py3) => (px1 - px3) * (py2 - py3) - (px2 - px3) * (py1 - py3);
        const d1 = d(x, y, ax, ay, bx, by), d2 = d(x, y, bx, by, cx, cy), d3 = d(x, y, cx, cy, ax, ay);
        return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };
    const s = size / 32;
    const on = (x, y) => {
        x /= s; y /= s;
        switch (shape) {
            case 'play':  return inTri(x, y, 10, 6, 10, 26, 25, 16);
            case 'pause': return (x >= 9 && x <= 14 && y >= 7 && y <= 25) || (x >= 18 && x <= 23 && y >= 7 && y <= 25);
            case 'prev':  return (x >= 7 && x <= 10 && y >= 7 && y <= 25) || inTri(x, y, 26, 7, 26, 25, 12, 16);
            case 'next':  return (x >= 22 && x <= 25 && y >= 7 && y <= 25) || inTri(x, y, 6, 7, 6, 25, 20, 16);
            default: return false;
        }
    };
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        if (on(x + 0.5, y + 0.5)) px.fill(255, (y * size + x) * 4, (y * size + x) * 4 + 4);
    }
    const raw = Buffer.alloc((size * 4 + 1) * size);
    for (let y = 0; y < size; y++) px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

const TRANSPORT_CMDS = new Set(['play', 'pause', 'playpause', 'next', 'previous']);

// `--adam-cmd=playpause` from a jump-list task or a second launch.
export function parseCmdArg(argv) {
    for (const a of argv || []) {
        const m = /^--adam-cmd=(\w+)$/.exec(a);
        if (m && TRANSPORT_CMDS.has(m[1])) return m[1];
    }
    return null;
}

// Page-side script that mirrors now-playing state into navigator.mediaSession, which Chromium
// forwards to the Windows SMTC (media overlay, lock screen, hardware media keys). A silent
// looping <audio> in a throwaway iframe keeps Chromium's media session alive while the real
// audio plays elsewhere (libvlc); the iframe has untouched HTMLMediaElement prototypes, so the
// page's playback hooks never see it.
export function mediaSessionScript(state) {
    return `(() => {
  const s = ${JSON.stringify(state)};
  const ms = navigator.mediaSession;
  if (!ms) return 'no-mediasession';
  const w = window;
  if (!w.__adamSmtc) {
    const send = (c) => w.adamBridge && w.adamBridge.mediaCmd && w.adamBridge.mediaCmd(c);
    const map = { play: 'play', pause: 'pause', stop: 'pause', nexttrack: 'next', previoustrack: 'previous' };
    for (const [a, c] of Object.entries(map)) { try { ms.setActionHandler(a, () => send(c)); } catch (e) {} }
    try { ms.setActionHandler('seekto', (d) => send({ type: 'setPosition', ms: Math.round((d.seekTime || 0) * 1000) })); } catch (e) {}
    const ifr = document.createElement('iframe');
    ifr.style.cssText = 'display:none;width:0;height:0;border:0';
    document.documentElement.appendChild(ifr);
    const a = new ifr.contentWindow.Audio();
    const n = 8000, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
    const t = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
    t(0, 'RIFF'); v.setUint32(4, 36 + n, true); t(8, 'WAVE'); t(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true); t(36, 'data'); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128);
    a.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    a.loop = true;
    w.__adamSmtc = { audio: a };
  }
  const k = w.__adamSmtc.audio;
  if (s.metadata) {
    const m = s.metadata;
    ms.metadata = new MediaMetadata({
      title: m.title || '', artist: m.artist || '', album: m.album || '',
      artwork: m.artUrl ? [{ src: m.artUrl, sizes: '512x512' }] : [],
    });
  }
  if (s.status) {
    ms.playbackState = s.status === 'Playing' ? 'playing' : s.status === 'Paused' ? 'paused' : 'none';
    if (s.status === 'Stopped') k.pause(); else k.play().catch(() => {});
  }
  if (s.durationMs > 0 && s.positionMs >= 0) {
    try { ms.setPositionState({ duration: s.durationMs / 1000, position: Math.min(s.positionMs, s.durationMs) / 1000, playbackRate: 1 }); } catch (e) {}
  }
  return 'ok';
})()`;
}

// ── Integration ──────────────────────────────────────────────────────────────

export function createWinIntegration({ app, getWin, sendCmd, nativeImage }) {
    const state = { status: 'Stopped', durationMs: 0, positionMs: 0, title: '' };
    let lastSmtcPush = 0;
    let icons = null;
    const iconSet = () => icons ||= {
        play:  nativeImage.createFromBuffer(makeIconPng('play')),
        pause: nativeImage.createFromBuffer(makeIconPng('pause')),
        prev:  nativeImage.createFromBuffer(makeIconPng('prev')),
        next:  nativeImage.createFromBuffer(makeIconPng('next')),
    };

    // Dev runs launch `electron.exe <app path>`; jump-list tasks need the same arguments.
    const appArg = process.defaultApp && process.argv[1] ? `"${path.resolve(process.argv[1])}" ` : '';

    function setThumbar() {
        const win = getWin();
        if (!win || win.isDestroyed()) return;
        const ic = iconSet();
        win.setThumbarButtons([
            { tooltip: 'Previous', icon: ic.prev, click: () => sendCmd('previous') },
            { tooltip: state.status === 'Playing' ? 'Pause' : 'Play',
              icon: state.status === 'Playing' ? ic.pause : ic.play, click: () => sendCmd('playpause') },
            { tooltip: 'Next', icon: ic.next, click: () => sendCmd('next') },
        ]);
    }

    function setJumpList() {
        const task = (cmd, title, description) => ({
            program: process.execPath, arguments: `${appArg}--adam-cmd=${cmd}`,
            iconPath: process.execPath, iconIndex: 0, title, description,
        });
        app.setUserTasks([
            task('playpause', 'Play / Pause', 'Toggle playback'),
            task('next', 'Next track', 'Skip to the next track'),
            task('previous', 'Previous track', 'Go back to the previous track'),
        ]);
    }

    function pushSmtc(extra) {
        const win = getWin();
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
        const payload = { positionMs: state.positionMs, durationMs: state.durationMs, ...extra };
        win.webContents.executeJavaScript(mediaSessionScript(payload), true).catch(() => {});
    }

    function setProgress() {
        const win = getWin();
        if (!win || win.isDestroyed()) return;
        if (state.status === 'Stopped' || !(state.durationMs > 0)) { win.setProgressBar(-1); return; }
        win.setProgressBar(Math.max(0, Math.min(1, state.positionMs / state.durationMs)),
            { mode: state.status === 'Paused' ? 'paused' : 'normal' });
    }

    return {
        init() {
            app.setAppUserModelId(APP_USER_MODEL_ID);
            setJumpList();
            setThumbar();
        },

        // Same payload as the renderer's `mpris:update` (position and length in microseconds).
        update(data) {
            const extra = {};
            let thumbDirty = false;
            if (data.status && data.status !== state.status) { state.status = data.status; thumbDirty = true; extra.status = data.status; }
            if (data.metadata) {
                const m = data.metadata;
                state.durationMs = Math.round((m['mpris:length'] || 0) / 1000);
                state.positionMs = 0;
                extra.metadata = {
                    title: m['xesam:title'] || '',
                    artist: Array.isArray(m['xesam:artist']) ? m['xesam:artist'].join(', ') : (m['xesam:artist'] || ''),
                    album: m['xesam:album'] || '',
                    artUrl: m['mpris:artUrl'] || '',
                };
            }
            if (data.position != null) state.positionMs = Math.round(data.position / 1000);
            if (thumbDirty) setThumbar();
            setProgress();
            // Metadata and status changes go out immediately; bare position ticks at most once a second.
            const now = Date.now();
            if (extra.status || extra.metadata || data.seeked || now - lastSmtcPush > 1000) {
                lastSmtcPush = now;
                pushSmtc(extra);
            }
        },

        // Re-assert per-window state after the window is (re)created or shown.
        refresh() { setThumbar(); setProgress(); },

        handleArgv(argv) {
            const cmd = parseCmdArg(argv);
            if (cmd) sendCmd(cmd);
            return !!cmd;
        },
    };
}
