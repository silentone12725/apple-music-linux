(() => {
  // src/engine/mp4parse.js
  function extractMetaFields(type, boxData, box) {
    if (type === "ftyp" && boxData.length >= 12)
      box.majorBrand = String.fromCharCode(boxData[8], boxData[9], boxData[10], boxData[11]);
    if (type === "hdlr" && boxData.length >= 20)
      box.handler = String.fromCharCode(boxData[16], boxData[17], boxData[18], boxData[19]);
    if ((type === "mp4a" || type === "enca") && boxData.length >= 28) {
      box.sampleRate = boxData[24] << 8 | boxData[25];
      box.channels = boxData[16] << 8 | boxData[17];
      box.isEncrypted = type === "enca";
    }
    if (type === "schm" && boxData.length >= 16)
      box.schemeType = String.fromCharCode(boxData[8], boxData[9], boxData[10], boxData[11]);
    if (type === "mdat")
      box.hex32 = Array.from(boxData.slice(8, Math.min(40, boxData.length))).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  }
  function extractTimingFields(type, boxData, box) {
    if (type === "mdhd" && boxData.length >= 24) {
      const ver = boxData[8];
      box.timescale = ver === 1 ? (boxData[20] << 24 | boxData[21] << 16 | boxData[22] << 8 | boxData[23]) >>> 0 : (boxData[16] << 24 | boxData[17] << 16 | boxData[18] << 8 | boxData[19]) >>> 0;
    }
    if (type === "tfhd" && boxData.length >= 16) {
      box.trackID = (boxData[8] << 24 | boxData[9] << 16 | boxData[10] << 8 | boxData[11]) >>> 0;
      box.flags = boxData[9] << 16 | boxData[10] << 8 | boxData[11];
    }
    if (type === "trun" && boxData.length >= 16)
      box.sampleCount = (boxData[8] << 24 | boxData[9] << 16 | boxData[10] << 8 | boxData[11]) >>> 0;
    if (type === "tfdt" && boxData.length >= 12) {
      const ver = boxData[8];
      box.baseMediaDecodeTime = ver === 1 ? (boxData[12] * 2 ** 24 + boxData[13] * 2 ** 16 + boxData[14] * 256 + boxData[15]) * 2 ** 32 + (boxData[16] * 2 ** 24 + boxData[17] * 2 ** 16 + boxData[18] * 256 + boxData[19]) : (boxData[12] << 24 | boxData[13] << 16 | boxData[14] << 8 | boxData[15]) >>> 0;
    }
    if (type === "senc" && boxData.length >= 12) {
      box.sampleCount = (boxData[12] << 24 | boxData[13] << 16 | boxData[14] << 8 | boxData[15]) >>> 0;
      box.ENCRYPTED = true;
    }
  }
  function mp4ParseBoxes(data, maxDepth) {
    if (maxDepth === void 0) maxDepth = 4;
    const result = [];
    let off = 0;
    while (off + 8 <= data.length) {
      const size = (data[off] << 24 | data[off + 1] << 16 | data[off + 2] << 8 | data[off + 3]) >>> 0;
      const type = String.fromCharCode(data[off + 4], data[off + 5], data[off + 6], data[off + 7]);
      if (size < 8) break;
      const boxData = data.slice(off, off + Math.min(size, data.length - off));
      const box = { type, size, offset: off };
      const containers = [
        "moov",
        "trak",
        "mdia",
        "minf",
        "stbl",
        "stsd",
        "mvex",
        "moof",
        "traf",
        "udta",
        "meta",
        "ilst",
        "edts"
      ];
      if (containers.includes(type) && maxDepth > 0) {
        const headerSize = type === "stsd" ? 16 : type === "meta" ? 12 : 8;
        box.children = mp4ParseBoxes(data.slice(off + headerSize, off + boxData.length), maxDepth - 1);
      }
      extractMetaFields(type, boxData, box);
      extractTimingFields(type, boxData, box);
      result.push(box);
      off += size;
      if (off >= data.length) break;
    }
    return result;
  }

  // src/engine/mp4base.js
  var u32 = (b, o) => (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
  function boxes(b, start, end) {
    const out = [];
    for (let o = start; o + 8 <= end; ) {
      const size = u32(b, o);
      if (size < 8 || o + size > end) break;
      out.push({ type: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), body: o + 8, end: o + size });
      o += size;
    }
    return out;
  }
  var child = (b, parent, type) => parent && boxes(b, parent.body, parent.end).find((x) => x.type === type);
  function mp4FirstDecodeSeconds(b) {
    const top = boxes(b, 0, b.length);
    const moov = top.find((x) => x.type === "moov");
    const moof = top.find((x) => x.type === "moof");
    if (!moov || !moof) return null;
    const mdhd = child(b, child(b, child(b, moov, "trak"), "mdia"), "mdhd");
    const tfdt = child(b, child(b, moof, "traf"), "tfdt");
    if (!mdhd || !tfdt) return null;
    const timescale = u32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
    const decodeTime = b[tfdt.body] === 1 ? u32(b, tfdt.body + 4) * 2 ** 32 + u32(b, tfdt.body + 8) : u32(b, tfdt.body + 4);
    return timescale > 0 ? decodeTime / timescale : null;
  }

  // src/engine/sidebar-glass.js
  var GLASS = Object.freeze({
    blur: Object.freeze({ def: 20, min: 0, max: 80 }),
    glassOpacity: Object.freeze({ def: 0.07, min: 0, max: 0.5 }),
    navAlpha: Object.freeze({ def: 0.72, min: 0, max: 1 }),
    // Album-art theming colours the sidebar with this alpha when the veil is at its default.
    artNavAlpha: 0.6
  });
  function clampTo({ def, min, max }, v) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  }
  var hundredths = (n) => Math.round(n * 100) / 100;
  var cleanBlur = (v) => Math.round(clampTo(GLASS.blur, v));
  var cleanGlassOpacity = (v) => hundredths(clampTo(GLASS.glassOpacity, v));
  var cleanNavAlpha = (v) => hundredths(clampTo(GLASS.navAlpha, v));
  function sidebarOpacityControl(mode) {
    return mode === "accent" ? { pref: "themeNavBgAlpha", ...GLASS.navAlpha, clean: cleanNavAlpha, hint: "How opaque the sidebar background is" } : { pref: "glassOpacity", ...GLASS.glassOpacity, clean: cleanGlassOpacity, hint: "How strong the light veil over the sidebar blur is" };
  }
  function navColorWithAlphaVar(color) {
    const m = /^(hsla|rgba)\((.*),\s*([\d.]+)\s*\)\s*$/i.exec(String(color).trim());
    return m ? `${m[1]}(${m[2]}, var(--adam-nav-alpha, ${m[3]}))` : color;
  }

  // src/engine/catalog.js
  var extractItemId = (item) => item?.playParams?.catalogId ?? item?.attributes?.playParams?.catalogId ?? item?.id ?? item?.playParams?.id ?? item?.attributes?.playParams?.id ?? null;
  var isVideoType = (t) => t === "music-videos" || t === "musicVideo" || t === "library-music-videos";
  var extractItemType = (item) => item?.type ?? item?.attributes?.playParams?.kind ?? item?.playParams?.kind ?? null;

  // src/engine/artpalette.js
  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }
  var hueDist = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };
  var clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  var pct = (v) => `${Math.round(v * 100)}%`;
  var hsla = (h, s, l, a = 1) => `hsla(${Math.round(h)}, ${pct(s)}, ${pct(l)}, ${a})`;
  function extractPalette(data, max = 5) {
    const buckets = /* @__PURE__ */ new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const sb = s < 0.12 ? 0 : s < 0.45 ? 1 : 2;
      const hb = sb === 0 ? 0 : Math.floor(h / 24) % 15;
      const lb = Math.min(4, Math.floor(l * 5));
      const key = hb * 100 + sb * 10 + lb;
      let bk = buckets.get(key);
      if (!bk) buckets.set(key, bk = { r: 0, g: 0, b: 0, n: 0 });
      bk.r += data[i];
      bk.g += data[i + 1];
      bk.b += data[i + 2];
      bk.n++;
      total++;
    }
    if (!total) return [];
    const colors = [...buckets.values()].map((bk) => {
      const [h, s, l] = rgbToHsl(bk.r / bk.n, bk.g / bk.n, bk.b / bk.n);
      return { h, s, l, weight: bk.n / total };
    }).sort((a, b) => b.weight - a.weight);
    const picked = [];
    for (const c of colors) {
      if (c.weight < 0.01) break;
      const distinct = picked.every((p) => (c.s > 0.12 && p.s > 0.12 ? hueDist(c.h, p.h) >= 30 : false) || Math.abs(c.l - p.l) >= 0.22 || Math.abs(c.s - p.s) >= 0.35);
      if (distinct) picked.push(c);
      if (picked.length === max) break;
    }
    return picked;
  }
  function luminance(h, s, l) {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    const lin = (v) => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
  }
  function paletteRoles(palette) {
    if (!palette?.length) return null;
    const base = palette[0];
    const vivid = (c) => c.s * (1 - Math.abs(c.l - 0.55)) * (0.35 + Math.sqrt(c.weight));
    const accent = [...palette].sort((a, b) => vivid(b) - vivid(a))[0];
    const others = palette.filter((c) => c !== base && c !== accent);
    const second = others[0] ?? { h: (base.h + 35) % 360, s: base.s, l: base.l };
    const third = others[1] ?? { h: (base.h + 325) % 360, s: base.s, l: base.l };
    const tone = (c, cap) => clamp(c.s, 0, cap);
    const mono = accent.s < 0.15;
    const accentS = mono ? 0 : clamp(accent.s, 0.55, 0.85);
    const accentL = mono ? 0.82 : 0.62;
    const onAccent = luminance(accent.h, accentS, accentL) > 0.36 ? "#000" : "#fff";
    return {
      pageBg: hsla(base.h, tone(base, 0.45), 0.08),
      glowA: hsla(second.h, tone(second, 0.6), 0.24, 0.55),
      glowB: hsla(third.h, tone(third, 0.6), 0.2, 0.45),
      navBg: hsla(base.h, tone(base, 0.35) * 0.8, 0.13, 0.6),
      raised: hsla(second.h, tone(second, 0.3), 0.22, 0.5),
      border: hsla(accent.h, mono ? 0 : 0.4, 0.55, 0.22),
      accent: hsla(accent.h, accentS, accentL),
      accentActive: hsla(accent.h, accentS, accentL, 0.26),
      onAccent
    };
  }

  // src/engine/auth.js
  function accountSignedIn(status) {
    const state = status?.state ?? {};
    if (state.authentication === "failed" || state.session === "expired") return false;
    return status?.capabilities?.cbcs === true || state.fairplay === "ready" || state.authentication === "logged_in" || state.session === "valid";
  }

  // src/engine/transport.js
  function createTransportController({ scope, send }) {
    let tail = Promise.resolve(), desired = null, revision = 0, pending = 0, epoch = 0;
    return {
      get desired() {
        return desired;
      },
      get revision() {
        return revision;
      },
      get pending() {
        return pending > 0;
      },
      reset(paused = null) {
        desired = paused;
        revision++;
        epoch++;
      },
      request(paused) {
        if (desired === paused) return tail;
        desired = paused;
        revision++;
        const owner = scope(), issuedEpoch = epoch;
        pending++;
        const result = tail.catch(() => {
        }).then(async () => {
          if (owner !== scope() || issuedEpoch !== epoch) return;
          await send(paused);
        }).finally(() => {
          pending--;
        });
        tail = result;
        return result;
      }
    };
  }

  // src/engine/transport-controls.js
  function installTransportControls({ root = document, state, command }) {
    const original = /* @__PURE__ */ new Map();
    const playIcon = '<svg viewBox="0 0 32 28" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M10 4v20l16-10z"/></svg>';
    const pauseIcon = '<svg viewBox="0 0 32 28" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M10 4h4v20h-4zm8 0h4v20h-4z"/></svg>';
    function button(host, action, icon, label) {
      let b = host.querySelector("[data-aml-transport]");
      if (!b) {
        b = root.createElement("button");
        b.dataset.amlTransport = action;
        b.dataset.testid = `aml-transport-${action}`;
        b.style.cssText = "display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer";
        b.onclick = (event) => {
          event.preventDefault();
          event.stopImmediatePropagation();
          const s = state();
          if (s.active) command(action === "play" ? s.paused ? "play" : "pause" : action);
        };
        host.appendChild(b);
      }
      if (b.innerHTML !== icon) b.innerHTML = icon;
      if (b.getAttribute("aria-label") !== label) b.setAttribute("aria-label", label);
      return b;
    }
    function restore() {
      for (const [node, display] of original) node.style.display = display;
      original.clear();
      root.querySelectorAll("[data-aml-transport]").forEach((b) => b.remove());
    }
    function sync() {
      const s = state();
      for (const node of original.keys()) if (!node.isConnected) original.delete(node);
      if (!s.active) {
        restore();
        return;
      }
      for (const host of root.querySelectorAll("amp-playback-controls-play, amp-playback-controls-item-skip")) {
        for (const native of host.querySelectorAll("button:not([data-aml-transport])")) {
          if (!original.has(native)) original.set(native, native.style.display);
          if (native.style.display !== "none") native.style.display = "none";
        }
        if (host.tagName === "AMP-PLAYBACK-CONTROLS-PLAY") {
          button(host, "play", s.paused ? playIcon : pauseIcon, s.paused ? "Play" : "Pause");
        } else {
          const previous = host.getAttribute("direction") === "previous";
          const action = previous ? "previous" : "next";
          const icon = `<svg viewBox="0 0 32 28" width="24" height="24" aria-hidden="true"><g fill="currentColor"${previous ? ' transform="translate(32 0) scale(-1 1)"' : ""}><path d="M5 5v18l11-9zm11 0v18l11-9zM27 5h2v18h-2z"/></g></svg>`;
          const b = button(host, action, icon, previous ? "Previous track" : "Next track");
          const disabled = previous ? !s.canPrevious : !s.canNext;
          if (b.disabled !== disabled) b.disabled = disabled;
          b.style.opacity = disabled ? "0.35" : "";
        }
      }
    }
    const observer = new MutationObserver((records) => {
      if (records.some((r) => [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && (n.matches?.("amp-playback-controls-play, amp-playback-controls-item-skip, button") || n.querySelector?.("amp-playback-controls-play, amp-playback-controls-item-skip"))))) sync();
    });
    observer.observe(root.documentElement, { childList: true, subtree: true });
    sync();
    return { sync, dispose() {
      observer.disconnect();
      restore();
    } };
  }

  // src/engine/handoff.js
  function playbackMode(sess) {
    if (sess?.capabilities?.video) return "mv";
    return sess?.codec === "aac" ? "aac" : "alac";
  }
  function needsVlcStop(prevMode, nextMode) {
    return prevMode === "alac" && nextMode !== "alac";
  }
  async function leaveLossless({ live, nextMode, stop, timeoutMs = 2e3 }) {
    if (!needsVlcStop(live ? "alac" : null, nextMode)) return { stopped: false, ok: true };
    let timer;
    const timeout = new Promise((res) => {
      timer = setTimeout(() => res(false), timeoutMs);
    });
    try {
      const ok = await Promise.race([Promise.resolve().then(stop).then(() => true), timeout]);
      return { stopped: true, ok };
    } catch (_) {
      return { stopped: true, ok: false };
    } finally {
      clearTimeout(timer);
    }
  }

  // src/engine/playstate.js
  var PLAY_STATE = Object.freeze({
    IDLE: "idle",
    // no active attempt
    OPENING: "opening",
    // POST /api/v1/playback in flight
    CDN_SETTLING: "cdn-settling",
    // session open; CDN gate open so MK can fire NPIDF
    STREAMING: "streaming",
    // MSE source buffer active
    COMPLETE: "complete"
    // stream fully pumped
  });
  var S = PLAY_STATE;
  var PLAY_TRANSITIONS = Object.freeze({
    [S.IDLE]: Object.freeze([S.OPENING]),
    [S.OPENING]: Object.freeze([S.CDN_SETTLING, S.STREAMING, S.IDLE]),
    [S.CDN_SETTLING]: Object.freeze([S.STREAMING, S.IDLE]),
    [S.STREAMING]: Object.freeze([S.COMPLETE, S.IDLE]),
    [S.COMPLETE]: Object.freeze([S.IDLE])
  });
  function isLegalPlayTransition(prev, next) {
    if (prev === next) return prev in PLAY_TRANSITIONS;
    return PLAY_TRANSITIONS[prev]?.includes(next) ?? false;
  }

  // src/engine/verification-code.js
  var CODE_LENGTH = 6;
  function normalizeCode(text) {
    return String(text ?? "").replace(/\D/g, "").slice(0, CODE_LENGTH);
  }
  function spreadDigits(current, index, text) {
    const digits = normalizeCode(text);
    const next = current.slice();
    for (let i = 0; i < digits.length && index + i < CODE_LENGTH; i++) next[index + i] = digits[i];
    const focus = Math.min(index + digits.length, CODE_LENGTH - 1);
    return { digits: next, focus };
  }
  function promptAction(snap, { open, view = null, submittedId = null, dismissedId = null }) {
    const st = snap?.state ?? {};
    if (st.fairplay === "ready" || snap?.capabilities?.cbcs === true || st.authentication === "logged_in") {
      return open ? "close" : "none";
    }
    const ch = snap?.challenge;
    if (ch?.type === "two_factor") {
      if (!open) return ch.id != null && ch.id === dismissedId ? "none" : "code";
      if (view !== "code") return "code";
      if (submittedId != null && ch.id !== submittedId) return "retry";
      return "none";
    }
    if (st.authentication === "failed" && open) return "failed";
    return "none";
  }

  // src/engine/account-sheet.js
  var ACCENT = "#fc3c44";
  var STYLE = `
#adam-account{width:380px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:0;border:0;border-radius:12px;
  background:rgba(43,43,45,.97);color:rgba(255,255,255,.88);overflow:hidden;
  box-shadow:0 0 0 .5px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08) inset,0 22px 70px rgba(0,0,0,.55);
  font:13px/1.38 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased}
#adam-account[open]{animation:adamSheetIn .2s ease-out}
#adam-account::backdrop{background:rgba(0,0,0,.32)}
#adam-account .body{padding:22px 22px 18px;display:flex;flex-direction:column;align-items:center;text-align:center}
#adam-account .app-icon{width:56px;height:56px;margin-bottom:12px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.35))}
#adam-account h1{margin:0;font:600 15px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Display",system-ui,sans-serif;color:#fff}
#adam-account .sub{margin:4px 0 16px;max-width:300px;font-size:12px;color:rgba(235,235,245,.6)}
#adam-account .group{align-self:stretch;border-radius:7px;background:rgba(0,0,0,.22);
  box-shadow:0 0 0 .5px rgba(255,255,255,.14) inset;text-align:left;overflow:hidden}
#adam-account .group input{display:block;width:100%;box-sizing:border-box;height:30px;padding:0 10px;border:0;margin:0;
  background:transparent;color:#fff;font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;outline:none}
#adam-account .group .pw{position:relative;border-top:.5px solid rgba(255,255,255,.12)}
#adam-account .group .pw input{padding-right:34px}
#adam-account .group button.eye{position:absolute;top:3px;right:4px;min-width:0;width:24px;height:24px;padding:0;border-radius:5px;
  background:transparent;box-shadow:none;color:rgba(235,235,245,.45)}
#adam-account .group button.eye:hover{color:rgba(235,235,245,.8)}
#adam-account .group button.eye[aria-pressed="true"]{color:${ACCENT}}
#adam-account .group button.eye svg{width:16px;height:16px}
#adam-account .group input::placeholder{color:rgba(235,235,245,.3)}
#adam-account .group input:disabled{color:rgba(255,255,255,.45)}
#adam-account .note{align-self:stretch;margin:8px 2px 0;font-size:11px;color:rgba(235,235,245,.38);text-align:left}
#adam-account .msg{align-self:stretch;min-height:16px;margin:8px 0 0;font-size:12px;color:rgba(235,235,245,.6)}
#adam-account .msg.err{color:#ff6961}
#adam-account .digits{display:flex;gap:7px;align-items:center;justify-content:center;margin:2px 0 0}
#adam-account .digits .sep{width:8px;height:1px;background:rgba(255,255,255,.25);margin:0 2px}
#adam-account .digits input{width:38px;height:46px;box-sizing:border-box;padding:0;border:0;border-radius:7px;text-align:center;
  background:rgba(0,0,0,.22);box-shadow:0 0 0 .5px rgba(255,255,255,.14) inset;color:#fff;caret-color:${ACCENT};
  font:500 22px/1 -apple-system,BlinkMacSystemFont,"SF Pro Rounded","SF Pro Display",system-ui,sans-serif;
  font-variant-numeric:tabular-nums;outline:none}
#adam-account .digits input:disabled{opacity:.55}
#adam-account.shake .digits{animation:adamShake .4s}
#adam-account .bar{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px 14px;
  border-top:.5px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02)}
#adam-account button{min-width:76px;height:24px;padding:0 12px;border:0;border-radius:6px;cursor:default;
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  font:13px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:#fff;
  background:rgba(255,255,255,.14);box-shadow:0 .5px 0 rgba(255,255,255,.08) inset,0 1px 1.5px rgba(0,0,0,.25)}
#adam-account button.primary{background:${ACCENT};box-shadow:0 .5px 0 rgba(255,255,255,.25) inset,0 1px 1.5px rgba(0,0,0,.3)}
#adam-account button:disabled{opacity:.45}
#adam-account button{outline:none}
#adam-account .spin{width:11px;height:11px;border-radius:50%;border:1.5px solid rgba(255,255,255,.35);border-top-color:#fff;
  animation:adamSpin .8s linear infinite}
@keyframes adamSheetIn{from{opacity:0;transform:translateY(-8px) scale(.98)}}
@keyframes adamShake{0%,100%{transform:none}20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
@keyframes adamSpin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#adam-account[open],#adam-account.shake .digits,#adam-account .spin{animation:none}}
`;
  var APP_ICON = `<svg class="app-icon" viewBox="0 0 56 56" aria-hidden="true">
<defs><linearGradient id="adamIconBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fb5c74"/><stop offset="1" stop-color="#fa233b"/></linearGradient></defs>
<rect width="56" height="56" rx="12.5" fill="url(#adamIconBg)"/>
<path fill="#fff" d="M37.6 13.2v20.6c0 2.9-2.1 5-5 5.4-2.4.3-4.3-1-4.3-3.1 0-1.9 1.4-3.3 3.6-3.8l2.4-.5c.8-.2 1.2-.7 1.2-1.5V20.4l-12 2.5v14.6c0 2.9-2.1 5-5 5.4-2.4.3-4.3-1-4.3-3.1 0-1.9 1.4-3.3 3.6-3.8l2.4-.5c.8-.2 1.2-.7 1.2-1.5V18.2c0-1 .6-1.6 1.6-1.8l13.1-2.8c.9-.2 1.5.4 1.5 1.3z"/>
</svg>`;
  var EYE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.2"/></svg>`;
  var EYE_SLASH = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2.2"/><path d="M2.5 2.5l11 11"/></svg>`;
  var REVEAL_MS = 8e3;
  function el(doc, tag, props = {}, ...children) {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v);
    }
    n.append(...children);
    return n;
  }
  function createAccountSheet({ signIn, submitCode, onDone = () => {
  }, onCancel = () => {
  }, doc = globalThis.document }) {
    let dlg = null, view = null, busy = false;
    let challengeId = null, submittedId = null, dismissedId = null;
    let inputs = [], msg = null, primary = null;
    let hidePassword = () => {
    };
    function ensureDialog() {
      if (dlg) return dlg;
      if (!doc.getElementById("adam-account-style")) {
        doc.head.appendChild(el(doc, "style", { id: "adam-account-style", textContent: STYLE }));
      }
      dlg = el(doc, "dialog", { id: "adam-account", "aria-labelledby": "adam-account-title" });
      dlg.addEventListener("cancel", (e) => {
        e.preventDefault();
        cancel();
      });
      doc.body.appendChild(dlg);
      return dlg;
    }
    function setMessage(text, isError = false) {
      if (!msg) return;
      msg.textContent = text;
      msg.className = isError ? "msg err" : "msg";
    }
    function setBusy(on, label) {
      busy = on;
      for (const i of inputs) i.disabled = on;
      if (!primary) return;
      primary.disabled = on || !ready();
      primary.replaceChildren(...on ? [el(doc, "span", { class: "spin" }), label] : [primary.dataset.label]);
    }
    function ready() {
      if (view === "signin") return inputs[0]?.value.trim() && inputs[1]?.value;
      return inputs.map((i) => i.value).join("").length === CODE_LENGTH;
    }
    function render(header, content, buttons) {
      ensureDialog();
      const body = el(doc, "div", { class: "body" });
      body.insertAdjacentHTML("beforeend", APP_ICON);
      body.append(...header, ...content);
      dlg.replaceChildren(body, el(doc, "div", { class: "bar" }, ...buttons));
      if (!dlg.open) dlg.showModal();
    }
    function button(label, { isPrimary = false, onClick }) {
      const b = el(doc, "button", { type: "button", class: isPrimary ? "primary" : "" }, label);
      b.dataset.label = label;
      b.addEventListener("click", onClick);
      return b;
    }
    function showSignIn(error = "") {
      view = "signin";
      busy = false;
      const email = el(doc, "input", { type: "email", placeholder: "Email or Phone Number", autocomplete: "username", spellcheck: false });
      const pass = el(doc, "input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
      inputs = [email, pass];
      const eye = el(doc, "button", { type: "button", class: "eye", "aria-label": "Show password", "aria-pressed": "false" });
      let revealTimer = null;
      const reveal = (on) => {
        clearTimeout(revealTimer);
        pass.type = on ? "text" : "password";
        eye.setAttribute("aria-pressed", String(on));
        eye.setAttribute("aria-label", on ? "Hide password" : "Show password");
        eye.innerHTML = on ? EYE_SLASH : EYE;
        if (on) revealTimer = setTimeout(() => reveal(false), REVEAL_MS);
      };
      reveal(false);
      eye.addEventListener("mousedown", (e) => e.preventDefault());
      eye.addEventListener("click", () => reveal(pass.type === "password"));
      hidePassword = () => reveal(false);
      msg = el(doc, "div", { class: "msg", "aria-live": "polite" });
      primary = button("Sign In", { isPrimary: true, onClick: submitSignIn });
      render(
        [
          el(doc, "h1", { id: "adam-account-title" }, "Sign in with your Apple Account"),
          el(doc, "div", { class: "sub" }, "Lossless and Hi-Res Lossless use Apple\u2019s FairPlay, which needs its own sign-in.")
        ],
        [
          el(doc, "div", { class: "group" }, email, el(doc, "div", { class: "pw" }, pass, eye)),
          el(doc, "div", { class: "note" }, "Your password is sent only to Apple and kept encrypted on this computer."),
          msg
        ],
        [button("Cancel", { onClick: cancel }), primary]
      );
      for (const i of inputs) {
        i.addEventListener("input", () => {
          primary.disabled = busy || !ready();
          setMessage("");
        });
        i.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && ready()) submitSignIn();
        });
      }
      primary.disabled = true;
      if (error) setMessage(error, true);
      email.focus();
    }
    async function submitSignIn() {
      if (busy || !ready()) return;
      hidePassword();
      setMessage("");
      setBusy(true, "Signing In\u2026");
      let res;
      try {
        res = await signIn(inputs[0].value.trim(), inputs[1].value);
      } catch (e) {
        res = { ok: false, error: e?.message };
      }
      if (view !== "signin") return;
      if (!res?.ok) {
        setBusy(false);
        setMessage(res?.error || "Could not sign in. Try again.", true);
      }
    }
    function showCode() {
      view = "code";
      busy = false;
      const fields = el(doc, "div", { class: "digits" });
      inputs = [];
      for (let i = 0; i < CODE_LENGTH; i++) {
        if (i === CODE_LENGTH / 2) fields.appendChild(el(doc, "span", { class: "sep", "aria-hidden": "true" }));
        const inp = el(doc, "input", {
          type: "text",
          inputMode: "numeric",
          maxLength: CODE_LENGTH,
          autocomplete: i === 0 ? "one-time-code" : "off",
          "aria-label": `Digit ${i + 1} of ${CODE_LENGTH}`
        });
        inp.addEventListener("input", () => fill(i, inp.value));
        inp.addEventListener("paste", (e) => {
          e.preventDefault();
          fill(i, e.clipboardData?.getData("text") ?? "");
        });
        inp.addEventListener("keydown", (e) => {
          if (e.key === "Backspace" && !inp.value && i > 0) {
            inputs[i - 1].value = "";
            inputs[i - 1].focus();
            e.preventDefault();
          } else if (e.key === "ArrowLeft" && i > 0) {
            inputs[i - 1].focus();
            e.preventDefault();
          } else if (e.key === "ArrowRight" && i < CODE_LENGTH - 1) {
            inputs[i + 1].focus();
            e.preventDefault();
          } else if (e.key === "Enter") submitCodeNow();
        });
        inputs.push(inp);
        fields.appendChild(inp);
      }
      msg = el(doc, "div", { class: "msg", "aria-live": "polite" });
      primary = button("Continue", { isPrimary: true, onClick: submitCodeNow });
      render(
        [
          el(doc, "h1", { id: "adam-account-title" }, "Enter Verification Code"),
          el(doc, "div", { class: "sub" }, "A verification code was sent to your other devices. Enter it to continue.")
        ],
        [fields, msg],
        [button("Cancel", { onClick: cancel }), primary]
      );
      primary.disabled = true;
      inputs[0].focus();
    }
    function fill(index, text) {
      const { digits, focus } = spreadDigits(inputs.map((i) => i.value), index, text);
      digits.forEach((d, i) => {
        inputs[i].value = d || "";
      });
      inputs[focus].focus();
      primary.disabled = busy || !ready();
      if (ready()) submitCodeNow();
    }
    async function submitCodeNow() {
      if (busy || !ready()) return;
      setMessage("");
      setBusy(true, "Verifying\u2026");
      submittedId = challengeId;
      let ok = false;
      try {
        ok = await submitCode(inputs.map((i) => i.value).join(""));
      } catch {
        ok = false;
      }
      if (view !== "code" || ok) return;
      submittedId = null;
      setBusy(false);
      setMessage("Could not send the code. Try again.", true);
    }
    function wrongCode() {
      submittedId = null;
      setBusy(false);
      for (const i of inputs) i.value = "";
      primary.disabled = true;
      inputs[0]?.focus();
      setMessage("Incorrect code. Enter the new code sent to your devices.", true);
      dlg.classList.remove("shake");
      void dlg.offsetWidth;
      dlg.classList.add("shake");
    }
    function close() {
      hidePassword();
      if (dlg?.open) dlg.close();
      view = null;
      busy = false;
      submittedId = null;
      inputs = [];
      msg = null;
      primary = null;
    }
    function cancel() {
      const running = view === "code" || view === "signin" && busy;
      if (view === "code") dismissedId = challengeId;
      close();
      if (running) onCancel();
    }
    function onSnapshot(snap) {
      const action = promptAction(snap, { open: view !== null, view, submittedId, dismissedId });
      if (snap?.challenge?.type === "two_factor") challengeId = snap.challenge.id ?? null;
      switch (action) {
        case "code":
          showCode();
          break;
        case "retry":
          wrongCode();
          break;
        case "close":
          close();
          onDone();
          break;
        case "failed":
          if (!busy) break;
          if (view === "signin") {
            setBusy(false);
            setMessage(snap?.message || "Could not sign in. Check your Apple Account and password.", true);
          } else showSignIn(snap?.message || "Sign-in failed. Try again.");
          break;
      }
    }
    return { openSignIn: () => showSignIn(), onSnapshot, close, isOpen: () => view !== null };
  }

  // src/engine/sign-out.js
  var SIGN_OUT_TEXT = {
    marker: "Couldn't sign out: the engine isn't responding and the sign-out couldn't be recorded. Try again.",
    credentials: "Signed out of the engine, but the saved sign-in couldn't be removed. Try again.",
    durability: "Signed out. If Adam is still signed in after a restart, sign out again."
  };
  var SIGN_OUT_TIMEOUT_MS = 6e4;
  async function signOutFlow({ engine, scope = "account", fetchFn = fetch, clearCredentials, timeoutMs = SIGN_OUT_TIMEOUT_MS }) {
    const route = scope === "device" ? "forget-device" : "logout";
    const r = await fetchFn(`${engine.replace(/\/+$/, "")}/api/v1/drm/${route}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs)
    }).catch(() => null);
    const engineOk = !!r?.ok;
    if (!clearCredentials) return engineOk ? { ok: true } : { ok: false, message: SIGN_OUT_TEXT.marker };
    const res = await clearCredentials({ reload: true, backstop: engineOk ? null : scope }).catch(() => ({ ok: false, error: "marker" }));
    if (!res?.ok) return { ok: false, message: res?.error === "credentials" ? SIGN_OUT_TEXT.credentials : SIGN_OUT_TEXT.marker };
    return { ok: true, note: res.warning === "durability" ? SIGN_OUT_TEXT.durability : "" };
  }

  // src/engine-playback.js
  var _accountSheetInstance = null;
  var _onAccountSignedIn = null;
  var _accountNote = null;
  var _pendingCredentials = null;
  function _accountSheet() {
    return _accountSheetInstance ??= createAccountSheet({
      signIn: async (email, password) => {
        const r = await fetch(`${ENGINE}/api/v1/drm/authenticate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password })
        });
        if (!r.ok) return { ok: false, error: (await r.text().catch(() => "")).trim() || `HTTP ${r.status}` };
        _pendingCredentials = { email, password };
        return { ok: true };
      },
      submitCode: async (code) => {
        const r = await fetch(`${ENGINE}/api/v1/drm/challenge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: code })
        });
        return r.ok;
      },
      onDone: () => {
        if (_pendingCredentials) window.adamBridge?.drmSaveCredentials(_pendingCredentials).catch(() => {
        });
        _pendingCredentials = null;
        _onAccountSignedIn?.();
      },
      onCancel: () => {
        _pendingCredentials = null;
        fetch(`${ENGINE}/api/v1/drm/logout`, { method: "POST" }).catch(() => {
        });
        window.adamBridge?.drmClearCredentials({ reload: false }).catch(() => {
        });
        _onAccountSignedIn?.();
      }
    });
  }
  try {
    for (const k of Object.keys(localStorage)) {
      if (!/^aml[-_]/.test(k)) continue;
      const n = "adam" + k.slice(3);
      if (localStorage.getItem(n) === null) localStorage.setItem(n, localStorage.getItem(k));
      localStorage.removeItem(k);
    }
  } catch (_) {
  }
  if (window.__adamEngineInjected) throw new Error("[Adam] double-injection guard");
  window.__adamEngineInjected = true;
  var ENGINE = window._adamEngineURL || "https://127.0.0.1:20025";
  var _ADAM_DEBUG = !!(window.adamBridge?.isDev || window.adamBridge?.debug) || localStorage.getItem("_ADAM_DEBUG") === "1";
  var LASTFM_API_KEY = "de5f164dcf024dc00e0aab05ba464d17";
  var LASTFM_API_SECRET = "c03db782a5d29db42da06edcbf76d89a";
  var _TIMINGS = {
    full: { poll: 250, debounce: 150, losslessWait: 1500, sseWait: 4e3, qualityRace: 200, mkCheck: 50 },
    reduced: { poll: 250, debounce: 150, losslessWait: 2e3, sseWait: 5e3, qualityRace: 250, mkCheck: 50 },
    minimal: { poll: 300, debounce: 150, losslessWait: 2500, sseWait: 6e3, qualityRace: 300, mkCheck: 50 }
  };
  var BUF_POLL_MS = 250;
  var _powerMode = "full";
  var _isCharging = null;
  var _sysPowerFloor = null;
  function T() {
    return _TIMINGS[_powerMode];
  }
  function _setPowerMode(mode) {
    if (_sysPowerFloor === "full" && mode !== "full") return;
    if (_sysPowerFloor === "reduced" && mode === "minimal") mode = "reduced";
    if (mode === _powerMode) return;
    if (_isCharging === true && mode !== "full") return;
    _powerMode = mode;
    console.log(`[Adam Power] mode=${mode} (floor=${_sysPowerFloor ?? "none"})`);
    if (_vlcMode && _vlcPollTimer) {
      const a = getMKAudio();
      if (a) startVLCPoll(a);
    }
  }
  var _lastBatLevel = null;
  function _recomputePowerMode() {
    if (_isCharging === true) _setPowerMode("full");
    else if (_isCharging === false && _lastBatLevel !== null)
      _setPowerMode(_lastBatLevel > 0.25 ? "reduced" : "minimal");
  }
  var _lastLoggedFloor;
  function _applySysPowerProfile(profile) {
    if (!profile) {
      _sysPowerFloor = null;
    } else if (profile === "performance" || profile === "balanced") {
      _sysPowerFloor = "full";
    } else if (profile === "cool" || profile === "quiet") {
      _sysPowerFloor = "reduced";
    } else {
      _sysPowerFloor = null;
    }
    if (_sysPowerFloor !== _lastLoggedFloor) {
      _lastLoggedFloor = _sysPowerFloor;
      console.log(`[Adam Power] sys profile=${profile} \u2192 floor=${_sysPowerFloor ?? "none"}`);
    }
    _recomputePowerMode();
  }
  navigator.getBattery?.().then((bat) => {
    const upd = () => {
      _isCharging = bat.charging;
      _lastBatLevel = bat.level;
      _recomputePowerMode();
    };
    bat.addEventListener("chargingchange", upd);
    bat.addEventListener("levelchange", upd);
    upd();
  }).catch(() => {
    _isCharging = true;
  });
  (function _pollSysPowerProfile() {
    const fetch2 = () => window.adamBridge?.getPowerProfile().then(_applySysPowerProfile).catch(() => {
    });
    fetch2();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fetch2();
    });
    window.addEventListener("focus", fetch2);
  })();
  var _domSettleCbs = /* @__PURE__ */ new Set();
  var _domSettleObs = null;
  var _domSettleQueued = false;
  function watchDomSettled(fn) {
    _domSettleCbs.add(fn);
    if (!_domSettleObs) {
      _domSettleObs = new MutationObserver(() => {
        if (_domSettleQueued) return;
        _domSettleQueued = true;
        requestAnimationFrame(() => {
          _domSettleQueued = false;
          for (const cb of [..._domSettleCbs]) {
            try {
              cb();
            } catch (err) {
              console.warn("[Adam DOM] watcher threw:", err);
            }
          }
        });
      });
      _domSettleObs.observe(document.documentElement, { childList: true, subtree: true });
    }
    try {
      fn();
    } catch (_) {
    }
    return () => _domSettleCbs.delete(fn);
  }
  (function probeJitter() {
    setTimeout(() => {
      if (_isCharging === true) return;
      let n = 0, sum = 0, prev = performance.now();
      const probe = (now) => {
        if (n > 0) sum += now - prev;
        prev = now;
        if (++n < 16) {
          requestAnimationFrame(probe);
          return;
        }
        const avg = sum / (n - 1);
        if (avg > 55 && _powerMode === "full") _setPowerMode("reduced");
      };
      requestAnimationFrame(probe);
    }, 3e3);
  })();
  if (window._adamDebug) (function installAudioCapture() {
    const CAP_LIMIT = 64 * 1024 * 1024;
    window.__adamCapture = {
      chunks: [],
      // {n, path, size, b64, boxes, bufBefore, bufAfter, grew, t}
      totalBytes: 0,
      enabled: true
    };
    window.__adamParseMp4 = mp4ParseBoxes;
    window.__adamCaptureChunk = function(path, n, value, bufBefore, bufAfter, grew) {
      if (!window.__adamCapture.enabled) return;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const HEADER = 8192;
      const slice = bytes.slice(0, HEADER);
      const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join("");
      const boxes2 = window.__adamParseMp4(bytes);
      window.__adamCapture.chunks.push({
        n,
        path,
        size: value.byteLength,
        capturedBytes: slice.length,
        hex,
        // first 8 KB as hex string
        boxes: boxes2,
        bufBefore,
        bufAfter,
        grew,
        t: Date.now()
      });
      window.__adamCapture.totalBytes += value.byteLength;
      window.__adamCapture.heldBytes = (window.__adamCapture.heldBytes || 0) + hex.length;
      const held = window.__adamCapture.chunks;
      while (window.__adamCapture.heldBytes > CAP_LIMIT && held.length > 1) {
        window.__adamCapture.heldBytes -= held.shift().hex.length;
      }
    };
    window.__adamDrainCapture = function() {
      const out = window.__adamCapture.chunks.slice();
      window.__adamCapture.chunks = [];
      window.__adamCapture.heldBytes = 0;
      return out;
    };
  })();
  (() => {
    const _suppress = (s) => typeof s === "string" && s.includes("eventQueue overflow");
    for (const method of ["log", "warn", "error", "info"]) {
      const _orig = console[method];
      console[method] = (...args) => {
        if (!_suppress(args[0])) _orig.apply(console, args);
      };
    }
  })();
  var _nativeSrcSet = null;
  var _nativeCTSet = null;
  var _nativePlay = null;
  var _ourBlobUrl = null;
  var _allowCDNTransition = false;
  var _externalPlayGateTimer = null;
  var _adamInGotoTransition = false;
  var _mkApiSaved = null;
  var _savedAacApiRestore = null;
  var _savedGateTracingCleanup = null;
  var _pendingExternalClickCatalogId = null;
  var _pendingExternalClickQueueIdx = -1;
  var _pendingPlaylistFetch = null;
  var _directPlayAdamId = null;
  var _directPlayGen = 0;
  var _directPlayPromise = null;
  var _adamNextRef = null;
  var _adamPrevRef = null;
  var _iframePlay = (() => {
    try {
      const ifr = document.createElement("iframe");
      ifr.style.display = "none";
      document.body.appendChild(ifr);
      const fn = ifr.contentWindow.HTMLMediaElement.prototype.play;
      document.body.removeChild(ifr);
      return fn;
    } catch (e) {
      return HTMLMediaElement.prototype.play;
    }
  })();
  var _nativePauseRef = HTMLMediaElement.prototype.pause;
  var _origFnCall = Function.prototype.call;
  var _origFnApply = Function.prototype.apply;
  var _vlcMode = false;
  var _vlcPosMs = 0;
  var _vlcPaused = false;
  var _vlcSyncVolume = null;
  var _VLC_VOL_KEY = "adam.vlcVolume";
  var _vlcVolPersist = (() => {
    try {
      const v = parseInt(localStorage.getItem(_VLC_VOL_KEY), 10);
      return v > 0 && v <= 200 ? v : 100;
    } catch (_) {
      return 100;
    }
  })();
  function _rememberVlcVolume(v) {
    if (!(v > 0)) return;
    _vlcVolPersist = v;
    try {
      localStorage.setItem(_VLC_VOL_KEY, String(v));
    } catch (_) {
    }
  }
  var _adamTransitioning = false;
  var _sessionContainers = [];
  var _sessionContainerIdx = -1;
  var _sessionItemIdx = -1;
  var _adamNavInternal = false;
  var _adamPendingCI = -1;
  var _adamPendingII = -1;
  var _itemTypes = /* @__PURE__ */ new Map();
  function _recordItemTypes(mkItems) {
    for (const it of mkItems ?? []) {
      const id = extractItemId(it);
      if (!id) continue;
      const t = extractItemType(it);
      if (t) _itemTypes.set(id, isVideoType(t) ? "music-videos" : "songs");
    }
  }
  var _isVideoId = (id) => _itemTypes.get(id) === "music-videos";
  function _sessionFlatIds() {
    return _sessionContainers.flatMap((c) => c.items);
  }
  function _sessionFlatIdx(ci, ii) {
    let n = 0;
    for (let i = 0; i < ci; i++) n += _sessionContainers[i].items.length;
    return n + ii;
  }
  var _vlcLyricsFreezeTimer = null;
  function _startLyricsFreeze(mkAudio) {
    if (_vlcLyricsFreezeTimer) return;
    _vlcLyricsFreezeTimer = setInterval(
      () => mkAudio.dispatchEvent(new Event("timeupdate")),
      100
    );
  }
  function _stopLyricsFreeze() {
    if (!_vlcLyricsFreezeTimer) return;
    clearInterval(_vlcLyricsFreezeTimer);
    _vlcLyricsFreezeTimer = null;
  }
  var _slGen = 0;
  var _slLines = null;
  var _slRAFId = null;
  var _slOverlay = null;
  var _slLastPaint = 0;
  var _slLinesEls = [];
  var _slWordEls = [];
  var _slCurLine = -1;
  var _slActive = false;
  function _ttmlMs(t) {
    if (!t) return 0;
    const p = t.split(":").map(Number);
    if (p.length === 3) return Math.round((p[0] * 3600 + p[1] * 60 + p[2]) * 1e3);
    if (p.length === 2) return Math.round((p[0] * 60 + p[1]) * 1e3);
    return Math.round(parseFloat(t) * 1e3);
  }
  function _parseTTML(ttml) {
    const doc = new DOMParser().parseFromString(ttml, "text/xml");
    if (doc.querySelector("parsererror")) return null;
    const tt = doc.querySelector("tt");
    if (!tt) return null;
    let timing = "Line";
    for (const a of tt.attributes) {
      if (a.localName === "timing") {
        timing = a.value;
        break;
      }
    }
    const out = [];
    for (const p of doc.querySelectorAll("body p")) {
      const begin = _ttmlMs(p.getAttribute("begin")), end = _ttmlMs(p.getAttribute("end"));
      if (!end) continue;
      let agent = "";
      for (const a of p.attributes) {
        if (a.localName === "agent") {
          agent = a.value;
          break;
        }
      }
      const words = [];
      if (timing === "Word") {
        for (const child2 of p.childNodes) {
          if (child2.nodeType === Node.TEXT_NODE) {
            if (child2.textContent.trim()) words.push({ begin: 0, end: 0, text: child2.textContent, ws: true });
          } else if (child2.nodeType === Node.ELEMENT_NODE) {
            const wb = _ttmlMs(child2.getAttribute("begin")), we = _ttmlMs(child2.getAttribute("end"));
            const text = child2.getAttribute("text") || child2.textContent;
            words.push({ begin: wb, end: we, text, ws: !wb && !we && /^\s+$/.test(text) });
          }
        }
      } else {
        const text = (p.getAttribute("text") || p.textContent).trim();
        if (text) words.push({ begin, end, text, ws: false });
      }
      if (words.some((w) => !w.ws)) out.push({ begin, end, agent, words, timing });
    }
    return out;
  }
  function _slStop() {
    if (_slRAFId) {
      cancelAnimationFrame(_slRAFId);
      _slRAFId = null;
    }
    _slLines = null;
    _slCurLine = -1;
    _slWordEls = [];
    _slLinesEls = [];
  }
  function _slHide() {
    _slActive = false;
    if (_slOverlay) {
      _slOverlay.style.opacity = "0";
      setTimeout(() => {
        if (_slOverlay && !_slActive) _slOverlay.style.display = "none";
      }, 350);
    }
  }
  function _slBuildOverlay() {
    if (_slOverlay) return;
    const el2 = document.createElement("div");
    el2.id = "adam-lyrics-overlay";
    el2.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:99998;display:none;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.86);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);transition:opacity 0.35s;opacity:0;overflow:hidden;font-family:-apple-system,SF Pro Display,system-ui,sans-serif;box-sizing:border-box;";
    const closeBtn = document.createElement("div");
    closeBtn.innerHTML = _svgCloseLg;
    closeBtn.style.cssText = "position:absolute;top:20px;right:24px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.45);cursor:pointer;user-select:none;transition:color 0.15s;z-index:1;border-radius:50%;";
    closeBtn.onmouseenter = () => {
      closeBtn.style.color = "#fff";
    };
    closeBtn.onmouseleave = () => {
      closeBtn.style.color = "rgba(255,255,255,0.45)";
    };
    closeBtn.onclick = () => _slHide();
    const inner = document.createElement("div");
    inner.id = "adam-sl-inner";
    inner.style.cssText = "width:100%;max-width:700px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:80px 32px 48px;box-sizing:border-box;overflow-y:auto;max-height:100%;scroll-behavior:smooth;scrollbar-width:none;";
    el2.append(closeBtn, inner);
    document.body.appendChild(el2);
    _slOverlay = el2;
  }
  function _slRenderLines(lines) {
    if (!_slOverlay) _slBuildOverlay();
    const c = _slOverlay.querySelector("#adam-sl-inner");
    c.innerHTML = "";
    _slLinesEls = [];
    _slWordEls = [];
    _slCurLine = -1;
    const FF = "-apple-system,SF Pro Display,system-ui,sans-serif";
    for (const ld of lines) {
      const lineEl = document.createElement("div");
      lineEl.style.cssText = `display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:2px 4px;padding:8px 12px;border-radius:12px;transition:opacity 0.4s,transform 0.4s;opacity:0.22;transform:scale(0.93);font-size:clamp(17px,3vw,30px);font-weight:600;line-height:1.4;text-align:center;font-family:${FF};cursor:default;width:100%;`;
      const wordEls = [];
      for (const w of ld.words) {
        if (w.ws) {
          const sp = document.createElement("span");
          sp.style.cssText = "display:inline-block;min-width:5px;";
          lineEl.appendChild(sp);
          wordEls.push(null);
          continue;
        }
        const span = document.createElement("span");
        span.textContent = w.text;
        span.style.cssText = "display:inline-block;border-radius:4px;padding:0 1px;transition:color 0.12s,transform 0.12s;color:rgba(255,255,255,0.28);will-change:color,transform;";
        lineEl.appendChild(span);
        wordEls.push(span);
      }
      _slLinesEls.push(lineEl);
      _slWordEls.push(wordEls);
      c.appendChild(lineEl);
    }
  }
  function _slApplyLineStyle(e, i, li) {
    if (i === li) {
      e.style.opacity = "1";
      e.style.transform = "scale(1)";
      e.scrollIntoView?.({ behavior: "smooth", block: "center" });
    } else if (i < li) {
      e.style.opacity = "0.15";
      e.style.transform = "scale(0.91)";
    } else {
      e.style.opacity = "0.22";
      e.style.transform = "scale(0.93)";
    }
  }
  function _slApplyWordStyle(sp, w, posMs, wi, lastWi) {
    const on = posMs >= w.begin && (posMs < w.end || wi === lastWi);
    const past = posMs >= w.end && wi < lastWi;
    if (on) {
      sp.style.color = "#fff";
      sp.style.transform = "scale(1.06)";
    } else if (past) {
      sp.style.color = "rgba(255,255,255,0.48)";
      sp.style.transform = "scale(1)";
    } else {
      sp.style.color = "rgba(255,255,255,0.28)";
      sp.style.transform = "scale(1)";
    }
  }
  function _slUpdateHighlight(posMs) {
    if (!_slLines || !_slLinesEls.length) return;
    const lines = _slLines;
    let li = lines.findIndex((l, i) => posMs >= l.begin && (posMs < l.end || i === lines.length - 1 && posMs >= l.begin));
    if (li < 0 && posMs < lines[0].begin) li = -1;
    if (li !== _slCurLine) {
      _slCurLine = li;
      for (let i = 0; i < _slLinesEls.length; i++) _slApplyLineStyle(_slLinesEls[i], i, li);
    }
    if (li >= 0 && _slWordEls[li]) {
      const words = lines[li].words;
      const wEls = _slWordEls[li];
      const lastWi = words.reduce((a, w, i) => !w.ws ? i : a, -1);
      for (let wi = 0; wi < words.length; wi++) {
        const w = words[wi];
        if (w.ws || !wEls[wi]) continue;
        _slApplyWordStyle(wEls[wi], w, posMs, wi, lastWi);
      }
    }
  }
  function _slRAFLoop(ts) {
    _slRAFId = requestAnimationFrame(_slRAFLoop);
    if (!_slActive || !_slLines) return;
    const minGapMs = _powerMode === "full" ? 33 : 66;
    if (ts !== void 0 && ts - _slLastPaint < minGapMs) return;
    _slLastPaint = ts ?? 0;
    _slUpdateHighlight((_mkInstance?.currentPlaybackTime || 0) * 1e3);
  }
  async function _slInitForTrack(assetId) {
    const gen = ++_slGen;
    _slStop();
    if (_slLinesEls.length && _slOverlay) {
      _slOverlay.querySelector("#adam-sl-inner").innerHTML = "";
      _slLinesEls = [];
      _slWordEls = [];
    }
    if (!assetId) return;
    try {
      const sf = encodeURIComponent(_mkInstance?.storefrontId ?? "us");
      const id = encodeURIComponent(assetId);
      let ttml = null;
      for (const type of ["syllable-lyrics", "lyrics"]) {
        const r = await fetch(`${ENGINE}/api/v1/lyrics/${id}?sf=${sf}&format=ttml&type=${type}`);
        if (_slGen !== gen) return;
        if (!r.ok) continue;
        const t = await r.text();
        if (_slGen !== gen) return;
        if (t && t.includes("<tt")) {
          ttml = t;
          break;
        }
      }
      if (!ttml || _slGen !== gen) return;
      const lines = _parseTTML(ttml);
      if (!lines?.length || _slGen !== gen) return;
      _slLines = lines;
      if (_slActive) {
        _slRenderLines(lines);
        if (!_slRAFId) _slRAFId = requestAnimationFrame(_slRAFLoop);
      }
    } catch (_) {
    }
  }
  var _syncVLCControls = () => {
  };
  var _pendingVLCIntent = null;
  var _vlcTransport = createTransportController({
    scope: () => _sessionId,
    send: async (paused) => {
      const response = await fetch(`${ENGINE}/api/v1/vlc/${paused ? "pause" : "resume"}`, {
        method: "POST",
        signal: AbortSignal.timeout(4e3)
      });
      if (!response.ok) throw new Error(`VLC transport: HTTP ${response.status}`);
    }
  });
  function _requestVLCTransport(paused) {
    _vlcPaused = paused;
    _syncVLCControls();
    const command = _vlcTransport.request(paused);
    const revision = _vlcTransport.revision;
    return command.catch((error) => {
      console.warn("[Adam VLC] transport:", error.message);
      if (_vlcTransport.revision === revision) _vlcTransport.reset();
    });
  }
  var _vlcSeekRevision = 0;
  var _vlcPollGeneration = 0;
  var _vlcPollTimer = null;
  var _vlcSeekTimer = null;
  var _vlcSeekFrozen = false;
  var _vlcSeekOffsetMs = 0;
  var _vlcRetryCount = 0;
  var _vlcPrevState = null;
  var _vlcLoading = false;
  var _seekBurstLog = 0;
  var _vlcPostSeek = false;
  var _vlcWasPlaying = false;
  var _vlcSeekTargetMs = 0;
  var _vlcErrCount = 0;
  var _vlcTickCount = 0;
  var _vlcLengthSet = false;
  var _vlcFetching = false;
  var _nextAlacSession = null;
  var _nextAlacTried = false;
  var _nextAacSession = null;
  var _nextAacTried = false;
  var _nextAlacRetries = 0;
  var _hoverSessions = /* @__PURE__ */ new Map();
  var _hoverInflight = /* @__PURE__ */ new Set();
  var _nextMvSession = null;
  var _nextMvTried = false;
  var _nextAacStreamResp = null;
  var GAPLESS_STREAM_LEAD = 8;
  var _seekable = false;
  var _seekTarget = -Infinity;
  var _seekFetchCtrl = null;
  var _pipeCtrl = null;
  var _activeSb = null;
  var _activeMs = null;
  var _activeStreamBase = "";
  var _ourSeekPending = false;
  var _ourSeekTarget = -Infinity;
  var _streamComplete = false;
  var _chunkCache = null;
  var _msePaused = false;
  var _activeMvControls = null;
  var _vlcLive = false;
  var _prevMs = null;
  var _prevSb = null;
  var _engineCaps = { lossless: false, atmos: false };
  var _streamingQuality = "lossless";
  var _downloadsQuality = "lossless";
  var _losslessWaitDone = false;
  var _snapshotEventId = -1;
  function _guardSourceBufferMethods() {
    const sbDesc = Object.getOwnPropertyDescriptor(SourceBuffer.prototype, "buffered");
    if (!sbDesc) return;
    const emptyEl = document.createElement("audio");
    Object.defineProperty(SourceBuffer.prototype, "buffered", {
      configurable: true,
      get() {
        try {
          return sbDesc.get.call(this);
        } catch (e) {
          if (e instanceof DOMException && e.name === "InvalidStateError")
            return emptyEl.buffered;
          throw e;
        }
      }
    });
    for (const method of ["remove", "abort", "appendBuffer"]) {
      const orig = SourceBuffer.prototype[method];
      if (orig) SourceBuffer.prototype[method] = function(...args) {
        try {
          return orig.apply(this, args);
        } catch (e) {
          if (e instanceof DOMException && e.name === "InvalidStateError") return;
          throw e;
        }
      };
    }
  }
  function _warnIfOurSourceCleared(el2, how) {
    if (!_activeMs || _activeMs.readyState === "closed" || !_ourBlobUrl) return;
    if (how.startsWith("src=") && how !== 'src=""') return;
    console.warn("[Adam MSE] our MediaSource is being detached by " + how + "\n" + (new Error().stack || "").split("\n").slice(2, 8).join("\n"));
  }
  function blockAppleCDN() {
    if (window.__adamCDNBlocked) return;
    window.__adamCDNBlocked = true;
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    _nativeSrcSet = desc.set;
    _nativeCTSet = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime").set;
    const isAppleCDN = (url) => url && !url.startsWith("blob:") && !url.startsWith("data:") && url !== "" && /mzstatic\.com|audio-ssl\.itunes\.apple\.com|akamaized\.net|cdn-apple\.com/i.test(url);
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      get: desc.get,
      set(val) {
        if (isAppleCDN(val) && !_allowCDNTransition) {
          console.log("[Adam Engine] Blocked CDN src:", val.slice(0, 80));
          return;
        }
        if (isAppleCDN(val) && _allowCDNTransition) {
          console.log("[Adam Engine] CDN src THROUGH (gate open):", val.slice(0, 80));
        }
        if (_allowCDNTransition && val !== void 0) {
          console.log('[AUDIO-SRC] gate-open src set \u2192 "' + String(val).slice(0, 60) + '"');
        }
        if (val?.startsWith("blob:") && (_ourBlobUrl ? val !== _ourBlobUrl : _adamInGotoTransition)) {
          if (_adamInGotoTransition && !_ourBlobUrl) console.log("[Adam Engine] Blocked MK blob during goto:", val.slice(0, 60));
          return;
        }
        _warnIfOurSourceCleared(this, "src=" + JSON.stringify(String(val).slice(0, 24)));
        desc.set.call(this, val);
      },
      configurable: true,
      enumerable: desc.enumerable
    });
    const realRemoveAttr = Element.prototype.removeAttribute;
    Element.prototype.removeAttribute = function(name) {
      if (name === "src" && this instanceof HTMLMediaElement) _warnIfOurSourceCleared(this, "removeAttribute(src)");
      return realRemoveAttr.call(this, name);
    };
    const realSetAttr = HTMLMediaElement.prototype.setAttribute;
    HTMLMediaElement.prototype.setAttribute = function(name, val) {
      if (name === "src" && isAppleCDN(val) && !_allowCDNTransition) return;
      return realSetAttr.call(this, name, val);
    };
    console.log("[Adam Engine] Apple CDN audio blocked");
    _guardSourceBufferMethods();
  }
  var _proxyInstalled = false;
  function installPlayProxy(mkAudio) {
    if (_proxyInstalled) return;
    _proxyInstalled = true;
    _nativePlay = HTMLMediaElement.prototype.play.bind(mkAudio);
    const _resolvers = [];
    mkAudio.addEventListener("playing", () => {
      const batch = _resolvers.splice(0);
      batch.forEach((r) => r());
    });
    mkAudio.play = () => {
      if (_vlcMode) {
        if (_vlcTransport.desired === true) return Promise.resolve();
        console.log(`[Adam VLC] audio.play() \u2192 resume`);
        _vlcPaused = false;
        const p2 = new Promise((resolve) => _resolvers.push(resolve));
        mkAudio.dispatchEvent(new Event("playing"));
        if (_vlcLoading) mkAudio.dispatchEvent(new Event("waiting"));
        return p2;
      }
      if (_msePaused) return new Promise(() => {
      });
      if (!_sessionId) {
        if (!_directPlayAdamId) {
          return new Promise((resolve) => _resolvers.push(resolve));
        }
        const p2 = new Promise((resolve) => _resolvers.push(resolve));
        mkAudio.dispatchEvent(new Event("playing"));
        return p2;
      }
      const p = new Promise((resolve) => _resolvers.push(resolve));
      mkAudio.dispatchEvent(new Event("playing"));
      _nativePlay().catch(() => {
      });
      return p;
    };
    console.log("[Adam Engine] Play proxy installed");
  }
  function installMKSeekInterceptor(mk) {
    if (mk.__adamSeekIntercepted) return;
    mk.__adamSeekIntercepted = true;
    const _origSeek = mk.seekToTime.bind(mk);
    mk.seekToTime = async function(seekSec) {
      const audio = getMKAudio();
      if (_vlcMode) {
        const seekRevision = ++_vlcSeekRevision;
        _vlcPosMs = Math.round(seekSec * 1e3);
        _vlcSeekFrozen = true;
        console.log(`[Adam VLC] seekToTime(${seekSec.toFixed(3)})  target=${_vlcPosMs}ms  debounce-reset`);
        if (audio) {
          audio.dispatchEvent(new Event("seeking"));
          audio.dispatchEvent(new Event("seeked"));
        }
        if (!_vlcSeekTimer) _vlcWasPlaying = !_vlcPaused;
        clearTimeout(_vlcSeekTimer);
        _vlcSeekTimer = setTimeout(async () => {
          _vlcSeekTimer = null;
          const seekTarget = _vlcPosMs;
          _vlcSeekTargetMs = seekTarget;
          console.log(`[Adam VLC seek] \u25BA SEND  posMs=${seekTarget}ms  wasPlaying=${_vlcWasPlaying}  uiPos=${_vlcPosMs}ms`);
          let actualStartMs = seekTarget;
          try {
            const t0 = performance.now();
            const seekResp = await fetch(`${ENGINE}/api/v1/vlc/seek`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ posMs: seekTarget, sessionId: _sessionId })
            });
            const rtt = (performance.now() - t0).toFixed(0);
            const seekData = await seekResp.json().catch(() => ({}));
            if (seekRevision !== _vlcSeekRevision) return;
            actualStartMs = seekData.actualStartMs ?? seekTarget;
            console.log(`[Adam VLC seek] \u25C4 RECV  target=${seekTarget}ms  engine.actualStart=${actualStartMs}ms  rtt=${rtt}ms`);
            _vlcPosMs = seekTarget;
          } catch (e) {
            console.warn(`[Adam VLC seek] \u2717 ERROR`, e);
          }
          if (seekRevision !== _vlcSeekRevision) return;
          _vlcSeekOffsetMs = 0;
          _vlcPrevState = null;
          _vlcSeekFrozen = false;
          _seekBurstLog = 20;
          if (_vlcWasPlaying) {
            _vlcPaused = false;
            _vlcPostSeek = true;
            _requestVLCTransport(false);
          }
          console.log(`[Adam VLC seek] \u21BA UNFREEZE  uiPos=${_vlcPosMs}ms  postSeek=${_vlcPostSeek}`);
          window.adamBridge?.mprisUpdate?.({ position: _vlcPosMs * 1e3, seeked: true });
        }, T().debounce);
      } else if (_activeMvControls) {
        _activeMvControls.seekTo(seekSec);
      } else {
        if (!_mvGateOpen) {
          console.log(`[Adam MV] seek blocked \u2014 A/V gate not open yet (seekSec=${seekSec.toFixed(2)})`);
          return;
        }
        _ourSeekPending = true;
        _ourSeekTarget = seekSec;
        if (audio) _nativeCTSet.call(audio, seekSec);
      }
    };
    console.log("[Adam Engine] MK seek interceptor installed");
  }
  function getMKAudio() {
    return document.getElementById("apple-music-player") || document.querySelector("audio") || null;
  }
  function _mprisPosMs() {
    if (_vlcMode) return _vlcPosMs;
    if (_activeMvControls) return Math.round(_activeMvControls.currentTime * 1e3);
    const a = getMKAudio();
    return a && Number.isFinite(a.currentTime) ? Math.round(a.currentTime * 1e3) : _vlcPosMs;
  }
  setInterval(() => {
    if (_vlcMode) return;
    if (_activeMvControls) {
      if (_activeMvControls.paused) return;
      window.adamBridge?.mprisUpdate?.({ position: Math.round(_activeMvControls.currentTime * 1e3) * 1e3 });
      return;
    }
    const a = getMKAudio();
    if (!a || a.paused || !Number.isFinite(a.currentTime) || a.currentTime <= 0) return;
    window.adamBridge?.mprisUpdate?.({ position: Math.round(a.currentTime * 1e3) * 1e3 });
  }, 1e3);
  function waitForMusicKit() {
    return new Promise((resolve) => {
      const check = () => {
        try {
          const mk = window.MusicKit?.getInstance?.();
          if (mk && "nowPlayingItem" in mk) return resolve(mk);
        } catch (_) {
        }
        setTimeout(check, T().mkCheck);
      };
      check();
    });
  }
  function getMUT() {
    const c = document.cookie.split(";").find((s) => s.trim().startsWith("media-user-token="));
    return c ? decodeURIComponent(c.trim().slice("media-user-token=".length)) : "";
  }
  var _mkInstance = null;
  function bridgeDuration(mk, durationSec) {
    _mkInstance = mk;
    try {
      Object.defineProperty(mk, "currentPlaybackDuration", {
        get: () => durationSec,
        configurable: true
      });
    } catch (_) {
    }
    const item = mk.nowPlayingItem;
    if (item && durationSec > 0) {
      const durMs = Math.round(durationSec * 1e3);
      for (const obj of [item, item.attributes].filter(Boolean)) {
        try {
          Object.defineProperty(obj, "durationInMillis", { get: () => durMs, configurable: true });
        } catch (_) {
        }
      }
    }
  }
  function unbridgeDuration() {
    if (_mkInstance) {
      try {
        delete _mkInstance.currentPlaybackDuration;
      } catch (_) {
      }
      _mkInstance = null;
    }
  }
  var _sessionId = null;
  var _currentAssetId = null;
  var _durationSec = 0;
  var _audioAnalysis = null;
  var _abortCtrl = null;
  var _generation = 0;
  var _htcSkippedItem = null;
  var _videoCodec = null;
  var _mvGateOpen = true;
  var _mvResetScrubberRef = null;
  var _nativeSeekRef = null;
  var _BUF_BAR_CSS = [
    "#playback-progress::-webkit-slider-runnable-track,",
    "input[type=range]::-webkit-slider-runnable-track{",
    "background:linear-gradient(to right,",
    "#fff var(--progress,0%),",
    "rgba(255,255,255,.26) var(--progress,0%),",
    "rgba(255,255,255,.26) var(--adam-buffer,var(--progress,0%)),",
    "rgba(255,255,255,.12) var(--adam-buffer,var(--progress,0%))",
    ")!important}"
  ].join("");
  var _playState = PLAY_STATE.IDLE;
  function setPlayState(next, ctx) {
    const prev = _playState;
    if (!isLegalPlayTransition(prev, next)) console.warn(`[Adam State] unexpected transition ${prev} \u2192 ${next}${ctx ? " | " + ctx : ""}`);
    _playState = next;
    if (prev !== next) console.log(`[Adam State] ${prev} \u2192 ${next}${ctx ? " | " + ctx : ""}`);
  }
  function genStale(myGen) {
    return myGen !== _generation;
  }
  var _mvMaxHeight = parseInt(localStorage.getItem("adam-mv-quality") || "2160", 10);
  var _mvVideoHeights = [];
  var _losslessSVG = `<svg viewBox="0 0 69 44" xmlns="http://www.w3.org/2000/svg" style="height:12px;width:auto;display:block;flex-shrink:0"><path d="M36.8269026,4 C42.3794214,4 45.7184513,10.5183153 48.20334,17.4261699 L48.4450486,18.1066712 L48.6815356,18.788389 L48.9130884,19.4700271 C49.6770268,21.7405814 50.36352,23.9882073 51.0204784,25.9968947 C52.5296562,19.7123189 51.7381954,18.3629096 53.3551269,18.3629096 C53.9565751,18.3629096 54.5652965,18.7717786 54.5652965,19.5168498 C54.5652965,19.8184059 54.0740356,23.0143253 53.391361,26.2165815 L53.2651959,26.7982368 L53.1352128,27.3761743 C52.9156151,28.3341623 52.6817778,29.2605867 52.4420448,30.075084 C59.3914285,48.2833991 64.5514879,24.299737 65.134561,19.3973484 C65.2196627,18.6903693 65.7520794,18.3629223 66.2903224,18.3629223 C67.0092304,18.3629223 67.5985395,18.9043683 67.4862017,19.7191497 C66.2419581,27.647702 64.3284002,40 56.4607867,40 C52.1189889,40 49.6781873,36.6024859 47.7506208,32.7092263 C46.4116896,30.0790205 45.2734117,26.952661 44.2263394,23.8087368 L43.9767371,23.0541028 C43.8940827,22.8026091 43.811956,22.5512479 43.7303009,22.3002645 L43.4866946,21.5486922 C41.1040436,14.1741911 39.0830717,7.34159293 35.9851696,7.34159293 C34.4711899,7.34159293 33.3487598,8.92234593 33.2709954,8.92234593 C33.128169,8.92234593 33.0160746,8.27828447 31.602332,6.51365955 C32.9478242,4.97723054 34.8023002,4 36.8269026,4 Z M11.0614865,4.01937104 C23.4500006,4.01937104 24.5519172,36.7070003 31.5633281,36.7070003 C32.3865195,36.7070003 33.2738509,36.2079668 34.2437613,35.0776923 C34.7806086,35.9871115 35.3308882,36.7945268 35.9004521,37.5054184 C34.500923,39.1028534 32.7595403,39.9988275 30.578884,39.9988275 C22.7448451,39.9977315 19.3788608,26.8790797 16.4819088,18.0220558 C15.7996486,20.8631751 15.4455023,23.434387 15.3068631,24.5887478 C15.2208267,25.3223111 14.6831215,25.6566526 14.1414468,25.6566526 C13.5407541,25.6566526 12.9351571,25.2454896 12.9351571,24.5116332 C12.9351571,24.4569356 12.9385248,24.4004537 12.9455035,24.3422131 C13.346708,21.4307464 14.1551865,17.0196557 15.0604448,13.9441978 C13.8554484,10.7869356 12.3503425,7.33621492 10.1329104,7.33621492 C5.65625092,7.33621492 3.09261157,18.5867088 2.37169324,24.5887478 C2.28565683,25.3223111 1.74795163,25.6566526 1.20627691,25.6566526 C0.605597004,25.6566526 0,25.2454896 0,24.5116332 C0,24.4569356 0.00336770017,24.4004537 0.0103463944,24.3422131 C0.114233957,23.5883333 0.225608359,22.8207923 0.346678477,22.046953 L0.452878843,21.3822914 C0.470991821,21.2713147 0.48931555,21.1602523 0.50785647,21.0491258 L0.621759807,20.3817689 C2.0405473,12.2570738 4.68538356,4.01937104 11.0614865,4.01937104 Z M23.9155499,4.00146557 C26.1404345,4.00146557 28.5270839,5.15921632 30.5844926,7.87545613 C30.6994554,8.00734485 31.8526558,9.79953527 32.2166235,10.4208612 C33.474197,12.6992201 34.5694223,15.4837436 35.5796467,18.378952 L35.8413062,19.1364745 C38.7427747,27.6177062 40.980016,36.7463669 44.4650259,36.7463669 C45.2911112,36.7463669 46.1873164,36.2334422 47.1790849,35.0773864 C47.7158553,35.9867291 48.2660581,36.794068 48.835558,37.5049086 C47.4394606,39.099438 45.6989231,39.9988275 43.5140667,39.9988275 C31.1995909,39.9969924 29.8609621,7.32900175 23.0764932,7.32900175 C21.5454317,7.32900175 20.4138588,8.92244789 20.3357358,8.92244789 C20.1928455,8.92244789 20.0806102,8.27846289 18.6670468,6.51397816 C20.048649,4.9358122 21.9168263,4.00146557 23.9155499,4.00146557 Z" fill="white" fill-rule="nonzero"/></svg>`;
  var _svgPlaySm = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="display:block;margin-left:1px"><path d="M6.483 21.466c.22 0 .432-.035.635-.107.203-.072.428-.179.674-.322L20.578 13.609c.438-.253.759-.498.963-.735.204-.237.305-.523.305-.859 0-.332-.101-.617-.305-.856-.204-.239-.525-.485-.963-.738L7.792 3c-.246-.142-.471-.25-.674-.324-.203-.073-.415-.11-.635-.11-.424 0-.777.153-1.058.458-.281.305-.422.723-.422 1.252v15.486c0 .53.141.946.422 1.249.281.304.634.455 1.058.455z" fill-rule="nonzero"/></svg>`;
  var _svgClose = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="display:block"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
  var _svgCloseLg = `<svg width="20" height="20" viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="display:block"><path d="M7.923 20.075c.132.128.284.214.459.256.174.043.347.043.519 0 .171-.042.319-.125.442-.248L14.002 15.424l4.653 4.656c.127.127.276.211.448.253.171.042.344.041.517-.001.174-.043.325-.129.453-.259.128-.128.213-.279.256-.451.043-.173.044-.345.003-.517-.041-.172-.124-.321-.249-.447L15.429 13.996l4.654-4.653c.125-.127.209-.276.251-.448.043-.171.042-.343-.002-.515-.045-.172-.131-.322-.259-.45-.132-.131-.283-.219-.455-.261-.172-.043-.344-.044-.515-.003-.172.041-.321.126-.448.254L14.002 12.574l-4.659-4.656c-.123-.125-.272-.208-.445-.249-.174-.041-.347-.041-.522 0-.174.041-.325.127-.453.259-.127.128-.21.279-.251.452-.041.174-.041.347 0 .519.041.173.122.32.243.441L12.574 13.996l-4.659 4.667c-.121.121-.204.268-.247.440-.044.171-.045.344-.003.519.042.174.128.325.258.453z" fill-rule="nonzero"/></svg>`;
  var _svgReset = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block"><path d="M10.2 5.5A4.2 4.2 0 1 1 8.1 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M7.5 0.5L8.5 2.2L6.5 2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  var _qualityBadgeInfo = { codec: null, sampleRate: null, bitDepth: null, spatialAudio: null };
  var _slotBadgeObs = null;
  var _slotBadgeRetry = null;
  function _insertBadgeIntoSlot(badge, attempt) {
    if (_slotBadgeRetry) {
      clearTimeout(_slotBadgeRetry);
      _slotBadgeRetry = null;
    }
    if (_slotBadgeObs) {
      _slotBadgeObs.disconnect();
      _slotBadgeObs = null;
    }
    const lcd = document.querySelector(
      '[data-testid="lcd-metadata"], .player-lcd, .web-chrome-playback-lcd'
    );
    const slot = lcd?.querySelector(".marquee--primary .marquee__menu-slot-container");
    const favEl = slot?.querySelector('.favorite-badge, [data-testid="favorite-button"]');
    if (slot && favEl) {
      slot.style.removeProperty("inset-inline-start");
      slot.style.removeProperty("inset-inline-end");
      slot.style.display = "flex";
      slot.style.alignItems = "center";
      slot.style.maxHeight = "none";
      slot.style.overflow = "visible";
      if (badge.parentNode !== slot) {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
        favEl.insertAdjacentElement("afterend", badge);
      }
      let _pinning = false;
      const _pinSlot = () => {
        if (_pinning || !badge.isConnected) return;
        const slotRect = slot.getBoundingClientRect();
        const lcdRect = lcd.getBoundingClientRect();
        const outOfBounds = slotRect.right > lcdRect.right + 10 || slotRect.left < lcdRect.left - 10;
        if (outOfBounds) {
          _pinning = true;
          slot.style.setProperty("inset-inline-start", "auto", "important");
          slot.style.setProperty("inset-inline-end", "0", "important");
          requestAnimationFrame(() => {
            _pinning = false;
          });
        } else {
          slot.style.removeProperty("inset-inline-start");
          slot.style.removeProperty("inset-inline-end");
        }
      };
      _slotBadgeObs = new MutationObserver(() => {
        if (!slot.isConnected || !badge.isConnected) {
          _slotBadgeObs?.disconnect();
          _slotBadgeObs = null;
          _insertBadgeIntoSlot(badge, 0);
          return;
        }
        _pinSlot();
      });
      _slotBadgeObs.observe(slot, { attributes: true, attributeFilter: ["style"] });
      const ml = slot.closest('[data-testid="marquee-line"]');
      if (ml) _slotBadgeObs.observe(ml, { attributes: true, attributeFilter: ["class", "style"] });
      _pinSlot();
      return;
    }
    const delay = attempt < 10 ? 200 : 2e3;
    _slotBadgeRetry = setTimeout(() => _insertBadgeIntoSlot(badge, attempt + 1), delay);
  }
  function _buildQualityPopup() {
    let pop = document.getElementById("adam-quality-popup");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "adam-quality-popup";
      Object.assign(pop.style, {
        position: "fixed",
        zIndex: "1000002",
        background: "rgba(30,30,32,0.92)",
        backdropFilter: "blur(60px) saturate(200%)",
        WebkitBackdropFilter: "blur(60px) saturate(200%)",
        border: "0.5px solid rgba(255,255,255,0.11)",
        borderRadius: "12px",
        padding: "9px 13px 10px",
        color: "#fff",
        fontFamily: '-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif',
        fontSize: "13px",
        lineHeight: "1.38",
        display: "none",
        pointerEvents: "none",
        boxShadow: "0 4px 24px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.4)",
        whiteSpace: "nowrap"
      });
      document.body.appendChild(pop);
    }
    return pop;
  }
  function _showQualityPopup(anchorEl) {
    const { codec, sampleRate, bitDepth, spatialAudio } = _qualityBadgeInfo;
    const pop = _buildQualityPopup();
    let title = "", detail = "";
    if (spatialAudio === "binaural-lossless") {
      title = "Spatial Audio";
      detail = "Dolby Atmos \xB7 Lossless Binaural";
    } else if (spatialAudio === "binaural") {
      title = "Spatial Audio";
      detail = "Dolby Atmos \xB7 Binaural";
    } else if (codec === "alac") {
      const hiRes = sampleRate > 48e3 || bitDepth > 16;
      const khz = sampleRate ? `${(sampleRate / 1e3).toFixed(sampleRate % 1e3 ? 1 : 0)} kHz` : "";
      const bits = bitDepth && bitDepth > 16 ? `${bitDepth}-bit ` : "";
      title = hiRes ? "Lossless" : "Lossless";
      detail = `${bits}${khz} ALAC`.trim();
    }
    pop.innerHTML = `<div style="font-size:13px;font-weight:590;letter-spacing:-0.01em;color:#fff;margin-bottom:1px">${title}</div><div style="font-size:12px;font-weight:400;color:rgba(255,255,255,0.55)">${detail}</div>`;
    pop.style.display = "block";
    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth || 130;
    const ph = pop.offsetHeight || 52;
    let left = r.left + r.width / 2 - pw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    const top = Math.max(8, r.top - ph - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }
  function showQualityBadge(codec, sampleRate, bitDepth, spatialAudio) {
    if (codec === null && _engineCaps.lossless && _streamingQuality !== "high-quality") {
      const optSR = _qualityBadgeInfo.sampleRate ?? 44100;
      const optBD = _qualityBadgeInfo.bitDepth ?? 16;
      setTimeout(() => {
        if (_qualityBadgeInfo.codec === null) {
          showQualityBadge("alac", optSR, optBD, null);
        }
      }, 80);
    }
    _qualityBadgeInfo = { codec, sampleRate, bitDepth, spatialAudio };
    let badge = document.getElementById("adam-quality-badge");
    let color, isHiRes = false, isSpatial = false, label = "";
    if (spatialAudio === "binaural-lossless" || spatialAudio === "binaural") {
      color = "#bf5af2";
      label = "SPATIAL AUDIO";
      isSpatial = true;
    } else if (codec === "alac") {
      isHiRes = sampleRate > 48e3 || bitDepth > 16;
      color = "#30d158";
      label = isHiRes ? "HI-RES" : "";
    } else {
      if (badge) badge.style.display = "none";
      document.getElementById("adam-quality-popup")?.style && (document.getElementById("adam-quality-popup").style.display = "none");
      window._syncNpBadge?.();
      window.adamBridge?.mprisUpdate?.({ qualityBadge: null });
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "adam-quality-badge";
      badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;border-radius:3px;padding:1px 4px;cursor:pointer;z-index:9999;white-space:nowrap;font-size:7.5px;font-weight:700;letter-spacing:.07em;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;transition:opacity 0.12s;';
      badge.addEventListener("mouseenter", () => {
        badge.style.opacity = "0.75";
      });
      badge.addEventListener("mouseleave", () => {
        badge.style.opacity = "1";
        setTimeout(() => {
          const pop = document.getElementById("adam-quality-popup");
          if (pop) pop.style.display = "none";
        }, 200);
      });
      badge.addEventListener("click", (e) => {
        e.stopImmediatePropagation();
        e.stopPropagation();
        const pop = document.getElementById("adam-quality-popup");
        if (pop && pop.style.display !== "none") {
          pop.style.display = "none";
        } else {
          _showQualityPopup(badge);
        }
      }, true);
      document.addEventListener("click", () => {
        const pop = document.getElementById("adam-quality-popup");
        if (pop) pop.style.display = "none";
      }, true);
      badge.style.flexShrink = "0";
      badge.style.alignSelf = "center";
      badge.style.marginLeft = "2px";
      _insertBadgeIntoSlot(badge, 0);
    }
    if (!badge.isConnected) _insertBadgeIntoSlot(badge, 0);
    badge.style.color = color;
    badge.style.border = "none";
    if (isSpatial) {
      badge.innerHTML = `<span>${label}</span>`;
    } else {
      badge.innerHTML = _losslessSVG;
    }
    badge.style.display = "inline-flex";
    window._syncNpBadge?.();
    window.adamBridge?.mprisUpdate?.({ qualityBadge: { codec, sampleRate, bitDepth, spatialAudio } });
  }
  (function() {
    let _npBadge = null;
    let _npBadgeLast = "";
    function _npContent() {
      const { codec, sampleRate, bitDepth, spatialAudio } = _qualityBadgeInfo;
      if (spatialAudio === "binaural-lossless" || spatialAudio === "binaural")
        return { show: true, label: "Spatial Audio", icon: false };
      if (codec === "alac") {
        const hi = sampleRate > 48e3 || bitDepth > 16;
        return { show: true, label: hi ? "Hi-Res Lossless" : "Lossless", icon: true };
      }
      return { show: false };
    }
    function _alignBadge() {
      if (!_npBadge?.isConnected || _npBadge.style.display === "none") return;
      const sr = _npBadge.parentNode;
      const ref = sr?.querySelector?.(".time.elapsed") || sr?.querySelector?.(".time.remaining");
      if (!ref) return;
      const badgeH = _npBadge.offsetHeight || 19;
      const top = ref.offsetTop + (ref.offsetHeight - badgeH) / 2;
      if (top > 0) _npBadge.style.top = top + "px";
    }
    function _syncBadge() {
      if (!_npBadge) return;
      const { show, label, icon } = _npContent();
      if (!show) {
        _npBadge.style.display = "none";
        _npBadgeLast = "";
        return;
      }
      const key = (icon ? "1" : "0") + label;
      const changed = key !== _npBadgeLast;
      if (changed) {
        _npBadge.innerHTML = (icon ? _losslessSVG : "") + `<span>${label}</span>`;
        _npBadgeLast = key;
      }
      _npBadge.style.display = "inline-flex";
      if (changed) _alignBadge();
    }
    function _fmtDur(secs) {
      const m = Math.floor(secs / 60), s = Math.round(secs % 60);
      return `-${m}:${s.toString().padStart(2, "0")}`;
    }
    function _attach(scrubber) {
      if (document.getElementById("adam-np-badge")) return;
      const sr = scrubber.shadowRoot;
      if (!sr) return;
      _npBadge = document.createElement("div");
      _npBadge.id = "adam-np-badge";
      _npBadge.style.cssText = "display:none;align-items:center;gap:5px;padding:3.5px 7px;border-radius:5px;font-size:11px;font-weight:500;letter-spacing:0em;line-height:1;white-space:nowrap;user-select:none;cursor:pointer;color:rgba(255,255,255,0.65);background:rgba(255,255,255,0.08);transition:opacity 0.12s;position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:2;";
      _npBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        const pop = document.getElementById("adam-quality-popup");
        if (pop && pop.style.display !== "none") {
          pop.style.display = "none";
        } else {
          _showQualityPopup(_npBadge);
        }
      });
      _npBadge.addEventListener("mouseenter", () => {
        _npBadge.style.opacity = "0.75";
      });
      _npBadge.addEventListener("mouseleave", () => {
        _npBadge.style.opacity = "1";
        setTimeout(() => {
          const pop = document.getElementById("adam-quality-popup");
          if (pop) pop.style.display = "none";
        }, 200);
      });
      scrubber.style.position = "relative";
      sr.appendChild(_npBadge);
      _syncBadge();
    }
    function _check() {
      if (_npBadge && !_npBadge.isConnected) _npBadge = null;
      if (_npBadge && _npBadge.isConnected) {
        _syncBadge();
        const dur = window.MusicKit?.getInstance?.()?.currentPlaybackDuration;
        if (dur > 0) {
          const rem = _npBadge.parentNode?.querySelector?.(".time.remaining");
          if (rem && rem.textContent === "--:--") rem.textContent = _fmtDur(dur);
        }
        return;
      }
      const scrubber = document.querySelector('[data-testid="lyrics-fullscreen-modal"] amp-playback-controls-progress') || document.querySelector("div.now-playing-structure amp-playback-controls-progress");
      if (scrubber) _attach(scrubber);
    }
    setInterval(_check, 300);
    window._syncNpBadge = _syncBadge;
  })();
  function deleteSession(id) {
    if (id) fetch(`${ENGINE}/api/v1/playback/${id}`, { method: "DELETE" }).catch(() => {
    });
  }
  function _sbWaitUpdate(sb, chunks) {
    return new Promise((res, rej) => {
      if (!sb.updating) return res();
      const done = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", fail);
        res();
      };
      const fail = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", fail);
        rej(new Error(`SB error chunk ${chunks}`));
      };
      sb.addEventListener("updateend", done, { once: true });
      sb.addEventListener("error", fail, { once: true });
    });
  }
  async function _sbRemove(ms, sb, start, end) {
    if (ms.readyState !== "open" || end <= start) return;
    await _sbWaitUpdate(sb, 0);
    if (ms.readyState !== "open") return;
    await new Promise((res, rej) => {
      sb.addEventListener("updateend", res, { once: true });
      sb.addEventListener("error", rej, { once: true });
      sb.remove(start, end);
    });
  }
  async function _sbEvictPlayed(ms, sb, audio, aggressiveSecs) {
    if (ms.readyState !== "open" || sb.buffered.length === 0) return;
    const evictEnd = Math.max(0, audio.currentTime - aggressiveSecs);
    if (evictEnd > sb.buffered.start(0) + 1) await _sbRemove(ms, sb, sb.buffered.start(0), evictEnd);
  }
  async function _throttleForward(ms, sb, audio, signal, FORWARD_SECS) {
    while (ms.readyState === "open" && sb.buffered.length > 0 && sb.buffered.end(sb.buffered.length - 1) - audio.currentTime > FORWARD_SECS) {
      if (signal.aborted) throw new Error("aborted");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  function _cacheAudioChunk(localSessionId, value) {
    if (!_chunkCache || _chunkCache.sessionId !== localSessionId || _chunkCache.byteSize >= 80 * 1024 * 1024) return;
    const copy = new Uint8Array(value.byteLength);
    copy.set(value);
    _chunkCache.chunks.push(copy);
    _chunkCache.byteSize += value.byteLength;
  }
  async function _appendWithRetry(sb, value, ms, audio, signal, BACKWARD_SECS, chunks) {
    try {
      sb.appendBuffer(value);
    } catch (e) {
      if (e.name === "InvalidStateError") {
        await _sbWaitUpdate(sb, chunks);
        if (signal.aborted) throw new Error("aborted");
        sb.appendBuffer(value);
      } else if (e.name === "QuotaExceededError") {
        let appended = false;
        for (let attempt = 0; !appended; attempt++) {
          await new Promise((r) => setTimeout(r, 300));
          if (signal.aborted) throw new Error("aborted");
          await _sbEvictPlayed(ms, sb, audio, attempt >= 2 ? 30 : BACKWARD_SECS);
          await _sbWaitUpdate(sb, chunks);
          try {
            sb.appendBuffer(value);
            appended = true;
          } catch (e2) {
            if (e2.name !== "QuotaExceededError") throw e2;
          }
        }
      } else {
        throw e;
      }
    }
  }
  async function pipeToSourceBuffer(sb, audio, streamUrlOrResp, signal, ms, durationSec, t0) {
    const localSessionId = _sessionId;
    const FORWARD_SECS = 240;
    const BACKWARD_SECS = 120;
    let resp;
    if (typeof streamUrlOrResp === "string") {
      resp = await fetch(streamUrlOrResp, { signal });
      if (!resp.ok) throw new Error(`Engine stream ${resp.status}`);
      console.log(`[Adam Engine] Stream open +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
    } else {
      resp = streamUrlOrResp;
      console.log(`[Adam Engine] Stream open (seek) +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
    }
    const reader = resp.body.getReader();
    let chunks = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error("aborted");
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[Adam Engine] Stream done (${chunks} chunks) +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
          break;
        }
        chunks++;
        if (ms.readyState === "closed" || audio.error) throw new Error(`MediaSource closed or audio error: ms=${ms.readyState} err=${audio.error?.code}`);
        _cacheAudioChunk(localSessionId, value);
        if (sb.buffered.length > 0 && audio.currentTime > sb.buffered.start(0) + BACKWARD_SECS + 1) {
          await _sbEvictPlayed(ms, sb, audio, BACKWARD_SECS);
        }
        await _throttleForward(ms, sb, audio, signal, FORWARD_SECS);
        await _sbWaitUpdate(sb, chunks);
        if (signal.aborted) throw new Error("aborted");
        if (ms.readyState === "closed" || audio.error) throw new Error(`MediaSource closed or audio error [post-wait]: ms=${ms.readyState} err=${audio.error?.code}`);
        await _appendWithRetry(sb, value, ms, audio, signal, BACKWARD_SECS, chunks);
      }
      await _sbWaitUpdate(sb, chunks);
      if (!signal.aborted && ms.readyState === "open") {
        if (durationSec > 0) {
          try {
            ms.duration = durationSec;
          } catch (_) {
          }
        }
        ms.endOfStream();
        _streamComplete = true;
        console.log(`[Adam Engine] Stream complete +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
        try {
          delete audio.load;
        } catch (_) {
        }
      }
    } finally {
      reader.cancel().catch(() => {
      });
    }
  }
  async function _mseFinalizeCacheInject(ms, sb, audio, pipeCtrl, mySC, wasStreamComplete, seekSec) {
    if (pipeCtrl.signal.aborted || _seekFetchCtrl !== mySC) return;
    await _sbWaitUpdate(sb, 0);
    if (wasStreamComplete) {
      if (ms.readyState === "open") {
        if (_durationSec > 0) {
          try {
            ms.duration = _durationSec;
          } catch (_) {
          }
        }
        ms.endOfStream();
        _streamComplete = true;
      }
    } else if (_seekable && _activeStreamBase) {
      const bufEnd = sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : seekSec;
      let resumeResp;
      try {
        resumeResp = await fetch(`${_activeStreamBase}&t=${bufEnd.toFixed(3)}`, { signal: pipeCtrl.signal });
      } catch (_) {
        return;
      }
      if (!resumeResp.ok || pipeCtrl.signal.aborted || _seekFetchCtrl !== mySC) {
        resumeResp?.body?.cancel();
        return;
      }
      await pipeToSourceBuffer(sb, audio, resumeResp, pipeCtrl.signal, ms, _durationSec, performance.now());
    }
  }
  async function _mseCacheReInjectBody(sb, ms, audio, cacheSnap, pipeCtrl, mySC, wasStreamComplete, seekSec) {
    const waitIdle = () => new Promise((res, rej) => {
      if (!sb.updating) return res();
      const done = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", fail);
        res();
      };
      const fail = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", fail);
        rej(new Error("SB error during cache re-inject"));
      };
      sb.addEventListener("updateend", done, { once: true });
      sb.addEventListener("error", fail, { once: true });
    });
    try {
      await waitIdle();
      if (pipeCtrl.signal.aborted || ms.readyState !== "open") return;
      if (sb.buffered.length > 0) sb.remove(0, Infinity);
      await waitIdle();
      try {
        sb.appendWindowStart = seekSec;
      } catch (_) {
      }
      for (const chunk of cacheSnap.chunks) {
        if (pipeCtrl.signal.aborted) return;
        await waitIdle();
        if (pipeCtrl.signal.aborted || ms.readyState !== "open") return;
        try {
          sb.appendBuffer(chunk);
        } catch (e) {
          if (e.name === "QuotaExceededError") console.warn("[Adam MSE] cache re-inject quota exceeded");
          return;
        }
      }
      await _mseFinalizeCacheInject(ms, sb, audio, pipeCtrl, mySC, wasStreamComplete, seekSec);
    } catch (e) {
      if (!pipeCtrl.signal.aborted) console.error("[Adam MSE] cache re-inject error:", e.message);
    }
  }
  function _mseCacheSeek(sb, audio, ms, seekSec) {
    if (Math.abs(_seekTarget - seekSec) < 0.5) {
      console.log(`[Adam MSE] Seek ${seekSec.toFixed(2)}s \u2192 cache guard`);
      return;
    }
    _seekTarget = seekSec;
    const wasPlaying = !audio.paused;
    const cacheSnap = _chunkCache;
    const wasStreamComplete = _streamComplete;
    _streamComplete = false;
    if (_seekFetchCtrl) {
      _seekFetchCtrl.abort();
    }
    _seekFetchCtrl = new AbortController();
    const mySC = _seekFetchCtrl;
    if (_pipeCtrl) {
      _pipeCtrl.abort();
      _pipeCtrl = null;
    }
    _pipeCtrl = new AbortController();
    const pipeCtrl = _pipeCtrl;
    console.log(`[Adam MSE] Seek ${seekSec.toFixed(2)}s \u2192 cache re-inject (${(cacheSnap.byteSize / 1e6).toFixed(1)} MB)`);
    _mseCacheReInjectBody(sb, ms, audio, cacheSnap, pipeCtrl, mySC, wasStreamComplete, seekSec).catch(() => {
    });
    try {
      _nativeCTSet.call(audio, seekSec);
    } catch (_) {
    }
    audio.addEventListener("canplay", () => {
      if (pipeCtrl.signal.aborted) return;
      try {
        sb.appendWindowStart = 0;
      } catch (_) {
      }
      _seekTarget = -Infinity;
      if (wasPlaying) _nativePlay().catch(() => {
      });
    }, { once: true });
  }
  async function _mseNetworkSeek(sb, audio, ms, seekSec) {
    if (_streamComplete) {
      _seekTarget = -Infinity;
      _streamComplete = false;
    }
    if (Math.abs(_seekTarget - seekSec) < 0.5) {
      console.log(`[Adam MSE] Seek ${seekSec.toFixed(2)}s \u2192 guard`);
      return;
    }
    _seekTarget = seekSec;
    const wasPlaying = !audio.paused;
    if (_seekFetchCtrl) {
      _seekFetchCtrl.abort();
    }
    _seekFetchCtrl = new AbortController();
    const mySeekCtrl = _seekFetchCtrl;
    const seekUrl = `${_activeStreamBase}&t=${seekSec.toFixed(3)}`;
    let resp;
    try {
      resp = await fetch(seekUrl, { signal: AbortSignal.any([mySeekCtrl.signal, _abortCtrl?.signal].filter(Boolean)) });
    } catch (e) {
      if (e.name !== "AbortError") console.warn("[Adam MSE] Seek fetch error:", e.message);
      return;
    }
    if (!resp.ok) {
      console.warn(`[Adam MSE] Seek ${resp.status} \u2014 not seekable`);
      return;
    }
    if (_abortCtrl?.signal.aborted || _seekFetchCtrl !== mySeekCtrl) {
      resp.body?.cancel();
      return;
    }
    const actualStart = parseFloat(resp.headers.get("X-Actual-Start") ?? seekSec);
    console.log(`[Adam MSE] Seek \u2192 ${seekSec.toFixed(2)}s (actual=${actualStart.toFixed(2)}s)`);
    if (_pipeCtrl) {
      _pipeCtrl.abort();
      _pipeCtrl = null;
    }
    const waitSBIdle = () => new Promise((res, rej) => {
      if (!sb.updating) return res();
      const done = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", fail);
        res();
      };
      const fail = () => {
        sb.removeEventListener("updateend", done);
        sb.removeEventListener("error", fail);
        rej(new Error("SB error during seek"));
      };
      sb.addEventListener("updateend", done, { once: true });
      sb.addEventListener("error", fail, { once: true });
    });
    try {
      await waitSBIdle();
      if (ms.readyState === "open") sb.remove(0, Infinity);
      await waitSBIdle();
    } catch (_) {
    }
    try {
      sb.appendWindowStart = seekSec;
    } catch (_) {
    }
    try {
      _nativeCTSet.call(audio, seekSec);
    } catch (_) {
    }
    _pipeCtrl = new AbortController();
    const pipeCtrl = _pipeCtrl;
    pipeToSourceBuffer(sb, audio, resp, pipeCtrl.signal, ms, _durationSec, performance.now()).catch((e) => {
      if (!pipeCtrl.signal.aborted) console.error("[Adam MSE] Seek pipe error:", e.message);
    });
    audio.addEventListener("canplay", () => {
      if (pipeCtrl.signal.aborted) return;
      try {
        sb.appendWindowStart = 0;
      } catch (_) {
      }
      _seekTarget = -Infinity;
      console.log(`[Adam MSE] Seek ready \u2014 req=${seekSec.toFixed(2)}s actual=${actualStart.toFixed(2)}s ct=${audio.currentTime.toFixed(2)}s`);
      if (wasPlaying) _nativePlay().catch((e) => console.warn("[Adam MSE] seek play():", e));
    }, { once: true });
  }
  async function mseSeekToTime(seekSec, audio, sb, ms) {
    if (ms.readyState === "closed") return;
    const bufferedRanges = Array.from({ length: sb.buffered.length }, (_, i) => `[${sb.buffered.start(i).toFixed(1)},${sb.buffered.end(i).toFixed(1)}]`).join(" ");
    console.log(`[Adam MSE] seekToTime(${seekSec.toFixed(2)}) ct=${audio.currentTime.toFixed(2)} buffered=${bufferedRanges || "(empty)"} seekable=${_seekable}`);
    for (let i = 0; i < sb.buffered.length; i++) {
      if (seekSec >= sb.buffered.start(i) - 1 && seekSec < sb.buffered.end(i) + 1) {
        console.log(`[Adam MSE] Seek ${seekSec.toFixed(2)}s \u2192 native (buffered)`);
        _seekTarget = -Infinity;
        const wasPlaying = !audio.paused;
        audio.addEventListener("seeked", () => {
          if (wasPlaying && audio.paused) _nativePlay().catch(() => {
          });
        }, { once: true });
        return;
      }
    }
    if (_chunkCache && _chunkCache.sessionId === _sessionId && _chunkCache.chunks.length > 0) {
      _mseCacheSeek(sb, audio, ms, seekSec);
      return;
    }
    if (!_seekable) {
      console.log(`[Adam MSE] Seek ${seekSec.toFixed(2)}s \u2192 not seekable`);
      return;
    }
    await _mseNetworkSeek(sb, audio, ms, seekSec);
  }
  function stopVLCPoll() {
    _vlcPollGeneration++;
    if (_vlcPollTimer) {
      clearInterval(_vlcPollTimer);
      _vlcPollTimer = null;
    }
  }
  function getMVContainer(signal, timeoutMs = 1e4) {
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (signal.aborted) return;
        const awk = document.querySelector("apple-music-video-player")?.shadowRoot?.querySelector("amp-window-takeover");
        const c = awk?.querySelector(".container.takeover");
        if (c && c.offsetHeight > 0) {
          resolve(c);
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("MV container not found"));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }
  async function startMVPipeline() {
    const _mvGen = _generation;
    console.log(`[Adam MV-V] enter gen=${_mvGen} session=${_sessionId} t=${Date.now()}`);
    _mvGateOpen = false;
    const containerPromise = getMVContainer(_abortCtrl.signal);
    const myVid = document.createElement("video");
    myVid.muted = true;
    myVid.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(myVid);
    const mkAudio = document.createElement("audio");
    mkAudio.style.display = "none";
    document.body.appendChild(mkAudio);
    mkAudio.addEventListener("error", () => console.error(`[Adam MV-A] mkAudio error code=${mkAudio.error?.code} msg=${mkAudio.error?.message}`));
    let ms = new MediaSource();
    let msBlobUrl = URL.createObjectURL(ms);
    myVid.src = msBlobUrl;
    let mvContainer;
    try {
      mvContainer = await containerPromise;
      console.log(`[Adam MV] container found ${mvContainer.offsetWidth}\xD7${mvContainer.offsetHeight}`);
      mvContainer.style.setProperty("pointer-events", "none", "important");
      mvContainer.style.setProperty("cursor", "wait", "important");
    } catch (e) {
      console.warn("[Adam MV] MV container not found, aborting:", e.message);
      myVid.src = "";
      if (myVid.parentNode) myVid.parentNode.removeChild(myVid);
      if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
      URL.revokeObjectURL(msBlobUrl);
      return;
    }
    const avpi = mvContainer.querySelector("amp-video-player-internal");
    const avp = avpi?.shadowRoot?.querySelector("amp-video-player");
    const avpShadow = avp?.shadowRoot;
    const vcDiv = avpShadow?.querySelector("#video-container");
    const nativeVidEl = avpShadow?.querySelector("#apple-music-video-player") ?? avpShadow?.querySelector("video");
    console.log(`[Adam MV-V] shadow traversal: avpi=${!!avpi} avp=${!!avp} avpShadow=${!!avpShadow} vcDiv=${!!vcDiv} nativeVidEl=${!!nativeVidEl} nativeVidEl.id=${nativeVidEl?.id} nativeVidEl.src="${nativeVidEl?.src?.slice(0, 60)}"`);
    if (nativeVidEl) {
      const _vidRef = nativeVidEl;
      Function.prototype.call = function(ctx, ...args) {
        if (this === _nativePauseRef && ctx === _vidRef) {
          console.warn("[Adam MV] intercepted savedPause.call(nativeVidEl) \u2014 counter-pause blocked. Stack:", new Error().stack.split("\n").slice(1, 4).join(" | "));
          return;
        }
        return Reflect.apply(_origFnCall, this, [ctx, ...args]);
      };
      Function.prototype.apply = function(ctx, args) {
        if (this === _nativePauseRef && ctx === _vidRef) {
          console.warn("[Adam MV] intercepted savedPause.apply(nativeVidEl) \u2014 counter-pause blocked.");
          return;
        }
        return Reflect.apply(_origFnApply, this, [ctx, args]);
      };
      console.log("[Adam MV] Function.prototype.call/apply intercept installed for counter-pause");
    }
    const _origReqFS = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function(opts) {
      return _origReqFS.call(document.documentElement, opts);
    };
    const _containerProps = ["position", "top", "left", "width", "height", "z-index", "background", "display", "justify-content", "align-content"];
    mvContainer.style.setProperty("position", "fixed", "important");
    mvContainer.style.setProperty("top", "0", "important");
    mvContainer.style.setProperty("left", "0", "important");
    mvContainer.style.setProperty("width", "100vw", "important");
    mvContainer.style.setProperty("height", "100vh", "important");
    mvContainer.style.setProperty("z-index", "999990", "important");
    mvContainer.style.setProperty("background", "#000", "important");
    mvContainer.style.setProperty("display", "flex", "important");
    mvContainer.style.setProperty("justify-content", "center", "important");
    mvContainer.style.setProperty("align-content", "center", "important");
    mvContainer.style.setProperty("cursor", "default", "important");
    myVid.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:100%;height:100%;object-fit:contain;z-index:1;pointer-events:none;";
    mvContainer.insertAdjacentElement("afterbegin", myVid);
    if (nativeVidEl) nativeVidEl.style.opacity = "0";
    const _vsegVideo = true;
    let _vsegBufferedSec = 0;
    let _vsegSb = null;
    console.log("%c[Adam MV]%c video backend = vseg", "color:#bf5af2;font-weight:bold", "color:inherit");
    const _nativeVidStopEvt = (e) => e.stopImmediatePropagation();
    if (nativeVidEl) {
      ["waiting", "stalled", "suspend"].forEach(
        (evt) => nativeVidEl.addEventListener(evt, _nativeVidStopEvt, true)
      );
    }
    const _subDiv = document.createElement("div");
    _subDiv.style.cssText = "position:absolute;bottom:10%;left:5%;right:5%;text-align:center;z-index:20;pointer-events:none;font-family:-apple-system,SF Pro Text,system-ui,sans-serif;transition:bottom 0.25s ease;";
    mvContainer.appendChild(_subDiv);
    const _spinSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="3"/><circle cx="22" cy="22" r="19" fill="none" stroke="white" stroke-width="3" stroke-dasharray="24 96" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 22 22" to="360 22 22" dur=".75s" repeatCount="indefinite"/></circle></svg>';
    const _bufSpinner = document.createElement("img");
    _bufSpinner.src = "data:image/svg+xml," + encodeURIComponent(_spinSvg);
    _bufSpinner.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:44px;height:44px;pointer-events:none;z-index:3;display:none";
    mvContainer.appendChild(_bufSpinner);
    let _ccEnabled = true;
    const _renderSubs = () => {
      if (!_ccEnabled) {
        _subDiv.innerHTML = "";
        return;
      }
      const lines = [];
      for (let i = 0; i < myVid.textTracks.length; i++) {
        const track = myVid.textTracks[i];
        if (track.mode === "disabled") continue;
        const cues = track.activeCues;
        for (let j = 0; j < (cues?.length ?? 0); j++) {
          const cue = cues[j];
          const text = cue instanceof VTTCue && cue.getCueAsHTML ? cue.getCueAsHTML().textContent : cue.text ?? "";
          if (text.trim()) lines.push(text.replace(/<[^>]+>/g, "").trim());
        }
      }
      if (lines.length) {
        _subDiv.style.bottom = lines.length > 2 ? "22%" : "10%";
        const escaped = lines.map((l) => l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")).join("\n");
        _subDiv.innerHTML = `<span style="display:inline-block;background:rgba(20,20,22,0.72);backdrop-filter:blur(14px) saturate(1.8);-webkit-backdrop-filter:blur(14px) saturate(1.8);color:#fff;padding:5px 14px 6px;border-radius:7px;font-size:15px;font-weight:500;line-height:1.55;white-space:pre-wrap;max-width:84%;letter-spacing:-0.1px;text-shadow:0 1px 2px rgba(0,0,0,0.3);">${escaped}</span>`;
      } else {
        _subDiv.innerHTML = "";
      }
    };
    const _attachTrack = (track) => {
      if (track.kind !== "captions" && track.kind !== "subtitles") return;
      track.mode = "hidden";
      track.addEventListener("cuechange", _renderSubs);
    };
    for (let i = 0; i < myVid.textTracks.length; i++) _attachTrack(myVid.textTracks[i]);
    myVid.textTracks.addEventListener("addtrack", (e) => _attachTrack(e.track));
    void (async () => {
      const lyricsId = _currentAssetId;
      const lyricsSf = _mkInstance?.storefrontId ?? "us";
      if (!lyricsId) return;
      try {
        const r = await fetch(`${ENGINE}/api/v1/lyrics/${encodeURIComponent(lyricsId)}?sf=${encodeURIComponent(lyricsSf)}&format=vtt`);
        if (_generation !== _mvGen || !r.ok) return;
        const vtt = await r.text();
        if (_generation !== _mvGen || !vtt || !vtt.startsWith("WEBVTT")) return;
        const blob = new Blob([vtt], { type: "text/vtt" });
        const url = URL.createObjectURL(blob);
        const trackEl = document.createElement("track");
        trackEl.kind = "subtitles";
        trackEl.srclang = "en";
        trackEl.label = "Lyrics";
        trackEl.src = url;
        trackEl.default = true;
        myVid.appendChild(trackEl);
        _abortCtrl.signal.addEventListener("abort", () => URL.revokeObjectURL(url), { once: true });
      } catch (_) {
      }
    })();
    const _nativeCCCtrl = avp?.querySelector("amp-captions-control") ?? document.querySelector("amp-captions-control");
    const _syncCCOpacity = () => {
      if (_nativeCCCtrl) _nativeCCCtrl.style.opacity = _ccEnabled ? "1" : "0.45";
    };
    const _wireCCBtn = () => {
      const menuComp = _nativeCCCtrl?.shadowRoot?.querySelector("amp-contextual-menu-button");
      const btn = menuComp?.shadowRoot?.querySelector("button");
      if (btn) {
        btn.addEventListener("click", (e) => {
          e.stopImmediatePropagation();
          e.stopPropagation();
          _ccEnabled = !_ccEnabled;
          _renderSubs();
          _syncCCOpacity();
        }, true);
        _syncCCOpacity();
      } else if (_nativeCCCtrl) {
        setTimeout(_wireCCBtn, 300);
      }
    };
    _wireCCBtn();
    const _avpiProps = ["position", "top", "left", "width", "height", "background", "transform"];
    if (avpi) {
      avpi.style.setProperty("position", "absolute", "important");
      avpi.style.setProperty("top", "0", "important");
      avpi.style.setProperty("left", "0", "important");
      avpi.style.setProperty("width", "100%", "important");
      avpi.style.setProperty("height", "100%", "important");
      avpi.style.setProperty("background", "transparent", "important");
      avpi.style.setProperty("transform", "none", "important");
    }
    const avpEl = avpi?.shadowRoot?.querySelector("amp-video-player");
    if (avpEl) {
      avpEl.style.setProperty("width", "100%", "important");
      avpEl.style.setProperty("height", "100%", "important");
      avpEl.style.setProperty("background", "transparent", "important");
    }
    if (vcDiv) {
      vcDiv.style.setProperty("width", "100%", "important");
      vcDiv.style.setProperty("height", "100%", "important");
      vcDiv.style.setProperty("background", "transparent", "important");
    }
    const gradientDiv = avpShadow?.querySelector(".gradient");
    if (gradientDiv) {
      gradientDiv.style.setProperty("display", "block", "important");
      gradientDiv.style.setProperty("opacity", "1", "important");
      gradientDiv.style.setProperty("visibility", "visible", "important");
      gradientDiv.style.setProperty("pointer-events", "none", "important");
      gradientDiv.style.setProperty("transition", "opacity 0.3s ease", "important");
    }
    const nativeVidInVc = vcDiv?.querySelector("video");
    if (nativeVidInVc && nativeVidInVc !== nativeVidEl) {
      nativeVidInVc.style.setProperty("display", "none", "important");
    }
    const mvPlay = () => {
      _userPaused = false;
      return _iframePlay.call(myVid).then(() => _iframePlay.call(mkAudio).catch(() => {
      })).catch(() => {
      });
    };
    const mvPause = () => {
      _userPaused = true;
      myVid.pause();
      mkAudio.pause();
    };
    const togglePlayPause = () => {
      if (myVid.paused) mvPlay();
      else mvPause();
    };
    if (nativeVidEl) {
      nativeVidEl.play = function() {
        if (!_avStarted) return Promise.resolve();
        if (myVid?.paused) mvPlay();
        return Promise.resolve();
      };
      nativeVidEl.pause = function() {
        if (_avStarted) mvPause();
      };
    }
    const toggleFullscreen = () => {
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {
        });
      } else {
        document.documentElement.requestFullscreen?.().catch(() => {
        });
      }
    };
    const onFullscreenChange = () => {
      _resizeScrim();
      mvContainer.style.setProperty("width", "100%", "important");
      mvContainer.style.setProperty("height", "100%", "important");
      setTimeout(_resizeScrim, 100);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    const scrimEl = avpShadow?.querySelector(".scrim");
    const scrimClickable = avpShadow?.querySelector(".scrim__clickable");
    const scrimHeader = avpShadow?.querySelector(".scrim__header");
    const scrimFooter = avpShadow?.querySelector(".scrim__footer");
    const scrimInfo = avpShadow?.querySelector(".scrim__info");
    const exitBtn = mvContainer.querySelector("amp-playback-controls-exit");
    const _resizeScrim = () => {
      const cw = mvContainer.offsetWidth || window.innerWidth;
      const ch = mvContainer.offsetHeight || window.innerHeight;
      const vw = myVid.videoWidth, vh2 = myVid.videoHeight;
      let lv = 0, lh = 0;
      if (vw && vh2) {
        const vr = vw / vh2, cr = cw / ch;
        if (vr > cr) lv = Math.round((ch - cw / vr) / 2);
        else lh = Math.round((cw - ch * vr) / 2);
      }
      if (avpi) {
        avpi.style.setProperty("top", lv + "px", "important");
        avpi.style.setProperty("left", lh + "px", "important");
        avpi.style.setProperty("width", cw - 2 * lh + "px", "important");
        avpi.style.setProperty("height", ch - 2 * lv + "px", "important");
      }
    };
    myVid.addEventListener("loadedmetadata", _resizeScrim);
    myVid.addEventListener("resize", _resizeScrim);
    const _scrimResizeObs = new ResizeObserver(_resizeScrim);
    _scrimResizeObs.observe(mvContainer);
    _resizeScrim();
    if (scrimEl) {
      scrimEl.style.setProperty("opacity", "1", "important");
      scrimEl.style.setProperty("visibility", "visible", "important");
      scrimEl.style.setProperty("transition", "opacity 0.3s ease", "important");
      scrimEl.style.setProperty("cursor", "default", "important");
    }
    if (scrimClickable) {
      scrimClickable.style.setProperty("pointer-events", "auto", "important");
      scrimClickable.style.setProperty("cursor", "default", "important");
    }
    if (scrimHeader) scrimHeader.style.setProperty("display", "none", "important");
    if (scrimFooter) {
      scrimFooter.style.setProperty("opacity", "1", "important");
      scrimFooter.style.setProperty("visibility", "visible", "important");
      scrimFooter.style.setProperty("pointer-events", "auto", "important");
    }
    if (scrimInfo) {
      scrimInfo.style.setProperty("opacity", "1", "important");
      scrimInfo.style.setProperty("visibility", "visible", "important");
    }
    let _abortReason = "unknown";
    const _abortMV = (reason) => {
      _abortReason = reason;
      console.log(`[Adam MV] abort: ${reason}`);
      _abortCtrl?.abort();
    };
    const onExitClick = (e) => {
      e.stopPropagation();
      _abortMV("exit-button");
    };
    if (exitBtn) {
      exitBtn.style.transition = "opacity 0.3s ease";
      exitBtn.style.setProperty("cursor", "default", "important");
      exitBtn.style.setProperty("z-index", "999999", "important");
      exitBtn.style.setProperty("pointer-events", "auto", "important");
      exitBtn.addEventListener("click", onExitClick);
    }
    if (!document.querySelector("#adam-sfpro-style")) {
      fetch(`${ENGINE}/fonts/SF-Pro.ttf`).then((r) => r.ok ? r.blob() : null).then((b) => {
        if (!b) return;
        const url = URL.createObjectURL(b);
        const s = document.createElement("style");
        s.id = "adam-sfpro-style";
        s.textContent = `@font-face{font-family:'SF Pro';src:url('${url}')format('truetype');font-weight:100 900;font-style:normal;}`;
        document.head.appendChild(s);
      }).catch(() => {
      });
    }
    const _sfFont = `'SF Pro',-apple-system,BlinkMacSystemFont,sans-serif`;
    const _qualityLabel = () => _mvMaxHeight >= 2160 ? "4K" : `${_mvMaxHeight}p`;
    const _tvIcon = `<svg width="20" height="17" viewBox="0 0 20 17" fill="currentColor" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><rect x="0.75" y="0.75" width="18.5" height="11.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="8" y="13" width="4" height="1.5" rx="0.6"/><rect x="5.5" y="14.5" width="9" height="2" rx="1"/></svg>`;
    const _qualityBtn = document.createElement("button");
    _qualityBtn.setAttribute("tabindex", "0");
    Object.assign(_qualityBtn.style, {
      background: "none",
      border: "none",
      color: "rgba(255,255,255,0.9)",
      fontSize: "11px",
      fontWeight: "510",
      letterSpacing: "0.02em",
      fontFamily: _sfFont,
      cursor: "pointer",
      padding: "5px 8px",
      borderRadius: "8px",
      display: "inline-flex",
      alignItems: "center",
      gap: "5px",
      transition: "background 0.12s, opacity 0.3s",
      flexShrink: "0"
    });
    const _qualitySpanEl = document.createElement("span");
    _qualitySpanEl.textContent = _qualityLabel();
    _qualityBtn.innerHTML = _tvIcon;
    _qualityBtn.appendChild(_qualitySpanEl);
    _qualityBtn.addEventListener("mouseenter", () => {
      _qualityBtn.style.background = "rgba(255,255,255,0.1)";
    });
    _qualityBtn.addEventListener("mouseleave", () => {
      _qualityBtn.style.background = "none";
    });
    const fsCtrl = avp?.querySelector("amp-playback-controls-full-screen");
    if (fsCtrl?.parentNode) {
      fsCtrl.parentNode.insertBefore(_qualityBtn, fsCtrl);
    } else if (footerRow) {
      footerRow.appendChild(_qualityBtn);
    } else {
      Object.assign(_qualityBtn.style, { position: "fixed", bottom: "64px", right: "56px", zIndex: "999999" });
      mvContainer.appendChild(_qualityBtn);
    }
    const _checkSVG = `<svg width="11" height="9" viewBox="0 0 11 9" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 4.5L4 7.5L10 1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const _activeTint = () => {
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--adam-accent-active").trim();
        if (v) return v;
      } catch (_) {
      }
      return "rgba(255,255,255,0.16)";
    };
    const _qualityMenu = document.createElement("div");
    Object.assign(_qualityMenu.style, {
      position: "fixed",
      zIndex: "1000001",
      width: "150px",
      // Matches the search-suggestions dropdown (vision-glass.js) so the two
      // popovers read as the same material.
      background: "rgba(14,14,18,0.55)",
      backdropFilter: "blur(32px) saturate(1.8) brightness(0.92)",
      WebkitBackdropFilter: "blur(32px) saturate(1.8) brightness(0.92)",
      border: "0.5px solid rgba(255,255,255,0.10)",
      borderRadius: "12px",
      padding: "5px 0",
      display: "none",
      flexDirection: "column",
      boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
      fontFamily: _sfFont,
      overflow: "hidden",
      boxSizing: "border-box"
    });
    const _sessHeights = Array.isArray(_mvVideoHeights) ? _mvVideoHeights : [];
    const _allTiers = [
      { label: "4K", height: 2160 },
      { label: "1080p", height: 1080 },
      { label: "720p", height: 720 },
      { label: "480p", height: 480 }
    ];
    const _bestForMax = (max) => Math.max(0, ..._sessHeights.filter((h) => h <= max));
    const _qualityOptions = _sessHeights.length === 0 ? _allTiers : _allTiers.filter((tier, i) => {
      const myBest = _bestForMax(tier.height);
      if (myBest === 0) return false;
      const below = _allTiers[i + 1];
      return !below || myBest > _bestForMax(below.height);
    });
    if (_qualityOptions.length > 0 && !_qualityOptions.some((o) => o.height === _mvMaxHeight)) {
      _mvMaxHeight = _qualityOptions[0].height;
      _qualitySpanEl.textContent = _qualityLabel();
    }
    _qualityOptions.forEach(({ label, height }) => {
      const opt = document.createElement("button");
      Object.assign(opt.style, {
        background: "none",
        border: "none",
        color: "rgba(255,255,255,0.92)",
        padding: "0 14px 0 10px",
        height: "28px",
        textAlign: "left",
        fontSize: "13px",
        fontWeight: "400",
        fontFamily: _sfFont,
        cursor: "default",
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: "0",
        transition: "background 0.08s"
      });
      const checkEl = document.createElement("span");
      checkEl.style.cssText = `width:22px;display:flex;align-items:center;flex-shrink:0;color:rgba(255,255,255,0.92)`;
      checkEl.innerHTML = height === _mvMaxHeight ? _checkSVG : "";
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      labelEl.style.flex = "1";
      opt.append(checkEl, labelEl);
      opt.addEventListener("mouseenter", () => {
        opt.style.background = _activeTint();
        opt.style.color = "#fff";
      });
      opt.addEventListener("mouseleave", () => {
        opt.style.background = "none";
        opt.style.color = "rgba(255,255,255,0.92)";
      });
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        _mvMaxHeight = height;
        localStorage.setItem("adam-mv-quality", String(height));
        _qualitySpanEl.textContent = _qualityLabel();
        _qualityMenu.querySelectorAll("button").forEach((b, i) => {
          b.querySelector("span").innerHTML = _qualityOptions[i].height === _mvMaxHeight ? _checkSVG : "";
        });
        _qualityMenu.style.display = "none";
        _qualityMenuOpen = false;
        const _genSnap = _generation;
        _mvResetScrubberRef?.();
        _abortMV("quality-change");
        if (rangeInput) {
          const _holdId = setInterval(() => {
            if (_mvResetScrubberRef) {
              clearInterval(_holdId);
              return;
            }
            try {
              rangeInput.value = "0";
              rangeInput.style.setProperty("--progress", "0%");
              rangeInput.style.setProperty("--width", "0%");
            } catch (_) {
            }
          }, 16);
          setTimeout(() => clearInterval(_holdId), T().qualityRace + 500);
        }
        setTimeout(() => {
          if (_generation === _genSnap && _mkInstance) handleTrackChange(_mkInstance);
        }, T().qualityRace);
      });
      _qualityMenu.appendChild(opt);
    });
    document.body.appendChild(_qualityMenu);
    let _qualityMenuOpen = false;
    const _openQualityMenu = () => {
      _qualityMenuOpen = true;
      _qualityMenu.style.visibility = "hidden";
      _qualityMenu.style.display = "flex";
      const mh = _qualityMenu.offsetHeight;
      _qualityMenu.style.visibility = "";
      const btnRect = _qualityBtn.getBoundingClientRect();
      _qualityMenu.style.top = Math.max(8, btnRect.top - mh - 8) + "px";
      _qualityMenu.style.right = window.innerWidth - btnRect.right + "px";
      _qualityMenu.style.bottom = "";
      _qualityMenu.style.left = "";
      const selected = [..._qualityMenu.querySelectorAll("button")].find((b) => b.querySelector("span")?.innerHTML?.includes("<svg")) ?? _qualityMenu.querySelector("button");
      selected?.focus();
    };
    const _closeQualityMenu = (restoreFocus = true) => {
      _qualityMenuOpen = false;
      _qualityMenu.style.display = "none";
      if (restoreFocus) _qualityBtn.focus();
    };
    _qualityBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (_qualityMenuOpen) _closeQualityMenu(false);
      else _openQualityMenu();
      _showControls();
    });
    _qualityBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        _qualityBtn.click();
      }
      if (e.key === "Escape") _closeQualityMenu();
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        _openQualityMenu();
      }
    });
    _qualityMenu.addEventListener("keydown", (e) => {
      const items = [..._qualityMenu.querySelectorAll("button")];
      const idx = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        items[(idx + 1) % items.length]?.focus();
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length]?.focus();
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        items[idx]?.click();
      }
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        _closeQualityMenu();
      }
    });
    mvContainer.addEventListener("click", () => {
      if (_qualityMenuOpen) _closeQualityMenu(false);
    });
    let _scrimAllowHide = false;
    const _scrimObs = scrimEl ? new MutationObserver(() => {
      if (_scrimAllowHide) return;
      if (scrimEl.style.opacity !== "1") scrimEl.style.setProperty("opacity", "1", "important");
      if (scrimEl.style.visibility !== "visible") scrimEl.style.setProperty("visibility", "visible", "important");
    }) : null;
    if (_scrimObs) _scrimObs.observe(scrimEl, { attributes: true, attributeFilter: ["style", "class"] });
    const footerRow = avp?.querySelector('[slot="footer"]');
    const infoEls = avp ? [...avp.querySelectorAll('[slot="info"]')] : [];
    [...infoEls, footerRow].forEach((el2) => {
      if (!el2) return;
      el2.style.setProperty("visibility", "visible", "important");
      el2.style.setProperty("opacity", "1", "important");
    });
    const footerEls = avp ? [...avp.querySelectorAll('[slot="footer"]')] : [];
    const scrubberEl = footerEls[0]?.querySelector("amp-playback-controls-progress") ?? footerRow?.querySelector("amp-playback-controls-progress");
    const scrubberShadow = scrubberEl?.shadowRoot;
    const rangeInput = scrubberShadow?.querySelector("#playback-progress") ?? scrubberShadow?.querySelector("input[type=range]");
    if (scrubberShadow && !scrubberShadow.getElementById("adam-buf-style")) {
      const st = document.createElement("style");
      st.id = "adam-buf-style";
      st.textContent = _BUF_BAR_CSS;
      scrubberShadow.appendChild(st);
    }
    if (scrubberEl) {
      scrubberEl.style.setProperty("visibility", "visible", "important");
      scrubberEl.style.setProperty("opacity", "1", "important");
    }
    let _userScrubbing = false;
    if (rangeInput) {
      rangeInput.removeAttribute("disabled");
      rangeInput.style.setProperty("pointer-events", "auto", "important");
      rangeInput.addEventListener("mousedown", () => {
        _userScrubbing = true;
      }, true);
      rangeInput.addEventListener("touchstart", () => {
        _userScrubbing = true;
      }, true);
      rangeInput.addEventListener("input", () => {
        const t = parseFloat(rangeInput.value);
        if (!isNaN(t)) {
          myVid.currentTime = t;
          mkAudio.currentTime = t;
          _updateProgress();
        }
        _showControls();
      }, true);
      let _lastCommit = -1;
      const _commitScrub = () => {
        _userScrubbing = false;
        const t = parseFloat(rangeInput.value);
        if (isNaN(t)) return;
        if (Math.abs(t - _lastCommit) < 0.25) return;
        _lastCommit = t;
      };
      const _cancelScrub = () => {
        _userScrubbing = false;
      };
      rangeInput.addEventListener("mouseup", _commitScrub, true);
      rangeInput.addEventListener("touchend", _commitScrub, true);
      rangeInput.addEventListener("change", _commitScrub, true);
      rangeInput.addEventListener("pointercancel", _cancelScrub, true);
      const _durEl = myVid;
      const _setRangeMax = () => {
        if (_durEl.duration && isFinite(_durEl.duration)) rangeInput.max = String(_durEl.duration);
        else if (_durationSec > 0) rangeInput.max = String(_durationSec);
      };
      _durEl.addEventListener("loadedmetadata", _setRangeMax);
      _durEl.addEventListener("durationchange", _setRangeMax);
      _setRangeMax();
    }
    const playCtrl = avp?.querySelector("amp-playback-controls-play");
    if (playCtrl) playCtrl.style.setProperty("display", "none", "important");
    const _svgPlay = `<svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9 6L22 14 9 22V6z"/></svg>`;
    const _svgPause = `<svg width="28" height="28" viewBox="0 0 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="4" width="6" height="20" rx="2"/><rect x="17" y="4" width="6" height="20" rx="2"/></svg>`;
    const _mvPlayBtn = document.createElement("button");
    Object.assign(_mvPlayBtn.style, {
      background: "none",
      border: "none",
      color: "rgba(255,255,255,0.95)",
      cursor: "pointer",
      padding: "0",
      width: "40px",
      height: "40px",
      borderRadius: "50%",
      flexShrink: "0",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      transition: "background 0.15s"
    });
    _mvPlayBtn.addEventListener("mouseenter", () => {
      _mvPlayBtn.style.background = "rgba(255,255,255,0.15)";
    });
    _mvPlayBtn.addEventListener("mouseleave", () => {
      _mvPlayBtn.style.background = "none";
    });
    _mvPlayBtn.addEventListener("click", (e) => {
      e.stopImmediatePropagation();
      togglePlayPause();
      _showControls();
    }, true);
    const _playStateEl = myVid;
    const _syncPlayIcon = () => {
      _mvPlayBtn.innerHTML = _playStateEl.paused ? _svgPlay : _svgPause;
      _mvPlayBtn.setAttribute("aria-label", _playStateEl.paused ? "Play" : "Pause");
    };
    _playStateEl.addEventListener("play", _syncPlayIcon);
    _playStateEl.addEventListener("pause", _syncPlayIcon);
    _playStateEl.addEventListener("playing", _syncPlayIcon);
    _syncPlayIcon();
    const _mvCurTime = () => myVid.currentTime || 0;
    const _mvSeekTo = (sec) => {
      const dur = _durationSec || myVid.duration || 1e9;
      myVid.currentTime = Math.max(0, Math.min(dur, sec));
      mkAudio.currentTime = myVid.currentTime;
    };
    const _skipFwd = avp?.querySelector("amp-playback-controls-skip-forward") ?? avp?.querySelector('[aria-label*="forward" i]') ?? avp?.querySelector('[aria-label*="10" i]');
    const _insertTarget = playCtrl ?? _skipFwd;
    if (_insertTarget?.parentNode) {
      _insertTarget.parentNode.insertBefore(_mvPlayBtn, _insertTarget);
    } else if (footerRow) {
      footerRow.appendChild(_mvPlayBtn);
    }
    const volCtrl = avp?.querySelector("amp-volume-control");
    const volInput = volCtrl?.shadowRoot?.querySelector("input[type=range]");
    if (volInput) {
      volInput.addEventListener("input", () => {
        mkAudio.volume = parseFloat(volInput.value);
        mkAudio.muted = parseFloat(volInput.value) === 0;
        _showControls();
      }, true);
    }
    const _syncVolSlider = () => {
      if (volInput && !_userScrubbing) volInput.value = String(mkAudio.muted ? 0 : mkAudio.volume);
    };
    mkAudio.addEventListener("volumechange", _syncVolSlider);
    let _hideTimer = null;
    const _showControls = () => {
      _scrimAllowHide = false;
      if (scrimEl) {
        scrimEl.style.setProperty("opacity", "1", "important");
        scrimEl.style.removeProperty("pointer-events");
      }
      if (gradientDiv) gradientDiv.style.setProperty("opacity", "1", "important");
      if (exitBtn) exitBtn.style.opacity = "1";
      _qualityBtn.style.opacity = "1";
      mvContainer.style.setProperty("cursor", "default", "important");
      clearTimeout(_hideTimer);
      _hideTimer = setTimeout(() => {
        if (_playStateEl.paused) return;
        _scrimAllowHide = true;
        if (scrimEl) {
          scrimEl.style.setProperty("opacity", "0", "important");
          scrimEl.style.setProperty("pointer-events", "none", "important");
        }
        if (gradientDiv) gradientDiv.style.setProperty("opacity", "0", "important");
        if (exitBtn) exitBtn.style.opacity = "0";
        _qualityBtn.style.opacity = "0";
        _qualityMenuOpen = false;
        _qualityMenu.style.display = "none";
        mvContainer.style.setProperty("cursor", "none", "important");
      }, 3e3);
    };
    mvContainer.addEventListener("mousemove", _showControls);
    const onKeyDown = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          togglePlayPause();
          _showControls();
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "ArrowLeft":
          e.preventDefault();
          _mvSeekTo(_mvCurTime() - 10);
          _showControls();
          break;
        case "ArrowRight":
          e.preventDefault();
          _mvSeekTo(_mvCurTime() + 10);
          _showControls();
          break;
        case "ArrowUp":
          e.preventDefault();
          mkAudio.volume = Math.min(1, mkAudio.volume + 0.1);
          _showControls();
          break;
        case "ArrowDown":
          e.preventDefault();
          mkAudio.volume = Math.max(0, mkAudio.volume - 0.1);
          _showControls();
          break;
        case "m":
        case "M":
          mkAudio.muted = !mkAudio.muted;
          _showControls();
          break;
        case "Escape":
          if (!document.fullscreenElement) _abortMV("escape-key");
          break;
        default:
          _showControls();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    _showControls();
    const onScrimClick = (e) => {
      if (e.target.closest('button, input, a, [role="button"], [role="slider"]')) {
        _showControls();
        return;
      }
      e.stopImmediatePropagation();
      _showControls();
      togglePlayPause();
    };
    scrimClickable?.addEventListener("click", onScrimClick, true);
    const onFooterClick = (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn === _qualityBtn) return;
      const label = (btn.getAttribute("aria-label") || "").toLowerCase();
      const cls = btn.className.toLowerCase();
      if (label.includes("play") || label.includes("pause") || cls.includes("play") || cls.includes("pause")) {
        e.stopImmediatePropagation();
        togglePlayPause();
        _showControls();
      } else if (label.includes("10") || label.includes("skip") || label.includes("forward") || label.includes("back") || label.includes("rewind") || cls.includes("skip")) {
        e.stopImmediatePropagation();
        const delta = label.includes("back") || label.includes("rewind") || cls.includes("back") ? -10 : 10;
        _mvSeekTo(_mvCurTime() + delta);
        _showControls();
      } else if (label.includes("fullscreen") || label.includes("screen") || cls.includes("full-screen") || cls.includes("fullscreen")) {
        e.stopImmediatePropagation();
        toggleFullscreen();
      }
    };
    scrimFooter?.addEventListener("click", onFooterClick, true);
    const _fmtTime = (s) => {
      const t = Math.max(0, Math.floor(s));
      const m = Math.floor(t / 60), sec = t % 60;
      return `${m}:${String(sec).padStart(2, "0")}`;
    };
    const progShadow = scrubberEl?.shadowRoot;
    const timeElapsed = progShadow?.querySelector(".time.elapsed");
    const timeRemain = progShadow?.querySelector(".time.remaining");
    let _thumbW = 0;
    const _measureThumb = () => {
      if (!rangeInput) return 0;
      try {
        const w = parseFloat(getComputedStyle(rangeInput, "::-webkit-slider-thumb").width);
        if (Number.isFinite(w) && w > 0 && w < 60) return w;
      } catch (_) {
      }
      return 12;
    };
    const _fillPct = (frac) => {
      const trackW = rangeInput?.clientWidth ?? 0;
      if (!(trackW > 0)) return frac * 100;
      if (_thumbW <= 0) _thumbW = _measureThumb();
      const tw = Math.min(_thumbW, trackW);
      return (tw / 2 + frac * (trackW - tw)) / trackW * 100;
    };
    const _thumbResizeObs = rangeInput ? new ResizeObserver(() => {
      _thumbW = _measureThumb();
    }) : null;
    _thumbResizeObs?.observe(rangeInput);
    const _updateProgress = () => {
      if (!rangeInput) return;
      if (_userScrubbing) return;
      const t = myVid.currentTime;
      const max = parseFloat(rangeInput.max) || parseFloat(rangeInput.getAttribute("max")) || 1;
      rangeInput.value = String(t);
      const frac = max > 0 ? Math.min(1, Math.max(0, t / max)) : 0;
      const pct2 = _fillPct(frac).toFixed(2) + "%";
      rangeInput.style.setProperty("--progress", pct2);
      rangeInput.style.setProperty("--width", pct2);
      if (max > 0) {
        let bFrac = 0;
        if (_vsegSb?.buffered.length > 0)
          bFrac = Math.min(1, Math.max(0, _vsegSb.buffered.end(_vsegSb.buffered.length - 1) / max));
        rangeInput.style.setProperty("--adam-buffer", _fillPct(bFrac).toFixed(2) + "%");
      }
      if (timeElapsed) timeElapsed.textContent = _fmtTime(t);
      if (timeRemain) timeRemain.textContent = "-" + _fmtTime(max - t);
    };
    const _resetScrubberToLoading = () => {
      if (!rangeInput) return;
      try {
        rangeInput.value = "0";
        rangeInput.style.setProperty("--progress", "0%");
        rangeInput.style.setProperty("--width", "0%");
        rangeInput.style.setProperty("--adam-buffer", "0%");
        if (timeElapsed) timeElapsed.textContent = _fmtTime(0);
        if (timeRemain) timeRemain.textContent = "--:--";
      } catch (_) {
      }
    };
    _mvResetScrubberRef = _resetScrubberToLoading;
    const _seekSyncInterval = setInterval(_updateProgress, T().poll);
    console.log(`[Adam MV-V] myVid created in mvContainer; nativeVidEl readyState=${nativeVidEl?.readyState}`);
    const audioMs = new MediaSource();
    const audioBlobUrl = URL.createObjectURL(audioMs);
    _nativeSrcSet.call(mkAudio, audioBlobUrl);
    try {
      await new Promise((resolve, reject) => {
        const sig = _abortCtrl.signal;
        sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        audioMs.addEventListener("sourceopen", resolve, { once: true });
      });
    } catch (e) {
      console.warn(`[Adam MV-V] audio MSE sourceopen failed: ${e.message}`);
      if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
      return;
    }
    URL.revokeObjectURL(audioBlobUrl);
    let _audioCanPlay = false, _videoCanPlay = false, _avStarted = false;
    let _videoStalled = false;
    const BUF_LOW = 2;
    const BUF_HIGH = 10;
    const SEEK_PRE_BUF = 0.4;
    const MV_START_LEAD = 3;
    let _dynBufTimer = null;
    let _bufPaused = false;
    let _userPaused = false;
    let _bufWaitStart = 0;
    const videoEl = myVid;
    const _getVidLead = () => {
      const ct = videoEl.currentTime;
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (videoEl.buffered.start(i) <= ct + 0.1 && ct <= videoEl.buffered.end(i))
          return videoEl.buffered.end(i) - ct;
      }
      return 0;
    };
    const _startDynBuf = () => {
      if (_dynBufTimer) return;
      _dynBufTimer = setInterval(() => {
        if (!_avStarted || _abortCtrl?.signal.aborted) {
          clearInterval(_dynBufTimer);
          _dynBufTimer = null;
          return;
        }
        if (ms.readyState === "ended") return;
        const lead = _getVidLead();
        if (_bufPaused) {
          if (lead >= BUF_HIGH) {
            _bufPaused = false;
            _bufSpinner.style.display = "none";
            if (_userPaused) {
              mkAudio.muted = false;
            } else {
              _mvGateOpen = _avStarted;
              mkAudio.currentTime = videoEl.currentTime;
              mkAudio.muted = false;
              _iframePlay.call(videoEl).catch(() => {
              });
            }
          } else {
            if (!videoEl.paused) {
              console.warn("[Adam MV buf:waiting] video escaped pause \u2014 re-pausing");
              videoEl.pause();
            }
            if (lead === 0) {
              const ct = videoEl.currentTime;
              let snapped = false;
              for (let i = 0; i < videoEl.buffered.length; i++) {
                const s = videoEl.buffered.start(i);
                if (s > ct && s - ct < 15) {
                  console.log(`[Adam MV buf:gap-snap] ct=${ct.toFixed(2)} \u2192 ${s.toFixed(2)} (gap=${(s - ct).toFixed(2)}s)`);
                  videoEl.currentTime = s;
                  snapped = true;
                  break;
                }
              }
              if (!snapped && videoEl.buffered.length > 0) {
                const bufEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
                if (ct > bufEnd && ct - bufEnd < 30 && Date.now() - _bufWaitStart > 8e3) {
                  console.warn(`[Adam MV buf:ahead-snap] ct=${ct.toFixed(2)} ahead of bufEnd=${bufEnd.toFixed(2)} \u2014 re-seeking`);
                  _bufWaitStart = Date.now();
                  _mvSeekTo(ct);
                }
              }
            }
            if (Date.now() - _bufWaitStart > 45e3) {
              console.warn(`[Adam MV buf:timeout] stalled ${((Date.now() - _bufWaitStart) / 1e3).toFixed(0)}s \u2014 restarting session`);
              _abortMV("buf-timeout");
              return;
            }
          }
        } else {
          if (lead < BUF_LOW && !videoEl.paused) {
            _bufPaused = true;
            _bufSpinner.style.display = "block";
            _mvGateOpen = false;
            _bufWaitStart = Date.now();
            videoEl.pause();
            mkAudio.muted = true;
            console.warn(`[Adam MV buf:LOW] lead=${lead.toFixed(2)}s < ${BUF_LOW}s \u2192 pausing. ct=${videoEl.currentTime.toFixed(2)} buffered=${videoEl.buffered?.length ? `${videoEl.buffered.start(0).toFixed(2)}-${videoEl.buffered.end(videoEl.buffered.length - 1).toFixed(2)}` : "empty"}`);
          } else {
            if (videoEl.paused && !_userPaused) {
              console.warn(`[Adam MV buf:stuck] videoEl paused with lead=${lead.toFixed(2)}s \u2014 retrying play`);
              _iframePlay.call(videoEl).catch(() => {
              });
            }
          }
        }
      }, BUF_POLL_MS);
    };
    const tryStart = () => {
      if (_avStarted || !_audioCanPlay || !_videoCanPlay || _abortCtrl?.signal.aborted) return;
      _avStarted = true;
      mvContainer.style.removeProperty("pointer-events");
      mvContainer.style.removeProperty("cursor");
      if (exitBtn) exitBtn.style.removeProperty("pointer-events");
      _mvGateOpen = true;
      _iframePlay.call(mkAudio).catch((e) => console.warn("[Adam MV] audio play rejected:", e.message));
    };
    mkAudio.addEventListener("canplay", () => {
      _audioCanPlay = true;
      tryStart();
    }, { once: true });
    const audioSb = audioMs.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const audioUrl = `${ENGINE}/api/v1/playback/${_sessionId}/audio?raw=1`;
    let _audioPipeCtrl = new AbortController();
    const _waitAudIdle = () => new Promise((res, rej) => {
      if (!audioSb.updating) return res();
      const onEnd = () => {
        audioSb.removeEventListener("error", onErr);
        res();
      };
      const onErr = (ev) => {
        audioSb.removeEventListener("updateend", onEnd);
        const detail = `code=${ev.target?.error?.code} msg=${ev.target?.error?.message}`;
        console.error(`[Adam MV-A] SourceBuffer ERROR event: ${detail}`);
        rej(new Error(`audio SB error: ${detail}`));
      };
      audioSb.addEventListener("updateend", onEnd, { once: true });
      audioSb.addEventListener("error", onErr, { once: true });
    });
    const _parseBoxHeader = (buf) => {
      if (!buf || buf.byteLength < 8) return `(${buf?.byteLength ?? 0}B too small)`;
      const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const results = [];
      let off = 0;
      while (off + 8 <= b.length && off < 512) {
        const size = (b[off] << 24 | b[off + 1] << 16 | b[off + 2] << 8 | b[off + 3]) >>> 0;
        const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
        results.push(`[${type}:${size}B]`);
        if (size < 8 || off + size > b.length) break;
        off += size;
      }
      const hex16 = Array.from(b.slice(0, Math.min(16, b.length))).map((x) => x.toString(16).padStart(2, "0")).join(" ");
      return `boxes=${results.join("")} hex=${hex16}`;
    };
    const _mvaTs = () => (Date.now() / 1e3).toFixed(3);
    const _mvaBufStr = () => {
      if (!audioSb || audioSb.buffered.length === 0) return "(empty)";
      const ranges = [];
      for (let i = 0; i < audioSb.buffered.length; i++)
        ranges.push(`${audioSb.buffered.start(i).toFixed(2)}-${audioSb.buffered.end(i).toFixed(2)}`);
      return ranges.join(" ");
    };
    async function appendAudioChunk(value, chunkIn, elapsed, bufBefore, signal, evictAudio) {
      try {
        audioSb.appendBuffer(value);
        await _waitAudIdle();
        const chunk = chunkIn + 1;
        const bufAfter = _mvaBufStr();
        const grew = bufBefore !== bufAfter;
        window.__adamCaptureChunk?.("mv-audio", chunk, value, bufBefore, bufAfter, grew);
        if (!grew && chunk > 1)
          console.warn(`[INTERCEPT] chunk#${chunk} DID NOT grow buffer! Encrypted fragment rejected by browser MSE.`);
        return { chunk, shouldBreak: false };
      } catch (e) {
        console.error(`[INTERCEPT APPEND-ERR] chunk#${chunkIn + 1} threw ${e.name}: ${e.message}`);
        if (e.name === "InvalidStateError") {
          console.warn(`[Adam MV-A] InvalidStateError chunk#${chunkIn} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} \u2014 retrying`);
          await _waitAudIdle();
          if (signal.aborted || audioMs.readyState !== "open") return { chunk: chunkIn, shouldBreak: true };
          audioSb.appendBuffer(value);
          await _waitAudIdle();
          const chunk = chunkIn + 1;
          return { chunk, shouldBreak: false };
        } else if (e.name === "QuotaExceededError") {
          console.warn(`[Adam MV-A] QuotaExceeded chunk#${chunkIn} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()} \u2014 evicting`);
          await evictAudio();
          await _waitAudIdle();
          if (signal.aborted || audioMs.readyState !== "open") return { chunk: chunkIn, shouldBreak: true };
          try {
            audioSb.appendBuffer(value);
            await _waitAudIdle();
            const chunk = chunkIn + 1;
            return { chunk, shouldBreak: false };
          } catch (_) {
            return { chunk: chunkIn, shouldBreak: false };
          }
        } else {
          throw e;
        }
      }
    }
    const MV_AUDIO_HOLD_MAX = 4 * 1024 * 1024;
    const concatBytes = (chunks) => {
      if (chunks.length === 1) return chunks[0];
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    };
    const runAudioPipe = async (signal) => {
      console.log(`[Adam MV-A] fetch start t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)}`);
      const t0 = performance.now();
      const resp = await fetch(audioUrl, { signal });
      if (!resp.ok) throw new Error(`audio ${resp.status}`);
      const reader = resp.body.getReader();
      let chunk = 0;
      const evictAudio = async () => {
        if (audioMs.readyState !== "open" || audioSb.buffered.length === 0) return;
        const evictTo = Math.max(0, mkAudio.currentTime - 30);
        if (evictTo > audioSb.buffered.start(0) + 1) {
          console.log(`[Adam MV-A] evict 0-${evictTo.toFixed(2)}s t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()}`);
          await _waitAudIdle();
          await new Promise((res, rej) => {
            audioSb.addEventListener("updateend", res, { once: true });
            audioSb.addEventListener("error", rej, { once: true });
            audioSb.remove(audioSb.buffered.start(0), evictTo);
          });
        }
      };
      const _sbErrListener = (ev) => {
        console.error(`[INTERCEPT SB-ERR] SourceBuffer error event fired! code=${ev.target?.error?.code} msg=${ev.target?.error?.message} readyState=${audioMs.readyState} buf=${_mvaBufStr()}`);
      };
      audioSb.addEventListener("error", _sbErrListener);
      let held = [], heldBytes = 0, offsetSet = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted || audioMs.readyState !== "open") break;
          const elapsed = ((performance.now() - t0) / 1e3).toFixed(2);
          await _waitAudIdle();
          if (signal.aborted || audioMs.readyState !== "open") break;
          const bufBefore = _mvaBufStr();
          if (!offsetSet) {
            held.push(value);
            heldBytes += value.length;
            const joined = concatBytes(held);
            const base = mp4FirstDecodeSeconds(joined);
            if (base === null && heldBytes < MV_AUDIO_HOLD_MAX) continue;
            offsetSet = true;
            held = [];
            try {
              if (base !== null && base > 0.5) {
                audioSb.timestampOffset = -base;
                console.log(`[Adam MV-A] timestampOffset=${(-base).toFixed(2)}s (HLS base=${base.toFixed(2)}s)`);
              } else if (base === null) {
                console.warn(`[Adam MV-A] could not read the stream start in ${heldBytes} bytes; audio may be offset from the video`);
              }
              audioSb.appendBuffer(joined);
              await _waitAudIdle();
            } catch (e) {
              console.warn(`[Adam MV-A] first append failed (${e.name}: ${e.message})`);
              await _waitAudIdle().catch(() => {
              });
            }
            chunk = 1;
            continue;
          }
          const r = await appendAudioChunk(value, chunk, elapsed, bufBefore, signal, evictAudio);
          if (r.shouldBreak) break;
          chunk = r.chunk;
        }
        if (!offsetSet && held.length && !signal.aborted && audioMs.readyState === "open") {
          audioSb.appendBuffer(concatBytes(held));
          await _waitAudIdle();
        }
      } finally {
        audioSb.removeEventListener("error", _sbErrListener);
        reader.cancel().catch(() => {
        });
      }
      await _waitAudIdle().catch(() => {
      });
      if (!signal.aborted && audioMs.readyState === "open") {
        try {
          delete mkAudio.load;
        } catch (_) {
        }
        try {
          audioMs.endOfStream();
        } catch (_) {
        }
      }
    };
    runAudioPipe(_audioPipeCtrl.signal).catch((e) => {
      if (!_audioPipeCtrl.signal.aborted) console.error("[Adam MV] audio pipe error:", e);
    });
    try {
      if (ms.readyState !== "open") {
        await new Promise((resolve, reject) => {
          const sig = _abortCtrl.signal;
          sig.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          ms.addEventListener("sourceopen", resolve, { once: true });
        });
      }
    } catch (e) {
      console.warn(`[Adam MV-V] video MSE sourceopen failed: ${e.message}`);
      _audioPipeCtrl.abort();
      mkAudio.pause();
      mkAudio.src = "";
      if (audioMs.readyState === "open") {
        try {
          audioMs.endOfStream();
        } catch (_) {
        }
      }
      if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
      return;
    }
    URL.revokeObjectURL(msBlobUrl);
    if (_durationSec > 0) {
      try {
        ms.duration = _durationSec;
      } catch (_) {
      }
    }
    _activeMvControls = {
      play: mvPlay,
      pause: mvPause,
      seekTo: _mvSeekTo,
      get currentTime() {
        return myVid.currentTime || 0;
      },
      get duration() {
        return myVid.duration || _durationSec || 0;
      },
      get paused() {
        return myVid.paused;
      },
      get volume() {
        return mkAudio.volume;
      },
      set volume(v) {
        mkAudio.volume = v;
      },
      get muted() {
        return mkAudio.muted;
      },
      set muted(m) {
        mkAudio.muted = m;
      }
    };
    const _setupVsegVideo = () => {
      const base = `${ENGINE}/api/v1/playback/${_sessionId}/vseg`;
      const BUFFER_AHEAD = 12;
      const ms2 = new MediaSource();
      myVid.src = URL.createObjectURL(ms2);
      _bufSpinner.style.display = "block";
      let sb = null;
      let _vsegCodecs = "";
      let fetchGeneration = 0;
      let loopAbort = new AbortController();
      let _seekHandlerActive = false;
      let _seekFreeze = null;
      const stopFetchLoop = () => {
        fetchGeneration++;
        loopAbort.abort();
        loopAbort = new AbortController();
      };
      const waitUpdateEnd = () => new Promise((resolve, reject) => {
        if (!sb.updating) {
          resolve();
          return;
        }
        const onDone = () => {
          sb.removeEventListener("updateend", onDone);
          sb.removeEventListener("error", onFail);
          resolve();
        };
        const onFail = (e) => {
          sb.removeEventListener("updateend", onDone);
          sb.removeEventListener("error", onFail);
          reject(e);
        };
        sb.addEventListener("updateend", onDone);
        sb.addEventListener("error", onFail);
      });
      const _showSeekFreeze = () => {
        if (myVid.readyState < 2 || myVid.videoWidth === 0) return;
        if (_seekFreeze) {
          try {
            _seekFreeze.remove();
          } catch (_) {
          }
        }
        const c = document.createElement("canvas");
        c.width = myVid.videoWidth;
        c.height = myVid.videoHeight;
        c.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:100%;height:100%;object-fit:contain;z-index:2;pointer-events:none;";
        c.getContext("2d").drawImage(myVid, 0, 0);
        mvContainer.appendChild(c);
        _seekFreeze = c;
      };
      const _clearSeekFreeze = () => {
        if (_seekFreeze) {
          try {
            _seekFreeze.remove();
          } catch (_) {
          }
          _seekFreeze = null;
        }
      };
      const _directVerdicts = window.__adamVsegDirect = window.__adamVsegDirect || {};
      const _probeDirect = async (resp, sig) => {
        let url = null, probeVid = null;
        try {
          const [ir, sr] = await Promise.all([
            fetch(`${base}/init`, { signal: sig }),
            fetch(`${base}/seg/0`, { signal: sig })
          ]);
          if (!ir.ok || !sr.ok) return false;
          const [initData, segData] = await Promise.all([ir.arrayBuffer(), sr.arrayBuffer()]);
          const pms = new MediaSource();
          probeVid = document.createElement("video");
          probeVid.muted = true;
          url = URL.createObjectURL(pms);
          probeVid.src = url;
          await new Promise((res, rej) => {
            pms.addEventListener("sourceopen", res, { once: true });
            setTimeout(() => rej(new Error("sourceopen timeout")), 3e3);
          });
          const psb = pms.addSourceBuffer(`video/mp4; codecs="${_vsegCodecs}"`);
          psb.timestampOffset = resp.tsOffset;
          const append = (buf) => new Promise((res, rej) => {
            psb.addEventListener("error", () => rej(new Error("append error")), { once: true });
            psb.addEventListener("updateend", res, { once: true });
            psb.appendBuffer(buf);
          });
          await append(initData);
          await append(segData);
          if (!psb.buffered.length) throw new Error("nothing buffered");
          const start = psb.buffered.start(0);
          if (Math.abs(start - resp.t) > 0.5) throw new Error(`placed at ${start.toFixed(2)}s, engine said ${resp.t.toFixed(2)}s`);
          console.log(`[Adam vseg] direct probe ok: buffered ${start.toFixed(2)}-${psb.buffered.end(0).toFixed(2)}s (tsOffset=${resp.tsOffset})`);
          return true;
        } catch (e) {
          console.warn("[Adam vseg] direct probe failed:", e?.message || e);
          return false;
        } finally {
          try {
            if (probeVid) {
              probeVid.removeAttribute("src");
              probeVid.load();
            }
          } catch (_) {
          }
          try {
            if (url) URL.revokeObjectURL(url);
          } catch (_) {
          }
        }
      };
      const runFetchLoop = async (startN) => {
        const gen = fetchGeneration;
        const sig = loopAbort.signal;
        let nextSeg = startN;
        try {
          while (!sig.aborted && gen === fetchGeneration && !_abortCtrl?.signal.aborted) {
            if (sb && sb.buffered.length > 0) {
              const ahead = sb.buffered.end(sb.buffered.length - 1) - myVid.currentTime;
              if (ahead > BUFFER_AHEAD) {
                await new Promise((r2) => setTimeout(r2, 400));
                continue;
              }
            }
            const r = await fetch(`${base}/seg/${nextSeg}`, { signal: sig }).catch(() => null);
            if (!r || sig.aborted || gen !== fetchGeneration) break;
            if (r.status === 404) {
              if (ms2.readyState === "open") ms2.endOfStream();
              break;
            }
            if (!r.ok) {
              console.warn(`[Adam vseg] seg/${nextSeg} HTTP ${r.status}`);
              break;
            }
            const data = await r.arrayBuffer();
            if (sig.aborted || gen !== fetchGeneration) break;
            await waitUpdateEnd();
            if (sig.aborted || gen !== fetchGeneration) break;
            sb.appendBuffer(data);
            await waitUpdateEnd();
            if (sig.aborted || gen !== fetchGeneration) break;
            if (sb.buffered.length > 0)
              _vsegBufferedSec = sb.buffered.end(sb.buffered.length - 1);
            nextSeg++;
          }
        } catch (e) {
          if (e.name !== "AbortError") console.warn("[Adam vseg] fetch loop error:", e);
        }
      };
      ms2.addEventListener("sourceopen", async () => {
        if (_durationSec > 0) {
          try {
            ms2.duration = _durationSec;
          } catch (_) {
          }
        }
        let codecs = "";
        for (let i = 0; i < 10 && !codecs; i++) {
          const m = await fetch(`${base}/manifest`).then((r) => r.json()).catch(() => null);
          if (m?.codecs) {
            codecs = m.codecs;
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!codecs) {
          console.error("[Adam vseg] no codec from manifest");
          return;
        }
        _vsegCodecs = codecs;
        sb = ms2.addSourceBuffer(`video/mp4; codecs="${codecs}"`);
        _vsegSb = sb;
        sb.addEventListener("error", (e) => console.error("[Adam vseg] SourceBuffer error", e));
        const initRes = await fetch(`${base}/init`).catch(() => null);
        if (!initRes?.ok) {
          console.error("[Adam vseg] init fetch failed");
          return;
        }
        const initData = await initRes.arrayBuffer();
        sb.appendBuffer(initData);
        await waitUpdateEnd();
        runFetchLoop(0);
      });
      myVid.addEventListener("seeking", async () => {
        if (!sb) return;
        if (_seekHandlerActive) return;
        const seekSec = myVid.currentTime;
        for (let i = 0; i < sb.buffered.length; i++) {
          if (sb.buffered.start(i) <= seekSec && seekSec < sb.buffered.end(i)) return;
        }
        _seekHandlerActive = true;
        _showSeekFreeze();
        _bufSpinner.style.display = "block";
        if (!mkAudio.paused) mkAudio.pause();
        mkAudio.currentTime = seekSec;
        _vsegBufferedSec = seekSec;
        stopFetchLoop();
        const sig = loopAbort.signal;
        console.log(`[Adam vseg] seek to ${seekSec.toFixed(2)}s`);
        const seekUrl = (noDirect) => `${base}/seek?t=${seekSec}${noDirect ? "&direct=0" : ""}`;
        let resp = await fetch(seekUrl(_directVerdicts[_vsegCodecs] === false), { signal: sig }).then((r) => r.json()).catch(() => null);
        if (sig.aborted) {
          _seekHandlerActive = false;
          return;
        }
        if (resp?.direct && _directVerdicts[_vsegCodecs] === void 0) {
          const ok = await _probeDirect(resp, sig);
          if (sig.aborted) {
            _seekHandlerActive = false;
            return;
          }
          _directVerdicts[_vsegCodecs] = ok;
          if (!ok) {
            console.warn("[Adam vseg] direct seek rejected by the probe \u2014 using the FFmpeg path from now on");
            resp = await fetch(seekUrl(true), { signal: sig }).then((r) => r.json()).catch(() => null);
            if (sig.aborted) {
              _seekHandlerActive = false;
              return;
            }
          }
        }
        const startN = resp?.n ?? 0;
        const startT = resp?.t ?? 0;
        await waitUpdateEnd().catch(() => {
        });
        if (sb.buffered.length > 0) {
          const end = sb.buffered.end(sb.buffered.length - 1);
          if (end > 0) {
            sb.remove(0, end + 1e-3);
            await waitUpdateEnd().catch(() => {
            });
          }
        }
        const tsOff = typeof resp?.tsOffset === "number" ? resp.tsOffset : startN === 0 ? startT : 0;
        try {
          sb.timestampOffset = tsOff;
        } catch (_) {
        }
        if (resp?.reinit) {
          try {
            const ir = await fetch(`${base}/init`, { signal: sig });
            if (!ir.ok) throw new Error(`init HTTP ${ir.status}`);
            const initData = await ir.arrayBuffer();
            if (sig.aborted) {
              _seekHandlerActive = false;
              return;
            }
            await waitUpdateEnd().catch(() => {
            });
            sb.appendBuffer(initData);
            await waitUpdateEnd();
            console.log(`[Adam vseg] re-initialised SourceBuffer (${resp.direct ? "direct" : "ffmpeg"} init, ${initData.byteLength}B, tsOffset=${tsOff})`);
          } catch (e) {
            if (e?.name !== "AbortError") console.error("[Adam vseg] re-init failed:", e?.message || e);
            _seekHandlerActive = false;
            return;
          }
        }
        if (!sig.aborted) runFetchLoop(startN);
      });
      myVid.addEventListener("seeked", () => {
        _seekHandlerActive = false;
        _clearSeekFreeze();
        if (!myVid.paused && mkAudio.paused) {
          const tryResume = () => {
            if (_abortCtrl?.signal.aborted) {
              _bufSpinner.style.display = "none";
              return;
            }
            if (myVid.paused) {
              _bufSpinner.style.display = "none";
              return;
            }
            if (_getVidLead() >= SEEK_PRE_BUF) {
              _bufSpinner.style.display = "none";
              if (myVid.paused) _iframePlay.call(myVid).catch(() => {
              });
              _iframePlay.call(mkAudio).catch(() => {
              });
            } else {
              setTimeout(tryResume, 200);
            }
          };
          tryResume();
        } else {
          _bufSpinner.style.display = "none";
        }
      });
      mkAudio.addEventListener("play", () => {
        if (_seekHandlerActive || _bufPaused || _playMirrorBusy) return;
        if (myVid.paused) _iframePlay.call(myVid).catch(() => {
        });
      });
      mkAudio.addEventListener("pause", () => {
        if (_seekHandlerActive || _bufPaused) return;
        if (!myVid.paused) myVid.pause();
      });
      let _vsegStalled = false;
      let _vsegMutedForStall = false;
      myVid.addEventListener("waiting", () => {
        if (!_avStarted || _seekHandlerActive || _vsegStalled) return;
        _vsegStalled = true;
        if (!mkAudio.muted) {
          mkAudio.muted = true;
          _vsegMutedForStall = true;
        }
        _bufSpinner.style.display = "block";
        console.log(`[Adam vseg] waiting at ct=${myVid.currentTime.toFixed(2)}`);
      });
      myVid.addEventListener("playing", () => {
        _clearSeekFreeze();
        _bufSpinner.style.display = "none";
        if (_vsegStalled) {
          _vsegStalled = false;
          const drift = mkAudio.currentTime - myVid.currentTime;
          if (Math.abs(drift) > 0.05) {
            console.log(`[Adam vseg] playing: snap mkAudio ${mkAudio.currentTime.toFixed(2)} \u2192 ${myVid.currentTime.toFixed(2)} (drift=${drift.toFixed(2)}s)`);
            mkAudio.currentTime = myVid.currentTime;
          }
          if (_vsegMutedForStall) {
            mkAudio.muted = false;
            _vsegMutedForStall = false;
          }
        }
      });
      let _vsegLastNudge = 0;
      myVid.addEventListener("timeupdate", () => {
        if (!_avStarted || _seekHandlerActive || _vsegStalled) return;
        const drift = mkAudio.currentTime - myVid.currentTime;
        const now = performance.now();
        if (Math.abs(drift) > 0.35 && now - _vsegLastNudge > 500) {
          _vsegLastNudge = now;
          console.log(`[Adam vseg] timeupdate drift=${drift.toFixed(3)}s \u2192 snap`);
          mkAudio.currentTime = myVid.currentTime;
        }
      });
      myVid.addEventListener("canplay", () => {
        _bufSpinner.style.display = "none";
        _clearSeekFreeze();
        _videoCanPlay = true;
        tryStart();
        _iframePlay.call(myVid).catch((e) => console.warn("[Adam vseg] myVid play rejected:", e.message));
      }, { once: true });
      _abortCtrl.signal.addEventListener("abort", () => {
        stopFetchLoop();
        fetch(`${base}`, { method: "DELETE" }).catch(() => {
        });
        _vsegSb = null;
        if (_vsegMutedForStall) {
          mkAudio.muted = false;
          _vsegMutedForStall = false;
        }
      }, { once: true });
      console.log("[Adam vseg] setup done, waiting for sourceopen");
    };
    _setupVsegVideo();
    let _mvVidSeeking = false;
    let _ignoreSeekUntil = 0;
    let _seekSnapCanvas = null;
    const _showSeekSnap = () => {
      if (videoEl.readyState < 2 || videoEl.videoWidth === 0) return;
      if (_seekSnapCanvas) {
        try {
          _seekSnapCanvas.remove();
        } catch (_) {
        }
      }
      const c = document.createElement("canvas");
      c.width = videoEl.videoWidth;
      c.height = videoEl.videoHeight;
      c.getContext("2d").drawImage(videoEl, 0, 0);
      c.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;z-index:3;pointer-events:none;";
      mvContainer.appendChild(c);
      _seekSnapCanvas = c;
    };
    const _hideSeekSnap = () => {
      if (!_seekSnapCanvas) return;
      try {
        _seekSnapCanvas.remove();
      } catch (_) {
      }
      _seekSnapCanvas = null;
    };
    let _playMirrorBusy = false;
    const onVideoPlay = () => {
      console.log(`[Adam MV-V] videoEl play ct=${videoEl.currentTime.toFixed(2)} mkAudio.paused=${mkAudio.paused} mkAudio.muted=${mkAudio.muted} mkAudio.volume=${mkAudio.volume} mkAudio.readyState=${mkAudio.readyState}`);
      if (Math.abs(mkAudio.currentTime - videoEl.currentTime) > 0.5)
        mkAudio.currentTime = videoEl.currentTime;
      const doPlay = () => {
        _playMirrorBusy = true;
        return _iframePlay.call(mkAudio).then(() => console.log("[Adam MV-A] mkAudio.play() resolved")).catch((e) => console.warn("[Adam MV-A] mkAudio.play() rejected:", e.message)).finally(() => {
          _playMirrorBusy = false;
        });
      };
      if (mkAudio.readyState >= 3) {
        doPlay();
        return;
      }
      mkAudio.addEventListener("canplay", doPlay, { once: true });
    };
    const onVideoPlaying = () => {
      _hideSeekSnap();
      _ignoreSeekUntil = 0;
      nativeVidEl?.dispatchEvent(new Event("playing", { bubbles: false }));
      getMKAudio()?.dispatchEvent(new Event("playing", { bubbles: false }));
      if (_videoStalled) {
        _videoStalled = false;
        _mvGateOpen = _avStarted;
        _bufSpinner.style.display = "none";
        const drift = mkAudio.currentTime - videoEl.currentTime;
        if (Math.abs(drift) > 0.05) {
          console.log(`[Adam MV buf:sync] stall recovery drift=${drift.toFixed(2)}s, snapping audio ct=${videoEl.currentTime.toFixed(2)}`);
          mkAudio.currentTime = videoEl.currentTime;
        }
        mkAudio.muted = false;
        console.log(`[Adam MV buf:sync] audio unmuted, video resumed ct=${videoEl.currentTime.toFixed(2)}`);
      }
    };
    const onVideoPause = () => {
      if (_bufPaused) return;
      console.log(`[Adam MV-V] videoEl pause ct=${videoEl.currentTime.toFixed(2)}`);
      mkAudio.pause();
      nativeVidEl?.dispatchEvent(new Event("pause", { bubbles: false }));
      getMKAudio()?.dispatchEvent(new Event("pause", { bubbles: false }));
    };
    const onVideoSeek = () => {
      if (_mvVidSeeking) return;
      console.log(`[Adam MV-V] videoEl seeked ct=${videoEl.currentTime.toFixed(2)}`);
      if (Math.abs(mkAudio.currentTime - videoEl.currentTime) > 0.5)
        mkAudio.currentTime = videoEl.currentTime;
    };
    const onEnded = (ev) => {
      if (_abortCtrl?.signal.aborted) return;
      const src = ev?.target === videoEl ? "video" : "audio";
      console.log(`[Adam MV] ${src} ended ct=${(videoEl.currentTime || mkAudio.currentTime)?.toFixed(2)}`);
      try {
        delete mkAudio.load;
      } catch (_) {
      }
      _abortMV("track-ended");
      _adamNextRef?.().catch(() => {
      });
      setTimeout(() => exitBtn?.click(), 200);
    };
    let _decodeRetryCount = 0;
    const onVideoError = () => {
      const code = videoEl.error?.code;
      const msg = videoEl.error?.message ?? "";
      console.error(`[Adam MV-V] videoEl error code=${code} msg="${msg}" buffered=${videoEl.buffered?.length ? `${videoEl.buffered.start(0).toFixed(2)}-${videoEl.buffered.end(videoEl.buffered.length - 1).toFixed(2)}` : "empty"} ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
      if (code === 3) {
        if (_decodeRetryCount === 0) {
          console.warn(`[Adam MV-V] decode error code=3 \u2014 deferring to pipe restart`);
          return;
        }
        if (_decodeRetryCount < 3) return;
        console.warn(`[Adam MV] decode error code=3 \u2014 pipe retries exhausted, advancing track`);
        _abortMV(`video-error-3`);
        _adamNextRef?.().catch(() => {
        });
        setTimeout(() => exitBtn?.click(), 200);
      } else if (code === 4) {
        console.warn(`[Adam MV] src-not-supported (code=4) \u2014 not retryable, advancing track`);
        _abortMV(`video-error-${code}`);
        _adamNextRef?.().catch(() => {
        });
        setTimeout(() => exitBtn?.click(), 200);
      }
    };
    const onVideoStall = () => console.warn(`[Adam MV-V] videoEl stalled ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
    const onVideoWait = () => {
      console.warn(`[Adam MV buf:stall] videoEl waiting ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
      if (_avStarted && !_videoStalled && !_bufPaused) {
        _videoStalled = true;
        _mvGateOpen = false;
        mkAudio.muted = true;
        _bufSpinner.style.display = "block";
        console.warn(`[Adam MV buf:stall] audio muted during video stall ct=${mkAudio.currentTime.toFixed(2)}`);
      }
    };
    videoEl.addEventListener("play", onVideoPlay);
    videoEl.addEventListener("playing", onVideoPlaying);
    videoEl.addEventListener("pause", onVideoPause);
    videoEl.addEventListener("seeked", onVideoSeek);
    videoEl.addEventListener("error", onVideoError);
    videoEl.addEventListener("stalled", onVideoStall);
    videoEl.addEventListener("waiting", onVideoWait);
    videoEl.addEventListener("ended", onEnded);
    videoEl.addEventListener("canplay", () => {
      if (_abortCtrl?.signal.aborted) return;
      console.log(`[Adam MV] canplay videoWidth=${videoEl.videoWidth} videoHeight=${videoEl.videoHeight} readyState=${videoEl.readyState}`);
      const checkBuf = () => {
        if (_abortCtrl?.signal.aborted) return;
        const b = videoEl.buffered;
        const lead = b.length > 0 ? b.end(b.length - 1) : 0;
        if (lead >= MV_START_LEAD) {
          console.log(`[Adam MV buf:gate] video gate satisfied lead=${lead.toFixed(2)}s`);
          _videoCanPlay = true;
          tryStart();
        } else {
          console.log(`[Adam MV buf:gate] video gate waiting lead=${lead.toFixed(2)}s (need ${MV_START_LEAD}s)`);
          videoEl.addEventListener("progress", checkBuf, { once: true });
        }
      };
      checkBuf();
    }, { once: true });
    mkAudio.addEventListener("ended", onEnded);
    const cleanupScrimStyles = () => {
      if (scrimEl) {
        ["opacity", "visibility", "transition", "cursor"].forEach((p) => scrimEl.style.removeProperty(p));
      }
      if (scrimClickable) {
        ["pointer-events", "cursor"].forEach((p) => scrimClickable.style.removeProperty(p));
      }
      if (scrimFooter) {
        ["opacity", "visibility", "pointer-events"].forEach((p) => scrimFooter.style.removeProperty(p));
      }
      if (scrimHeader) {
        scrimHeader.style.removeProperty("display");
      }
      if (scrimInfo) {
        ["opacity", "visibility"].forEach((p) => scrimInfo.style.removeProperty(p));
      }
    };
    const cleanupVideoContainerStyles = () => {
      if (avpi) {
        for (const p of _avpiProps) avpi.style.removeProperty(p);
      }
      if (avpEl) {
        avpEl.style.removeProperty("width");
        avpEl.style.removeProperty("height");
        avpEl.style.removeProperty("background");
      }
      if (vcDiv) {
        vcDiv.style.removeProperty("width");
        vcDiv.style.removeProperty("height");
        vcDiv.style.removeProperty("background");
      }
      if (gradientDiv) {
        ["display", "opacity", "visibility", "pointer-events", "transition"].forEach((p) => gradientDiv.style.removeProperty(p));
      }
    };
    const cleanup = () => {
      console.log(`[Adam MV-V] cleanup gen=${_mvGen} curGen=${_generation} reason=${_abortReason}`);
      _hideSeekSnap();
      _activeMvControls = null;
      try {
        delete mkAudio.load;
      } catch (_) {
      }
      clearInterval(_dynBufTimer);
      _dynBufTimer = null;
      if (mkAudio.muted) mkAudio.muted = false;
      _audioPipeCtrl.abort();
      mkAudio.pause();
      if (_abortReason === "exit-button") {
        try {
          delete mkAudio.play;
        } catch (_) {
        }
        _proxyInstalled = false;
        _msePaused = false;
        setPlayState(PLAY_STATE.IDLE, "mv:exit");
      }
      nativeVidEl?.dispatchEvent(new Event("pause", { bubbles: false }));
      if (myVid.parentNode) myVid.parentNode.removeChild(myVid);
      mvContainer.removeEventListener("mousemove", _showControls);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {
      });
      scrimClickable?.removeEventListener("click", onScrimClick, true);
      scrimFooter?.removeEventListener("click", onFooterClick, true);
      for (const p of _containerProps) mvContainer.style.removeProperty(p);
      mvContainer.style.removeProperty("cursor");
      mvContainer.style.removeProperty("pointer-events");
      _scrimObs?.disconnect();
      _scrimResizeObs?.disconnect();
      myVid.removeEventListener("loadedmetadata", _resizeScrim);
      myVid.removeEventListener("resize", _resizeScrim);
      cleanupScrimStyles();
      if (exitBtn) {
        exitBtn.removeEventListener("click", onExitClick);
        exitBtn.style.opacity = "";
        exitBtn.style.transition = "";
        ["cursor", "z-index", "pointer-events"].forEach((p) => exitBtn.style.removeProperty(p));
      }
      if (_qualityBtn.parentNode) _qualityBtn.parentNode.removeChild(_qualityBtn);
      if (_qualityMenu.parentNode) _qualityMenu.parentNode.removeChild(_qualityMenu);
      if (vcDiv) vcDiv.classList.remove("hide-cursor");
      clearTimeout(_hideTimer);
      clearInterval(_seekSyncInterval);
      _thumbResizeObs?.disconnect();
      if (_mvResetScrubberRef === _resetScrubberToLoading) _mvResetScrubberRef = null;
      _nativeSeekRef = null;
      cleanupVideoContainerStyles();
      mvContainer.style.removeProperty("cursor");
      if (nativeVidInVc) nativeVidInVc.style.removeProperty("display");
      if (nativeVidEl) {
        nativeVidEl.style.opacity = "";
        ["waiting", "stalled", "suspend"].forEach(
          (evt) => nativeVidEl.removeEventListener(evt, _nativeVidStopEvt, true)
        );
      }
      Element.prototype.requestFullscreen = _origReqFS;
      _mvPlayBtn.remove();
      _playStateEl.removeEventListener("play", _syncPlayIcon);
      _playStateEl.removeEventListener("pause", _syncPlayIcon);
      _playStateEl.removeEventListener("playing", _syncPlayIcon);
      mkAudio.removeEventListener("volumechange", _syncVolSlider);
      Function.prototype.call = _origFnCall;
      Function.prototype.apply = _origFnApply;
      _mvGateOpen = true;
      _bufSpinner.style.display = "none";
      if (_bufSpinner.parentNode) _bufSpinner.parentNode.removeChild(_bufSpinner);
      if (_subDiv.parentNode) _subDiv.parentNode.removeChild(_subDiv);
      for (let i = 0; i < myVid.textTracks.length; i++)
        myVid.textTracks[i].removeEventListener("cuechange", _renderSubs);
    };
    _abortCtrl.signal.addEventListener("abort", cleanup, { once: true });
    console.log(`[Adam MV] pipeline started session=${_sessionId}`);
  }
  function _vlcHandleLength(lengthMs) {
    if (!_vlcLengthSet && lengthMs > 0) {
      _vlcLengthSet = true;
      _durationSec = lengthMs / 1e3;
      if (_mkInstance) bridgeDuration(_mkInstance, _durationSec);
    }
    if (!_nextAlacTried && !_nextAlacSession && _durationSec > 0) {
      _nextAlacTried = true;
      console.log(`[Adam Gapless] trigger at track start (dur=${_durationSec.toFixed(1)}s) \u2014 starting ALAC pre-warm`);
      _prewarmNextAlac().catch(() => {
      });
    }
    if (!_nextMvTried && !_nextMvSession && _durationSec > 0) {
      _nextMvTried = true;
      _prewarmNextMv().catch(() => {
      });
    }
  }
  function _vlcUpdatePosition(posMs, state, mkAudio) {
    const prevPos = _vlcPosMs;
    if (!_vlcSeekFrozen && posMs > 0) _vlcPosMs = posMs;
    if (_vlcPosMs !== prevPos) mkAudio.dispatchEvent(new Event("timeupdate"));
    if (++_vlcTickCount % 4 === 0) {
      window.adamBridge?.mprisUpdate?.({ position: _vlcPosMs * 1e3 });
    }
    if (_seekBurstLog > 0) {
      _seekBurstLog--;
      const delta = posMs > 0 ? posMs - _vlcSeekTargetMs : null;
      const deltaStr = delta !== null ? ` \u0394=${delta >= 0 ? "+" : ""}${delta}ms` : "";
      console.log(`[Adam VLC seek] poll  vlc.posMs=${posMs}ms  ui.pos=${_vlcPosMs}ms  target=${_vlcSeekTargetMs}ms${deltaStr}  state=${state}  frozen=${_vlcSeekFrozen}`);
      if (delta !== null && delta < -5e3 && _seekBurstLog > 10 && _sessionId && !_vlcSeekFrozen) {
        _seekBurstLog = 0;
        const reloadMs = _vlcSeekTargetMs;
        const seekRevision = _vlcSeekRevision;
        console.warn(`[Adam VLC seek] rewind detected \u0394=${delta}ms \u2014 SeekReload fallback to ${reloadMs}ms`);
        _vlcSeekFrozen = true;
        _vlcPosMs = reloadMs;
        fetch(`${ENGINE}/api/v1/vlc/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: _sessionId, assetId: _currentAssetId, startMs: reloadMs })
        }).then(() => {
          if (seekRevision !== _vlcSeekRevision) return;
          _vlcSeekFrozen = false;
          _seekBurstLog = 20;
          _vlcPrevState = null;
        }).catch(() => {
          if (seekRevision === _vlcSeekRevision) _vlcSeekFrozen = false;
        });
      }
    } else if (_vlcTickCount % 20 === 0) {
      console.log(`[Adam VLC] pos=${posMs}ms state=${state}`);
    }
  }
  function _vlcRetryFrom(posMs, mkAudio, delay) {
    const sessionId = _sessionId;
    const assetId = _currentAssetId;
    setTimeout(async () => {
      if (_sessionId !== sessionId || !_vlcMode) return;
      try {
        const response = await fetch(`${ENGINE}/api/v1/vlc/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, assetId, startMs: posMs }),
          signal: AbortSignal.timeout(15e3)
        });
        if (!response.ok) throw new Error(`VLC reload: HTTP ${response.status}`);
        if (_sessionId !== sessionId) return;
        _vlcPosMs = posMs;
        _vlcLoading = true;
      } catch (error) {
        if (_sessionId === sessionId) console.warn("[Adam VLC] recovery failed:", error.message);
      } finally {
        if (_sessionId === sessionId && _vlcMode) startVLCPoll(mkAudio);
      }
    }, delay);
  }
  function _vlcHandleEnded(posMs, mkAudio, reason = "ended") {
    stopVLCPoll();
    if (posMs < 2e3 && _durationSec > 5 && _vlcRetryCount < 2) {
      _vlcRetryCount++;
      _vlcSeekOffsetMs = 0;
      console.log(`[Adam VLC] premature end at posMs=${posMs} \u2014 reload attempt ${_vlcRetryCount}`);
      _vlcRetryFrom(0, mkAudio, 1500);
      return;
    }
    const trackEndMs = Math.round(_durationSec * 1e3);
    const endWindowMs = reason === "error" ? 3e3 : Math.min(1e4, trackEndMs * 0.1);
    if (posMs > 2e3 && trackEndMs > 5e3 && posMs < trackEndMs - endWindowMs && _vlcRetryCount < 2) {
      _vlcRetryCount++;
      const resumeMs = posMs;
      console.warn(`[Adam VLC] false end at ${posMs}ms (track=${trackEndMs}ms) \u2014 reloading to resume at ${resumeMs}ms attempt ${_vlcRetryCount}`);
      _vlcRetryFrom(resumeMs, mkAudio, 500);
      return;
    }
    if (_allowCDNTransition) {
      console.log("[Adam VLC] ended \u2014 _adamNext suppressed (CDN gate open)");
    } else {
      console.log("[Adam VLC] ended \u2192 _adamNext");
      _adamNextRef?.().catch(() => {
      });
    }
  }
  function _vlcHandleStateChange(state, prev, posMs, mkAudio) {
    if (state === "playing") {
      _vlcPaused = false;
      _stopLyricsFreeze();
      const wasLoading = _vlcLoading;
      _vlcLoading = false;
      const fromSeek = _vlcPostSeek;
      _vlcPostSeek = false;
      if (prev !== "paused" || fromSeek || wasLoading) mkAudio.dispatchEvent(new Event("playing"));
    }
    if (state === "paused") {
      if (!_vlcPostSeek && !_vlcLoading) {
        _vlcPaused = true;
        mkAudio.dispatchEvent(new Event("pause"));
        _startLyricsFreeze(mkAudio);
      }
    }
    if (state === "error" || state === "ended" || state === "stopped" && (prev === "playing" || prev === "ended")) {
      _vlcHandleEnded(Math.max(posMs, _vlcPosMs), mkAudio, state);
    }
  }
  async function _vlcPollTick(mkAudio, mySession, generation = _vlcPollGeneration) {
    if (_vlcFetching || generation !== _vlcPollGeneration) return;
    _vlcFetching = true;
    const transportRevision = _vlcTransport.revision;
    try {
      const r = await fetch(`${ENGINE}/api/v1/vlc/time`, { signal: AbortSignal.timeout(4e3) });
      if (!r.ok) throw new Error(`VLC status: HTTP ${r.status}`);
      if (_sessionId !== mySession || generation !== _vlcPollGeneration) return;
      _vlcErrCount = 0;
      const { posMs, lengthMs, state, volume, muted } = await r.json();
      if (_sessionId !== mySession || generation !== _vlcPollGeneration || transportRevision !== _vlcTransport.revision || _vlcTransport.pending) return;
      _vlcSyncVolume?.(volume, muted);
      _vlcHandleLength(lengthMs);
      _vlcUpdatePosition(posMs, state, mkAudio);
      if (state === _vlcPrevState) return;
      const prev = _vlcPrevState;
      _vlcPrevState = state;
      console.log(`[Adam VLC] state: ${prev ?? "null"} \u2192 ${state}  posMs=${posMs}  frozen=${_vlcSeekFrozen}`);
      if (_vlcSeekFrozen) return;
      _vlcHandleStateChange(state, prev, posMs, mkAudio);
    } catch (_) {
      if (_sessionId !== mySession || generation !== _vlcPollGeneration) return;
      if (++_vlcErrCount === 5) mkAudio.dispatchEvent(new Event("waiting"));
    } finally {
      if (generation === _vlcPollGeneration) _vlcFetching = false;
    }
  }
  function startVLCPoll(mkAudio) {
    stopVLCPoll();
    _vlcPrevState = null;
    _vlcErrCount = 0;
    _vlcTickCount = 0;
    _vlcLengthSet = false;
    _vlcFetching = false;
    const mySession = _sessionId;
    const generation = _vlcPollGeneration;
    _vlcPollTimer = setInterval(() => _vlcPollTick(mkAudio, mySession, generation), T().poll);
  }
  function waitForLossless(timeoutMs) {
    if (_streamingQuality === "high-quality") return Promise.resolve();
    if (_engineCaps.lossless || _losslessWaitDone) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (_engineCaps.lossless || Date.now() >= deadline) {
          _losslessWaitDone = true;
          resolve();
        } else {
          setTimeout(tick, 100);
        }
      };
      tick();
    });
  }
  function _prewarmScheduleRetry(reason) {
    if (_nextAlacRetries >= 3) {
      console.warn(`[Adam Gapless] ${reason} \u2014 max retries reached, giving up`);
      return;
    }
    _nextAlacRetries++;
    console.log(`[Adam Gapless] ${reason} \u2014 retry ${_nextAlacRetries}/3 in 5s`);
    setTimeout(() => {
      if (_nextAlacSession || !_nextAlacTried) return;
      _nextAlacTried = false;
    }, 5e3);
  }
  function _prewarmHandlePrecache(r) {
    if (r.status === 204) console.log("[Adam Gapless] disk cache already populated \u2014 gapless ready \u2713");
    else if (r.status === 202) console.log("[Adam Gapless] disk cache download started in engine background");
    else console.warn(`[Adam Gapless] precache returned unexpected ${r.status}`);
  }
  async function _hoverPrewarmById(adamId, isVideo = false) {
    const mk = _mkInstance;
    if (!mk) return;
    if (_hoverSessions.has(adamId) || _hoverInflight.has(adamId)) return;
    _hoverInflight.add(adamId);
    try {
      const sf = mk.storefrontId ?? "us";
      const lossless = !isVideo && _engineCaps.lossless && _streamingQuality !== "high-quality";
      const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: adamId,
          storefront: sf,
          capabilities: { lossless, hiRes: lossless && _streamingQuality === "hi-res-lossless", atmos: false, video: isVideo },
          ...isVideo ? { mvMaxHeight: _mvMaxHeight } : {},
          token: mk.developerToken ?? "",
          mediaUserToken: getMUT()
        })
      });
      if (!sessResp.ok) return;
      const sess = await sessResp.json();
      if (_hoverSessions.size >= 4) {
        const oldest = _hoverSessions.keys().next().value;
        const { sess: old } = _hoverSessions.get(oldest);
        deleteSession(old.sessionId);
        _hoverSessions.delete(oldest);
      }
      _hoverSessions.set(adamId, { sess, isVideo });
      console.log(`[Adam Hover] pre-warmed ${isVideo ? "MV" : "audio"} ${adamId} \u2192 ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
    } catch (_) {
    } finally {
      _hoverInflight.delete(adamId);
    }
  }
  var HOVER_INTENT_MS = 350;
  function _installHoverPrewarm() {
    let pendingId = null, timer = null;
    const prewarmSoon = (id, isVideo = false) => {
      if (id === pendingId) return;
      clearTimeout(timer);
      pendingId = id;
      timer = setTimeout(() => {
        pendingId = null;
        _hoverPrewarmById(id, isVideo);
      }, HOVER_INTENT_MS);
    };
    document.addEventListener("pointerenter", (e) => {
      if (!_engineCaps.lossless && !_engineCaps.aac) return;
      try {
        let el2 = e.target;
        for (let depth = 0; depth < 12 && el2; depth++) {
          const did = el2.dataset?.id || el2.dataset?.contentId || el2.dataset?.songId;
          if (did) {
            const numId = did.startsWith("a.") ? did.slice(2) : did;
            if (/^\d{7,12}$/.test(numId) && numId !== _currentAssetId) {
              prewarmSoon(numId);
              return;
            }
          }
          if (el2.tagName === "A" && el2.href) {
            const m = el2.href.match(/\/(\d{7,12})(?:[/?#]|$)/);
            if (m && m[1] !== _currentAssetId) {
              const isMV = el2.href.includes("/music-video/");
              prewarmSoon(m[1], isMV);
              return;
            }
          }
          el2 = el2.parentElement;
        }
      } catch (_) {
      }
    }, { capture: true, passive: true });
  }
  async function _prewarmNextAlac() {
    const mk = _mkInstance;
    if (!mk) return;
    const items = mk.queue?.items;
    const pos = mk.queue?.position ?? -1;
    if (!items || pos < 0 || pos + 1 >= items.length) return;
    const nextItem = items[pos + 1];
    const nextAdamId = nextItem?.playParams?.catalogId ?? nextItem?.attributes?.playParams?.catalogId ?? nextItem?.id ?? nextItem?.playParams?.id ?? nextItem?.attributes?.playParams?.id;
    if (!nextAdamId) return;
    if (nextItem?.type === "music-videos" || nextItem?.type === "musicVideo" || nextItem?.type === "library-music-videos") return;
    if (!_engineCaps.lossless || _streamingQuality === "high-quality") return;
    const nextName = nextItem?.attributes?.name ?? nextAdamId;
    console.log(`[Adam Gapless] opening session for "${nextName}" (${nextAdamId}) attempt=${_nextAlacRetries + 1}`);
    const t0 = performance.now();
    try {
      const sf = mk.storefrontId ?? "us";
      const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: nextAdamId,
          storefront: sf,
          capabilities: { lossless: true, hiRes: _streamingQuality === "hi-res-lossless", atmos: false, video: false },
          token: mk.developerToken ?? "",
          mediaUserToken: getMUT()
        })
      });
      if (!sessResp.ok) {
        const permanent = sessResp.status === 401 || sessResp.status === 403 || sessResp.status === 404;
        if (permanent) {
          console.warn(`[Adam Gapless] session open failed ${sessResp.status} (permanent) \u2014 will not retry`);
        } else {
          _prewarmScheduleRetry(`session open failed ${sessResp.status}`);
        }
        return;
      }
      const sess = await sessResp.json();
      const elapsed = ((performance.now() - t0) / 1e3).toFixed(2);
      if (sess.codec !== "alac") {
        console.log(`[Adam Gapless] skipped \u2014 engine returned ${sess.codec} (not lossless) in ${elapsed}s \u2014 will not retry`);
        deleteSession(sess.sessionId);
        return;
      }
      _nextAlacSession = { adamId: nextAdamId, sess };
      console.log(`[Adam Gapless] session ready ${sess.sessionId} dur=${(sess.durationMs / 1e3).toFixed(1)}s in ${elapsed}s \u2014 kicking off disk cache download`);
      fetch(`${ENGINE}/api/v1/playback/${sess.sessionId}/precache`, { method: "POST" }).then(_prewarmHandlePrecache).catch(() => console.warn("[Adam Gapless] precache request failed \u2014 VLC will download on first play"));
    } catch (e) {
      _prewarmScheduleRetry(`pre-warm error: ${e?.message}`);
    }
  }
  async function _fetchAudioAnalysis(adamId, sf) {
    try {
      const params = new URLSearchParams({ sf: sf || "us" });
      const r = await fetch(`${ENGINE}/api/v1/audioanalysis/${encodeURIComponent(adamId)}?${params}`);
      if (!r.ok || r.status === 204) return;
      const data = await r.json();
      if (_currentAssetId === adamId) {
        _audioAnalysis = data;
        console.log(`[Adam AA] ${adamId} fadeOut=${data.fadeOut?.startMs}\u2013${data.fadeOut?.endMs}ms bpm=${data.bpm || "?"}`);
      }
    } catch {
    }
  }
  async function _prewarmNextAac() {
    const mk = _mkInstance;
    if (!mk) return;
    const items = mk.queue?.items;
    const pos = mk.queue?.position ?? -1;
    if (!items || pos < 0 || pos + 1 >= items.length) return;
    const nextItem = items[pos + 1];
    const nextAdamId = nextItem?.playParams?.catalogId ?? nextItem?.attributes?.playParams?.catalogId ?? nextItem?.id ?? nextItem?.playParams?.id ?? nextItem?.attributes?.playParams?.id;
    if (!nextAdamId) return;
    if (nextItem?.type === "music-videos" || nextItem?.type === "musicVideo" || nextItem?.type === "library-music-videos") return;
    if (_engineCaps.lossless && _streamingQuality !== "high-quality") return;
    const nextName = nextItem?.attributes?.name ?? nextAdamId;
    console.log(`[Adam Gapless AAC] opening session for "${nextName}" (${nextAdamId})`);
    const t0 = performance.now();
    try {
      const sf = mk.storefrontId ?? "us";
      const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: nextAdamId,
          storefront: sf,
          capabilities: { lossless: false, atmos: false, video: false },
          token: mk.developerToken ?? "",
          mediaUserToken: getMUT()
        })
      });
      if (!sessResp.ok) return;
      const sess = await sessResp.json();
      const elapsed = ((performance.now() - t0) / 1e3).toFixed(2);
      _nextAacSession = { adamId: nextAdamId, sess };
      console.log(`[Adam Gapless AAC] session ready ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s in ${elapsed}s`);
    } catch (e) {
      console.warn(`[Adam Gapless AAC] pre-warm error: ${e?.message}`);
    }
  }
  async function _prewarmNextMv() {
    const mk = _mkInstance;
    if (!mk) return;
    const items = mk.queue?.items;
    const pos = mk.queue?.position ?? -1;
    if (!items || pos < 0 || pos + 1 >= items.length) return;
    const nextItem = items[pos + 1];
    if (!isVideoType(nextItem?.type)) return;
    const nextAdamId = nextItem?.playParams?.catalogId ?? nextItem?.attributes?.playParams?.catalogId ?? nextItem?.id ?? nextItem?.playParams?.id ?? nextItem?.attributes?.playParams?.id;
    if (!nextAdamId) return;
    const nextName = nextItem?.attributes?.name ?? nextAdamId;
    console.log(`[Adam Gapless MV] opening session for "${nextName}" (${nextAdamId})`);
    const t0 = performance.now();
    try {
      const sf = mk.storefrontId ?? "us";
      const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: nextAdamId,
          storefront: sf,
          capabilities: { lossless: false, atmos: false, video: true },
          mvMaxHeight: _mvMaxHeight,
          token: mk.developerToken ?? "",
          mediaUserToken: getMUT()
        })
      });
      if (!sessResp.ok) return;
      const sess = await sessResp.json();
      const elapsed = ((performance.now() - t0) / 1e3).toFixed(2);
      _nextMvSession = { adamId: nextAdamId, sess };
      console.log(`[Adam Gapless MV] session ready ${sess.sessionId} dur=${(sess.durationMs / 1e3).toFixed(1)}s in ${elapsed}s`);
    } catch (e) {
      console.warn(`[Adam Gapless MV] pre-warm error: ${e?.message}`);
    }
  }
  function _discardNextAacStream() {
    if (!_nextAacStreamResp) return;
    try {
      _nextAacStreamResp.ctrl.abort();
    } catch (_) {
    }
    try {
      _nextAacStreamResp.resp?.body?.cancel();
    } catch (_) {
    }
    _nextAacStreamResp = null;
  }
  function _prefetchNextAacStream() {
    if (!_nextAacSession || _nextAacStreamResp) return;
    const sess = _nextAacSession.sess;
    if (!sess?.sessionId || sess.codec !== "aac") return;
    const audioPath = sess.streams?.audio ?? `/api/v1/playback/${sess.sessionId}/audio`;
    const streamBase = `${ENGINE}${audioPath}?raw=1`;
    const ctrl = new AbortController();
    fetch(streamBase, { signal: ctrl.signal }).then((resp) => {
      if (!resp.ok) {
        resp.body?.cancel();
        return;
      }
      if (ctrl.signal.aborted) {
        resp.body?.cancel();
        return;
      }
      _nextAacStreamResp = { sessionId: sess.sessionId, resp, ctrl };
      console.log(`[Adam Gapless AAC] stream pre-opened for ${sess.sessionId} \u2014 TTFB paid`);
    }).catch(() => {
    });
  }
  async function _handleNullNPIDF(mk) {
    const tmpAudio = getMKAudio();
    if (tmpAudio) {
      try {
        delete tmpAudio.load;
      } catch (_) {
      }
    }
    if (_allowCDNTransition) {
      console.log("[NPIDF] null-item with CDN gate open \u2014 waiting for real NPIDF");
      return null;
    }
    console.log("[NPIDF] null-item (station/queue transition) \u2014 load() shadow cleared, waiting for real NPIDF");
    const genSnapshot = _generation;
    await new Promise((r) => setTimeout(r, 200));
    if (_generation !== genSnapshot) return null;
    return mk.nowPlayingItem;
  }
  function _closeCDNGate(mk) {
    if (!_allowCDNTransition) return;
    _allowCDNTransition = false;
    if (_externalPlayGateTimer) {
      clearTimeout(_externalPlayGateTimer);
      _externalPlayGateTimer = null;
    }
    if (_mkApiSaved) {
      mk.play = _mkApiSaved.play;
      mk.setQueue = _mkApiSaved.setQueue;
      mk.changeToMediaAtIndex = _mkApiSaved.changeToMediaAtIndex;
      _mkApiSaved = null;
    }
    if (_savedAacApiRestore) {
      _savedAacApiRestore();
      _savedAacApiRestore = null;
    }
    if (_savedGateTracingCleanup) {
      _savedGateTracingCleanup();
      _savedGateTracingCleanup = null;
    }
    _pendingExternalClickCatalogId = null;
    _pendingExternalClickQueueIdx = -1;
    _pendingPlaylistFetch = null;
  }
  function _resetPlaybackState() {
    setPlayState(PLAY_STATE.IDLE, "reset");
    if (_pipeCtrl) {
      _pipeCtrl.abort();
      _pipeCtrl = null;
    }
    if (_abortCtrl) {
      _abortCtrl.abort();
      _abortCtrl = null;
    }
    _ourBlobUrl = null;
    if (_streamComplete && _activeMs?.readyState === "ended") {
      _prevMs = _activeMs;
      _prevSb = _activeSb;
    } else {
      _prevMs = null;
      _prevSb = null;
    }
    _activeSb = null;
    _activeMs = null;
    _activeStreamBase = "";
    _seekable = false;
    _seekTarget = -Infinity;
    _ourSeekPending = false;
    _ourSeekTarget = -Infinity;
    _streamComplete = false;
    _chunkCache = null;
    _msePaused = false;
    if (_seekFetchCtrl) {
      _seekFetchCtrl.abort();
      _seekFetchCtrl = null;
    }
    _vlcMode = false;
    window._adamVlcMode = false;
    _syncVLCControls();
    _vlcPosMs = 0;
    _vlcPaused = false;
    _stopLyricsFreeze();
    _vlcSeekFrozen = false;
    _vlcRetryCount = 0;
    _vlcSeekOffsetMs = 0;
    _vlcPrevState = null;
    _vlcLoading = false;
    _seekBurstLog = 0;
    _vlcPostSeek = false;
    _vlcWasPlaying = false;
    _vlcSeekTargetMs = 0;
    _vlcSyncVolume = null;
    _scVlcReapply = null;
    _nextAlacTried = false;
    _nextAlacRetries = 0;
    _audioAnalysis = null;
    _nextAacTried = false;
    _nextMvTried = false;
    if (_vlcSeekTimer) {
      clearTimeout(_vlcSeekTimer);
      _vlcSeekTimer = null;
    }
    stopVLCPoll();
    unbridgeDuration();
    deleteSession(_sessionId);
    _sessionId = null;
    _currentAssetId = null;
    _durationSec = 0;
    showQualityBadge(null);
  }
  async function _resolveSession(item, adamId, sf, mk) {
    const isVideo = isVideoType(item.type);
    if (adamId) _itemTypes.set(adamId, isVideo ? "music-videos" : "songs");
    const losslessWanted = _engineCaps.lossless && _streamingQuality !== "high-quality";
    if (!isVideo && losslessWanted && _nextAlacSession?.adamId === adamId) {
      const sess = _nextAlacSession.sess;
      _nextAlacSession = null;
      console.log(`[Adam Gapless] \u2713 HIT \u2014 using pre-warmed ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s (saved ~2\u20135s webplayback+CDN)`);
      return sess;
    }
    if (!isVideo && !losslessWanted && _nextAacSession?.adamId === adamId) {
      const sess = _nextAacSession.sess;
      _nextAacSession = null;
      console.log(`[Adam Gapless AAC] \u2713 HIT \u2014 using pre-warmed ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
      return sess;
    }
    if (isVideo && _nextMvSession?.adamId === adamId) {
      const sess = _nextMvSession.sess;
      _nextMvSession = null;
      console.log(`[Adam Gapless MV] \u2713 HIT \u2014 using pre-warmed ${sess.sessionId} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
      return sess;
    }
    if (_hoverSessions.has(adamId)) {
      const entry = _hoverSessions.get(adamId);
      if (entry.isVideo === isVideo) {
        _hoverSessions.delete(adamId);
        console.log(`[Adam Hover] \u2713 HIT \u2014 using hover pre-warmed ${isVideo ? "MV" : "audio"} ${entry.sess.sessionId} codec=${entry.sess.codec} dur=${(entry.sess.durationMs / 1e3).toFixed(1)}s`);
        return entry.sess;
      }
    }
    const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: adamId,
        storefront: sf,
        capabilities: {
          lossless: losslessWanted,
          hiRes: losslessWanted && _streamingQuality === "hi-res-lossless",
          atmos: false,
          video: isVideo
        },
        mvMaxHeight: _mvMaxHeight,
        token: mk.developerToken ?? "",
        mediaUserToken: getMUT()
      })
    });
    if (!sessResp.ok) throw new Error(`Session ${sessResp.status}: ${await sessResp.text()}`);
    return sessResp.json();
  }
  async function _mseRecoverPipe(err, sb, mkAudio, ms, myStreamBase, pipeCtrl, durationSec, t0) {
    if (pipeCtrl.signal.aborted) return;
    const bufEnd = sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : 0;
    console.warn("[Adam MSE] pipe error \u2014 recovering from", bufEnd.toFixed(1) + "s:", err.message);
    if (ms.readyState === "closed") {
      console.error("[Adam MSE] ms=closed, no recovery");
      return;
    }
    if (ms.readyState === "ended") console.warn("[Adam MSE] ms=ended (Chrome decode-error path) \u2014 attempting resume");
    try {
      const resumeUrl = bufEnd > 1 ? `${myStreamBase}&t=${bufEnd.toFixed(3)}` : myStreamBase;
      const resp = await fetch(resumeUrl, { signal: pipeCtrl.signal });
      if (!resp.ok || pipeCtrl.signal.aborted) {
        resp?.body?.cancel();
        return;
      }
      await pipeToSourceBuffer(sb, mkAudio, resp, pipeCtrl.signal, ms, durationSec, t0);
    } catch (e2) {
      if (!pipeCtrl.signal.aborted) {
        console.error("[Adam MSE] recovery failed:", e2.message);
        if (ms.readyState === "open") try {
          ms.endOfStream();
        } catch (_) {
        }
      }
    }
  }
  async function _setupMSEPath(mkAudio, sess, mk, ctrl, t0) {
    _seekable = sess.capabilities?.seekable ?? false;
    _chunkCache = { sessionId: _sessionId, chunks: [], byteSize: 0 };
    const audioPath = sess.streams?.audio ?? `/api/v1/playback/${_sessionId}/audio`;
    const streamBase = `${ENGINE}${audioPath}?raw=1`;
    _activeStreamBase = streamBase;
    const ms = new MediaSource();
    const blobUrl = URL.createObjectURL(ms);
    _ourBlobUrl = blobUrl;
    _prevMs = null;
    _prevSb = null;
    _nativeSrcSet.call(mkAudio, blobUrl);
    delete mkAudio.load;
    HTMLMediaElement.prototype.load.call(mkAudio);
    mkAudio.load = () => {
    };
    await new Promise((resolve, reject) => {
      ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      ms.addEventListener("sourceopen", resolve, { once: true });
    });
    URL.revokeObjectURL(blobUrl);
    if (_durationSec > 0) {
      try {
        ms.duration = _durationSec;
      } catch (_) {
      }
    }
    const sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    sb.addEventListener("error", () => {
      console.error("[Adam MSE] SourceBuffer error \u2014 audio.error=" + (mkAudio.error ? mkAudio.error.code + " " + mkAudio.error.message : "none") + " src=" + (mkAudio.currentSrc ? mkAudio.currentSrc.slice(0, 24) : "(empty)") + " ms=" + ms.readyState + " updating=" + sb.updating + " buf=" + (sb.buffered.length > 0 ? sb.buffered.start(0).toFixed(1) + "-" + sb.buffered.end(sb.buffered.length - 1).toFixed(1) + "s" : "empty"));
    });
    _activeSb = sb;
    _activeMs = ms;
    const _nativeMSEPause = HTMLMediaElement.prototype.pause.bind(mkAudio);
    _msePaused = false;
    Object.defineProperty(mkAudio, "paused", {
      get: () => _msePaused,
      configurable: true
    });
    mkAudio.pause = () => {
      _msePaused = true;
      _nativeMSEPause();
    };
    mkAudio.addEventListener("loadedmetadata", function onMeta() {
      try {
        if (sb.buffered.length > 0 && sb.buffered.start(0) > mkAudio.currentTime + 0.1)
          mkAudio.currentTime = sb.buffered.start(0);
        else if (sb.buffered.length === 0)
          sb.addEventListener("updateend", () => {
            try {
              if (sb.buffered.length > 0 && sb.buffered.start(0) > mkAudio.currentTime + 0.1) mkAudio.currentTime = sb.buffered.start(0);
            } catch (_) {
            }
          }, { once: true });
      } catch (_) {
      }
    }, { once: true });
    _pipeCtrl = new AbortController();
    const pipeCtrl = _pipeCtrl;
    const myStreamBase = streamBase;
    let pipeInput = streamBase;
    if (_nextAacStreamResp?.sessionId === _sessionId) {
      pipeInput = _nextAacStreamResp.resp;
      _nextAacStreamResp = null;
      console.log(`[Adam Gapless AAC] \u2713 stream HIT \u2014 using pre-opened response for ${_sessionId}`);
    } else if (_nextAacStreamResp) {
      _discardNextAacStream();
    }
    pipeToSourceBuffer(sb, mkAudio, pipeInput, pipeCtrl.signal, ms, _durationSec, t0).catch((err) => _mseRecoverPipe(err, sb, mkAudio, ms, myStreamBase, pipeCtrl, _durationSec, t0));
    const onXfVol = () => _xfTrackUserVolume(mkAudio);
    mkAudio.addEventListener("volumechange", onXfVol);
    ctrl.signal.addEventListener(
      "abort",
      () => mkAudio.removeEventListener("volumechange", onXfVol),
      { once: true }
    );
    _xfFadeIn(mkAudio);
    let _gaplessArmed = false, _xfFadedOut = false;
    const onGaplessTick = () => {
      if (ctrl.signal.aborted || _durationSec <= 0) return;
      const remaining = _durationSec - mkAudio.currentTime;
      const analysisLeadSec = _audioAnalysis?.fadeOut ? Math.max(GAPLESS_STREAM_LEAD, (_durationSec * 1e3 - _audioAnalysis.fadeOut.startMs) / 1e3) : GAPLESS_STREAM_LEAD;
      if (!_gaplessArmed && remaining <= analysisLeadSec) {
        _gaplessArmed = true;
        _prefetchNextAacStream();
        if (_crossfadeMode === "adaptive") _xfPlanAdaptive();
      }
      const analysisCrossfadeSec = _audioAnalysis?.fadeOut ? Math.max(1, (_audioAnalysis.fadeOut.endMs - _audioAnalysis.fadeOut.startMs) / 1e3) : null;
      const effectiveCrossfadeSec = analysisCrossfadeSec ?? _crossfadeSec;
      if (!_xfFadedOut && effectiveCrossfadeSec > 0 && remaining <= effectiveCrossfadeSec) {
        const d = _xfDecision();
        if (d === "fade") {
          if (analysisCrossfadeSec != null) {
            _xfFadedOut = true;
            _xfFadeOut(mkAudio, remaining, analysisCrossfadeSec);
          } else if (_crossfadeMode === "adaptive") {
            const dur = _xfPlanSession === _sessionId && _xfPlannedSec != null ? _xfPlannedSec : _xfAdaptiveDuration();
            if (remaining <= dur) {
              _xfFadedOut = true;
              _xfFadeOut(mkAudio, remaining, dur);
            }
          } else {
            _xfFadedOut = true;
            _xfFadeOut(mkAudio, remaining);
          }
        } else if (d === "skip-gapless") {
          _xfFadedOut = true;
          _xfSkipNextFadeIn = true;
        } else if (d === "skip") {
          _xfFadedOut = true;
        }
      }
      if (_gaplessArmed && (_xfFadedOut || effectiveCrossfadeSec <= 0)) {
        mkAudio.removeEventListener("timeupdate", onGaplessTick);
      }
    };
    mkAudio.addEventListener("timeupdate", onGaplessTick);
    ctrl.signal.addEventListener(
      "abort",
      () => mkAudio.removeEventListener("timeupdate", onGaplessTick),
      { once: true }
    );
    const onSeeking = () => {
      if (ctrl.signal.aborted) return;
      if (!_ourSeekPending) return;
      _ourSeekPending = false;
      mseSeekToTime(_ourSeekTarget, mkAudio, sb, ms);
    };
    const tryPlay = () => {
      if (ctrl.signal.aborted) return;
      mkAudio.addEventListener("seeking", onSeeking);
      if (_ourSeekPending) {
        _ourSeekPending = false;
        mseSeekToTime(_ourSeekTarget, mkAudio, sb, ms);
        return;
      }
      _nativePlay().catch((e) => console.warn("[Adam MSE] play():", e));
    };
    if (mkAudio.readyState >= 3) tryPlay();
    else mkAudio.addEventListener("canplay", tryPlay, { once: true });
    const onAACEnded = () => {
      if (ctrl.signal.aborted) return;
      if (_allowCDNTransition) {
        console.log("[Adam MSE] ended \u2014 _adamNext suppressed (CDN gate open)");
        return;
      }
      console.log("[Adam MSE] audio ended \u2192 _adamNext");
      _adamNextRef?.().catch(() => {
      });
    };
    mkAudio.addEventListener("ended", onAACEnded);
    ctrl.signal.addEventListener("abort", () => {
      mkAudio.removeEventListener("seeking", onSeeking);
      mkAudio.removeEventListener("canplay", tryPlay);
      mkAudio.removeEventListener("ended", onAACEnded);
      delete mkAudio.paused;
      delete mkAudio.pause;
      _msePaused = false;
      unbridgeDuration();
    }, { once: true });
    console.log(`[Adam MSE] AAC stream open +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
  }
  async function _setupVLCPath(mkAudio, sess, adamId, ctrl, t0) {
    _vlcTransport.reset(false);
    _vlcMode = true;
    window._adamVlcMode = true;
    _syncVLCControls();
    _allowCDNTransition = false;
    const _silentMs = new MediaSource();
    const _silentUrl = URL.createObjectURL(_silentMs);
    _prevMs = null;
    _prevSb = null;
    _nativeSrcSet.call(mkAudio, _silentUrl);
    delete mkAudio.load;
    HTMLMediaElement.prototype.load.call(mkAudio);
    mkAudio.load = () => {
    };
    _vlcPaused = false;
    _syncVLCControls();
    Object.defineProperty(mkAudio, "paused", {
      get: () => _vlcPaused,
      configurable: true
    });
    _vlcPosMs = 0;
    Object.defineProperty(mkAudio, "currentTime", {
      get: () => _vlcPosMs / 1e3,
      set: () => {
      },
      configurable: true
    });
    let _vlcVolume = _vlcVolPersist;
    let _vlcMuted = false;
    let _vlcPreMuteVol = _vlcVolume;
    let _vlcVolSetting = false;
    let _vlcVolPostedAt = 0;
    const _postVlcVol = (vol) => (_vlcVolPostedAt = performance.now(), fetch(`${ENGINE}/api/v1/vlc/volume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume: Math.round(vol * _scFactor) })
    }).catch(() => {
    }));
    _scVlcReapply = () => _postVlcVol(_vlcMuted ? 0 : _vlcVolume);
    const _dispatchVolChange = () => {
      if (_vlcVolSetting) return;
      _vlcVolSetting = true;
      try {
        mkAudio.dispatchEvent(new Event("volumechange"));
      } finally {
        _vlcVolSetting = false;
      }
    };
    _vlcSyncVolume = (volume, muted) => {
      if (!Number.isFinite(volume)) return;
      if (performance.now() - _vlcVolPostedAt < 1500) return;
      if (Math.round(_vlcVolume * _scFactor) === volume && _vlcMuted === !!muted) return;
      const requested = Math.round(volume / (_scFactor || 1));
      _vlcVolume = requested;
      _rememberVlcVolume(requested);
      _vlcMuted = !!muted;
      _dispatchVolChange();
    };
    Object.defineProperty(mkAudio, "volume", {
      get: () => _vlcVolume / 100,
      set: (v) => {
        if (_vlcVolSetting) return;
        const newVol = Math.max(0, Math.min(200, Math.round(v * 100)));
        if (newVol === _vlcVolume) return;
        _vlcVolume = newVol;
        _rememberVlcVolume(newVol);
        if (_vlcVolume > 0) _vlcMuted = false;
        _postVlcVol(_vlcMuted ? 0 : _vlcVolume);
        _dispatchVolChange();
      },
      configurable: true
    });
    Object.defineProperty(mkAudio, "muted", {
      get: () => _vlcMuted,
      set: (v) => {
        _vlcMuted = !!v;
        if (_vlcMuted) {
          _vlcPreMuteVol = _vlcVolume || 100;
          _postVlcVol(0);
        } else {
          _vlcVolume = _vlcPreMuteVol;
          _rememberVlcVolume(_vlcVolume);
          _postVlcVol(_vlcVolume);
        }
        _dispatchVolChange();
      },
      configurable: true
    });
    mkAudio.pause = () => {
      if (_vlcTransport.desired !== true) return;
      console.log(`[Adam VLC] pause() \u2192 pause`);
      _vlcPaused = true;
      mkAudio.dispatchEvent(new Event("pause"));
      _startLyricsFreeze(mkAudio);
    };
    _vlcLoading = true;
    const vlcResp = await fetch(`${ENGINE}/api/v1/vlc/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: _sessionId, assetId: adamId, startMs: 0 }),
      signal: ctrl.signal
    });
    if (!vlcResp.ok) throw new Error(`VLC load: ${await vlcResp.text()}`);
    _postVlcVol(_vlcVolume);
    if (ctrl.signal.aborted) return;
    mkAudio.addEventListener("canplay", () => {
      if (!ctrl.signal.aborted) {
        _vlcPaused = false;
        mkAudio.dispatchEvent(new Event("playing"));
        if (_vlcLoading) mkAudio.dispatchEvent(new Event("waiting"));
      }
    }, { once: true });
    mkAudio.dispatchEvent(new Event("canplay"));
    if (_pendingVLCIntent !== null) {
      const paused = _pendingVLCIntent;
      _pendingVLCIntent = null;
      await _requestVLCTransport(paused);
      if (paused) mkAudio.dispatchEvent(new Event("pause"));
    }
    startVLCPoll(mkAudio);
    console.log(`[Adam Engine] VLC playing +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
    ctrl.signal.addEventListener("abort", () => {
      unbridgeDuration();
      stopVLCPoll();
      _stopLyricsFreeze();
      _vlcLoading = false;
      URL.revokeObjectURL(_silentUrl);
      delete mkAudio.paused;
      delete mkAudio.currentTime;
      delete mkAudio.volume;
      delete mkAudio.muted;
      delete mkAudio.pause;
      _vlcPaused = false;
    }, { once: true });
  }
  async function _triggerDirectPlay(adamId, mk) {
    if (!adamId) return;
    if (_isVideoId(adamId)) {
      console.log(`[Adam DirectPlay] skip ${adamId} \u2014 music video, deferring to NPIDF path`);
      return;
    }
    const mkAudio = getMKAudio();
    if (!mkAudio) return;
    const myGen = ++_generation;
    _directPlayGen = myGen;
    _directPlayAdamId = adamId;
    _resetPlaybackState();
    setPlayState(PLAY_STATE.OPENING, `direct:${adamId}`);
    if (!mkAudio.paused && !mkAudio.ended) mkAudio.pause();
    _msePaused = false;
    installPlayProxy(mkAudio);
    const sf = mk.storefrontId ?? "us";
    const t0 = performance.now();
    console.log(`[Adam DirectPlay] \u2192 ${adamId} (pre-NPIDF fast path)`);
    await waitForLossless(T().losslessWait);
    if (genStale(myGen)) return;
    try {
      const losslessWanted = _engineCaps.lossless && _streamingQuality !== "high-quality";
      const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: adamId,
          storefront: sf,
          capabilities: { lossless: losslessWanted, hiRes: losslessWanted && _streamingQuality === "hi-res-lossless", atmos: false, video: false },
          mvMaxHeight: _mvMaxHeight,
          token: mk.developerToken ?? "",
          mediaUserToken: getMUT()
        })
      });
      if (genStale(myGen)) return;
      if (!sessResp.ok) {
        console.error("[Adam DirectPlay] Session error:", sessResp.status);
        _directPlayAdamId = null;
        setPlayState(PLAY_STATE.IDLE, "direct:session-error");
        return;
      }
      const sess = await sessResp.json();
      if (genStale(myGen)) return;
      if (sess.capabilities?.video || sess.codec !== "aac") {
        _directPlayAdamId = null;
        deleteSession(sess.sessionId);
        setPlayState(PLAY_STATE.IDLE, "direct:codec-fallback");
        if (_htcSkippedItem) {
          const pendingItem = _htcSkippedItem;
          _htcSkippedItem = null;
          const pendingId = pendingItem?.playParams?.catalogId ?? pendingItem?.attributes?.playParams?.catalogId ?? pendingItem?.id;
          if (pendingId === adamId) handleTrackChange(pendingItem);
        }
        return;
      }
      _sessionId = sess.sessionId;
      _directPlayAdamId = null;
      _durationSec = (sess.durationMs ?? 0) / 1e3;
      _currentAssetId = adamId;
      _videoCodec = null;
      _mvVideoHeights = [];
      console.log(`[Adam DirectPlay] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth, sess.spatialAudio);
      bridgeDuration(mk, _durationSec);
      _slInitForTrack(adamId);
      _broadcastNowPlaying();
      _allowCDNTransition = false;
      setPlayState(PLAY_STATE.CDN_SETTLING, `direct:${adamId}`);
      _abortCtrl = new AbortController();
      setPlayState(PLAY_STATE.STREAMING, `direct:${adamId}`);
      await _setupMSEPath(mkAudio, sess, mk, _abortCtrl, t0);
      if (!genStale(myGen)) {
        setPlayState(PLAY_STATE.COMPLETE, `direct:${adamId}`);
        _directPlayAdamId = null;
        if (!_nextAacTried && !_nextAacSession) {
          _nextAacTried = true;
          _prewarmNextAac().catch(() => {
          });
        }
        if (!_nextMvTried && !_nextMvSession) {
          _nextMvTried = true;
          _prewarmNextMv().catch(() => {
          });
        }
      }
    } catch (err) {
      if (!genStale(myGen)) {
        console.error("[Adam DirectPlay] Error:", err);
        _directPlayAdamId = null;
        setPlayState(PLAY_STATE.IDLE, "direct:error");
      }
    }
  }
  function _htcConfirmDirectPlay(htcAdamId) {
    if (!_directPlayAdamId || _directPlayAdamId !== htcAdamId || _directPlayGen !== _generation) return false;
    _directPlayGen = 0;
    _currentAssetId = htcAdamId;
    if (_savedAacApiRestore) {
      _savedAacApiRestore();
      _savedAacApiRestore = null;
    }
    if (_savedGateTracingCleanup) {
      _savedGateTracingCleanup();
      _savedGateTracingCleanup = null;
    }
    if (_externalPlayGateTimer) {
      clearTimeout(_externalPlayGateTimer);
      _externalPlayGateTimer = null;
    }
    console.log(`[Adam Engine] NPIDF confirmed \u2014 direct play in progress/active for ${htcAdamId}, skipping re-open`);
    return true;
  }
  function _htcDiscardStalePrewarms(adamId) {
    if (_nextAlacSession && _nextAlacSession.adamId !== adamId) {
      console.log(`[Adam Gapless] MISS \u2014 pre-warm was for ${_nextAlacSession.adamId}, playing ${adamId} \u2014 discarding`);
      deleteSession(_nextAlacSession.sess.sessionId);
      _nextAlacSession = null;
    }
    if (_nextAacSession && _nextAacSession.adamId !== adamId) {
      deleteSession(_nextAacSession.sess.sessionId);
      _nextAacSession = null;
      _discardNextAacStream();
    }
    if (_nextMvSession && _nextMvSession.adamId !== adamId) {
      console.log(`[Adam Gapless MV] MISS \u2014 pre-warm was for ${_nextMvSession.adamId}, playing ${adamId} \u2014 discarding`);
      deleteSession(_nextMvSession.sess.sessionId);
      _nextMvSession = null;
    }
  }
  async function handleTrackChange(mk) {
    let item = mk.nowPlayingItem;
    if (!item) {
      item = await _handleNullNPIDF(mk);
      if (!item) return;
    }
    _closeCDNGate(mk);
    const _htcAdamId = item.playParams?.catalogId ?? item.attributes?.playParams?.catalogId ?? item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
    if (_htcConfirmDirectPlay(_htcAdamId)) {
      _htcSkippedItem = item;
      return;
    }
    _htcSkippedItem = null;
    _directPlayAdamId = null;
    _directPlayGen = 0;
    const myGen = ++_generation;
    _resetPlaybackState();
    setPlayState(PLAY_STATE.OPENING, `htc:${_htcAdamId ?? "?"}`);
    const adamId = item.playParams?.catalogId ?? item.attributes?.playParams?.catalogId ?? item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
    const sf = mk.storefrontId ?? "us";
    if (!adamId) {
      console.warn("[Adam Engine] No Adam ID");
      return;
    }
    _currentAssetId = adamId;
    _slInitForTrack(adamId);
    _htcDiscardStalePrewarms(adamId);
    const t0 = performance.now();
    console.log(`[Adam Engine] \u2192 ${item.attributes?.name ?? adamId} (id=${adamId} sf=${sf})`);
    const mkAudio = getMKAudio();
    if (mkAudio) {
      if (!mkAudio.paused && !mkAudio.ended) mkAudio.pause();
      mkAudio.load = () => {
      };
      installPlayProxy(mkAudio);
    }
    await waitForLossless(T().losslessWait);
    if (genStale(myGen)) return;
    try {
      const sess = await _resolveSession(item, adamId, sf, mk);
      if (genStale(myGen)) {
        queueMicrotask(() => {
          if (_sessionId === sess.sessionId) return;
          if (_sessionId !== null) {
            deleteSession(sess.sessionId);
            return;
          }
          setTimeout(() => {
            if (_sessionId !== sess.sessionId) deleteSession(sess.sessionId);
          }, 5e3);
        });
        return;
      }
      _sessionId = sess.sessionId;
      _durationSec = (sess.durationMs ?? 0) / 1e3;
      _videoCodec = sess.capabilities?.videoCodec || null;
      _mvVideoHeights = sess.videoHeights ?? [];
      _audioAnalysis = null;
      console.log(`[Adam Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      {
        const left = await leaveLossless({
          live: _vlcLive,
          nextMode: playbackMode(sess),
          stop: () => fetch(`${ENGINE}/api/v1/vlc/stop`, { method: "POST" })
        });
        if (left.stopped) {
          if (left.ok) _vlcLive = false;
          else console.warn("[Adam Handoff] libvlc stop did not complete; continuing");
          if (genStale(myGen)) return;
        }
      }
      showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth, sess.spatialAudio);
      _broadcastNowPlaying();
      _abortCtrl = new AbortController();
      const ctrl = _abortCtrl;
      if (sess.capabilities?.video) {
        bridgeDuration(mk, _durationSec);
        setPlayState(PLAY_STATE.STREAMING, `htc:mv:${adamId}`);
        await startMVPipeline();
        return;
      }
      if (!mkAudio) throw new Error("MK audio element not found");
      bridgeDuration(mk, _durationSec);
      if (sess.codec === "aac") {
        _fetchAudioAnalysis(adamId, sf).catch(() => {
        });
        if (!_nextAacTried && !_nextAacSession) {
          _nextAacTried = true;
          _prewarmNextAac().catch(() => {
          });
        }
        if (!_nextMvTried && !_nextMvSession) {
          _nextMvTried = true;
          _prewarmNextMv().catch(() => {
          });
        }
        setPlayState(PLAY_STATE.STREAMING, `htc:aac:${adamId}`);
        await _setupMSEPath(mkAudio, sess, mk, ctrl, t0);
      } else {
        _vlcLive = true;
        setPlayState(PLAY_STATE.STREAMING, `htc:alac:${adamId}`);
        await _setupVLCPath(mkAudio, sess, adamId, ctrl, t0);
      }
    } catch (err) {
      if (!_abortCtrl?.signal.aborted) {
        const mk2 = window.MusicKit?.getInstance?.();
        console.error(
          "[Adam Engine] Playback error:",
          err,
          "\n  adamId=",
          _currentAssetId,
          "gen=",
          myGen,
          "currentGen=",
          _generation,
          "\n  mk.state=",
          mk2?.playbackState,
          "mk.item=",
          mk2?.nowPlayingItem?.id ?? "null"
        );
      }
      if (mkAudio) delete mkAudio.load;
      setPlayState(PLAY_STATE.IDLE, "htc:error");
    }
  }
  var _HIST_KEY = "adam_play_history";
  var _HIST_MAX = 50;
  var _queueHistory = [];
  async function _histLoadAsync() {
    try {
      const raw = await window.adamBridge?.storeRead(_HIST_KEY);
      if (raw) {
        _queueHistory = JSON.parse(raw);
        return;
      }
    } catch (_) {
    }
    try {
      const legacy = localStorage.getItem(_HIST_KEY);
      if (legacy) {
        _queueHistory = JSON.parse(legacy);
        await window.adamBridge?.storeWrite(_HIST_KEY, legacy);
        localStorage.removeItem(_HIST_KEY);
      }
    } catch (_) {
    }
  }
  async function _histSaveAsync() {
    try {
      await window.adamBridge?.storeWrite(_HIST_KEY, JSON.stringify(_queueHistory));
    } catch (_) {
    }
  }
  function _histArtUrl(artwork, size = 48) {
    if (!artwork?.url) return null;
    return artwork.url.replace("{w}", size).replace("{h}", size);
  }
  function _histEscape(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function _histFmtDur(ms) {
    if (!ms) return "";
    const s = Math.round(ms / 1e3);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function _histPush(item) {
    if (!item) return;
    const entry = {
      name: item.attributes?.name || "",
      artist: item.attributes?.artistName || "",
      artworkUrl: _histArtUrl(item.attributes?.artwork),
      duration: _histFmtDur(item.attributes?.durationInMillis),
      id: item.id,
      catalogId: item.playParams?.catalogId || item.attributes?.playParams?.catalogId || item.id,
      ts: Date.now()
    };
    if (!entry.name || _queueHistory[0]?.id === entry.id) return;
    _queueHistory.unshift(entry);
    if (_queueHistory.length > _HIST_MAX) _queueHistory.length = _HIST_MAX;
    _histSaveAsync();
    _histRender();
  }
  function _histClear() {
    _queueHistory = [];
    window.adamBridge?.storeDelete(_HIST_KEY).catch(() => {
    });
    _histRender();
  }
  var _RESUME_KEY = "adam_resume_state";
  var _RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
  var _resumeEnabled = true;
  var _resumeState = null;
  var _resumeDirty = false;
  var _resumeFlushTimer = null;
  function _resumeCurrentPositionSec() {
    if (_vlcMode) return _vlcPosMs / 1e3;
    if (_activeMvControls) return _activeMvControls.currentTime;
    const a = getMKAudio();
    return a && Number.isFinite(a.currentTime) ? a.currentTime : 0;
  }
  function _resumeMark() {
    if (!_resumeEnabled) return;
    const item = _mkInstance?.nowPlayingItem;
    if (!item || !_currentAssetId) return;
    const a = item.attributes ?? {};
    _resumeState = {
      v: 2,
      // Full queue snapshot: every container's song-id list, plus position.
      containers: _sessionContainers.map((c) => ({ items: c.items.slice() })),
      containerIdx: _sessionContainerIdx,
      itemIdx: _sessionItemIdx,
      shuffle: _mkInstance?.shuffleMode === 1,
      repeat: _mkInstance?.repeatMode ?? 0,
      adamId: _currentAssetId,
      name: a.name || "",
      artist: a.artistName || "",
      artworkUrl: _histArtUrl(a.artwork, 128),
      positionSec: Math.max(0, Math.round(_resumeCurrentPositionSec())),
      durationSec: Math.round(_durationSec || (a.durationInMillis || 0) / 1e3),
      savedAt: Date.now()
    };
    _resumeDirty = true;
  }
  async function _resumeFlush() {
    if (!_resumeDirty || !_resumeState) return;
    _resumeDirty = false;
    try {
      await window.adamBridge?.storeWrite(_RESUME_KEY, JSON.stringify(_resumeState));
    } catch (_) {
    }
  }
  function _resumeClear() {
    _resumeState = null;
    _resumeDirty = false;
    window.adamBridge?.storeDelete(_RESUME_KEY).catch(() => {
    });
  }
  function _resumeShowChip(mk, saved) {
    if (document.getElementById("adam-resume-chip")) return;
    const FF = "font-family:-apple-system,SF Pro Text,system-ui,sans-serif;";
    const chip = document.createElement("div");
    chip.id = "adam-resume-chip";
    chip.style.cssText = "position:fixed;bottom:110px;right:22px;z-index:99997;display:flex;align-items:center;gap:12px;max-width:360px;padding:12px 14px;border-radius:14px;background:rgba(30,30,32,0.92);border:0.5px solid rgba(255,255,255,0.14);box-shadow:0 10px 40px rgba(0,0,0,0.55);backdrop-filter:blur(28px) saturate(1.8);-webkit-backdrop-filter:blur(28px) saturate(1.8);transform:translateY(20px);opacity:0;transition:transform 0.3s,opacity 0.3s;" + FF;
    if (saved.artworkUrl) {
      const art = document.createElement("img");
      art.src = saved.artworkUrl;
      art.style.cssText = "width:44px;height:44px;border-radius:6px;flex-shrink:0;object-fit:cover;";
      chip.appendChild(art);
    }
    const txt = document.createElement("div");
    txt.style.cssText = "flex:1;min-width:0;";
    const pos = `${Math.floor(saved.positionSec / 60)}:${String(saved.positionSec % 60).padStart(2, "0")}`;
    const queueLen = (saved.containers || []).reduce((n, c) => n + (c.items?.length || 0), 0);
    const label = queueLen > 1 ? `Resume from ${pos} \xB7 ${queueLen} tracks` : `Resume from ${pos}`;
    txt.innerHTML = `<div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:2px;">${label}</div><div style="font-size:13px;color:#fff;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_histEscape(saved.name)}</div><div style="font-size:11px;color:rgba(255,255,255,0.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_histEscape(saved.artist)}</div>`;
    chip.appendChild(txt);
    const playBtn = document.createElement("button");
    playBtn.innerHTML = _svgPlaySm;
    playBtn.style.cssText = "width:36px;height:36px;flex-shrink:0;border-radius:50%;border:none;cursor:pointer;background:#fc3c44;color:#fff;display:flex;align-items:center;justify-content:center;";
    const dismiss = document.createElement("button");
    dismiss.innerHTML = _svgClose;
    dismiss.style.cssText = "width:24px;height:24px;flex-shrink:0;border-radius:50%;border:none;cursor:pointer;background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.6);display:flex;align-items:center;justify-content:center;";
    const close = () => {
      chip.style.opacity = "0";
      chip.style.transform = "translateY(20px)";
      setTimeout(() => chip.remove(), 300);
    };
    dismiss.onclick = close;
    playBtn.onclick = () => {
      close();
      _resumePlay(mk, saved);
    };
    chip.append(playBtn, dismiss);
    document.body.appendChild(chip);
    requestAnimationFrame(() => {
      chip.style.opacity = "1";
      chip.style.transform = "translateY(0)";
    });
    setTimeout(() => {
      if (document.getElementById("adam-resume-chip")) close();
    }, 2e4);
  }
  function _resumeSeekWhenReady(mk, saved) {
    if (!saved.positionSec) return;
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (_currentAssetId === saved.adamId && _durationSec > 0) {
        clearInterval(iv);
        try {
          mk.seekToTime(Math.min(saved.positionSec, _durationSec - 1));
        } catch (_) {
        }
      } else if (tries > 40) {
        clearInterval(iv);
      }
    }, 250);
  }
  async function _resumePlay(mk, saved) {
    try {
      const containers = Array.isArray(saved.containers) ? saved.containers : [];
      const flatIds = containers.flatMap((c) => (c.items || []).slice());
      if (containers.length) {
        _sessionContainers = containers.map((c) => ({ items: (c.items || []).slice() }));
        _sessionContainerIdx = Math.max(0, Math.min(saved.containerIdx ?? 0, _sessionContainers.length - 1));
        _sessionItemIdx = saved.itemIdx ?? 0;
      }
      if (typeof saved.shuffle === "boolean") {
        try {
          mk.shuffleMode = saved.shuffle ? 1 : 0;
        } catch (_) {
        }
      }
      if (Number.isFinite(saved.repeat)) {
        try {
          mk.repeatMode = saved.repeat;
        } catch (_) {
        }
      }
      const targetIdx = flatIds.indexOf(saved.adamId);
      if (flatIds.length && targetIdx >= 0) {
        await mk.setQueue({ songs: flatIds });
        await mk.changeToMediaAtIndex(targetIdx);
      } else {
        await mk.setQueue({ song: saved.adamId });
        await mk.play();
      }
      _resumeSeekWhenReady(mk, saved);
    } catch (e) {
      console.warn("[Adam Resume] restore failed, falling back to single track:", e?.message);
      try {
        await mk.setQueue({ song: saved.adamId });
        await mk.play();
        _resumeSeekWhenReady(mk, saved);
      } catch (_) {
      }
    }
  }
  async function _resumeSetup(mk) {
    try {
      const raw = await window.adamBridge?.storeRead("resumeEnabled");
      if (raw === "false" || raw === false) _resumeEnabled = false;
    } catch (_) {
    }
    if (!_resumeFlushTimer) _resumeFlushTimer = setInterval(_resumeFlush, 15e3);
    window.addEventListener("pagehide", _resumeFlush);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) _resumeFlush();
    });
    window.adamBridge?.onFlushAndQuit?.(() => {
      _resumeMark();
      _resumeFlush();
    });
    const audio = getMKAudio();
    if (audio) {
      audio.addEventListener("timeupdate", _resumeMark);
      audio.addEventListener("pause", () => {
        _resumeMark();
        _resumeFlush();
      });
    }
    if (!_resumeEnabled) return;
    let saved = null;
    try {
      const raw = await window.adamBridge?.storeRead(_RESUME_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch (_) {
    }
    if (!saved?.adamId) return;
    if (Date.now() - (saved.savedAt || 0) > _RESUME_MAX_AGE_MS) {
      _resumeClear();
      return;
    }
    const queueLen = (saved.containers || []).reduce((n, c) => n + (c.items?.length || 0), 0);
    const midTrack = saved.positionSec >= 5 && !(saved.durationSec && saved.positionSec > saved.durationSec - 5);
    if (queueLen <= 1 && !midTrack) return;
    _resumeShowChip(mk, saved);
  }
  var _discordEnabled = false;
  function _isPausedNow() {
    if (_vlcMode) return _vlcPaused;
    if (_activeMvControls) return _activeMvControls.paused;
    return getMKAudio()?.paused ?? false;
  }
  async function _deepLinkOpen(mk, intent) {
    const { type, id, sf } = intent;
    if (!id) return;
    console.log(`[Adam DeepLink] type=${type} id=${id} sf=${sf}`);
    if (sf && sf !== mk.storefrontId) {
      try {
        await mk.changeUserStorefront(sf);
      } catch (_) {
      }
    }
    try {
      switch (type) {
        case "song":
          await mk.setQueue({ song: id });
          await mk.play();
          break;
        case "album":
          await mk.setQueue({ album: id });
          await mk.play();
          break;
        case "playlist":
          await mk.setQueue({ playlist: id });
          await mk.play();
          break;
        case "music-video":
          await mk.setQueue({ musicVideo: id });
          await mk.play();
          break;
        case "artist":
          history.pushState({}, "", `/artist/${id}`);
          window.dispatchEvent(new PopStateEvent("popstate"));
          break;
        default:
          console.warn(`[Adam DeepLink] unknown type: ${type}`);
      }
    } catch (e) {
      console.error("[Adam DeepLink] navigation error:", e.message);
    }
  }
  function _authStateSetup(mk) {
    const report = async () => {
      const signedIn = mk.authorizationStatus === 3;
      window.adamBridge?.authState?.(signedIn);
      let mode = "blur";
      if (signedIn) {
        try {
          mode = (await window.adamBridge?.getPrefs?.())?.themeMode || "accent";
        } catch (_) {
          mode = "accent";
        }
      }
      document.body?.setAttribute("data-adam-mode", mode);
    };
    report();
    mk.addEventListener("authorizationStatusDidChange", report);
  }
  function _deepLinkSetup(mk) {
    window.adamBridge?.onOpenUrl?.((intent) => {
      _deepLinkOpen(mk, intent).catch(() => {
      });
    });
  }
  function _discordUpdateNow() {
    if (!_discordEnabled || !window.adamBridge?.discordUpdate) return;
    const item = _mkInstance?.nowPlayingItem;
    if (!item || !_currentAssetId) return;
    const a = item.attributes ?? {};
    const posSec = _resumeCurrentPositionSec();
    const durSec = _durationSec || (a.durationInMillis || 0) / 1e3;
    const playing = !_isPausedNow();
    const startedAtMs = Date.now() - Math.round(posSec * 1e3);
    const sf = _mkInstance?.storefrontId ?? "us";
    const isVideo = isVideoType(item.type);
    const itemType = isVideo ? "music-video" : "song";
    const slug = (a.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "track";
    const appleUrl = `https://music.apple.com/${sf}/${itemType}/${slug}/${_currentAssetId}`;
    window.adamBridge.discordUpdate({
      name: a.name || "",
      artist: a.artistName || "",
      album: a.albumName || "",
      artworkUrl: _histArtUrl(a.artwork, 512),
      playing,
      startedAtMs: playing ? startedAtMs : 0,
      endsAtMs: playing && durSec ? startedAtMs + Math.round(durSec * 1e3) : 0,
      appleUrl,
      isVideo
    });
  }
  async function _discordSetup() {
    try {
      const raw = await window.adamBridge?.storeRead("discordEnabled");
      _discordEnabled = raw === "true" || raw === true;
    } catch (_) {
    }
    const audio = getMKAudio();
    if (audio) {
      audio.addEventListener("play", _discordUpdateNow);
      audio.addEventListener("pause", _discordUpdateNow);
    }
    setInterval(() => {
      if (_discordEnabled) _discordUpdateNow();
    }, 1e4);
    if (_discordEnabled) _discordUpdateNow();
  }
  var _lastfmConnected = false;
  var _lbConnected = false;
  var _scrobbleTimer = null;
  async function _lastfmRefreshStatus() {
    try {
      const s = await window.adamBridge?.lastfmStatus();
      _lastfmConnected = !!s?.connected;
      return s;
    } catch (_) {
      return null;
    }
  }
  async function _lbRefreshStatus() {
    try {
      const s = await window.adamBridge?.lbStatus();
      _lbConnected = !!s?.connected;
      return s;
    } catch (_) {
      return null;
    }
  }
  function _scrobbleOnTrackChange() {
    if (_scrobbleTimer) {
      clearTimeout(_scrobbleTimer);
      _scrobbleTimer = null;
    }
    if (!_lastfmConnected && !_lbConnected) return;
    const item = _mkInstance?.nowPlayingItem;
    if (!item) return;
    const a = item.attributes ?? {};
    const artist = a.artistName || "";
    const track = a.name || "";
    if (!artist || !track) return;
    const durSec = _durationSec || (a.durationInMillis || 0) / 1e3;
    const meta = {
      artist,
      track,
      album: a.albumName || "",
      albumArtist: a.albumArtistName || a.artistName || "",
      duration: durSec || void 0
    };
    if (_lastfmConnected) window.adamBridge?.lastfmNowPlaying?.(meta);
    if (_lbConnected) window.adamBridge?.lbNowPlaying?.(meta);
    if (durSec && durSec < 30) return;
    const thresholdSec = durSec ? Math.min(240, durSec / 2) : 60;
    const startedAt = Date.now();
    const myTimer = setTimeout(() => {
      if (_scrobbleTimer !== myTimer) return;
      _scrobbleTimer = null;
      const scrob = { ...meta, timestamp: Math.floor(startedAt / 1e3) };
      if (_lastfmConnected) window.adamBridge?.lastfmScrobble?.(scrob);
      if (_lbConnected) window.adamBridge?.lbScrobble?.(scrob);
    }, thresholdSec * 1e3);
    _scrobbleTimer = myTimer;
  }
  async function _scrobbleSetup() {
    await Promise.all([_lastfmRefreshStatus(), _lbRefreshStatus()]);
  }
  var _soundCheckEnabled = false;
  var _scFactor = 1;
  var _scVlcReapply = null;
  var SC_TARGET_LKFS = -16;
  var _audioCtx = null;
  var _audioSrc = null;
  var _audioGain = null;
  var _audioAnalyser = null;
  var _audioGraphFailed = false;
  function _ensureAudioGraph() {
    if (_audioGraphFailed) return false;
    if (_audioGain) return true;
    try {
      const audio = getMKAudio();
      if (!audio) return false;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      _audioCtx = new Ctx();
      _audioSrc = _audioCtx.createMediaElementSource(audio);
      _audioAnalyser = _audioCtx.createAnalyser();
      _audioAnalyser.fftSize = 1024;
      _audioGain = _audioCtx.createGain();
      _audioSrc.connect(_audioAnalyser);
      _audioAnalyser.connect(_audioGain);
      _audioGain.connect(_audioCtx.destination);
      return true;
    } catch (e) {
      console.warn("[Adam Audio] WebAudio graph unavailable:", e?.message);
      _audioGraphFailed = true;
      _audioCtx = _audioSrc = _audioGain = _audioAnalyser = null;
      return false;
    }
  }
  function _scFindBox(dv, start, end, type) {
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const t = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
      let hdr = 8;
      if (size === 1) {
        if (p + 16 > end) break;
        size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
        hdr = 16;
      }
      if (size < hdr || p + size > end) break;
      if (t === type) return { start: p + hdr, end: p + size };
      p += size;
    }
    return null;
  }
  function _scFindPath(dv, start, end, path) {
    let s = start, e = end;
    for (const type of path) {
      const box = _scFindBox(dv, s, e, type);
      if (!box) return null;
      s = box.start;
      e = box.end;
    }
    return { start: s, end: e };
  }
  function _scParseLoudnessBase(dv, start, end) {
    let p = start;
    if (p + 4 > end) return NaN;
    const version = dv.getUint8(p);
    p += 4;
    let count = 1;
    if (version >= 2) {
      count = dv.getUint8(p) & 63;
      p += 1;
    }
    for (let i = 0; i < count && p < end; i++) {
      if (version >= 1) p += 1;
      p += 3;
      if (p >= end) break;
      const measCount = dv.getUint8(p);
      p += 1;
      for (let m = 0; m < measCount && p + 3 <= end; m++) {
        const methodDef = dv.getUint8(p), methodVal = dv.getUint8(p + 1);
        p += 3;
        if (methodDef === 1 || methodDef === 2) return methodVal / 4 - 57.75;
      }
    }
    return NaN;
  }
  async function _scFetchLoudness() {
    if (!_sessionId) return NaN;
    try {
      const resp = await fetch(
        `${ENGINE}/api/v1/playback/${_sessionId}/audio?raw=1`,
        { headers: { Range: "bytes=0-262143" } }
      );
      if (!resp.ok) return NaN;
      const dv = new DataView(await resp.arrayBuffer());
      const box = _scFindPath(dv, 0, dv.byteLength, ["moov", "udta", "ludt"]) || _scFindPath(dv, 0, dv.byteLength, ["moov", "trak", "udta", "ludt"]);
      if (!box) return NaN;
      const leaf = _scFindBox(dv, box.start, box.end, "tlou") || _scFindBox(dv, box.start, box.end, "alou");
      if (!leaf) return NaN;
      return _scParseLoudnessBase(dv, leaf.start, leaf.end);
    } catch (_) {
      return NaN;
    }
  }
  async function _scApplyForTrack() {
    _scFactor = 1;
    if (_audioGain) _audioGain.gain.value = 1;
    if (!_soundCheckEnabled || !_sessionId) return;
    const lkfs = await _scFetchLoudness();
    if (!Number.isFinite(lkfs)) {
      console.log("[Adam SoundCheck] no ludt loudness in stream");
      return;
    }
    const factor = Math.max(0, Math.min(1, Math.pow(10, (SC_TARGET_LKFS - lkfs) / 20)));
    _scFactor = factor;
    console.log(`[Adam SoundCheck] loudness=${lkfs.toFixed(2)} LKFS \u2192 factor=${factor.toFixed(3)} (${(20 * Math.log10(factor || 1)).toFixed(2)} dB)`);
    if (factor >= 0.999) return;
    if (_vlcMode) {
      _scVlcReapply?.();
    } else if (_ensureAudioGraph()) {
      try {
        if (_audioCtx.state === "suspended") await _audioCtx.resume();
      } catch (_) {
      }
      _audioGain.gain.value = factor;
    }
  }
  function _scSetEnabled(on) {
    _soundCheckEnabled = on;
    if (on) {
      _scApplyForTrack();
      return;
    }
    _scFactor = 1;
    if (_audioGain) _audioGain.gain.value = 1;
    _scVlcReapply?.();
  }
  async function _scSetup() {
    try {
      const raw = await window.adamBridge?.storeRead("soundCheckEnabled");
      _soundCheckEnabled = raw === "true" || raw === true;
    } catch (_) {
    }
  }
  var _crossfadeMode = "off";
  var _crossfadeManual = 6;
  var XF_AUTO_SEC = 6;
  var XF_ADAPT_MAX = 10;
  var XF_ADAPT_MIN = 2;
  var _crossfadeSec = 0;
  var _xfBaseVol = null;
  var _xfRamping = false;
  var _xfTimer = null;
  var _xfSkipNextFadeIn = false;
  var _xfPreserveGapless = true;
  var _xfStationEnabled = true;
  var _xfRmsHist = [];
  var _xfRmsBuf = null;
  var _xfPlannedSec = null;
  var _xfPlanSession = null;
  var _xfDecodeCtx = null;
  function _xfRecompute() {
    _crossfadeSec = _crossfadeMode === "auto" ? XF_AUTO_SEC : _crossfadeMode === "adaptive" ? XF_ADAPT_MAX : _crossfadeMode === "manual" ? _crossfadeManual : 0;
    if (_crossfadeSec <= 0) {
      _xfCancel();
      const a = getMKAudio();
      if (a && _xfBaseVol != null) {
        try {
          a.volume = _xfBaseVol;
        } catch (_) {
        }
      }
    }
  }
  function _xfCancel() {
    if (_xfTimer) {
      clearInterval(_xfTimer);
      _xfTimer = null;
    }
    _xfRamping = false;
  }
  function _xfTrackUserVolume(audio) {
    if (!_xfRamping) _xfBaseVol = audio.volume;
  }
  function _xfFadeInSec() {
    return _crossfadeMode === "manual" ? _crossfadeManual : XF_AUTO_SEC;
  }
  function _xfSampleRms() {
    if (!_ensureAudioGraph() || !_audioAnalyser) return null;
    try {
      if (_audioCtx.state === "suspended") _audioCtx.resume();
    } catch (_) {
    }
    const n = _audioAnalyser.fftSize;
    if (!_xfRmsBuf || _xfRmsBuf.length !== n) _xfRmsBuf = new Float32Array(n);
    _audioAnalyser.getFloatTimeDomainData(_xfRmsBuf);
    let s = 0;
    for (let i = 0; i < n; i++) s += _xfRmsBuf[i] * _xfRmsBuf[i];
    return Math.sqrt(s / n);
  }
  function _xfAnalyzeEnding(audioBuf) {
    const sr = audioBuf.sampleRate;
    const ch = audioBuf.getChannelData(0);
    const tail = Math.min(12, audioBuf.duration);
    const start = Math.max(0, ch.length - Math.floor(tail * sr));
    const win = Math.max(1, Math.floor(sr * 0.5));
    let peak = 0, final = 0;
    for (let i = start; i < ch.length; i += win) {
      let s = 0, n = 0;
      for (let j = i; j < Math.min(i + win, ch.length); j++) {
        s += ch[j] * ch[j];
        n++;
      }
      const rms = Math.sqrt(s / Math.max(1, n));
      final = rms;
      if (rms > peak) peak = rms;
    }
    if (peak < 1e-4) return XF_ADAPT_MIN;
    const ratio = final / peak;
    if (ratio >= 0.7) return XF_ADAPT_MAX;
    if (ratio <= 0.3) return XF_ADAPT_MIN;
    return XF_ADAPT_MIN + (XF_ADAPT_MAX - XF_ADAPT_MIN) * ((ratio - 0.3) / 0.4);
  }
  async function _xfPlanAdaptive() {
    if (_crossfadeMode !== "adaptive") return;
    const cache = _chunkCache;
    if (!cache || !cache.chunks || !cache.chunks.length) return;
    if (_xfPlanSession === cache.sessionId && _xfPlannedSec != null) return;
    try {
      let total = 0;
      for (const c of cache.chunks) total += c.byteLength;
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const c of cache.chunks) {
        bytes.set(c, o);
        o += c.byteLength;
      }
      if (!_xfDecodeCtx) _xfDecodeCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuf = await _xfDecodeCtx.decodeAudioData(bytes.buffer);
      _xfPlannedSec = _xfAnalyzeEnding(audioBuf);
      _xfPlanSession = cache.sessionId;
      console.log(`[Adam Crossfade] adaptive plan: ${_xfPlannedSec.toFixed(1)}s fade (session ${cache.sessionId})`);
    } catch (e) {
      console.log("[Adam Crossfade] adaptive offline analysis unavailable, using live sampling:", e?.message);
    }
  }
  function _xfAdaptiveDuration() {
    const rms = _xfSampleRms();
    if (rms == null) return XF_AUTO_SEC;
    const now = performance.now();
    _xfRmsHist.push({ t: now, rms });
    while (_xfRmsHist.length && now - _xfRmsHist[0].t > 3e3) _xfRmsHist.shift();
    if (rms < 0.015) return XF_ADAPT_MIN;
    const past = _xfRmsHist[0]?.rms ?? rms;
    const ratio = past > 0 ? rms / past : 1;
    if (ratio >= 0.7) return XF_ADAPT_MAX;
    const f = Math.max(0, Math.min(1, (ratio - 0.3) / 0.4));
    return XF_ADAPT_MIN + (XF_ADAPT_MAX - XF_ADAPT_MIN) * f;
  }
  function _xfAreSequential(a, b) {
    if (!a || !b) return false;
    const al = (a.albumName || "").trim().toLowerCase();
    const bl = (b.albumName || "").trim().toLowerCase();
    if (!al || !bl || al !== bl) return false;
    if ((a.artistName || "") !== (b.artistName || "")) return false;
    const ad = a.discNumber ?? 1, bd = b.discNumber ?? 1;
    const at = a.trackNumber, bt = b.trackNumber;
    if (!Number.isFinite(at) || !Number.isFinite(bt)) return false;
    return ad === bd && bt === at + 1;
  }
  function _xfDecision() {
    if (_crossfadeSec <= 0) return "skip";
    const mk = _mkInstance;
    if (!mk) return "skip";
    if ((mk.repeatMode ?? 0) === 1) return "skip";
    const items = mk.queue?.items;
    const pos = mk.queue?.position ?? -1;
    if (!items || pos < 0) return "skip";
    if (pos + 1 >= items.length) {
      return _xfStationEnabled && (mk.autoplayEnabled ?? true) ? "wait" : "skip";
    }
    const nextItem = items[pos + 1];
    const nextType = nextItem?.type ?? nextItem?.attributes?.playParams?.kind;
    if (nextType && String(nextType).includes("video")) return "skip";
    if (_xfPreserveGapless && _xfAreSequential(mk.nowPlayingItem?.attributes, nextItem?.attributes)) {
      return "skip-gapless";
    }
    return "fade";
  }
  var XF_STEPS = 20;
  var XF_MIN_STEP_MS = 200;
  var XF_MAX_STEP_MS = 500;
  function _xfRamp(audio, to, durSec, onDone) {
    _xfCancel();
    const from = audio.volume;
    const rawMs = durSec * 1e3 / XF_STEPS;
    const stepMs = Math.max(XF_MIN_STEP_MS, Math.min(XF_MAX_STEP_MS, rawMs));
    const steps = Math.max(1, Math.round(durSec * 1e3 / stepMs));
    let i = 0;
    _xfRamping = true;
    _xfTimer = setInterval(() => {
      i++;
      try {
        audio.volume = Math.max(0, Math.min(1, from + (to - from) * (i / steps)));
      } catch (_) {
      }
      if (i >= steps) {
        _xfCancel();
        onDone?.();
      }
    }, stepMs);
  }
  function _xfFadeIn(audio) {
    if (_crossfadeSec <= 0 || !audio) return;
    _xfRmsHist = [];
    _xfPlannedSec = null;
    _xfPlanSession = null;
    if (_xfSkipNextFadeIn) {
      _xfSkipNextFadeIn = false;
      return;
    }
    if (_xfBaseVol == null) _xfBaseVol = audio.volume || 1;
    _xfRamping = true;
    try {
      audio.volume = 0;
    } catch (_) {
    }
    _xfRamp(audio, _xfBaseVol, _xfFadeInSec());
  }
  function _xfFadeOut(audio, remainingSec, forceDur) {
    if (_crossfadeSec <= 0 || !audio) return;
    const len = forceDur != null ? forceDur : _crossfadeSec;
    _xfRamp(audio, 0, Math.max(0.2, Math.min(len, remainingSec)));
  }
  function _xfSetMode(mode) {
    _crossfadeMode = mode;
    window.adamBridge?.setTweak("crossfade-mode", mode);
    _xfRecompute();
  }
  function _xfSetManualSec(sec) {
    _crossfadeManual = Math.max(0, Math.min(12, sec));
    window.adamBridge?.setTweak("crossfade-sec", _crossfadeManual);
    if (_crossfadeMode === "manual") _xfRecompute();
  }
  async function _xfSetup() {
    try {
      const prefs = await window.adamBridge?.getPrefs();
      const v = Number(prefs?.["crossfade-sec"]);
      if (Number.isFinite(v) && v >= 0) _crossfadeManual = Math.min(12, v);
      const m = prefs?.["crossfade-mode"];
      _crossfadeMode = m === "off" || m === "auto" || m === "adaptive" || m === "manual" ? m : _crossfadeManual > 0 ? "manual" : "off";
      _xfRecompute();
      if (prefs?.["xf-preserve-gapless"] === false) _xfPreserveGapless = false;
      if (prefs?.["xf-station"] === false) _xfStationEnabled = false;
    } catch (_) {
    }
  }
  var _adamToastTimer = null;
  function _adamToast(text) {
    let el2 = document.getElementById("adam-toast");
    if (!el2) {
      el2 = document.createElement("div");
      el2.id = "adam-toast";
      el2.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(10px);z-index:99999;padding:9px 18px;border-radius:20px;background:rgba(30,30,32,0.92);border:0.5px solid rgba(255,255,255,0.14);color:#fff;font-size:13px;font-weight:500;font-family:-apple-system,SF Pro Text,system-ui,sans-serif;pointer-events:none;opacity:0;box-shadow:0 8px 30px rgba(0,0,0,0.5);backdrop-filter:blur(24px) saturate(1.8);-webkit-backdrop-filter:blur(24px) saturate(1.8);transition:opacity 0.2s,transform 0.2s;";
      document.body.appendChild(el2);
    }
    el2.textContent = text;
    requestAnimationFrame(() => {
      el2.style.opacity = "1";
      el2.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(_adamToastTimer);
    _adamToastTimer = setTimeout(() => {
      el2.style.opacity = "0";
      el2.style.transform = "translateX(-50%) translateY(10px)";
    }, 1600);
  }
  var _lovedState = {};
  var _reemitMpris = null;
  var _pushMiniStateRef = null;
  async function _toggleLove() {
    const mk = _mkInstance, id = _currentAssetId;
    if (!mk || !id) return;
    try {
      let loved = _lovedState[id];
      if (loved === void 0) {
        try {
          const r = await mk.api.music(`/v1/me/ratings/songs/${id}`);
          loved = r?.data?.data?.[0]?.attributes?.value === 1;
        } catch (_) {
          loved = false;
        }
      }
      if (loved) {
        await mk.api.music(`/v1/me/ratings/songs/${id}`, {}, { fetchOptions: { method: "DELETE" } });
        _lovedState[id] = false;
        _adamToast("Removed from Favourites");
      } else {
        await mk.api.music(
          `/v1/me/ratings/songs/${id}`,
          {},
          { fetchOptions: { method: "PUT", body: JSON.stringify({ type: "rating", attributes: { value: 1 } }) } }
        );
        _lovedState[id] = true;
        _adamToast("\u2665  Loved");
      }
      _reemitMpris?.();
    } catch (e) {
      console.warn("[Adam Love] toggle failed:", e?.message);
      _adamToast("Could not update Favourite");
    }
  }
  var _hotkeysEnabled = true;
  var _HOTKEY_ACTIONS = [
    { id: "playPause", label: "Play / Pause", def: " " },
    { id: "seekForward", label: "Seek forward 10s", def: "ArrowRight" },
    { id: "seekBack", label: "Seek back 10s", def: "ArrowLeft" },
    { id: "volUp", label: "Volume up", def: "ArrowUp" },
    { id: "volDown", label: "Volume down", def: "ArrowDown" },
    { id: "love", label: "Love / Favourite", def: "l" }
  ];
  var _hotkeyBindings = Object.fromEntries(_HOTKEY_ACTIONS.map((a) => [a.id, a.def]));
  function _hotkeyKeyLabel(k) {
    if (k === " ") return "Space";
    const map = { ArrowRight: "\u2192", ArrowLeft: "\u2190", ArrowUp: "\u2191", ArrowDown: "\u2193", Escape: "Esc" };
    if (map[k]) return map[k];
    return k.length === 1 ? k.toUpperCase() : k;
  }
  function _hotkeyNormalize(k) {
    return k.length === 1 ? k.toLowerCase() : k;
  }
  function _hotkeyActionFor(key) {
    const norm = _hotkeyNormalize(key);
    for (const [id, k] of Object.entries(_hotkeyBindings)) {
      if (_hotkeyNormalize(k) === norm) return id;
    }
    return null;
  }
  function _hotkeyTypingTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }
  function _hotkeyAdjustVolume(delta) {
    const a = getMKAudio();
    if (!a) return;
    const v = Math.max(0, Math.min(1, (a.volume ?? 1) + delta));
    try {
      a.volume = v;
    } catch (_) {
    }
    _adamToast(`Volume ${Math.round(v * 100)}%`);
  }
  function _hotkeyRun(action) {
    const mk = _mkInstance;
    if (!mk) return;
    const pos = _resumeCurrentPositionSec();
    switch (action) {
      case "playPause":
        _isPausedNow() ? mk.play?.() : mk.pause?.();
        break;
      case "seekForward":
        try {
          mk.seekToTime(pos + 10);
        } catch (_) {
        }
        break;
      case "seekBack":
        try {
          mk.seekToTime(Math.max(0, pos - 10));
        } catch (_) {
        }
        break;
      case "volUp":
        _hotkeyAdjustVolume(0.05);
        break;
      case "volDown":
        _hotkeyAdjustVolume(-0.05);
        break;
      case "love":
        _toggleLove();
        break;
    }
  }
  var _hotkeyCapture = null;
  function _installMediaHotkeys() {
    document.addEventListener("keydown", (e) => {
      if (_hotkeyCapture) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const cb = _hotkeyCapture;
        _hotkeyCapture = null;
        cb(e.key === "Escape" ? null : e.key);
        return;
      }
      if (!_hotkeysEnabled) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (_hotkeyTypingTarget(e.target)) return;
      const action = _hotkeyActionFor(e.key);
      if (!action) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      _hotkeyRun(action);
    }, true);
  }
  async function _hotkeySaveBindings() {
    try {
      await window.adamBridge?.storeWrite("hotkeyBindings", JSON.stringify(_hotkeyBindings));
    } catch (_) {
    }
  }
  async function _hotkeysSetup() {
    try {
      const raw = await window.adamBridge?.storeRead("hotkeysEnabled");
      if (raw === "false" || raw === false) _hotkeysEnabled = false;
      const b = await window.adamBridge?.storeRead("hotkeyBindings");
      if (b) {
        const parsed = JSON.parse(b);
        for (const a of _HOTKEY_ACTIONS) if (parsed[a.id]) _hotkeyBindings[a.id] = parsed[a.id];
      }
    } catch (_) {
    }
    _installMediaHotkeys();
  }
  function _broadcastNowPlaying() {
    try {
      _discordUpdateNow();
    } catch (_) {
    }
    try {
      _scrobbleOnTrackChange();
    } catch (_) {
    }
    try {
      _resumeMark();
      _resumeFlush();
    } catch (_) {
    }
    try {
      _scApplyForTrack();
    } catch (_) {
    }
    try {
      _pushMiniStateRef?.();
    } catch (_) {
    }
  }
  function _histRender() {
    const section = document.getElementById("adam-history-section");
    if (!section) return;
    if (_queueHistory.length === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    section.innerHTML = `
        <div class="adam-hs-header">
            <span class="adam-hs-title">History</span>
        </div>
        <div class="adam-hs-list">
        ${_queueHistory.slice(0, 30).map((h) => `
            <div class="adam-hs-item" data-catalog-id="${_histEscape(h.catalogId)}">
                ${h.artworkUrl ? `<img class="adam-hs-art" src="${_histEscape(h.artworkUrl)}" loading="lazy">` : `<div class="adam-hs-art adam-hs-art-ph"></div>`}
                <div class="adam-hs-meta">
                    <div class="adam-hs-name">${_histEscape(h.name)}</div>
                    <div class="adam-hs-artist">${_histEscape(h.artist)}</div>
                </div>
                ${h.duration ? `<span class="adam-hs-dur">${_histEscape(h.duration)}</span>` : ""}
            </div>`).join("")}
        </div>`;
  }
  function _histInjectStyles() {
    if (document.getElementById("adam-hist-css")) return;
    const s = document.createElement("style");
    s.id = "adam-hist-css";
    s.textContent = `
#adam-history-section {
    border-bottom: 1px solid var(--separator, rgba(128,128,128,.18));
    padding-bottom: 8px;
    margin-bottom: 4px;
}
.adam-hs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px var(--side-panel-horizontal-padding, 20px) 8px;
}
.adam-hs-title {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: normal;
    text-transform: none;
    opacity: 1;
}
.adam-hs-list { padding-bottom: 4px; max-height: 300px; overflow-y: auto; scrollbar-width: thin; }
.adam-hs-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px var(--side-panel-horizontal-padding, 20px);
    min-height: 44px;
    cursor: pointer;
    border-radius: 6px;
    transition: background .12s;
    box-sizing: border-box;
}
.adam-hs-item:hover { background: var(--systemFillTertiary, rgba(128,128,128,.14)); }
.adam-hs-art {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
    background: rgba(128,128,128,.18);
}
.adam-hs-art-ph { background: rgba(128,128,128,.18); }
.adam-hs-meta { min-width: 0; flex: 1; }
.adam-hs-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.adam-hs-artist {
    font-size: 11px;
    opacity: .55;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.adam-hs-dur {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    opacity: .55;
    flex-shrink: 0;
    padding-left: 6px;
}`;
    document.head.appendChild(s);
  }
  var _histEnabled = true;
  function _histInject() {
    const panel = document.querySelector(".side-panel");
    if (!panel) return;
    if (!_histEnabled) {
      panel.querySelector("#adam-history-section")?.remove();
      return;
    }
    if (panel.querySelector("#adam-history-section")) return;
    const div = document.createElement("div");
    div.id = "adam-history-section";
    div.addEventListener("click", (e) => {
      const item = e.target.closest(".adam-hs-item");
      if (item?.dataset.catalogId) window._adamHistPlay(item.dataset.catalogId);
    });
    panel.prepend(div);
    _histRender();
  }
  async function setupQueueHistory(mk) {
    _histInjectStyles();
    window._adamHistClear = _histClear;
    window._adamHistPlay = (catalogId) => {
      if (!catalogId) return;
      mk.setQueue({ song: catalogId }).then(() => mk.play()).catch(() => {
      });
    };
    try {
      const pref = await window.adamBridge?.storeRead("historyEnabled");
      if (pref !== null && pref !== void 0) _histEnabled = pref !== "false" && pref !== false;
    } catch (_) {
    }
    await _histLoadAsync();
    mk.addEventListener("nowPlayingItemWillChange", () => _histPush(mk.nowPlayingItem));
    watchDomSettled(_histInject);
  }
  async function setup() {
    if (window.__adamEngineMounted) return;
    window.__adamEngineMounted = true;
    blockAppleCDN();
    let _adamLastGotoMs = 0;
    const _inGotoWindow = () => performance.now() - _adamLastGotoMs < 1e3 || _playState === PLAY_STATE.OPENING || _playState === PLAY_STATE.STREAMING;
    const _isSpuriousDialog = (el2) => el2?.tagName === "DIALOG" && el2?.dataset?.testid === "dialog" && el2?.classList?.contains("error");
    const _origShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function() {
      if (_isSpuriousDialog(this)) {
        const mkAudio = getMKAudio();
        const mk2 = window.MusicKit?.getInstance?.();
        console.error(
          "[Adam] Error dialog showModal triggered \u2014 dumping state:",
          "\n  playState   =",
          _playState,
          "\n  generation  =",
          _generation,
          "\n  sessionId   =",
          _sessionId,
          "\n  adamId      =",
          _currentAssetId,
          "\n  allowCDN    =",
          _allowCDNTransition,
          "\n  mk.state    =",
          mk2?.playbackState,
          "\n  mk.item     =",
          mk2?.nowPlayingItem?.id ?? "null",
          "\n  mk.queuePos =",
          mk2?.queue?.position,
          "\n  audio.src   =",
          mkAudio?.src?.slice(0, 80) ?? "null",
          "\n  audio.loadShadowed =",
          mkAudio?.load?.toString?.()?.includes("{}") ?? "no",
          "\n  dialogText  =",
          this.innerText?.slice(0, 200)
        );
        if (_inGotoWindow()) {
          console.log("[Adam] Suppressed error dialog showModal (goto window)");
          return;
        }
      }
      return _origShowModal.call(this);
    };
    new MutationObserver(() => {
      if (!_inGotoWindow()) return;
      const dlg = document.querySelector('dialog[data-testid="dialog"].error[open]');
      if (dlg) {
        dlg.close();
        console.log("[Adam] Closed spurious error dialog (goto window)");
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    try {
      const msg = await window._adamEngine?.waitFor("engine.snapshot", T().sseWait);
      const snap = msg?.payload?.snapshot;
      const gen = msg?.meta?.generation ?? "?";
      const why = msg?.meta?.reason ?? "?";
      _snapshotEventId = msg?.meta?.id ?? -1;
      if (snap?.capabilities) {
        _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        window._adamLossless = _engineCaps.lossless && _streamingQuality !== "high-quality";
      }
      console.log(`[Adam Engine] Engine ready \u2014 drm.session=${snap?.drm?.session ?? "unknown"} lossless=${_engineCaps.lossless} gen=${gen} reason=${why} snapshotId=${_snapshotEventId}`);
    } catch (e) {
      console.warn("[Adam Engine] Engine snapshot timeout:", e.message, "\u2014 continuing");
    }
    window.adamBridge?.getPrefs().then((p) => {
      if (p["streaming-quality"]) _streamingQuality = p["streaming-quality"];
      if (p["lossless-enabled"] === false) _streamingQuality = "high-quality";
      if (p["downloads-quality"]) _downloadsQuality = p["downloads-quality"];
      window._adamLossless = _engineCaps.lossless && _streamingQuality !== "high-quality";
      const body = {};
      if (p.prewarmLimitMB != null) body.prewarmLimitMB = p.prewarmLimitMB;
      if (p.persistLimitMB != null) body.persistLimitMB = p.persistLimitMB;
      if (p.persistTTLDays != null) body.persistTTLDays = p.persistTTLDays;
      if (Object.keys(body).length)
        fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
        });
    }).catch(() => {
    });
    window._adamEngine?.on("drm", (msg) => {
      const eventId = msg?.meta?.id ?? Infinity;
      if (eventId <= _snapshotEventId) {
        console.log(`[Adam Engine] DRM event ${eventId} skipped (predates snapshot ${_snapshotEventId})`);
        return;
      }
      const snap = msg?.payload;
      const wasLossless = _engineCaps.lossless;
      const sess = snap?.state?.session ?? "unknown";
      if (snap?.capabilities) {
        _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        window._adamLossless = _engineCaps.lossless && _streamingQuality !== "high-quality";
      }
      console.log(`[Adam Engine] DRM state \u2192 session=${sess} lossless=${_engineCaps.lossless}`);
      if (!wasLossless && _engineCaps.lossless) _losslessWaitDone = false;
      _accountSheet().onSnapshot(snap);
      if (snap?.challenge?.type === "credentials") {
        console.log("[Adam Engine] DRM credential challenge \u2014 opening sign-in form");
        window.__adamOpenEngineSettings?.();
      }
    });
    const mk = await waitForMusicKit();
    console.log("[Adam Engine] MusicKit ready");
    const _pushLibraryTokens = () => {
      try {
        const mkut = mk.musicUserToken;
        const devToken = mk.developerToken || "";
        if (mkut) {
          fetch(ENGINE + "/api/v1/library/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ musicUserToken: mkut, developerToken: devToken })
          }).catch(() => {
          });
        }
      } catch (_) {
      }
    };
    _pushLibraryTokens();
    window._adamEngine?.on("sse.open", _pushLibraryTokens);
    mk.addEventListener("authorizationStatusDidChange", _pushLibraryTokens);
    async function _mkFetchAll(mkInst, basePath, extraParams, onProgress) {
      const items = [];
      const [pathOnly, qs] = basePath.split("?");
      const baseParams = Object.assign({ limit: 100 }, extraParams);
      if (qs) qs.split("&").forEach((kv) => {
        const [k, v] = kv.split("=");
        if (k && !(k in baseParams)) baseParams[k] = v;
      });
      let nextOffset = null;
      while (true) {
        if (items.length > 5e4) break;
        const params = Object.assign({}, baseParams);
        if (nextOffset !== null) params.offset = nextOffset;
        const res = await mkInst.api.music(pathOnly, params);
        const body = res?.data;
        if (body?.errors?.length) throw new Error(body.errors[0]?.detail || body.errors[0]?.title || "API error");
        const page = body?.data || [];
        items.push(...page);
        onProgress(items.length, pathOnly);
        const nextUrl = body?.next || null;
        if (!nextUrl) break;
        const m = nextUrl.match(/[?&]offset=(\d+)/);
        nextOffset = m ? parseInt(m[1], 10) : null;
        if (nextOffset === null) break;
      }
      return items;
    }
    async function _syncLibraryViaJS(onProgress) {
      if (!onProgress) onProgress = () => {
      };
      const mkInst = window.MusicKit?.getInstance?.();
      if (!mkInst) throw new Error("MusicKit not ready");
      const songs = await _mkFetchAll(mkInst, "/v1/me/library/songs", { include: "catalog,albums" }, onProgress);
      onProgress(songs.length, "albums");
      const albums = await _mkFetchAll(mkInst, "/v1/me/library/albums", { include: "catalog" }, onProgress);
      onProgress(albums.length, "playlists");
      const playlists = await _mkFetchAll(mkInst, "/v1/me/library/playlists", {}, onProgress);
      const playlistTracks = {};
      for (let i = 0; i < playlists.length; i++) {
        onProgress(i, "tracks:" + (playlists[i].attributes?.name || playlists[i].id));
        const tracks = await _mkFetchAll(mkInst, `/v1/me/library/playlists/${playlists[i].id}/tracks`, {}, onProgress);
        playlistTracks[playlists[i].id] = tracks;
      }
      let revision = "";
      try {
        const libRes = await mkInst.api.music("/v1/me/library");
        revision = libRes?.data?.data?.[0]?.attributes?.revision || libRes?.data?.revision || libRes?.data?.data?.[0]?.id || "";
      } catch (_) {
      }
      const resp = await fetch(ENGINE + "/api/v1/library/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ songs, albums, playlists, playlistTracks, revision })
      });
      if (!resp.ok) throw new Error(await resp.text());
      return await resp.json();
    }
    window._syncLibraryViaJS = _syncLibraryViaJS;
    const _maybeAutoSync = async () => {
      try {
        const mkForAuth = window.MusicKit?.getInstance?.();
        if (!mkForAuth) return;
        if (mkForAuth.authorizationStatus !== 3) {
          console.log("[Adam Library] auto-sync: waiting for web UI login (MK status=" + mkForAuth.authorizationStatus + ")");
          const _onAuth = async () => {
            mk.removeEventListener("authorizationStatusDidChange", _onAuth);
            await _maybeAutoSync();
          };
          mk.addEventListener("authorizationStatusDidChange", _onAuth);
          return;
        }
        const status = await fetch(ENGINE + "/api/v1/library/status").then((r) => r.json()).catch(() => null);
        if (!status?.needsSync) return;
        console.log("[Adam Library] auto-sync: cache needs refresh (web auth)");
        const result = await _syncLibraryViaJS();
        if (result.songs === 0) {
          console.log("[Adam Library] auto-sync: library is empty \u2014 will not retry for 24h");
        } else {
          console.log(`[Adam Library] auto-sync done: ${result.songs} songs, ${result.playlists} playlists`);
        }
      } catch (e) {
        console.log("[Adam Library] auto-sync failed:", e.message || e);
      }
    };
    setTimeout(_maybeAutoSync, 2e3);
    const _origMKPlay = mk.play.bind(mk);
    const _origMKPause = mk.pause.bind(mk);
    mk.play = async function() {
      if (_vlcMode) {
        if (_vlcPaused) {
          console.log("[Adam VLC] mk.play() \u2192 resume");
          _requestVLCTransport(false);
        }
      } else if (_activeMvControls) {
        _msePaused = false;
        _activeMvControls.play();
      } else {
        _msePaused = false;
      }
      return _origMKPlay().catch(() => {
      });
    };
    mk.pause = function() {
      if (_vlcMode) {
        console.log("[Adam VLC] mk.pause() \u2192 pause");
        _requestVLCTransport(true);
        getMKAudio()?.dispatchEvent(new Event("pause"));
      } else if (_activeMvControls) {
        _msePaused = true;
        _activeMvControls.pause();
      } else {
        _msePaused = true;
        getMKAudio()?.pause();
      }
      return _origMKPause();
    };
    installMKSeekInterceptor(mk);
    const transportControls = installTransportControls({
      state: () => {
        const ci = _sessionContainerIdx;
        const ii = _sessionItemIdx;
        const cur = _sessionContainers[ci];
        return {
          active: _vlcLive,
          paused: _pendingVLCIntent ?? _vlcPaused,
          canPrevious: !!cur,
          canNext: !!cur && ((mk.repeatMode ?? 0) !== 0 || ii + 1 < cur.items.length || ci + 1 < _sessionContainers.length || mk.queue?.playbackMode === 1)
        };
      },
      command: (action) => {
        if (!_vlcMode && (action === "play" || action === "pause")) {
          _pendingVLCIntent = action === "pause";
          _syncVLCControls();
          return;
        }
        const result = action === "play" ? mk.play() : action === "pause" ? mk.pause() : action === "next" ? _adamNextRef?.(true) : _adamPrevRef?.();
        Promise.resolve(result).catch((error) => console.warn("[Adam] transport control:", error.message));
      }
    });
    _syncVLCControls = transportControls.sync;
    let _adamAdvancing = false;
    let _adamAdvancingTimer = null;
    let _adamGotoTarget = null;
    let _adamGotoTargetId = null;
    function _clearAdvancing() {
      _adamAdvancing = false;
      clearTimeout(_adamAdvancingTimer);
      _adamAdvancingTimer = null;
    }
    async function _adamGoto(ci, ii) {
      if (_adamAdvancing) {
        console.log("[Adam] _adamGoto busy, ignoring ci=", ci, "ii=", ii);
        return;
      }
      _adamAdvancing = true;
      _adamTransitioning = true;
      _adamLastGotoMs = performance.now();
      _adamNavInternal = true;
      _adamPendingCI = ci;
      _adamPendingII = ii;
      const targetFlat = _sessionFlatIdx(ci, ii);
      _adamGotoTarget = targetFlat;
      _adamInGotoTransition = true;
      console.log("[Adam] _adamGoto ci=", ci, "ii=", ii, "flat=", targetFlat);
      stopVLCPoll();
      const _gotoAudio = getMKAudio();
      if (_gotoAudio && _nativeSrcSet) {
        _nativeSrcSet.call(_gotoAudio, "");
        HTMLMediaElement.prototype.load.call(_gotoAudio);
      }
      if (_gotoAudio) {
        try {
          delete _gotoAudio.load;
        } catch (_) {
        }
        try {
          delete _gotoAudio.paused;
        } catch (_) {
        }
        try {
          delete _gotoAudio.currentTime;
        } catch (_) {
        }
        try {
          delete _gotoAudio.volume;
        } catch (_) {
        }
        try {
          delete _gotoAudio.muted;
        } catch (_) {
        }
        try {
          delete _gotoAudio.pause;
        } catch (_) {
        }
        try {
          delete _gotoAudio.play;
        } catch (_) {
        }
      }
      _proxyInstalled = false;
      _vlcMode = false;
      const targetSongId = _sessionContainers[ci]?.items[ii];
      const targetItem = targetSongId ? (mk.queue?.items ?? []).find((it) => extractItemId(it) === targetSongId) : null;
      if (targetItem) sendMprisMetadata(targetItem);
      _adamAdvancingTimer = setTimeout(() => {
        _adamGotoTarget = null;
        _adamGotoTargetId = null;
        _adamInGotoTransition = false;
        _allowCDNTransition = false;
        _adamTransitioning = false;
        _adamNavInternal = false;
        _adamPendingCI = -1;
        _adamPendingII = -1;
        _clearAdvancing();
      }, 6e3);
      const mkCurrentItems = mk.queue?.items ?? [];
      const mkDirectIdx = targetSongId ? mkCurrentItems.findIndex((it) => extractItemId(it) === targetSongId) : -1;
      const targetIsVideo = _isVideoId(targetSongId);
      if (mkDirectIdx >= 0 && !targetIsVideo) {
        _adamGotoTarget = mkDirectIdx;
        _adamGotoTargetId = targetSongId ?? null;
        await mk.changeToMediaAtIndex(mkDirectIdx).catch(() => {
        });
      } else {
        const allIds = _sessionFlatIds();
        if (!allIds.length) {
          clearTimeout(_adamAdvancingTimer);
          _clearAdvancing();
          _adamGotoTarget = null;
          _adamGotoTargetId = null;
          _adamInGotoTransition = false;
          _allowCDNTransition = false;
          _adamTransitioning = false;
          _adamNavInternal = false;
          _adamPendingCI = -1;
          _adamPendingII = -1;
          return;
        }
        const songIds = targetIsVideo ? allIds : allIds.filter((id) => !_isVideoId(id));
        const songIdx = targetIsVideo ? -1 : songIds.indexOf(targetSongId);
        if (targetIsVideo) {
          const desc = { musicVideo: targetSongId };
          console.log("[Adam] _adamGoto mixed/MV session \u2014 targeted setQueue " + JSON.stringify(desc));
          _adamGotoTarget = 0;
          _adamGotoTargetId = targetSongId ?? null;
          await mk.setQueue(desc).catch(() => {
          });
          await mk.changeToMediaAtIndex(0).catch(() => {
          });
        } else if (songIdx >= 0 && songIds.length !== allIds.length) {
          console.log("[Adam] _adamGoto mixed session \u2014 songs only, idx=" + songIdx + " of " + songIds.length);
          _adamGotoTarget = songIdx;
          _adamGotoTargetId = targetSongId ?? null;
          await mk.setQueue({ songs: songIds }).catch(() => {
          });
          await mk.changeToMediaAtIndex(songIdx).catch(() => {
          });
        } else {
          const targetIdx = Math.max(0, Math.min(targetFlat, allIds.length - 1));
          _adamGotoTarget = targetIdx;
          _adamGotoTargetId = targetSongId ?? null;
          const sqDesc = targetSongId ? { songs: allIds, startWith: { id: targetSongId } } : { songs: allIds };
          await mk.setQueue(sqDesc).catch(() => {
          });
          await mk.play().catch(() => {
          });
        }
      }
      _clearAdvancing();
      _updateTransportButtons();
      const mkAudio = document.querySelector("audio");
      if (mkAudio && !_vlcMode) mkAudio.dispatchEvent(new Event("waiting"));
    }
    async function _adamNext(manual = false) {
      const repeat = mk.repeatMode ?? 0;
      const ci = _sessionContainerIdx, ii = _sessionItemIdx;
      const cur = _sessionContainers[ci];
      if (repeat === 1 && !manual) {
        if (ci >= 0) await _adamGoto(ci, ii);
        return;
      }
      if (!cur) return;
      if (ii + 1 < cur.items.length) {
        await _adamGoto(ci, ii + 1);
      } else if (repeat === 2) {
        await _adamGoto(ci, 0);
      } else if (ci + 1 < _sessionContainers.length) {
        await _adamGoto(ci + 1, 0);
      } else {
        const mkItems = mk.queue?.items ?? [];
        const freshIds = mkItems.map(extractItemId).filter((id) => id && !cur.items.includes(id));
        if (freshIds.length) {
          cur.items.push(...freshIds);
          await _adamGoto(ci, ii + 1);
        } else if (mk.queue?.playbackMode === 1 && _mkOrigSkipToNext) {
          console.log("[Adam Station] end of snapshot \u2014 delegating to MK native skip for station fetch");
          _mkOrigSkipToNext();
        }
      }
    }
    async function _adamPrev() {
      const ci = _sessionContainerIdx, ii = _sessionItemIdx;
      if (ci < 0) return;
      if (ii > 0) {
        await _adamGoto(ci, ii - 1);
      } else if (ci > 0) {
        await _adamGoto(ci - 1, _sessionContainers[ci - 1].items.length - 1);
      }
    }
    const _mkOrigSkipToNext = mk.skipToNextItem?.bind(mk);
    mk.skipToNextItem = () => _adamNext(true);
    mk.skipToPreviousItem = _adamPrev;
    _adamNextRef = _adamNext;
    _adamPrevRef = _adamPrev;
    function _ownedGoto(ids, startId, label, closeGate) {
      const items = ids.slice();
      const target = startId && items.includes(startId) ? startId : items[0];
      let ci = _sessionContainers.findIndex((c) => c.items.length === items.length && c.items.every((v, i) => v === items[i]));
      if (ci < 0) {
        _sessionContainers.push({ items });
        ci = _sessionContainers.length - 1;
      }
      const ii = Math.max(0, _sessionContainers[ci].items.indexOf(target));
      if (_ADAM_DEBUG) console.log(`[MK-DBG] ${label} \u2192 owned change: ${items.length} track(s) ci=${ci} ii=${ii} target=${target}`);
      if (closeGate) closeGate();
      _allowCDNTransition = true;
      return _adamGoto(ci, ii).then(() => _ADAM_DEBUG && console.log(`[MK-DBG] ${label} \u2192 owned change dispatched`)).catch((err) => _ADAM_DEBUG && console.log(`[MK-DBG] ${label} \u2192 owned change failed:`, err?.message || err));
    }
    function _normalizeStartId(desc) {
      const raw = desc?.startWith?.id;
      if (!raw) return null;
      const stripped = raw.startsWith("a.") ? raw.slice(2) : raw;
      if (/^\d{6,}$/.test(stripped)) return stripped;
      const qItems = mk?.queue?.items;
      if (qItems?.length) {
        for (const it of qItems) {
          const lid = it?.id ?? it?.playParams?.id ?? it?.attributes?.playParams?.id;
          if (lid === raw || lid === stripped) {
            const cid = it?.playParams?.catalogId ?? it?.attributes?.playParams?.catalogId;
            if (cid && /^\d{6,}$/.test(String(cid))) return String(cid);
          }
        }
      }
      return _pendingExternalClickCatalogId || null;
    }
    function _resolvePlaylistCatalogIds() {
      if (!_pendingPlaylistFetch) return Promise.resolve([]);
      return Promise.race([
        _pendingPlaylistFetch,
        new Promise((res) => setTimeout(() => res(null), 3e3))
      ]).then(
        (result) => (result?.tracks || []).map((t) => t.cid).filter((id) => id && /^\d{6,}$/.test(id))
      ).catch(() => []);
    }
    function _updateTransportButtons() {
      const ci = _sessionContainerIdx, ii = _sessionItemIdx;
      const cur = _sessionContainers[ci];
      const repeat = mk.repeatMode ?? 0;
      const hasPrev = ci > 0 || ii > 0;
      const hasNext = repeat !== 0 || cur && (ii + 1 < cur.items.length || ci + 1 < _sessionContainers.length);
      const allBtns = document.querySelectorAll(
        '[data-testid*="skip-back"], [data-testid*="skip-forward"], [data-testid*="skip-previous"], [data-testid*="skip-next"], [data-testid*="transport-previous"], [data-testid*="transport-next"]'
      );
      for (const btn of allBtns) {
        const tid = (btn.getAttribute("data-testid") || "").toLowerCase();
        const isPrev = tid.includes("previous") || tid.includes("skip-back");
        const isNext = tid.includes("next") || tid.includes("skip-forward");
        if (isPrev) {
          btn.style.opacity = hasPrev ? "" : "0.35";
          btn.style.pointerEvents = hasPrev ? "" : "none";
        } else if (isNext) {
          btn.style.opacity = hasNext ? "" : "0.35";
          btn.style.pointerEvents = hasNext ? "" : "none";
        }
      }
      const labelBtns = document.querySelectorAll('[aria-label*="skip" i], [aria-label*="previous track" i], [aria-label*="next track" i]');
      for (const btn of labelBtns) {
        const label = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (label.includes("up next")) continue;
        const isPrev = label.includes("previous") || label.includes("back");
        const isNext = label.includes("next") || label.includes("forward");
        if (isPrev) {
          btn.style.opacity = hasPrev ? "" : "0.35";
          btn.style.pointerEvents = hasPrev ? "" : "none";
        } else if (isNext) {
          btn.style.opacity = hasNext ? "" : "0.35";
          btn.style.pointerEvents = hasNext ? "" : "none";
        }
      }
    }
    function mprisTrackId(item) {
      const id = item?.id ?? item?.playParams?.id ?? item?.attributes?.playParams?.id ?? "unknown";
      return `/com/apple/music/track/${String(id).replace(/[^A-Za-z0-9_]/g, "_")}`;
    }
    function sendMprisMetadata(item) {
      if (!window.adamBridge?.mprisUpdate || !item) return;
      const a = item.attributes ?? {};
      const artTemplate = a.artwork?.url ?? "";
      const artUrl = artTemplate.replace("{w}", "1000").replace("{h}", "1000");
      const meta = {
        "mpris:trackid": mprisTrackId(item),
        "mpris:length": Math.round((a.durationInMillis ?? 0) * 1e3),
        "xesam:title": a.name ?? "",
        "xesam:artist": [a.artistName ?? ""],
        "xesam:album": a.albumName ?? "",
        "mpris:artUrl": artUrl
      };
      if (a.albumArtistName || a.artistName) meta["xesam:albumArtist"] = [a.albumArtistName ?? a.artistName];
      if (Array.isArray(a.genreNames) && a.genreNames.length) meta["xesam:genre"] = a.genreNames;
      if (Number.isFinite(a.trackNumber)) meta["xesam:trackNumber"] = a.trackNumber;
      if (Number.isFinite(a.discNumber)) meta["xesam:discNumber"] = a.discNumber;
      if (a.composerName) meta["xesam:composer"] = [a.composerName];
      if (a.releaseDate) meta["xesam:contentCreated"] = a.releaseDate;
      if (Number.isFinite(a.userRating)) meta["xesam:userRating"] = Math.max(0, Math.min(1, a.userRating / 5));
      if (Number.isFinite(a.popularity)) meta["xesam:autoRating"] = Math.max(0, Math.min(1, a.popularity / 100));
      const iid = extractItemId(item);
      if (iid && iid in _lovedState) meta["xesam:userRating"] = _lovedState[iid] ? 1 : 0;
      window.adamBridge.mprisUpdate({
        metadata: meta,
        shuffle: mk.shuffleMode === 1
      });
    }
    _reemitMpris = () => {
      try {
        sendMprisMetadata(mk.nowPlayingItem);
      } catch (_) {
      }
    };
    function sendMprisStatus(status, { isResume = false } = {}) {
      const seeked = isResume && status === "Playing" && _vlcPosMs > 0;
      window.adamBridge?.mprisUpdate?.({ status, position: _mprisPosMs() * 1e3, seeked });
    }
    function _pushMiniState() {
      const a = getMKAudio();
      window.adamBridge?.mprisUpdate?.({
        volume: a && Number.isFinite(a.volume) ? Math.round(a.volume * 100) : 100,
        repeat: mk.repeatMode ?? 0,
        shuffle: mk.shuffleMode === 1,
        loved: !!_lovedState[_currentAssetId]
      });
    }
    _pushMiniStateRef = _pushMiniState;
    window.adamBridge?.onMiniSync?.(() => {
      try {
        if (mk.nowPlayingItem) sendMprisMetadata(mk.nowPlayingItem);
        _pushMiniState();
        const playing = mk.playbackState === window.MusicKit?.PlaybackStates?.playing;
        window.adamBridge?.mprisUpdate?.({ status: playing ? "Playing" : "Paused", position: _mprisPosMs() * 1e3 });
      } catch (_) {
      }
    });
    window.adamBridge?.onMprisCmd?.((cmd) => {
      if (cmd && typeof cmd === "object") {
        if (cmd.type === "seek") {
          const targetMs = Math.max(0, _mprisPosMs() + cmd.deltaMs);
          mk.seekToTime(targetMs / 1e3);
          window.adamBridge?.mprisUpdate?.({ position: targetMs * 1e3, seeked: true });
        } else if (cmd.type === "setPosition") {
          const targetMs = Math.max(0, cmd.ms);
          mk.seekToTime(targetMs / 1e3);
          window.adamBridge?.mprisUpdate?.({ position: targetMs * 1e3, seeked: true });
        } else if (cmd.type === "setLoopStatus") {
          const loopMap = { "None": 0, "Track": 1, "Playlist": 2 };
          const mode = loopMap[cmd.value];
          if (mode != null) {
            mk.repeatMode = mode;
            _pushMiniState();
          }
        } else if (cmd.type === "shuffle") {
          mk.shuffleMode = cmd.value ? 1 : 0;
        } else if (cmd.type === "setVolume") {
          const v = Math.max(0, Math.min(1, cmd.value / 100));
          if (_activeMvControls) {
            try {
              _activeMvControls.volume = v;
            } catch (_) {
            }
          } else {
            const a = getMKAudio();
            if (a) {
              try {
                a.volume = v;
              } catch (_) {
              }
            }
          }
          _pushMiniState();
        } else if (cmd.type === "repeat") {
          const cur = mk.repeatMode ?? 0;
          mk.repeatMode = cur === 0 ? 2 : cur === 2 ? 1 : 0;
          _pushMiniState();
        } else if (cmd.type === "love") {
          _toggleLove().then(() => _pushMiniState());
        }
        return;
      }
      switch (cmd) {
        case "play":
          mk.play().catch(() => {
          });
          break;
        case "pause":
          mk.pause();
          break;
        case "playpause":
          mk.playbackState === window.MusicKit?.PlaybackStates?.playing ? mk.pause() : mk.play().catch(() => {
          });
          break;
        case "next":
          _adamNext(true).catch(() => {
          });
          break;
        case "previous":
          if (mk.currentPlaybackTime > 3) mk.seekToTime(0);
          else _adamPrev().catch(() => {
          });
          break;
      }
    });
    mk.addEventListener("shuffleModeDidChange", () => {
      window.adamBridge?.mprisUpdate?.({ shuffle: mk.shuffleMode === 1 });
    });
    mk.addEventListener("repeatModeDidChange", () => {
      window.adamBridge?.mprisUpdate?.({ repeat: mk.repeatMode ?? 0 });
    });
    const _qId = (item) => item?.id ?? item?.playParams?.id ?? item?.attributes?.playParams?.id ?? null;
    function _prewarmLibraryPlaylist(playlistId) {
      return fetch(ENGINE + "/api/v1/library/playlists/" + encodeURIComponent(playlistId) + "/tracks").then((r) => r.ok ? r.json() : null).catch(() => null);
    }
    document.addEventListener("click", (e) => {
      if (e.target.closest(".contextual-menu")) return;
      const _dbgPlaySel = e.target.closest(
        '[data-testid="play-button"], [data-testid="click-action"], [data-testid="library-track"], .primary-actions__button--play, [class*="play-button"]'
        // any play-button class variant
        // NOTE: [aria-label*="Play"] removed — matches product-lockup nav links (false positive)
      );
      if (!_vlcMode && _dbgPlaySel) {
        console.log("[Adam AAC-GATE] click caught vlc=" + _vlcMode + " sel=" + (_dbgPlaySel?.dataset?.testid || _dbgPlaySel?.className?.toString()?.slice(0, 30) || "?"));
        if (_dbgPlaySel?.dataset?.testid === "click-action" && (_dbgPlaySel?.href?.includes("/music-video/") || !!e.target?.closest?.('[class*="vertical-video"]'))) {
          console.log("[Adam AAC-GATE] MV click-action \u2014 skipping interceptor, allowing navigation");
          return;
        }
        if (_allowCDNTransition) return;
        const _aacMkAudio = getMKAudio();
        if (_aacMkAudio) {
          try {
            delete _aacMkAudio.load;
          } catch (_) {
          }
          try {
            delete _aacMkAudio.play;
          } catch (_) {
          }
          try {
            delete _aacMkAudio.paused;
          } catch (_) {
          }
          try {
            delete _aacMkAudio.pause;
          } catch (_) {
          }
        }
        _proxyInstalled = false;
        _msePaused = false;
        _ourBlobUrl = null;
        _pendingExternalClickCatalogId = null;
        _pendingExternalClickQueueIdx = -1;
        let aacCatalogId = null;
        let aacSetQueueDesc = null;
        let _domWalkIsMV = false;
        try {
          let el2 = e.target;
          if (e.target?.closest?.('[class*="vertical-video"]')) _domWalkIsMV = true;
          for (let depth = 0; depth < 12 && el2; depth++) {
            const did = el2.dataset?.id || el2.dataset?.contentId || el2.dataset?.songId;
            if (did) {
              const numId = did.startsWith("a.") ? did.slice(2) : did;
              if (/^\d{7,12}$/.test(numId)) {
                aacCatalogId = numId;
                if (_domWalkIsMV) {
                  _itemTypes.set(aacCatalogId, "music-videos");
                  aacSetQueueDesc = { musicVideo: aacCatalogId };
                }
                break;
              }
            }
            if (el2.tagName === "A" && el2.href) {
              const mvM = el2.href.match(/\/music-video\/[^/]+\/(\d{7,12})(?:[/?#]|$)/);
              if (mvM) {
                aacCatalogId = mvM[1];
                _itemTypes.set(aacCatalogId, "music-videos");
                aacSetQueueDesc = { musicVideo: aacCatalogId };
                break;
              }
              const m = el2.href.match(/\/(\d{7,12})(?:[/?#]|$)/);
              if (m) {
                aacCatalogId = m[1];
                break;
              }
            }
            if (el2.className && typeof el2.className === "string" && el2.className.includes("vertical-video")) {
              _domWalkIsMV = true;
            }
            el2 = el2.parentElement;
          }
        } catch (_) {
        }
        _pendingPlaylistFetch = null;
        let _aacPlaylistId = null;
        if (!aacCatalogId) {
          try {
            const href = location.href;
            let m;
            if (m = href.match(/\/music-video\/[^/]+\/(\d{7,12})(?:[/?#]|$)/)) {
              aacCatalogId = m[1];
              _itemTypes.set(aacCatalogId, "music-videos");
              aacSetQueueDesc = { musicVideo: aacCatalogId };
            } else if (m = href.match(/\/song\/[^/]+\/(\d{7,12})(?:[/?#]|$)/)) {
              aacCatalogId = m[1];
              aacSetQueueDesc = { song: aacCatalogId };
            } else if (m = href.match(/\/album\/[^/]+\/(\d{7,12})(?:[/?#]|$)/)) {
              aacSetQueueDesc = { album: m[1] };
            } else if (m = href.match(/\/playlist\/[^/]+\/(pl\.[A-Za-z0-9]+)(?:[/?#]|$)/)) {
              aacSetQueueDesc = { playlist: m[1] };
            }
          } catch (_) {
          }
        }
        try {
          const m = location.href.match(/\/library\/playlist\/(p\.[A-Za-z0-9]+)/);
          if (m) {
            _aacPlaylistId = m[1];
            _pendingPlaylistFetch = _prewarmLibraryPlaylist(_aacPlaylistId);
          }
        } catch (_) {
        }
        _pendingExternalClickCatalogId = aacCatalogId;
        _directPlayPromise = aacCatalogId ? _triggerDirectPlay(aacCatalogId, mk) : null;
        if (_directPlayPromise) _directPlayPromise.catch(() => {
        });
        if (_ADAM_DEBUG) console.log("[Adam click] external play in AAC mode \u2014 opening CDN gate playbackState=" + mk.playbackState + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null") + " catalogId=" + (aacCatalogId || "not-found") + (aacSetQueueDesc ? " desc=" + JSON.stringify(aacSetQueueDesc) : "") + (_aacPlaylistId ? " playlist=" + _aacPlaylistId + " (pre-fetching)" : "") + " target=" + (e.target?.tagName || "?") + " testId=" + (e.target?.closest("[data-testid]")?.dataset?.testid || "none") + " matched=" + (_dbgPlaySel?.dataset?.testid || _dbgPlaySel?.className?.toString()?.slice(0, 40) || "?"));
        _allowCDNTransition = true;
        const _aacMkApiSaved = {
          setQueue: mk.setQueue,
          changeToMediaAtIndex: mk.changeToMediaAtIndex
        };
        const _aacRestoreApi = () => {
          mk.setQueue = _aacMkApiSaved.setQueue;
          mk.changeToMediaAtIndex = _aacMkApiSaved.changeToMediaAtIndex;
          _savedAacApiRestore = null;
        };
        if (_savedAacApiRestore) _savedAacApiRestore();
        _savedAacApiRestore = _aacRestoreApi;
        const _aacCloseGate = () => {
          if (_externalPlayGateTimer) {
            clearTimeout(_externalPlayGateTimer);
            _externalPlayGateTimer = null;
          }
          _allowCDNTransition = false;
          _pendingExternalClickCatalogId = null;
          _pendingExternalClickQueueIdx = -1;
          _pendingPlaylistFetch = null;
          if (_savedAacApiRestore) {
            _savedAacApiRestore();
            _savedAacApiRestore = null;
          }
          if (_savedGateTracingCleanup) {
            _savedGateTracingCleanup();
            _savedGateTracingCleanup = null;
          }
        };
        const _aacOwnedGoto = (ids, startId, label) => _ownedGoto(ids, startId, label, _aacCloseGate);
        mk.setQueue = (...a) => {
          const desc = a[0];
          if (_ADAM_DEBUG) console.log("[MK-DBG AAC] mk.setQueue() args=" + JSON.stringify(a).slice(0, 400));
          if (desc?.playlists && desc?.startWith?.id) {
            const startWithLid = desc.startWith?.id ?? null;
            if (_ADAM_DEBUG) console.log("[MK-DBG AAC] playlists \u2192 resolving pre-fetched tracks, startWithLid=" + startWithLid);
            const fetchResult = _pendingPlaylistFetch ? Promise.race([_pendingPlaylistFetch, new Promise((res) => setTimeout(() => res(null), 3e3))]) : Promise.resolve(null);
            return fetchResult.then((result) => {
              const tracks = result?.tracks || [];
              const catalogIds = tracks.map((t) => t.cid).filter((id) => id && /^\d{6,}$/.test(id));
              if (catalogIds.length > 1) {
                const _lidNumeric = startWithLid?.startsWith("a.") ? startWithLid.slice(2) : startWithLid;
                let startCid = _pendingExternalClickCatalogId || (/^\d{6,}$/.test(_lidNumeric) ? _lidNumeric : null);
                if (!startCid && startWithLid) {
                  const match = tracks.find((t) => t.lid === startWithLid || t.lid === startWithLid.replace(/^[a-z]\./, ""));
                  startCid = match?.cid ?? null;
                }
                if (_ADAM_DEBUG) console.log("[MK-DBG AAC] playlists \u2192 " + catalogIds.length + " tracks, startCid=" + startCid);
                return _aacOwnedGoto(catalogIds, startCid, "playlist/local");
              }
              if (_ADAM_DEBUG) console.log("[MK-DBG AAC] playlists \u2192 cache cold, passthrough");
              if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
              _externalPlayGateTimer = setTimeout(() => {
                if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout)");
                _aacCloseGate();
              }, 45e3);
              const p2 = _aacMkApiSaved.setQueue.apply(mk, a);
              if (p2?.then) p2.then(
                () => _ADAM_DEBUG && console.log("[MK-DBG AAC] playlists \u2192 passthrough resolved"),
                (err) => {
                  if (_ADAM_DEBUG) console.log("[MK-DBG AAC] playlists \u2192 passthrough rejected:", err?.message || err);
                  _aacCloseGate();
                }
              );
              return p2;
            });
          }
          if (desc?.albums?.length === 1 && typeof desc.albums[0] === "string" && desc.albums[0].startsWith("l.")) {
            const albumId = desc.albums[0];
            const startWithLid = desc.startWith?.id ?? null;
            if (_ADAM_DEBUG) console.log("[MK-DBG AAC] albums \u2192 querying local cache for " + albumId);
            const fetchPromise = fetch(`${ENGINE}/api/v1/library/albums/${encodeURIComponent(albumId)}/tracks`).then((r) => r.ok ? r.json() : null).catch(() => null);
            return Promise.race([fetchPromise, new Promise((res) => setTimeout(() => res(null), 3e3))]).then((result) => {
              const tracks = result?.tracks || [];
              const catalogIds = tracks.map((t) => t.cid).filter((id) => id && /^\d{6,}$/.test(id));
              if (catalogIds.length > 0) {
                if (_ADAM_DEBUG) console.log("[MK-DBG AAC] albums \u2192 local cache: " + catalogIds.length + " tracks");
                const startCid = startWithLid ? (tracks.find((t) => t.lid === startWithLid) || {}).cid : _pendingExternalClickCatalogId || null;
                return _aacOwnedGoto(catalogIds, startCid, "albums/local");
              }
              if (_ADAM_DEBUG) console.log("[MK-DBG AAC] albums \u2192 cache cold, fetching tracks via MK REST");
              if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
              _externalPlayGateTimer = setTimeout(() => {
                if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout)");
                _aacCloseGate();
              }, 2e4);
              const mkInst = window.MusicKit?.getInstance?.();
              const directFetch = mkInst ? mkInst.api.music(`/v1/me/library/albums/${encodeURIComponent(albumId)}/tracks`, { limit: 100 }).then((res) => res?.data?.data || []).catch(() => []) : Promise.resolve([]);
              return directFetch.then((items) => {
                const directIds = items.map((item) => {
                  const pp = item?.attributes?.playParams;
                  return pp?.catalogId || (pp?.isLibrary ? null : pp?.id) || null;
                }).filter((id) => id && /^\d{6,}$/.test(id));
                if (directIds.length > 0) {
                  if (_ADAM_DEBUG) console.log("[MK-DBG AAC] albums \u2192 REST fetch: " + directIds.length + " tracks (store for next time)");
                  const cacheTracks = items.map((item) => ({
                    id: item.id,
                    attributes: item.attributes,
                    relationships: item.relationships || {}
                  }));
                  fetch(`${ENGINE}/api/v1/library/ingest`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ songs: cacheTracks, albums: [], playlists: {}, playlistTracks: {} })
                  }).catch(() => {
                  });
                  const startCid = startWithLid ? (() => {
                    const match = items.find((item) => item.id === startWithLid);
                    const pp = match?.attributes?.playParams;
                    return pp?.catalogId || (pp?.isLibrary ? null : pp?.id) || null;
                  })() : _pendingExternalClickCatalogId || null;
                  return _aacOwnedGoto(directIds, startCid, "albums/REST");
                }
                const _coldTimeout = mk.playbackState === 2 ? 65e3 : 45e3;
                if (_ADAM_DEBUG) console.log("[MK-DBG AAC] albums \u2192 REST empty, last-resort Apple setQueue (timeout=" + _coldTimeout / 1e3 + "s)");
                if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
                _externalPlayGateTimer = setTimeout(() => {
                  if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout after setQueue)");
                  _aacCloseGate();
                }, _coldTimeout);
                const p2 = _aacMkApiSaved.setQueue.apply(mk, a);
                if (p2?.then) p2.then(
                  () => _ADAM_DEBUG && console.log("[MK-DBG AAC] setQueue resolved"),
                  (err) => {
                    if (_ADAM_DEBUG) console.log("[MK-DBG AAC] setQueue rejected:", err?.message || err);
                    _aacCloseGate();
                  }
                );
                return p2;
              });
            });
          }
          const startWithId = _normalizeStartId(desc);
          if (startWithId) {
            const swType = desc?.startWith?.type;
            if (swType === "albums") {
              if (_ADAM_DEBUG) console.log("[MK-DBG AAC] startWith type=albums, id=" + startWithId + " \u2192 fetching tracks");
              if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
              _externalPlayGateTimer = setTimeout(() => {
                if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout)");
                _aacCloseGate();
              }, 2e4);
              const mkInst = window.MusicKit?.getInstance?.();
              const albumFetch = mkInst ? mkInst.api.music(`/v1/catalog/${mkInst.storefrontId}/albums/${encodeURIComponent(startWithId)}/tracks`, { limit: 100 }).then((res) => res?.data?.data || []).catch(() => []) : Promise.resolve([]);
              return albumFetch.then((items) => {
                const trackIds = items.map((item) => item?.id).filter((id) => id && /^\d{6,}$/.test(id));
                if (trackIds.length > 0) {
                  if (_ADAM_DEBUG) console.log("[MK-DBG AAC] album resolved: " + trackIds.length + " tracks");
                  return _aacOwnedGoto(trackIds, trackIds[0], "albums/catalog");
                }
                if (_ADAM_DEBUG) console.log("[MK-DBG AAC] album fetch empty, passthrough");
                const p2 = _aacMkApiSaved.setQueue.apply(mk, a);
                if (p2?.then) p2.then(
                  () => _ADAM_DEBUG && console.log("[MK-DBG AAC] album passthrough resolved"),
                  (err) => {
                    if (_ADAM_DEBUG) console.log("[MK-DBG AAC] album passthrough rejected:", err?.message || err);
                    _aacCloseGate();
                  }
                );
                return p2;
              });
            }
            if (swType === "playlists") {
              if (_ADAM_DEBUG) console.log("[MK-DBG AAC] startWith type=playlists, id=" + startWithId + " \u2192 resolving");
              return _resolvePlaylistCatalogIds().then((catalogIds) => {
                if (catalogIds.length > 1) {
                  return _aacOwnedGoto(catalogIds, catalogIds[0], "playlists/startWith");
                }
                if (_ADAM_DEBUG) console.log("[MK-DBG AAC] playlist resolve empty, passthrough");
                if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
                _externalPlayGateTimer = setTimeout(() => {
                  if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout)");
                  _aacCloseGate();
                }, 45e3);
                const p2 = _aacMkApiSaved.setQueue.apply(mk, a);
                if (p2?.then) p2.then(
                  () => _ADAM_DEBUG && console.log("[MK-DBG AAC] playlists passthrough resolved"),
                  (err) => {
                    if (_ADAM_DEBUG) console.log("[MK-DBG AAC] playlists passthrough rejected:", err?.message || err);
                    _aacCloseGate();
                  }
                );
                return p2;
              });
            }
            if (swType === "music-videos" || desc?.url?.includes("/music-video/")) {
              _itemTypes.set(startWithId, "music-videos");
            }
            const albumUrlId = typeof desc?.url === "string" ? desc.url.match(/\/album\/[^/?#]+\/(\d{6,})/)?.[1] : null;
            const mkInstAlbum = window.MusicKit?.getInstance?.();
            if (albumUrlId && mkInstAlbum?.storefrontId) {
              if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
              _externalPlayGateTimer = setTimeout(() => {
                if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout)");
                _aacCloseGate();
              }, 2e4);
              return mkInstAlbum.api.music(`/v1/catalog/${mkInstAlbum.storefrontId}/albums/${encodeURIComponent(albumUrlId)}/tracks`, { limit: 100 }).then((res) => res?.data?.data || []).catch(() => []).then((items) => {
                const trackIds = items.map((item) => item?.id).filter((id) => id && /^\d{6,}$/.test(id));
                if (trackIds.includes(startWithId)) {
                  return _aacOwnedGoto(trackIds, startWithId, "album/startWith");
                }
                return _aacOwnedGoto([startWithId], startWithId, "startWith");
              });
            }
            return _aacOwnedGoto([startWithId], startWithId, "startWith");
          }
          if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
          _externalPlayGateTimer = setTimeout(() => {
            if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout after setQueue)");
            _aacCloseGate();
          }, 45e3);
          const p = _aacMkApiSaved.setQueue.apply(mk, a);
          if (p?.then) p.then(
            () => _ADAM_DEBUG && console.log("[MK-DBG AAC] setQueue resolved"),
            (err) => {
              if (_ADAM_DEBUG) console.log("[MK-DBG AAC] setQueue rejected:", err?.message || err);
              _aacCloseGate();
            }
          );
          return p;
        };
        mk.changeToMediaAtIndex = (idx) => {
          if (_ADAM_DEBUG) console.log("[MK-DBG AAC] mk.changeToMediaAtIndex(" + idx + ")");
          const p = _aacMkApiSaved.changeToMediaAtIndex.call(mk, idx);
          if (p?.then) p.then(
            () => _ADAM_DEBUG && console.log("[MK-DBG AAC] ctmi resolved"),
            (err) => _ADAM_DEBUG && console.log("[MK-DBG AAC] ctmi rejected:", err?.message || err)
          );
          return p;
        };
        const _aacGateAudioEl = getMKAudio();
        const _aacGateEvts = ["pause", "play", "playing", "waiting", "stalled", "error", "emptied", "loadstart", "canplay", "canplaythrough", "ended"];
        const _aacGateEvtHandler = (ev) => {
          const el2 = _aacGateAudioEl;
          if (_ADAM_DEBUG) console.log("[AUDIO-EVT] " + ev.type + " paused=" + el2?.paused + " readyState=" + el2?.readyState + " src=" + (el2?.src || "").slice(0, 60));
        };
        if (_aacGateAudioEl) _aacGateEvts.forEach((t) => _aacGateAudioEl.addEventListener(t, _aacGateEvtHandler));
        const _aacGateStateListener = () => _ADAM_DEBUG && console.log("[MK-DBG] playbackStateDidChange \u2192 " + mk.playbackState + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null"));
        mk.addEventListener("playbackStateDidChange", _aacGateStateListener);
        const _aacGateTracingCleanup = () => {
          if (_aacGateAudioEl) _aacGateEvts.forEach((t) => _aacGateAudioEl.removeEventListener(t, _aacGateEvtHandler));
          mk.removeEventListener("playbackStateDidChange", _aacGateStateListener);
        };
        if (typeof _savedGateTracingCleanup === "function") _savedGateTracingCleanup();
        _savedGateTracingCleanup = _aacGateTracingCleanup;
        if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
        _externalPlayGateTimer = setTimeout(() => {
          if (_ADAM_DEBUG) console.log("[Adam click] AAC CDN gate reset (safety timeout)");
          _aacCloseGate();
        }, 2e4);
        const _aacDesc = _domWalkIsMV && _isVideoId(aacCatalogId) ? null : aacSetQueueDesc ?? (aacCatalogId ? { song: aacCatalogId } : null);
        if (_aacDesc) {
          _aacMkApiSaved.setQueue.call(mk, _aacDesc).then(() => _aacMkApiSaved.setQueue && mk.play()).catch(() => {
          });
        }
        return;
      }
      if (_vlcMode && _dbgPlaySel) {
        console.log("[Adam VLC-GATE] click caught vlc=" + _vlcMode + " saved=" + !!_mkApiSaved + " sel=" + (_dbgPlaySel?.dataset?.testid || _dbgPlaySel?.className?.toString()?.slice(0, 30) || "?"));
        if (_dbgPlaySel?.dataset?.testid === "click-action" && (_dbgPlaySel?.href?.includes("/music-video/") || !!e.target?.closest?.('[class*="vertical-video"]'))) {
          console.log("[Adam VLC-GATE] MV click-action \u2014 skipping interceptor, allowing navigation");
          return;
        }
        if (_mkApiSaved) return;
        const mkAudioEl = getMKAudio();
        if (mkAudioEl) {
          try {
            delete mkAudioEl.load;
          } catch (_) {
          }
          try {
            delete mkAudioEl.play;
          } catch (_) {
          }
          try {
            delete mkAudioEl.paused;
          } catch (_) {
          }
          try {
            delete mkAudioEl.currentTime;
          } catch (_) {
          }
        }
        _proxyInstalled = false;
        stopVLCPoll();
        _pendingExternalClickCatalogId = null;
        _pendingExternalClickQueueIdx = -1;
        try {
          let el2 = e.target;
          for (let depth = 0; depth < 12 && el2; depth++) {
            const did = el2.dataset?.id || el2.dataset?.contentId || el2.dataset?.songId;
            if (did) {
              const numId = did.startsWith("a.") ? did.slice(2) : did;
              if (/^\d{7,12}$/.test(numId)) {
                _pendingExternalClickCatalogId = numId;
                break;
              }
            }
            if (el2.tagName === "A" && el2.href) {
              const m = el2.href.match(/\/(\d{7,12})(?:[/?#]|$)/);
              if (m) {
                _pendingExternalClickCatalogId = m[1];
                break;
              }
            }
            el2 = el2.parentElement;
          }
        } catch (_) {
        }
        try {
          const qItems = mk.queue?.items;
          if (qItems?.length && _pendingExternalClickCatalogId) {
            _pendingExternalClickQueueIdx = qItems.findIndex((it) => extractItemId(it) === _pendingExternalClickCatalogId);
          }
          if (_ADAM_DEBUG && qItems?.length && !window._adamQueueItemDumped) {
            window._adamQueueItemDumped = true;
            const it = qItems[0];
            const allKeys = /* @__PURE__ */ new Set();
            let proto = it;
            while (proto && proto !== Object.prototype) {
              Object.getOwnPropertyNames(proto).forEach((k) => allKeys.add(k));
              proto = Object.getPrototypeOf(proto);
            }
            const dump = {};
            for (const k of allKeys) {
              try {
                dump[k] = it[k];
              } catch (_) {
              }
            }
            console.log("[Adam queue-item dump]", JSON.stringify(dump, (_, v) => typeof v === "function" ? "[fn]" : v, 2).slice(0, 4e3));
          }
        } catch (_) {
        }
        _pendingPlaylistFetch = null;
        let _pendingPlaylistId = null;
        try {
          const m = location.href.match(/\/library\/playlist\/(p\.[A-Za-z0-9]+)/);
          if (m) {
            _pendingPlaylistId = m[1];
            _pendingPlaylistFetch = _prewarmLibraryPlaylist(_pendingPlaylistId);
          }
        } catch (_) {
        }
        if (_ADAM_DEBUG) console.log("[Adam click] external play while VLC active \u2014 opening CDN gate playbackState=" + mk.playbackState + " adamGotoTarget=" + _adamGotoTarget + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null") + " catalogId=" + (_pendingExternalClickCatalogId || "not-found") + (_pendingPlaylistId ? " playlist=" + _pendingPlaylistId + " (pre-fetching)" : ""));
        _allowCDNTransition = true;
        _ourBlobUrl = null;
        _mkApiSaved = { play: mk.play, setQueue: mk.setQueue, changeToMediaAtIndex: mk.changeToMediaAtIndex };
        mk.play = (...a) => {
          console.log("[VLC-MK] mk.play() state=" + mk.playbackState);
          const p = _mkApiSaved.play.apply(mk, a);
          if (p?.then) p.then(() => console.log("[VLC-MK] mk.play() resolved"), (e2) => console.log("[VLC-MK] mk.play() rejected:", e2?.message || e2));
          return p;
        };
        mk.setQueue = (...a) => {
          console.log("[VLC-MK] mk.setQueue() args=" + JSON.stringify(a).slice(0, 200));
          const desc = a[0];
          if (desc?.playlists && desc?.startWith?.id) {
            const targetId = desc.startWith.id;
            const isLibraryTrack = targetId.startsWith("a.") || targetId.startsWith("i.");
            if (isLibraryTrack) {
              const startWithLid = targetId;
              const targetNumId = targetId.startsWith("a.") ? targetId.slice(2) : targetId;
              const domCatalogId = _pendingExternalClickCatalogId || (/^\d{6,}$/.test(targetNumId) ? targetNumId : null);
              const fetchPromise = _pendingPlaylistFetch ? Promise.race([_pendingPlaylistFetch, new Promise((res) => setTimeout(() => res(null), 3e3))]) : Promise.resolve(null);
              return fetchPromise.then((result) => {
                const tracks = result?.tracks || [];
                const catalogIds = tracks.map((t) => t.cid).filter((id) => id && /^\d{6,}$/.test(id));
                if (catalogIds.length > 1) {
                  let catalogId = domCatalogId;
                  if (!catalogId && startWithLid) {
                    const match = tracks.find((t) => t.lid === startWithLid || t.lid === startWithLid.replace(/^[a-z]\./, ""));
                    catalogId = match?.cid ?? null;
                  }
                  if (_ADAM_DEBUG) console.log("[MK-DBG] setQueue \u2192 local cache: " + catalogIds.length + " tracks, startWith=" + catalogId);
                  const pDesc = { songs: catalogIds };
                  if (catalogId && catalogIds.includes(catalogId)) pDesc.startWith = { id: catalogId };
                  const p2 = _mkApiSaved.setQueue.call(mk, pDesc);
                  if (p2?.then) p2.then(() => _ADAM_DEBUG && console.log("[MK-DBG] local cache resolved"), (e2) => _ADAM_DEBUG && console.log("[MK-DBG] local cache rejected:", e2?.message || String(e2)));
                  return p2;
                }
                if (_ADAM_DEBUG) console.log("[MK-DBG] setQueue \u2192 passthrough (cache cold) startWithLid=" + startWithLid);
                const p = _mkApiSaved.setQueue.apply(mk, a);
                if (p?.then) p.then(() => _ADAM_DEBUG && console.log("[MK-DBG] passthrough resolved"), (e2) => _ADAM_DEBUG && console.log("[MK-DBG] passthrough rejected:", e2?.message || String(e2)));
                return p;
              });
            }
          }
          const _vlcGotoById = (id) => {
            if (_pendingExternalClickQueueIdx >= 0 && id) {
              const mkQ = mk.queue?.items;
              const slotIt = mkQ?.[_pendingExternalClickQueueIdx];
              if (slotIt && extractItemId(slotIt) === id) {
                const ci2 = _sessionContainerIdx;
                const cur2 = _sessionContainers[ci2];
                if (cur2) {
                  if (!cur2.items.includes(id)) cur2.items.push(id);
                  const ii = cur2.items.indexOf(id);
                  console.log("[Adam VLC] \u2192 _adamGoto(" + ci2 + "," + ii + ") id=" + id + " via click-idx=" + _pendingExternalClickQueueIdx);
                  _adamGoto(ci2, ii).catch(() => {
                  });
                  return true;
                }
              }
            }
            for (let c = 0; c < _sessionContainers.length; c++) {
              const ii = (_sessionContainers[c]?.items ?? []).indexOf(id);
              if (ii >= 0) {
                console.log("[Adam VLC] \u2192 _adamGoto(" + c + "," + ii + ") id=" + id);
                _adamGoto(c, ii).catch(() => {
                });
                return true;
              }
            }
            const mkQ2 = mk.queue?.items;
            const ci = _sessionContainerIdx;
            const cur = _sessionContainers[ci];
            if (cur && mkQ2?.length && mkQ2.findIndex((it) => extractItemId(it) === id) >= 0) {
              if (!cur.items.includes(id)) cur.items.push(id);
              const ii = cur.items.indexOf(id);
              console.log("[Adam VLC] \u2192 _adamGoto(" + ci + "," + ii + ") id=" + id + " (added to container)");
              _adamGoto(ci, ii).catch(() => {
              });
              return true;
            }
            return false;
          };
          if (desc?.url && desc?.startWith?.id) {
            const startId = _normalizeStartId(desc);
            if (startId) {
              if (_vlcGotoById(startId)) return;
              console.log("[Adam VLC] url-setQueue \u2192 passthrough (not in queue, id=" + startId + ")");
            }
          }
          const clickId = _pendingExternalClickCatalogId;
          if (clickId) {
            if (_vlcGotoById(clickId)) return;
            console.log("[Adam VLC] setQueue(" + Object.keys(desc ?? {}).join("/") + ") \u2192 passthrough (id=" + clickId + " not in queue)");
          }
          console.log("[Adam VLC] passthrough with teardown \u2014 handing off to MK");
          const _origSQ = _mkApiSaved.setQueue;
          if (_externalPlayGateTimer) {
            clearTimeout(_externalPlayGateTimer);
            _externalPlayGateTimer = null;
          }
          stopVLCPoll();
          unbridgeDuration();
          const _vlcStopped = leaveLossless({
            live: true,
            nextMode: "aac",
            stop: () => fetch(ENGINE + "/api/v1/vlc/stop", { method: "POST" })
          }).then((r) => {
            if (r.ok) _vlcLive = false;
          });
          deleteSession(_sessionId);
          _sessionId = null;
          _currentAssetId = null;
          _durationSec = 0;
          showQualityBadge(null);
          _vlcMode = false;
          const _ae = document.getElementById("apple-music-player");
          if (_ae) {
            for (const _p of ["load", "paused", "currentTime", "volume", "muted", "pause", "play"]) {
              try {
                delete _ae[_p];
              } catch (_) {
              }
            }
            try {
              _ae.pause();
              _ae.src = "";
              _ae.load();
            } catch (_) {
            }
          }
          mk.play = _mkApiSaved.play;
          mk.setQueue = _mkApiSaved.setQueue;
          mk.changeToMediaAtIndex = _mkApiSaved.changeToMediaAtIndex;
          _mkApiSaved = null;
          _allowCDNTransition = false;
          _pendingExternalClickCatalogId = null;
          _pendingExternalClickQueueIdx = -1;
          return _vlcStopped.then(() => _origSQ.apply(mk, a));
        };
        mk.changeToMediaAtIndex = (idx) => {
          console.log("[VLC-MK] mk.changeToMediaAtIndex(" + idx + ")");
          const p = _mkApiSaved.changeToMediaAtIndex.call(mk, idx);
          if (p?.then) p.then(() => console.log("[VLC-MK] ctmi(" + idx + ") resolved"), (e2) => console.log("[VLC-MK] ctmi(" + idx + ") rejected:", e2?.message || e2));
          return p;
        };
        const _gateAudioEl = getMKAudio();
        const _gateEvts = ["pause", "play", "playing", "waiting", "stalled", "error", "emptied", "loadstart", "canplay", "canplaythrough", "ended"];
        const _gateEvtHandler = (ev) => {
          const el2 = _gateAudioEl;
          if (_ADAM_DEBUG) console.log("[AUDIO-EVT] " + ev.type + " paused=" + el2?.paused + " readyState=" + el2?.readyState + " src=" + (el2?.src || "").slice(0, 60));
        };
        if (_gateAudioEl) _gateEvts.forEach((t) => _gateAudioEl.addEventListener(t, _gateEvtHandler));
        const _gateStateListener = () => _ADAM_DEBUG && console.log("[MK-DBG] playbackStateDidChange \u2192 " + mk.playbackState + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null"));
        mk.addEventListener("playbackStateDidChange", _gateStateListener);
        const _gateTracingCleanup = () => {
          if (_gateAudioEl) _gateEvts.forEach((t) => _gateAudioEl.removeEventListener(t, _gateEvtHandler));
          mk.removeEventListener("playbackStateDidChange", _gateStateListener);
        };
        if (typeof _savedGateTracingCleanup === "function") _savedGateTracingCleanup();
        _savedGateTracingCleanup = _gateTracingCleanup;
        if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
        _externalPlayGateTimer = setTimeout(() => {
          if (_mkApiSaved) {
            mk.play = _mkApiSaved.play;
            mk.setQueue = _mkApiSaved.setQueue;
            mk.changeToMediaAtIndex = _mkApiSaved.changeToMediaAtIndex;
            _mkApiSaved = null;
          }
          if (_savedGateTracingCleanup) {
            _savedGateTracingCleanup();
            _savedGateTracingCleanup = null;
          }
          _pendingExternalClickCatalogId = null;
          _pendingExternalClickQueueIdx = -1;
          _pendingPlaylistFetch = null;
          const el2 = getMKAudio();
          if (el2 && _vlcMode) {
            el2.load = () => {
            };
            Object.defineProperty(el2, "paused", { get: () => _vlcPaused, configurable: true });
            Object.defineProperty(el2, "currentTime", { get: () => _vlcPosMs / 1e3, set: () => {
            }, configurable: true });
            startVLCPoll(el2);
          }
          _allowCDNTransition = false;
          _externalPlayGateTimer = null;
          if (_ADAM_DEBUG) console.log("[Adam click] CDN gate reset (safety timeout)");
        }, 2e4);
      }
      const PS = window.MusicKit?.PlaybackStates;
      if (mk.playbackState !== PS?.playing && mk.playbackState !== PS?.paused) return;
      const pos = mk.queue?.position ?? 0;
      const snapNext = _qId(mk.queue?.items?.[pos + 1]);
      const snapNow = _qId(mk.nowPlayingItem);
      let done = false;
      const check = (itemChangeFired) => {
        if (done) return;
        done = true;
        mk.removeEventListener("queueItemsDidChange", onQueue);
        mk.removeEventListener("queueDidChange", onQueue);
        mk.removeEventListener("nowPlayingItemDidChange", onItem);
        if (itemChangeFired) return;
        const curPos = mk.queue?.position ?? 0;
        if (curPos !== pos) return;
        if ((_qId(mk.queue?.items?.[curPos]) ?? null) !== snapNow) return;
        const newNext = _qId(mk.queue?.items?.[curPos + 1]);
        if (newNext && newNext !== snapNext) {
          const ci = _sessionContainerIdx;
          const cur2 = _sessionContainers[ci];
          const intraIdx = cur2 ? cur2.items.indexOf(newNext) : -1;
          if (intraIdx >= 0 && intraIdx !== _sessionItemIdx + 1) {
            console.log("[adam] track-click: non-linear same-playlist jump to ci=", ci, "ii=", intraIdx);
            _adamGoto(ci, intraIdx).catch(() => {
            });
          } else {
            console.log("[adam] track-click: inserted at next, calling _adamNext");
            _adamNext(true).catch(() => {
            });
          }
        }
      };
      const onItem = () => check(true);
      const onQueue = () => check(false);
      mk.addEventListener("nowPlayingItemDidChange", onItem, { once: true });
      mk.addEventListener("queueItemsDidChange", onQueue, { once: true });
      mk.addEventListener("queueDidChange", onQueue, { once: true });
      setTimeout(() => check(false), 200);
    }, true);
    setupQueueHistory(mk);
    _resumeSetup(mk);
    _discordSetup(mk);
    _scrobbleSetup();
    _deepLinkSetup(mk);
    _authStateSetup(mk);
    _scSetup();
    _xfSetup();
    _hotkeysSetup();
    _installHoverPrewarm();
    mk.addEventListener("queueItemsDidChange", () => {
      const activeCur = _sessionContainers[_sessionContainerIdx];
      if (!activeCur) return;
      const mkLive = mk.queue?.items ?? [];
      _recordItemTypes(mkLive);
      const activeCurSet = new Set(activeCur.items);
      let added = 0;
      for (const mkItem of mkLive) {
        const id = extractItemId(mkItem);
        if (id && !activeCurSet.has(id)) {
          activeCur.items.push(id);
          activeCurSet.add(id);
          added++;
        }
      }
      if (added) {
        console.log(`[Adam Station] queueItemsDidChange \u2014 added ${added} new item(s) to container, total=${activeCur.items.length}`);
        _updateTransportButtons();
      }
    });
    mk.addEventListener("nowPlayingItemDidChange", async () => {
      console.log("[NPIDF] fired item=" + (mk.nowPlayingItem?.attributes?.name || "null") + " allowCDN=" + _allowCDNTransition + " adamGotoTarget=" + _adamGotoTarget);
      if (_adamGotoTarget !== null) {
        const item2 = mk.nowPlayingItem;
        if (!item2) return;
        const itemId = extractItemId(item2);
        const targetItem = mk.queue?.items?.[_adamGotoTarget];
        const targetId = _adamGotoTargetId || extractItemId(targetItem);
        if (targetId && itemId !== targetId) {
          console.log("[Adam] NPIDF filtered: spurious event for", item2?.attributes?.name, "(advancing to idx", _adamGotoTarget, "target id", targetId, ")");
          if (_allowCDNTransition || _mkApiSaved) {
            if (_mkApiSaved) {
              mk.play = _mkApiSaved.play;
              mk.setQueue = _mkApiSaved.setQueue;
              mk.changeToMediaAtIndex = _mkApiSaved.changeToMediaAtIndex;
              if (typeof _savedGateTracingCleanup === "function") {
                _savedGateTracingCleanup();
                _savedGateTracingCleanup = null;
              }
              _mkApiSaved = null;
            }
            _allowCDNTransition = false;
            clearTimeout(_externalPlayGateTimer);
            _externalPlayGateTimer = null;
            if (_adamPendingCI >= 0 && !_adamAdvancing) {
              const rCI = _adamPendingCI, rII = _adamPendingII;
              console.log("[Adam] NPIDF filter: gate closed \u2014 retrying _adamGoto ci=", rCI, "ii=", rII);
              setTimeout(() => _adamGoto(rCI, rII), 250);
            }
          }
          return;
        }
        _adamGotoTarget = null;
        _adamGotoTargetId = null;
        _adamInGotoTransition = false;
        _adamTransitioning = false;
        clearTimeout(_adamAdvancingTimer);
        _adamAdvancingTimer = null;
      }
      _clearAdvancing();
      let item = mk.nowPlayingItem;
      if (!item) {
        for (let i = 0; i < 5; i++) {
          await new Promise((r) => setTimeout(r, 50));
          item = mk.nowPlayingItem;
          if (item) break;
        }
      }
      if (_mkApiSaved && item) {
        clearTimeout(_externalPlayGateTimer);
        _externalPlayGateTimer = null;
        mk.play = _mkApiSaved.play;
        mk.setQueue = _mkApiSaved.setQueue;
        mk.changeToMediaAtIndex = _mkApiSaved.changeToMediaAtIndex;
        _mkApiSaved = null;
        if (typeof _savedGateTracingCleanup === "function") {
          _savedGateTracingCleanup();
          _savedGateTracingCleanup = null;
        }
        _pendingExternalClickCatalogId = null;
        _pendingExternalClickQueueIdx = -1;
        _pendingPlaylistFetch = null;
        _allowCDNTransition = false;
      }
      const wasInternal = _adamNavInternal;
      _adamNavInternal = false;
      if (item) {
        const songId = extractItemId(item);
        if (wasInternal && _adamPendingCI >= 0) {
          _sessionContainerIdx = _adamPendingCI;
          _sessionItemIdx = _adamPendingII;
          _adamPendingCI = -1;
          _adamPendingII = -1;
        } else if (songId) {
          const cur = _sessionContainers[_sessionContainerIdx];
          if (cur && cur.items[_sessionItemIdx] === songId) {
          } else if (cur && cur.items[_sessionItemIdx + 1] === songId) {
            _sessionItemIdx++;
          } else {
            const intraIdx = cur ? cur.items.indexOf(songId) : -1;
            if (intraIdx >= 0) {
              _sessionItemIdx = intraIdx;
            } else {
              let interIdx = -1;
              let interCI = -1;
              for (let ci = _sessionContainers.length - 1; ci >= 0; ci--) {
                if (ci === _sessionContainerIdx) continue;
                const idx = _sessionContainers[ci].items.indexOf(songId);
                if (idx >= 0) {
                  interCI = ci;
                  interIdx = idx;
                  break;
                }
              }
              if (interCI >= 0) {
                _sessionContainerIdx = interCI;
                _sessionItemIdx = interIdx;
              } else {
                const mkItems2 = mk.queue?.items ?? [];
                const mkPos2 = mk.queue?.position ?? 0;
                const newIds = mkItems2.map(extractItemId).filter(Boolean);
                if (newIds.length) {
                  const curItems = cur?.items ?? [];
                  const newIdsSet = new Set(newIds);
                  const sameCtx = curItems.length >= 2 && curItems.every((id) => newIdsSet.has(id));
                  if (sameCtx) {
                    const curSet = new Set(curItems);
                    for (const id of newIds) {
                      if (!curSet.has(id)) {
                        cur.items.push(id);
                        curSet.add(id);
                      }
                    }
                    _sessionItemIdx = cur.items.indexOf(songId);
                  } else {
                    _sessionContainers.push({ items: newIds });
                    _sessionContainerIdx = _sessionContainers.length - 1;
                    _sessionItemIdx = mkPos2;
                  }
                }
              }
            }
          }
        }
        const activeCur = _sessionContainers[_sessionContainerIdx];
        if (activeCur) {
          const mkLive = mk.queue?.items ?? [];
          _recordItemTypes(mkLive);
          const activeCurSet = new Set(activeCur.items);
          for (const mkItem of mkLive) {
            const id = extractItemId(mkItem);
            if (id && !activeCurSet.has(id)) {
              activeCur.items.push(id);
              activeCurSet.add(id);
            }
          }
        }
      }
      handleTrackChange(mk);
      _updateTransportButtons();
      window._adamSmartCache?.onTrackChange(mk);
      if (item) {
        const id = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
        window._adamSmartCache?.recordPlay(id);
        sendMprisMetadata(item);
      } else {
        sendMprisStatus("Stopped");
      }
    });
    mk.addEventListener("playbackStateDidChange", () => {
      const PS = window.MusicKit?.PlaybackStates;
      console.log(`[Adam Engine] state=${mk.playbackState} (playing=${PS?.playing})`);
      const s = mk.playbackState;
      if (s === PS?.playing) {
        if (!_vlcMode || _vlcPosMs > 0) sendMprisStatus("Playing", { isResume: _vlcPaused });
      } else if (s === PS?.paused) {
        sendMprisStatus("Paused");
      } else if (s === PS?.stopped || s === PS?.none) {
        sendMprisStatus("Stopped");
      }
      if (!_vlcMode) return;
      if (s === PS?.playing) {
        if (_vlcPaused) {
          console.log("[Adam VLC] playbackStateDidChange \u2192 playing \u2192 resume");
          _vlcPaused = false;
          fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
          });
        }
      } else if (s === PS?.paused) {
        console.log("[Adam VLC] playbackStateDidChange \u2192 paused \u2192 pause");
        _vlcPaused = true;
        fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
        });
      }
    });
    const cache = window._adamSmartCache;
    if (cache) {
      cache.observeNavigation(() => mk);
      cache.warmOnStartup(mk);
    }
    if (mk.nowPlayingItem) handleTrackChange(mk);
  }
  setup().catch((e) => console.error("[Adam Engine] setup:", e));
  (function initSearchSuggestionsPortal() {
    let portaled = null;
    function positionPortal(el2) {
      const bar = document.querySelector('[class*="search-input-wrapper"]');
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      el2.style.setProperty("position", "fixed", "important");
      el2.style.setProperty("top", r.bottom + 6 + "px", "important");
      el2.style.setProperty("left", r.left + "px", "important");
      el2.style.setProperty("width", r.width + "px", "important");
      el2.style.setProperty("z-index", "9999", "important");
    }
    function doPortal(sugg) {
      if (portaled === sugg) return;
      portaled = sugg;
      sugg.remove();
      positionPortal(sugg);
      document.body.appendChild(sugg);
    }
    function tryScan() {
      const bar = document.querySelector('[class*="search-input-wrapper"]');
      if (!bar) return false;
      const sugg = bar.querySelector('[class*="search-suggestions"]');
      if (!sugg) return false;
      doPortal(sugg);
      return true;
    }
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const sugg = node.matches('[class*="search-suggestions"]') ? node : node.querySelector('[class*="search-suggestions"]');
          if (sugg && sugg.closest('[class*="search-input-wrapper"]')) {
            doPortal(sugg);
            return;
          }
        }
        for (const node of m.removedNodes) {
          if (node.nodeType !== 1) continue;
          const gone = node.matches('[class*="search-suggestions"]') ? node : node.querySelector('[class*="search-suggestions"]');
          if (gone === portaled) portaled = null;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    function wireSearchInput(input) {
      if (!input || input._adamPortalWired) return;
      input._adamPortalWired = true;
      function startPoll() {
        if (tryScan()) return;
        let attempts = 0;
        const t = setInterval(() => {
          if (tryScan() || ++attempts >= 20) clearInterval(t);
        }, 30);
      }
      input.addEventListener("input", startPoll);
      input.addEventListener("focus", startPoll);
    }
    function attachToSearchInput() {
      wireSearchInput(document.querySelector(
        '#search-input__text-field, [class*="search-input__text-field"]'
      ));
    }
    attachToSearchInput();
    watchDomSettled(attachToSearchInput);
    window.addEventListener("resize", () => {
      if (portaled) positionPortal(portaled);
    }, { passive: true });
  })();
  (function initTracklistStatsInHeader() {
    let statsEl = null;
    let restEl = null;
    let lastText = null;
    const COPYRIGHT = /^[℗©]/;
    const DATE = /\b(19|20)\d{2}\b/;
    const COUNT = /\d+\s*(songs?|videos?|episodes?|items?|tracks?)\b|\b\d+\s*(minutes?|mins?|hours?|hrs?|hr)\b/i;
    function splitLines(text) {
      const up = [], stay = [];
      for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        if (!COPYRIGHT.test(line) && (COUNT.test(line) || DATE.test(line))) up.push(line);
        else stay.push(line);
      }
      return { up, stay };
    }
    function sync() {
      const header = document.querySelector('[class*="container-detail-header"]:not([class*="wrapper"])');
      if (!header) {
        if (statsEl) {
          statsEl.remove();
          statsEl = null;
        }
        if (restEl) {
          restEl.remove();
          restEl = null;
        }
        lastText = null;
        return;
      }
      const headings = header.querySelector('[class*="headings"]:not([class*="primary"]):not([class*="secondary"])');
      if (!headings) return;
      const src = document.querySelector('[data-testid="tracklist-footer-description"]') || document.querySelector('[class*="tracklist-footer"] p[class*="description"]');
      const text = src?.textContent ?? "";
      const { up, stay } = splitLines(text);
      if (!statsEl || !headings.contains(statsEl)) {
        statsEl?.remove();
        statsEl = document.createElement("p");
        statsEl.id = "adam-tracklist-stats";
        headings.appendChild(statsEl);
        lastText = null;
      }
      if (src && (!restEl || restEl.previousElementSibling !== src)) {
        restEl?.remove();
        restEl = document.createElement("p");
        restEl.id = "adam-tracklist-footer-rest";
        src.after(restEl);
        lastText = null;
      }
      if (text !== lastText) {
        statsEl.textContent = up.join("\n");
        statsEl.style.display = up.length ? "" : "none";
        if (restEl) {
          restEl.className = src.className;
          restEl.textContent = stay.join("\n");
          restEl.style.display = stay.length ? "" : "none";
        }
        lastText = text;
      }
      if (src) {
        src.style.display = "none";
        if (src.parentElement?.style.display === "none") src.parentElement.style.display = "";
      }
    }
    watchDomSettled(sync);
  })();
  (function initArtTheme() {
    const BODY_VARS = [
      "--adam-nav-bg",
      "--adam-nav-border",
      "--adam-accent",
      "--adam-accent-active",
      "--keyColor",
      "--adam-art-page-bg",
      "--adam-art-glow-a",
      "--adam-art-glow-b",
      "--adam-art-raised",
      "--adam-art-on-accent",
      "--adam-art-src"
    ];
    const BG_LAYER_IDS = ["_adamBlurBg", "_adamAccentBg", "_adamCustomBg", "_adamArtBlur", "_adamArtBg"];
    let enabled = true;
    let lastSrc = null;
    let token = 0;
    const style = document.createElement("style");
    style.id = "adam-art-theme-style";
    style.textContent = `
        /* \u2500\u2500 hide Apple's full-page artwork wash \u2500\u2500 */
        [data-adam-page-art] { visibility: hidden !important; }

        /* \u2500\u2500 blurred artwork backdrop \u2500\u2500 */
        /* Sits below the gradient glow layer. ::before = blurred artwork fill;
           ::after = palette-tinted dark overlay so content stays legible. */
        #_adamArtBlur {
            position: fixed; inset: 0; z-index: 0; pointer-events: none;
            opacity: 0; transition: opacity .8s ease;
            overflow: hidden;
        }
        #_adamArtBlur::before {
            content: ''; position: absolute; inset: -8%;
            background-image: var(--adam-art-src, none);
            background-size: cover; background-position: center;
            filter: blur(80px) saturate(1.6);
        }
        #_adamArtBlur::after {
            content: ''; position: absolute; inset: 0;
            background: var(--adam-nav-bg, rgba(0,0,0,0.35));
            opacity: 0.55;
        }
        body[data-adam-art-theme] #_adamArtBlur { opacity: 1; }

        /* \u2500\u2500 Mode isolation: hide wallpaper blur layers in non-blur modes \u2500\u2500 */
        /* main.mjs injects #_adamBlurBg + #_adamBlurTint for blur mode but
           never removes them. When the user switches to accent or custom CSS the layers
           must disappear so they don't bleed through as ghost colours. */
        body[data-adam-mode="accent"] #_adamBlurBg,
        body[data-adam-mode="accent"] #_adamBlurTint,
        body[data-adam-mode="custom"] #_adamBlurBg,
        body[data-adam-mode="custom"] #_adamBlurTint { opacity: 0 !important; transition: opacity .4s ease !important; }

        /* \u2500\u2500 gradient glow layer (sits above the blur) \u2500\u2500 */
        /* pageBg removed \u2014 the blur layer's tint overlay provides the dark base. */
        #_adamArtBg {
            position: fixed; inset: 0; z-index: 0; pointer-events: none;
            opacity: 0; transition: opacity .6s ease;
            background:
                radial-gradient(60% 55% at 12% 8%, var(--adam-art-glow-a, transparent), transparent 70%),
                radial-gradient(55% 50% at 92% 88%, var(--adam-art-glow-b, transparent), transparent 70%);
        }
        body[data-adam-art-theme] #_adamArtBg { opacity: 1; }

        /* \u2500\u2500 page body: hue-tinted dark base \u2500\u2500 */
        body[data-adam-art-theme] { background: var(--adam-art-page-bg) !important; }
        body[data-adam-art-theme] .body-container,
        body[data-adam-art-theme] .app-container,
        body[data-adam-art-theme] main,
        body[data-adam-art-theme] .content-container,
        body[data-adam-art-theme] [data-main-content],
        body[data-adam-art-theme] .scrollable-page,
        body[data-adam-art-theme] .album-container,
        body[data-adam-art-theme] .section,
        body[data-adam-art-theme] .section-content,
        body[data-adam-art-theme] .container-detail-header,
        body[data-adam-art-theme] .container-detail-header-wrapper { background: transparent !important; }
        /* Remove section dividers that show as black lines */
        body[data-adam-art-theme] .section,
        body[data-adam-art-theme] .album-container,
        body[data-adam-art-theme] .container-detail-header { border-color: var(--adam-nav-border) !important; }

        /* \u2500\u2500 navigation sidebar \u2500\u2500 */
        body[data-adam-art-theme] nav.navigation {
            background: var(--adam-nav-bg) !important;
            border-right-color: var(--adam-nav-border) !important;
        }
        body[data-adam-art-theme] .navigation-item__link:hover { background: var(--adam-art-raised) !important; }
        body[data-adam-art-theme] .navigation-item--selected .navigation-item__link { background: var(--adam-accent-active) !important; }
        body[data-adam-art-theme] .navigation-item--selected .navigation-item__label,
        body[data-adam-art-theme] .navigation-item--selected .navigation-item__icon { color: var(--adam-accent) !important; }

        /* \u2500\u2500 footer player bar \u2500\u2500 */
        /* Leave Apple's player bar completely unstyled. The --keyColor override on
           body[data-adam-art-theme] (see keyColor propagation below) already swaps
           the accent colour (play button, scrubber fill, etc.) from pink to the
           art-derived accent. No background, blur or clip-path changes needed. */
        /* Light text on nav sidebar, side panel and context menus */
        body[data-adam-art-theme] nav.navigation,
        body[data-adam-art-theme] .side-panel,
        body[data-adam-art-theme] .contextual-menu { color: rgba(255,255,255,0.85) !important; }
        body[data-adam-art-theme] .navigation-items__header { color: rgba(255,255,255,0.5) !important; }
        body[data-adam-art-theme] .search-input__text-field { color: rgba(255,255,255,0.85) !important; }

        /* \u2500\u2500 tracklist rows \u2500\u2500 */
        body[data-adam-art-theme] .songs-list-row { border-color: var(--adam-nav-border) !important; }
        body[data-adam-art-theme] .songs-list-row:hover,
        body[data-adam-art-theme] .library-track:not(.library-track--header):hover { background: var(--adam-art-raised) !important; }
        body[data-adam-art-theme] .songs-list-row.songs-list-row--selected,
        body[data-adam-art-theme] .library-track.is-playing { background: var(--adam-accent-active) !important; }
        body[data-adam-art-theme] .songs-list__header,
        body[data-adam-art-theme] .library-track--header { background: transparent !important; }

        /* \u2500\u2500 primary actions (Play / Shuffle / Add) \u2500\u2500 */
        body[data-adam-art-theme] .primary-actions__button--play button {
            background: var(--adam-accent) !important; color: var(--adam-art-on-accent) !important;
        }
        body[data-adam-art-theme] .primary-actions__button--play button svg,
        body[data-adam-art-theme] .primary-actions__button--play button svg path { fill: var(--adam-art-on-accent) !important; }
        body[data-adam-art-theme] .primary-actions__button--shuffle button,
        body[data-adam-art-theme] .primary-actions__button--add-to-library button { background: var(--adam-art-raised) !important; }

        /* \u2500\u2500 context menus \u2500\u2500 */
        body[data-adam-art-theme] .contextual-menu {
            background: var(--adam-nav-bg) !important;
            border: 1px solid var(--adam-nav-border) !important;
            backdrop-filter: blur(20px) !important;
            -webkit-backdrop-filter: blur(20px) !important;
        }
        body[data-adam-art-theme] .contextual-menu-item > button:hover,
        body[data-adam-art-theme] .contextual-menu-item > a:hover { background: var(--adam-art-raised) !important; }

        /* \u2500\u2500 search \u2500\u2500 */
        body[data-adam-art-theme] .search-input__text-field,
        body[data-adam-art-theme] .search-input-wrapper { background: var(--adam-art-raised) !important; }
        body[data-adam-art-theme] .search-scope-bar__pill-option--selected {
            background: var(--adam-accent) !important; color: var(--adam-art-on-accent) !important;
        }

        /* \u2500\u2500 side panel / Up Next \u2500\u2500 */
        body[data-adam-art-theme] .side-panel {
            background: var(--adam-nav-bg) !important;
            border-left-color: var(--adam-nav-border) !important;
            backdrop-filter: blur(20px) !important;
            -webkit-backdrop-filter: blur(20px) !important;
        }
        body[data-adam-art-theme] .up-next-item:hover { background: var(--adam-art-raised) !important; }

        /* \u2500\u2500 shelf / grid \u2500\u2500 */
        body[data-adam-art-theme] .shelf,
        body[data-adam-art-theme] section.shelf-grid,
        body[data-adam-art-theme] .shelf-grid__body { background: transparent !important; }

        /* \u2500\u2500 keyColor propagation for amp-* web components \u2500\u2500 */
        body[data-adam-art-theme] { --keyColor: var(--adam-accent); }
    `;
    (document.head || document.documentElement).appendChild(style);
    function markPageArt() {
      const vw = innerWidth, vh = innerHeight;
      for (const el2 of document.querySelectorAll(".artwork-component:not([data-adam-page-art])")) {
        if (el2.closest('[class*="lockup"], [class*="shelf"], nav, [class*="player"], [class*="lcd"], [class*="artwork__main"], [class*="artist-header"]')) continue;
        const r = el2.getBoundingClientRect();
        if (r.width >= vw * 0.6 && r.height >= vh * 0.6) el2.setAttribute("data-adam-page-art", "");
      }
    }
    function ensureBgLayers() {
      let ref = document.body.firstElementChild;
      while (ref && BG_LAYER_IDS.includes(ref.id)) ref = ref.nextElementSibling;
      if (!document.getElementById("_adamArtBg")) {
        const l = document.createElement("div");
        l.id = "_adamArtBg";
        document.body.insertBefore(l, ref);
      }
      if (!document.getElementById("_adamArtBlur")) {
        const l = document.createElement("div");
        l.id = "_adamArtBlur";
        document.body.insertBefore(l, document.getElementById("_adamArtBg"));
      }
    }
    function apply(roles, artSrc) {
      const b = document.body.style;
      b.setProperty("--adam-nav-bg", navColorWithAlphaVar(roles.navBg));
      b.setProperty("--adam-nav-border", roles.border);
      b.setProperty("--adam-accent", roles.accent);
      b.setProperty("--adam-accent-active", roles.accentActive);
      b.setProperty("--keyColor", roles.accent);
      b.setProperty("--adam-art-page-bg", roles.pageBg);
      b.setProperty("--adam-art-glow-a", roles.glowA);
      b.setProperty("--adam-art-glow-b", roles.glowB);
      b.setProperty("--adam-art-raised", roles.raised);
      b.setProperty("--adam-art-on-accent", roles.onAccent);
      b.setProperty("--adam-art-src", artSrc ? `url("${artSrc.replace(/"/g, "%22")}")` : "none");
      ensureBgLayers();
      document.body.setAttribute("data-adam-art-theme", "");
    }
    function clear() {
      if (!document.body) return;
      for (const v of BODY_VARS) document.body.style.removeProperty(v);
      document.body.removeAttribute("data-adam-art-theme");
    }
    async function computeRoles(src, headerArt) {
      try {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.src = src;
        await im.decode();
        const cv = document.createElement("canvas");
        cv.width = cv.height = 40;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.drawImage(im, 0, 0, 40, 40);
        const roles = paletteRoles(extractPalette(cx.getImageData(0, 0, 40, 40).data));
        if (roles) return roles;
      } catch (_) {
      }
      const hex = headerArt?.style.getPropertyValue("--artwork-bg-color").trim() ?? "";
      const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
      if (!m) return null;
      const [h, s, l] = rgbToHsl(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
      return paletteRoles([{ h, s, l, weight: 1 }]);
    }
    async function sync() {
      if (!document.body) return;
      markPageArt();
      if (!enabled) {
        if (lastSrc !== null || document.body.hasAttribute("data-adam-art-theme")) {
          clear();
          lastSrc = null;
          token++;
        }
        return;
      }
      const img = document.querySelector(".container-detail-header .artwork__main img");
      let src = img ? img.currentSrc || "" : null;
      if (img && (!src || /1x1\.gif$/.test(src))) {
        img.addEventListener("load", sync, { once: true });
        return;
      }
      if (!src) {
        if (lastSrc !== null) {
          clear();
          lastSrc = null;
          token++;
        }
        return;
      }
      if (src === lastSrc) return;
      lastSrc = src;
      const my = ++token;
      const roles = await computeRoles(src, img?.closest(".artwork-component"));
      if (my !== token || !enabled) return;
      if (roles) apply(roles, src);
      else clear();
    }
    window.addEventListener("adam:art-theme", (e) => {
      enabled = !!e.detail;
      lastSrc = null;
      sync();
    });
    window.adamBridge?.getPrefs?.().then((p) => {
      if (!document.body) return;
      enabled = p?.artTheme !== false;
      if (p?.artThemeMode) window.adamBridge.setTweak("artThemeMode", null);
      const startupMode = p?.signedIn ? p?.themeMode || "accent" : "blur";
      document.body.setAttribute("data-adam-mode", startupMode);
      sync();
    }).catch(() => {
    });
    watchDomSettled(sync);
    window.addEventListener("resize", markPageArt, { passive: true });
    (function hookMusicKit() {
      const mk = window.MusicKit?.getInstance?.();
      if (mk) {
        mk.addEventListener("nowPlayingItemDidChange", sync);
        mk.addEventListener("playbackStateDidChange", sync);
        return;
      }
      document.addEventListener("musickitloaded", hookMusicKit, { once: true });
      const t = setInterval(() => {
        if (window.MusicKit?.getInstance?.()) {
          hookMusicKit();
          clearInterval(t);
        }
      }, 500);
      setTimeout(() => clearInterval(t), 2e4);
    })();
  })();
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason?.message ?? "";
    if (msg.includes("play() method was called without a previous") || msg.includes("lyrics are not being displayed") || msg.includes("lyrics are already being displayed")) {
      e.preventDefault();
    }
  });
  window.adamClearSession = function() {
    stopVLCPoll();
    if (_pipeCtrl) {
      _pipeCtrl.abort();
      _pipeCtrl = null;
    }
    if (_abortCtrl) {
      _abortCtrl.abort();
      _abortCtrl = null;
    }
    if (_seekFetchCtrl) {
      _seekFetchCtrl.abort();
      _seekFetchCtrl = null;
    }
    deleteSession(_sessionId);
    _sessionId = null;
    _currentAssetId = null;
    _durationSec = 0;
    _vlcMode = false;
    _vlcPosMs = 0;
    _ourBlobUrl = null;
    if (_nextAlacSession) {
      deleteSession(_nextAlacSession.sess.sessionId);
      _nextAlacSession = null;
    }
    _nextAlacTried = false;
    _nextAlacRetries = 0;
    if (_nextAacSession) {
      deleteSession(_nextAacSession.sess.sessionId);
      _nextAacSession = null;
    }
    _nextAacTried = false;
    _discardNextAacStream();
    if (_nextMvSession) {
      deleteSession(_nextMvSession.sess.sessionId);
      _nextMvSession = null;
    }
    _nextMvTried = false;
    for (const [, { sess }] of _hoverSessions) deleteSession(sess.sessionId);
    _hoverSessions.clear();
    _hoverInflight.clear();
    unbridgeDuration();
    try {
      _mkInstance?.pause?.();
    } catch (_) {
    }
    console.log("[Adam] adamClearSession: all playback stopped and session released");
  };
  window.adamStartSession = async function(adamId, sf) {
    const mk = _mkInstance;
    if (!mk) {
      console.warn("[Adam] adamStartSession: no MK instance");
      return null;
    }
    const storefront = sf ?? mk.storefrontId ?? "us";
    const losslessWanted = _engineCaps.lossless && _streamingQuality !== "high-quality";
    console.log(`[Adam] adamStartSession adamId=${adamId} sf=${storefront} lossless=${losslessWanted}`);
    const r = await fetch(`${ENGINE}/api/v1/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: adamId,
        storefront,
        capabilities: { lossless: losslessWanted, atmos: false, video: false },
        token: mk.developerToken ?? "",
        mediaUserToken: getMUT()
      })
    });
    if (!r.ok) {
      console.error(`[Adam] adamStartSession: engine ${r.status}`);
      return null;
    }
    const sess = await r.json();
    console.log(`[Adam] adamStartSession: session=${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
    return sess;
  };
  window.adamGetQueueInfo = function() {
    const mk = _mkInstance;
    return {
      items: mk?.queue?.items ?? [],
      position: mk?.queue?.position ?? -1,
      nowPlaying: mk?.nowPlayingItem ?? null,
      storefrontId: mk?.storefrontId ?? "us",
      sessionId: _sessionId,
      codec: _vlcMode ? "alac/vlc" : "aac/mse",
      durationSec: _durationSec,
      posMs: _vlcPosMs
    };
  };
  (function setupEngineSettings() {
    if (!window.adamBridge) return;
    const FF = "font-family:-apple-system,SF Pro Text,system-ui,sans-serif;";
    function dot(ok) {
      const d = document.createElement("span");
      d.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${ok ? "#34c759" : "#ff3b30"};`;
      return d;
    }
    function makeSection(title) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-top:28px;";
      const h = document.createElement("h2");
      h.textContent = title;
      h.style.cssText = FF + "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.07em;color:rgba(255,255,255,0.38);margin:0 0 7px;padding-left:2px;";
      const body = document.createElement("div");
      body.style.cssText = "background:rgba(255,255,255,0.07);border:0.5px solid rgba(255,255,255,0.1);border-radius:12px;padding:0 14px;";
      wrap.appendChild(h);
      wrap.appendChild(body);
      return { wrap, body };
    }
    function makeRow(label, val, subtitle, isLast) {
      const r = document.createElement("div");
      r.style.cssText = "display:flex;align-items:center;padding:12px 0;" + (isLast ? "" : "border-bottom:0.5px solid rgba(255,255,255,0.07);");
      const lbl = document.createElement("div");
      lbl.style.cssText = "flex:1;";
      const m = document.createElement("div");
      m.style.cssText = FF + "font-size:13px;color:rgba(255,255,255,0.88);line-height:1.3;";
      m.textContent = label;
      lbl.appendChild(m);
      if (subtitle) {
        const s = document.createElement("div");
        s.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.36);margin-top:2px;line-height:1.4;";
        s.textContent = subtitle;
        lbl.appendChild(s);
      }
      r.appendChild(lbl);
      r.appendChild(val);
      return r;
    }
    function statusVal(text, ok) {
      const v = document.createElement("div");
      v.style.cssText = FF + "display:flex;align-items:center;gap:6px;font-size:13px;color:rgba(255,255,255,0.5);";
      if (ok !== void 0) v.appendChild(dot(ok));
      v.appendChild(document.createTextNode(text));
      return v;
    }
    function makeBtn(text) {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = FF + "padding:6px 14px;border-radius:8px;border:none;font-size:13px;cursor:pointer;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.88);white-space:nowrap;transition:background 0.15s;";
      b.onmouseenter = () => {
        b.style.background = "rgba(255,255,255,0.2)";
      };
      b.onmouseleave = () => {
        b.style.background = "rgba(255,255,255,0.12)";
      };
      return b;
    }
    function makeInput(type, placeholder) {
      const inp = document.createElement("input");
      inp.type = type;
      inp.placeholder = placeholder;
      inp.style.cssText = FF + "width:100%;box-sizing:border-box;padding:8px 10px;margin-top:8px;border-radius:6px;border:0.5px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.85);font-size:13px;outline:none;";
      return inp;
    }
    async function fetchDRM() {
      const r = await fetch(`${ENGINE}/api/v1/drm/status`);
      return r.json();
    }
    function buildAccountSection(drm, onRefresh) {
      const { wrap, body } = makeSection("Engine Account");
      const drmState = drm?.state ?? drm ?? {};
      const managerOk = drmState?.manager === "ready";
      const processOk = drmState?.process === "running";
      const fairplayOk = drmState?.fairplay === "ready";
      const cbcsOk = drm?.capabilities?.cbcs === true;
      const isSignedIn = cbcsOk || fairplayOk;
      function renderState() {
        body.innerHTML = "";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:10px;padding:11px 0;";
        row.appendChild(dot(isSignedIn));
        const text = document.createElement("div");
        text.style.cssText = "flex:1;";
        const main = document.createElement("div");
        main.style.cssText = FF + "font-size:13px;color:rgba(255,255,255,0.85);";
        main.textContent = isSignedIn ? "Signed in" : "Not signed in";
        text.appendChild(main);
        if (!isSignedIn) {
          const sub = document.createElement("div");
          sub.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.38);margin-top:2px;";
          if (!managerOk) {
            sub.textContent = "DRM engine not ready. Check engine logs.";
          } else if (!processOk) {
            sub.textContent = "DRM backend not loaded. Restart the app.";
          } else {
            sub.textContent = "Sign in to enable lossless and hi-res playback";
          }
          text.appendChild(sub);
        }
        if (isSignedIn) {
          const sub = document.createElement("div");
          sub.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.38);margin-top:2px;";
          sub.textContent = "Signing out removes your account from this computer. Signing in again here normally needs no code.";
          text.appendChild(sub);
        }
        row.appendChild(text);
        const btn = makeBtn(isSignedIn ? "Sign Out" : "Sign In\u2026");
        btn.onclick = isSignedIn ? () => runSignOut("account", btn, "Signing out\u2026") : () => _accountSheet().openSignIn();
        row.appendChild(btn);
        body.appendChild(row);
        const forgetRow = document.createElement("div");
        forgetRow.style.cssText = "display:flex;align-items:center;gap:10px;padding:0 0 11px 18px;";
        const forgetText = document.createElement("div");
        forgetText.style.cssText = FF + "flex:1;font-size:11px;color:rgba(255,255,255,0.38);";
        forgetText.textContent = "Forget this device: Apple will treat this computer as new.";
        const forget = makeBtn("Forget This Device\u2026");
        forget.style.fontSize = "12px";
        forget.style.padding = "4px 10px";
        let armed = false;
        forget.onclick = () => {
          if (!armed) {
            armed = true;
            forget.textContent = "Forget Device";
            forget.style.background = "#fc3c44";
            forget.onmouseenter = forget.onmouseleave = null;
            forgetText.textContent = "The next sign-in will ask for a verification code. Click again to confirm.";
            return;
          }
          runSignOut("device", forget, "Forgetting\u2026");
        };
        forgetRow.append(forgetText, forget);
        body.appendChild(forgetRow);
        if (_accountNote) {
          const note = document.createElement("div");
          note.style.cssText = FF + "font-size:11px;padding:0 0 11px 18px;color:" + (_accountNote.error ? "#ff6961" : "rgba(255,255,255,0.45)") + ";";
          note.textContent = _accountNote.text;
          body.appendChild(note);
          _accountNote = null;
        }
      }
      async function runSignOut(scope, button, busyText) {
        button.disabled = true;
        button.textContent = busyText;
        const res = await signOutFlow({
          engine: ENGINE,
          scope,
          clearCredentials: window.adamBridge?.drmClearCredentials
        });
        if (res.message) _accountNote = { text: res.message, error: true };
        else if (res.note) _accountNote = { text: res.note, error: false };
        onRefresh();
      }
      _onAccountSignedIn = onRefresh;
      renderState();
      return wrap;
    }
    function getDialog() {
      let dlg = document.getElementById("adam-settings-dialog");
      if (dlg) return dlg;
      dlg = document.createElement("dialog");
      dlg.id = "adam-settings-dialog";
      const st = document.createElement("style");
      st.textContent = `
            #adam-settings-dialog {
                position:fixed; inset:0; margin:auto;
                width:min(660px,calc(100vw - 48px));
                max-height:min(82vh,760px); overflow-y:auto;
                border:0.5px solid rgba(255,255,255,0.14); border-radius:16px;
                background:rgba(18,18,20,0.78);
                backdrop-filter:blur(48px) saturate(1.9);
                -webkit-backdrop-filter:blur(48px) saturate(1.9);
                box-shadow:0 32px 80px rgba(0,0,0,0.8),0 0 0 0.5px rgba(255,255,255,0.07);
                padding:0 32px 32px; color:rgba(255,255,255,0.9);
                font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
                --adam-settings-accent:#fc3c44;
            }
            #adam-settings-dialog :where(input,button,select,textarea):focus-visible {
                outline:2px solid var(--adam-settings-accent) !important;
                outline-offset:2px;
            }
            #adam-settings-dialog :where(input[type="range"],input[type="checkbox"],input[type="radio"]) {
                accent-color:var(--adam-settings-accent) !important;
            }
            #adam-settings-close {
                position:sticky; top:18px; float:right; z-index:10;
                margin-left:auto; flex-shrink:0;
            }
            #adam-settings-dialog::backdrop {
                background:rgba(0,0,0,0.35);
                backdrop-filter:blur(20px) saturate(1.4);
                -webkit-backdrop-filter:blur(20px) saturate(1.4);
            }
            #adam-settings-dialog::-webkit-scrollbar { width:4px; }
            #adam-settings-dialog::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.18);border-radius:2px; }
            @keyframes _adam-pop-in  { from{opacity:0;transform:scale(0.94) translateY(10px)} to{opacity:1;transform:scale(1) translateY(0)} }
            @keyframes _adam-pop-out { from{opacity:1;transform:scale(1) translateY(0)}       to{opacity:0;transform:scale(0.96) translateY(5px)} }
            @keyframes _adam-bd-in   { from{opacity:0} to{opacity:1} }
            @keyframes _adam-bd-out  { from{opacity:1} to{opacity:0} }
            @keyframes _adam-spin    { to{transform:rotate(360deg)} }
            ._adam-spinner { display:inline-block;width:10px;height:10px;border:1.5px solid rgba(255,255,255,0.18);border-top-color:rgba(255,255,255,0.6);border-radius:50%;animation:_adam-spin .7s linear infinite;flex-shrink:0; }
            #adam-settings-dialog.adam-opening { animation:_adam-pop-in  .32s cubic-bezier(.34,1.4,.64,1) forwards; }
            #adam-settings-dialog.adam-closing { animation:_adam-pop-out .2s  cubic-bezier(.32,0,.67,0) forwards; }
            #adam-settings-dialog.adam-opening::backdrop { animation:_adam-bd-in  .28s ease forwards; }
            #adam-settings-dialog.adam-closing::backdrop { animation:_adam-bd-out .18s ease-in forwards; }
        `;
      document.head.appendChild(st);
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        document.querySelectorAll(".adam-qdrop-menu").forEach((m) => {
          m.style.display = "none";
        });
        if (e.target === dlg) closeSettings();
      }, true);
      return dlg;
    }
    function closeSettings() {
      _hotkeyCapture = null;
      const dlg = document.getElementById("adam-settings-dialog");
      if (!dlg?.open) return;
      dlg.classList.replace("adam-opening", "adam-closing") || dlg.classList.add("adam-closing");
      dlg.addEventListener("animationend", () => {
        dlg.classList.remove("adam-closing");
        dlg.close();
      }, { once: true });
    }
    function _adamMiniBtn(onClick) {
      const b = document.createElement("button");
      b.innerHTML = _svgReset;
      b.title = "Reset to default";
      b.style.cssText = FF + "width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.12);border-radius:5px;color:rgba(255,255,255,0.35);cursor:pointer;transition:all 0.15s;";
      b.onmouseenter = () => {
        b.style.background = "rgba(255,255,255,0.12)";
        b.style.color = "rgba(255,255,255,0.7)";
      };
      b.onmouseleave = () => {
        b.style.background = "rgba(255,255,255,0.06)";
        b.style.color = "rgba(255,255,255,0.35)";
      };
      b.onclick = onClick;
      return b;
    }
    function _adamIOSToggle(on, onChange) {
      let _on = !!on;
      const track = document.createElement("div");
      track.style.cssText = "position:relative;width:34px;height:20px;border-radius:10px;background:" + (_on ? "#fc3c44" : "rgba(255,255,255,0.2)") + ";cursor:pointer;flex-shrink:0;transition:background 0.2s;box-sizing:border-box;";
      const thumb = document.createElement("div");
      thumb.style.cssText = "position:absolute;top:2px;left:" + (_on ? "16px" : "2px") + ";width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);transition:left 0.22s cubic-bezier(0.34,1.4,0.64,1);";
      track.appendChild(thumb);
      track.addEventListener("click", () => {
        _on = !_on;
        track.style.background = _on ? "#fc3c44" : "rgba(255,255,255,0.2)";
        thumb.style.left = _on ? "16px" : "2px";
        onChange(_on);
      });
      track._cb = {
        get checked() {
          return _on;
        },
        set checked(v) {
          _on = !!v;
          track.style.background = _on ? "#fc3c44" : "rgba(255,255,255,0.2)";
          thumb.style.left = _on ? "16px" : "2px";
        }
      };
      return track;
    }
    function _adamMakeQualityDropdown(prefKey, prefs, qualityOpts, onChange) {
      const saved = prefs[prefKey] ?? "lossless";
      let current = saved;
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;display:inline-block;";
      const btn = document.createElement("div");
      btn.className = "adam-qdrop-btn";
      const btnLabel = document.createElement("span");
      btnLabel.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const chevron = document.createElement("span");
      chevron.className = "adam-qdrop-chevron";
      chevron.innerHTML = "&#9660;";
      btn.append(btnLabel, chevron);
      const menu = document.createElement("div");
      menu.className = "adam-qdrop-menu";
      menu.style.cssText += "display:none;position:absolute;top:calc(100% + 4px);right:0;left:auto;z-index:10;";
      function setOption(value, save) {
        current = value;
        const opt = qualityOpts.find((o) => o.value === value);
        btnLabel.textContent = opt ? opt.label : value;
        const sv = String(value);
        menu.querySelectorAll(".adam-qdrop-item").forEach((el2) => {
          el2.classList.toggle("selected", el2.dataset.value === sv);
        });
        if (save) {
          window.adamBridge?.setTweak(prefKey, value);
          if (prefKey === "streaming-quality") _streamingQuality = value;
          onChange?.(value);
        }
      }
      qualityOpts.forEach(({ value, label }) => {
        const item = document.createElement("div");
        item.className = "adam-qdrop-item";
        item.dataset.value = value;
        const accent = document.createElement("div");
        accent.className = "adam-qdrop-accent";
        const lbl = document.createElement("div");
        lbl.className = "adam-qdrop-item-label";
        lbl.textContent = label;
        item.append(accent, lbl);
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          setOption(value, true);
          menu.style.display = "none";
        });
        menu.appendChild(item);
      });
      setOption(current, false);
      wrap.append(btn, menu);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = menu.style.display !== "none";
        document.querySelectorAll(".adam-qdrop-menu").forEach((m) => {
          m.style.display = "none";
        });
        if (!open) {
          menu.style.display = "block";
          const sel = menu.querySelector(".selected");
          if (sel) sel.scrollIntoView({ block: "nearest" });
        }
      });
      return { wrap, setValue: (v) => setOption(v, false) };
    }
    function _adamCssColorToHex(str) {
      if (/^#[0-9a-fA-F]{6}$/.test(str)) return str;
      const m = str.match(/hsla?\((\d+),\s*([\d.]+)%,\s*([\d.]+)%/);
      if (!m) return "#336699";
      const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100, a = s * Math.min(l, 1 - l);
      const f = (n) => {
        const k = (n + h * 12) % 12;
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      };
      return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
    }
    function _adamRenderAcrylicControls(container, info) {
      container.innerHTML = "";
      const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
      const cur = { ...info };
      const send = (patch) => {
        Object.assign(cur, patch);
        window.adamBridge.setAcrylic(patch);
      };
      const selectCss = FF + "min-width:150px;padding:5px 8px;border-radius:6px;border:0.5px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:rgba(255,255,255,0.88);font-size:13px;outline:none;color-scheme:dark;";
      function select(labels, keys, value, onChange) {
        const el2 = document.createElement("select");
        el2.style.cssText = selectCss;
        keys.forEach((k) => {
          const o = document.createElement("option");
          o.value = k;
          o.textContent = labels[k];
          el2.appendChild(o);
        });
        el2.value = value;
        el2.onchange = () => onChange(el2.value);
        return el2;
      }
      function slider(value, onChange, { min = 0, max = 1, step = 0.01, format = (v) => Number(v).toFixed(2) } = {}) {
        const val = document.createElement("span");
        val.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:52px;text-align:right;";
        const sl = document.createElement("input");
        sl.type = "range";
        sl.min = min;
        sl.max = max;
        sl.step = step;
        sl.style.cssText = "width:150px;accent-color:#fc3c44;margin:0 10px;";
        const show = (v) => {
          sl.value = v;
          val.textContent = format(+v);
        };
        sl.oninput = () => {
          val.textContent = format(+sl.value);
          onChange(+sl.value);
        };
        show(value);
        const wrap = document.createElement("div");
        wrap.style.cssText = "display:flex;align-items:center;";
        wrap.appendChild(sl);
        wrap.appendChild(val);
        wrap.set = show;
        return wrap;
      }
      const themeSel = select(THEME_LABELS, Object.keys(THEME_LABELS), cur.theme, (v) => send({ theme: v }));
      const color = document.createElement("input");
      color.type = "color";
      color.value = cur.tintColor;
      color.style.cssText = "width:44px;height:26px;padding:0;border:0.5px solid rgba(255,255,255,0.2);border-radius:6px;background:none;cursor:pointer;";
      color.oninput = () => send({ tintColor: color.value });
      const blurSl = slider(cur.blurRadius, (v) => send({ blurRadius: v }), {
        format: (v) => `${(30 * Math.pow(v, 1.25)).toFixed(1)} px`
      });
      const saturationSl = slider(cur.saturation, (v) => send({ saturation: v }), { max: 2, step: 0.05, format: (v) => `${v.toFixed(2)}\xD7` });
      const noiseSl = slider(cur.noise, (v) => send({ noise: v }), { max: 0.1, step: 2e-3, format: (v) => `${(v * 100).toFixed(1)}%` });
      const tintSl = slider(cur.tintOpacity, (v) => send({ tintOpacity: v }));
      const lumSl = slider(cur.lumOpacity, (v) => send({ lumOpacity: v }));
      container.appendChild(makeRow("Blur radius", blurSl, "Gaussian radius follows a gentle curve; zero leaves the backdrop clear", false));
      container.appendChild(makeRow("Saturation", saturationSl, "Color intensity of the blurred host backdrop", false));
      container.appendChild(makeRow("Noise", noiseSl, "Fine grain on the glass; fades with the blur", false));
      container.appendChild(makeRow("Theme", themeSel, "Light or dark luminosity tint; System follows Windows", false));
      container.appendChild(makeRow("Tint color", color, null, false));
      container.appendChild(makeRow("Tint opacity", tintSl, "Colour laid over the material", false));
      container.appendChild(makeRow("Luminosity opacity", lumSl, "Theme-coloured layer under the tint; 1 hides the material", false));
      const reset = makeBtn("Reset");
      reset.style.cssText += "margin:10px 0;display:block;";
      reset.onclick = async () => {
        const d = await window.adamBridge.setAcrylic({ ...info.defaults });
        if (!d) return;
        Object.assign(cur, d);
        themeSel.value = d.theme;
        color.value = d.tintColor;
        blurSl.set(d.blurRadius);
        saturationSl.set(d.saturation);
        noiseSl.set(d.noise);
        tintSl.set(d.tintOpacity);
        lumSl.set(d.lumOpacity);
      };
      container.appendChild(reset);
    }
    function _adamRenderPaletteEditor(container, thInfo, st) {
      container.innerHTML = "";
      const pal = st.curPalette || thInfo.defaultPalette || {};
      const paletteKeys = [
        { key: "bgColor", label: "Background" },
        { key: "accent", label: "Accent" },
        { key: "navBg", label: "Sidebar" },
        { key: "navBorder", label: "Border" },
        { key: "accentActive", label: "Active" }
      ];
      const grid = document.createElement("div");
      grid.style.cssText = "display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:12px 0;border-bottom:0.5px solid rgba(255,255,255,0.07);";
      paletteKeys.forEach(({ key, label }) => {
        const cell = document.createElement("div");
        cell.style.cssText = "display:flex;flex-direction:column;align-items:stretch;gap:4px;";
        const swatchWrap = document.createElement("div");
        swatchWrap.style.cssText = `height:30px;border-radius:6px;background:${pal[key] || "#333"};border:1px solid rgba(255,255,255,0.1);position:relative;overflow:hidden;cursor:pointer;`;
        const picker = document.createElement("input");
        picker.type = "color";
        picker.value = _adamCssColorToHex(pal[key] || "#336699");
        picker.style.cssText = "position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;";
        picker.oninput = () => {
          pal[key] = picker.value;
          swatchWrap.style.background = picker.value;
          st.curPalette = { ...pal };
          window.adamBridge.setThemePalette(key, picker.value);
        };
        swatchWrap.appendChild(picker);
        const lbl = document.createElement("div");
        lbl.style.cssText = FF + "font-size:10px;color:rgba(255,255,255,0.4);text-align:center;";
        lbl.textContent = label;
        cell.appendChild(swatchWrap);
        cell.appendChild(lbl);
        grid.appendChild(cell);
      });
      container.appendChild(grid);
      const resetBtn = makeBtn("Reset to Apple Music");
      resetBtn.style.cssText += "margin:10px 0;display:block;";
      resetBtn.onclick = async () => {
        const newPal = await window.adamBridge.resetThemePalette();
        if (newPal) {
          st.curPalette = newPal;
          _adamRenderPaletteEditor(container, thInfo, st);
        }
      };
      container.appendChild(resetBtn);
      const presH = document.createElement("div");
      presH.style.cssText = FF + "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.4);margin:12px 0 6px;";
      presH.textContent = "Presets";
      container.appendChild(presH);
      const presetList = document.createElement("div");
      presetList.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;min-height:24px;margin-bottom:10px;";
      function renderPresets() {
        presetList.innerHTML = "";
        if (!st.thPresets.length) {
          const none = document.createElement("span");
          none.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.25);";
          none.textContent = "No saved presets";
          presetList.appendChild(none);
          return;
        }
        st.thPresets.forEach(({ name, builtin }) => {
          const chip = document.createElement("div");
          chip.style.cssText = `display:flex;align-items:center;gap:4px;background:${builtin ? "rgba(252,60,68,0.18)" : "rgba(255,255,255,0.1)"};border-radius:20px;padding:3px 8px 3px 12px;cursor:default;${builtin ? "border:1px solid rgba(252,60,68,0.35);" : ""}`;
          const cl = document.createElement("span");
          cl.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.8);cursor:pointer;";
          cl.textContent = name;
          cl.onclick = () => {
            const pr = st.thPresets.find((x) => x.name === name);
            if (pr) {
              st.curPalette = pr.palette;
              window.adamBridge.applyThemePreset(name);
              _adamRenderPaletteEditor(container, thInfo, st);
            }
          };
          chip.appendChild(cl);
          if (!builtin) {
            const del = document.createElement("button");
            del.innerHTML = _svgClose;
            del.style.cssText = "border:none;background:transparent;color:rgba(255,255,255,0.35);cursor:pointer;padding:0 0 0 4px;display:inline-flex;align-items:center;";
            del.onclick = () => {
              st.thPresets = st.thPresets.filter((x) => x.name !== name);
              window.adamBridge.deleteThemePreset(name);
              renderPresets();
            };
            chip.appendChild(del);
          }
          presetList.appendChild(chip);
        });
      }
      renderPresets();
      container.appendChild(presetList);
      const actRow = document.createElement("div");
      actRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding-bottom:12px;align-items:center;";
      const saveNameInput = document.createElement("input");
      saveNameInput.type = "text";
      saveNameInput.placeholder = "Preset name\u2026";
      saveNameInput.style.cssText = FF + "display:none;padding:4px 8px;border-radius:6px;border:none;font-size:12px;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);width:110px;";
      const saveBtn = makeBtn("Save preset");
      saveBtn.onclick = () => {
        const showing = saveNameInput.style.display !== "none";
        saveNameInput.style.display = showing ? "none" : "inline-block";
        if (!showing) {
          saveNameInput.value = "";
          saveNameInput.focus();
        }
      };
      const saveConfirmBtn = makeBtn("\u2713");
      saveConfirmBtn.title = "Confirm save";
      saveConfirmBtn.style.cssText += "display:none;padding:4px 9px;";
      const doSave = async () => {
        const name = saveNameInput.value.trim();
        if (!name) return;
        const newPresets = await window.adamBridge.saveThemePreset(name);
        if (newPresets) {
          const builtins = st.thPresets.filter((x) => x.builtin);
          st.thPresets = [...builtins, ...newPresets];
          renderPresets();
        }
        saveNameInput.style.display = "none";
        saveConfirmBtn.style.display = "none";
        saveBtn.textContent = "Save preset";
      };
      saveConfirmBtn.onclick = doSave;
      saveNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSave();
        if (e.key === "Escape") {
          saveNameInput.style.display = "none";
          saveConfirmBtn.style.display = "none";
        }
      });
      saveNameInput.addEventListener("input", () => {
        saveConfirmBtn.style.display = saveNameInput.value.trim() ? "inline-block" : "none";
      });
      const exportBtn = makeBtn("Export");
      exportBtn.onclick = async () => {
        const name = prompt("Preset name to export (leave blank for current palette):") || "current";
        await window.adamBridge.exportThemePreset(name);
      };
      const importBtn = makeBtn("Import");
      importBtn.onclick = async () => {
        const preset = await window.adamBridge.importThemePreset();
        if (preset) {
          st.thPresets = st.thPresets.filter((x) => x.name !== preset.name);
          st.thPresets.push(preset);
          renderPresets();
        }
      };
      actRow.appendChild(saveBtn);
      actRow.appendChild(saveNameInput);
      actRow.appendChild(saveConfirmBtn);
      actRow.appendChild(exportBtn);
      actRow.appendChild(importBtn);
      container.appendChild(actRow);
    }
    const _DL_KNOWN_VARS = /* @__PURE__ */ new Set([
      "title",
      "song",
      "artist",
      "album_artist",
      "album",
      "track_number",
      "track",
      "disc_number",
      "disc",
      "year",
      "genre",
      "codec",
      "ext",
      "quality",
      "tag",
      "release_date",
      "releasedate",
      "isrc",
      "id",
      "song_id",
      "url_artist",
      "urlartist"
    ]);
    const _DL_EX = {
      album_artist: "Artist Name",
      artist: "Artist Name",
      album: "Album Title",
      year: "2024",
      codec: "alac",
      quality: "Lossless",
      url_artist: "artist-name",
      "track_number:02d": "01",
      track_number: "1",
      disc_number: "1",
      title: "Song Title",
      tag: "[E]",
      ext: "m4a",
      id: "1234567890",
      isrc: "USRC12345678",
      release_date: "2024-01-15"
    };
    function _dlSubhead(text) {
      const h = document.createElement("div");
      h.style.cssText = FF + "font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:14px 0 4px;text-transform:uppercase;";
      h.textContent = text;
      return h;
    }
    function _dlDropdown(options, savedValue, onSave) {
      let current = savedValue;
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;display:inline-block;min-width:180px;";
      const btn = document.createElement("div");
      btn.className = "adam-qdrop-btn";
      btn.style.cssText += "font-size:12px;";
      const btnLabel = document.createElement("span");
      btnLabel.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const chevron = document.createElement("span");
      chevron.className = "adam-qdrop-chevron";
      chevron.innerHTML = "&#9660;";
      btn.append(btnLabel, chevron);
      const menu = document.createElement("div");
      menu.className = "adam-qdrop-menu";
      menu.style.cssText += "display:none;position:absolute;top:calc(100% + 4px);right:0;left:auto;z-index:20;min-width:100%;";
      function setOpt(v, save) {
        current = v;
        const opt = options.find((o) => o.value === v);
        btnLabel.textContent = opt ? opt.label : v;
        const sv = String(v);
        menu.querySelectorAll(".adam-qdrop-item").forEach((el2) => el2.classList.toggle("selected", el2.dataset.value === sv));
        if (save) onSave(v);
      }
      options.forEach(({ value, label }) => {
        const item = document.createElement("div");
        item.className = "adam-qdrop-item";
        item.dataset.value = value;
        const accent = document.createElement("div");
        accent.className = "adam-qdrop-accent";
        const lbl = document.createElement("div");
        lbl.className = "adam-qdrop-item-label";
        lbl.textContent = label;
        item.append(accent, lbl);
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          setOpt(value, true);
          menu.style.display = "none";
        });
        menu.appendChild(item);
      });
      setOpt(current, false);
      wrap.append(btn, menu);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const open = menu.style.display !== "none";
        document.querySelectorAll(".adam-qdrop-menu").forEach((m) => {
          m.style.display = "none";
        });
        if (!open) {
          menu.style.display = "block";
          menu.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
        }
      });
      return { wrap, getValue: () => current, setValue: (v) => setOpt(v, false) };
    }
    const _dlValidateTemplate = (tmpl) => {
      const matches = tmpl.match(/\{([^}:]+)(?::[^}]+)?\}/g) || [];
      const unknown = matches.map((m) => m.match(/\{([^}:]+)/)[1].toLowerCase()).filter((n) => !_DL_KNOWN_VARS.has(n));
      return unknown.length ? `Unknown variables: ${unknown.map((n) => "{" + n + "}").join(", ")}` : "";
    };
    const _dlRenderTemplate = (val) => (val || "").replace(/\{([^}:]+)(?::[^}]+)?\}/g, (_, k) => _DL_EX[k] || _DL_EX[k.toLowerCase()] || `{${k}}`);
    function _adamMakeTemplateRow(label, presets, savedValue, prefKey, suffix, prefs, updatePreview) {
      const isCustom = !presets.some((p) => p.value === savedValue);
      const rowWrap = document.createElement("div");
      rowWrap.style.cssText = "display:flex;flex-direction:column;gap:5px;";
      const topRow = document.createElement("div");
      topRow.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
      const customLbl = document.createElement("span");
      customLbl.style.cssText = FF + "display:inline-flex;align-items:center;gap:6px;color:rgba(255,255,255,0.4);font-size:11px;flex-shrink:0;";
      const _customToggleEl = _adamIOSToggle(isCustom, () => syncMode && syncMode());
      const customCb = _customToggleEl._cb;
      customLbl.append(_customToggleEl, document.createTextNode("Custom"));
      const resetBtn = document.createElement("button");
      resetBtn.textContent = "Reset";
      resetBtn.title = "Restore default";
      resetBtn.style.cssText = FF + "padding:2px 8px;background:rgba(255,255,255,0.06);border:0.5px solid rgba(255,255,255,0.12);border-radius:5px;color:rgba(255,255,255,0.38);font-size:10.5px;cursor:pointer;flex-shrink:0;transition:all 0.15s;";
      resetBtn.onmouseenter = () => {
        resetBtn.style.background = "rgba(255,255,255,0.12)";
        resetBtn.style.color = "rgba(255,255,255,0.7)";
      };
      resetBtn.onmouseleave = () => {
        resetBtn.style.background = "rgba(255,255,255,0.06)";
        resetBtn.style.color = "rgba(255,255,255,0.38)";
      };
      const { wrap: ddWrap, getValue, setValue } = _dlDropdown(presets, isCustom ? presets[0].value : savedValue, (v) => {
        window.adamBridge?.setTweak(prefKey, v);
        exampleEl.textContent = _dlRenderTemplate(v) + (suffix || "");
        updatePreview();
      });
      const exampleEl = document.createElement("div");
      exampleEl.style.cssText = FF + "font-size:10.5px;color:rgba(255,255,255,0.32);font-family:ui-monospace,monospace;padding:1px 0;min-height:14px;";
      const customWrap = document.createElement("div");
      customWrap.style.cssText = "display:flex;flex-direction:column;gap:4px;";
      const customInp = document.createElement("input");
      customInp.type = "text";
      customInp.value = isCustom ? savedValue : getValue() || "";
      customInp.placeholder = prefKey.includes("album") ? "{album_artist}/{year} - {album}" : "{track_number:02d} - {title}";
      customInp.style.cssText = FF + "width:100%;padding:5px 10px;border-radius:7px;background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.88);font-size:12px;box-sizing:border-box;outline:none;transition:border-color 0.15s;";
      customInp.onfocus = () => {
        customInp.style.borderColor = "rgba(252,60,68,0.45)";
      };
      customInp.onblur = () => {
        const err = _dlValidateTemplate(customInp.value);
        customInp.style.borderColor = err ? "rgba(255,69,58,0.5)" : customInp.value ? "rgba(48,209,88,0.4)" : "rgba(255,255,255,0.15)";
      };
      const validMsg = document.createElement("div");
      validMsg.style.cssText = FF + "font-size:10.5px;min-height:14px;";
      const applyCustom = (val) => {
        const err = _dlValidateTemplate(val);
        if (err) {
          validMsg.style.color = "#ff453a";
          validMsg.textContent = "\u26A0 " + err;
          customInp.style.borderColor = "rgba(255,69,58,0.5)";
          exampleEl.textContent = "";
        } else {
          validMsg.style.color = "#30d158";
          validMsg.textContent = val ? "\u2713 Valid" : "";
          customInp.style.borderColor = val ? "rgba(48,209,88,0.4)" : "rgba(255,255,255,0.15)";
          window.adamBridge?.setTweak(prefKey, val);
          exampleEl.textContent = val ? _dlRenderTemplate(val) + (suffix || "") : "";
          updatePreview();
        }
      };
      customInp.oninput = () => applyCustom(customInp.value);
      customWrap.append(customInp, validMsg);
      const syncMode = () => {
        const custom = customCb.checked;
        ddWrap.style.display = custom ? "none" : "inline-block";
        customWrap.style.display = custom ? "block" : "none";
        resetBtn.style.display = custom || getValue() === presets[0].value ? "none" : "inline-block";
        if (custom) {
          customInp.value = getValue();
          applyCustom(customInp.value);
        } else {
          window.adamBridge?.setTweak(prefKey, getValue());
          exampleEl.textContent = _dlRenderTemplate(getValue()) + (suffix || "");
          updatePreview();
        }
      };
      resetBtn.onclick = () => {
        customCb.checked = false;
        setValue(presets[0].value);
        window.adamBridge?.setTweak(prefKey, presets[0].value);
        exampleEl.textContent = _dlRenderTemplate(presets[0].value) + (suffix || "");
        updatePreview();
        syncMode();
      };
      syncMode();
      topRow.append(ddWrap, customLbl, resetBtn);
      rowWrap.append(topRow, customWrap, exampleEl);
      return rowWrap;
    }
    function _buildEngineStatusSection(drm) {
      const { wrap, body: stBody } = makeSection("Engine Status");
      function spinner() {
        const s = document.createElement("span");
        s.className = "_adam-spinner";
        return s;
      }
      function renderStatusRows(d) {
        const st = d.state ?? {};
        const proc = st.process ?? "unknown";
        const procOk = proc === "running";
        const procLoading = proc === "starting";
        const fp = st.fairplay ?? "unknown";
        const fpOk = fp === "ready";
        const fpLoading = fp === "unknown" && procLoading;
        const cbcs = d?.capabilities?.cbcs === true;
        const sessOk = cbcs || fpOk;
        const sessText = cbcs ? "active (cbcs)" : fpOk ? "valid" : "none";
        const sessLoading = !sessOk && (procLoading || proc === "running");
        return [
          { label: "DRM process", ok: procOk, loading: procLoading, text: proc },
          { label: "FairPlay", ok: fpOk, loading: fpLoading, text: fp },
          {
            label: "Session",
            ok: sessOk,
            loading: sessLoading,
            text: sessText,
            subtitle: "Authentication lease with Apple servers"
          },
          { label: "Backend", text: ((n) => n ? n[0].toUpperCase() + n.slice(1) : "Unknown")(d.backend?.selected), noDot: true }
        ];
      }
      function applyStatusRow(v, { ok, loading, text, noDot }) {
        v.innerHTML = "";
        if (!noDot) v.appendChild(loading ? spinner() : dot(ok));
        v.appendChild(document.createTextNode(text));
      }
      const valEls = [];
      renderStatusRows(drm).forEach((row, i, arr) => {
        const isLast = i === arr.length - 1;
        const v = statusVal("", row.noDot ? void 0 : row.ok);
        applyStatusRow(v, row);
        valEls.push({ el: v, noDot: !!row.noDot });
        stBody.appendChild(makeRow(row.label, v, row.subtitle, isLast));
      });
      const refreshRow = document.createElement("div");
      refreshRow.style.cssText = "padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);margin-top:2px;";
      const refreshBtn = makeBtn("Refresh");
      refreshBtn.onclick = () => openSettings();
      refreshRow.appendChild(refreshBtn);
      stBody.appendChild(refreshRow);
      const isResolved = (d) => {
        const st = d.state ?? {};
        return st.process === "running" && st.fairplay === "ready" && (st.session === "valid" || d?.capabilities?.cbcs === true);
      };
      if (!isResolved(drm)) {
        const poll = setInterval(async () => {
          if (!wrap.isConnected) {
            clearInterval(poll);
            return;
          }
          const d = await fetchDRM().catch(() => null);
          if (!d) return;
          renderStatusRows(d).forEach((row, i) => applyStatusRow(valEls[i].el, row));
          if (accountSignedIn(d) !== accountSignedIn(drm)) {
            clearInterval(poll);
            openSettings();
            return;
          }
          if (isResolved(d)) clearInterval(poll);
        }, 2e3);
      }
      return wrap;
    }
    function _buildDisplaySection(prefs) {
      const { wrap, body: dBody } = makeSection("Display");
      const RST = FF + "border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.45);border-radius:4px;padding:2px 6px;font-size:11px;cursor:pointer;margin-left:6px;flex-shrink:0;";
      function makeResetBtn(label, onClick) {
        const b = document.createElement("button");
        b.title = `Reset ${label}`;
        b.innerHTML = _svgReset;
        b.style.cssText = RST;
        b.onmouseenter = () => b.style.color = "rgba(255,255,255,0.8)";
        b.onmouseleave = () => b.style.color = "rgba(255,255,255,0.45)";
        b.onclick = onClick;
        return b;
      }
      const blurVal = document.createElement("span");
      blurVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;";
      blurVal.textContent = `${cleanBlur(prefs.glassBlur)}px`;
      const blurSl = document.createElement("input");
      blurSl.type = "range";
      blurSl.min = GLASS.blur.min;
      blurSl.max = GLASS.blur.max;
      blurSl.step = 4;
      blurSl.value = cleanBlur(prefs.glassBlur);
      blurSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      blurSl.oninput = () => {
        blurVal.textContent = `${blurSl.value}px`;
        window.adamBridge.setGlassBlur(+blurSl.value);
      };
      const blurR = document.createElement("div");
      blurR.style.cssText = "display:flex;align-items:center;flex:1;";
      blurR.appendChild(blurSl);
      blurR.appendChild(blurVal);
      blurR.appendChild(makeResetBtn("glass blur", () => {
        blurSl.value = GLASS.blur.def;
        blurVal.textContent = `${GLASS.blur.def}px`;
        window.adamBridge.setGlassBlur(GLASS.blur.def);
      }));
      dBody.appendChild(makeRow("Glass blur", blurR, "Sidebar and UI element blur intensity", false));
      const bgBlurVal = document.createElement("span");
      bgBlurVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;";
      bgBlurVal.textContent = `${prefs.bgBlur ?? 18}px`;
      const bgBlurSl = document.createElement("input");
      bgBlurSl.type = "range";
      bgBlurSl.min = 0;
      bgBlurSl.max = 60;
      bgBlurSl.step = 2;
      bgBlurSl.value = prefs.bgBlur ?? 18;
      bgBlurSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      bgBlurSl.oninput = () => {
        bgBlurVal.textContent = `${bgBlurSl.value}px`;
        window.adamBridge.setBgBlur(+bgBlurSl.value);
      };
      const bgBlurR = document.createElement("div");
      bgBlurR.style.cssText = "display:flex;align-items:center;flex:1;";
      bgBlurR.appendChild(bgBlurSl);
      bgBlurR.appendChild(bgBlurVal);
      bgBlurR.appendChild(makeResetBtn("background blur", () => {
        bgBlurSl.value = 18;
        bgBlurVal.textContent = "18px";
        window.adamBridge.setBgBlur(18);
      }));
      if (window.adamBridge.platform !== "win32") dBody.appendChild(makeRow("Background blur", bgBlurR, "Wallpaper blur (requires a wallpaper to be set)", false));
      const navOpVal = document.createElement("span");
      navOpVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;";
      const navOpSl = document.createElement("input");
      navOpSl.type = "range";
      navOpSl.step = 0.01;
      navOpSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      const navVals = { themeNavBgAlpha: prefs.themeNavBgAlpha, glassOpacity: prefs.glassOpacity };
      let navMode = document.body.getAttribute("data-adam-mode") || "blur";
      const navOpR = document.createElement("div");
      navOpR.style.cssText = "display:flex;align-items:center;flex:1;";
      const navOpRow = makeRow("Sidebar opacity", navOpR, sidebarOpacityControl(navMode).hint, false);
      const navOpHint = navOpRow.firstChild.children[1];
      function showNavOpacity() {
        const c = sidebarOpacityControl(navMode);
        navOpSl.min = c.min;
        navOpSl.max = c.max;
        const v = c.clean(navVals[c.pref]);
        navOpSl.value = v;
        navOpVal.textContent = Math.round(v * 100) + "%";
        navOpHint.textContent = c.hint;
      }
      function setNavOpacity(v) {
        const c = sidebarOpacityControl(navMode);
        navVals[c.pref] = c.clean(v);
        showNavOpacity();
        window.adamBridge.setNavOpacity(navVals[c.pref]);
      }
      navOpSl.oninput = () => setNavOpacity(navOpSl.value);
      navOpR.appendChild(navOpSl);
      navOpR.appendChild(navOpVal);
      navOpR.appendChild(makeResetBtn("sidebar opacity", () => setNavOpacity(sidebarOpacityControl(navMode).def)));
      showNavOpacity();
      const onThemeMode = (e) => {
        if (!navOpSl.isConnected) {
          window.removeEventListener("adam:theme-mode", onThemeMode);
          return;
        }
        navMode = e.detail;
        showNavOpacity();
      };
      window.addEventListener("adam:theme-mode", onThemeMode);
      window.adamBridge.getThemeInfo().then((info) => {
        if (info?.themeMode) {
          navMode = info.themeMode;
          showNavOpacity();
        }
      }).catch(() => {
      });
      dBody.appendChild(navOpRow);
      const zoomVal = document.createElement("span");
      zoomVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;";
      zoomVal.textContent = `${Math.round((prefs.zoomFactor ?? 1) * 100)}%`;
      const zoomSl = document.createElement("input");
      zoomSl.type = "range";
      zoomSl.min = 75;
      zoomSl.max = 150;
      zoomSl.step = 25;
      zoomSl.value = Math.round((prefs.zoomFactor ?? 1) * 100);
      zoomSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      zoomSl.oninput = () => {
        zoomVal.textContent = `${zoomSl.value}%`;
        window.adamBridge.setZoom(+zoomSl.value / 100);
      };
      const zoomR = document.createElement("div");
      zoomR.style.cssText = "display:flex;align-items:center;flex:1;";
      zoomR.appendChild(zoomSl);
      zoomR.appendChild(zoomVal);
      zoomR.appendChild(makeResetBtn("zoom", () => {
        zoomSl.value = 100;
        zoomVal.textContent = "100%";
        window.adamBridge.setZoom(1);
      }));
      dBody.appendChild(makeRow("Zoom", zoomR, null, false));
      const motionToggle = _adamIOSToggle(
        prefs.reduceMotion === true,
        (v) => window.adamBridge.setTweak("reduceMotion", v)
      );
      dBody.appendChild(makeRow(
        "Reduce animations",
        motionToggle,
        "Use still artwork and fewer transitions. Restart required.",
        false
      ));
      const toggle = _adamIOSToggle(
        prefs.hideUpsell !== false,
        (v) => window.adamBridge.setTweak("hideUpsell", v)
      );
      dBody.appendChild(makeRow("Hide upsell banners", toggle, null, false));
      const radioToggle = _adamIOSToggle(
        !!prefs.hideRadio,
        (v) => window.adamBridge.setTweak("hideRadio", v)
      );
      dBody.appendChild(makeRow("Hide Radio", radioToggle, "Remove Radio from the sidebar", true));
      return wrap;
    }
    async function _buildThemeSection(prefs) {
      const { wrap, body: thBody } = makeSection("Theme");
      const thInfo = await window.adamBridge.getThemeInfo().catch(() => ({ blurAvailable: true, themeMode: "accent", themePalette: null, defaultPalette: null, themePresets: [], customCssPath: null }));
      const blurAvail = !!thInfo.blurAvailable;
      const st = {
        curMode: thInfo.themeMode || (blurAvail ? "blur" : "accent"),
        curPalette: thInfo.themePalette,
        thPresets: thInfo.themePresets || []
      };
      document.body.setAttribute("data-adam-mode", st.curMode);
      function renderCustomCss(container) {
        container.innerHTML = "";
        const pathDiv = document.createElement("div");
        pathDiv.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);padding:10px 0;word-break:break-all;min-height:32px;";
        pathDiv.textContent = thInfo.customCssPath || "No file selected";
        container.appendChild(pathDiv);
        const btnsRow = document.createElement("div");
        btnsRow.style.cssText = "display:flex;gap:6px;padding-bottom:10px;";
        const browseBtn = makeBtn("Browse & Import CSS");
        browseBtn.onclick = async () => {
          const fp = await window.adamBridge.importThemeCss();
          if (fp) {
            pathDiv.textContent = fp;
            thInfo.customCssPath = fp;
          }
        };
        const clearBtn = makeBtn("Clear");
        clearBtn.onclick = () => {
          window.adamBridge.setThemeMode("custom");
          pathDiv.textContent = "No file selected";
          thInfo.customCssPath = null;
        };
        const hint = document.createElement("div");
        hint.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.28);padding-top:4px;";
        hint.textContent = "See adam-custom.example.css in the project root for the template.";
        btnsRow.appendChild(browseBtn);
        btnsRow.appendChild(clearBtn);
        container.appendChild(btnsRow);
        container.appendChild(hint);
      }
      const thContentArea = document.createElement("div");
      function renderThemeContent(mode) {
        thContentArea.innerHTML = "";
        if (mode === "blur" && thInfo.acrylic) {
          _adamRenderAcrylicControls(thContentArea, thInfo.acrylic);
        } else if (mode === "blur") {
          const info = document.createElement("div");
          info.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.4);padding:12px 0;";
          info.textContent = "Your wallpaper is blurred and shown behind the app. Adjust intensity with the Background blur slider above.";
          thContentArea.appendChild(info);
        } else if (mode === "accent") {
          if (!st.curPalette) st.curPalette = thInfo.defaultPalette || {};
          _adamRenderPaletteEditor(thContentArea, thInfo, st);
        } else {
          renderCustomCss(thContentArea);
        }
      }
      const modeRow = document.createElement("div");
      modeRow.style.cssText = "padding:12px 0;border-bottom:0.5px solid rgba(255,255,255,0.07);";
      const modeSeg = document.createElement("div");
      modeSeg.style.cssText = "display:flex;background:rgba(255,255,255,0.06);border-radius:8px;padding:2px;gap:2px;";
      const thModes = [
        { label: "Blur", value: "blur", disabled: false, tip: "" },
        { label: "Accent", value: "accent", disabled: false, tip: "" },
        { label: "Custom CSS", value: "custom", disabled: false, tip: "" }
      ];
      thModes.forEach(({ label, value, disabled, tip }) => {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.disabled = disabled;
        if (tip) btn.title = tip;
        const isActive = value === st.curMode;
        btn.style.cssText = `flex:1;padding:5px 0;border:none;border-radius:6px;${FF}font-size:12px;cursor:${disabled ? "not-allowed" : "pointer"};transition:background .15s,color .15s;` + (isActive ? "background:rgba(255,255,255,0.18);color:rgba(255,255,255,0.88);font-weight:500;" : "background:transparent;color:rgba(255,255,255,0.38);") + (disabled ? "opacity:0.3;" : "");
        btn.onclick = () => {
          if (disabled) return;
          st.curMode = value;
          modeSeg.querySelectorAll("button").forEach((b, i) => {
            const a = thModes[i].value === st.curMode;
            b.style.background = a ? "rgba(255,255,255,0.18)" : "transparent";
            b.style.color = a ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.38)";
            b.style.fontWeight = a ? "500" : "";
          });
          document.body.setAttribute("data-adam-mode", value);
          window.adamBridge.setThemeMode(value);
          window.dispatchEvent(new CustomEvent("adam:theme-mode", { detail: value }));
          renderThemeContent(value);
        };
        modeSeg.appendChild(btn);
      });
      modeRow.appendChild(modeSeg);
      const artToggle = _adamIOSToggle(prefs.artTheme !== false, (v) => {
        window.adamBridge.setTweak("artTheme", v);
        window.dispatchEvent(new CustomEvent("adam:art-theme", { detail: v }));
      });
      thBody.appendChild(makeRow("Album art theming", artToggle, "Colour album and playlist pages with a palette from their artwork", false));
      thBody.appendChild(modeRow);
      thBody.appendChild(thContentArea);
      renderThemeContent(st.curMode);
      return wrap;
    }
    function _buildAudioSection(prefs, drmSignedIn, drmAvailable = true) {
      const { wrap, body: aqBody } = makeSection("Audio Quality");
      if (!document.getElementById("adam-quality-dropdown-style")) {
        const ds = document.createElement("style");
        ds.id = "adam-quality-dropdown-style";
        ds.textContent = `
                .adam-qdrop-btn {
                    display:flex;align-items:center;justify-content:space-between;gap:8px;
                    padding:6px 10px 6px 12px;
                    background:rgba(255,255,255,0.10);
                    border:0.5px solid rgba(255,255,255,0.18);
                    border-radius:8px;cursor:pointer;
                    font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
                    font-size:11px;color:rgba(255,255,255,0.88);
                    transition:background 0.15s;user-select:none;white-space:nowrap;
                }
                .adam-qdrop-btn:hover { background:rgba(255,255,255,0.15); }
                .adam-qdrop-chevron { font-size:8px;color:rgba(255,255,255,0.45);flex-shrink:0; }
                .adam-qdrop-menu {
                    background:rgba(32,32,36,0.72);
                    border:0.5px solid rgba(255,255,255,0.14);
                    border-radius:10px;
                    box-shadow:0 8px 32px rgba(0,0,0,0.6),0 1px 0 rgba(255,255,255,0.06) inset;
                    backdrop-filter:blur(40px) saturate(2.0);
                    -webkit-backdrop-filter:blur(40px) saturate(2.0);
                    overflow:hidden;padding:4px 0;
                }
                .adam-qdrop-item {
                    display:flex;align-items:center;gap:0;
                    padding:0;cursor:pointer;
                    font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
                    font-size:11px;color:rgba(255,255,255,0.88);
                    transition:background 0.1s;
                    border-radius:0;position:relative;white-space:nowrap;
                }
                .adam-qdrop-item:hover { background:rgba(255,255,255,0.07); }
                .adam-qdrop-accent {
                    width:3px;align-self:stretch;flex-shrink:0;
                    background:transparent;border-radius:0;
                    transition:background 0.15s;
                }
                .adam-qdrop-item.selected .adam-qdrop-accent { background:#fc3c44; }
                .adam-qdrop-item-label {
                    flex:1;padding:8px 16px 8px 10px;
                }
                .adam-qdrop-item.selected .adam-qdrop-item-label { color:#fff;font-weight:500; }
            `;
        document.head.appendChild(ds);
      }
      const losslessOn = prefs["lossless-enabled"] !== false && drmAvailable;
      const qualityOpts = [
        { value: "high-quality", label: "High Quality (AAC 256 kbps)" },
        { value: "lossless", label: "Lossless (ALAC up to 24-bit / 48 kHz)" },
        { value: "hi-res-lossless", label: "Hi-Res Lossless (ALAC up to 24-bit / 192 kHz)" }
      ];
      const { wrap: sqWrap, setValue: setSQ } = _adamMakeQualityDropdown("streaming-quality", prefs, qualityOpts);
      if (!losslessOn) setSQ("high-quality");
      const sqResetBtn = _adamMiniBtn(() => {
        if (!losslessToggle._cb.checked) losslessToggle.click();
        setSQ("lossless");
        window.adamBridge?.setTweak("streaming-quality", "lossless");
        _streamingQuality = "lossless";
      });
      if (!drmAvailable) {
        sqResetBtn.style.opacity = "0.38";
        sqResetBtn.style.pointerEvents = "none";
      }
      const sqInner = document.createElement("div");
      sqInner.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
      const sqQualityWrap = document.createElement("div");
      sqQualityWrap.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
      sqQualityWrap.append(sqWrap);
      sqInner.append(sqQualityWrap, sqResetBtn);
      function _applyLosslessRowState(on) {
        sqQualityWrap.style.opacity = on ? "1" : "0.38";
        sqQualityWrap.style.pointerEvents = on ? "" : "none";
      }
      _applyLosslessRowState(losslessOn);
      const sqRow = makeRow(
        "Streaming",
        sqInner,
        !drmAvailable ? "AAC only: this build has no DRM layer" : drmSignedIn ? null : "Lossless qualities play once the DRM layer is ready; AAC plays until then",
        true
      );
      let _onLosslessChange = null;
      const losslessToggle = _adamIOSToggle(losslessOn, (v) => {
        window.adamBridge?.setTweak("lossless-enabled", v);
        _applyLosslessRowState(v);
        if (!v) {
          setSQ("high-quality");
          _streamingQuality = "high-quality";
        } else {
          const savedSQ = prefs["streaming-quality"] || "lossless";
          setSQ(savedSQ);
          _streamingQuality = savedSQ;
        }
        _onLosslessChange?.(v);
      });
      if (!drmAvailable) {
        losslessToggle.style.opacity = "0.4";
        losslessToggle.style.pointerEvents = "none";
        losslessToggle.title = "Lossless needs the DRM layer, which this build does not include";
      }
      aqBody.appendChild(makeRow(
        "Lossless Audio",
        losslessToggle,
        !drmAvailable ? "Not available: this build has no DRM layer, so AAC plays" : drmSignedIn ? "Stream lossless audio (ALAC) when available" : "Starts as soon as the DRM layer is ready; AAC plays until then",
        false
      ));
      aqBody.appendChild(sqRow);
      return { wrap, onLosslessChange: (fn) => {
        _onLosslessChange = fn;
      } };
    }
    async function _buildCacheSection() {
      const { wrap, body: cBody } = makeSection("Playback Cache");
      const cacheStats = await fetch(`${ENGINE}/api/v1/cache/stats`).then((r) => r.json()).catch(() => null);
      const mvCacheInfo = await fetch(`${ENGINE}/api/v1/cache/mv`).then((r) => r.json()).catch(() => null);
      const persist = cacheStats?.persistent;
      if (persist?.available !== false) {
        const usedMB = Math.round((persist?.sizeBytes ?? 0) / (1024 * 1024));
        const limitMB = Math.round((persist?.limitBytes ?? 500 * 1024 * 1024) / (1024 * 1024));
        const ttlDays = persist?.ttlDays ?? 5;
        const songsSubhead = document.createElement("div");
        songsSubhead.style.cssText = FF + "font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:12px 0 4px;text-transform:uppercase;";
        songsSubhead.textContent = "Songs";
        cBody.appendChild(songsSubhead);
        const pct2 = limitMB > 0 ? Math.min(100, Math.round(usedMB / limitMB * 100)) : 0;
        const barWrap = document.createElement("div");
        barWrap.style.cssText = "flex:1;";
        const barBg = document.createElement("div");
        barBg.style.cssText = "height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;";
        const barFill = document.createElement("div");
        barFill.style.cssText = `height:100%;width:${pct2}%;background:#fc3c44;border-radius:2px;`;
        barBg.appendChild(barFill);
        const barLabel = document.createElement("div");
        barLabel.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.4);";
        barLabel.textContent = `${usedMB} MB / ${limitMB} MB`;
        barWrap.appendChild(barBg);
        barWrap.appendChild(barLabel);
        cBody.appendChild(makeRow("Song cache used", barWrap, "Frequently played songs cached to disk", false));
        const szVal = document.createElement("span");
        szVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);min-width:62px;text-align:right;white-space:nowrap;flex-shrink:0;";
        szVal.textContent = `${limitMB} MB`;
        const szSl = document.createElement("input");
        szSl.type = "range";
        szSl.min = 100;
        szSl.max = 1e4;
        szSl.step = 100;
        szSl.value = limitMB;
        szSl.style.cssText = "flex:1;accent-color:#fc3c44;";
        szSl.oninput = () => {
          szVal.textContent = `${szSl.value} MB`;
        };
        szSl.onchange = () => {
          const v = +szSl.value;
          window.adamBridge?.setPref("persistLimitMB", v);
          fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persistLimitMB: v }) }).catch(() => {
          });
        };
        const szResetBtn = _adamMiniBtn(() => {
          szSl.value = 500;
          szVal.textContent = "500 MB";
          window.adamBridge?.setPref("persistLimitMB", 500);
          fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persistLimitMB: 500 }) }).catch(() => {
          });
        });
        const szRow = document.createElement("div");
        szRow.style.cssText = "display:flex;align-items:center;flex:1;gap:8px;";
        szRow.append(szSl, szVal, szResetBtn);
        cBody.appendChild(makeRow("Cache size limit", szRow, null, false));
        const ttlInp = document.createElement("input");
        ttlInp.type = "number";
        ttlInp.min = 1;
        ttlInp.max = 365;
        ttlInp.value = ttlDays;
        ttlInp.style.cssText = FF + "width:60px;padding:4px 8px;border-radius:6px;border:none;font-size:13px;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);text-align:center;";
        ttlInp.onchange = () => {
          const v = Math.max(1, +ttlInp.value || 5);
          ttlInp.value = v;
          window.adamBridge?.setPref("persistTTLDays", v);
          fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persistTTLDays: v }) }).catch(() => {
          });
        };
        const ttlWrap = document.createElement("div");
        ttlWrap.style.cssText = "display:flex;align-items:center;gap:6px;";
        ttlWrap.appendChild(ttlInp);
        const ttlUnit = document.createElement("span");
        ttlUnit.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);";
        ttlUnit.textContent = "days";
        ttlWrap.appendChild(ttlUnit);
        const ttlResetBtn = _adamMiniBtn(() => {
          ttlInp.value = 5;
          window.adamBridge?.setPref("persistTTLDays", 5);
          fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persistTTLDays: 5 }) }).catch(() => {
          });
        });
        ttlWrap.appendChild(ttlResetBtn);
        cBody.appendChild(makeRow("Expiry", ttlWrap, "Songs unused longer than this are removed", false));
        const clearRow = document.createElement("div");
        clearRow.style.cssText = "padding:10px 0;display:flex;gap:6px;";
        const clearSongsBtn = makeBtn("Clear Songs");
        clearSongsBtn.onclick = () => {
          fetch(`${ENGINE}/api/v1/cache/playback?what=persistent`, { method: "DELETE" }).then(() => openSettings()).catch(() => {
          });
        };
        const clearAudioSegBtn = makeBtn("Clear Audio Cache");
        clearAudioSegBtn.title = "Clears cached AAC audio HLS segments (~/.cache/adam/engine/segments/)";
        clearAudioSegBtn.onclick = () => {
          fetch(`${ENGINE}/api/v1/cache/playback?what=segments`, { method: "DELETE" }).then(() => openSettings()).catch(() => {
          });
        };
        clearRow.appendChild(clearSongsBtn);
        clearRow.appendChild(clearAudioSegBtn);
        cBody.appendChild(clearRow);
      }
      const mvSubhead = document.createElement("div");
      mvSubhead.style.cssText = FF + "font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:14px 0 4px;text-transform:uppercase;border-top:0.5px solid rgba(255,255,255,0.1);margin-top:2px;";
      mvSubhead.textContent = "Music Video";
      cBody.appendChild(mvSubhead);
      const mvEnabled = mvCacheInfo?.enabled ?? true;
      const mvMaxBytes = mvCacheInfo?.maxBytes ?? 2 * 1024 * 1024 * 1024;
      const mvSizeBytes = mvCacheInfo?.sizeBytes ?? 0;
      const mvMaxGB = +(mvMaxBytes / (1024 * 1024 * 1024)).toFixed(1);
      const mvUsedMB = Math.round(mvSizeBytes / (1024 * 1024));
      const mvMaxMBLabel = Math.round(mvMaxBytes / (1024 * 1024));
      const mvPct = mvMaxBytes > 0 ? Math.min(100, Math.round(mvSizeBytes / mvMaxBytes * 100)) : 0;
      const mvBarWrap = document.createElement("div");
      mvBarWrap.style.cssText = "flex:1;";
      const mvBarBg = document.createElement("div");
      mvBarBg.style.cssText = "height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;";
      const mvBarFill = document.createElement("div");
      mvBarFill.style.cssText = `height:100%;width:${mvPct}%;background:#fc3c44;border-radius:2px;`;
      mvBarBg.appendChild(mvBarFill);
      const mvBarLabel = document.createElement("div");
      mvBarLabel.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.4);";
      const mvQuality = mvCacheInfo?.quality;
      mvBarLabel.textContent = mvQuality ? `${mvUsedMB} MB / ${mvMaxMBLabel} MB \xB7 ${mvQuality}` : `${mvUsedMB} MB / ${mvMaxMBLabel} MB`;
      mvBarWrap.appendChild(mvBarBg);
      mvBarWrap.appendChild(mvBarLabel);
      cBody.appendChild(makeRow("Cache used", mvBarWrap, null, false));
      const mvToggle = _adamIOSToggle(mvEnabled, (v) => {
        mvCapSl.disabled = !v;
        fetch(`${ENGINE}/api/v1/cache/mv`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: v })
        }).catch(() => {
        });
      });
      cBody.appendChild(makeRow("Cache MV segments", mvToggle, "Stores downloaded video segments so replays start instantly", false));
      const mvMaxMB = Math.round(mvMaxGB * 1024);
      const mvCapVal = document.createElement("span");
      mvCapVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);min-width:62px;text-align:right;white-space:nowrap;flex-shrink:0;";
      mvCapVal.textContent = `${mvMaxMB} MB`;
      const mvCapSl = document.createElement("input");
      mvCapSl.type = "range";
      mvCapSl.min = 512;
      mvCapSl.max = 20480;
      mvCapSl.step = 512;
      mvCapSl.value = mvMaxMB;
      mvCapSl.style.cssText = "flex:1;accent-color:#fc3c44;";
      mvCapSl.disabled = !mvEnabled;
      mvCapSl.oninput = () => {
        mvCapVal.textContent = `${mvCapSl.value} MB`;
      };
      mvCapSl.onchange = () => {
        fetch(`${ENGINE}/api/v1/cache/mv`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxBytes: Math.round(+mvCapSl.value * 1024 * 1024) })
        }).catch(() => {
        });
      };
      const mvCapResetBtn = _adamMiniBtn(() => {
        mvCapSl.value = 2048;
        mvCapVal.textContent = "2048 MB";
        fetch(`${ENGINE}/api/v1/cache/mv`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxBytes: 2 * 1024 * 1024 * 1024 }) }).catch(() => {
        });
      });
      const mvCapRow = document.createElement("div");
      mvCapRow.style.cssText = "display:flex;align-items:center;flex:1;gap:8px;";
      mvCapRow.append(mvCapSl, mvCapVal, mvCapResetBtn);
      cBody.appendChild(makeRow("Capacity limit", mvCapRow, "LRU eviction \u2014 oldest segments removed when limit is reached", false));
      const mvClearRow = document.createElement("div");
      mvClearRow.style.cssText = "padding:10px 0;display:flex;gap:6px;";
      const mvClearBtn = makeBtn("Clear MV Cache");
      mvClearBtn.onclick = () => {
        fetch(`${ENGINE}/api/v1/cache/mv`, { method: "DELETE" }).then(() => openSettings()).catch(() => {
        });
      };
      mvClearRow.appendChild(mvClearBtn);
      cBody.appendChild(mvClearRow);
      return wrap;
    }
    function _buildContentMarkersRows(dlBody, prefs, makeRow2, makeIOSToggle, makeMiniBtn) {
      dlBody.appendChild(_dlSubhead("Content Markers"));
      function makeMarkerInput(prefKey, defaultVal) {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.value = prefs[prefKey] || defaultVal;
        inp.maxLength = 8;
        inp.style.cssText = FF + "width:60px;padding:4px 8px;border-radius:7px;text-align:center;background:rgba(255,255,255,0.08);border:0.5px solid rgba(255,255,255,0.15);color:rgba(255,255,255,0.88);font-size:12.5px;font-family:ui-monospace,monospace;outline:none;transition:border-color 0.15s;";
        inp.onfocus = () => {
          inp.style.borderColor = "rgba(252,60,68,0.5)";
        };
        inp.onblur = () => {
          inp.style.borderColor = "rgba(255,255,255,0.15)";
        };
        inp.oninput = () => window.adamBridge?.setTweak(prefKey, inp.value);
        return inp;
      }
      function makeMarkerControl(prefKey, defaultVal) {
        const inp = makeMarkerInput(prefKey, defaultVal);
        const resetBtn = makeMiniBtn("", () => {
          inp.value = defaultVal;
          window.adamBridge?.setTweak(prefKey, defaultVal);
        });
        const w = document.createElement("div");
        w.style.cssText = "display:flex;align-items:center;gap:6px;";
        w.append(inp, resetBtn);
        return w;
      }
      function makeDependentRow(label, control) {
        const w = document.createElement("div");
        w.style.cssText = "display:flex;align-items:center;padding:9px 0 9px 14px;border-bottom:0.5px solid rgba(255,255,255,0.07);";
        const lbl = document.createElement("div");
        lbl.style.cssText = FF + "flex:1;font-size:13px;color:rgba(255,255,255,0.45);";
        lbl.textContent = label;
        if (control.style) control.style.marginLeft = "auto";
        w.append(lbl, control);
        return w;
      }
      function makeMarkerRow(label, prefKey, marker, hint, isLast) {
        const on = prefKey === "explicit-enabled" ? prefs[prefKey] !== false : !!prefs[prefKey];
        const inpRow = makeDependentRow("Marker text", makeMarkerControl(prefKey.replace("-enabled", "-marker"), marker));
        inpRow.style.display = on ? "" : "none";
        dlBody.appendChild(makeRow2(
          label,
          makeIOSToggle(on, (v) => {
            window.adamBridge?.setTweak(prefKey, v);
            inpRow.style.display = v ? "" : "none";
          }),
          hint,
          isLast
        ));
        dlBody.appendChild(inpRow);
      }
      makeMarkerRow("Explicit content", "explicit-enabled", "[E]", "Add [E] to filenames of explicit tracks", false);
      makeMarkerRow("Clean content", "clean-enabled", "[C]", "Add [C] to filenames of clean/censored tracks", false);
      makeMarkerRow("Apple Digital Masters", "adm-enabled", "[M]", "Add [M] to filenames of tracks mastered for Apple Music", false);
      dlBody.appendChild(makeRow2(
        "Playlist metadata",
        makeIOSToggle(!!prefs["use-songinfo-for-playlist"], (v) => window.adamBridge?.setTweak("use-songinfo-for-playlist", v)),
        "Use original album track number and album name instead of playlist position when downloading a playlist",
        true
      ));
    }
    function _buildDownloadsSection(prefs, tools, drmSignedIn, drmAvailable = true) {
      const { wrap, body: dlBody } = makeSection("Downloads");
      function makeIOSToggle(on, onChange) {
        return _adamIOSToggle(on, onChange);
      }
      function makeMiniBtn(_, onClick) {
        return _adamMiniBtn(onClick);
      }
      const losslessAllowed = drmSignedIn && prefs["lossless-enabled"] !== false;
      let previewEl = null;
      function updatePreview() {
        if (!previewEl) return;
        const trackTmpl = prefs["dl-filename-track"] || "{track_number:02d} - {title}";
        const albumTmpl = prefs["dl-dirname-album"] || "{album_artist}/{year} - {album}";
        previewEl.textContent = _dlRenderTemplate(albumTmpl) + "/" + _dlRenderTemplate(trackTmpl) + ".m4a";
      }
      function makeTemplateRow(label, presets, savedValue, prefKey, suffix) {
        return _adamMakeTemplateRow(label, presets, savedValue, prefKey, suffix, prefs, updatePreview);
      }
      dlBody.appendChild(_dlSubhead("Filename"));
      const TRACK_PRESETS = [
        { value: "{track_number:02d} - {title}", label: "Track# - Title" },
        { value: "{title}", label: "Title only" },
        { value: "{artist} - {title}", label: "Artist - Title" }
      ];
      const ALBUM_PRESETS = [
        { value: "{album_artist}/{year} - {album}", label: "Artist/Year - Album" },
        { value: "{album_artist}/{album}", label: "Artist/Album" },
        { value: "{album}", label: "Album only" }
      ];
      dlBody.appendChild(makeRow(
        "Track filename",
        makeTemplateRow("Track filename", TRACK_PRESETS, prefs["dl-filename-track"] || TRACK_PRESETS[0].value, "dl-filename-track", ".m4a"),
        null,
        false
      ));
      dlBody.appendChild(makeRow(
        "Album folder",
        makeTemplateRow("Album folder", ALBUM_PRESETS, prefs["dl-dirname-album"] || ALBUM_PRESETS[0].value, "dl-dirname-album", "/"),
        null,
        false
      ));
      const previewWrap = document.createElement("div");
      previewWrap.style.cssText = FF + "font-size:10.5px;color:rgba(255,255,255,0.3);font-family:ui-monospace,monospace;padding:4px 0 10px;word-break:break-all;";
      previewEl = previewWrap;
      dlBody.appendChild(previewWrap);
      updatePreview();
      dlBody.appendChild(_dlSubhead("Format"));
      const fullQualityOpts = drmSignedIn ? [
        { value: "high-quality", label: "High Quality (AAC 256 kbps)" },
        { value: "lossless", label: "Lossless (ALAC up to 24-bit / 48 kHz)" },
        { value: "hi-res-lossless", label: "Hi-Res Lossless (ALAC up to 24-bit / 192 kHz)" }
      ] : [{ value: "high-quality", label: "High Quality (AAC 256 kbps)" }];
      const { wrap: dlQWrap, setValue: setDlQ } = _adamMakeQualityDropdown("dl-quality", prefs, fullQualityOpts);
      if (!losslessAllowed) setDlQ("high-quality");
      const dlQReset = makeMiniBtn("", () => {
        if (!_dlLosslessOn) return;
        setDlQ("lossless");
        window.adamBridge?.setTweak("dl-quality", "lossless");
      });
      const dlQInner = document.createElement("div");
      dlQInner.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
      const dlQDropWrap = document.createElement("div");
      dlQDropWrap.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
      dlQDropWrap.appendChild(dlQWrap);
      dlQInner.append(dlQDropWrap, dlQReset);
      let _dlLosslessOn = losslessAllowed;
      function applyDlLossless(on) {
        _dlLosslessOn = on;
        dlQDropWrap.style.opacity = on ? "1" : "0.38";
        dlQDropWrap.style.pointerEvents = on ? "" : "none";
        dlQReset.style.opacity = on ? "1" : "0.38";
        if (!on) {
          setDlQ("high-quality");
        } else {
          setDlQ(prefs["dl-quality"] || "lossless");
        }
      }
      applyDlLossless(losslessAllowed);
      dlBody.appendChild(makeRow(
        "Quality",
        dlQInner,
        !drmSignedIn ? drmAvailable ? "Lossless downloads are available once the DRM session is ready" : "Lossless downloads need the DRM layer, which this build does not include" : null,
        true
      ));
      const ffmpegIndCtrl = document.createElement("div");
      ffmpegIndCtrl.style.cssText = "display:flex;align-items:center;gap:6px;";
      const ffmpegDot = document.createElement("span");
      const ffmpegLabel = document.createElement("span");
      ffmpegLabel.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.7);";
      ffmpegIndCtrl.append(ffmpegDot, ffmpegLabel);
      const ffmpegRow = makeRow("FFmpeg", ffmpegIndCtrl, "Checking\u2026", false);
      dlBody.appendChild(ffmpegRow);
      const ffmpegSub = ffmpegRow.firstChild.children[1];
      const ffmpegToggle = makeIOSToggle(!!prefs["dl-ffmpeg-enabled"], (v) => window.adamBridge?.setTweak("dl-ffmpeg-enabled", v));
      dlBody.appendChild(makeRow("Convert with FFmpeg", ffmpegToggle, "Re-encode downloaded files with FFmpeg", false));
      function applyFfmpeg(info) {
        const found = info?.available === true;
        const enc = info?.encoders;
        const canEncode = !enc || enc.aac === true || enc.flac === true;
        const usable = found && canEncode;
        ffmpegDot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${usable ? "#34c759" : found ? "#ff9f0a" : "#ff3b30"};`;
        const missing = !found && (!info?.error || info.error === "not found");
        ffmpegLabel.textContent = found ? info.version || "Available" : missing ? "Not found" : "Not working";
        ffmpegSub.textContent = !found ? missing ? "Install FFmpeg or set a custom path below" : info.error : !canEncode ? "This FFmpeg has no AAC or FLAC encoder, so it cannot re-encode downloads" : enc ? `Available for re-encoding (${[enc.aac && "AAC", enc.flac && "FLAC"].filter(Boolean).join(", ")})` : "Available for re-encoding";
        ffmpegToggle.style.opacity = usable ? "" : "0.4";
        ffmpegToggle.style.pointerEvents = usable ? "" : "none";
        ffmpegToggle.title = usable ? "" : "FFmpeg is not available";
        if (!usable) ffmpegToggle._cb.checked = false;
      }
      applyFfmpeg(tools?.ffmpeg);
      let ffmpegCheck = 0;
      function recheckFfmpeg(customPath) {
        const mine = ++ffmpegCheck;
        fetch(`${ENGINE}/api/v1/tools?ffmpegPath=${encodeURIComponent(customPath || "")}`).then((r) => r.json()).then((t) => {
          if (mine === ffmpegCheck) applyFfmpeg(t?.ffmpeg);
        }).catch(() => {
        });
      }
      recheckFfmpeg(prefs["ffmpeg-path"]);
      const ffmpegPathInp = document.createElement("input");
      ffmpegPathInp.type = "text";
      ffmpegPathInp.placeholder = "Default (from PATH)";
      ffmpegPathInp.value = prefs["ffmpeg-path"] || "";
      ffmpegPathInp.style.cssText = FF + "flex:1;min-width:0;padding:5px 9px;border-radius:7px;background:rgba(255,255,255,0.07);border:0.5px solid rgba(255,255,255,0.14);color:rgba(255,255,255,0.85);font-size:11.5px;font-family:ui-monospace,monospace;outline:none;transition:border-color 0.15s;";
      ffmpegPathInp.onfocus = () => {
        ffmpegPathInp.style.borderColor = "rgba(252,60,68,0.5)";
      };
      ffmpegPathInp.onblur = () => {
        ffmpegPathInp.style.borderColor = "rgba(255,255,255,0.14)";
        const v = ffmpegPathInp.value.trim();
        window.adamBridge?.setTweak("ffmpeg-path", v);
        recheckFfmpeg(v);
      };
      const ffmpegPathRow = document.createElement("div");
      ffmpegPathRow.style.cssText = "display:flex;align-items:center;gap:6px;flex:1;";
      ffmpegPathRow.appendChild(ffmpegPathInp);
      dlBody.appendChild(makeRow("FFmpeg path", ffmpegPathRow, "Leave blank to use system PATH", false));
      const embedArtToggle = makeIOSToggle(prefs["dl-embed-art"] !== false, (v) => window.adamBridge?.setTweak("dl-embed-art", v));
      dlBody.appendChild(makeRow("Embed artwork", embedArtToggle, null, false));
      const motionArtToggle = makeIOSToggle(!!prefs["dl-motion-art"], (v) => window.adamBridge?.setTweak("dl-motion-art", v));
      dlBody.appendChild(makeRow("Download animated artwork", motionArtToggle, "Save motion cover as a separate video file alongside the track", false));
      dlBody.appendChild(_dlSubhead("Music Video"));
      const MV_RES_OPTS = [
        { value: "best", label: "Best Available" },
        { value: "4k", label: "4K (2160p)" },
        { value: "1080p", label: "1080p" },
        { value: "720p", label: "720p" },
        { value: "480p", label: "480p" }
      ];
      const { wrap: mvResDd } = _dlDropdown(MV_RES_OPTS, prefs["dl-mv-quality"] || "best", (v) => {
        if (!drmSignedIn) return;
        window.adamBridge?.setTweak("dl-mv-quality", v);
      });
      if (!drmSignedIn) {
        mvResDd.style.opacity = "0.38";
        mvResDd.style.pointerEvents = "none";
      }
      dlBody.appendChild(makeRow(
        "Resolution",
        mvResDd,
        drmSignedIn ? null : "Music video downloads are available once the DRM session is ready",
        false
      ));
      const ART_OPTS = [
        { value: "600", label: "600 \xD7 600" },
        { value: "1200", label: "1200 \xD7 1200" },
        { value: "3000", label: "3000 \xD7 3000" }
      ];
      const { wrap: artDd } = _dlDropdown(ART_OPTS, prefs["dl-artwork-size"] || "1200", (v) => window.adamBridge?.setTweak("dl-artwork-size", v));
      dlBody.appendChild(makeRow("Artwork size", artDd, null, false));
      dlBody.appendChild(_dlSubhead("Lyrics"));
      const lyricsToggle = makeIOSToggle(prefs["dl-lyrics"] !== false, (v) => window.adamBridge?.setTweak("dl-lyrics", v));
      dlBody.appendChild(makeRow("Embed lyrics", lyricsToggle, null, false));
      const timedLyricsToggle = makeIOSToggle(prefs["dl-timed-lyrics"] !== false, (v) => window.adamBridge?.setTweak("dl-timed-lyrics", v));
      dlBody.appendChild(makeRow("Timed lyrics (SYLT)", timedLyricsToggle, null, false));
      _buildContentMarkersRows(dlBody, prefs, makeRow, makeIOSToggle, makeMiniBtn);
      dlBody.appendChild(_dlSubhead("Queue"));
      dlBody.appendChild(makeRow(
        "Retry on fail",
        makeIOSToggle(prefs["retry-on-fail"] !== false, (v) => window.adamBridge?.setTweak("retry-on-fail", v)),
        "Automatically retry a failed download",
        false
      ));
      const RETRY_TIMEOUT_OPTS = [
        { value: 15, label: "15 seconds" },
        { value: 30, label: "30 seconds" },
        { value: 60, label: "1 minute" },
        { value: 300, label: "5 minutes" }
      ];
      const { wrap: retryToDd } = _dlDropdown(
        RETRY_TIMEOUT_OPTS,
        parseInt(prefs["retry-timeout"] ?? "30", 10),
        (v) => window.adamBridge?.setTweak("retry-timeout", parseInt(v, 10))
      );
      dlBody.appendChild(makeRow("Retry after", retryToDd, null, false));
      return { wrap, applyLossless: applyDlLossless };
    }
    async function _buildPlaybackSection(prefs) {
      const { wrap, body } = makeSection("Playback");
      const resumeRaw = await window.adamBridge?.storeRead("resumeEnabled").catch(() => null);
      const resumeOn = resumeRaw !== "false" && resumeRaw !== false;
      const resumeToggle = _adamIOSToggle(resumeOn, async (v) => {
        _resumeEnabled = v;
        await window.adamBridge?.storeWrite("resumeEnabled", String(v)).catch(() => {
        });
        if (!v) _resumeClear();
      });
      body.appendChild(makeRow(
        "Resume on launch",
        resumeToggle,
        "Offer to restore your last queue and position on launch",
        false
      ));
      const scRaw = await window.adamBridge?.storeRead("soundCheckEnabled").catch(() => null);
      const scOn = scRaw === "true" || scRaw === true;
      const scToggle = _adamIOSToggle(scOn, async (v) => {
        await window.adamBridge?.storeWrite("soundCheckEnabled", String(v)).catch(() => {
        });
        _scSetEnabled(v);
      });
      body.appendChild(makeRow(
        "Loudness Normalisation",
        scToggle,
        "Normalize track loudness to a consistent level (experimental)",
        false
      ));
      const _xfModes = ["off", "auto", "adaptive", "manual"];
      const xfModeInit = _xfModes.includes(prefs?.["crossfade-mode"]) ? prefs["crossfade-mode"] : (Number(prefs?.["crossfade-sec"]) || 0) > 0 ? "manual" : "off";
      const xfManualInit = Math.min(12, Math.max(1, Number(prefs?.["crossfade-sec"]) || 6));
      const xfVal = document.createElement("span");
      xfVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;";
      xfVal.textContent = `${xfManualInit}s`;
      const xfSl = document.createElement("input");
      xfSl.type = "range";
      xfSl.min = 1;
      xfSl.max = 12;
      xfSl.step = 1;
      xfSl.value = xfManualInit;
      xfSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      xfSl.oninput = () => {
        const v = +xfSl.value;
        xfVal.textContent = `${v}s`;
        _xfSetManualSec(v);
      };
      const xfSecInner = document.createElement("div");
      xfSecInner.style.cssText = "display:flex;align-items:center;flex:1;";
      xfSecInner.append(xfSl, xfVal);
      const xfSecRow = makeRow("Duration", xfSecInner, null, false);
      xfSecRow.style.paddingLeft = "14px";
      const gaplessOn = prefs?.["xf-preserve-gapless"] !== false;
      const gaplessToggle = _adamIOSToggle(gaplessOn, (v) => {
        _xfPreserveGapless = v;
        window.adamBridge?.setTweak("xf-preserve-gapless", v);
      });
      const gaplessRow = makeRow(
        "Keep albums gapless",
        gaplessToggle,
        "Skip crossfade between consecutive tracks of the same album",
        false
      );
      gaplessRow.style.paddingLeft = "14px";
      const stationOn = prefs?.["xf-station"] !== false;
      const stationToggle = _adamIOSToggle(stationOn, (v) => {
        _xfStationEnabled = v;
        window.adamBridge?.setTweak("xf-station", v);
      });
      const stationRow = makeRow(
        "Crossfade autoplay & stations",
        stationToggle,
        "Wait for the next recommended track so it fades in consistently",
        false
      );
      stationRow.style.paddingLeft = "14px";
      const xfApplyMode = (mode) => {
        xfSecRow.style.display = mode === "manual" ? "" : "none";
        const on = mode !== "off";
        gaplessRow.style.display = on ? "" : "none";
        stationRow.style.display = on ? "" : "none";
      };
      const { wrap: xfModeWrap } = _adamMakeQualityDropdown("crossfade-mode", { "crossfade-mode": xfModeInit }, [
        { value: "off", label: "Off" },
        { value: "auto", label: "Automatic (Smart)" },
        { value: "adaptive", label: "Automatic (Adaptive)" },
        { value: "manual", label: "Manual" }
      ], (mode) => {
        _xfSetMode(mode);
        xfApplyMode(mode);
      });
      body.appendChild(makeRow(
        "Crossfade",
        xfModeWrap,
        "Off \xB7 Smart (fixed) \xB7 Adaptive (per-track) \xB7 Manual \u2014 AAC only",
        false
      ));
      body.appendChild(xfSecRow);
      body.appendChild(gaplessRow);
      body.appendChild(stationRow);
      xfApplyMode(xfModeInit);
      const discordRaw = await window.adamBridge?.storeRead("discordEnabled").catch(() => null);
      const discordOn = discordRaw === "true" || discordRaw === true;
      const discordToggle = _adamIOSToggle(discordOn, async (v) => {
        _discordEnabled = v;
        await window.adamBridge?.storeWrite("discordEnabled", String(v)).catch(() => {
        });
        if (v) _discordUpdateNow();
        else window.adamBridge?.discordDisable?.();
      });
      body.appendChild(makeRow(
        "Discord Rich Presence",
        discordToggle,
        "Show the current track on your Discord profile (requires a client ID in main.mjs)",
        false
      ));
      return { wrap };
    }
    function _buildLinksSection() {
      const { wrap, body } = makeSection("Links");
      const intro = document.createElement("div");
      intro.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.42);line-height:1.5;padding:2px 0 10px;";
      intro.textContent = `Choose which links open in Adam. adam:// links always work. Turning a scheme on makes Adam the app your system uses for it, replacing Apple's Music app or another player for those links. Plain https://music.apple.com links open in your browser; turn on music:// and use the "Open in Music" button on the website to send them here.`;
      body.appendChild(intro);
      const rows = document.createElement("div");
      body.appendChild(rows);
      const render = (list) => {
        rows.textContent = "";
        let group = null;
        for (const s of list) {
          if (s.group !== group) {
            group = s.group;
            const h = document.createElement("div");
            h.textContent = s.groupTitle;
            h.style.cssText = FF + "font-size:10px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:rgba(255,255,255,0.5);padding:12px 0 2px;";
            rows.appendChild(h);
          }
          const toggle = _adamIOSToggle(s.enabled, async (v) => {
            try {
              render(await window.adamBridge.linksSet(s.scheme, v));
            } catch (e) {
              console.warn("[Adam Links] could not change", s.scheme, e?.message || e);
            }
          });
          const status = !s.enabled ? "" : s.active ? " \xB7 active" : " \xB7 not active yet: check your system default apps";
          rows.appendChild(makeRow(s.scheme + "://", toggle, s.note + status, false));
        }
      };
      window.adamBridge?.linksGet?.().then(render).catch(() => {
      });
      return { wrap };
    }
    function _buildShortcutsSection() {
      const { wrap, body } = makeSection("Keyboard Shortcuts");
      const enToggle = _adamIOSToggle(_hotkeysEnabled, async (v) => {
        _hotkeysEnabled = v;
        await window.adamBridge?.storeWrite("hotkeysEnabled", String(v)).catch(() => {
        });
      });
      body.appendChild(makeRow(
        "In-app shortcuts",
        enToggle,
        "Control playback with the keyboard when the window is focused",
        false
      ));
      const keyBtns = {};
      for (const act of _HOTKEY_ACTIONS) {
        const btn = makeBtn(_hotkeyKeyLabel(_hotkeyBindings[act.id]));
        btn.style.minWidth = "58px";
        keyBtns[act.id] = btn;
        btn.onclick = () => {
          btn.textContent = "Press a key\u2026";
          _hotkeyCapture = (key) => {
            if (key) {
              _hotkeyBindings[act.id] = key;
              _hotkeySaveBindings();
            }
            btn.textContent = _hotkeyKeyLabel(_hotkeyBindings[act.id]);
          };
        };
        body.appendChild(makeRow(act.label, btn, null, false));
      }
      const resetRow = document.createElement("div");
      resetRow.style.cssText = "padding:10px 0;display:flex;gap:6px;";
      const resetBtn = makeBtn("Reset to defaults");
      resetBtn.onclick = () => {
        for (const act of _HOTKEY_ACTIONS) {
          _hotkeyBindings[act.id] = act.def;
          if (keyBtns[act.id]) keyBtns[act.id].textContent = _hotkeyKeyLabel(act.def);
        }
        _hotkeySaveBindings();
      };
      resetRow.appendChild(resetBtn);
      body.appendChild(resetRow);
      return { wrap };
    }
    function _scrobbleNote(html) {
      const n = document.createElement("div");
      n.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.42);line-height:1.5;padding:2px 0 10px;";
      n.innerHTML = html;
      n.querySelectorAll("a").forEach((a) => {
        a.style.cssText = "color:#fc3c44;text-decoration:none;";
        a.onclick = (e) => {
          e.preventDefault();
          window.adamBridge?.openExternal?.(a.getAttribute("href")) ?? window.open(a.getAttribute("href"));
        };
      });
      return n;
    }
    async function _buildScrobbleSection() {
      const { wrap, body } = makeSection("Scrobbling");
      body.appendChild(_scrobbleSubhead("Last.fm"));
      const lf = await window.adamBridge?.lastfmStatus().catch(() => null) ?? {};
      if (LASTFM_API_KEY && (!lf.apiKey || !lf.secretSet)) {
        await window.adamBridge?.lastfmSetCredentials({ apiKey: LASTFM_API_KEY, secret: LASTFM_API_SECRET }).catch(() => {
        });
        Object.assign(lf, { apiKey: LASTFM_API_KEY, secretSet: true, configured: true });
      }
      const lfVal = document.createElement("div");
      lfVal.style.cssText = "display:flex;align-items:center;gap:8px;";
      const lfConnected = () => {
        lfVal.innerHTML = "";
        lfVal.appendChild(statusVal(lf.username || "connected", true));
        const disc = makeBtn("Disconnect");
        disc.onclick = async () => {
          await window.adamBridge?.lastfmDisconnect();
          _lastfmConnected = false;
          openSettings();
        };
        lfVal.appendChild(disc);
      };
      const lfDisconnected = () => {
        lfVal.innerHTML = "";
        const connect = makeBtn("Connect");
        connect.onclick = async () => {
          const r = await window.adamBridge?.lastfmAuth();
          if (r?.error) {
            connect.textContent = "Error \u2014 retry";
            return;
          }
          connect.textContent = "Finish connecting";
          connect.onclick = async () => {
            const s = await window.adamBridge?.lastfmSession(r.token);
            if (s?.username) {
              _lastfmConnected = true;
              lf.username = s.username;
              lfConnected();
            } else {
              connect.textContent = "Approve in the window, then retry";
            }
          };
        };
        lfVal.appendChild(connect);
      };
      (lf.connected ? lfConnected : lfDisconnected)();
      body.appendChild(makeRow("Account", lfVal, "Log in and authorize Adam in the in-app Last.fm window", false));
      body.appendChild(_scrobbleSubhead("ListenBrainz"));
      const lb = await window.adamBridge?.lbStatus().catch(() => null) ?? {};
      const lbCard = document.createElement("div");
      lbCard.style.cssText = FF + "display:flex;flex-direction:column;margin:4px 0 8px;border-radius:8px;border:0.5px solid rgba(255,255,255,0.12);overflow:hidden;";
      const lbInner = document.createElement("div");
      lbInner.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:rgba(255,255,255,0.04);";
      const lbLabel = document.createElement("span");
      lbLabel.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);flex:0 0 auto;margin-right:10px;";
      lbLabel.textContent = "Account";
      const lbRight = document.createElement("div");
      lbRight.style.cssText = "display:flex;align-items:center;gap:8px;flex:1;";
      lbInner.append(lbLabel, lbRight);
      lbCard.appendChild(lbInner);
      body.appendChild(lbCard);
      body.appendChild(_scrobbleNote(
        'Paste your token from <a href="https://listenbrainz.org/settings/">listenbrainz.org/settings</a> (the "User token" field). No app registration needed.'
      ));
      const lbRenderConnected = () => {
        lbRight.innerHTML = "";
        lbRight.appendChild(statusVal(lb.username || "connected", true));
        const disc = makeBtn("Disconnect");
        disc.onclick = async () => {
          await window.adamBridge?.lbDisconnect();
          _lbConnected = false;
          openSettings();
        };
        lbRight.appendChild(disc);
      };
      const lbRenderInput = () => {
        lbRight.innerHTML = "";
        const lbTokenInput = makeInput("password", "User token");
        lbTokenInput.style.cssText = FF + "flex:1;background:transparent;border:none;outline:none;padding:4px 0;font-size:13px;color:rgba(255,255,255,0.85);";
        lbTokenInput.style.removeProperty("width");
        const lbConnBtn = makeBtn("Connect");
        lbConnBtn.onclick = async () => {
          const tok = lbTokenInput.value.trim();
          if (!tok) return;
          lbConnBtn.textContent = "\u2026";
          lbConnBtn.disabled = true;
          await window.adamBridge?.lbSetToken(tok);
          const s = await window.adamBridge?.lbStatus();
          if (s?.connected) {
            _lbConnected = true;
            lb.username = s.username;
            lb.connected = true;
            lbRenderConnected();
          } else {
            lbConnBtn.textContent = "Invalid";
            lbConnBtn.disabled = false;
          }
        };
        lbRight.append(lbTokenInput, lbConnBtn);
      };
      if (lb.connected) lbRenderConnected();
      else lbRenderInput();
      return { wrap };
    }
    function _scrobbleSubhead(text) {
      const h = document.createElement("div");
      h.style.cssText = FF + "font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:14px 0 4px;text-transform:uppercase;";
      h.textContent = text;
      return h;
    }
    async function _buildHistorySection() {
      const { wrap, body: histBody } = makeSection("History");
      const histEnabledRaw = await window.adamBridge?.storeRead("historyEnabled").catch(() => null);
      const histIsEnabled = histEnabledRaw !== "false" && histEnabledRaw !== false;
      const histToggle = _adamIOSToggle(histIsEnabled, async (v) => {
        _histEnabled = v;
        await window.adamBridge?.storeWrite("historyEnabled", String(v)).catch(() => {
        });
        _histInject();
      });
      histBody.appendChild(makeRow("Show in Up Next panel", histToggle, "Display recently played tracks above the queue", false));
      const histClearRow = document.createElement("div");
      histClearRow.style.cssText = "padding:10px 0;display:flex;gap:6px;";
      const histClearBtn = makeBtn("Clear History");
      histClearBtn.onclick = () => {
        _histClear();
        openSettings();
      };
      histClearRow.appendChild(histClearBtn);
      histBody.appendChild(histClearRow);
      return wrap;
    }
    async function _buildLibrarySection() {
      const { wrap, body: libBody } = makeSection("Library");
      const libStatus = await fetch(`${ENGINE}/api/v1/library/status`).then((r) => r.json()).catch(() => ({}));
      const libSongs = libStatus.songs ?? 0;
      const libPl = libStatus.playlists ?? 0;
      const libAt = libStatus.syncedAt ? new Date(libStatus.syncedAt) : null;
      const libAtStr = libAt && libAt.getFullYear() > 2e3 ? libAt.toLocaleDateString(void 0, { month: "short", day: "numeric", year: "numeric" }) : "Never";
      const libStatEl = document.createElement("span");
      libStatEl.style.cssText = FF + "color:rgba(255,255,255,0.45);font-size:11px;";
      libStatEl.textContent = libSongs > 0 ? `${libSongs} songs \xB7 ${libPl} playlists \xB7 synced ${libAtStr}` : "Not synced";
      libBody.appendChild(makeRow("Local library cache", libStatEl, "Syncs your songs and playlists for instant queue-building", false));
      const libSyncRow = document.createElement("div");
      libSyncRow.style.cssText = "padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
      const libSyncBtn = makeBtn("Sync Now");
      const libSyncMsg = document.createElement("span");
      libSyncMsg.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.4);flex:1;";
      libSyncBtn.onclick = async () => {
        libSyncBtn.disabled = true;
        libSyncBtn.textContent = "Syncing\u2026";
        libSyncMsg.textContent = "Fetching songs\u2026";
        try {
          const result = await window._syncLibraryViaJS((count, phase) => {
            if (typeof phase === "string" && phase.startsWith("tracks:")) {
              libSyncMsg.textContent = `Playlist tracks: ${phase.slice(7)}`;
            } else if (phase === "playlists") {
              libSyncMsg.textContent = `Songs done (${count}). Fetching playlists\u2026`;
            } else {
              libSyncMsg.textContent = `Songs: ${count}\u2026`;
            }
          });
          libSyncMsg.textContent = `Done \u2014 ${result.songs} songs, ${result.playlists} playlists`;
          libStatEl.textContent = `${result.songs} songs \xB7 ${result.playlists} playlists \xB7 synced just now`;
          libSyncBtn.textContent = "Sync Now";
          libSyncBtn.disabled = false;
        } catch (e) {
          libSyncMsg.textContent = "Error: " + (e.message || String(e));
          libSyncBtn.textContent = "Sync Now";
          libSyncBtn.disabled = false;
        }
      };
      libSyncRow.append(libSyncBtn, libSyncMsg);
      libBody.appendChild(libSyncRow);
      return wrap;
    }
    let _settingsPreload = null;
    function _warmSettingsCache() {
      _settingsPreload = Promise.all([
        fetchDRM().catch(() => ({ state: {}, capabilities: {}, backend: {} })),
        fetch(`${ENGINE}/api/v1/tools`).then((r) => r.json()).catch(() => ({})),
        window.adamBridge.getPrefs().catch(() => ({})),
        fetch(`${ENGINE}/api/v1/capabilities`).then((r) => r.json()).catch(() => ({}))
      ]);
      return _settingsPreload;
    }
    setTimeout(_warmSettingsCache, 600);
    let _settingsGen = 0;
    async function openSettings() {
      const myGen = ++_settingsGen;
      const dlg = getDialog();
      dlg.innerHTML = "";
      const closeBtn = document.createElement("button");
      closeBtn.id = "adam-settings-close";
      closeBtn.textContent = "\u2715";
      closeBtn.style.cssText = FF + "background:rgba(30,30,32,0.85);border:0.5px solid rgba(255,255,255,0.13);border-radius:50%;width:26px;height:26px;cursor:pointer;color:rgba(255,255,255,0.6);font-size:12px;display:flex;align-items:center;justify-content:center;margin-top:16px;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:background 0.15s,color 0.15s;";
      closeBtn.onmouseenter = () => {
        closeBtn.style.background = "rgba(255,255,255,0.14)";
        closeBtn.style.color = "#fff";
      };
      closeBtn.onmouseleave = () => {
        closeBtn.style.background = "rgba(30,30,32,0.85)";
        closeBtn.style.color = "rgba(255,255,255,0.6)";
      };
      closeBtn.onclick = closeSettings;
      dlg.appendChild(closeBtn);
      const titleBar = document.createElement("div");
      titleBar.style.cssText = "display:flex;align-items:center;gap:10px;padding:4px 0 4px;margin-top:-26px;";
      const title = document.createElement("h1");
      title.textContent = "Adam Settings";
      title.style.cssText = FF + "font-size:17px;font-weight:700;letter-spacing:-0.3px;margin:0;color:rgba(255,255,255,0.95);";
      const savedBadge = document.createElement("span");
      savedBadge.style.cssText = FF + "font-size:10px;color:#30d158;opacity:0;transition:opacity 0.3s;flex-shrink:0;";
      savedBadge.textContent = "\u2713 Saved";
      let _savedTimer = null;
      titleBar.append(title, savedBadge);
      dlg.appendChild(titleBar);
      const _bridge = window.adamBridge;
      if (_bridge._settingsRestore) _bridge._settingsRestore();
      const _realSetTweak = _bridge.setTweak.bind(_bridge);
      const _restoreProxy = () => {
        _bridge.setTweak = _realSetTweak;
        _bridge._settingsRestore = null;
      };
      _bridge._settingsRestore = _restoreProxy;
      _bridge.setTweak = (k, v) => {
        _realSetTweak(k, v);
        savedBadge.style.opacity = "1";
        clearTimeout(_savedTimer);
        _savedTimer = setTimeout(() => {
          savedBadge.style.opacity = "0";
        }, 1400);
      };
      dlg.addEventListener("close", () => {
        _restoreProxy();
        _warmSettingsCache();
      }, { once: true });
      if (!dlg.open) {
        dlg.classList.remove("adam-closing");
        dlg.classList.add("adam-opening");
        dlg.showModal();
        dlg.addEventListener("animationend", () => dlg.classList.remove("adam-opening"), { once: true });
      }
      const [drm, [, tools], prefs] = await Promise.all([
        fetchDRM().catch(() => ({ state: {}, capabilities: {}, backend: {} })),
        _settingsPreload ?? _warmSettingsCache(),
        window.adamBridge.getPrefs().catch(() => ({}))
      ]);
      _warmSettingsCache();
      if (myGen !== _settingsGen) {
        _restoreProxy();
        return;
      }
      const drmSignedIn = accountSignedIn(drm);
      const drmAvailable = drm?.available !== false;
      const [themeWrap, cacheWrap, { wrap: playbackWrap }, scrobbleWrap, historyWrap, libraryWrap] = await Promise.all([
        _buildThemeSection(prefs),
        _buildCacheSection(),
        _buildPlaybackSection(prefs),
        _buildScrobbleSection().then((r) => r.wrap),
        _buildHistorySection(),
        _buildLibrarySection()
      ]);
      if (myGen !== _settingsGen) {
        _restoreProxy();
        return;
      }
      dlg.appendChild(buildAccountSection(drm, openSettings));
      dlg.appendChild(_buildEngineStatusSection(drm));
      dlg.appendChild(_buildDisplaySection(prefs));
      dlg.appendChild(themeWrap);
      const { wrap: audioWrap, onLosslessChange } = _buildAudioSection(prefs, drmSignedIn, drmAvailable);
      dlg.appendChild(audioWrap);
      dlg.appendChild(cacheWrap);
      const { wrap: dlWrap, applyLossless: applyDlLossless } = _buildDownloadsSection(prefs, tools, drmSignedIn, drmAvailable);
      dlg.appendChild(dlWrap);
      onLosslessChange(applyDlLossless);
      dlg.appendChild(playbackWrap);
      dlg.appendChild(_buildShortcutsSection().wrap);
      dlg.appendChild(_buildLinksSection().wrap);
      dlg.appendChild(scrobbleWrap);
      dlg.appendChild(historyWrap);
      dlg.appendChild(libraryWrap);
    }
    const COG_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%" style="display:block;padding:17%"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.05-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;
    const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%" style="display:block;padding:19%"><path d="M11.9952,21.1159C12.3277,21.1159 12.6697,20.9829 12.8977,20.7359L19.12,14.5136C19.3765,14.2571 19.5,13.9531 19.5,13.6396C19.5,12.9462 19.006,12.4522 18.341,12.4522C17.9801,12.4522 17.6856,12.6042 17.4671,12.8322L15.3011,14.9791L13.1352,17.4395L13.2112,15.3781L13.2112,4.254C13.2112,3.5035 12.7172,3 11.9952,3C11.2733,3 10.7793,3.5035 10.7793,4.254L10.7793,15.3781L10.8648,17.4395L8.6894,14.9791L6.5329,12.8322C6.3049,12.6042 6.0199,12.4522 5.659,12.4522C4.994,12.4522 4.5,12.9462 4.5,13.6396C4.5,13.9531 4.6235,14.2571 4.88,14.5136L11.0928,20.7359C11.3303,20.9829 11.6628,21.1159 11.9952,21.1159Z"/></svg>`;
    function findAccountRow() {
      const nav = document.querySelector("nav.navigation") || document.querySelector("nav");
      if (!nav) return null;
      return nav.querySelector('[class*="account-menu"]') || nav.querySelector('[class*="account"]') || nav.querySelector('[class*="Account"]') || nav.querySelector('[aria-haspopup="true"]') || nav.querySelector('[aria-haspopup="menu"]') || nav.querySelector('[aria-label*="ccount"]') || // Last-resort: bottom-most li containing an img (profile photo)
      [...nav.querySelectorAll("li")].reverse().find((li) => li.querySelector("img")) || null;
    }
    const _szN = 28;
    let _cogResizeObs = null;
    function mountSettingsCog() {
      const accountRow = findAccountRow();
      const nav = document.querySelector("nav.navigation") || document.querySelector("nav");
      if (!accountRow || !nav) return;
      let cog = document.getElementById("adam-settings-cog");
      let dlBtn = document.getElementById("adam-downloads-btn");
      if (!cog) {
        cog = document.createElement("button");
        cog.id = "adam-settings-cog";
        cog.title = "Adam Settings";
        cog.innerHTML = COG_SVG;
        _styleNavBtn(cog);
        cog.onclick = (e) => {
          e.stopPropagation();
          openSettings();
        };
        nav.appendChild(cog);
      }
      if (!dlBtn) {
        dlBtn = document.createElement("button");
        dlBtn.id = "adam-downloads-btn";
        dlBtn.title = "Downloads";
        dlBtn.innerHTML = DOWNLOAD_SVG;
        _styleNavBtn(dlBtn);
        dlBtn.onclick = (e) => {
          e.stopPropagation();
          window.__adamToggleDownloads?.();
        };
        nav.appendChild(dlBtn);
      }
      _positionCogButtons(nav, accountRow, cog, dlBtn);
      if (!_cogResizeObs) {
        _cogResizeObs = new ResizeObserver(() => {
          const row = findAccountRow();
          const n = document.querySelector("nav.navigation") || document.querySelector("nav");
          const c = document.getElementById("adam-settings-cog");
          const d = document.getElementById("adam-downloads-btn");
          if (row && n && c && d) _positionCogButtons(n, row, c, d);
        });
        _cogResizeObs.observe(nav);
      }
    }
    function _styleNavBtn(btn) {
      const sz = _szN + "px";
      btn.style.cssText = [
        "position:absolute",
        `width:${sz}`,
        `height:${sz}`,
        "border-radius:50%",
        "border:none",
        "background:rgba(255,255,255,0.10)",
        "color:rgba(255,255,255,0.55)",
        "cursor:pointer",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "transition:background 0.15s,color 0.15s",
        "-webkit-app-region:no-drag",
        "flex-shrink:0",
        "box-sizing:border-box",
        "z-index:200"
      ].join(";");
      btn.onmouseenter = () => {
        btn.style.background = "rgba(255,255,255,0.20)";
        btn.style.color = "rgba(255,255,255,0.9)";
      };
      btn.onmouseleave = () => {
        btn.style.background = "rgba(255,255,255,0.10)";
        btn.style.color = "rgba(255,255,255,0.55)";
      };
    }
    function _positionCogButtons(nav, accountRow, cog, dlBtn) {
      const navRect = nav.getBoundingClientRect();
      const rowRect = accountRow.getBoundingClientRect();
      if (!navRect.height || !rowRect.height) return;
      const top = rowRect.top - navRect.top + (rowRect.height - _szN) / 2;
      const gap = 8;
      cog.style.top = `${top}px`;
      cog.style.right = "10px";
      dlBtn.style.top = `${top}px`;
      dlBtn.style.right = `${10 + _szN + gap}px`;
    }
    watchDomSettled(() => {
      if (findAccountRow()) mountSettingsCog();
    });
    window.__adamOpenEngineSettings = openSettings;
  })();
  (function initAMLDownloads() {
    const PIN_PATH = "M12.219,22.208C12.281,22.208 12.361,22.137 12.46,21.994C12.558,21.851 12.658,21.664 12.758,21.432C12.859,21.199 12.943,20.945 13.012,20.668C13.08,20.391 13.115,20.119 13.115,19.853L13.115,15.075L11.32,15.075L11.32,19.853C11.32,20.119 11.353,20.391 11.421,20.668C11.489,20.945 11.573,21.199 11.674,21.432C11.776,21.664 11.876,21.851 11.975,21.994C12.073,22.137 12.155,22.208 12.219,22.208ZM6.926,15.874L17.506,15.874C17.919,15.874 18.249,15.753 18.496,15.512C18.744,15.271 18.868,14.951 18.868,14.553C18.868,13.91 18.7,13.287 18.364,12.684C18.028,12.082 17.558,11.543 16.953,11.067C16.349,10.59 15.644,10.211 14.838,9.93C14.032,9.649 13.159,9.508 12.219,9.508C11.278,9.508 10.405,9.649 9.597,9.93C8.789,10.211 8.084,10.59 7.481,11.067C6.878,11.543 6.408,12.082 6.07,12.684C5.733,13.287 5.564,13.91 5.564,14.553C5.564,14.951 5.689,15.271 5.938,15.512C6.187,15.753 6.517,15.874 6.926,15.874ZM7.35,14.334C7.202,14.334 7.141,14.248 7.167,14.078C7.22,13.709 7.379,13.342 7.644,12.978C7.909,12.613 8.264,12.282 8.709,11.985C9.153,11.687 9.671,11.449 10.264,11.27C10.856,11.091 11.508,11.001 12.219,11.001C12.926,11.001 13.576,11.091 14.169,11.27C14.762,11.449 15.281,11.687 15.724,11.985C16.168,12.282 16.523,12.613 16.789,12.978C17.055,13.342 17.214,13.709 17.267,14.078C17.293,14.248 17.231,14.334 17.082,14.334L7.35,14.334ZM6.621,3.2C6.621,3.503 6.737,3.802 6.97,4.097C7.109,4.28 7.304,4.483 7.556,4.707C7.808,4.93 8.096,5.163 8.418,5.406C8.741,5.648 9.082,5.89 9.441,6.131L9.129,10.756L10.749,10.756L11.064,5.425C11.071,5.278 11.021,5.176 10.912,5.118C10.66,4.985 10.424,4.852 10.202,4.718C9.981,4.583 9.783,4.456 9.607,4.335C9.431,4.215 9.284,4.107 9.166,4.013C9.048,3.918 8.965,3.847 8.919,3.799C8.884,3.754 8.875,3.716 8.893,3.684C8.911,3.651 8.941,3.635 8.984,3.635L15.45,3.635C15.491,3.635 15.52,3.651 15.538,3.684C15.556,3.716 15.549,3.754 15.515,3.799C15.467,3.847 15.385,3.918 15.269,4.013C15.152,4.107 15.006,4.215 14.83,4.335C14.654,4.456 14.456,4.583 14.233,4.718C14.011,4.852 13.773,4.985 13.519,5.118C13.413,5.176 13.365,5.278 13.376,5.425L13.683,10.756L15.305,10.756L14.99,6.131C15.351,5.89 15.694,5.648 16.019,5.406C16.343,5.163 16.63,4.93 16.88,4.707C17.129,4.483 17.323,4.28 17.461,4.097C17.698,3.802 17.817,3.503 17.817,3.2C17.817,2.907 17.714,2.665 17.507,2.474C17.301,2.282 17.036,2.186 16.711,2.186L7.726,2.186C7.398,2.186 7.131,2.282 6.927,2.474C6.723,2.665 6.621,2.907 6.621,3.2Z";
    const TRASH_PATH = "M16.4187,22.4626C17.571,22.4626 18.2679,21.8214 18.3144,20.6691L18.9091,7.0924L20.303,7.0924C20.684,7.0924 21,6.7672 21,6.3862C21,6.0052 20.684,5.6892 20.303,5.6892L16.1585,5.6892L16.1585,4.2674C16.1585,2.8642 15.2385,2 13.7517,2L10.2297,2C8.7429,2 7.8229,2.8642 7.8229,4.2674L7.8229,5.6892L3.697,5.6892C3.3252,5.6892 3,6.0052 3,6.3862C3,6.7765 3.3252,7.0924 3.697,7.0924L5.1002,7.0924L5.6949,20.6691C5.7414,21.8214 6.4383,22.4626 7.5813,22.4626L16.4187,22.4626ZM14.4858,5.6892L9.5049,5.6892L9.5049,4.3604C9.5049,3.8957 9.8301,3.5798 10.332,3.5798L13.6588,3.5798C14.1606,3.5798 14.4858,3.8957 14.4858,4.3604L14.4858,5.6892ZM9.0589,19.8049C8.7243,19.8049 8.492,19.5911 8.4827,19.2566L8.1946,9.1368C8.1853,8.8116 8.4177,8.5885 8.7801,8.5885C9.1053,8.5885 9.3469,8.8023 9.3562,9.1275L9.635,19.2566C9.6443,19.5818 9.412,19.8049 9.0589,19.8049ZM12.0046,19.8049C11.6515,19.8049 11.4006,19.5818 11.4006,19.2566L11.4006,9.1368C11.4006,8.8116 11.6515,8.5885 12.0046,8.5885C12.3578,8.5885 12.5994,8.8116 12.5994,9.1368L12.5994,19.2566C12.5994,19.5818 12.3578,19.8049 12.0046,19.8049ZM14.9411,19.8049C14.588,19.8049 14.3557,19.5818 14.365,19.2566L14.6438,9.1368C14.6531,8.8023 14.8947,8.5885 15.2199,8.5885C15.5731,8.5885 15.8147,8.8116 15.8054,9.1368L15.5173,19.2566C15.508,19.5911 15.2757,19.8049 14.9411,19.8049Z";
    const DL_PATH = "M11.9952,21.1159C12.3277,21.1159 12.6697,20.9829 12.8977,20.7359L19.12,14.5136C19.3765,14.2571 19.5,13.9531 19.5,13.6396C19.5,12.9462 19.006,12.4522 18.341,12.4522C17.9801,12.4522 17.6856,12.6042 17.4671,12.8322L15.3011,14.9791L13.1352,17.4395L13.2112,15.3781L13.2112,4.254C13.2112,3.5035 12.7172,3 11.9952,3C11.2733,3 10.7793,3.5035 10.7793,4.254L10.7793,15.3781L10.8648,17.4395L8.6894,14.9791L6.5329,12.8322C6.3049,12.6042 6.0199,12.4522 5.659,12.4522C4.994,12.4522 4.5,12.9462 4.5,13.6396C4.5,13.9531 4.6235,14.2571 4.88,14.5136L11.0928,20.7359C11.3303,20.9829 11.6628,21.1159 11.9952,21.1159Z";
    const mkSvg = (path, transform) => {
      const inner = transform ? `<g transform="${transform}"><path d="${path}"/></g>` : `<path d="${path}"/>`;
      return `<svg viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg" width="16" height="16" style="display:block;flex-shrink:0">${inner}</svg>`;
    };
    const _PIN = mkSvg(PIN_PATH, "rotate(-45 12 12)");
    const _TRASH = mkSvg(TRASH_PATH, "");
    const ICON_SVG = {
      "Pin Album": _PIN,
      "Unpin Album": _PIN,
      "Pin Music Video": _PIN,
      "Unpin Music Video": _PIN,
      "Pin Song": _PIN,
      "Unpin Song": _PIN,
      "Pin Playlist": _PIN,
      "Unpin Playlist": _PIN,
      "Delete from Library": _TRASH,
      "Remove from Library": _TRASH,
      "Copy Embed Code": mkSvg(DL_PATH, "")
    };
    ;
    (function injectContextMenuCSS() {
      if (document.getElementById("adam-ctx-icons")) return;
      const li = (t) => `li.contextual-menu-item:has(button[title='${t}'])`;
      const con = (t) => `${li(t)} .contextual-menu-item__icon-container`;
      const svg = (t) => `${con(t)} > svg`;
      const PIN_TITLES = ["Pin Album", "Unpin Album", "Pin Music Video", "Unpin Music Video", "Pin Song", "Unpin Song", "Pin Playlist", "Unpin Playlist"];
      const TRASH_TITLES = ["Delete from Library", "Remove from Library"];
      const EMBED_TITLE = "Copy Embed Code";
      const ALL_CON = [...PIN_TITLES, ...TRASH_TITLES, EMBED_TITLE].map(con).join(",\n");
      const ALL_SVG = [...PIN_TITLES, ...TRASH_TITLES, EMBED_TITLE].map(svg).join(",\n");
      const EMBED_LI = li(EMBED_TITLE);
      const s = document.createElement("style");
      s.id = "adam-ctx-icons";
      s.textContent = `
/* position:relative so our absolute span is clipped to the container */
${ALL_CON} { position:relative !important; }

/* hide Apple's SVG via CSS \u2014 never touch inline styles on Glimmer elements */
${ALL_SVG} { opacity:0 !important; }

/* rename "Copy Embed Code" \u2192 "Download" purely via CSS */
${EMBED_LI} .contextual-menu-item__option-text { font-size:0 !important; }
${EMBED_LI} .contextual-menu-item__option-text::before { content:'Download'; font-size:13px !important; }`;
      document.head.appendChild(s);
    })();
    function _armContainer(container, svgHtml) {
      if (container._adamArmed) return;
      container._adamArmed = true;
      const inject = () => {
        if (container.querySelector("[data-adam]")) return;
        const span = document.createElement("span");
        span.setAttribute("data-adam", "1");
        span.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;";
        span.innerHTML = svgHtml;
        container.appendChild(span);
      };
      inject();
      const obs = new MutationObserver(() => {
        obs.disconnect();
        inject();
        obs.observe(container, { childList: true, subtree: true });
      });
      obs.observe(container, { childList: true, subtree: true });
    }
    function injectMenuIcons(menu) {
      if (!menu) return;
      menu.querySelectorAll("button").forEach((btn) => {
        const title = btn.title || btn.querySelector(".contextual-menu-item__option-text")?.textContent?.trim() || "";
        const svgHtml = ICON_SVG[title];
        if (!svgHtml) return;
        const container = btn.querySelector(".contextual-menu-item__icon-container") || btn.closest("li")?.querySelector(".contextual-menu-item__icon-container");
        if (container) _armContainer(container, svgHtml);
      });
    }
    let _ctxTarget = null;
    document.addEventListener("mousedown", (e) => {
      if (!e.target.closest("amp-contextual-menu")) _ctxTarget = e.target;
    }, true);
    document.addEventListener("contextmenu", (e) => {
      _ctxTarget = e.target;
    }, true);
    function _parseAMHref(href) {
      if (!href || !href.includes("music.apple.com")) return null;
      const sfM = href.match(/\/([a-z]{2,3})\//);
      const sf = sfM?.[1] || "us";
      const songM = href.match(/[?&]i=(\d+)/);
      if (songM) return { type: "song", id: songM[1], storefront: sf };
      const songD = href.match(/\/song\/[^/?#]+\/(\d+)/);
      if (songD) return { type: "song", id: songD[1], storefront: sf };
      const mvM = href.match(/\/music-video\/[^/?#]+\/(\d+)/);
      if (mvM) return { type: "video", id: mvM[1], storefront: sf };
      const plM = href.match(/\/playlist\/[^/?#]+(\/pl\.[a-f0-9]+)/i);
      if (plM) return { type: "playlist", id: plM[1].slice(1), storefront: sf };
      const libPlM = href.match(/\/library\/playlists\/(p\.[A-Za-z0-9]+)/);
      if (libPlM) return { type: "playlist", id: libPlM[1], storefront: sf, isLibrary: true };
      const albumM = href.match(/\/album\/[^/?#]+\/(\d+)/);
      if (albumM) return { type: "album", id: albumM[1], storefront: sf };
      return null;
    }
    function _resolveViaMenuLink(menuNode) {
      return new Promise((resolve) => {
        const copyBtn = Array.from(menuNode.querySelectorAll("button")).find((b) => {
          const t = b.querySelector(".contextual-menu-item__option-text")?.textContent?.trim() || b.title || b.getAttribute("aria-label") || "";
          return t === "Copy Link";
        });
        if (!copyBtn) return resolve(null);
        const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
        const timer = setTimeout(() => {
          navigator.clipboard.writeText = orig;
          resolve(null);
        }, 1e3);
        navigator.clipboard.writeText = async (text) => {
          clearTimeout(timer);
          navigator.clipboard.writeText = orig;
          resolve(text);
          return Promise.reject(new DOMException("", "NotAllowedError"));
        };
        copyBtn.click();
      });
    }
    function resolveTrackInfo(target) {
      let el2 = target;
      for (let i = 0; i < 25 && el2 && el2 !== document.body; i++) {
        const directHref = el2.href || el2.getAttribute?.("href") || "";
        if (directHref) {
          const info = _parseAMHref(directHref);
          if (info) return info;
        }
        const childLink = el2.querySelector?.('a[href*="music.apple.com"]');
        if (childLink) {
          const info = _parseAMHref(childLink.href);
          if (info) return info;
        }
        el2 = el2.parentElement;
      }
      return _parseAMHref(location.href);
    }
    function _mkMetaForId(id) {
      try {
        const mk = window.MusicKit?.getInstance?.();
        const candidates = [mk?.nowPlayingItem, ...mk?.queue?.items || []].filter(Boolean);
        for (const item of candidates) {
          const pid = String(item.id || item.attributes?.playParams?.id || "");
          if (pid === String(id)) {
            return {
              title: item.attributes?.name || "",
              artist: item.attributes?.artistName || "",
              artwork: item.attributes?.artwork?.url || ""
            };
          }
        }
      } catch (_) {
      }
      return null;
    }
    async function prefetchHintMeta(info) {
      const mkMeta = _mkMetaForId(info.id);
      if (mkMeta && mkMeta.title)
        return { title: mkMeta.title, artist: mkMeta.artist, artwork: mkMeta.artwork };
      try {
        const sf = encodeURIComponent(info.storefront || "us");
        const meta = await fetch(`${ENGINE}/api/v1/metadata/${info.id}?sf=${sf}`, {
          signal: AbortSignal.timeout(6e3)
        }).then((r) => r.ok ? r.json() : null).catch(() => null);
        if (meta)
          return { title: meta.title || "", artist: meta.artistName || "", artwork: meta.artworkUrl || "" };
      } catch (_) {
      }
      return { title: "", artist: "", artwork: "" };
    }
    function buildDownloadOptions(prefs) {
      return {
        EmbedArtwork: prefs["embed-artwork"] !== false,
        ArtworkSize: parseInt(prefs["artwork-size"] || "3000", 10),
        EmbedLyrics: prefs["embed-lyrics"] !== false,
        LrcType: prefs["lyrics-type"] || "lyrics",
        LrcFormat: prefs["lyrics-format"] || "lrc",
        SaveLrcSidecar: !!prefs["save-lrc-sidecar"],
        OverwritePolicy: prefs["download-overwrite"] || "skip",
        ConvertToFLAC: !!prefs["convert-to-flac"],
        FFmpegPath: prefs["ffmpeg-path"] || "",
        KeepOriginal: !!prefs["keep-original"],
        ExplicitChoice: prefs["explicit-enabled"] !== false ? prefs["explicit-marker"] || "[E]" : "",
        CleanChoice: prefs["clean-enabled"] ? prefs["clean-marker"] || "[C]" : "",
        MasterChoice: prefs["adm-enabled"] !== false ? prefs["adm-marker"] || "[M]" : ""
      };
    }
    async function startDownload(info) {
      if (!info) {
        console.warn("[Adam] startDownload: no track info");
        return;
      }
      const mk = window.MusicKit?.getInstance?.();
      const prefs = await window.adamBridge?.getPrefs().catch(() => ({})) || {};
      const qual = prefs["downloads-quality"] || _downloadsQuality || "lossless";
      const isLossless = qual !== "high-quality";
      const hint = await prefetchHintMeta(info);
      const _af = prefs["download-album-folder"] || "{album_artist}/{album}";
      const _sf = prefs["download-song-file"] || "{track_number:02d} - {title}";
      const body = {
        AssetID: info.id,
        Storefront: info.storefront,
        Token: mk?.developerToken || "",
        MUT: mk?.musicUserToken || "",
        Language: navigator.language || "en-US",
        Capabilities: {
          Lossless: isLossless,
          Atmos: false,
          Video: info.type === "video",
          Playlist: info.type === "playlist",
          LibraryPlaylist: !!info.isLibrary
        },
        MVMaxHeight: parseInt(prefs["mv-max-height"] ?? "0", 10) || 0,
        OutputDir: prefs["download-dir"] || "",
        FilenameTemplate: `${_af}/${_sf}`,
        Options: buildDownloadOptions(prefs),
        HintTitle: hint.title,
        HintArtist: hint.artist,
        HintArtwork: hint.artwork
      };
      try {
        const res = await fetch(`${ENGINE}/api/v1/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`engine ${res.status}`);
        const job = await res.json();
        openDownloadsPanel();
        return job;
      } catch (e) {
        console.error("[Adam] download error:", e);
      }
    }
    function clampSubmenus(root) {
      const PLAYER_BAR_H = 72;
      const maxBottom = window.innerHeight - PLAYER_BAR_H;
      root.querySelectorAll(
        "div.contextual-menu.contextual-menu--nested, div.contextual-menu.contextual-menu--in-submenu"
      ).forEach((sub) => {
        const list = sub.querySelector("ul.contextual-menu__list");
        if (!list) return;
        const top = sub.getBoundingClientRect().top;
        if (top <= 0) return;
        const available = maxBottom - top - 10;
        if (available > 0) {
          list.style.setProperty("max-height", `${available}px`, "important");
          list.style.setProperty("overflow-y", "auto", "important");
        }
      });
    }
    function setupSubmenuHover(menuRoot) {
      if (!menuRoot || menuRoot._adamSubmenuWired) return;
      const li = menuRoot.querySelector("li.contextual-menu-item:has(button[title='Add to Playlist'])");
      if (!li) return;
      const subs = () => Array.from(menuRoot.querySelectorAll(
        "div.contextual-menu.contextual-menu--nested, div.contextual-menu.contextual-menu--in-submenu"
      ));
      const hide = () => subs().forEach((s) => {
        s.style.setProperty("opacity", "0", "important");
        s.style.setProperty("pointer-events", "none", "important");
        s.style.setProperty("visibility", "hidden", "important");
      });
      const show = () => subs().forEach((s) => {
        s.style.removeProperty("opacity");
        s.style.removeProperty("pointer-events");
        s.style.removeProperty("visibility");
      });
      hide();
      menuRoot._adamSubmenuWired = true;
      li.addEventListener("mouseenter", show);
      li.addEventListener("mouseleave", (e) => {
        if (subs().some((s) => s.contains(e.relatedTarget) || s === e.relatedTarget)) return;
        hide();
      });
      subs().forEach((s) => s.addEventListener("mouseleave", (e) => {
        if (li.contains(e.relatedTarget) || e.relatedTarget === li) return;
        hide();
      }));
    }
    const _menuObservers = /* @__PURE__ */ new Map();
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1 || node.tagName !== "AMP-CONTEXTUAL-MENU") continue;
          node.addEventListener("click", async (e) => {
            const btn = e.target.closest("button");
            if (!btn) return;
            const title = btn.title || btn.querySelector(".contextual-menu-item__option-text")?.textContent?.trim() || "";
            if (title !== "Download" && title !== "Copy Embed Code" && !title.includes("Embed Code")) return;
            e.stopPropagation();
            e.preventDefault();
            let trackInfo = null;
            try {
              const clipUrl = await _resolveViaMenuLink(node);
              if (clipUrl) trackInfo = _parseAMHref(clipUrl);
            } catch (_) {
            }
            if (!trackInfo) trackInfo = resolveTrackInfo(_ctxTarget);
            document.body.click();
            if (trackInfo) startDownload(trackInfo);
          }, true);
          const inner = new MutationObserver(() => {
            injectMenuIcons(node.querySelector(".contextual-menu"));
            clampSubmenus(node);
            setupSubmenuHover(node);
          });
          inner.observe(node, { childList: true, subtree: true });
          _menuObservers.set(node, inner);
          setTimeout(() => {
            injectMenuIcons(node.querySelector(".contextual-menu"));
            setupSubmenuHover(node);
          }, 80);
        }
        for (const node of m.removedNodes) {
          if (node.nodeType !== 1 || node.tagName !== "AMP-CONTEXTUAL-MENU") continue;
          const obs = _menuObservers.get(node);
          if (obs) {
            obs.disconnect();
            _menuObservers.delete(node);
          }
        }
      }
    }).observe(document.body, { childList: true });
    let _panelEl = null;
    if (!document.getElementById("adam-dl-kf")) {
      const _kfs = document.createElement("style");
      _kfs.id = "adam-dl-kf";
      _kfs.textContent = `
@keyframes adam-dl-pulse{0%,100%{opacity:0.55}50%{opacity:1}}
@keyframes adam-dl-dot{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes adam-dl-skel{0%{opacity:.4}50%{opacity:.8}100%{opacity:.4}}
.adam-dl-pill{display:inline-flex;align-items:center;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.1px;flex-shrink:0}
.adam-dl-pill-q{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.38)}
.adam-dl-pill-r{background:rgba(255,214,10,0.13);color:rgba(255,210,80,0.85)}
.adam-dl-pill-dl{background:rgba(255,255,255,0.10);color:rgba(255,255,255,0.60)}
.adam-dl-pill-ok{background:rgba(48,209,88,0.14);color:#30d158}
.adam-dl-pill-err{background:rgba(255,69,58,0.15);color:#ff453a}
.adam-dl-pill-x{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.25)}
.adam-dl-skel-line{border-radius:3px;background:rgba(255,255,255,0.10);animation:adam-dl-skel 1.4s ease-in-out infinite}
.adam-dl-art-skel{background:linear-gradient(135deg,rgba(255,255,255,0.08) 0%,rgba(255,255,255,0.04) 100%);animation:adam-dl-skel 1.4s ease-in-out infinite}`;
      document.head.appendChild(_kfs);
    }
    let _pollTimer = null;
    let _countdownTimer = null;
    const _failedAt = /* @__PURE__ */ new Map();
    function openDownloadsPanel() {
      if (!_panelEl) _panelEl = buildDownloadsPanel();
      if (!document.body.contains(_panelEl)) document.body.appendChild(_panelEl);
      _panelEl.style.display = "flex";
      startPolling();
    }
    function closeDownloadsPanel() {
      if (_panelEl) _panelEl.style.display = "none";
      stopPolling();
    }
    window.__adamToggleDownloads = () => {
      if (!_panelEl || _panelEl.style.display === "none") openDownloadsPanel();
      else closeDownloadsPanel();
    };
    function _sidebarWidth() {
      const nav = document.querySelector("nav.navigation") || document.querySelector('[class*="web-navigation"]') || document.querySelector(".side-panel");
      const w = nav ? nav.offsetWidth : 0;
      return w > 160 ? w : 240;
    }
    function buildDownloadsPanel() {
      const panel = document.createElement("div");
      panel.id = "adam-downloads-panel";
      panel.style.cssText = [
        "position:fixed",
        "bottom:72px",
        "left:8px",
        "width:320px",
        "max-height:520px",
        "background:rgba(24,24,26,0.92)",
        "backdrop-filter:blur(40px) saturate(1.8)",
        "-webkit-backdrop-filter:blur(40px) saturate(1.8)",
        "border:0.5px solid rgba(255,255,255,0.12)",
        "border-radius:14px",
        "box-shadow:0 16px 48px rgba(0,0,0,0.75),0 1px 0 rgba(255,255,255,0.06) inset",
        "z-index:99999",
        "display:flex",
        "flex-direction:column",
        "overflow:hidden",
        "font-family:-apple-system,SF Pro Text,system-ui,sans-serif"
      ].join(";");
      const hdr = document.createElement("div");
      hdr.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:15px 16px 13px;border-bottom:0.5px solid rgba(255,255,255,0.09);flex-shrink:0;gap:8px;";
      const titleGroup = document.createElement("div");
      titleGroup.style.cssText = "display:flex;align-items:baseline;gap:8px;flex:1;min-width:0;";
      const title = document.createElement("span");
      title.textContent = "Downloads";
      title.style.cssText = "color:#fff;font-size:15px;font-weight:600;letter-spacing:-0.3px;";
      const countBadge = document.createElement("span");
      countBadge.id = "adam-dl-count";
      countBadge.style.cssText = "font-size:11px;color:rgba(255,255,255,0.30);font-weight:400;display:none;";
      titleGroup.append(title, countBadge);
      const btnGroup = document.createElement("div");
      btnGroup.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";
      const clearBtn = document.createElement("button");
      clearBtn.id = "adam-dl-cleardone";
      clearBtn.textContent = "Clear done";
      clearBtn.style.cssText = "background:none;border:none;color:rgba(255,255,255,0.32);cursor:pointer;font-size:12px;padding:3px 7px;border-radius:5px;transition:color 0.15s,background 0.15s;display:none;";
      clearBtn.onmouseenter = () => {
        clearBtn.style.color = "rgba(255,255,255,0.75)";
        clearBtn.style.background = "rgba(255,255,255,0.07)";
      };
      clearBtn.onmouseleave = () => {
        clearBtn.style.color = "rgba(255,255,255,0.32)";
        clearBtn.style.background = "none";
      };
      clearBtn.onclick = clearDoneJobs;
      const closeBtn = document.createElement("button");
      closeBtn.innerHTML = `<svg viewBox="0 0 14 14" fill="currentColor" width="14" height="14"><path d="M1.4 1.4a1 1 0 0 1 1.414 0L7 5.586l4.186-4.186a1 1 0 1 1 1.414 1.414L8.414 7l4.186 4.186a1 1 0 1 1-1.414 1.414L7 8.414 2.814 12.6A1 1 0 0 1 1.4 11.186L5.586 7 1.4 2.814A1 1 0 0 1 1.4 1.4z"/></svg>`;
      closeBtn.style.cssText = "background:none;border:none;color:rgba(255,255,255,0.40);cursor:pointer;padding:4px;display:flex;align-items:center;border-radius:50%;transition:color 0.15s,background 0.15s;";
      closeBtn.onmouseenter = () => {
        closeBtn.style.color = "#fff";
        closeBtn.style.background = "rgba(255,255,255,0.10)";
      };
      closeBtn.onmouseleave = () => {
        closeBtn.style.color = "rgba(255,255,255,0.40)";
        closeBtn.style.background = "none";
      };
      closeBtn.onclick = closeDownloadsPanel;
      btnGroup.append(clearBtn, closeBtn);
      hdr.append(titleGroup, btnGroup);
      panel.appendChild(hdr);
      const list = document.createElement("div");
      list.id = "adam-downloads-list";
      list.style.cssText = "flex:1;overflow-y:auto;padding:6px 0;";
      panel.appendChild(list);
      return panel;
    }
    function syncJobRetry(job, retryEnabled, retryDelay) {
      if (job.phase === "failed" && retryEnabled) {
        if (!_failedAt.has(job.jobId)) {
          const deadline = Date.now() + retryDelay;
          const t = setTimeout(() => {
            _failedAt.delete(job.jobId);
            retryJob(job.jobId);
          }, retryDelay);
          _failedAt.set(job.jobId, { timer: t, deadline });
        }
      } else {
        const entry = _failedAt.get(job.jobId);
        if (entry !== void 0) {
          clearTimeout(entry.timer);
          _failedAt.delete(job.jobId);
        }
      }
    }
    let _dlPrefs = {};
    function renderJobs(jobs) {
      const list = document.getElementById("adam-downloads-list");
      if (!list) return;
      const countEl = document.getElementById("adam-dl-count");
      const clearEl = document.getElementById("adam-dl-cleardone");
      if (!jobs?.length) {
        list.innerHTML = "";
        const empty = document.createElement("div");
        empty.style.cssText = "padding:44px 20px;text-align:center;color:rgba(255,255,255,0.28);font-size:12.5px;letter-spacing:-0.1px;";
        empty.textContent = "No downloads yet";
        list.appendChild(empty);
        if (countEl) {
          countEl.textContent = "";
          countEl.style.display = "none";
        }
        if (clearEl) clearEl.style.display = "none";
        return;
      }
      const active = jobs.filter((j) => j.phase !== "done" && j.phase !== "failed" && j.phase !== "cancelled").length;
      const done = jobs.filter((j) => j.phase === "done" || j.phase === "failed" || j.phase === "cancelled").length;
      if (countEl) {
        countEl.textContent = active > 0 ? `${active} active` : `${jobs.length}`;
        countEl.style.display = "";
      }
      if (clearEl) clearEl.style.display = done > 0 ? "" : "none";
      jobs.sort((a, b) => (a.queuePos ?? 0) - (b.queuePos ?? 0));
      const newIds = new Set(jobs.map((j) => j.jobId));
      list.querySelectorAll("[data-job-id]").forEach((el2) => {
        if (!newIds.has(el2.dataset.jobId)) el2.remove();
      });
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        let row = list.querySelector(`[data-job-id="${job.jobId}"]`);
        if (row) {
          updateJobRow(row, job);
        } else {
          row = buildJobRow(job);
          let anchor = null;
          for (let j = i + 1; j < jobs.length; j++) {
            anchor = list.querySelector(`[data-job-id="${jobs[j].jobId}"]`);
            if (anchor) break;
          }
          list.insertBefore(row, anchor);
        }
      }
      const retryEnabled = _dlPrefs["retry-on-fail"] !== false;
      const retryDelay = (parseInt(_dlPrefs["retry-timeout"] ?? "30", 10) || 30) * 1e3;
      for (const job of jobs) syncJobRetry(job, retryEnabled, retryDelay);
    }
    const PHASE_LABEL = {
      queued: "Queued",
      resolving: "Resolving\u2026",
      downloading: "Downloading",
      tagging: "Tagging\u2026",
      moving: "Saving\u2026",
      done: "Done",
      failed: "Failed",
      cancelled: "Cancelled"
    };
    function _fmtBytes(n) {
      if (!n) return "";
      if (n < 1024) return n + " B";
      if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
      if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
      return (n / 1073741824).toFixed(2) + " GB";
    }
    function _artThumb(url, size) {
      if (!url) return "";
      return url.replace("{w}", size).replace("{h}", size);
    }
    const PILL_CLASS = {
      queued: "adam-dl-pill adam-dl-pill-q",
      resolving: "adam-dl-pill adam-dl-pill-r",
      downloading: "adam-dl-pill adam-dl-pill-dl",
      tagging: "adam-dl-pill adam-dl-pill-dl",
      moving: "adam-dl-pill adam-dl-pill-dl",
      done: "adam-dl-pill adam-dl-pill-ok",
      failed: "adam-dl-pill adam-dl-pill-err",
      cancelled: "adam-dl-pill adam-dl-pill-x"
    };
    function buildJobRow(job) {
      const row = document.createElement("div");
      row.dataset.jobId = job.jobId;
      row.style.cssText = "padding:12px 16px;border-bottom:0.5px solid rgba(255,255,255,0.06);display:flex;gap:13px;align-items:flex-start;";
      const art = document.createElement("div");
      art.className = "adam-dl-art";
      art.style.cssText = "width:48px;height:48px;border-radius:9px;flex-shrink:0;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.5);margin-top:1px;";
      const artImg = document.createElement("img");
      artImg.style.cssText = "width:100%;height:100%;object-fit:cover;display:none;";
      art.appendChild(artImg);
      const artSkel = document.createElement("div");
      artSkel.className = "adam-dl-art-skel";
      artSkel.style.cssText = "width:100%;height:100%;";
      art.appendChild(artSkel);
      const col = document.createElement("div");
      col.className = "adam-dl-col";
      col.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;";
      const titleRow = document.createElement("div");
      titleRow.style.cssText = "display:flex;align-items:center;gap:6px;";
      const name = document.createElement("span");
      name.className = "adam-dl-name";
      name.style.cssText = "flex:1;color:rgba(255,255,255,0.92);font-size:13px;font-weight:590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-0.2px;";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "adam-dl-cancel";
      cancelBtn.innerHTML = `<svg viewBox="0 0 10 10" width="9" height="9"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
      cancelBtn.style.cssText = "background:none;border:none;color:rgba(255,255,255,0.20);cursor:pointer;padding:3px;display:flex;align-items:center;flex-shrink:0;border-radius:4px;transition:color 0.15s;";
      cancelBtn.onmouseenter = () => {
        cancelBtn.style.color = "rgba(255,255,255,0.65)";
      };
      cancelBtn.onmouseleave = () => {
        cancelBtn.style.color = "rgba(255,255,255,0.20)";
      };
      cancelBtn.onclick = () => cancelJob(job.jobId);
      titleRow.append(name, cancelBtn);
      const metaRow = document.createElement("div");
      metaRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:6px;";
      const artist = document.createElement("span");
      artist.className = "adam-dl-artist";
      artist.style.cssText = "color:rgba(255,255,255,0.40);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
      const pill = document.createElement("span");
      pill.className = "adam-dl-pill adam-dl-pill-q";
      metaRow.append(artist, pill);
      const progRow = document.createElement("div");
      progRow.className = "adam-dl-prog-row";
      progRow.style.cssText = "display:flex;align-items:center;gap:8px;";
      const bar = document.createElement("div");
      bar.style.cssText = "flex:1;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;";
      const fill = document.createElement("div");
      fill.className = "adam-dl-fill";
      fill.style.cssText = "height:100%;border-radius:2px;width:0%;transition:width 0.4s ease;background:rgba(255,255,255,0.85);";
      bar.appendChild(fill);
      const sizeLabel = document.createElement("span");
      sizeLabel.className = "adam-dl-size";
      sizeLabel.style.cssText = "font-size:10.5px;color:rgba(255,255,255,0.28);flex-shrink:0;font-variant-numeric:tabular-nums;min-width:52px;text-align:right;";
      progRow.append(bar, sizeLabel);
      col.append(titleRow, metaRow, progRow);
      row.append(art, col);
      updateJobRow(row, job);
      return row;
    }
    function _applyJobNameArtist(name, artist, hasTitle, job) {
      if (name) {
        if (hasTitle) {
          name.textContent = job.title || job.output.split("/").pop();
          name.style.cssText = "flex:1;color:rgba(255,255,255,0.92);font-size:13px;font-weight:590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-0.2px;";
        } else {
          name.textContent = "";
          name.style.cssText = "flex:1;height:11px;margin:1px 0;border-radius:3px;background:rgba(255,255,255,0.10);animation:adam-dl-skel 1.4s ease-in-out infinite;max-width:70%;";
        }
      }
      if (artist) {
        if (hasTitle) {
          artist.textContent = job.artistName || "";
          artist.style.cssText = "color:rgba(255,255,255,0.40);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
        } else {
          artist.textContent = "";
          artist.style.cssText = "flex:1;height:9px;margin:1px 0;border-radius:3px;background:rgba(255,255,255,0.07);animation:adam-dl-skel 1.4s ease-in-out infinite;max-width:45%;";
        }
      }
    }
    function _applyJobFill(fill, phase, isActive, isTerminal, job) {
      if (!fill) return;
      const BG = { done: "#30d158", failed: "#ff453a", cancelled: "rgba(255,255,255,0.10)" };
      const pct2 = isTerminal ? 100 : job.percent ?? 0;
      const bg = BG[phase] || "rgba(255,255,255,0.85)";
      if (phase === "downloading") {
        fill.style.cssText = `height:100%;border-radius:2px;width:${pct2}%;transition:width 0.6s ease;background:${bg};animation:none;`;
      } else if (isActive) {
        fill.style.cssText = `height:100%;border-radius:2px;width:${pct2}%;transition:width 0.4s ease;background:${bg};animation:adam-dl-pulse 1.2s ease-in-out infinite;`;
      } else {
        fill.style.cssText = `height:100%;border-radius:2px;width:${pct2}%;transition:width 0.4s ease;background:${bg};animation:none;`;
      }
    }
    function _applyJobRetry(row, job, phase) {
      const col = row.querySelector(".adam-dl-col");
      let retryBtn = row.querySelector(".adam-dl-retry");
      let countdownEl = row.querySelector(".adam-dl-countdown");
      if (phase === "failed" || phase === "cancelled") {
        if (!retryBtn && col) {
          retryBtn = document.createElement("button");
          retryBtn.className = "adam-dl-retry";
          retryBtn.style.cssText = "margin-top:2px;padding:3px 10px;background:rgba(252,60,68,0.13);border:0.5px solid rgba(252,60,68,0.30);border-radius:5px;color:#fc3c44;font-size:10px;cursor:pointer;font-weight:500;transition:background 0.15s;align-self:flex-start;";
          retryBtn.onmouseenter = () => {
            retryBtn.style.background = "rgba(252,60,68,0.28)";
          };
          retryBtn.onmouseleave = () => {
            retryBtn.style.background = "rgba(252,60,68,0.13)";
          };
          retryBtn.onclick = () => {
            const entry2 = _failedAt.get(job.jobId);
            if (entry2) {
              clearTimeout(entry2.timer);
              _failedAt.delete(job.jobId);
            }
            retryBtn.textContent = "Retrying\u2026";
            retryBtn.disabled = true;
            if (countdownEl) countdownEl.textContent = "";
            retryJob(job.jobId);
          };
          col.appendChild(retryBtn);
        }
        if (retryBtn) retryBtn.textContent = retryBtn.disabled ? "Retrying\u2026" : "Retry";
        const entry = _failedAt.get(job.jobId);
        if (entry && phase === "failed") {
          if (!countdownEl && col) {
            countdownEl = document.createElement("span");
            countdownEl.className = "adam-dl-countdown";
            countdownEl.style.cssText = "font-size:10px;color:rgba(255,255,255,0.28);margin-top:1px;align-self:flex-start;";
            col.appendChild(countdownEl);
          }
          if (countdownEl) {
            const secs = Math.max(0, Math.ceil((entry.deadline - Date.now()) / 1e3));
            countdownEl.textContent = secs > 0 ? `Auto-retry in ${secs}s` : "Retrying\u2026";
          }
        } else {
          countdownEl?.remove();
        }
      } else {
        retryBtn?.remove();
        countdownEl?.remove();
      }
    }
    function _applyJobMedia(artImg, artSkel, size, progRow, cancelBtn, phase, isTerminal, job) {
      if (size) {
        if (phase === "downloading" && job.bytesTotal && job.bytesDone) {
          size.textContent = `${_fmtBytes(job.bytesDone)} / ${_fmtBytes(job.bytesTotal)}`;
        } else {
          size.textContent = _fmtBytes(job.bytesDone);
        }
      }
      if (progRow) progRow.style.display = phase === "queued" || phase === "cancelled" ? "none" : "flex";
      if (artImg && job.artworkUrl) {
        if (artImg.style.display === "none") {
          artImg.src = _artThumb(job.artworkUrl, 84);
          artImg.style.display = "block";
        }
        if (artSkel) artSkel.style.display = "none";
      }
      if (cancelBtn) cancelBtn.style.display = isTerminal ? "none" : "flex";
    }
    function updateJobRow(row, job) {
      const name = row.querySelector(".adam-dl-name");
      const artist = row.querySelector(".adam-dl-artist");
      const pill = row.querySelector(".adam-dl-pill");
      const fill = row.querySelector(".adam-dl-fill");
      const size = row.querySelector(".adam-dl-size");
      const artEl = row.querySelector(".adam-dl-art");
      const artImg = artEl?.querySelector("img");
      const artSkel = artEl?.querySelector(".adam-dl-art-skel");
      const cancelBtn = row.querySelector(".adam-dl-cancel");
      const progRow = row.querySelector(".adam-dl-prog-row");
      const phase = job.phase || "";
      const hasTitle = !!(job.title || job.output);
      const isTerminal = phase === "done" || phase === "failed" || phase === "cancelled";
      const isActive = phase === "downloading" || phase === "tagging" || phase === "moving" || phase === "resolving";
      _applyJobNameArtist(name, artist, hasTitle, job);
      if (pill) {
        pill.className = PILL_CLASS[phase] || "adam-dl-pill adam-dl-pill-q";
        pill.textContent = PHASE_LABEL[phase] || phase;
      }
      _applyJobFill(fill, phase, isActive, isTerminal, job);
      _applyJobMedia(artImg, artSkel, size, progRow, cancelBtn, phase, isTerminal, job);
      _applyJobRetry(row, job, phase);
    }
    async function clearDoneJobs() {
      const res = await fetch(`${ENGINE}/api/v1/export`).then((r) => r.json()).catch(() => []);
      const terminal = (Array.isArray(res) ? res : []).filter((j) => j.phase === "done" || j.phase === "failed" || j.phase === "cancelled");
      await Promise.all(terminal.map((j) => fetch(`${ENGINE}/api/v1/export/${j.jobId}`, { method: "DELETE" }).catch(() => {
      })));
      pollJobs();
    }
    async function cancelJob(id) {
      await fetch(`${ENGINE}/api/v1/export/${id}`, { method: "DELETE" }).catch(() => {
      });
      pollJobs();
    }
    async function retryJob(id) {
      await fetch(`${ENGINE}/api/v1/export/${id}/retry`, { method: "POST" }).catch(() => {
      });
      pollJobs();
    }
    let _pollSeq = 0;
    async function pollJobs() {
      const seq = ++_pollSeq;
      try {
        const jobs = await fetch(`${ENGINE}/api/v1/export`).then((r) => r.json());
        _dlPrefs = await window.adamBridge?.getPrefs().catch(() => ({})) || {};
        if (seq === _pollSeq) renderJobs(Array.isArray(jobs) ? jobs : []);
      } catch (_) {
      }
    }
    function _tickCountdowns() {
      document.querySelectorAll(".adam-dl-countdown").forEach((el2) => {
        const jobId = el2.closest("[data-job-id]")?.dataset.jobId;
        if (!jobId) return;
        const entry = _failedAt.get(jobId);
        if (!entry) {
          el2.textContent = "";
          return;
        }
        const secs = Math.max(0, Math.ceil((entry.deadline - Date.now()) / 1e3));
        el2.textContent = secs > 0 ? `Auto-retry in ${secs}s` : "Retrying\u2026";
      });
    }
    function startPolling() {
      if (_pollTimer) return;
      if (document.visibilityState === "hidden") return;
      pollJobs();
      _pollTimer = setInterval(pollJobs, 2e3);
      _countdownTimer = setInterval(_tickCountdowns, 1e3);
    }
    function stopPolling() {
      if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
      }
      if (_countdownTimer) {
        clearInterval(_countdownTimer);
        _countdownTimer = null;
      }
    }
    const _panelOpen = () => !!_panelEl && _panelEl.style.display !== "none";
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") stopPolling();
      else if (_panelOpen()) startPolling();
    });
  })();
})();
