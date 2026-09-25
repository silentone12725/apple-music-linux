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

  // src/engine-playback.js
  if (window.__amlEngineInjected) throw new Error("[AML] double-injection guard");
  window.__amlEngineInjected = true;
  var ENGINE = window._amlEngineURL || "http://127.0.0.1:20025";
  var ENGINE_HTTPS = ENGINE.replace(/^http:\/\/(127\.0\.0\.1|localhost):(\d+)/, (_, host, port) => `https://${host}:${Number(port) + 1}`);
  var _AML_DEBUG = !!window.amlBridge?.isDev || localStorage.getItem("_AML_DEBUG") === "1";
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
    console.log(`[AML Power] mode=${mode} (floor=${_sysPowerFloor ?? "none"})`);
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
    console.log(`[AML Power] sys profile=${profile} \u2192 floor=${_sysPowerFloor ?? "none"}`);
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
    const fetch2 = () => window.amlBridge?.getPowerProfile().then(_applySysPowerProfile).catch(() => {
    });
    fetch2();
    setInterval(fetch2, 3e4);
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
              console.warn("[AML DOM] watcher threw:", err);
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
  if (window._amlDebug) (function installAudioCapture() {
    const CAP_LIMIT = 64 * 1024 * 1024;
    window.__amlCapture = {
      chunks: [],
      // {n, path, size, b64, boxes, bufBefore, bufAfter, grew, t}
      totalBytes: 0,
      enabled: true
    };
    window.__amlParseMp4 = mp4ParseBoxes;
    window.__amlCaptureChunk = function(path, n, value, bufBefore, bufAfter, grew) {
      if (!window.__amlCapture.enabled) return;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const HEADER = 8192;
      const slice = bytes.slice(0, HEADER);
      const hex = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join("");
      const boxes = window.__amlParseMp4(bytes);
      window.__amlCapture.chunks.push({
        n,
        path,
        size: value.byteLength,
        capturedBytes: slice.length,
        hex,
        // first 8 KB as hex string
        boxes,
        bufBefore,
        bufAfter,
        grew,
        t: Date.now()
      });
      window.__amlCapture.totalBytes += value.byteLength;
    };
    window.__amlDrainCapture = function() {
      const out = window.__amlCapture.chunks.slice();
      window.__amlCapture.chunks = [];
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
  var _mkApiSaved = null;
  var _savedAacApiRestore = null;
  var _savedGateTracingCleanup = null;
  var _pendingExternalClickCatalogId = null;
  var _pendingExternalClickQueueIdx = -1;
  var _pendingPlaylistFetch = null;
  var _directPlayAdamId = null;
  var _directPlayGen = 0;
  var _directPlayPromise = null;
  var _amlNextRef = null;
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
  var _vlcVolPersist = 100;
  var _amlTransitioning = false;
  var _sessionContainers = [];
  var _sessionContainerIdx = -1;
  var _sessionItemIdx = -1;
  var _amlNavInternal = false;
  var _amlPendingCI = -1;
  var _amlPendingII = -1;
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
        for (const child of p.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            if (child.textContent.trim()) words.push({ begin: 0, end: 0, text: child.textContent, ws: true });
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            const wb = _ttmlMs(child.getAttribute("begin")), we = _ttmlMs(child.getAttribute("end"));
            const text = child.getAttribute("text") || child.textContent;
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
    const el = document.createElement("div");
    el.id = "aml-lyrics-overlay";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:99998;display:none;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.86);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);transition:opacity 0.35s;opacity:0;overflow:hidden;font-family:-apple-system,SF Pro Display,system-ui,sans-serif;box-sizing:border-box;";
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
    inner.id = "aml-sl-inner";
    inner.style.cssText = "width:100%;max-width:700px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:80px 32px 48px;box-sizing:border-box;overflow-y:auto;max-height:100%;scroll-behavior:smooth;scrollbar-width:none;";
    el.append(closeBtn, inner);
    document.body.appendChild(el);
    _slOverlay = el;
  }
  function _slRenderLines(lines) {
    if (!_slOverlay) _slBuildOverlay();
    const c = _slOverlay.querySelector("#aml-sl-inner");
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
      _slOverlay.querySelector("#aml-sl-inner").innerHTML = "";
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
  var _wcStallPaused = false;
  var _wcAudioHold = false;
  var _activeMvControls = null;
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
  function blockAppleCDN() {
    if (window.__amlCDNBlocked) return;
    window.__amlCDNBlocked = true;
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    _nativeSrcSet = desc.set;
    _nativeCTSet = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime").set;
    const isAppleCDN = (url) => url && !url.startsWith("blob:") && !url.startsWith("data:") && url !== "" && /mzstatic\.com|audio-ssl\.itunes\.apple\.com|akamaized\.net|cdn-apple\.com/i.test(url);
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      get: desc.get,
      set(val) {
        if (isAppleCDN(val) && !_allowCDNTransition) {
          console.log("[AML Engine] Blocked CDN src:", val.slice(0, 80));
          return;
        }
        if (isAppleCDN(val) && _allowCDNTransition) {
          console.log("[AML Engine] CDN src THROUGH (gate open):", val.slice(0, 80));
        }
        if (_allowCDNTransition && val !== void 0) {
          console.log('[AUDIO-SRC] gate-open src set \u2192 "' + String(val).slice(0, 60) + '"');
        }
        if (val?.startsWith("blob:") && _ourBlobUrl && val !== _ourBlobUrl) {
          return;
        }
        desc.set.call(this, val);
      },
      configurable: true,
      enumerable: desc.enumerable
    });
    const realSetAttr = HTMLMediaElement.prototype.setAttribute;
    HTMLMediaElement.prototype.setAttribute = function(name, val) {
      if (name === "src" && isAppleCDN(val) && !_allowCDNTransition) return;
      return realSetAttr.call(this, name, val);
    };
    console.log("[AML Engine] Apple CDN audio blocked");
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
        console.log(`[AML VLC] audio.play() \u2192 resume`);
        _vlcPaused = false;
        const p2 = new Promise((resolve) => _resolvers.push(resolve));
        mkAudio.dispatchEvent(new Event("playing"));
        if (_vlcLoading) mkAudio.dispatchEvent(new Event("waiting"));
        fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
        });
        return p2;
      }
      if (_msePaused || _wcStallPaused) return new Promise(() => {
      });
      if (_wcAudioHold) {
        const p2 = new Promise((resolve) => _resolvers.push(resolve));
        mkAudio.dispatchEvent(new Event("playing"));
        mkAudio.dispatchEvent(new Event("waiting"));
        return p2;
      }
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
    console.log("[AML Engine] Play proxy installed");
  }
  function installMKSeekInterceptor(mk) {
    if (mk.__amlSeekIntercepted) return;
    mk.__amlSeekIntercepted = true;
    const _origSeek = mk.seekToTime.bind(mk);
    mk.seekToTime = async function(seekSec) {
      const audio = getMKAudio();
      if (_vlcMode) {
        _vlcPosMs = Math.round(seekSec * 1e3);
        _vlcSeekFrozen = true;
        console.log(`[AML VLC] seekToTime(${seekSec.toFixed(3)})  target=${_vlcPosMs}ms  debounce-reset`);
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
          console.log(`[AML VLC seek] \u25BA SEND  posMs=${seekTarget}ms  wasPlaying=${_vlcWasPlaying}  uiPos=${_vlcPosMs}ms`);
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
            actualStartMs = seekData.actualStartMs ?? seekTarget;
            console.log(`[AML VLC seek] \u25C4 RECV  target=${seekTarget}ms  engine.actualStart=${actualStartMs}ms  rtt=${rtt}ms`);
            _vlcPosMs = seekTarget;
          } catch (e) {
            console.warn(`[AML VLC seek] \u2717 ERROR`, e);
          }
          _vlcSeekOffsetMs = 0;
          _vlcPrevState = null;
          _vlcSeekFrozen = false;
          _seekBurstLog = 20;
          if (_vlcWasPlaying) {
            _vlcPaused = false;
            _vlcPostSeek = true;
            fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
            });
          }
          console.log(`[AML VLC seek] \u21BA UNFREEZE  uiPos=${_vlcPosMs}ms  postSeek=${_vlcPostSeek}`);
          window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1e3, seeked: true });
        }, T().debounce);
      } else if (_activeMvControls) {
        _activeMvControls.seekTo(seekSec);
      } else {
        if (!_mvGateOpen) {
          console.log(`[AML MV] seek blocked \u2014 A/V gate not open yet (seekSec=${seekSec.toFixed(2)})`);
          return;
        }
        _ourSeekPending = true;
        _ourSeekTarget = seekSec;
        if (audio) _nativeCTSet.call(audio, seekSec);
      }
    };
    console.log("[AML Engine] MK seek interceptor installed");
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
      window.amlBridge?.mprisUpdate?.({ position: Math.round(_activeMvControls.currentTime * 1e3) * 1e3 });
      return;
    }
    const a = getMKAudio();
    if (!a || a.paused || !Number.isFinite(a.currentTime) || a.currentTime <= 0) return;
    window.amlBridge?.mprisUpdate?.({ position: Math.round(a.currentTime * 1e3) * 1e3 });
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
    "rgba(255,255,255,.26) var(--aml-buffer,var(--progress,0%)),",
    "rgba(255,255,255,.12) var(--aml-buffer,var(--progress,0%))",
    ")!important}"
  ].join("");
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
  var _playState = PLAY_STATE.IDLE;
  function setPlayState(next, ctx) {
    const prev = _playState;
    _playState = next;
    if (prev !== next) console.log(`[AML State] ${prev} \u2192 ${next}${ctx ? " | " + ctx : ""}`);
  }
  function genStale(myGen) {
    return myGen !== _generation;
  }
  var _mvMaxHeight = parseInt(localStorage.getItem("aml-mv-quality") || "1080", 10);
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
    let pop = document.getElementById("aml-quality-popup");
    if (!pop) {
      pop = document.createElement("div");
      pop.id = "aml-quality-popup";
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
    let badge = document.getElementById("aml-quality-badge");
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
      document.getElementById("aml-quality-popup")?.style && (document.getElementById("aml-quality-popup").style.display = "none");
      window.amlBridge?.mprisUpdate?.({ qualityBadge: null });
      return;
    }
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "aml-quality-badge";
      badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;border-radius:3px;padding:1px 4px;cursor:pointer;z-index:9999;white-space:nowrap;font-size:7.5px;font-weight:700;letter-spacing:.07em;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;transition:opacity 0.12s;';
      badge.addEventListener("mouseenter", () => {
        badge.style.opacity = "0.75";
      });
      badge.addEventListener("mouseleave", () => {
        badge.style.opacity = "1";
        setTimeout(() => {
          const pop = document.getElementById("aml-quality-popup");
          if (pop) pop.style.display = "none";
        }, 200);
      });
      badge.addEventListener("click", (e) => {
        e.stopImmediatePropagation();
        e.stopPropagation();
        const pop = document.getElementById("aml-quality-popup");
        if (pop && pop.style.display !== "none") {
          pop.style.display = "none";
        } else {
          _showQualityPopup(badge);
        }
      }, true);
      document.addEventListener("click", () => {
        const pop = document.getElementById("aml-quality-popup");
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
    window.amlBridge?.mprisUpdate?.({ qualityBadge: { codec, sampleRate, bitDepth, spatialAudio } });
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
      if (document.getElementById("aml-np-badge")) return;
      const sr = scrubber.shadowRoot;
      if (!sr) return;
      _npBadge = document.createElement("div");
      _npBadge.id = "aml-np-badge";
      _npBadge.style.cssText = "display:none;align-items:center;gap:5px;padding:3.5px 7px;border-radius:5px;font-size:11px;font-weight:500;letter-spacing:0em;line-height:1;white-space:nowrap;user-select:none;cursor:pointer;color:rgba(255,255,255,0.65);background:rgba(255,255,255,0.08);transition:opacity 0.12s;position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:2;";
      _npBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        const pop = document.getElementById("aml-quality-popup");
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
          const pop = document.getElementById("aml-quality-popup");
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
    setInterval(_check, 800);
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
      console.log(`[AML Engine] Stream open +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
    } else {
      resp = streamUrlOrResp;
      console.log(`[AML Engine] Stream open (seek) +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
    }
    const reader = resp.body.getReader();
    let chunks = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error("aborted");
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[AML Engine] Stream done (${chunks} chunks) +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
          break;
        }
        chunks++;
        if (ms.readyState !== "open" || audio.error) throw new Error(`MediaSource closed or audio error: ms=${ms.readyState} err=${audio.error?.code}`);
        _cacheAudioChunk(localSessionId, value);
        if (sb.buffered.length > 0 && audio.currentTime > sb.buffered.start(0) + BACKWARD_SECS + 1) {
          await _sbEvictPlayed(ms, sb, audio, BACKWARD_SECS);
        }
        await _throttleForward(ms, sb, audio, signal, FORWARD_SECS);
        await _sbWaitUpdate(sb, chunks);
        if (signal.aborted) throw new Error("aborted");
        if (ms.readyState !== "open" || audio.error) throw new Error(`MediaSource closed or audio error [post-wait]: ms=${ms.readyState} err=${audio.error?.code}`);
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
        console.log(`[AML Engine] Stream complete +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
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
          if (e.name === "QuotaExceededError") console.warn("[AML MSE] cache re-inject quota exceeded");
          return;
        }
      }
      await _mseFinalizeCacheInject(ms, sb, audio, pipeCtrl, mySC, wasStreamComplete, seekSec);
    } catch (e) {
      if (!pipeCtrl.signal.aborted) console.error("[AML MSE] cache re-inject error:", e.message);
    }
  }
  function _mseCacheSeek(sb, audio, ms, seekSec) {
    if (Math.abs(_seekTarget - seekSec) < 0.5) {
      console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s \u2192 cache guard`);
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
    console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s \u2192 cache re-inject (${(cacheSnap.byteSize / 1e6).toFixed(1)} MB)`);
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
      console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s \u2192 guard`);
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
      if (e.name !== "AbortError") console.warn("[AML MSE] Seek fetch error:", e.message);
      return;
    }
    if (!resp.ok) {
      console.warn(`[AML MSE] Seek ${resp.status} \u2014 not seekable`);
      return;
    }
    if (_abortCtrl?.signal.aborted || _seekFetchCtrl !== mySeekCtrl) {
      resp.body?.cancel();
      return;
    }
    const actualStart = parseFloat(resp.headers.get("X-Actual-Start") ?? seekSec);
    console.log(`[AML MSE] Seek \u2192 ${seekSec.toFixed(2)}s (actual=${actualStart.toFixed(2)}s)`);
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
      if (!pipeCtrl.signal.aborted) console.error("[AML MSE] Seek pipe error:", e.message);
    });
    audio.addEventListener("canplay", () => {
      if (pipeCtrl.signal.aborted) return;
      try {
        sb.appendWindowStart = 0;
      } catch (_) {
      }
      _seekTarget = -Infinity;
      console.log(`[AML MSE] Seek ready \u2014 req=${seekSec.toFixed(2)}s actual=${actualStart.toFixed(2)}s ct=${audio.currentTime.toFixed(2)}s`);
      if (wasPlaying) _nativePlay().catch((e) => console.warn("[AML MSE] seek play():", e));
    }, { once: true });
  }
  async function mseSeekToTime(seekSec, audio, sb, ms) {
    if (ms.readyState === "closed") return;
    const bufferedRanges = Array.from({ length: sb.buffered.length }, (_, i) => `[${sb.buffered.start(i).toFixed(1)},${sb.buffered.end(i).toFixed(1)}]`).join(" ");
    console.log(`[AML MSE] seekToTime(${seekSec.toFixed(2)}) ct=${audio.currentTime.toFixed(2)} buffered=${bufferedRanges || "(empty)"} seekable=${_seekable}`);
    for (let i = 0; i < sb.buffered.length; i++) {
      if (seekSec >= sb.buffered.start(i) - 1 && seekSec < sb.buffered.end(i) + 1) {
        console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s \u2192 native (buffered)`);
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
      console.log(`[AML MSE] Seek ${seekSec.toFixed(2)}s \u2192 not seekable`);
      return;
    }
    await _mseNetworkSeek(sb, audio, ms, seekSec);
  }
  function stopVLCPoll() {
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
    console.log(`[AML MV-V] enter gen=${_mvGen} session=${_sessionId} t=${Date.now()}`);
    _mvGateOpen = false;
    const containerPromise = getMVContainer(_abortCtrl.signal);
    const myVid = document.createElement("video");
    myVid.muted = true;
    myVid.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(myVid);
    const mkAudio = document.createElement("audio");
    mkAudio.style.display = "none";
    document.body.appendChild(mkAudio);
    mkAudio.addEventListener("play", () => console.log(`[AML MV-A] mkAudio play event ct=${mkAudio.currentTime.toFixed(2)} muted=${mkAudio.muted} vol=${mkAudio.volume}`));
    mkAudio.addEventListener("playing", () => console.log(`[AML MV-A] mkAudio playing event ct=${mkAudio.currentTime.toFixed(2)}`));
    mkAudio.addEventListener("pause", () => console.log(`[AML MV-A] mkAudio pause event ct=${mkAudio.currentTime.toFixed(2)}`));
    mkAudio.addEventListener("error", () => console.error(`[AML MV-A] mkAudio error code=${mkAudio.error?.code} msg=${mkAudio.error?.message}`));
    let ms = new MediaSource();
    let msBlobUrl = URL.createObjectURL(ms);
    myVid.src = msBlobUrl;
    let mvContainer;
    try {
      mvContainer = await containerPromise;
      console.log(`[AML MV] container found ${mvContainer.offsetWidth}\xD7${mvContainer.offsetHeight}`);
      mvContainer.style.setProperty("pointer-events", "none", "important");
      mvContainer.style.setProperty("cursor", "wait", "important");
    } catch (e) {
      console.warn("[AML MV] MV container not found, aborting:", e.message);
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
    console.log(`[AML MV-V] shadow traversal: avpi=${!!avpi} avp=${!!avp} avpShadow=${!!avpShadow} vcDiv=${!!vcDiv} nativeVidEl=${!!nativeVidEl} nativeVidEl.id=${nativeVidEl?.id} nativeVidEl.src="${nativeVidEl?.src?.slice(0, 60)}"`);
    if (nativeVidEl) {
      const _vidRef = nativeVidEl;
      Function.prototype.call = function(ctx, ...args) {
        if (this === _nativePauseRef && ctx === _vidRef) {
          console.warn("[AML MV] intercepted savedPause.call(nativeVidEl) \u2014 counter-pause blocked. Stack:", new Error().stack.split("\n").slice(1, 4).join(" | "));
          return;
        }
        return Reflect.apply(_origFnCall, this, [ctx, ...args]);
      };
      Function.prototype.apply = function(ctx, args) {
        if (this === _nativePauseRef && ctx === _vidRef) {
          console.warn("[AML MV] intercepted savedPause.apply(nativeVidEl) \u2014 counter-pause blocked.");
          return;
        }
        return Reflect.apply(_origFnApply, this, [ctx, args]);
      };
      console.log("[AML MV] Function.prototype.call/apply intercept installed for counter-pause");
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
    const _nativeVideo = false;
    const _wcVideo = false;
    const _mp4Video = false;
    const _vsegVideo = true;
    let _vsegBufferedSec = 0;
    let _wcCleanup = null;
    let _wcBufferedSec = 0;
    let _wcParsedSec = 0;
    let _wcVW = 0, _wcVH = 0;
    console.log("%c[AML MV]%c video backend = %c%s", "color:#bf5af2;font-weight:bold", "color:inherit", "color:#30d158;font-weight:bold", _vsegVideo ? "vseg" : _nativeVideo ? "native-dl" : _wcVideo ? "webcodecs" : "mse");
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
      if (_wcVideo) return _iframePlay.call(mkAudio).catch(() => {
      });
      return _iframePlay.call(myVid).then(() => _iframePlay.call(mkAudio).catch(() => {
      })).catch(() => {
      });
    };
    const mvPause = () => {
      _userPaused = true;
      if (!_wcVideo) myVid.pause();
      mkAudio.pause();
    };
    const togglePlayPause = () => {
      if (_wcVideo ? mkAudio.paused : myVid.paused) mvPlay();
      else mvPause();
    };
    if (nativeVidEl) {
      nativeVidEl.play = function() {
        console.log(`[AML MV] nativeVidEl.play() intercepted \u2192 myVid.paused=${myVid?.paused} _bufPaused=${_bufPaused} _avStarted=${_avStarted}`);
        if (!_avStarted) return Promise.resolve();
        if (_wcVideo ? mkAudio?.paused : myVid?.paused) mvPlay();
        return Promise.resolve();
      };
      nativeVidEl.pause = function() {
        console.log(`[AML MV] nativeVidEl.pause() intercepted \u2192 forwarding to mvPause`);
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
      const vw = _wcVW || myVid.videoWidth, vh2 = _wcVH || myVid.videoHeight;
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
      console.log(`[AML MV] abort: ${reason}`);
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
    if (!document.querySelector("#aml-sfpro-style")) {
      fetch(`${ENGINE}/fonts/SF-Pro.ttf`).then((r) => r.ok ? r.blob() : null).then((b) => {
        if (!b) return;
        const url = URL.createObjectURL(b);
        const s = document.createElement("style");
        s.id = "aml-sfpro-style";
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
        const v = getComputedStyle(document.documentElement).getPropertyValue("--aml-accent-active").trim();
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
        localStorage.setItem("aml-mv-quality", String(height));
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
    [...infoEls, footerRow].forEach((el) => {
      if (!el) return;
      el.style.setProperty("visibility", "visible", "important");
      el.style.setProperty("opacity", "1", "important");
    });
    const footerEls = avp ? [...avp.querySelectorAll('[slot="footer"]')] : [];
    const scrubberEl = footerEls[0]?.querySelector("amp-playback-controls-progress") ?? footerRow?.querySelector("amp-playback-controls-progress");
    const scrubberShadow = scrubberEl?.shadowRoot;
    const rangeInput = scrubberShadow?.querySelector("#playback-progress") ?? scrubberShadow?.querySelector("input[type=range]");
    if (scrubberShadow && !scrubberShadow.getElementById("aml-buf-style")) {
      const st = document.createElement("style");
      st.id = "aml-buf-style";
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
          if (_wcVideo || _nativeVideo) {
            if (timeElapsed) timeElapsed.textContent = _fmtTime(t);
          } else {
            myVid.currentTime = t;
            mkAudio.currentTime = t;
            _updateProgress();
          }
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
        if (_wcVideo) {
          mkAudio.currentTime = t;
        } else if (_nativeVideo && _nativeSeekRef) {
          console.log(`[AML MV native] commit seek \u2192 ${t.toFixed(2)}s`);
          _nativeSeekRef(t);
        }
      };
      const _cancelScrub = () => {
        _userScrubbing = false;
      };
      rangeInput.addEventListener("mouseup", _commitScrub, true);
      rangeInput.addEventListener("touchend", _commitScrub, true);
      rangeInput.addEventListener("change", _commitScrub, true);
      rangeInput.addEventListener("pointercancel", _cancelScrub, true);
      const _durEl = _wcVideo ? mkAudio : myVid;
      const _setRangeMax = () => {
        if (_nativeVideo && _durationSec > 0) {
          rangeInput.max = String(_durationSec);
          return;
        }
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
    const _playStateEl = _wcVideo ? mkAudio : myVid;
    const _syncPlayIcon = () => {
      _mvPlayBtn.innerHTML = _playStateEl.paused ? _svgPlay : _svgPause;
      _mvPlayBtn.setAttribute("aria-label", _playStateEl.paused ? "Play" : "Pause");
    };
    _playStateEl.addEventListener("play", _syncPlayIcon);
    _playStateEl.addEventListener("pause", _syncPlayIcon);
    _playStateEl.addEventListener("playing", _syncPlayIcon);
    _syncPlayIcon();
    const _mvCurTime = () => (_wcVideo ? mkAudio.currentTime : myVid.currentTime) || 0;
    const _mvSeekTo = (sec) => {
      if (_wcVideo) {
        const dur = mkAudio.duration || _durationSec || 1e9;
        mkAudio.currentTime = Math.max(0, Math.min(dur, sec));
      } else if (_nativeVideo && _nativeSeekRef) {
        _nativeSeekRef(Math.max(0, Math.min(_durationSec || 1e9, sec)));
      } else {
        const dur = _durationSec || myVid.duration || 1e9;
        myVid.currentTime = Math.max(0, Math.min(dur, sec));
        mkAudio.currentTime = myVid.currentTime;
      }
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
      const text = btn.textContent.trim().toLowerCase();
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
      if (_wcStallPaused && _wcVideo) {
        const t2 = mkAudio.currentTime;
        const max2 = parseFloat(rangeInput.max) || parseFloat(rangeInput.getAttribute("max")) || 1;
        rangeInput.value = String(t2);
        const frac2 = max2 > 0 ? Math.min(1, Math.max(0, t2 / max2)) : 0;
        rangeInput.style.setProperty("--progress", _fillPct(frac2).toFixed(2) + "%");
        if (timeElapsed) timeElapsed.textContent = _fmtTime(t2);
        return;
      }
      const t = _wcVideo ? mkAudio.currentTime : myVid.currentTime;
      const max = parseFloat(rangeInput.max) || parseFloat(rangeInput.getAttribute("max")) || 1;
      rangeInput.value = String(t);
      const frac = max > 0 ? Math.min(1, Math.max(0, t / max)) : 0;
      const pct2 = _fillPct(frac).toFixed(2) + "%";
      rangeInput.style.setProperty("--progress", pct2);
      if (!_wcVideo && !_nativeVideo) rangeInput.style.setProperty("--width", pct2);
      if (max > 0) {
        let bFrac = 0;
        if (_wcVideo) {
          bFrac = Math.min(1, Math.max(0, _wcParsedSec / max));
        } else if (_vsegVideo) {
          bFrac = Math.min(1, Math.max(0, _vsegBufferedSec / max));
        } else if (_nativeVideo) {
          const nBuf = myVid.buffered;
          if (nBuf && nBuf.length > 0)
            bFrac = Math.min(1, Math.max(0, nBuf.end(nBuf.length - 1) / max));
        } else {
          const vBuf = videoSb?.buffered;
          if (vBuf && vBuf.length > 0)
            bFrac = Math.min(1, Math.max(0, vBuf.end(vBuf.length - 1) / max));
        }
        rangeInput.style.setProperty("--aml-buffer", _fillPct(bFrac).toFixed(2) + "%");
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
        rangeInput.style.setProperty("--aml-buffer", "0%");
        if (timeElapsed) timeElapsed.textContent = _fmtTime(0);
        if (timeRemain) timeRemain.textContent = "--:--";
      } catch (_) {
      }
    };
    _mvResetScrubberRef = _resetScrubberToLoading;
    const _seekSyncInterval = setInterval(_updateProgress, T().poll);
    console.log(`[AML MV-V] myVid created in mvContainer; nativeVidEl readyState=${nativeVidEl?.readyState}`);
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
      console.warn(`[AML MV-V] audio MSE sourceopen failed: ${e.message}`);
      if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
      return;
    }
    URL.revokeObjectURL(audioBlobUrl);
    let _audioCanPlay = false, _videoCanPlay = false, _avStarted = false;
    let _videoStalled = false;
    const BUF_LOW = 2;
    const BUF_HIGH = 10;
    let _dynBufTimer = null;
    let _bufPaused = false;
    let _userPaused = false;
    let _bufWaitStart = 0;
    const _getVidLead = () => {
      const ct = videoEl.currentTime;
      for (let i = 0; i < videoEl.buffered.length; i++) {
        if (videoEl.buffered.start(i) <= ct + 0.1 && ct <= videoEl.buffered.end(i))
          return videoEl.buffered.end(i) - ct;
      }
      return 0;
    };
    const _startDynBuf = () => {
      if (_nativeVideo) return;
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
              console.log(`[AML MV buf:resume-held] lead=${lead.toFixed(2)}s \u2014 user paused, not auto-resuming`);
            } else {
              _mvGateOpen = _avStarted;
              mkAudio.currentTime = videoEl.currentTime;
              mkAudio.muted = false;
              _iframePlay.call(videoEl).catch(() => {
              });
              console.log(`[AML MV buf:resume] lead=${lead.toFixed(2)}s ct=${videoEl.currentTime.toFixed(2)}`);
            }
          } else {
            if (!videoEl.paused) {
              console.warn("[AML MV buf:waiting] video escaped pause \u2014 re-pausing");
              videoEl.pause();
            }
            if (lead === 0) {
              const ct = videoEl.currentTime;
              let snapped = false;
              for (let i = 0; i < videoEl.buffered.length; i++) {
                const s = videoEl.buffered.start(i);
                if (s > ct && s - ct < 15) {
                  console.log(`[AML MV buf:gap-snap] ct=${ct.toFixed(2)} \u2192 ${s.toFixed(2)} (gap=${(s - ct).toFixed(2)}s)`);
                  videoEl.currentTime = s;
                  snapped = true;
                  break;
                }
              }
              if (!snapped && videoEl.buffered.length > 0) {
                const bufEnd = videoEl.buffered.end(videoEl.buffered.length - 1);
                if (ct > bufEnd && ct - bufEnd < 30 && Date.now() - _bufWaitStart > 8e3) {
                  console.warn(`[AML MV buf:ahead-snap] ct=${ct.toFixed(2)} ahead of bufEnd=${bufEnd.toFixed(2)} \u2014 re-seeking`);
                  _bufWaitStart = Date.now();
                  _mvVideoSeek(ct).catch(() => {
                  });
                }
              }
            }
            if (pipeCtrl.signal.aborted && !_abortCtrl.signal.aborted && !_pipeRestarted) {
              _pipeRestarted = true;
              const restartAt = videoEl.currentTime;
              _ignoreSeekUntil = Date.now() + 8e3;
              console.warn(`[AML MV buf:recover] pipe dead + buf stalled at ct=${restartAt.toFixed(2)}s \u2014 restarting pipe`);
              pipeCtrl = new AbortController();
              _startVideoPipe(`${videoUrl}?t=${restartAt.toFixed(3)}`);
            }
            if (Date.now() - _bufWaitStart > 45e3) {
              console.warn(`[AML MV buf:timeout] stalled ${((Date.now() - _bufWaitStart) / 1e3).toFixed(0)}s \u2014 restarting session`);
              _abortMV("buf-timeout");
              return;
            }
            console.debug(`[AML MV buf:waiting] lead=${lead.toFixed(2)}s (need ${BUF_HIGH}s to resume)`);
          }
        } else if (videoEl.paused && lead < BUF_LOW && pipeCtrl.signal.aborted && !_abortCtrl.signal.aborted) {
          if (!_pipeRestarted) {
            _pipeRestarted = true;
            console.warn(`[AML MV buf:recover] pipe dead + starved at ct=${videoEl.currentTime.toFixed(2)}s \u2014 restarting pipe`);
            pipeCtrl = new AbortController();
            _startVideoPipe(`${videoUrl}?t=${videoEl.currentTime.toFixed(3)}`);
            _iframePlay.call(videoEl).catch(() => {
            });
          } else {
            console.warn("[AML MV buf:recover] pipe restart did not recover \u2014 aborting session");
            _abortMV("pipe-dead");
          }
        } else {
          if (lead < BUF_LOW && !videoEl.paused) {
            _bufPaused = true;
            _bufSpinner.style.display = "block";
            _mvGateOpen = false;
            _bufWaitStart = Date.now();
            videoEl.pause();
            mkAudio.muted = true;
            console.warn(`[AML MV buf:LOW] lead=${lead.toFixed(2)}s < ${BUF_LOW}s \u2192 pausing. ct=${videoEl.currentTime.toFixed(2)} buffered=${videoEl.buffered?.length ? `${videoEl.buffered.start(0).toFixed(2)}-${videoEl.buffered.end(videoEl.buffered.length - 1).toFixed(2)}` : "empty"}`);
          } else {
            if (lead >= BUF_HIGH) _pipeRestarted = false;
            if (videoEl.paused && !_userPaused) {
              console.warn(`[AML MV buf:stuck] videoEl paused with lead=${lead.toFixed(2)}s \u2014 retrying play`);
              _iframePlay.call(videoEl).catch(() => {
              });
            } else {
              console.debug(`[AML MV buf:ok] lead=${lead.toFixed(2)}s`);
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
      if (_vsegVideo || _wcVideo || _nativeVideo) {
        _iframePlay.call(mkAudio).catch((e) => console.warn("[AML MV] audio play rejected:", e.message));
        return;
      }
      const audCt = mkAudio.currentTime;
      const vidCt = videoEl.currentTime;
      const vidBufEnd = videoSb.buffered.length > 0 ? videoSb.buffered.end(videoSb.buffered.length - 1) : 0;
      const canSyncToAudio = Math.abs(vidCt - audCt) > 0.05 && audCt <= vidBufEnd + 1;
      console.log(`[AML MV buf:gate] A/V gate open audio=${audCt.toFixed(2)} video=${vidCt.toFixed(2)} vidBufEnd=${vidBufEnd.toFixed(2)} canSyncToAudio=${canSyncToAudio}`);
      if (canSyncToAudio) videoEl.currentTime = audCt;
      _iframePlay.call(videoEl).catch((e) => console.warn("[AML MV] av-gate play rejected:", e.message));
      _startDynBuf();
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
        console.error(`[AML MV-A] SourceBuffer ERROR event: ${detail}`);
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
        window.__amlCaptureChunk?.("mv-audio", chunk, value, bufBefore, bufAfter, grew);
        console.log(`[AML MV-A] chunk#${chunk} size=${value.byteLength} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${bufAfter} +${elapsed}s bufGrew=${grew}`);
        if (!grew && chunk > 1)
          console.warn(`[INTERCEPT] chunk#${chunk} DID NOT grow buffer! Encrypted fragment rejected by browser MSE.`);
        return { chunk, shouldBreak: false };
      } catch (e) {
        console.error(`[INTERCEPT APPEND-ERR] chunk#${chunkIn + 1} threw ${e.name}: ${e.message}`);
        if (e.name === "InvalidStateError") {
          console.warn(`[AML MV-A] InvalidStateError chunk#${chunkIn} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} \u2014 retrying`);
          await _waitAudIdle();
          if (signal.aborted || audioMs.readyState !== "open") return { chunk: chunkIn, shouldBreak: true };
          audioSb.appendBuffer(value);
          await _waitAudIdle();
          const chunk = chunkIn + 1;
          console.log(`[AML MV-A] chunk#${chunk} size=${value.byteLength} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()} +${elapsed}s (retry)`);
          return { chunk, shouldBreak: false };
        } else if (e.name === "QuotaExceededError") {
          console.warn(`[AML MV-A] QuotaExceeded chunk#${chunkIn} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()} \u2014 evicting`);
          await evictAudio();
          await _waitAudIdle();
          if (signal.aborted || audioMs.readyState !== "open") return { chunk: chunkIn, shouldBreak: true };
          try {
            audioSb.appendBuffer(value);
            await _waitAudIdle();
            const chunk = chunkIn + 1;
            console.log(`[AML MV-A] chunk#${chunk} size=${value.byteLength} t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()} +${elapsed}s (post-evict)`);
            return { chunk, shouldBreak: false };
          } catch (_) {
            return { chunk: chunkIn, shouldBreak: false };
          }
        } else {
          throw e;
        }
      }
    }
    const runAudioPipe = async (signal) => {
      console.log(`[AML MV-A] fetch start t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} url=${audioUrl}`);
      const t0 = performance.now();
      const resp = await fetch(audioUrl, { signal });
      if (!resp.ok) throw new Error(`audio ${resp.status}`);
      const reader = resp.body.getReader();
      let chunk = 0;
      const evictAudio = async () => {
        if (audioMs.readyState !== "open" || audioSb.buffered.length === 0) return;
        const evictTo = Math.max(0, mkAudio.currentTime - 30);
        if (evictTo > audioSb.buffered.start(0) + 1) {
          console.log(`[AML MV-A] evict 0-${evictTo.toFixed(2)}s t=${_mvaTs()} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()}`);
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
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            console.log(`[AML MV-A] stream done t=${_mvaTs()} chunk#${chunk} ct=${mkAudio.currentTime.toFixed(3)} buf=${_mvaBufStr()}`);
            break;
          }
          if (signal.aborted || audioMs.readyState !== "open") break;
          const elapsed = ((performance.now() - t0) / 1e3).toFixed(2);
          await _waitAudIdle();
          if (signal.aborted || audioMs.readyState !== "open") break;
          const bufBefore = _mvaBufStr();
          console.log(`[INTERCEPT PRE-APPEND] chunk#${chunk + 1} size=${value.byteLength} bufBefore=${bufBefore} ${_parseBoxHeader(value)}`);
          const r = await appendAudioChunk(value, chunk, elapsed, bufBefore, signal, evictAudio);
          if (r.shouldBreak) break;
          chunk = r.chunk;
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
      if (!_audioPipeCtrl.signal.aborted) console.error("[AML MV] audio pipe error:", e);
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
      console.warn(`[AML MV-V] video MSE sourceopen failed: ${e.message}`);
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
    const rawVideoCodec = _videoCodec || "";
    const videoCodecStr = rawVideoCodec.split(",").map((c) => c.trim()).find((c) => /^(avc1|hvc1|hev1|vp09|av01)/.test(c)) ?? "avc1.640028";
    const videoMime = `video/mp4; codecs="${videoCodecStr}"`;
    if (!_wcVideo && !_mp4Video && !MediaSource.isTypeSupported(videoMime)) {
      console.error(`[AML MV] video codec not supported: ${videoMime} \u2014 skipping track`);
      _audioPipeCtrl.abort();
      mkAudio.pause();
      mkAudio.src = "";
      if (audioMs.readyState === "open") {
        try {
          audioMs.endOfStream();
        } catch (_) {
        }
      }
      if (ms.readyState === "open") {
        try {
          ms.endOfStream();
        } catch (_) {
        }
      }
      if (mkAudio.parentNode) mkAudio.parentNode.removeChild(mkAudio);
      _amlNextRef?.().catch(() => {
      });
      return;
    }
    console.log(`[AML MV] video codec="${videoCodecStr}"`);
    let videoSb = _wcVideo || _mp4Video || _nativeVideo ? null : ms.addSourceBuffer(videoMime);
    const videoEl = myVid;
    let pipeCtrl = new AbortController();
    let _pipeRestarted = false;
    const videoUrl = `${ENGINE}/api/v1/playback/${_sessionId}/video`;
    const BUF_MAX_AHEAD = 50;
    const BUF_BACK_KEEP = 15;
    const _waitVidIdle = () => new Promise((res, rej) => {
      if (!videoSb.updating) return res();
      const onEnd = () => {
        videoSb.removeEventListener("error", onErr);
        res();
      };
      const onErr = () => {
        videoSb.removeEventListener("updateend", onEnd);
        setTimeout(() => {
          const buf = videoSb.buffered?.length ? `${videoSb.buffered.start(0).toFixed(1)}-${videoSb.buffered.end(videoSb.buffered.length - 1).toFixed(1)}` : "empty";
          const veCode = videoEl.error?.code ?? "none";
          const veMsg = videoEl.error?.message ?? "";
          rej(new Error(`SB error buffered=${buf} ct=${videoEl.currentTime?.toFixed(2)} readyState=${videoEl.readyState} veCode=${veCode} veMsg="${veMsg}"`));
        }, 50);
      };
      videoSb.addEventListener("updateend", onEnd, { once: true });
      videoSb.addEventListener("error", onErr, { once: true });
    });
    const _boxName = (chunk) => {
      if (!chunk || chunk.byteLength < 8) return "?";
      const v = new DataView(chunk.buffer, chunk.byteOffset, Math.min(chunk.byteLength, 8));
      return String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    };
    const _bufRanges = (sb) => {
      const r = [];
      for (let i = 0; i < sb.buffered.length; i++) r.push(`${sb.buffered.start(i).toFixed(2)}-${sb.buffered.end(i).toFixed(2)}`);
      return r.join(",") || "(empty)";
    };
    const _leadAhead = () => {
      const b = videoSb.buffered;
      if (!b || b.length === 0) return 0;
      return Math.max(0, b.end(b.length - 1) - videoEl.currentTime);
    };
    const _evictBackBuffer = async (keepSec, signal) => {
      const b = videoSb.buffered;
      if (!b || b.length === 0) return false;
      const cutoff = videoEl.currentTime - keepSec;
      const start = b.start(0);
      if (cutoff <= start + 0.1) return false;
      await _waitVidIdle();
      if (signal.aborted || ms.readyState !== "open") return false;
      try {
        videoSb.remove(start, cutoff);
      } catch (_) {
        return false;
      }
      await _waitVidIdle();
      console.log(`[AML MV-pipe] evicted ${start.toFixed(1)}-${cutoff.toFixed(1)}s (ct=${videoEl.currentTime.toFixed(1)}) buf=${_bufRanges(videoSb)}`);
      return true;
    };
    const _awaitBufferHeadroom = (signal) => new Promise((resolve) => {
      if (signal.aborted || ms.readyState !== "open") return resolve();
      if (_leadAhead() < BUF_MAX_AHEAD) return resolve();
      console.log(`[AML MV-pipe] backpressure: lead=${_leadAhead().toFixed(1)}s >= ${BUF_MAX_AHEAD}s \u2014 pausing fetch`);
      let tick = 0;
      const onAbort = () => {
        clearInterval(tick);
        resolve();
      };
      tick = setInterval(() => {
        if (signal.aborted || ms.readyState !== "open" || _leadAhead() < BUF_MAX_AHEAD) {
          clearInterval(tick);
          signal.removeEventListener("abort", onAbort);
          resolve();
        }
      }, BUF_POLL_MS);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const _appendWithQuota = async (chunk, signal) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (signal.aborted || ms.readyState !== "open") return false;
        try {
          videoSb.appendBuffer(chunk);
          return true;
        } catch (e) {
          if (e.name === "QuotaExceededError") {
            const keep = [BUF_BACK_KEEP, 8, 2][Math.min(attempt, 2)];
            console.warn(`[AML MV-pipe] quota exceeded size=${chunk.byteLength} attempt=${attempt + 1} \u2014 evicting to ${keep}s back buffer`);
            const freed = await _evictBackBuffer(keep, signal);
            if (!freed && attempt >= 1) {
              throw new Error(`MSE quota exhausted, nothing to evict (buf=${_bufRanges(videoSb)} ct=${videoEl.currentTime.toFixed(2)})`);
            }
          } else if (e.name === "InvalidStateError") {
            await _waitVidIdle();
          } else {
            throw e;
          }
        }
      }
      if (signal.aborted || ms.readyState !== "open") return false;
      throw new Error(`appendBuffer failed after retries size=${chunk.byteLength} buf=${_bufRanges(videoSb)}`);
    };
    const runVideoPipe = async (url, signal) => {
      console.log(`[AML MV-pipe] start url=${url.split("?")[1] || "base"} signal.aborted=${signal.aborted}`);
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`video ${resp.status}`);
      const reader = resp.body.getReader();
      let chunkN = 0;
      try {
        while (true) {
          await _awaitBufferHeadroom(signal);
          if (signal.aborted || ms.readyState !== "open") {
            console.log(`[AML MV-pipe] break-backpressure chunk#${chunkN} signal.aborted=${signal.aborted}`);
            break;
          }
          const { done, value } = await reader.read();
          if (done) {
            console.log(`[AML MV-pipe] done after ${chunkN} chunks buf=${_bufRanges(videoSb)}`);
            break;
          }
          if (signal.aborted || ms.readyState !== "open") {
            console.log(`[AML MV-pipe] break chunk#${chunkN} signal.aborted=${signal.aborted} msState=${ms.readyState}`);
            break;
          }
          const box = _boxName(value);
          const bufBefore = _bufRanges(videoSb);
          await _waitVidIdle();
          if (signal.aborted || ms.readyState !== "open") {
            console.log(`[AML MV-pipe] break-after-idle chunk#${chunkN} box=${box} signal.aborted=${signal.aborted}`);
            break;
          }
          if (!await _appendWithQuota(value, signal)) break;
          chunkN++;
          if (chunkN <= 6 || chunkN % 20 === 0)
            console.log(`[AML MV-pipe] appended chunk#${chunkN} size=${value.byteLength} box=${box} lead=${_leadAhead().toFixed(1)}s bufBefore=${bufBefore}`);
        }
      } finally {
        reader.cancel().catch(() => {
        });
      }
      await _waitVidIdle().catch(() => {
      });
      if (!signal.aborted && ms.readyState !== "open" && videoEl.error?.code === 3) {
        const buf = videoSb.buffered?.length ? `${videoSb.buffered.start(0).toFixed(2)}-${videoSb.buffered.end(videoSb.buffered.length - 1).toFixed(2)}` : "empty";
        throw new Error(`SB error buffered=${buf} ct=${videoEl.currentTime?.toFixed(2)} readyState=${videoEl.readyState} veCode=3 veMsg="${videoEl.error?.message ?? ""}"`);
      }
      if (!signal.aborted && ms.readyState === "open") ms.endOfStream();
    };
    const _startVideoPipe = (url = videoUrl) => {
      const mySignal = pipeCtrl.signal;
      runVideoPipe(url, mySignal).catch(async (e) => {
        const aborted = mySignal.aborted;
        console.log(`[AML MV-pipe] catch err="${e.message}" pipeAborted=${aborted} ct=${videoEl.currentTime?.toFixed(2)} readyState=${videoEl.readyState}`);
        if (!aborted && _decodeRetryCount < 3 && e.message.includes("veCode=3")) {
          _decodeRetryCount++;
          _bufWaitStart = Date.now();
          const ct = videoEl.currentTime;
          const badEnd = videoSb.buffered.length > 0 ? videoSb.buffered.end(videoSb.buffered.length - 1) : ct;
          const skipTo = _decodeRetryCount === 1 ? ct + 0.5 : Math.max(ct + 0.5, badEnd + 3);
          console.warn(`[AML MV-pipe] veCode=3 retry #${_decodeRetryCount} (${_decodeRetryCount === 1 ? "recover-in-place" : "skip-past"}) \u2014 clearing SB, seeking to ${skipTo.toFixed(1)}s`);
          try {
            _mvVidSeeking = true;
            if (videoSb.updating) {
              await new Promise((res) => videoSb.addEventListener("updateend", res, { once: true }));
            }
            if (!_abortCtrl.signal.aborted && ms.readyState === "open") {
              videoSb.remove(0, Infinity);
              await new Promise((res) => videoSb.addEventListener("updateend", res, { once: true }));
            } else if (!_abortCtrl.signal.aborted && ms.readyState !== "open") {
              try {
                URL.revokeObjectURL(msBlobUrl);
              } catch (_) {
              }
              ms = new MediaSource();
              msBlobUrl = URL.createObjectURL(ms);
              myVid.src = msBlobUrl;
              await new Promise((res, rej) => {
                const sig = _abortCtrl.signal;
                sig.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
                ms.addEventListener("sourceopen", res, { once: true });
              });
              if (_durationSec > 0) {
                try {
                  ms.duration = _durationSec;
                } catch (_) {
                }
              }
              videoSb = ms.addSourceBuffer(videoMime);
              console.log(`[AML MV-pipe] rebuilt MediaSource for retry (was ended)`);
            }
            _ignoreSeekUntil = Date.now() + 2e3;
            videoEl.currentTime = skipTo;
            await Promise.race([
              new Promise((res) => videoEl.addEventListener("seeked", res, { once: true })),
              new Promise((res) => setTimeout(res, 500))
            ]);
          } catch (_) {
          } finally {
            _mvVidSeeking = false;
          }
          if (!_abortCtrl.signal.aborted) {
            pipeCtrl = new AbortController();
            _startVideoPipe(`${videoUrl}?t=${skipTo.toFixed(3)}`);
          }
          return;
        }
        if (!aborted) {
          console.error(`[AML MV] video pipe error: ${e.message} ct=${videoEl.currentTime?.toFixed(2)} readyState=${videoEl.readyState}`);
          _abortMV(`video-pipe-error`);
          _amlNextRef?.().catch(() => {
          });
          setTimeout(() => exitBtn?.click(), 200);
        }
      });
    };
    const _setupWebCodecsVideo = () => {
      _wcAudioHold = true;
      try {
        HTMLMediaElement.prototype.pause.call(mkAudio);
      } catch (_) {
      }
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;z-index:2;pointer-events:none;background:#000;";
      mvContainer.insertAdjacentElement("afterbegin", canvas);
      if (myVid) myVid.style.display = "none";
      const cctx = canvas.getContext("2d", { alpha: false });
      if (!document.getElementById("_wcSpinStyle")) {
        const s = document.createElement("style");
        s.id = "_wcSpinStyle";
        s.textContent = "@keyframes _wcSpin{from{transform:translate(-50%,-50%) rotate(0deg)}to{transform:translate(-50%,-50%) rotate(360deg)}}";
        document.head.appendChild(s);
      }
      const _wcSpinner = document.createElement("div");
      _wcSpinner.style.cssText = [
        "position:absolute;top:50%;left:50%",
        "transform:translate(-50%,-50%)",
        "width:44px;height:44px;border-radius:50%",
        "border:3px solid rgba(255,255,255,0.25)",
        "border-top-color:rgba(255,255,255,0.9)",
        "animation:_wcSpin 0.75s linear infinite",
        "pointer-events:none;z-index:3;display:none"
      ].join(";");
      mvContainer.appendChild(_wcSpinner);
      let dec = null;
      let fetchCtrl = null;
      let raf = 0;
      let firstFrame = false;
      let _wcRebuffering = false;
      let _wcDecErrCount = 0;
      let _wcRebufStart = 0;
      const queue = [];
      const QUEUE_MAX = 24;
      const MAX_DECODE_QUEUE = QUEUE_MAX;
      const DECODE_AHEAD_SEC = 15;
      const MAX_RENDER_QUEUE = 600;
      let _wcDiscarded = 0;
      const aborted = () => _abortCtrl?.signal.aborted;
      let gen = 0;
      let currentSeekSec = 0;
      let wcFramesOpened = 0, wcFramesClosed = 0, wcObsoletePaints = 0, wcObsoleteState = 0;
      const closeWcFrame = (f) => {
        if (!f) return;
        wcFramesClosed++;
        try {
          f.close();
        } catch (_) {
        }
      };
      const driftSamples = [];
      const DRIFT_WINDOW = 10;
      const addDrift = (d) => {
        driftSamples.push(d);
        if (driftSamples.length > DRIFT_WINDOW) driftSamples.shift();
      };
      const medianDrift = () => {
        if (!driftSamples.length) return 0;
        const s = [...driftSamples].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      let lastCt = null;
      let _metricN = 0;
      const _queueLengthMs = () => queue.length >= 2 ? Math.max(0, (queue[queue.length - 1].tUs - queue[0].tUs) / 1e3) : 0;
      window._wcFrameStats = () => ({ opened: wcFramesOpened, closed: wcFramesClosed, outstanding: wcFramesOpened - wcFramesClosed });
      window._wcStats = () => ({
        gen,
        outstanding: wcFramesOpened - wcFramesClosed,
        obsoletePaints: wcObsoletePaints,
        obsoleteState: wcObsoleteState,
        medianDriftMs: +(medianDrift() * 1e3).toFixed(1),
        bufferedSec: +(_wcBufferedSec || 0).toFixed(2),
        queued: queue.length,
        discarded: _wcDiscarded,
        queueLengthMs: +_queueLengthMs().toFixed(0)
      });
      let wakeProducer = null;
      const wakeProd = () => {
        const w = wakeProducer;
        if (w) {
          wakeProducer = null;
          w();
        }
      };
      const _wcDispatchWaiting = () => {
        nativeVidEl?.dispatchEvent(new Event("waiting", { bubbles: false }));
        getMKAudio()?.dispatchEvent(new Event("waiting", { bubbles: false }));
      };
      const _wcDispatchPlaying = () => {
        nativeVidEl?.dispatchEvent(new Event("playing", { bubbles: false }));
        getMKAudio()?.dispatchEvent(new Event("playing", { bubbles: false }));
      };
      const render = () => {
        if (aborted()) return;
        const ct = mkAudio.currentTime;
        const clockRegressed = lastCt != null && ct + 1e-3 < lastCt;
        const clockFrozen = lastCt != null && Math.abs(ct - lastCt) < 5e-4 && !mkAudio.paused && !_wcRebuffering;
        const clockUsable = !(clockRegressed || clockFrozen);
        lastCt = ct;
        const nowUs = ct * 1e6;
        while (queue.length && queue[0].tUs <= nowUs) {
          const f = queue.shift();
          if (queue.length && queue[0].tUs <= nowUs) {
            closeWcFrame(f.frame);
            continue;
          }
          if (f.g !== gen) wcObsoletePaints++;
          if (canvas.width !== f.frame.displayWidth) {
            canvas.width = f.frame.displayWidth;
            canvas.height = f.frame.displayHeight;
          }
          cctx.drawImage(f.frame, 0, 0, canvas.width, canvas.height);
          if (clockUsable) addDrift(f.tUs / 1e6 - ct);
          closeWcFrame(f.frame);
        }
        wakeProd();
        if (firstFrame && !_wcRebuffering) {
          if (!_wcStallPaused && !_msePaused && queue.length === 0 && !mkAudio.paused) {
            _wcStallPaused = true;
            mkAudio.pause();
            _wcSpinner.style.display = "block";
            _wcDispatchWaiting();
            console.log(`[AML MV-WC] video underrun \u2014 stalling audio ct=${ct.toFixed(2)}`);
          } else if (_wcStallPaused && queue.length > 0) {
            _wcStallPaused = false;
            _wcSpinner.style.display = "none";
            _iframePlay.call(mkAudio).catch(() => {
            });
            _wcDispatchPlaying();
            console.log(`[AML MV-WC] rebuffered \u2014 resuming audio ct=${ct.toFixed(2)} queued=${queue.length}`);
          }
        }
        if (++_metricN % 30 === 0) {
          const dms = medianDrift() * 1e3;
          console.log(`[wc-metric] drift=${dms.toFixed(1)}ms buffered=${(_wcBufferedSec || 0).toFixed(2)} q=${queue.length} gen=${gen} outstanding=${wcFramesOpened - wcFramesClosed}`);
        }
        if (_wcRebuffering && _wcRebufStart > 0 && Date.now() - _wcRebufStart > 8e3) {
          console.warn(`[AML MV-WC] hang timeout ${((Date.now() - _wcRebufStart) / 1e3).toFixed(1)}s \u2014 restarting ct=${ct.toFixed(2)}`);
          _wcRebufStart = 0;
          requestRestart("hang");
        }
        raf = requestAnimationFrame(render);
      };
      const start = async (seekSec = 0) => {
        const myGen = gen;
        fetchCtrl = new AbortController();
        const sig = fetchCtrl.signal;
        const live = () => myGen === gen && !sig.aborted && !aborted();
        const myDec = dec = new VideoDecoder({
          output: (frame) => {
            wcFramesOpened++;
            if (!live()) {
              if (myGen !== gen) wcObsoleteState++;
              closeWcFrame(frame);
              return;
            }
            while (queue.length >= MAX_RENDER_QUEUE) {
              closeWcFrame(queue.shift().frame);
              _wcDiscarded++;
            }
            queue.push({ frame, tUs: frame.timestamp, g: myGen });
            const fSec = frame.timestamp / 1e6;
            if (fSec > _wcBufferedSec) _wcBufferedSec = fSec;
            _wcRebuffering = false;
            if (!firstFrame) {
              firstFrame = true;
              _videoCanPlay = true;
              _wcAudioHold = false;
              _wcVW = frame.displayWidth;
              _wcVH = frame.displayHeight;
              console.log(`[AML MV-WC] first frame decoded ${_wcVW}x${_wcVH} \u2014 opening A/V gate`);
              _resizeScrim();
              tryStart();
              if (!raf) raf = requestAnimationFrame(render);
            }
          },
          error: (e) => {
            if (myGen !== gen) return;
            console.error(`[AML MV-WC] decode error (attempt ${_wcDecErrCount + 1}/3): ${e.message}`);
            if (_wcDecErrCount++ < 3 && live()) requestRestart("decode-error");
          }
        });
        myDec.addEventListener("dequeue", wakeProd);
        let buf = new Uint8Array(0);
        const td = new TextDecoder();
        let state = "magic", codec = "", waitingForKeyframe = true;
        const drain = () => {
          for (; ; ) {
            if (myGen !== gen) return;
            if (state === "magic") {
              if (buf.length < 4) return;
              if (td.decode(buf.slice(0, 4)) !== "AME1") {
                console.error("[AML MV-WC] bad ES magic");
                fetchCtrl.abort();
                return;
              }
              buf = buf.slice(4);
              state = "codec";
            } else if (state === "codec") {
              if (buf.length < 2) return;
              const l = buf[0] << 8 | buf[1];
              if (buf.length < 2 + l) return;
              codec = td.decode(buf.slice(2, 2 + l));
              buf = buf.slice(2 + l);
              state = "avcc";
            } else if (state === "avcc") {
              if (buf.length < 2) return;
              const l = buf[0] << 8 | buf[1];
              if (buf.length < 2 + l) return;
              const avcC = buf.slice(2, 2 + l);
              buf = buf.slice(2 + l);
              state = "samples";
              try {
                myDec.configure({ codec, description: avcC, optimizeForLatency: true, hardwareAcceleration: "no-preference" });
              } catch (e) {
                console.error(`[AML MV-WC] configure failed: ${e.message}`);
                fetchCtrl.abort();
                return;
              }
              waitingForKeyframe = true;
              console.log(`[AML MV-WC] configured codec=${codec} avcC=${avcC.length}B`);
            } else {
              if (buf.length < 17) return;
              const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
              const len = dv.getUint32(13);
              if (buf.length < 17 + len) return;
              if (myDec.decodeQueueSize >= MAX_DECODE_QUEUE) return;
              const lead = queue.length ? queue[queue.length - 1].tUs / 1e6 - mkAudio.currentTime : 0;
              if (lead >= DECODE_AHEAD_SEC) return;
              const key = (buf[0] & 1) === 1;
              const tUs = Number(dv.getBigInt64(1));
              const durUs = dv.getUint32(9);
              const data = buf.slice(17, 17 + len);
              buf = buf.slice(17 + len);
              const fParsedSec = tUs / 1e6;
              if (fParsedSec > _wcParsedSec) _wcParsedSec = fParsedSec;
              if (!key && waitingForKeyframe) continue;
              waitingForKeyframe = false;
              try {
                myDec.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: tUs, duration: durUs, data }));
              } catch (e) {
                console.error(`[AML MV-WC] decode() threw: ${e.message}`);
              }
            }
          }
        };
        console.log(`[AML MV-WC] start gen=${myGen} seekSec=${seekSec.toFixed(2)} ct=${mkAudio.currentTime.toFixed(2)}`);
        try {
          const esUrl = `${videoUrl}-es${seekSec > 0 ? `?t=${seekSec.toFixed(3)}` : ""}`;
          const resp = await fetch(esUrl, { signal: sig });
          if (!live()) {
            resp.body?.cancel().catch(() => {
            });
            return;
          }
          if (!resp.ok) {
            console.error(`[AML MV-WC] /video-es ${resp.status} seekSec=${seekSec.toFixed(2)}`);
            return;
          }
          console.log(`[AML MV-WC] /video-es ok gen=${myGen} ct=${mkAudio.currentTime.toFixed(2)}`);
          const reader = resp.body.getReader();
          let chunkN = 0, done = false;
          for (; ; ) {
            if (!live()) break;
            drain();
            if (!live()) break;
            const full = myDec.decodeQueueSize >= MAX_DECODE_QUEUE;
            const ahead = queue.length ? queue[queue.length - 1].tUs / 1e6 - mkAudio.currentTime >= DECODE_AHEAD_SEC : false;
            if (full || ahead) {
              await new Promise((res) => {
                wakeProducer = res;
              });
              continue;
            }
            if (done) break;
            const r = await reader.read();
            if (r.done) {
              console.log(`[AML MV-WC] stream done gen=${myGen} chunk#${chunkN} queued=${queue.length}`);
              done = true;
              continue;
            }
            if (!live()) break;
            chunkN++;
            if (chunkN <= 5 || chunkN % 100 === 0)
              console.log(`[AML MV-WC] chunk#${chunkN} size=${r.value.byteLength} buf=${buf.length} decQ=${myDec.decodeQueueSize} queued=${queue.length} ct=${mkAudio.currentTime.toFixed(2)}`);
            const nb = new Uint8Array(buf.length + r.value.length);
            nb.set(buf);
            nb.set(r.value, buf.length);
            buf = nb;
          }
          if (myGen === gen && myDec.state === "configured") await myDec.flush().catch(() => {
          });
        } catch (e) {
          if (live()) console.error(`[AML MV-WC] stream error: ${e.message}`);
        }
      };
      let _wcSeekTimer = null;
      const requestRestart = (reason, seekSec = currentSeekSec) => {
        gen++;
        try {
          fetchCtrl?.abort();
        } catch (_) {
        }
        wakeProd();
        clearTimeout(_wcSeekTimer);
        _wcSeekTimer = setTimeout(() => {
          _wcSeekTimer = null;
          _commitWcSeek(seekSec, reason);
        }, 50);
      };
      const _commitWcSeek = (seekSec, reason) => {
        if (aborted()) return;
        const t = typeof seekSec === "number" ? seekSec : mkAudio.currentTime;
        currentSeekSec = t;
        console.log(`[AML MV-WC] commit restart (${reason}) gen=${gen} \u2192 ${t.toFixed(2)}s queued=${queue.length}`);
        gen++;
        try {
          if (dec && dec.state !== "closed") dec.close();
        } catch (_) {
        }
        while (queue.length) closeWcFrame(queue.shift().frame);
        firstFrame = _avStarted;
        if (_avStarted) {
          _wcStallPaused = true;
          try {
            HTMLMediaElement.prototype.pause.call(mkAudio);
          } catch (_) {
          }
          _wcSpinner.style.display = "block";
        } else {
          _wcStallPaused = false;
        }
        _wcRebuffering = true;
        _wcRebufStart = Date.now();
        _wcDecErrCount = 0;
        _wcBufferedSec = t;
        _wcParsedSec = t;
        start(t).catch(() => {
        });
      };
      const onWcSeek = () => {
        if (aborted()) return;
        const t = mkAudio.currentTime;
        const qFirst = queue.length ? queue[0].tUs / 1e6 : -1;
        if (qFirst >= 0 && t >= qFirst - 0.5 && t <= _wcBufferedSec + 1) return;
        requestRestart("seek", t);
      };
      mkAudio.addEventListener("seeking", onWcSeek);
      _wcCleanup = () => {
        gen++;
        _wcStallPaused = false;
        _wcAudioHold = false;
        _wcRebuffering = false;
        try {
          mkAudio.removeEventListener("seeking", onWcSeek);
        } catch (_) {
        }
        clearTimeout(_wcSeekTimer);
        try {
          fetchCtrl?.abort();
        } catch (_) {
        }
        wakeProd();
        if (raf) cancelAnimationFrame(raf);
        while (queue.length) closeWcFrame(queue.shift().frame);
        try {
          if (dec && dec.state !== "closed") dec.close();
        } catch (_) {
        }
        try {
          canvas.remove();
        } catch (_) {
        }
        try {
          _wcSpinner.remove();
        } catch (_) {
        }
        try {
          delete window._wcFrameStats;
          delete window._wcStats;
        } catch (_) {
        }
      };
      _wcRebuffering = true;
      _wcRebufStart = Date.now();
      start(0).catch((e) => console.error("[AML MV-WC] start error:", e.message));
    };
    _activeMvControls = {
      play: mvPlay,
      pause: mvPause,
      seekTo: _mvSeekTo,
      get currentTime() {
        return (_wcVideo ? mkAudio.currentTime : myVid.currentTime) || 0;
      },
      get duration() {
        if (_nativeVideo) return _durationSec || myVid.duration || 0;
        return (_wcVideo ? mkAudio.duration : myVid.duration) || _durationSec || 0;
      },
      get paused() {
        return _wcVideo ? mkAudio.paused : myVid.paused;
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
    const _setupMP4BoxVideo = () => {
      console.log("[AML MV-MP4] starting direct fMP4\u2192MSE path");
      if (!MediaSource.isTypeSupported(videoMime)) {
        console.error("[AML MV-MP4] codec not supported:", videoMime, "\u2014 falling back to WebCodecs");
        _setupWebCodecsVideo();
        return;
      }
      const fetchCtrl = new AbortController();
      const mp4Sb = ms.addSourceBuffer(videoMime);
      videoSb = mp4Sb;
      mp4Sb.mode = "segments";
      let pending = new Uint8Array(0);
      let initDone = false;
      let initBuf = new Uint8Array(0);
      let pendingMoof = null;
      let timescale = 9e4;
      let tsOffsetSet = false;
      const cat = (a, b) => {
        const r = new Uint8Array(a.length + b.length);
        r.set(a);
        r.set(b, a.length);
        return r;
      };
      const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      const u32 = (b, i) => (b[i] << 24 | b[i + 1] << 16 | b[i + 2] << 8 | b[i + 3]) >>> 0;
      const findBox = (buf, type) => {
        const t0 = type.charCodeAt(0), t1 = type.charCodeAt(1), t2 = type.charCodeAt(2), t3 = type.charCodeAt(3);
        for (let i = 0; i + 8 <= buf.length; ) {
          const sz = u32(buf, i);
          if (sz < 8) break;
          if (buf[i + 4] === t0 && buf[i + 5] === t1 && buf[i + 6] === t2 && buf[i + 7] === t3) return buf.subarray(i, i + sz);
          i += sz;
        }
        return null;
      };
      const moovTimescale = (moovBox) => {
        const trak = findBox(moovBox.subarray(8), "trak");
        if (!trak) return 9e4;
        const mdia = findBox(trak.subarray(8), "mdia");
        if (!mdia) return 9e4;
        const mdhd = findBox(mdia.subarray(8), "mdhd");
        if (!mdhd || mdhd.length < 24) return 9e4;
        const off = mdhd[8] === 1 ? 28 : 20;
        return mdhd.length >= off + 4 ? u32(mdhd, off) : 9e4;
      };
      const moofTFDT = (moofBox) => {
        const traf = findBox(moofBox.subarray(8), "traf");
        if (!traf) return 0;
        const tfdt = findBox(traf.subarray(8), "tfdt");
        if (!tfdt || tfdt.length < 16) return 0;
        if (tfdt[8] === 1 && tfdt.length >= 20) return u32(tfdt, 12) * 4294967296 + u32(tfdt, 16);
        return u32(tfdt, 12);
      };
      let _segN = 0;
      const _logBuf = (label) => {
        if (!mp4Sb || !mp4Sb.buffered || mp4Sb.buffered.length === 0) {
          console.log(`[AML MV-MP4] ${label} buf=(empty) tsOff=${mp4Sb?.timestampOffset?.toFixed(3)}`);
          return;
        }
        const b = mp4Sb.buffered;
        const ranges = Array.from({ length: b.length }, (_, i) => `${b.start(i).toFixed(2)}-${b.end(i).toFixed(2)}`).join(" ");
        console.log(`[AML MV-MP4] ${label} buf=[${ranges}] tsOff=${mp4Sb.timestampOffset.toFixed(3)}`);
      };
      const appendWhenReady = (ab, beforeAppend) => {
        const try_ = () => {
          if (mp4Sb.updating) {
            mp4Sb.addEventListener("updateend", try_, { once: true });
            return;
          }
          if (beforeAppend) beforeAppend();
          try {
            mp4Sb.appendBuffer(ab);
            mp4Sb.addEventListener("updateend", () => _logBuf(`seg#${_segN}`), { once: true });
          } catch (e) {
            console.warn("[AML MV-MP4] append:", e.message);
          }
        };
        try_();
      };
      const drain = () => {
        for (; ; ) {
          if (pending.length < 8) return;
          const size = u32(pending, 0);
          if (size < 8 || pending.length < size) return;
          const type = String.fromCharCode(pending[4], pending[5], pending[6], pending[7]);
          const box = pending.slice(0, size);
          pending = pending.slice(size);
          if (!initDone) {
            initBuf = cat(initBuf, box);
            if (type === "moov") {
              initDone = true;
              timescale = moovTimescale(box);
              const trak = findBox(box.subarray(8), "trak");
              const mdia = trak ? findBox(trak.subarray(8), "mdia") : null;
              const mdhd = mdia ? findBox(mdia.subarray(8), "mdhd") : null;
              const hex = (arr, n) => arr ? Array.from(arr.subarray(0, Math.min(n, arr.length))).map((v) => v.toString(16).padStart(2, "0")).join(" ") : "null";
              console.log(`[AML MV-MP4] MOOV raw: size=${box.length}B trak=${trak?.length} mdia=${mdia?.length} mdhd=${mdhd?.length}`);
              console.log(`[AML MV-MP4] mdhd hex: ${hex(mdhd, mdhd?.length || 0)}`);
              console.log(`[AML MV-MP4] init ${initBuf.length}B timescale=${timescale}`);
              _segN = 0;
              appendWhenReady(toAB(initBuf));
            }
          } else if (type === "moof") {
            pendingMoof = box;
          } else if (type === "mdat" && pendingMoof) {
            const moofBox = pendingMoof;
            pendingMoof = null;
            _segN++;
            const seg = toAB(cat(moofBox, box));
            if (!tsOffsetSet) {
              tsOffsetSet = true;
              const tfdt = moofTFDT(moofBox);
              const traf = findBox(moofBox.subarray(8), "traf");
              const tfdtBox = traf ? findBox(traf.subarray(8), "tfdt") : null;
              const hex = (arr, n) => arr ? Array.from(arr.subarray(0, Math.min(n, arr.length))).map((v) => v.toString(16).padStart(2, "0")).join(" ") : "null";
              console.log(`[AML MV-MP4] MOOF#1 raw: moofSize=${moofBox.length} traf=${traf?.length} tfdt=${tfdtBox?.length}`);
              console.log(`[AML MV-MP4] tfdt hex: ${hex(tfdtBox, tfdtBox?.length || 0)}`);
              appendWhenReady(seg, () => {
                const offset = -(tfdt / timescale);
                mp4Sb.timestampOffset = offset;
                console.log(`[AML MV-MP4] seg#1 TFDT=${tfdt} timescale=${timescale} \u2192 tsOff=${offset.toFixed(3)}s`);
              });
            } else {
              appendWhenReady(seg);
            }
          }
        }
      };
      fetch(`${ENGINE}/api/v1/playback/${_sessionId}/video-raw`, { signal: fetchCtrl.signal }).then(async (resp) => {
        if (!resp.ok) {
          console.error("[AML MV-MP4] fetch", resp.status);
          return;
        }
        const reader = resp.body.getReader();
        try {
          for (; ; ) {
            const { done, value } = await reader.read();
            if (done) break;
            pending = pending.length ? cat(pending, value) : value;
            drain();
          }
          mp4Sb.addEventListener("updateend", () => {
            if (!mp4Sb.updating && ms.readyState === "open") {
              try {
                ms.endOfStream();
              } catch (_) {
              }
            }
          }, { once: true });
        } catch (e) {
          if (e.name !== "AbortError") console.error("[AML MV-MP4] read:", e.message);
        }
      }).catch((e) => {
        if (e.name !== "AbortError") console.error("[AML MV-MP4] fetch:", e.message);
      });
      _wcCleanup = () => fetchCtrl.abort();
    };
    const _setupNativeVideo = () => {
      const enginePath = `/api/v1/playback/${_sessionId}/video-dl`;
      const dlUrl = `${ENGINE_HTTPS}${enginePath}`;
      const infoUrl = `${ENGINE_HTTPS}/api/v1/playback/${_sessionId}/video-dl-info`;
      const _NET = ["EMPTY", "IDLE", "LOADING", "NO_SOURCE"];
      const _RS = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
      const _nlog = (ev) => console.log(`%c[AML MV native]%c ${ev} net=${_NET[myVid.networkState]} rs=${_RS[myVid.readyState]} ct=${myVid.currentTime.toFixed(2)} dur=${isFinite(myVid.duration) ? myVid.duration.toFixed(2) : myVid.duration} vw=${myVid.videoWidth} vh=${myVid.videoHeight} err=${myVid.error ? myVid.error.code : "-"}`, "color:#bf5af2;font-weight:bold", "color:inherit");
      ["loadstart", "loadedmetadata", "loadeddata", "canplaythrough", "stalled", "emptied", "abort"].forEach((ev) => myVid.addEventListener(ev, () => _nlog(ev)));
      const _startPoll = () => {
        _bufSpinner.style.display = "block";
        const _poll = async () => {
          if (_abortCtrl?.signal.aborted) return;
          try {
            const info = await fetch(infoUrl).then((r) => r.json());
            if (info.cached) {
              const _src = info.cdnProxy ? "CDN proxy (instant)" : "faststart cache";
              console.log(`%c[AML MV native]%c ${_src} ready \u2014 loading`, "color:#30d158;font-weight:bold", "color:inherit");
              _bufSpinner.style.display = "none";
              myVid.src = "";
              myVid.load();
              myVid.src = dlUrl;
              myVid.load();
              return;
            }
            console.log(`%c[AML MV native]%c cache building (preparing=${info.preparing}) \u2014 retry in 2s`, "color:#ff9f0a;font-weight:bold", "color:inherit");
          } catch (_e) {
            console.warn("[AML MV native] poll error", _e);
          }
          setTimeout(_poll, 2e3);
        };
        setTimeout(_poll, 2e3);
      };
      myVid.addEventListener("error", () => {
        const e = myVid.error;
        console.error(`%c[AML MV native]%c ERROR code=${e?.code} msg="${e?.message || ""}" net=${_NET[myVid.networkState]} rs=${_RS[myVid.readyState]} currentSrc=${myVid.currentSrc}`, "color:#ff453a;font-weight:bold", "color:inherit");
        if ((e?.code === 2 || e?.code === 3) && !_abortCtrl?.signal.aborted) {
          console.log("%c[AML MV native]%c transient error \u2014 polling for cache", "color:#ff9f0a;font-weight:bold", "color:inherit");
          _startPoll();
          return;
        }
        _abortMV(`video-error-${e?.code ?? "?"}`);
        _amlNextRef?.().catch(() => {
        });
        setTimeout(() => exitBtn?.click(), 200);
      });
      let _lastNudge = 0;
      myVid.addEventListener("timeupdate", () => {
        if (!_avStarted) return;
        const drift = mkAudio.currentTime - myVid.currentTime;
        const now = performance.now();
        if (Math.abs(drift) > 0.35 && now - _lastNudge > 500) {
          _lastNudge = now;
          mkAudio.currentTime = myVid.currentTime;
        }
      });
      const _dispatchNative = (type) => {
        nativeVidEl?.dispatchEvent(new Event(type, { bubbles: false }));
        const mka = getMKAudio();
        if (mka && mka !== mkAudio) mka.dispatchEvent(new Event(type, { bubbles: false }));
      };
      mkAudio.addEventListener("play", () => {
        if (myVid.paused) _iframePlay.call(myVid).catch(() => {
        });
      });
      mkAudio.addEventListener("pause", () => {
        if (!myVid.paused) myVid.pause();
      });
      myVid.addEventListener("play", () => {
        if (mkAudio.paused) _iframePlay.call(mkAudio).catch(() => {
        });
        _dispatchNative("playing");
      });
      myVid.addEventListener("pause", () => {
        if (!mkAudio.paused) mkAudio.pause();
        _dispatchNative("pause");
      });
      myVid.addEventListener("waiting", () => {
        _nlog("waiting");
        if (_avStarted && !_videoStalled && !_bufPaused) {
          _videoStalled = true;
          _mvGateOpen = false;
          mkAudio.muted = true;
          _bufSpinner.style.display = "block";
        }
      });
      myVid.addEventListener("playing", () => {
        _nlog("playing");
        _dispatchNative("playing");
        if (_videoStalled) {
          _videoStalled = false;
          _mvGateOpen = _avStarted;
          _bufSpinner.style.display = "none";
          if (Math.abs(mkAudio.currentTime - myVid.currentTime) > 0.05) mkAudio.currentTime = myVid.currentTime;
          mkAudio.muted = false;
        }
      });
      let _reseeking = false;
      const _nativeSeek = (target) => {
        if (_reseeking) return;
        target = Math.max(0, Math.min(_durationSec || target, target));
        for (let i = 0; i < myVid.buffered.length; i++) {
          if (target >= myVid.buffered.start(i) && target <= myVid.buffered.end(i)) {
            try {
              myVid.currentTime = target;
            } catch (_) {
            }
            try {
              mkAudio.currentTime = target;
            } catch (_) {
            }
            return;
          }
        }
        console.log(`%c[AML MV native]%c seek ${target.toFixed(2)}s via Range`, "color:#bf5af2;font-weight:bold", "color:#30d158");
        _bufSpinner.style.display = "block";
        _reseeking = true;
        try {
          myVid.currentTime = target;
        } catch (_) {
        }
        try {
          mkAudio.currentTime = target;
        } catch (_) {
        }
        myVid.addEventListener("seeked", () => {
          _reseeking = false;
          _bufSpinner.style.display = "none";
          if (Math.abs(mkAudio.currentTime - myVid.currentTime) > 0.1) mkAudio.currentTime = myVid.currentTime;
        }, { once: true });
      };
      _nativeSeekRef = _nativeSeek;
      myVid.addEventListener("seeked", () => {
        if (_reseeking) return;
        _nlog("seeked");
        if (Math.abs(mkAudio.currentTime - myVid.currentTime) > 0.3) mkAudio.currentTime = myVid.currentTime;
      });
      myVid.addEventListener("ended", () => {
        if (_abortCtrl?.signal.aborted) return;
        console.log(`[AML MV native] ended ct=${myVid.currentTime.toFixed(2)} \u2192 next`);
        _abortMV("track-ended");
        _amlNextRef?.().catch(() => {
        });
        setTimeout(() => exitBtn?.click(), 200);
      });
      myVid.addEventListener("canplay", () => {
        _nlog("canplay");
        _bufSpinner.style.display = "none";
        _dispatchNative("canplay");
        _videoCanPlay = true;
        tryStart();
      }, { once: true });
      myVid.muted = true;
      (async () => {
        try {
          const info = await fetch(infoUrl).then((r) => r.json());
          if (info.cached) {
            console.log("%c[AML MV native]%c cache hit \u2014 loading", "color:#30d158;font-weight:bold", "color:inherit");
            _bufSpinner.style.display = "block";
            myVid.src = dlUrl;
            try {
              myVid.load();
            } catch (e) {
              console.error(`[AML MV native] load() threw: ${e.message}`);
            }
            return;
          }
        } catch (_e) {
          console.warn("[AML MV native] info preflight error", _e);
        }
        console.log("%c[AML MV native]%c cache miss \u2014 waiting for HLS decrypt + faststart", "color:#ff9f0a;font-weight:bold", "color:inherit");
        _startPoll();
      })();
    };
    const _setupVsegVideo = () => {
      const base = `${ENGINE}/api/v1/playback/${_sessionId}/vseg`;
      const BUFFER_AHEAD = 12;
      const ms2 = new MediaSource();
      myVid.src = URL.createObjectURL(ms2);
      _bufSpinner.style.display = "block";
      let sb = null;
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
              console.warn(`[AML vseg] seg/${nextSeg} HTTP ${r.status}`);
              break;
            }
            const data = await r.arrayBuffer();
            if (sig.aborted || gen !== fetchGeneration) break;
            await waitUpdateEnd();
            if (sig.aborted || gen !== fetchGeneration) break;
            sb.appendBuffer(data);
            await waitUpdateEnd();
            if (gen !== fetchGeneration) break;
            if (sb.buffered.length > 0)
              _vsegBufferedSec = sb.buffered.end(sb.buffered.length - 1);
            nextSeg++;
          }
        } catch (e) {
          if (e.name !== "AbortError") console.warn("[AML vseg] fetch loop error:", e);
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
          console.error("[AML vseg] no codec from manifest");
          return;
        }
        sb = ms2.addSourceBuffer(`video/mp4; codecs="${codecs}"`);
        sb.addEventListener("error", (e) => console.error("[AML vseg] SourceBuffer error", e));
        const initRes = await fetch(`${base}/init`).catch(() => null);
        if (!initRes?.ok) {
          console.error("[AML vseg] init fetch failed");
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
        console.log(`[AML vseg] seek to ${seekSec.toFixed(2)}s`);
        const resp = await fetch(`${base}/seek?t=${seekSec}`, { signal: sig }).then((r) => r.json()).catch(() => null);
        if (sig.aborted) {
          _seekHandlerActive = false;
          return;
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
        try {
          sb.timestampOffset = startN === 0 ? startT : 0;
        } catch (_) {
        }
        if (!sig.aborted) runFetchLoop(startN);
      });
      myVid.addEventListener("seeked", () => {
        _seekHandlerActive = false;
        _bufSpinner.style.display = "none";
        _clearSeekFreeze();
        if (!myVid.paused && mkAudio.paused)
          mkAudio.play().catch(() => {
          });
      });
      myVid.addEventListener("canplay", () => {
        _bufSpinner.style.display = "none";
        _clearSeekFreeze();
        _videoCanPlay = true;
        tryStart();
        _iframePlay.call(myVid).catch((e) => console.warn("[AML vseg] myVid play rejected:", e.message));
      }, { once: true });
      _abortCtrl.signal.addEventListener("abort", () => {
        stopFetchLoop();
        fetch(`${base}`, { method: "DELETE" }).catch(() => {
        });
      }, { once: true });
      console.log("[AML vseg] setup done, waiting for sourceopen");
    };
    if (_vsegVideo) _setupVsegVideo();
    else if (_nativeVideo) _setupNativeVideo();
    else if (_mp4Video) _setupMP4BoxVideo();
    else if (_wcVideo) _setupWebCodecsVideo();
    else _startVideoPipe();
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
    const _mvVideoSeek = async (seekSec) => {
      if (_mvVidSeeking || pipeCtrl.signal.aborted || ms.readyState !== "open") return;
      for (let i = 0; i < videoSb.buffered.length; i++) {
        if (seekSec >= videoSb.buffered.start(i) - 0.5 && seekSec < videoSb.buffered.end(i)) return;
      }
      _mvVidSeeking = true;
      _showSeekSnap();
      try {
        if (typeof _wcCleanup === "function") {
          try {
            _wcCleanup();
          } catch (_) {
          }
          _wcCleanup = null;
        }
        const prev = pipeCtrl;
        pipeCtrl = new AbortController();
        prev.abort();
        const sig = pipeCtrl.signal;
        try {
          await _waitVidIdle();
        } catch (_) {
        }
        if (videoSb.buffered.length > 0) {
          videoSb.remove(0, Infinity);
          try {
            await _waitVidIdle();
          } catch (_) {
          }
        }
        if (sig.aborted || ms.readyState !== "open") {
          _hideSeekSnap();
          return;
        }
        videoSb.timestampOffset = 0;
        _ignoreSeekUntil = Date.now() + 8e3;
        console.log(`[AML MV-V] seek to ${seekSec.toFixed(1)}s \u2014 re-fetching from engine`);
        if (seekSec < (_durationSec || 1e9) - 1) {
          _startVideoPipe(`${videoUrl}?t=${seekSec.toFixed(3)}`);
        }
      } finally {
        _mvVidSeeking = false;
      }
    };
    videoEl.addEventListener("seeking", () => {
      if (_wcVideo) return;
      if (_nativeVideo) return;
      if (Date.now() < _ignoreSeekUntil) return;
      _mvVideoSeek(videoEl.currentTime).catch(() => {
      });
    });
    const onVideoPlay = () => {
      console.log(`[AML MV-V] videoEl play ct=${videoEl.currentTime.toFixed(2)} mkAudio.paused=${mkAudio.paused} mkAudio.muted=${mkAudio.muted} mkAudio.volume=${mkAudio.volume} mkAudio.readyState=${mkAudio.readyState}`);
      if (Math.abs(mkAudio.currentTime - videoEl.currentTime) > 0.5)
        mkAudio.currentTime = videoEl.currentTime;
      _iframePlay.call(mkAudio).then(() => console.log("[AML MV-A] mkAudio.play() resolved")).catch((e) => console.warn("[AML MV-A] mkAudio.play() rejected:", e.message));
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
          console.log(`[AML MV buf:sync] stall recovery drift=${drift.toFixed(2)}s, snapping audio ct=${videoEl.currentTime.toFixed(2)}`);
          mkAudio.currentTime = videoEl.currentTime;
        }
        mkAudio.muted = false;
        console.log(`[AML MV buf:sync] audio unmuted, video resumed ct=${videoEl.currentTime.toFixed(2)}`);
      }
    };
    const onVideoPause = () => {
      if (_bufPaused) return;
      console.log(`[AML MV-V] videoEl pause ct=${videoEl.currentTime.toFixed(2)}`);
      mkAudio.pause();
      nativeVidEl?.dispatchEvent(new Event("pause", { bubbles: false }));
      getMKAudio()?.dispatchEvent(new Event("pause", { bubbles: false }));
    };
    const onVideoSeek = () => {
      if (_mvVidSeeking) return;
      console.log(`[AML MV-V] videoEl seeked ct=${videoEl.currentTime.toFixed(2)}`);
      if (Math.abs(mkAudio.currentTime - videoEl.currentTime) > 0.5)
        mkAudio.currentTime = videoEl.currentTime;
    };
    const onEnded = (ev) => {
      if (_abortCtrl?.signal.aborted) return;
      const src = _wcVideo ? "audio" : ev?.target === videoEl ? "video" : "audio";
      console.log(`[AML MV] ${src} ended ct=${(videoEl.currentTime || mkAudio.currentTime)?.toFixed(2)}`);
      try {
        delete mkAudio.load;
      } catch (_) {
      }
      _abortMV("track-ended");
      _amlNextRef?.().catch(() => {
      });
      setTimeout(() => exitBtn?.click(), 200);
    };
    let _decodeRetryCount = 0;
    const onVideoError = () => {
      const code = videoEl.error?.code;
      const msg = videoEl.error?.message ?? "";
      console.error(`[AML MV-V] videoEl error code=${code} msg="${msg}" buffered=${videoEl.buffered?.length ? `${videoEl.buffered.start(0).toFixed(2)}-${videoEl.buffered.end(videoEl.buffered.length - 1).toFixed(2)}` : "empty"} ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
      if (code === 3) {
        if (_decodeRetryCount === 0) {
          console.warn(`[AML MV-V] decode error code=3 \u2014 deferring to pipe restart`);
          return;
        }
        if (_decodeRetryCount < 3) return;
        console.warn(`[AML MV] decode error code=3 \u2014 pipe retries exhausted, advancing track`);
        _abortMV(`video-error-3`);
        _amlNextRef?.().catch(() => {
        });
        setTimeout(() => exitBtn?.click(), 200);
      } else if (code === 4) {
        console.warn(`[AML MV] src-not-supported (code=4) \u2014 not retryable, advancing track`);
        _abortMV(`video-error-${code}`);
        _amlNextRef?.().catch(() => {
        });
        setTimeout(() => exitBtn?.click(), 200);
      }
    };
    const onVideoStall = () => console.warn(`[AML MV-V] videoEl stalled ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
    const onVideoWait = () => {
      console.warn(`[AML MV buf:stall] videoEl waiting ct=${videoEl.currentTime.toFixed(2)} readyState=${videoEl.readyState}`);
      if (_avStarted && !_videoStalled && !_bufPaused) {
        _videoStalled = true;
        _mvGateOpen = false;
        mkAudio.muted = true;
        _bufSpinner.style.display = "block";
        console.warn(`[AML MV buf:stall] audio muted during video stall ct=${mkAudio.currentTime.toFixed(2)}`);
      }
    };
    if (!_wcVideo && !_nativeVideo) {
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
        console.log(`[AML MV] canplay videoWidth=${videoEl.videoWidth} videoHeight=${videoEl.videoHeight} readyState=${videoEl.readyState}`);
        const checkBuf = () => {
          if (_abortCtrl?.signal.aborted) return;
          const b = videoEl.buffered;
          const lead = b.length > 0 ? b.end(b.length - 1) : 0;
          if (lead >= 1.5) {
            console.log(`[AML MV buf:gate] video gate satisfied lead=${lead.toFixed(2)}s`);
            _videoCanPlay = true;
            tryStart();
          } else {
            console.log(`[AML MV buf:gate] video gate waiting lead=${lead.toFixed(2)}s (need 1.5s)`);
            videoEl.addEventListener("progress", checkBuf, { once: true });
          }
        };
        checkBuf();
      }, { once: true });
    }
    mkAudio.addEventListener("ended", onEnded);
    if (_wcVideo) {
      const _wcDispatch = (type) => {
        nativeVidEl?.dispatchEvent(new Event(type, { bubbles: false }));
        const mka = getMKAudio();
        if (mka && mka !== mkAudio) mka.dispatchEvent(new Event(type, { bubbles: false }));
      };
      mkAudio.addEventListener("playing", () => {
        console.log(`[AML MV-WC] mkAudio playing ct=${mkAudio.currentTime.toFixed(2)} \u2192 clearing loading`);
        _wcDispatch("playing");
      });
      mkAudio.addEventListener("play", () => _wcDispatch("playing"));
      mkAudio.addEventListener("pause", () => _wcDispatch("pause"));
    }
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
      console.log(`[AML MV-V] cleanup gen=${_mvGen} curGen=${_generation} reason=${_abortReason}`);
      if (_wcCleanup) {
        try {
          _wcCleanup();
        } catch (_) {
        }
        _wcCleanup = null;
      }
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
    console.log(`[AML MV] pipeline started session=${_sessionId}`);
  }
  function _vlcHandleLength(lengthMs, mkAudio) {
    if (!_vlcLengthSet && lengthMs > 0) {
      _vlcLengthSet = true;
      _durationSec = lengthMs / 1e3;
      if (_mkInstance) bridgeDuration(_mkInstance, _durationSec);
    }
    if (!_nextAlacTried && !_nextAlacSession && _durationSec > 0) {
      _nextAlacTried = true;
      console.log(`[AML Gapless] trigger at track start (dur=${_durationSec.toFixed(1)}s) \u2014 starting ALAC pre-warm`);
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
      window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1e3 });
    }
    if (_seekBurstLog > 0) {
      _seekBurstLog--;
      const delta = posMs > 0 ? posMs - _vlcSeekTargetMs : null;
      const deltaStr = delta !== null ? ` \u0394=${delta >= 0 ? "+" : ""}${delta}ms` : "";
      console.log(`[AML VLC seek] poll  vlc.posMs=${posMs}ms  ui.pos=${_vlcPosMs}ms  target=${_vlcSeekTargetMs}ms${deltaStr}  state=${state}  frozen=${_vlcSeekFrozen}`);
      if (delta !== null && delta < -5e3 && _seekBurstLog > 10 && _sessionId && !_vlcSeekFrozen) {
        _seekBurstLog = 0;
        const reloadMs = _vlcSeekTargetMs;
        console.warn(`[AML VLC seek] rewind detected \u0394=${delta}ms \u2014 SeekReload fallback to ${reloadMs}ms`);
        _vlcSeekFrozen = true;
        _vlcPosMs = reloadMs;
        fetch(`${ENGINE}/api/v1/vlc/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: _sessionId, assetId: _currentAssetId, startMs: reloadMs })
        }).then(() => {
          _vlcSeekFrozen = false;
          _seekBurstLog = 20;
          _vlcPrevState = null;
        }).catch(() => {
          _vlcSeekFrozen = false;
        });
      }
    } else if (_vlcTickCount % 20 === 0) {
      console.log(`[AML VLC] pos=${posMs}ms state=${state}`);
    }
  }
  function _vlcHandleEnded(posMs, mkAudio) {
    stopVLCPoll();
    if (posMs > 2e3) {
      _vlcPosMs = Math.round(_durationSec * 1e3);
      mkAudio.dispatchEvent(new Event("timeupdate"));
    }
    if (posMs < 2e3 && _durationSec > 5 && _vlcRetryCount < 2) {
      _vlcRetryCount++;
      _vlcSeekOffsetMs = 0;
      console.log(`[AML VLC] premature end at posMs=${posMs} \u2014 reload attempt ${_vlcRetryCount}`);
      setTimeout(() => {
        if (!_sessionId) return;
        fetch(`${ENGINE}/api/v1/vlc/load`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: _sessionId, assetId: _currentAssetId, startMs: 0 })
        }).then(() => startVLCPoll(mkAudio)).catch(() => {
        });
      }, 1500);
      return;
    }
    const trackEndMs = Math.round(_durationSec * 1e3);
    if (posMs > 2e3 && trackEndMs > 5e3 && posMs < trackEndMs - 3e3 && _vlcRetryCount < 2) {
      _vlcRetryCount++;
      const resumeMs = posMs;
      console.warn(`[AML VLC] false end at ${posMs}ms (track=${trackEndMs}ms) \u2014 seeking to resume at ${resumeMs}ms attempt ${_vlcRetryCount}`);
      setTimeout(() => {
        if (!_sessionId) return;
        fetch(`${ENGINE}/api/v1/vlc/seek`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ posMs: resumeMs, sessionId: _sessionId })
        }).then(() => {
          _vlcPosMs = resumeMs;
          startVLCPoll(mkAudio);
        }).catch(() => {
        });
      }, 500);
      return;
    }
    if (_allowCDNTransition) {
      console.log("[AML VLC] ended \u2014 _amlNext suppressed (CDN gate open)");
    } else {
      console.log("[AML VLC] ended \u2192 _amlNext");
      _amlNextRef?.().catch(() => {
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
      if (!_vlcPostSeek) {
        _vlcPaused = true;
        mkAudio.dispatchEvent(new Event("pause"));
        _startLyricsFreeze(mkAudio);
      }
    }
    if (state === "ended" || state === "stopped" && (prev === "playing" || prev === "ended")) {
      _vlcHandleEnded(posMs, mkAudio);
    }
  }
  async function _vlcPollTick(mkAudio, mySession) {
    if (_vlcFetching) return;
    _vlcFetching = true;
    try {
      const r = await fetch(`${ENGINE}/api/v1/vlc/time`);
      if (!r.ok || _sessionId !== mySession) return;
      _vlcErrCount = 0;
      const { posMs, lengthMs, state } = await r.json();
      if (_sessionId !== mySession) return;
      _vlcHandleLength(lengthMs, mkAudio);
      _vlcUpdatePosition(posMs, state, mkAudio);
      if (state === _vlcPrevState) return;
      const prev = _vlcPrevState;
      _vlcPrevState = state;
      console.log(`[AML VLC] state: ${prev ?? "null"} \u2192 ${state}  posMs=${posMs}  frozen=${_vlcSeekFrozen}`);
      if (_vlcSeekFrozen) return;
      _vlcHandleStateChange(state, prev, posMs, mkAudio);
    } catch (_) {
      if (++_vlcErrCount >= 5) stopVLCPoll();
    } finally {
      _vlcFetching = false;
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
    _vlcPollTimer = setInterval(() => _vlcPollTick(mkAudio, mySession), T().poll);
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
      console.warn(`[AML Gapless] ${reason} \u2014 max retries reached, giving up`);
      return;
    }
    _nextAlacRetries++;
    console.log(`[AML Gapless] ${reason} \u2014 retry ${_nextAlacRetries}/3 in 5s`);
    setTimeout(() => {
      if (_nextAlacSession || !_nextAlacTried) return;
      _nextAlacTried = false;
    }, 5e3);
  }
  function _prewarmHandlePrecache(r) {
    if (r.status === 204) console.log("[AML Gapless] disk cache already populated \u2014 gapless ready \u2713");
    else if (r.status === 202) console.log("[AML Gapless] disk cache download started in engine background");
    else console.warn(`[AML Gapless] precache returned unexpected ${r.status}`);
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
          capabilities: { lossless, atmos: false, video: isVideo },
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
      console.log(`[AML Hover] pre-warmed ${isVideo ? "MV" : "audio"} ${adamId} \u2192 ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
    } catch (_) {
    } finally {
      _hoverInflight.delete(adamId);
    }
  }
  function _installHoverPrewarm(mk) {
    document.addEventListener("pointerenter", (e) => {
      if (!_engineCaps.lossless && !_engineCaps.aac) return;
      try {
        let el = e.target;
        for (let depth = 0; depth < 12 && el; depth++) {
          const did = el.dataset?.id || el.dataset?.contentId || el.dataset?.songId;
          if (did) {
            const numId = did.startsWith("a.") ? did.slice(2) : did;
            if (/^\d{7,12}$/.test(numId) && numId !== _adamId) {
              _hoverPrewarmById(numId);
              return;
            }
          }
          if (el.tagName === "A" && el.href) {
            const m = el.href.match(/\/(\d{7,12})(?:[/?#]|$)/);
            if (m && m[1] !== _adamId) {
              const isMV = el.href.includes("/music-video/");
              _hoverPrewarmById(m[1], isMV);
              return;
            }
          }
          el = el.parentElement;
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
    console.log(`[AML Gapless] opening session for "${nextName}" (${nextAdamId}) attempt=${_nextAlacRetries + 1}`);
    const t0 = performance.now();
    try {
      const sf = mk.storefrontId ?? "us";
      const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: nextAdamId,
          storefront: sf,
          capabilities: { lossless: true, atmos: false, video: false },
          token: mk.developerToken ?? "",
          mediaUserToken: getMUT()
        })
      });
      if (!sessResp.ok) {
        const permanent = sessResp.status === 401 || sessResp.status === 403 || sessResp.status === 404;
        if (permanent) {
          console.warn(`[AML Gapless] session open failed ${sessResp.status} (permanent) \u2014 will not retry`);
        } else {
          _prewarmScheduleRetry(`session open failed ${sessResp.status}`);
        }
        return;
      }
      const sess = await sessResp.json();
      const elapsed = ((performance.now() - t0) / 1e3).toFixed(2);
      if (sess.codec !== "alac") {
        console.log(`[AML Gapless] skipped \u2014 engine returned ${sess.codec} (not lossless) in ${elapsed}s \u2014 will not retry`);
        deleteSession(sess.sessionId);
        return;
      }
      _nextAlacSession = { adamId: nextAdamId, sess };
      console.log(`[AML Gapless] session ready ${sess.sessionId} dur=${(sess.durationMs / 1e3).toFixed(1)}s in ${elapsed}s \u2014 kicking off disk cache download`);
      fetch(`${ENGINE}/api/v1/playback/${sess.sessionId}/precache`, { method: "POST" }).then(_prewarmHandlePrecache).catch(() => console.warn("[AML Gapless] precache request failed \u2014 VLC will download on first play"));
    } catch (e) {
      _prewarmScheduleRetry(`pre-warm error: ${e?.message}`);
    }
  }
  async function _fetchAudioAnalysis(adamId, sf, token) {
    try {
      const params = new URLSearchParams({ sf: sf || "us" });
      if (token) params.set("token", token);
      const r = await fetch(`${ENGINE}/api/v1/audioanalysis/${encodeURIComponent(adamId)}?${params}`);
      if (!r.ok || r.status === 204) return;
      const data = await r.json();
      if (_currentAssetId === adamId) {
        _audioAnalysis = data;
        console.log(`[AML AA] ${adamId} fadeOut=${data.fadeOut?.startMs}\u2013${data.fadeOut?.endMs}ms bpm=${data.bpm || "?"}`);
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
    console.log(`[AML Gapless AAC] opening session for "${nextName}" (${nextAdamId})`);
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
      console.log(`[AML Gapless AAC] session ready ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s in ${elapsed}s`);
    } catch (e) {
      console.warn(`[AML Gapless AAC] pre-warm error: ${e?.message}`);
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
    console.log(`[AML Gapless MV] opening session for "${nextName}" (${nextAdamId})`);
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
      console.log(`[AML Gapless MV] session ready ${sess.sessionId} dur=${(sess.durationMs / 1e3).toFixed(1)}s in ${elapsed}s`);
    } catch (e) {
      console.warn(`[AML Gapless MV] pre-warm error: ${e?.message}`);
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
      console.log(`[AML Gapless AAC] stream pre-opened for ${sess.sessionId} \u2014 TTFB paid`);
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
    window._amlVlcMode = false;
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
      console.log(`[AML Gapless] \u2713 HIT \u2014 using pre-warmed ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s (saved ~2\u20135s webplayback+CDN)`);
      return sess;
    }
    if (!isVideo && !losslessWanted && _nextAacSession?.adamId === adamId) {
      const sess = _nextAacSession.sess;
      _nextAacSession = null;
      console.log(`[AML Gapless AAC] \u2713 HIT \u2014 using pre-warmed ${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
      return sess;
    }
    if (isVideo && _nextMvSession?.adamId === adamId) {
      const sess = _nextMvSession.sess;
      _nextMvSession = null;
      console.log(`[AML Gapless MV] \u2713 HIT \u2014 using pre-warmed ${sess.sessionId} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
      return sess;
    }
    if (_hoverSessions.has(adamId)) {
      const entry = _hoverSessions.get(adamId);
      if (entry.isVideo === isVideo) {
        _hoverSessions.delete(adamId);
        console.log(`[AML Hover] \u2713 HIT \u2014 using hover pre-warmed ${isVideo ? "MV" : "audio"} ${entry.sess.sessionId} codec=${entry.sess.codec} dur=${(entry.sess.durationMs / 1e3).toFixed(1)}s`);
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
    console.warn("[AML MSE] pipe error \u2014 recovering from", bufEnd.toFixed(1) + "s:", err.message);
    if (ms.readyState !== "open") {
      console.error("[AML MSE] ms=" + ms.readyState + ", no recovery");
      return;
    }
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
        console.error("[AML MSE] recovery failed:", e2.message);
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
      console.error("[AML MSE] SourceBuffer error \u2014 ms=" + ms.readyState + " updating=" + sb.updating + " buf=" + (sb.buffered.length > 0 ? sb.buffered.start(0).toFixed(1) + "-" + sb.buffered.end(sb.buffered.length - 1).toFixed(1) + "s" : "empty"));
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
      console.log(`[AML Gapless AAC] \u2713 stream HIT \u2014 using pre-opened response for ${_sessionId}`);
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
      _nativePlay().catch((e) => console.warn("[AML MSE] play():", e));
    };
    if (mkAudio.readyState >= 3) tryPlay();
    else mkAudio.addEventListener("canplay", tryPlay, { once: true });
    const onAACEnded = () => {
      if (ctrl.signal.aborted) return;
      if (_allowCDNTransition) {
        console.log("[AML MSE] ended \u2014 _amlNext suppressed (CDN gate open)");
        return;
      }
      console.log("[AML MSE] audio ended \u2192 _amlNext");
      _amlNextRef?.().catch(() => {
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
    console.log(`[AML MSE] AAC stream open +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
  }
  async function _setupVLCPath(mkAudio, sess, adamId, ctrl, t0) {
    _vlcMode = true;
    window._amlVlcMode = true;
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
    const _postVlcVol = (vol) => fetch(`${ENGINE}/api/v1/vlc/volume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ volume: Math.round(vol * _scFactor) })
    }).catch(() => {
    });
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
    Object.defineProperty(mkAudio, "volume", {
      get: () => _vlcVolume / 100,
      set: (v) => {
        if (_vlcVolSetting) return;
        const newVol = Math.max(0, Math.min(200, Math.round(v * 100)));
        if (newVol === _vlcVolume) return;
        _vlcVolume = newVol;
        _vlcVolPersist = newVol;
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
          _vlcVolPersist = _vlcVolume;
          _postVlcVol(_vlcVolume);
        }
        _dispatchVolChange();
      },
      configurable: true
    });
    mkAudio.pause = () => {
      console.log(`[AML VLC] pause() \u2192 pause`);
      _vlcPaused = true;
      mkAudio.dispatchEvent(new Event("pause"));
      _startLyricsFreeze(mkAudio);
      fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
      });
    };
    _vlcLoading = true;
    const vlcResp = await fetch(`${ENGINE}/api/v1/vlc/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: _sessionId, assetId: adamId, startMs: 0 }),
      signal: ctrl.signal
    });
    if (!vlcResp.ok) throw new Error(`VLC load: ${await vlcResp.text()}`);
    _postVlcVol(_vlcMuted ? 0 : _vlcVolume);
    if (ctrl.signal.aborted) return;
    mkAudio.addEventListener("canplay", () => {
      if (!ctrl.signal.aborted) {
        _vlcPaused = false;
        mkAudio.dispatchEvent(new Event("playing"));
        if (_vlcLoading) mkAudio.dispatchEvent(new Event("waiting"));
      }
    }, { once: true });
    mkAudio.dispatchEvent(new Event("canplay"));
    startVLCPoll(mkAudio);
    console.log(`[AML Engine] VLC playing +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
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
      console.log(`[AML DirectPlay] skip ${adamId} \u2014 music video, deferring to NPIDF path`);
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
    console.log(`[AML DirectPlay] \u2192 ${adamId} (pre-NPIDF fast path)`);
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
          capabilities: { lossless: losslessWanted, atmos: false, video: false },
          mvMaxHeight: _mvMaxHeight,
          token: mk.developerToken ?? "",
          mediaUserToken: getMUT()
        })
      });
      if (genStale(myGen)) return;
      if (!sessResp.ok) {
        console.error("[AML DirectPlay] Session error:", sessResp.status);
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
        return;
      }
      _sessionId = sess.sessionId;
      _directPlayAdamId = null;
      _durationSec = (sess.durationMs ?? 0) / 1e3;
      _currentAssetId = adamId;
      _videoCodec = null;
      _mvVideoHeights = [];
      console.log(`[AML DirectPlay] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
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
        console.error("[AML DirectPlay] Error:", err);
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
    console.log(`[AML Engine] NPIDF confirmed \u2014 direct play in progress/active for ${htcAdamId}, skipping re-open`);
    return true;
  }
  function _htcDiscardStalePrewarms(adamId) {
    if (_nextAlacSession && _nextAlacSession.adamId !== adamId) {
      console.log(`[AML Gapless] MISS \u2014 pre-warm was for ${_nextAlacSession.adamId}, playing ${adamId} \u2014 discarding`);
      deleteSession(_nextAlacSession.sess.sessionId);
      _nextAlacSession = null;
    }
    if (_nextAacSession && _nextAacSession.adamId !== adamId) {
      deleteSession(_nextAacSession.sess.sessionId);
      _nextAacSession = null;
      _discardNextAacStream();
    }
    if (_nextMvSession && _nextMvSession.adamId !== adamId) {
      console.log(`[AML Gapless MV] MISS \u2014 pre-warm was for ${_nextMvSession.adamId}, playing ${adamId} \u2014 discarding`);
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
    if (_htcConfirmDirectPlay(_htcAdamId)) return;
    _directPlayAdamId = null;
    _directPlayGen = 0;
    const myGen = ++_generation;
    _resetPlaybackState();
    setPlayState(PLAY_STATE.OPENING, `htc:${_htcAdamId ?? "?"}`);
    const adamId = item.playParams?.catalogId ?? item.attributes?.playParams?.catalogId ?? item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
    const sf = mk.storefrontId ?? "us";
    if (!adamId) {
      console.warn("[AML Engine] No Adam ID");
      return;
    }
    _currentAssetId = adamId;
    _slInitForTrack(adamId);
    _htcDiscardStalePrewarms(adamId);
    const t0 = performance.now();
    console.log(`[AML Engine] \u2192 ${item.attributes?.name ?? adamId} (id=${adamId} sf=${sf})`);
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
      console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
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
        _fetchAudioAnalysis(adamId, sf, mk.developerToken ?? "").catch(() => {
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
        setPlayState(PLAY_STATE.STREAMING, `htc:alac:${adamId}`);
        await _setupVLCPath(mkAudio, sess, adamId, ctrl, t0);
      }
    } catch (err) {
      if (!_abortCtrl?.signal.aborted) {
        const mk2 = window.MusicKit?.getInstance?.();
        console.error(
          "[AML Engine] Playback error:",
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
  var _HIST_KEY = "aml_play_history";
  var _HIST_MAX = 50;
  var _queueHistory = [];
  async function _histLoadAsync() {
    try {
      const raw = await window.amlBridge?.storeRead(_HIST_KEY);
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
        await window.amlBridge?.storeWrite(_HIST_KEY, legacy);
        localStorage.removeItem(_HIST_KEY);
      }
    } catch (_) {
    }
  }
  async function _histSaveAsync() {
    try {
      await window.amlBridge?.storeWrite(_HIST_KEY, JSON.stringify(_queueHistory));
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
    window.amlBridge?.storeDelete(_HIST_KEY).catch(() => {
    });
    _histRender();
  }
  var _RESUME_KEY = "aml_resume_state";
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
      await window.amlBridge?.storeWrite(_RESUME_KEY, JSON.stringify(_resumeState));
    } catch (_) {
    }
  }
  function _resumeClear() {
    _resumeState = null;
    _resumeDirty = false;
    window.amlBridge?.storeDelete(_RESUME_KEY).catch(() => {
    });
  }
  function _resumeShowChip(mk, saved) {
    if (document.getElementById("aml-resume-chip")) return;
    const FF = "font-family:-apple-system,SF Pro Text,system-ui,sans-serif;";
    const chip = document.createElement("div");
    chip.id = "aml-resume-chip";
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
      if (document.getElementById("aml-resume-chip")) close();
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
      console.warn("[AML Resume] restore failed, falling back to single track:", e?.message);
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
      const raw = await window.amlBridge?.storeRead("resumeEnabled");
      if (raw === "false" || raw === false) _resumeEnabled = false;
    } catch (_) {
    }
    if (!_resumeFlushTimer) _resumeFlushTimer = setInterval(_resumeFlush, 15e3);
    window.addEventListener("pagehide", _resumeFlush);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) _resumeFlush();
    });
    window.amlBridge?.onFlushAndQuit?.(() => {
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
      const raw = await window.amlBridge?.storeRead(_RESUME_KEY);
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
    console.log(`[AML DeepLink] type=${type} id=${id} sf=${sf}`);
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
          console.warn(`[AML DeepLink] unknown type: ${type}`);
      }
    } catch (e) {
      console.error("[AML DeepLink] navigation error:", e.message);
    }
  }
  function _deepLinkSetup(mk) {
    window.amlBridge?.onOpenUrl?.((intent) => {
      _deepLinkOpen(mk, intent).catch(() => {
      });
    });
  }
  function _discordUpdateNow() {
    if (!_discordEnabled || !window.amlBridge?.discordUpdate) return;
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
    window.amlBridge.discordUpdate({
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
      const raw = await window.amlBridge?.storeRead("discordEnabled");
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
      const s = await window.amlBridge?.lastfmStatus();
      _lastfmConnected = !!s?.connected;
      return s;
    } catch (_) {
      return null;
    }
  }
  async function _lbRefreshStatus() {
    try {
      const s = await window.amlBridge?.lbStatus();
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
    if (_lastfmConnected) window.amlBridge?.lastfmNowPlaying?.(meta);
    if (_lbConnected) window.amlBridge?.lbNowPlaying?.(meta);
    if (durSec && durSec < 30) return;
    const thresholdSec = durSec ? Math.min(240, durSec / 2) : 60;
    const startedAt = Date.now();
    const myTimer = setTimeout(() => {
      if (_scrobbleTimer !== myTimer) return;
      _scrobbleTimer = null;
      const scrob = { ...meta, timestamp: Math.floor(startedAt / 1e3) };
      if (_lastfmConnected) window.amlBridge?.lastfmScrobble?.(scrob);
      if (_lbConnected) window.amlBridge?.lbScrobble?.(scrob);
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
      console.warn("[AML Audio] WebAudio graph unavailable:", e?.message);
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
      console.log("[AML SoundCheck] no ludt loudness in stream");
      return;
    }
    const factor = Math.max(0, Math.min(1, Math.pow(10, (SC_TARGET_LKFS - lkfs) / 20)));
    _scFactor = factor;
    console.log(`[AML SoundCheck] loudness=${lkfs.toFixed(2)} LKFS \u2192 factor=${factor.toFixed(3)} (${(20 * Math.log10(factor || 1)).toFixed(2)} dB)`);
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
      const raw = await window.amlBridge?.storeRead("soundCheckEnabled");
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
      console.log(`[AML Crossfade] adaptive plan: ${_xfPlannedSec.toFixed(1)}s fade (session ${cache.sessionId})`);
    } catch (e) {
      console.log("[AML Crossfade] adaptive offline analysis unavailable, using live sampling:", e?.message);
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
    window.amlBridge?.setTweak("crossfade-mode", mode);
    _xfRecompute();
  }
  function _xfSetManualSec(sec) {
    _crossfadeManual = Math.max(0, Math.min(12, sec));
    window.amlBridge?.setTweak("crossfade-sec", _crossfadeManual);
    if (_crossfadeMode === "manual") _xfRecompute();
  }
  async function _xfSetup() {
    try {
      const prefs = await window.amlBridge?.getPrefs();
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
  var _amlToastTimer = null;
  function _amlToast(text) {
    let el = document.getElementById("aml-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "aml-toast";
      el.style.cssText = "position:fixed;left:50%;bottom:96px;transform:translateX(-50%) translateY(10px);z-index:99999;padding:9px 18px;border-radius:20px;background:rgba(30,30,32,0.92);border:0.5px solid rgba(255,255,255,0.14);color:#fff;font-size:13px;font-weight:500;font-family:-apple-system,SF Pro Text,system-ui,sans-serif;pointer-events:none;opacity:0;box-shadow:0 8px 30px rgba(0,0,0,0.5);backdrop-filter:blur(24px) saturate(1.8);-webkit-backdrop-filter:blur(24px) saturate(1.8);transition:opacity 0.2s,transform 0.2s;";
      document.body.appendChild(el);
    }
    el.textContent = text;
    requestAnimationFrame(() => {
      el.style.opacity = "1";
      el.style.transform = "translateX(-50%) translateY(0)";
    });
    clearTimeout(_amlToastTimer);
    _amlToastTimer = setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(-50%) translateY(10px)";
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
        _amlToast("Removed from Favourites");
      } else {
        await mk.api.music(
          `/v1/me/ratings/songs/${id}`,
          {},
          { fetchOptions: { method: "PUT", body: JSON.stringify({ type: "rating", attributes: { value: 1 } }) } }
        );
        _lovedState[id] = true;
        _amlToast("\u2665  Loved");
      }
      _reemitMpris?.();
    } catch (e) {
      console.warn("[AML Love] toggle failed:", e?.message);
      _amlToast("Could not update Favourite");
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
    _amlToast(`Volume ${Math.round(v * 100)}%`);
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
      await window.amlBridge?.storeWrite("hotkeyBindings", JSON.stringify(_hotkeyBindings));
    } catch (_) {
    }
  }
  async function _hotkeysSetup() {
    try {
      const raw = await window.amlBridge?.storeRead("hotkeysEnabled");
      if (raw === "false" || raw === false) _hotkeysEnabled = false;
      const b = await window.amlBridge?.storeRead("hotkeyBindings");
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
    const section = document.getElementById("aml-history-section");
    if (!section) return;
    if (_queueHistory.length === 0) {
      section.style.display = "none";
      return;
    }
    section.style.display = "";
    section.innerHTML = `
        <div class="aml-hs-header">
            <span class="aml-hs-title">History</span>
        </div>
        <div class="aml-hs-list">
        ${_queueHistory.slice(0, 30).map((h) => `
            <div class="aml-hs-item" data-catalog-id="${_histEscape(h.catalogId)}">
                ${h.artworkUrl ? `<img class="aml-hs-art" src="${_histEscape(h.artworkUrl)}" loading="lazy">` : `<div class="aml-hs-art aml-hs-art-ph"></div>`}
                <div class="aml-hs-meta">
                    <div class="aml-hs-name">${_histEscape(h.name)}</div>
                    <div class="aml-hs-artist">${_histEscape(h.artist)}</div>
                </div>
                ${h.duration ? `<span class="aml-hs-dur">${_histEscape(h.duration)}</span>` : ""}
            </div>`).join("")}
        </div>`;
  }
  function _histInjectStyles() {
    if (document.getElementById("aml-hist-css")) return;
    const s = document.createElement("style");
    s.id = "aml-hist-css";
    s.textContent = `
#aml-history-section {
    border-bottom: 1px solid var(--separator, rgba(128,128,128,.18));
    padding-bottom: 8px;
    margin-bottom: 4px;
}
.aml-hs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px var(--side-panel-horizontal-padding, 20px) 8px;
}
.aml-hs-title {
    font-size: 17px;
    font-weight: 700;
    letter-spacing: normal;
    text-transform: none;
    opacity: 1;
}
.aml-hs-list { padding-bottom: 4px; max-height: 300px; overflow-y: auto; scrollbar-width: thin; }
.aml-hs-item {
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
.aml-hs-item:hover { background: var(--systemFillTertiary, rgba(128,128,128,.14)); }
.aml-hs-art {
    width: 40px;
    height: 40px;
    border-radius: 4px;
    object-fit: cover;
    flex-shrink: 0;
    background: rgba(128,128,128,.18);
}
.aml-hs-art-ph { background: rgba(128,128,128,.18); }
.aml-hs-meta { min-width: 0; flex: 1; }
.aml-hs-name {
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.aml-hs-artist {
    font-size: 11px;
    opacity: .55;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.aml-hs-dur {
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
      panel.querySelector("#aml-history-section")?.remove();
      return;
    }
    if (panel.querySelector("#aml-history-section")) return;
    const div = document.createElement("div");
    div.id = "aml-history-section";
    div.addEventListener("click", (e) => {
      const item = e.target.closest(".aml-hs-item");
      if (item?.dataset.catalogId) window._amlHistPlay(item.dataset.catalogId);
    });
    panel.prepend(div);
    _histRender();
  }
  async function setupQueueHistory(mk) {
    _histInjectStyles();
    window._amlHistClear = _histClear;
    window._amlHistPlay = (catalogId) => {
      if (!catalogId) return;
      mk.setQueue({ song: catalogId }).then(() => mk.play()).catch(() => {
      });
    };
    try {
      const pref = await window.amlBridge?.storeRead("historyEnabled");
      if (pref !== null && pref !== void 0) _histEnabled = pref !== "false" && pref !== false;
    } catch (_) {
    }
    await _histLoadAsync();
    mk.addEventListener("nowPlayingItemWillChange", () => _histPush(mk.nowPlayingItem));
    watchDomSettled(_histInject);
  }
  async function setup() {
    if (window.__amlEngineMounted) return;
    window.__amlEngineMounted = true;
    blockAppleCDN();
    let _amlLastGotoMs = 0;
    const _inGotoWindow = () => performance.now() - _amlLastGotoMs < 1e3 || _playState === PLAY_STATE.OPENING || _playState === PLAY_STATE.STREAMING;
    const _isSpuriousDialog = (el) => el?.tagName === "DIALOG" && el?.dataset?.testid === "dialog" && el?.classList?.contains("error");
    const _origShowModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function() {
      if (_isSpuriousDialog(this)) {
        const mkAudio = getMKAudio();
        const mk2 = window.MusicKit?.getInstance?.();
        console.error(
          "[AML] Error dialog showModal triggered \u2014 dumping state:",
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
          console.log("[AML] Suppressed error dialog showModal (goto window)");
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
        console.log("[AML] Closed spurious error dialog (goto window)");
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    try {
      const msg = await window._amlEngine?.waitFor("engine.snapshot", T().sseWait);
      const snap = msg?.payload?.snapshot;
      const gen = msg?.meta?.generation ?? "?";
      const why = msg?.meta?.reason ?? "?";
      _snapshotEventId = msg?.meta?.id ?? -1;
      if (snap?.capabilities) {
        _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        window._amlLossless = _engineCaps.lossless && _streamingQuality !== "high-quality";
      }
      console.log(`[AML Engine] Engine ready \u2014 drm.session=${snap?.drm?.session ?? "unknown"} lossless=${_engineCaps.lossless} gen=${gen} reason=${why} snapshotId=${_snapshotEventId}`);
    } catch (e) {
      console.warn("[AML Engine] Engine snapshot timeout:", e.message, "\u2014 continuing");
    }
    window.amlBridge?.getPrefs().then((p) => {
      if (p["streaming-quality"]) _streamingQuality = p["streaming-quality"];
      if (p["lossless-enabled"] === false) _streamingQuality = "high-quality";
      if (p["downloads-quality"]) _downloadsQuality = p["downloads-quality"];
      window._amlLossless = _engineCaps.lossless && _streamingQuality !== "high-quality";
      const body = {};
      if (p.prewarmLimitMB != null) body.prewarmLimitMB = p.prewarmLimitMB;
      if (p.persistLimitMB != null) body.persistLimitMB = p.persistLimitMB;
      if (p.persistTTLDays != null) body.persistTTLDays = p.persistTTLDays;
      if (Object.keys(body).length)
        fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {
        });
    }).catch(() => {
    });
    window._amlEngine?.on("drm", (msg) => {
      const eventId = msg?.meta?.id ?? Infinity;
      if (eventId <= _snapshotEventId) {
        console.log(`[AML Engine] DRM event ${eventId} skipped (predates snapshot ${_snapshotEventId})`);
        return;
      }
      const snap = msg?.payload;
      const wasLossless = _engineCaps.lossless;
      const sess = snap?.state?.session ?? "unknown";
      if (snap?.capabilities) {
        _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
        window._amlLossless = _engineCaps.lossless && _streamingQuality !== "high-quality";
      }
      console.log(`[AML Engine] DRM state \u2192 session=${sess} lossless=${_engineCaps.lossless}`);
      if (!wasLossless && _engineCaps.lossless) _losslessWaitDone = false;
      if (snap?.challenge?.type === "credentials") {
        console.log("[AML Engine] DRM credential challenge \u2014 opening sign-in form");
        window.__amlOpenEngineSettings?.();
      }
    });
    const mk = await waitForMusicKit();
    console.log("[AML Engine] MusicKit ready");
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
    setInterval(_pushLibraryTokens, 6e4);
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
          console.log("[AML Library] auto-sync: waiting for web UI login (MK status=" + mkForAuth.authorizationStatus + ")");
          const _onAuth = async () => {
            mk.removeEventListener("authorizationStatusDidChange", _onAuth);
            await _maybeAutoSync();
          };
          mk.addEventListener("authorizationStatusDidChange", _onAuth);
          return;
        }
        const status = await fetch(ENGINE + "/api/v1/library/status").then((r) => r.json()).catch(() => null);
        if (!status?.needsSync) return;
        console.log("[AML Library] auto-sync: cache needs refresh (web auth)");
        const result = await _syncLibraryViaJS();
        if (result.songs === 0) {
          console.log("[AML Library] auto-sync: library is empty \u2014 will not retry for 24h");
        } else {
          console.log(`[AML Library] auto-sync done: ${result.songs} songs, ${result.playlists} playlists`);
        }
      } catch (e) {
        console.log("[AML Library] auto-sync failed:", e.message || e);
      }
    };
    setTimeout(_maybeAutoSync, 2e3);
    const _origMKPlay = mk.play.bind(mk);
    const _origMKPause = mk.pause.bind(mk);
    mk.play = function() {
      if (_vlcMode) {
        if (_vlcPaused) {
          console.log("[AML VLC] mk.play() \u2192 resume");
          _vlcPaused = false;
          fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
          });
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
        console.log("[AML VLC] mk.pause() \u2192 pause");
        _vlcPaused = true;
        getMKAudio()?.dispatchEvent(new Event("pause"));
        fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
        });
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
    let _amlAdvancing = false;
    let _amlAdvancingTimer = null;
    let _amlGotoTarget = null;
    let _amlGotoTargetId = null;
    function _clearAdvancing() {
      _amlAdvancing = false;
      clearTimeout(_amlAdvancingTimer);
      _amlAdvancingTimer = null;
    }
    async function _amlGoto(ci, ii) {
      if (_amlAdvancing) {
        console.log("[AML] _amlGoto busy, ignoring ci=", ci, "ii=", ii);
        return;
      }
      _amlAdvancing = true;
      _amlTransitioning = true;
      _amlLastGotoMs = performance.now();
      _amlNavInternal = true;
      _amlPendingCI = ci;
      _amlPendingII = ii;
      const targetFlat = _sessionFlatIdx(ci, ii);
      _amlGotoTarget = targetFlat;
      console.log("[AML] _amlGoto ci=", ci, "ii=", ii, "flat=", targetFlat);
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
      _amlAdvancingTimer = setTimeout(() => {
        _amlGotoTarget = null;
        _amlGotoTargetId = null;
        _allowCDNTransition = false;
        _amlTransitioning = false;
        _amlNavInternal = false;
        _amlPendingCI = -1;
        _amlPendingII = -1;
        _clearAdvancing();
      }, 6e3);
      const mkCurrentItems = mk.queue?.items ?? [];
      const mkDirectIdx = targetSongId ? mkCurrentItems.findIndex((it) => extractItemId(it) === targetSongId) : -1;
      const targetIsVideo = _isVideoId(targetSongId);
      if (mkDirectIdx >= 0 && !targetIsVideo) {
        _amlGotoTarget = mkDirectIdx;
        _amlGotoTargetId = targetSongId ?? null;
        await mk.changeToMediaAtIndex(mkDirectIdx).catch(() => {
        });
      } else {
        const allIds = _sessionFlatIds();
        if (!allIds.length) {
          clearTimeout(_amlAdvancingTimer);
          _clearAdvancing();
          _amlGotoTarget = null;
          _amlGotoTargetId = null;
          _allowCDNTransition = false;
          _amlTransitioning = false;
          _amlNavInternal = false;
          _amlPendingCI = -1;
          _amlPendingII = -1;
          return;
        }
        const hasVideo = targetIsVideo || allIds.some(_isVideoId);
        if (hasVideo) {
          const desc = targetIsVideo ? { musicVideo: targetSongId } : { song: targetSongId };
          console.log("[AML] _amlGoto mixed/MV session \u2014 targeted setQueue " + JSON.stringify(desc));
          _amlGotoTarget = 0;
          _amlGotoTargetId = targetSongId ?? null;
          await mk.setQueue(desc).catch(() => {
          });
          await mk.changeToMediaAtIndex(0).catch(() => {
          });
        } else {
          const targetIdx = Math.max(0, Math.min(targetFlat, allIds.length - 1));
          _amlGotoTarget = targetIdx;
          _amlGotoTargetId = targetSongId ?? null;
          await mk.setQueue({ songs: allIds }).catch(() => {
          });
          await mk.changeToMediaAtIndex(targetIdx).catch(() => {
          });
        }
      }
      _clearAdvancing();
      _updateTransportButtons();
      const mkAudio = document.querySelector("audio");
      if (mkAudio && !_vlcMode) mkAudio.dispatchEvent(new Event("waiting"));
    }
    async function _amlNext(manual = false) {
      const repeat = mk.repeatMode ?? 0;
      const ci = _sessionContainerIdx, ii = _sessionItemIdx;
      const cur = _sessionContainers[ci];
      if (repeat === 1 && !manual) {
        if (ci >= 0) await _amlGoto(ci, ii);
        return;
      }
      if (!cur) return;
      if (ii + 1 < cur.items.length) {
        await _amlGoto(ci, ii + 1);
      } else if (repeat === 2) {
        await _amlGoto(ci, 0);
      } else if (ci + 1 < _sessionContainers.length) {
        await _amlGoto(ci + 1, 0);
      } else {
        const mkItems = mk.queue?.items ?? [];
        const freshIds = mkItems.map(extractItemId).filter((id) => id && !cur.items.includes(id));
        if (freshIds.length) {
          cur.items.push(...freshIds);
          await _amlGoto(ci, ii + 1);
        } else if (mk.queue?.playbackMode === 1 && _mkOrigSkipToNext) {
          console.log("[AML Station] end of snapshot \u2014 delegating to MK native skip for station fetch");
          _mkOrigSkipToNext();
        }
      }
    }
    async function _amlPrev() {
      const ci = _sessionContainerIdx, ii = _sessionItemIdx;
      if (ci < 0) return;
      if (ii > 0) {
        await _amlGoto(ci, ii - 1);
      } else if (ci > 0) {
        await _amlGoto(ci - 1, _sessionContainers[ci - 1].items.length - 1);
      }
    }
    const _mkOrigSkipToNext = mk.skipToNextItem?.bind(mk);
    mk.skipToNextItem = () => _amlNext(true);
    mk.skipToPreviousItem = _amlPrev;
    _amlNextRef = _amlNext;
    function _ownedGoto(ids, startId, label, closeGate) {
      const items = ids.slice();
      const target = startId && items.includes(startId) ? startId : items[0];
      let ci = _sessionContainers.findIndex((c) => c.items.length === items.length && c.items.every((v, i) => v === items[i]));
      if (ci < 0) {
        _sessionContainers.push({ items });
        ci = _sessionContainers.length - 1;
      }
      const ii = Math.max(0, _sessionContainers[ci].items.indexOf(target));
      if (_AML_DEBUG) console.log(`[MK-DBG] ${label} \u2192 owned change: ${items.length} track(s) ci=${ci} ii=${ii} target=${target}`);
      if (closeGate) closeGate();
      return _amlGoto(ci, ii).then(() => _AML_DEBUG && console.log(`[MK-DBG] ${label} \u2192 owned change dispatched`)).catch((err) => _AML_DEBUG && console.log(`[MK-DBG] ${label} \u2192 owned change failed:`, err?.message || err));
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
      if (!window.amlBridge?.mprisUpdate || !item) return;
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
      window.amlBridge.mprisUpdate({
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
      window.amlBridge?.mprisUpdate?.({ status, position: _mprisPosMs() * 1e3, seeked });
    }
    function _pushMiniState() {
      const a = getMKAudio();
      window.amlBridge?.mprisUpdate?.({
        volume: a && Number.isFinite(a.volume) ? Math.round(a.volume * 100) : 100,
        repeat: mk.repeatMode ?? 0,
        shuffle: mk.shuffleMode === 1,
        loved: !!_lovedState[_currentAssetId]
      });
    }
    _pushMiniStateRef = _pushMiniState;
    window.amlBridge?.onMiniSync?.(() => {
      try {
        if (mk.nowPlayingItem) sendMprisMetadata(mk.nowPlayingItem);
        _pushMiniState();
        const playing = mk.playbackState === window.MusicKit?.PlaybackStates?.playing;
        window.amlBridge?.mprisUpdate?.({ status: playing ? "Playing" : "Paused", position: _mprisPosMs() * 1e3 });
      } catch (_) {
      }
    });
    window.amlBridge?.onMprisCmd?.((cmd) => {
      if (cmd && typeof cmd === "object") {
        if (cmd.type === "seek") {
          const targetMs = Math.max(0, _mprisPosMs() + cmd.deltaMs);
          mk.seekToTime(targetMs / 1e3);
          window.amlBridge?.mprisUpdate?.({ position: targetMs * 1e3, seeked: true });
        } else if (cmd.type === "setPosition") {
          const targetMs = Math.max(0, cmd.ms);
          mk.seekToTime(targetMs / 1e3);
          window.amlBridge?.mprisUpdate?.({ position: targetMs * 1e3, seeked: true });
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
          _amlNext(true).catch(() => {
          });
          break;
        case "previous":
          if (mk.currentPlaybackTime > 3) mk.seekToTime(0);
          else _amlPrev().catch(() => {
          });
          break;
      }
    });
    mk.addEventListener("shuffleModeDidChange", () => {
      window.amlBridge?.mprisUpdate?.({ shuffle: mk.shuffleMode === 1 });
    });
    mk.addEventListener("repeatModeDidChange", () => {
      window.amlBridge?.mprisUpdate?.({ repeat: mk.repeatMode ?? 0 });
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
        console.log("[AML AAC-GATE] click caught vlc=" + _vlcMode + " sel=" + (_dbgPlaySel?.dataset?.testid || _dbgPlaySel?.className?.toString()?.slice(0, 30) || "?"));
        if (_dbgPlaySel?.dataset?.testid === "click-action" && (_dbgPlaySel?.href?.includes("/music-video/") || !!e.target?.closest?.('[class*="vertical-video"]'))) {
          console.log("[AML AAC-GATE] MV click-action \u2014 skipping interceptor, allowing navigation");
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
          let el = e.target;
          if (e.target?.closest?.('[class*="vertical-video"]')) _domWalkIsMV = true;
          for (let depth = 0; depth < 12 && el; depth++) {
            const did = el.dataset?.id || el.dataset?.contentId || el.dataset?.songId;
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
            if (el.tagName === "A" && el.href) {
              const mvM = el.href.match(/\/music-video\/[^/]+\/(\d{7,12})(?:[/?#]|$)/);
              if (mvM) {
                aacCatalogId = mvM[1];
                _itemTypes.set(aacCatalogId, "music-videos");
                aacSetQueueDesc = { musicVideo: aacCatalogId };
                break;
              }
              const m = el.href.match(/\/(\d{7,12})(?:[/?#]|$)/);
              if (m) {
                aacCatalogId = m[1];
                break;
              }
            }
            if (el.className && typeof el.className === "string" && el.className.includes("vertical-video")) {
              _domWalkIsMV = true;
            }
            el = el.parentElement;
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
        if (_AML_DEBUG) console.log("[AML click] external play in AAC mode \u2014 opening CDN gate playbackState=" + mk.playbackState + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null") + " catalogId=" + (aacCatalogId || "not-found") + (aacSetQueueDesc ? " desc=" + JSON.stringify(aacSetQueueDesc) : "") + (_aacPlaylistId ? " playlist=" + _aacPlaylistId + " (pre-fetching)" : "") + " target=" + (e.target?.tagName || "?") + " testId=" + (e.target?.closest("[data-testid]")?.dataset?.testid || "none") + " matched=" + (_dbgPlaySel?.dataset?.testid || _dbgPlaySel?.className?.toString()?.slice(0, 40) || "?"));
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
          if (_AML_DEBUG) console.log("[MK-DBG AAC] mk.setQueue() args=" + JSON.stringify(a).slice(0, 400));
          if (desc?.playlists && desc?.startWith?.id) {
            const startCid = _normalizeStartId(desc);
            if (_AML_DEBUG) console.log("[MK-DBG AAC] playlists \u2192 resolving pre-fetched tracks, startWith=" + startCid);
            return _resolvePlaylistCatalogIds().then((catalogIds) => {
              if (catalogIds.length > 1) {
                return _aacOwnedGoto(catalogIds, startCid, "playlist/local");
              }
              if (_AML_DEBUG) console.log("[MK-DBG AAC] playlists \u2192 cache cold, passthrough");
              if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
              _externalPlayGateTimer = setTimeout(() => {
                if (_AML_DEBUG) console.log("[AML click] AAC CDN gate reset (safety timeout)");
                _aacCloseGate();
              }, 45e3);
              const p2 = _aacMkApiSaved.setQueue.apply(mk, a);
              if (p2?.then) p2.then(
                () => _AML_DEBUG && console.log("[MK-DBG AAC] playlists \u2192 passthrough resolved"),
                (err) => {
                  if (_AML_DEBUG) console.log("[MK-DBG AAC] playlists \u2192 passthrough rejected:", err?.message || err);
                  _aacCloseGate();
                }
              );
              return p2;
            });
          }
          if (desc?.albums?.length === 1 && typeof desc.albums[0] === "string" && desc.albums[0].startsWith("l.")) {
            const albumId = desc.albums[0];
            const startWithLid = desc.startWith?.id ?? null;
            if (_AML_DEBUG) console.log("[MK-DBG AAC] albums \u2192 querying local cache for " + albumId);
            const fetchPromise = fetch(`${ENGINE}/api/v1/library/albums/${encodeURIComponent(albumId)}/tracks`).then((r) => r.ok ? r.json() : null).catch(() => null);
            return Promise.race([fetchPromise, new Promise((res) => setTimeout(() => res(null), 3e3))]).then((result) => {
              const tracks = result?.tracks || [];
              const catalogIds = tracks.map((t) => t.cid).filter((id) => id && /^\d{6,}$/.test(id));
              if (catalogIds.length > 0) {
                if (_AML_DEBUG) console.log("[MK-DBG AAC] albums \u2192 local cache: " + catalogIds.length + " tracks");
                const startCid = startWithLid ? (tracks.find((t) => t.lid === startWithLid) || {}).cid : _pendingExternalClickCatalogId || null;
                return _aacOwnedGoto(catalogIds, startCid, "albums/local");
              }
              if (_AML_DEBUG) console.log("[MK-DBG AAC] albums \u2192 cache cold, fetching tracks via MK REST");
              if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
              _externalPlayGateTimer = setTimeout(() => {
                if (_AML_DEBUG) console.log("[AML click] AAC CDN gate reset (safety timeout)");
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
                  if (_AML_DEBUG) console.log("[MK-DBG AAC] albums \u2192 REST fetch: " + directIds.length + " tracks (store for next time)");
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
                if (_AML_DEBUG) console.log("[MK-DBG AAC] albums \u2192 REST empty, last-resort Apple setQueue (timeout=" + _coldTimeout / 1e3 + "s)");
                if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
                _externalPlayGateTimer = setTimeout(() => {
                  if (_AML_DEBUG) console.log("[AML click] AAC CDN gate reset (safety timeout after setQueue)");
                  _aacCloseGate();
                }, _coldTimeout);
                const p2 = _aacMkApiSaved.setQueue.apply(mk, a);
                if (p2?.then) p2.then(
                  () => _AML_DEBUG && console.log("[MK-DBG AAC] setQueue resolved"),
                  (err) => {
                    if (_AML_DEBUG) console.log("[MK-DBG AAC] setQueue rejected:", err?.message || err);
                    _aacCloseGate();
                  }
                );
                return p2;
              });
            });
          }
          const startWithId = _normalizeStartId(desc);
          if (startWithId) {
            if (desc?.startWith?.type === "music-videos" || desc?.url?.includes("/music-video/")) {
              _itemTypes.set(startWithId, "music-videos");
            }
            return _aacOwnedGoto([startWithId], startWithId, "startWith");
          }
          if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
          _externalPlayGateTimer = setTimeout(() => {
            if (_AML_DEBUG) console.log("[AML click] AAC CDN gate reset (safety timeout after setQueue)");
            _aacCloseGate();
          }, 45e3);
          const p = _aacMkApiSaved.setQueue.apply(mk, a);
          if (p?.then) p.then(
            () => _AML_DEBUG && console.log("[MK-DBG AAC] setQueue resolved"),
            (err) => {
              if (_AML_DEBUG) console.log("[MK-DBG AAC] setQueue rejected:", err?.message || err);
              _aacCloseGate();
            }
          );
          return p;
        };
        mk.changeToMediaAtIndex = (idx) => {
          if (_AML_DEBUG) console.log("[MK-DBG AAC] mk.changeToMediaAtIndex(" + idx + ")");
          const p = _aacMkApiSaved.changeToMediaAtIndex.call(mk, idx);
          if (p?.then) p.then(
            () => _AML_DEBUG && console.log("[MK-DBG AAC] ctmi resolved"),
            (err) => _AML_DEBUG && console.log("[MK-DBG AAC] ctmi rejected:", err?.message || err)
          );
          return p;
        };
        const _aacGateAudioEl = getMKAudio();
        const _aacGateEvts = ["pause", "play", "playing", "waiting", "stalled", "error", "emptied", "loadstart", "canplay", "canplaythrough", "ended"];
        const _aacGateEvtHandler = (ev) => {
          const el = _aacGateAudioEl;
          if (_AML_DEBUG) console.log("[AUDIO-EVT] " + ev.type + " paused=" + el?.paused + " readyState=" + el?.readyState + " src=" + (el?.src || "").slice(0, 60));
        };
        if (_aacGateAudioEl) _aacGateEvts.forEach((t) => _aacGateAudioEl.addEventListener(t, _aacGateEvtHandler));
        const _aacGateStateListener = () => _AML_DEBUG && console.log("[MK-DBG] playbackStateDidChange \u2192 " + mk.playbackState + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null"));
        mk.addEventListener("playbackStateDidChange", _aacGateStateListener);
        const _aacGateTracingCleanup = () => {
          if (_aacGateAudioEl) _aacGateEvts.forEach((t) => _aacGateAudioEl.removeEventListener(t, _aacGateEvtHandler));
          mk.removeEventListener("playbackStateDidChange", _aacGateStateListener);
        };
        if (typeof _savedGateTracingCleanup === "function") _savedGateTracingCleanup();
        _savedGateTracingCleanup = _aacGateTracingCleanup;
        if (_externalPlayGateTimer) clearTimeout(_externalPlayGateTimer);
        _externalPlayGateTimer = setTimeout(() => {
          if (_AML_DEBUG) console.log("[AML click] AAC CDN gate reset (safety timeout)");
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
        console.log("[AML VLC-GATE] click caught vlc=" + _vlcMode + " saved=" + !!_mkApiSaved + " sel=" + (_dbgPlaySel?.dataset?.testid || _dbgPlaySel?.className?.toString()?.slice(0, 30) || "?"));
        if (_dbgPlaySel?.dataset?.testid === "click-action" && (_dbgPlaySel?.href?.includes("/music-video/") || !!e.target?.closest?.('[class*="vertical-video"]'))) {
          console.log("[AML VLC-GATE] MV click-action \u2014 skipping interceptor, allowing navigation");
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
          let el = e.target;
          for (let depth = 0; depth < 12 && el; depth++) {
            const did = el.dataset?.id || el.dataset?.contentId || el.dataset?.songId;
            if (did) {
              const numId = did.startsWith("a.") ? did.slice(2) : did;
              if (/^\d{7,12}$/.test(numId)) {
                _pendingExternalClickCatalogId = numId;
                break;
              }
            }
            if (el.tagName === "A" && el.href) {
              const m = el.href.match(/\/(\d{7,12})(?:[/?#]|$)/);
              if (m) {
                _pendingExternalClickCatalogId = m[1];
                break;
              }
            }
            el = el.parentElement;
          }
        } catch (_) {
        }
        try {
          const qItems = mk.queue?.items;
          if (qItems?.length && _pendingExternalClickCatalogId) {
            _pendingExternalClickQueueIdx = qItems.findIndex((it) => extractItemId(it) === _pendingExternalClickCatalogId);
          }
          if (_AML_DEBUG && qItems?.length && !window._amlQueueItemDumped) {
            window._amlQueueItemDumped = true;
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
            console.log("[AML queue-item dump]", JSON.stringify(dump, (_, v) => typeof v === "function" ? "[fn]" : v, 2).slice(0, 4e3));
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
        if (_AML_DEBUG) console.log("[AML click] external play while VLC active \u2014 opening CDN gate playbackState=" + mk.playbackState + " amlGotoTarget=" + _amlGotoTarget + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null") + " catalogId=" + (_pendingExternalClickCatalogId || "not-found") + (_pendingPlaylistId ? " playlist=" + _pendingPlaylistId + " (pre-fetching)" : ""));
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
            const targetNumId = targetId.startsWith("a.") ? targetId.slice(2) : targetId;
            const isLibraryTrack = targetId.startsWith("a.");
            const effectiveCatalogId = _pendingExternalClickCatalogId || (/^\d{6,}$/.test(targetNumId) ? targetNumId : null);
            if (isLibraryTrack && effectiveCatalogId) {
              const catalogId = effectiveCatalogId;
              const fetchPromise = _pendingPlaylistFetch ? Promise.race([_pendingPlaylistFetch, new Promise((res) => setTimeout(() => res(null), 3e3))]) : Promise.resolve(null);
              return fetchPromise.then((result) => {
                const tracks = result?.tracks || [];
                const catalogIds = tracks.map((t) => t.cid).filter((id) => id && /^\d{6,}$/.test(id));
                if (catalogIds.length > 1) {
                  if (_AML_DEBUG) console.log("[MK-DBG] setQueue \u2192 local cache: " + catalogIds.length + " tracks, startWith=" + catalogId);
                  const pDesc = { songs: catalogIds };
                  if (catalogIds.includes(catalogId)) pDesc.startWith = { id: catalogId };
                  const p2 = _mkApiSaved.setQueue.call(mk, pDesc);
                  if (p2?.then) p2.then(() => _AML_DEBUG && console.log("[MK-DBG] local cache resolved"), (e2) => _AML_DEBUG && console.log("[MK-DBG] local cache rejected:", e2?.message || String(e2)));
                  return p2;
                }
                if (_AML_DEBUG) console.log("[MK-DBG] setQueue \u2192 passthrough (cache cold) catalogId=" + catalogId);
                const p = _mkApiSaved.setQueue.apply(mk, a);
                if (p?.then) p.then(() => _AML_DEBUG && console.log("[MK-DBG] passthrough resolved"), (e2) => _AML_DEBUG && console.log("[MK-DBG] passthrough rejected:", e2?.message || String(e2)));
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
                  console.log("[AML VLC] \u2192 _amlGoto(" + ci2 + "," + ii + ") id=" + id + " via click-idx=" + _pendingExternalClickQueueIdx);
                  _amlGoto(ci2, ii).catch(() => {
                  });
                  return true;
                }
              }
            }
            for (let c = 0; c < _sessionContainers.length; c++) {
              const ii = (_sessionContainers[c]?.items ?? []).indexOf(id);
              if (ii >= 0) {
                console.log("[AML VLC] \u2192 _amlGoto(" + c + "," + ii + ") id=" + id);
                _amlGoto(c, ii).catch(() => {
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
              console.log("[AML VLC] \u2192 _amlGoto(" + ci + "," + ii + ") id=" + id + " (added to container)");
              _amlGoto(ci, ii).catch(() => {
              });
              return true;
            }
            return false;
          };
          if (desc?.url && desc?.startWith?.id) {
            const startId = _normalizeStartId(desc);
            if (startId) {
              if (_vlcGotoById(startId)) return;
              console.log("[AML VLC] url-setQueue \u2192 passthrough (not in queue, id=" + startId + ")");
            }
          }
          const clickId = _pendingExternalClickCatalogId;
          if (clickId) {
            if (_vlcGotoById(clickId)) return;
            console.log("[AML VLC] setQueue(" + Object.keys(desc ?? {}).join("/") + ") \u2192 passthrough (id=" + clickId + " not in queue)");
          }
          console.log("[AML VLC] passthrough with teardown \u2014 handing off to MK");
          const _origSQ = _mkApiSaved.setQueue;
          if (_externalPlayGateTimer) {
            clearTimeout(_externalPlayGateTimer);
            _externalPlayGateTimer = null;
          }
          stopVLCPoll();
          unbridgeDuration();
          fetch(ENGINE + "/api/v1/vlc/stop", { method: "POST" }).catch(() => {
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
          return _origSQ.apply(mk, a);
        };
        mk.changeToMediaAtIndex = (idx) => {
          console.log("[VLC-MK] mk.changeToMediaAtIndex(" + idx + ")");
          const p = _mkApiSaved.changeToMediaAtIndex.call(mk, idx);
          if (p?.then) p.then((r) => console.log("[VLC-MK] ctmi(" + idx + ") resolved"), (e2) => console.log("[VLC-MK] ctmi(" + idx + ") rejected:", e2?.message || e2));
          return p;
        };
        const _gateAudioEl = getMKAudio();
        const _gateEvts = ["pause", "play", "playing", "waiting", "stalled", "error", "emptied", "loadstart", "canplay", "canplaythrough", "ended"];
        const _gateEvtHandler = (ev) => {
          const el = _gateAudioEl;
          if (_AML_DEBUG) console.log("[AUDIO-EVT] " + ev.type + " paused=" + el?.paused + " readyState=" + el?.readyState + " src=" + (el?.src || "").slice(0, 60));
        };
        if (_gateAudioEl) _gateEvts.forEach((t) => _gateAudioEl.addEventListener(t, _gateEvtHandler));
        const _gateStateListener = () => _AML_DEBUG && console.log("[MK-DBG] playbackStateDidChange \u2192 " + mk.playbackState + " nowPlaying=" + (mk.nowPlayingItem?.attributes?.name || "null"));
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
          const el = getMKAudio();
          if (el && _vlcMode) {
            el.load = () => {
            };
            Object.defineProperty(el, "paused", { get: () => _vlcPaused, configurable: true });
            Object.defineProperty(el, "currentTime", { get: () => _vlcPosMs / 1e3, set: () => {
            }, configurable: true });
            startVLCPoll(el);
          }
          _allowCDNTransition = false;
          _externalPlayGateTimer = null;
          if (_AML_DEBUG) console.log("[AML click] CDN gate reset (safety timeout)");
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
            console.log("[aml] track-click: non-linear same-playlist jump to ci=", ci, "ii=", intraIdx);
            _amlGoto(ci, intraIdx).catch(() => {
            });
          } else {
            console.log("[aml] track-click: inserted at next, calling _amlNext");
            _amlNext(true).catch(() => {
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
    _scSetup();
    _xfSetup();
    _hotkeysSetup();
    _installHoverPrewarm(mk);
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
        console.log(`[AML Station] queueItemsDidChange \u2014 added ${added} new item(s) to container, total=${activeCur.items.length}`);
        _updateTransportButtons();
      }
    });
    mk.addEventListener("nowPlayingItemDidChange", async () => {
      console.log("[NPIDF] fired item=" + (mk.nowPlayingItem?.attributes?.name || "null") + " allowCDN=" + _allowCDNTransition + " amlGotoTarget=" + _amlGotoTarget);
      if (_amlGotoTarget !== null) {
        const item2 = mk.nowPlayingItem;
        if (!item2) return;
        const itemId = extractItemId(item2);
        const targetItem = mk.queue?.items?.[_amlGotoTarget];
        const targetId = _amlGotoTargetId || extractItemId(targetItem);
        if (targetId && itemId !== targetId) {
          console.log("[AML] NPIDF filtered: spurious event for", item2?.attributes?.name, "(advancing to idx", _amlGotoTarget, "target id", targetId, ")");
          return;
        }
        _amlGotoTarget = null;
        _amlGotoTargetId = null;
        _amlTransitioning = false;
        clearTimeout(_amlAdvancingTimer);
        _amlAdvancingTimer = null;
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
      const wasInternal = _amlNavInternal;
      _amlNavInternal = false;
      if (item) {
        const songId = extractItemId(item);
        if (wasInternal && _amlPendingCI >= 0) {
          _sessionContainerIdx = _amlPendingCI;
          _sessionItemIdx = _amlPendingII;
          _amlPendingCI = -1;
          _amlPendingII = -1;
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
      window._amlSmartCache?.onTrackChange(mk);
      if (item) {
        const id = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
        window._amlSmartCache?.recordPlay(id);
        sendMprisMetadata(item);
      } else {
        sendMprisStatus("Stopped");
      }
    });
    mk.addEventListener("playbackStateDidChange", () => {
      const PS = window.MusicKit?.PlaybackStates;
      console.log(`[AML Engine] state=${mk.playbackState} (playing=${PS?.playing})`);
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
          console.log("[AML VLC] playbackStateDidChange \u2192 playing \u2192 resume");
          _vlcPaused = false;
          fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
          });
        }
      } else if (s === PS?.paused) {
        console.log("[AML VLC] playbackStateDidChange \u2192 paused \u2192 pause");
        _vlcPaused = true;
        fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
        });
      }
    });
    const cache = window._amlSmartCache;
    if (cache) {
      cache.observeNavigation(() => mk);
      cache.warmOnStartup(mk);
    }
    if (mk.nowPlayingItem) handleTrackChange(mk);
  }
  setup().catch((e) => console.error("[AML Engine] setup:", e));
  (function initSearchSuggestionsPortal() {
    let portaled = null;
    function positionPortal(el) {
      const bar = document.querySelector('[class*="search-input-wrapper"]');
      if (!bar) return;
      const r = bar.getBoundingClientRect();
      el.style.setProperty("position", "fixed", "important");
      el.style.setProperty("top", r.bottom + 6 + "px", "important");
      el.style.setProperty("left", r.left + "px", "important");
      el.style.setProperty("width", r.width + "px", "important");
      el.style.setProperty("z-index", "9999", "important");
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
      if (!input || input._amlPortalWired) return;
      input._amlPortalWired = true;
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
        statsEl.id = "aml-tracklist-stats";
        headings.appendChild(statsEl);
        lastText = null;
      }
      if (src && (!restEl || restEl.previousElementSibling !== src)) {
        restEl?.remove();
        restEl = document.createElement("p");
        restEl.id = "aml-tracklist-footer-rest";
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
      "--aml-nav-bg",
      "--aml-nav-border",
      "--aml-accent",
      "--aml-accent-active",
      "--keyColor",
      "--aml-art-page-bg",
      "--aml-art-glow-a",
      "--aml-art-glow-b",
      "--aml-art-raised",
      "--aml-art-on-accent",
      "--aml-art-src"
    ];
    const BG_LAYER_IDS = ["_amlBlurBg", "_amlAccentBg", "_amlCustomBg", "_amlArtBlur", "_amlArtBg"];
    let enabled = true;
    let lastSrc = null;
    let token = 0;
    const style = document.createElement("style");
    style.id = "aml-art-theme-style";
    style.textContent = `
        /* \u2500\u2500 hide Apple's full-page artwork wash \u2500\u2500 */
        [data-aml-page-art] { visibility: hidden !important; }

        /* \u2500\u2500 blurred artwork backdrop \u2500\u2500 */
        /* Sits below the gradient glow layer. ::before = blurred artwork fill;
           ::after = palette-tinted dark overlay so content stays legible. */
        #_amlArtBlur {
            position: fixed; inset: 0; z-index: 0; pointer-events: none;
            opacity: 0; transition: opacity .8s ease;
            overflow: hidden;
        }
        #_amlArtBlur::before {
            content: ''; position: absolute; inset: -8%;
            background-image: var(--aml-art-src, none);
            background-size: cover; background-position: center;
            filter: blur(80px) saturate(1.6);
        }
        #_amlArtBlur::after {
            content: ''; position: absolute; inset: 0;
            background: var(--aml-nav-bg, rgba(0,0,0,0.65));
        }
        body[data-aml-art-theme] #_amlArtBlur { opacity: 1; }

        /* \u2500\u2500 gradient glow layer (sits above the blur) \u2500\u2500 */
        /* pageBg removed \u2014 the blur layer's tint overlay provides the dark base. */
        #_amlArtBg {
            position: fixed; inset: 0; z-index: 0; pointer-events: none;
            opacity: 0; transition: opacity .6s ease;
            background:
                radial-gradient(60% 55% at 12% 8%, var(--aml-art-glow-a, transparent), transparent 70%),
                radial-gradient(55% 50% at 92% 88%, var(--aml-art-glow-b, transparent), transparent 70%);
        }
        body[data-aml-art-theme] #_amlArtBg { opacity: 1; }

        /* \u2500\u2500 page body: hue-tinted dark base \u2500\u2500 */
        body[data-aml-art-theme] { background: var(--aml-art-page-bg) !important; }
        body[data-aml-art-theme] .body-container,
        body[data-aml-art-theme] .app-container,
        body[data-aml-art-theme] main,
        body[data-aml-art-theme] .content-container,
        body[data-aml-art-theme] .scrollable-page,
        body[data-aml-art-theme] .section,
        body[data-aml-art-theme] .section-content,
        body[data-aml-art-theme] .container-detail-header,
        body[data-aml-art-theme] .container-detail-header-wrapper { background: transparent !important; }

        /* \u2500\u2500 navigation sidebar \u2500\u2500 */
        body[data-aml-art-theme] nav.navigation {
            background: var(--aml-nav-bg) !important;
            border-right-color: var(--aml-nav-border) !important;
        }
        body[data-aml-art-theme] .navigation-item__link:hover { background: var(--aml-art-raised) !important; }
        body[data-aml-art-theme] .navigation-item--selected .navigation-item__link { background: var(--aml-accent-active) !important; }
        body[data-aml-art-theme] .navigation-item--selected .navigation-item__label,
        body[data-aml-art-theme] .navigation-item--selected .navigation-item__icon { color: var(--aml-accent) !important; }

        /* \u2500\u2500 footer player bar \u2500\u2500 */
        /* Leave Apple's player bar completely unstyled. The --keyColor override on
           body[data-aml-art-theme] (see keyColor propagation below) already swaps
           the accent colour (play button, scrubber fill, etc.) from pink to the
           art-derived accent. No background, blur or clip-path changes needed. */
        /* Light text on nav sidebar, side panel and context menus */
        body[data-aml-art-theme] nav.navigation,
        body[data-aml-art-theme] .side-panel,
        body[data-aml-art-theme] .contextual-menu { color: rgba(255,255,255,0.85) !important; }
        body[data-aml-art-theme] .navigation-items__header { color: rgba(255,255,255,0.5) !important; }
        body[data-aml-art-theme] .search-input__text-field { color: rgba(255,255,255,0.85) !important; }

        /* \u2500\u2500 tracklist rows \u2500\u2500 */
        body[data-aml-art-theme] .songs-list-row { border-color: var(--aml-nav-border) !important; }
        body[data-aml-art-theme] .songs-list-row:hover,
        body[data-aml-art-theme] .library-track:not(.library-track--header):hover { background: var(--aml-art-raised) !important; }
        body[data-aml-art-theme] .songs-list-row.songs-list-row--selected,
        body[data-aml-art-theme] .library-track.is-playing { background: var(--aml-accent-active) !important; }
        body[data-aml-art-theme] .songs-list__header,
        body[data-aml-art-theme] .library-track--header { background: transparent !important; }

        /* \u2500\u2500 primary actions (Play / Shuffle / Add) \u2500\u2500 */
        body[data-aml-art-theme] .primary-actions__button--play button {
            background: var(--aml-accent) !important; color: var(--aml-art-on-accent) !important;
        }
        body[data-aml-art-theme] .primary-actions__button--play button svg,
        body[data-aml-art-theme] .primary-actions__button--play button svg path { fill: var(--aml-art-on-accent) !important; }
        body[data-aml-art-theme] .primary-actions__button--shuffle button,
        body[data-aml-art-theme] .primary-actions__button--add-to-library button { background: var(--aml-art-raised) !important; }

        /* \u2500\u2500 context menus \u2500\u2500 */
        body[data-aml-art-theme] .contextual-menu {
            background: var(--aml-nav-bg) !important;
            border: 1px solid var(--aml-nav-border) !important;
            backdrop-filter: blur(20px) !important;
            -webkit-backdrop-filter: blur(20px) !important;
        }
        body[data-aml-art-theme] .contextual-menu-item > button:hover,
        body[data-aml-art-theme] .contextual-menu-item > a:hover { background: var(--aml-art-raised) !important; }

        /* \u2500\u2500 search \u2500\u2500 */
        body[data-aml-art-theme] .search-input__text-field,
        body[data-aml-art-theme] .search-input-wrapper { background: var(--aml-art-raised) !important; }
        body[data-aml-art-theme] .search-scope-bar__pill-option--selected {
            background: var(--aml-accent) !important; color: var(--aml-art-on-accent) !important;
        }

        /* \u2500\u2500 side panel / Up Next \u2500\u2500 */
        body[data-aml-art-theme] .side-panel {
            background: var(--aml-nav-bg) !important;
            border-left-color: var(--aml-nav-border) !important;
            backdrop-filter: blur(20px) !important;
            -webkit-backdrop-filter: blur(20px) !important;
        }
        body[data-aml-art-theme] .up-next-item:hover { background: var(--aml-art-raised) !important; }

        /* \u2500\u2500 shelf / grid \u2500\u2500 */
        body[data-aml-art-theme] .shelf,
        body[data-aml-art-theme] section.shelf-grid,
        body[data-aml-art-theme] .shelf-grid__body { background: transparent !important; }

        /* \u2500\u2500 keyColor propagation for amp-* web components \u2500\u2500 */
        body[data-aml-art-theme] { --keyColor: var(--aml-accent); }
    `;
    (document.head || document.documentElement).appendChild(style);
    function markPageArt() {
      const vw = innerWidth, vh = innerHeight;
      for (const el of document.querySelectorAll(".artwork-component:not([data-aml-page-art])")) {
        if (el.closest('[class*="lockup"], [class*="shelf"], nav, [class*="player"], [class*="lcd"], [class*="artwork__main"], [class*="artist-header"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw * 0.6 && r.height >= vh * 0.6) el.setAttribute("data-aml-page-art", "");
      }
    }
    function ensureBgLayers() {
      let ref = document.body.firstElementChild;
      while (ref && BG_LAYER_IDS.includes(ref.id)) ref = ref.nextElementSibling;
      if (!document.getElementById("_amlArtBg")) {
        const l = document.createElement("div");
        l.id = "_amlArtBg";
        document.body.insertBefore(l, ref);
      }
      if (!document.getElementById("_amlArtBlur")) {
        const l = document.createElement("div");
        l.id = "_amlArtBlur";
        document.body.insertBefore(l, document.getElementById("_amlArtBg"));
      }
    }
    function apply(roles, artSrc) {
      const b = document.body.style;
      b.setProperty("--aml-nav-bg", roles.navBg);
      b.setProperty("--aml-nav-border", roles.border);
      b.setProperty("--aml-accent", roles.accent);
      b.setProperty("--aml-accent-active", roles.accentActive);
      b.setProperty("--keyColor", roles.accent);
      b.setProperty("--aml-art-page-bg", roles.pageBg);
      b.setProperty("--aml-art-glow-a", roles.glowA);
      b.setProperty("--aml-art-glow-b", roles.glowB);
      b.setProperty("--aml-art-raised", roles.raised);
      b.setProperty("--aml-art-on-accent", roles.onAccent);
      b.setProperty("--aml-art-src", artSrc ? `url("${artSrc.replace(/"/g, "%22")}")` : "none");
      ensureBgLayers();
      document.body.setAttribute("data-aml-art-theme", "");
    }
    function clear() {
      if (!document.body) return;
      for (const v of BODY_VARS) document.body.style.removeProperty(v);
      document.body.removeAttribute("data-aml-art-theme");
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
    function nowPlayingArtSrc() {
      try {
        const mk = window.MusicKit?.getInstance?.();
        if (!mk?.nowPlayingItem) return null;
        const art = mk.nowPlayingItem.attributes?.artwork;
        if (!art?.url) return null;
        return art.url.replace("{w}", "80").replace("{h}", "80");
      } catch (_) {
        return null;
      }
    }
    async function sync() {
      if (!document.body) return;
      markPageArt();
      if (!enabled) {
        if (lastSrc !== null || document.body.hasAttribute("data-aml-art-theme")) {
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
      if (!src) src = nowPlayingArtSrc();
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
    window.addEventListener("aml:art-theme", (e) => {
      enabled = !!e.detail;
      lastSrc = null;
      sync();
    });
    window.amlBridge?.getPrefs?.().then((p) => {
      enabled = p?.artTheme !== false;
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
  window.amlClearSession = function() {
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
    console.log("[AML] amlClearSession: all playback stopped and session released");
  };
  window.amlStartSession = async function(adamId, sf) {
    const mk = _mkInstance;
    if (!mk) {
      console.warn("[AML] amlStartSession: no MK instance");
      return null;
    }
    const storefront = sf ?? mk.storefrontId ?? "us";
    const losslessWanted = _engineCaps.lossless && _streamingQuality !== "high-quality";
    console.log(`[AML] amlStartSession adamId=${adamId} sf=${storefront} lossless=${losslessWanted}`);
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
      console.error(`[AML] amlStartSession: engine ${r.status}`);
      return null;
    }
    const sess = await r.json();
    console.log(`[AML] amlStartSession: session=${sess.sessionId} codec=${sess.codec} dur=${(sess.durationMs / 1e3).toFixed(1)}s`);
    return sess;
  };
  window.amlGetQueueInfo = function() {
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
    if (!window.amlBridge) return;
    let injected = false;
    const FF = "font-family:-apple-system,SF Pro Text,system-ui,sans-serif;";
    function dot(ok) {
      const d = document.createElement("span");
      d.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${ok ? "#34c759" : "#ff3b30"};`;
      return d;
    }
    function makeSection(title) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "margin-top:32px;";
      const h = document.createElement("h2");
      h.textContent = title;
      h.style.cssText = FF + "font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:rgba(255,255,255,0.4);margin:0 0 8px;";
      const body = document.createElement("div");
      body.style.cssText = "background:rgba(255,255,255,0.08);border-radius:10px;padding:0 14px;";
      wrap.appendChild(h);
      wrap.appendChild(body);
      return { wrap, body };
    }
    function makeRow(label, val, subtitle, isLast) {
      const r = document.createElement("div");
      r.style.cssText = "display:flex;align-items:center;padding:11px 0;" + (isLast ? "" : "border-bottom:0.5px solid rgba(255,255,255,0.07);");
      const lbl = document.createElement("div");
      lbl.style.cssText = "flex:1;";
      const m = document.createElement("div");
      m.style.cssText = FF + "font-size:13px;color:rgba(255,255,255,0.85);";
      m.textContent = label;
      lbl.appendChild(m);
      if (subtitle) {
        const s = document.createElement("div");
        s.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.38);margin-top:2px;";
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
      b.style.cssText = FF + "padding:5px 13px;border-radius:6px;border:none;font-size:12px;cursor:pointer;background:rgba(255,255,255,0.12);color:rgba(255,255,255,0.85);white-space:nowrap;";
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
    const checkDRMStatus = (status, msgEl, t, onDone, onChallenge) => {
      const auth = status.state?.authentication;
      const session = status.state?.session;
      if (session === "valid" || auth === "logged_in" || status.state?.fairplay === "ready" || status.capabilities?.cbcs === true) {
        clearInterval(t);
        onDone();
        return;
      }
      if (auth === "challenging") {
        clearInterval(t);
        onChallenge();
        return;
      }
      if (auth === "failed") {
        clearInterval(t);
        msgEl.textContent = status.message || "Authentication failed.";
      }
    };
    function buildAccountSection(drm, onRefresh) {
      const { wrap, body } = makeSection("Engine Account");
      const drmState = drm?.state ?? drm ?? {};
      const processOk = drmState?.process === "running";
      const isSignedIn = processOk && drmState?.session === "valid" || drmState?.authentication === "logged_in" || drmState?.fairplay === "ready" || drm?.capabilities?.cbcs === true;
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
          sub.textContent = "Sign in to enable lossless and hi-res playback";
          text.appendChild(sub);
        }
        row.appendChild(text);
        const btn = makeBtn(isSignedIn ? "Sign Out" : "Sign In\u2026");
        btn.onclick = isSignedIn ? async () => {
          btn.disabled = true;
          btn.textContent = "Signing out\u2026";
          await fetch(`${ENGINE}/api/v1/drm/logout`, { method: "POST" }).catch(() => {
          });
          onRefresh();
        } : renderSignIn;
        row.appendChild(btn);
        body.appendChild(row);
      }
      function renderSignIn() {
        body.innerHTML = "";
        const emailInp = makeInput("email", "Apple ID (email)");
        const passInp = makeInput("password", "Password");
        const msgEl = document.createElement("div");
        msgEl.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.5);padding:4px 0;min-height:16px;";
        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:8px;padding:10px 0 4px;";
        const cancelBtn = makeBtn("Cancel");
        const goBtn = makeBtn("Sign In");
        goBtn.style.cssText += "background:#fc3c44;color:#fff;";
        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(goBtn);
        body.appendChild(emailInp);
        body.appendChild(passInp);
        body.appendChild(msgEl);
        body.appendChild(btnRow);
        cancelBtn.onclick = renderState;
        goBtn.onclick = async () => {
          const email = emailInp.value.trim();
          const password = passInp.value;
          if (!email || !password) {
            msgEl.textContent = "Email and password required.";
            return;
          }
          goBtn.disabled = true;
          goBtn.textContent = "Signing in\u2026";
          msgEl.textContent = "";
          const r = await fetch(`${ENGINE}/api/v1/drm/authenticate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
          }).catch((e) => {
            msgEl.textContent = e.message;
          });
          if (!r) {
            goBtn.disabled = false;
            goBtn.textContent = "Sign In";
            return;
          }
          if (!r.ok) {
            msgEl.textContent = await r.text().catch(() => `HTTP ${r.status}`);
            goBtn.disabled = false;
            goBtn.textContent = "Sign In";
            return;
          }
          msgEl.textContent = "Contacting Apple servers\u2026";
          pollForAuth(msgEl);
        };
      }
      function pollForAuth(msgEl) {
        let n = 0;
        const t = setInterval(async () => {
          if (++n > 60) {
            clearInterval(t);
            msgEl.textContent = "Timed out. Refresh to check status.";
            return;
          }
          const status = await fetchDRM().catch(() => null);
          if (!status) return;
          checkDRMStatus(status, msgEl, t, onRefresh, renderChallenge);
        }, 1e3);
      }
      function renderChallenge() {
        body.innerHTML = "";
        const note = document.createElement("div");
        note.style.cssText = FF + "font-size:13px;color:rgba(255,255,255,0.85);padding:10px 0 4px;";
        note.textContent = "Two-factor authentication \u2014 enter the code sent to your device.";
        const codeInp = makeInput("text", "6-digit code");
        codeInp.maxLength = 8;
        const errEl = document.createElement("div");
        errEl.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.5);padding:4px 0;min-height:16px;";
        const submitBtn = makeBtn("Submit");
        submitBtn.style.cssText += "margin-top:6px;";
        body.appendChild(note);
        body.appendChild(codeInp);
        body.appendChild(errEl);
        body.appendChild(submitBtn);
        submitBtn.onclick = async () => {
          const reply = codeInp.value.trim();
          if (!reply) return;
          submitBtn.disabled = true;
          const r = await fetch(`${ENGINE}api/v1/drm/challenge`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reply })
          }).catch((e) => {
            errEl.textContent = e.message;
          });
          if (!r) {
            submitBtn.disabled = false;
            return;
          }
          if (!r.ok) {
            errEl.textContent = await r.text().catch(() => `HTTP ${r.status}`);
            submitBtn.disabled = false;
            return;
          }
          pollForAuth(errEl);
        };
      }
      renderState();
      return wrap;
    }
    function getDialog() {
      let dlg = document.getElementById("aml-settings-dialog");
      if (dlg) return dlg;
      dlg = document.createElement("dialog");
      dlg.id = "aml-settings-dialog";
      const st = document.createElement("style");
      st.textContent = `
            #aml-settings-dialog {
                position:fixed; inset:0; margin:auto;
                width:min(660px,calc(100vw - 48px));
                max-height:min(82vh,760px); overflow-y:auto;
                border:0.5px solid rgba(255,255,255,0.14); border-radius:16px;
                background:rgba(18,18,20,0.93);
                backdrop-filter:blur(48px) saturate(1.9);
                -webkit-backdrop-filter:blur(48px) saturate(1.9);
                box-shadow:0 32px 80px rgba(0,0,0,0.8),0 0 0 0.5px rgba(255,255,255,0.07);
                padding:0 32px 32px; color:rgba(255,255,255,0.9);
                font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
            }
            #aml-settings-close {
                position:sticky; top:18px; float:right; z-index:10;
                margin-left:auto; flex-shrink:0;
            }
            #aml-settings-dialog::backdrop {
                background:rgba(0,0,0,0.4);
            }
            #aml-settings-dialog::-webkit-scrollbar { width:4px; }
            #aml-settings-dialog::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.18);border-radius:2px; }
            @keyframes _aml-pop-in  { from{opacity:0;transform:scale(0.88)} to{opacity:1;transform:scale(1)} }
            @keyframes _aml-pop-out { from{opacity:1;transform:scale(1)}    to{opacity:0;transform:scale(0.88)} }
            @keyframes _aml-spin    { to{transform:rotate(360deg)} }
            ._aml-spinner { display:inline-block;width:10px;height:10px;border:1.5px solid rgba(255,255,255,0.18);border-top-color:rgba(255,255,255,0.6);border-radius:50%;animation:_aml-spin .7s linear infinite;flex-shrink:0; }
            #aml-settings-dialog.aml-opening { animation:_aml-pop-in  .22s cubic-bezier(.34,1.4,.64,1) forwards; }
            #aml-settings-dialog.aml-closing { animation:_aml-pop-out .16s ease-in forwards; }
        `;
      document.head.appendChild(st);
      document.body.appendChild(dlg);
      dlg.addEventListener("click", (e) => {
        document.querySelectorAll(".aml-qdrop-menu").forEach((m) => {
          m.style.display = "none";
        });
        if (e.target === dlg) closeSettings();
      }, true);
      return dlg;
    }
    function closeSettings() {
      _hotkeyCapture = null;
      const dlg = document.getElementById("aml-settings-dialog");
      if (!dlg?.open) return;
      dlg.classList.replace("aml-opening", "aml-closing") || dlg.classList.add("aml-closing");
      dlg.addEventListener("animationend", () => {
        dlg.classList.remove("aml-closing");
        dlg.close();
      }, { once: true });
    }
    function _amlMiniBtn(onClick) {
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
    function _amlIOSToggle(on, onChange) {
      const label = document.createElement("label");
      label.style.cssText = "position:relative;display:inline-flex;align-items:center;cursor:pointer;flex-shrink:0;width:44px;height:26px;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = on;
      cb.style.cssText = "position:absolute;opacity:0;width:0;height:0;pointer-events:none;";
      const track = document.createElement("span");
      track.style.cssText = `position:absolute;inset:0;border-radius:13px;transition:background 0.22s;background:${on ? "var(--aml-accent,#fc3c44)" : "rgba(255,255,255,0.18)"};`;
      const thumb = document.createElement("span");
      thumb.style.cssText = `position:absolute;top:3px;left:${on ? "21px" : "3px"};width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);transition:left 0.22s;`;
      label.append(cb, track, thumb);
      cb.addEventListener("change", () => {
        track.style.background = cb.checked ? "var(--aml-accent,#fc3c44)" : "rgba(255,255,255,0.18)";
        thumb.style.left = cb.checked ? "21px" : "3px";
        onChange(cb.checked);
      });
      label._cb = cb;
      return label;
    }
    function _amlMakeQualityDropdown(prefKey, prefs, qualityOpts, onChange) {
      const saved = prefs[prefKey] ?? "lossless";
      let current = saved;
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:relative;display:inline-block;";
      const btn = document.createElement("div");
      btn.className = "aml-qdrop-btn";
      const btnLabel = document.createElement("span");
      btnLabel.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const chevron = document.createElement("span");
      chevron.className = "aml-qdrop-chevron";
      chevron.innerHTML = "&#9660;";
      btn.append(btnLabel, chevron);
      const menu = document.createElement("div");
      menu.className = "aml-qdrop-menu";
      menu.style.cssText += "display:none;position:absolute;top:calc(100% + 4px);right:0;left:auto;z-index:10;";
      function setOption(value, save) {
        current = value;
        const opt = qualityOpts.find((o) => o.value === value);
        btnLabel.textContent = opt ? opt.label : value;
        const sv = String(value);
        menu.querySelectorAll(".aml-qdrop-item").forEach((el) => {
          el.classList.toggle("selected", el.dataset.value === sv);
        });
        if (save) {
          window.amlBridge?.setTweak(prefKey, value);
          if (prefKey === "streaming-quality") _streamingQuality = value;
          onChange?.(value);
        }
      }
      qualityOpts.forEach(({ value, label }) => {
        const item = document.createElement("div");
        item.className = "aml-qdrop-item";
        item.dataset.value = value;
        const accent = document.createElement("div");
        accent.className = "aml-qdrop-accent";
        const lbl = document.createElement("div");
        lbl.className = "aml-qdrop-item-label";
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
        document.querySelectorAll(".aml-qdrop-menu").forEach((m) => {
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
    function _amlGenPalette(hex, appearance) {
      hex = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#fc3c44";
      const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      const d = mx - mn, s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
      let h = 0;
      if (d) {
        if (mx === r) h = ((g - b) / d + 6) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      const hi = Math.round(h), si = Math.round(s * 100);
      if (appearance === "light") {
        return { accent: hex, bgColor: `hsla(${hi},${Math.round(si * 0.25)}%,96%,1)`, navBg: `hsla(${hi},${Math.round(si * 0.3)}%,91%,0.95)`, navBorder: `hsla(${hi},${Math.round(si * 0.6)}%,30%,0.15)`, accentActive: `hsla(${hi},${si}%,45%,0.15)` };
      }
      return { accent: hex, bgColor: `hsla(${hi},${Math.round(si * 0.5)}%,10%,1)`, navBg: `hsla(${hi},${Math.round(si * 0.8)}%,14%,0.72)`, navBorder: `hsla(${hi},${Math.round(si * 0.7)}%,50%,0.25)`, accentActive: `hsla(${hi},${Math.round(si * 0.9)}%,60%,0.28)` };
    }
    function _amlCssColorToHex(str) {
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
    function _amlRenderPaletteEditor(container, thInfo, st) {
      container.innerHTML = "";
      const pal = st.curPalette || _amlGenPalette(thInfo.systemAccent || "#fc3c44", st.curAppearance);
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
        picker.value = _amlCssColorToHex(pal[key] || "#336699");
        picker.style.cssText = "position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;";
        picker.oninput = () => {
          pal[key] = picker.value;
          swatchWrap.style.background = picker.value;
          st.curPalette = { ...pal };
          window.amlBridge.setThemePalette(key, picker.value);
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
      const resetBtn = makeBtn("Reset to system accent");
      resetBtn.style.cssText += "margin:10px 0;display:block;";
      resetBtn.onclick = async () => {
        const newPal = await window.amlBridge.resetThemePalette();
        if (newPal) {
          st.curPalette = newPal;
          _amlRenderPaletteEditor(container, thInfo, st);
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
              window.amlBridge.applyThemePreset(name);
              _amlRenderPaletteEditor(container, thInfo, st);
            }
          };
          chip.appendChild(cl);
          if (!builtin) {
            const del = document.createElement("button");
            del.innerHTML = _svgClose;
            del.style.cssText = "border:none;background:transparent;color:rgba(255,255,255,0.35);cursor:pointer;padding:0 0 0 4px;display:inline-flex;align-items:center;";
            del.onclick = () => {
              st.thPresets = st.thPresets.filter((x) => x.name !== name);
              window.amlBridge.deleteThemePreset(name);
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
        const newPresets = await window.amlBridge.saveThemePreset(name);
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
        await window.amlBridge.exportThemePreset(name);
      };
      const importBtn = makeBtn("Import");
      importBtn.onclick = async () => {
        const preset = await window.amlBridge.importThemePreset();
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
      btn.className = "aml-qdrop-btn";
      btn.style.cssText += "font-size:12px;";
      const btnLabel = document.createElement("span");
      btnLabel.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const chevron = document.createElement("span");
      chevron.className = "aml-qdrop-chevron";
      chevron.innerHTML = "&#9660;";
      btn.append(btnLabel, chevron);
      const menu = document.createElement("div");
      menu.className = "aml-qdrop-menu";
      menu.style.cssText += "display:none;position:absolute;top:calc(100% + 4px);right:0;left:auto;z-index:20;min-width:100%;";
      function setOpt(v, save) {
        current = v;
        const opt = options.find((o) => o.value === v);
        btnLabel.textContent = opt ? opt.label : v;
        const sv = String(v);
        menu.querySelectorAll(".aml-qdrop-item").forEach((el) => el.classList.toggle("selected", el.dataset.value === sv));
        if (save) onSave(v);
      }
      options.forEach(({ value, label }) => {
        const item = document.createElement("div");
        item.className = "aml-qdrop-item";
        item.dataset.value = value;
        const accent = document.createElement("div");
        accent.className = "aml-qdrop-accent";
        const lbl = document.createElement("div");
        lbl.className = "aml-qdrop-item-label";
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
        document.querySelectorAll(".aml-qdrop-menu").forEach((m) => {
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
    function _amlMakeTemplateRow(label, presets, savedValue, prefKey, suffix, prefs, updatePreview) {
      const isCustom = !presets.some((p) => p.value === savedValue);
      const rowWrap = document.createElement("div");
      rowWrap.style.cssText = "display:flex;flex-direction:column;gap:5px;";
      const topRow = document.createElement("div");
      topRow.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
      const customLbl = document.createElement("span");
      customLbl.style.cssText = FF + "display:inline-flex;align-items:center;gap:6px;color:rgba(255,255,255,0.4);font-size:11px;flex-shrink:0;";
      const _customToggleEl = _amlIOSToggle(isCustom, () => syncMode && syncMode());
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
        window.amlBridge?.setTweak(prefKey, v);
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
          window.amlBridge?.setTweak(prefKey, val);
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
          window.amlBridge?.setTweak(prefKey, getValue());
          exampleEl.textContent = _dlRenderTemplate(getValue()) + (suffix || "");
          updatePreview();
        }
      };
      resetBtn.onclick = () => {
        customCb.checked = false;
        setValue(presets[0].value);
        window.amlBridge?.setTweak(prefKey, presets[0].value);
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
        s.className = "_aml-spinner";
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
        const sessOk = st.session === "valid" || cbcs;
        const sessText = st.session === "valid" ? "valid" : cbcs ? "active (cbcs)" : st.session ?? "unknown";
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
          { label: "Backend", text: d.backend?.selected ?? "embedded", noDot: true }
        ];
      }
      function applyStatusRow(v, { ok, loading, text, noDot }) {
        v.innerHTML = "";
        if (!noDot) v.appendChild(loading ? spinner() : dot(ok));
        v.appendChild(document.createTextNode(text));
      }
      const valEls = [];
      renderStatusRows(drm).forEach((row, i, arr) => {
        const v = statusVal("", row.noDot ? void 0 : row.ok);
        applyStatusRow(v, row);
        valEls.push({ el: v, noDot: !!row.noDot });
        stBody.appendChild(makeRow(row.label, v, row.subtitle, i === arr.length - 1));
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
      blurVal.textContent = `${prefs.glassBlur ?? 20}px`;
      const blurSl = document.createElement("input");
      blurSl.type = "range";
      blurSl.min = 0;
      blurSl.max = 80;
      blurSl.step = 4;
      blurSl.value = prefs.glassBlur ?? 20;
      blurSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      blurSl.oninput = () => {
        blurVal.textContent = `${blurSl.value}px`;
        window.amlBridge.setGlassBlur(+blurSl.value);
      };
      const blurR = document.createElement("div");
      blurR.style.cssText = "display:flex;align-items:center;flex:1;";
      blurR.appendChild(blurSl);
      blurR.appendChild(blurVal);
      blurR.appendChild(makeResetBtn("glass blur", () => {
        blurSl.value = 20;
        blurVal.textContent = "20px";
        window.amlBridge.setGlassBlur(20);
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
        window.amlBridge.setBgBlur(+bgBlurSl.value);
      };
      const bgBlurR = document.createElement("div");
      bgBlurR.style.cssText = "display:flex;align-items:center;flex:1;";
      bgBlurR.appendChild(bgBlurSl);
      bgBlurR.appendChild(bgBlurVal);
      bgBlurR.appendChild(makeResetBtn("background blur", () => {
        bgBlurSl.value = 18;
        bgBlurVal.textContent = "18px";
        window.amlBridge.setBgBlur(18);
      }));
      dBody.appendChild(makeRow("Background blur", bgBlurR, "Wallpaper blur (requires a wallpaper to be set)", false));
      const navOpVal = document.createElement("span");
      navOpVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;";
      const initNavAlpha = prefs.themeNavBgAlpha ?? 0.72;
      navOpVal.textContent = Math.round(initNavAlpha * 100) + "%";
      const navOpSl = document.createElement("input");
      navOpSl.type = "range";
      navOpSl.min = 0;
      navOpSl.max = 1;
      navOpSl.step = 0.01;
      navOpSl.value = initNavAlpha;
      navOpSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      navOpSl.oninput = () => {
        navOpVal.textContent = Math.round(+navOpSl.value * 100) + "%";
        window.amlBridge.setNavOpacity(+navOpSl.value);
      };
      const navOpR = document.createElement("div");
      navOpR.style.cssText = "display:flex;align-items:center;flex:1;";
      navOpR.appendChild(navOpSl);
      navOpR.appendChild(navOpVal);
      navOpR.appendChild(makeResetBtn("sidebar opacity", () => {
        navOpSl.value = 0.72;
        navOpVal.textContent = "72%";
        window.amlBridge.setNavOpacity(0.72);
      }));
      dBody.appendChild(makeRow("Sidebar opacity", navOpR, "How opaque the sidebar background is", false));
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
        window.amlBridge.setZoom(+zoomSl.value / 100);
      };
      const zoomR = document.createElement("div");
      zoomR.style.cssText = "display:flex;align-items:center;flex:1;";
      zoomR.appendChild(zoomSl);
      zoomR.appendChild(zoomVal);
      zoomR.appendChild(makeResetBtn("zoom", () => {
        zoomSl.value = 100;
        zoomVal.textContent = "100%";
        window.amlBridge.setZoom(1);
      }));
      dBody.appendChild(makeRow("Zoom", zoomR, null, false));
      const toggle = _amlIOSToggle(
        prefs.hideUpsell !== false,
        (v) => window.amlBridge.setTweak("hideUpsell", v)
      );
      dBody.appendChild(makeRow("Hide upsell banners", toggle, null, false));
      const radioToggle = _amlIOSToggle(
        !!prefs.hideRadio,
        (v) => window.amlBridge.setTweak("hideRadio", v)
      );
      dBody.appendChild(makeRow("Hide Radio", radioToggle, "Remove Radio from the sidebar", true));
      return wrap;
    }
    async function _buildThemeSection(prefs) {
      const { wrap, body: thBody } = makeSection("Theme");
      const thInfo = await window.amlBridge.getThemeInfo().catch(() => ({ blurAvailable: false, themeMode: "accent", themePalette: null, themePresets: [], customCssPath: null, systemAccent: "#fc3c44", themeAppearance: "dark" }));
      const blurAvail = !!thInfo.blurAvailable;
      const st = {
        curMode: prefs.artThemeMode || thInfo.themeMode || (blurAvail ? "blur" : "accent"),
        curPalette: thInfo.themePalette,
        thPresets: thInfo.themePresets || [],
        curAppearance: thInfo.themeAppearance || "dark"
      };
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
          const fp = await window.amlBridge.importThemeCss();
          if (fp) {
            pathDiv.textContent = fp;
            thInfo.customCssPath = fp;
          }
        };
        const clearBtn = makeBtn("Clear");
        clearBtn.onclick = () => {
          window.amlBridge.setThemeMode("custom");
          pathDiv.textContent = "No file selected";
          thInfo.customCssPath = null;
        };
        const hint = document.createElement("div");
        hint.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.28);padding-top:4px;";
        hint.textContent = "See aml-custom.example.css in the project root for the template.";
        btnsRow.appendChild(browseBtn);
        btnsRow.appendChild(clearBtn);
        container.appendChild(btnsRow);
        container.appendChild(hint);
      }
      const thContentArea = document.createElement("div");
      function renderThemeContent(mode) {
        thContentArea.innerHTML = "";
        if (mode === "blur") {
          const info = document.createElement("div");
          info.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.4);padding:12px 0;";
          info.textContent = blurAvail ? "Wallpaper is blurred and shown behind the app. Adjust intensity with the Background blur slider above." : "Blur is only available on Hyprland and KDE. Your current desktop does not support it.";
          thContentArea.appendChild(info);
        } else if (mode === "art-blur") {
          const info = document.createElement("div");
          info.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.4);padding:12px 0;";
          info.textContent = "The currently playing track's artwork is blurred full-screen and tinted with its palette colours. Enable Album art theming above to activate.";
          thContentArea.appendChild(info);
        } else if (mode === "accent") {
          if (!st.curPalette) st.curPalette = _amlGenPalette(thInfo.systemAccent || "#fc3c44", st.curAppearance);
          _amlRenderPaletteEditor(thContentArea, thInfo, st);
        } else {
          renderCustomCss(thContentArea);
        }
      }
      const modeRow = document.createElement("div");
      modeRow.style.cssText = "padding:12px 0;border-bottom:0.5px solid rgba(255,255,255,0.07);";
      const modeSeg = document.createElement("div");
      modeSeg.style.cssText = "display:flex;background:rgba(255,255,255,0.06);border-radius:8px;padding:2px;gap:2px;";
      const thModes = [
        { label: "Blur", value: "blur", disabled: !blurAvail, tip: blurAvail ? "" : "Only on Hyprland / KDE" },
        { label: "Accent", value: "accent", disabled: false, tip: "" },
        { label: "Accented Blur", value: "art-blur", disabled: false, tip: "" },
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
          const prev = st.curMode;
          st.curMode = value;
          modeSeg.querySelectorAll("button").forEach((b, i) => {
            const a = thModes[i].value === st.curMode;
            b.style.background = a ? "rgba(255,255,255,0.18)" : "transparent";
            b.style.color = a ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.38)";
            b.style.fontWeight = a ? "500" : "";
          });
          if (value === "art-blur") {
            window.amlBridge.setThemeMode("accent");
            window.amlBridge.setTweak("artThemeMode", "art-blur");
            if (!artToggle._cb.checked) {
              artToggle._cb.checked = true;
              window.amlBridge.setTweak("artTheme", true);
              window.dispatchEvent(new CustomEvent("aml:art-theme", { detail: true }));
            }
          } else {
            window.amlBridge.setThemeMode(value);
            window.amlBridge.setTweak("artThemeMode", null);
            if (prev === "art-blur") {
              artToggle._cb.checked = false;
              window.amlBridge.setTweak("artTheme", false);
              window.dispatchEvent(new CustomEvent("aml:art-theme", { detail: false }));
            }
          }
          renderThemeContent(value);
        };
        modeSeg.appendChild(btn);
      });
      modeRow.appendChild(modeSeg);
      const artToggle = _amlIOSToggle(prefs.artTheme !== false, (v) => {
        window.amlBridge.setTweak("artTheme", v);
        window.dispatchEvent(new CustomEvent("aml:art-theme", { detail: v }));
      });
      thBody.appendChild(makeRow("Album art theming", artToggle, "Colour album and playlist pages with a palette from their artwork", false));
      thBody.appendChild(modeRow);
      thBody.appendChild(thContentArea);
      renderThemeContent(st.curMode);
      return wrap;
    }
    function _buildAudioSection(prefs, drmSignedIn) {
      const { wrap, body: aqBody } = makeSection("Audio Quality");
      if (!document.getElementById("aml-quality-dropdown-style")) {
        const ds = document.createElement("style");
        ds.id = "aml-quality-dropdown-style";
        ds.textContent = `
                .aml-qdrop-btn {
                    display:flex;align-items:center;justify-content:space-between;gap:8px;
                    padding:6px 10px 6px 12px;
                    background:rgba(255,255,255,0.10);
                    border:0.5px solid rgba(255,255,255,0.18);
                    border-radius:8px;cursor:pointer;
                    font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
                    font-size:11px;color:rgba(255,255,255,0.88);
                    transition:background 0.15s;user-select:none;white-space:nowrap;
                }
                .aml-qdrop-btn:hover { background:rgba(255,255,255,0.15); }
                .aml-qdrop-chevron { font-size:8px;color:rgba(255,255,255,0.45);flex-shrink:0; }
                .aml-qdrop-menu {
                    background:rgba(32,32,34,0.97);
                    border:0.5px solid rgba(255,255,255,0.12);
                    border-radius:10px;
                    box-shadow:0 8px 32px rgba(0,0,0,0.7),0 1px 0 rgba(255,255,255,0.06) inset;
                    backdrop-filter:blur(32px) saturate(1.8);
                    -webkit-backdrop-filter:blur(32px) saturate(1.8);
                    overflow:hidden;padding:4px 0;
                }
                .aml-qdrop-item {
                    display:flex;align-items:center;gap:0;
                    padding:0;cursor:pointer;
                    font-family:-apple-system,SF Pro Text,system-ui,sans-serif;
                    font-size:11px;color:rgba(255,255,255,0.88);
                    transition:background 0.1s;
                    border-radius:0;position:relative;white-space:nowrap;
                }
                .aml-qdrop-item:hover { background:rgba(255,255,255,0.07); }
                .aml-qdrop-accent {
                    width:3px;align-self:stretch;flex-shrink:0;
                    background:transparent;border-radius:0;
                    transition:background 0.15s;
                }
                .aml-qdrop-item.selected .aml-qdrop-accent { background:#fc3c44; }
                .aml-qdrop-item-label {
                    flex:1;padding:8px 16px 8px 10px;
                }
                .aml-qdrop-item.selected .aml-qdrop-item-label { color:#fff;font-weight:500; }
            `;
        document.head.appendChild(ds);
      }
      const losslessOn = drmSignedIn && prefs["lossless-enabled"] !== false;
      const qualityOpts = drmSignedIn ? [
        { value: "high-quality", label: "High Quality (AAC 256 kbps)" },
        { value: "lossless", label: "Lossless (ALAC up to 24-bit / 48 kHz)" },
        { value: "hi-res-lossless", label: "Hi-Res Lossless (ALAC up to 24-bit / 192 kHz)" }
      ] : [
        { value: "high-quality", label: "High Quality (AAC 256 kbps)" }
      ];
      const { wrap: sqWrap, setValue: setSQ } = _amlMakeQualityDropdown("streaming-quality", prefs, qualityOpts);
      if (!losslessOn) setSQ("high-quality");
      const sqResetBtn = _amlMiniBtn(() => {
        if (!drmSignedIn) return;
        if (!losslessToggle.querySelector("input")?.checked) {
          losslessToggle.querySelector("input").click();
        }
        setSQ("lossless");
        window.amlBridge?.setTweak("streaming-quality", "lossless");
        _streamingQuality = "lossless";
      });
      const sqInner = document.createElement("div");
      sqInner.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
      const sqQualityWrap = document.createElement("div");
      sqQualityWrap.style.cssText = "flex:1;display:flex;align-items:center;gap:8px;";
      sqQualityWrap.append(sqWrap);
      sqInner.append(sqQualityWrap, sqResetBtn);
      if (!drmSignedIn) {
        sqInner.style.opacity = "0.38";
        sqInner.style.pointerEvents = "none";
      }
      function _applyLosslessRowState(on) {
        sqQualityWrap.style.opacity = on ? "1" : "0.38";
        sqQualityWrap.style.pointerEvents = on ? "" : "none";
      }
      _applyLosslessRowState(losslessOn);
      const sqRow = makeRow(
        "Streaming",
        sqInner,
        drmSignedIn ? null : "Sign in to Engine Account to change streaming quality",
        true
      );
      let _onLosslessChange = null;
      const losslessToggle = _amlIOSToggle(losslessOn, (v) => {
        window.amlBridge?.setTweak("lossless-enabled", v);
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
      if (!drmSignedIn) {
        losslessToggle.style.opacity = "0.38";
        losslessToggle.style.pointerEvents = "none";
        losslessToggle.title = "Sign in to Engine Account to enable lossless";
      }
      aqBody.appendChild(makeRow(
        "Lossless Audio",
        losslessToggle,
        drmSignedIn ? "Stream lossless audio (ALAC) when available" : "Sign in to Engine Account to enable lossless",
        false
      ));
      aqBody.appendChild(sqRow);
      return { wrap, onLosslessChange: (fn) => {
        _onLosslessChange = fn;
      } };
    }
    async function _buildCacheSection(prefs) {
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
          window.amlBridge?.setPref("persistLimitMB", v);
          fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persistLimitMB: v }) }).catch(() => {
          });
        };
        const szResetBtn = _amlMiniBtn(() => {
          szSl.value = 500;
          szVal.textContent = "500 MB";
          window.amlBridge?.setPref("persistLimitMB", 500);
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
          window.amlBridge?.setPref("persistTTLDays", v);
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
        const ttlResetBtn = _amlMiniBtn(() => {
          ttlInp.value = 5;
          window.amlBridge?.setPref("persistTTLDays", 5);
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
        clearAudioSegBtn.title = "Clears cached AAC audio HLS segments (~/.cache/apple-music-linux/engine/segments/)";
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
      const mvToggle = _amlIOSToggle(mvEnabled, (v) => {
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
      const mvCapResetBtn = _amlMiniBtn(() => {
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
      const pwSubhead = document.createElement("div");
      pwSubhead.style.cssText = FF + "font-size:10px;font-weight:600;letter-spacing:0.06em;color:rgba(255,255,255,0.35);padding:14px 0 4px;text-transform:uppercase;border-top:0.5px solid rgba(255,255,255,0.1);margin-top:2px;";
      pwSubhead.textContent = "Pre-warm";
      cBody.appendChild(pwSubhead);
      const prewarm = cacheStats?.prewarm;
      const pwUsedMB = Math.round((prewarm?.sizeBytes ?? 0) / (1024 * 1024));
      const pwLimitMB = Math.round((prewarm?.limitBytes ?? 1024 * 1024 * 1024) / (1024 * 1024));
      const pwPct = pwLimitMB > 0 ? Math.min(100, Math.round(pwUsedMB / pwLimitMB * 100)) : 0;
      const pwBarWrap = document.createElement("div");
      pwBarWrap.style.cssText = "flex:1;";
      const pwBarBg = document.createElement("div");
      pwBarBg.style.cssText = "height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;";
      const pwBarFill = document.createElement("div");
      pwBarFill.style.cssText = `height:100%;width:${pwPct}%;background:#fc3c44;border-radius:2px;`;
      pwBarBg.appendChild(pwBarFill);
      const pwBarLabel = document.createElement("div");
      pwBarLabel.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.4);";
      pwBarLabel.textContent = `${pwUsedMB} MB / ${pwLimitMB} MB`;
      pwBarWrap.appendChild(pwBarBg);
      pwBarWrap.appendChild(pwBarLabel);
      cBody.appendChild(makeRow("Pre-warm buffer", pwBarWrap, "Next 2 tracks pre-loaded in memory", false));
      const pwSzVal = document.createElement("span");
      pwSzVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);min-width:62px;text-align:right;white-space:nowrap;flex-shrink:0;";
      pwSzVal.textContent = `${pwLimitMB} MB`;
      const pwSzSl = document.createElement("input");
      pwSzSl.type = "range";
      pwSzSl.min = 100;
      pwSzSl.max = 4096;
      pwSzSl.step = 128;
      pwSzSl.value = pwLimitMB;
      pwSzSl.style.cssText = "flex:1;accent-color:#fc3c44;";
      pwSzSl.oninput = () => {
        pwSzVal.textContent = `${pwSzSl.value} MB`;
      };
      pwSzSl.onchange = () => {
        const v = +pwSzSl.value;
        window.amlBridge?.setPref("prewarmLimitMB", v);
        fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prewarmLimitMB: v }) }).catch(() => {
        });
      };
      const pwSzResetBtn = _amlMiniBtn(() => {
        pwSzSl.value = 1024;
        pwSzVal.textContent = "1024 MB";
        window.amlBridge?.setPref("prewarmLimitMB", 1024);
        fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prewarmLimitMB: 1024 }) }).catch(() => {
        });
      });
      const pwSzRow = document.createElement("div");
      pwSzRow.style.cssText = "display:flex;align-items:center;flex:1;gap:8px;";
      pwSzRow.append(pwSzSl, pwSzVal, pwSzResetBtn);
      cBody.appendChild(makeRow("Pre-warm size limit", pwSzRow, null, true));
      const pwClearRow = document.createElement("div");
      pwClearRow.style.cssText = "padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);margin-top:2px;";
      const clearPrewarmBtn = makeBtn("Clear Pre-warm");
      clearPrewarmBtn.onclick = () => {
        fetch(`${ENGINE}/api/v1/cache/playback?what=prewarm`, { method: "DELETE" }).then(() => openSettings()).catch(() => {
        });
      };
      pwClearRow.appendChild(clearPrewarmBtn);
      cBody.appendChild(pwClearRow);
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
        inp.oninput = () => window.amlBridge?.setTweak(prefKey, inp.value);
        return inp;
      }
      function makeMarkerControl(prefKey, defaultVal) {
        const inp = makeMarkerInput(prefKey, defaultVal);
        const resetBtn = makeMiniBtn("", () => {
          inp.value = defaultVal;
          window.amlBridge?.setTweak(prefKey, defaultVal);
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
            window.amlBridge?.setTweak(prefKey, v);
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
        makeIOSToggle(!!prefs["use-songinfo-for-playlist"], (v) => window.amlBridge?.setTweak("use-songinfo-for-playlist", v)),
        "Use original album track number and album name instead of playlist position when downloading a playlist",
        true
      ));
    }
    function _buildDownloadsSection(prefs, tools, drmSignedIn) {
      const { wrap, body: dlBody } = makeSection("Downloads");
      function makeIOSToggle(on, onChange) {
        return _amlIOSToggle(on, onChange);
      }
      function makeMiniBtn(_, onClick) {
        return _amlMiniBtn(onClick);
      }
      function dlSubhead(text) {
        return _dlSubhead(text);
      }
      function dlDropdown(opts, val, onSave) {
        return _dlDropdown(opts, val, onSave);
      }
      const losslessAllowed = drmSignedIn && prefs["lossless-enabled"] !== false;
      const qualityOpts = losslessAllowed ? [
        { value: "high-quality", label: "High Quality (AAC 256 kbps)" },
        { value: "lossless", label: "Lossless (ALAC up to 24-bit / 48 kHz)" },
        { value: "hi-res-lossless", label: "Hi-Res Lossless (ALAC up to 24-bit / 192 kHz)" }
      ] : [
        { value: "high-quality", label: "High Quality (AAC 256 kbps)" }
      ];
      function makeQualityDropdown(prefKey) {
        return _amlMakeQualityDropdown(prefKey, prefs, qualityOpts);
      }
      let previewEl = null;
      function updatePreview() {
        if (!previewEl) return;
        const trackTmpl = prefs["dl-filename-track"] || "{track_number:02d} - {title}";
        const albumTmpl = prefs["dl-dirname-album"] || "{album_artist}/{year} - {album}";
        previewEl.textContent = _dlRenderTemplate(albumTmpl) + "/" + _dlRenderTemplate(trackTmpl) + ".m4a";
      }
      function makeTemplateRow(label, presets, savedValue, prefKey, suffix) {
        return _amlMakeTemplateRow(label, presets, savedValue, prefKey, suffix, prefs, updatePreview);
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
      const { wrap: dlQWrap, setValue: setDlQ } = _amlMakeQualityDropdown("dl-quality", prefs, fullQualityOpts);
      if (!losslessAllowed) setDlQ("high-quality");
      const dlQReset = makeMiniBtn("", () => {
        if (!_dlLosslessOn) return;
        setDlQ("lossless");
        window.amlBridge?.setTweak("dl-quality", "lossless");
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
        !drmSignedIn ? "Sign in to Engine Account to unlock lossless downloads" : null,
        true
      ));
      const ffmpegAvail = tools?.ffmpeg?.available === true;
      const ffmpegVersion = tools?.ffmpeg?.version ?? null;
      const ffmpegIndCtrl = document.createElement("div");
      ffmpegIndCtrl.style.cssText = "display:flex;align-items:center;gap:6px;";
      const ffmpegDot = document.createElement("span");
      ffmpegDot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${ffmpegAvail ? "#34c759" : "#ff3b30"};`;
      const ffmpegLabel = document.createElement("span");
      ffmpegLabel.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.7);";
      ffmpegLabel.textContent = ffmpegAvail ? ffmpegVersion || "Available" : "Not found";
      ffmpegIndCtrl.append(ffmpegDot, ffmpegLabel);
      dlBody.appendChild(makeRow(
        "FFmpeg",
        ffmpegIndCtrl,
        ffmpegAvail ? "Available for re-encoding" : "Install FFmpeg or set a custom path below",
        false
      ));
      const ffmpegToggle = makeIOSToggle(!!prefs["dl-ffmpeg-enabled"] && ffmpegAvail, (v) => window.amlBridge?.setTweak("dl-ffmpeg-enabled", v));
      if (!ffmpegAvail) {
        ffmpegToggle.style.opacity = "0.4";
        ffmpegToggle.title = "FFmpeg not found";
      }
      dlBody.appendChild(makeRow("Convert with FFmpeg", ffmpegToggle, "Re-encode downloaded files with FFmpeg", false));
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
        window.amlBridge?.setTweak("ffmpeg-path", ffmpegPathInp.value.trim());
      };
      const ffmpegPathRow = document.createElement("div");
      ffmpegPathRow.style.cssText = "display:flex;align-items:center;gap:6px;flex:1;";
      ffmpegPathRow.appendChild(ffmpegPathInp);
      dlBody.appendChild(makeRow("FFmpeg path", ffmpegPathRow, "Leave blank to use system PATH", false));
      const embedArtToggle = makeIOSToggle(prefs["dl-embed-art"] !== false, (v) => window.amlBridge?.setTweak("dl-embed-art", v));
      dlBody.appendChild(makeRow("Embed artwork", embedArtToggle, null, false));
      const motionArtToggle = makeIOSToggle(!!prefs["dl-motion-art"], (v) => window.amlBridge?.setTweak("dl-motion-art", v));
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
        window.amlBridge?.setTweak("dl-mv-quality", v);
      });
      if (!drmSignedIn) {
        mvResDd.style.opacity = "0.38";
        mvResDd.style.pointerEvents = "none";
      }
      dlBody.appendChild(makeRow(
        "Resolution",
        mvResDd,
        drmSignedIn ? null : "Sign in to Engine Account to enable MV downloads",
        false
      ));
      const ART_OPTS = [
        { value: "600", label: "600 \xD7 600" },
        { value: "1200", label: "1200 \xD7 1200" },
        { value: "3000", label: "3000 \xD7 3000" }
      ];
      const { wrap: artDd } = _dlDropdown(ART_OPTS, prefs["dl-artwork-size"] || "1200", (v) => window.amlBridge?.setTweak("dl-artwork-size", v));
      dlBody.appendChild(makeRow("Artwork size", artDd, null, false));
      dlBody.appendChild(_dlSubhead("Lyrics"));
      const lyricsToggle = makeIOSToggle(prefs["dl-lyrics"] !== false, (v) => window.amlBridge?.setTweak("dl-lyrics", v));
      dlBody.appendChild(makeRow("Embed lyrics", lyricsToggle, null, false));
      const timedLyricsToggle = makeIOSToggle(prefs["dl-timed-lyrics"] !== false, (v) => window.amlBridge?.setTweak("dl-timed-lyrics", v));
      dlBody.appendChild(makeRow("Timed lyrics (SYLT)", timedLyricsToggle, null, false));
      _buildContentMarkersRows(dlBody, prefs, makeRow, makeIOSToggle, makeMiniBtn);
      dlBody.appendChild(_dlSubhead("Queue"));
      dlBody.appendChild(makeRow(
        "Retry on fail",
        makeIOSToggle(prefs["retry-on-fail"] !== false, (v) => window.amlBridge?.setTweak("retry-on-fail", v)),
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
        (v) => window.amlBridge?.setTweak("retry-timeout", parseInt(v, 10))
      );
      dlBody.appendChild(makeRow("Retry after", retryToDd, null, false));
      return { wrap, applyLossless: applyDlLossless };
    }
    async function _buildPlaybackSection(prefs, drmSignedIn) {
      const { wrap, body } = makeSection("Playback");
      const resumeRaw = await window.amlBridge?.storeRead("resumeEnabled").catch(() => null);
      const resumeOn = resumeRaw !== "false" && resumeRaw !== false;
      const resumeToggle = _amlIOSToggle(resumeOn, async (v) => {
        _resumeEnabled = v;
        await window.amlBridge?.storeWrite("resumeEnabled", String(v)).catch(() => {
        });
        if (!v) _resumeClear();
      });
      body.appendChild(makeRow(
        "Resume on launch",
        resumeToggle,
        "Offer to restore your last queue and position on launch",
        false
      ));
      const scRaw = await window.amlBridge?.storeRead("soundCheckEnabled").catch(() => null);
      const scOn = scRaw === "true" || scRaw === true;
      const scToggle = _amlIOSToggle(scOn, async (v) => {
        await window.amlBridge?.storeWrite("soundCheckEnabled", String(v)).catch(() => {
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
      const gaplessToggle = _amlIOSToggle(gaplessOn, (v) => {
        _xfPreserveGapless = v;
        window.amlBridge?.setTweak("xf-preserve-gapless", v);
      });
      const gaplessRow = makeRow(
        "Keep albums gapless",
        gaplessToggle,
        "Skip crossfade between consecutive tracks of the same album",
        false
      );
      gaplessRow.style.paddingLeft = "14px";
      const stationOn = prefs?.["xf-station"] !== false;
      const stationToggle = _amlIOSToggle(stationOn, (v) => {
        _xfStationEnabled = v;
        window.amlBridge?.setTweak("xf-station", v);
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
      const { wrap: xfModeWrap } = _amlMakeQualityDropdown("crossfade-mode", { "crossfade-mode": xfModeInit }, [
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
      const discordRaw = await window.amlBridge?.storeRead("discordEnabled").catch(() => null);
      const discordOn = discordRaw === "true" || discordRaw === true;
      const discordToggle = _amlIOSToggle(discordOn, async (v) => {
        _discordEnabled = v;
        await window.amlBridge?.storeWrite("discordEnabled", String(v)).catch(() => {
        });
        if (v) _discordUpdateNow();
        else window.amlBridge?.discordDisable?.();
      });
      body.appendChild(makeRow(
        "Discord Rich Presence",
        discordToggle,
        "Show the current track on your Discord profile (requires a client ID in main.mjs)",
        false
      ));
      return { wrap };
    }
    function _buildShortcutsSection() {
      const { wrap, body } = makeSection("Keyboard Shortcuts");
      const enToggle = _amlIOSToggle(_hotkeysEnabled, async (v) => {
        _hotkeysEnabled = v;
        await window.amlBridge?.storeWrite("hotkeysEnabled", String(v)).catch(() => {
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
          window.amlBridge?.openExternal?.(a.getAttribute("href")) ?? window.open(a.getAttribute("href"));
        };
      });
      return n;
    }
    async function _buildScrobbleSection() {
      const { wrap, body } = makeSection("Scrobbling");
      body.appendChild(_scrobbleSubhead("Last.fm"));
      const lf = await window.amlBridge?.lastfmStatus().catch(() => null) ?? {};
      if (LASTFM_API_KEY && (!lf.apiKey || !lf.secretSet)) {
        await window.amlBridge?.lastfmSetCredentials({ apiKey: LASTFM_API_KEY, secret: LASTFM_API_SECRET }).catch(() => {
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
          await window.amlBridge?.lastfmDisconnect();
          _lastfmConnected = false;
          openSettings();
        };
        lfVal.appendChild(disc);
      };
      const lfDisconnected = () => {
        lfVal.innerHTML = "";
        const connect = makeBtn("Connect");
        connect.onclick = async () => {
          const r = await window.amlBridge?.lastfmAuth();
          if (r?.error) {
            connect.textContent = "Error \u2014 retry";
            return;
          }
          connect.textContent = "Finish connecting";
          connect.onclick = async () => {
            const s = await window.amlBridge?.lastfmSession(r.token);
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
      body.appendChild(makeRow("Account", lfVal, "Log in and authorize AML in the in-app Last.fm window", false));
      body.appendChild(_scrobbleSubhead("ListenBrainz"));
      const lb = await window.amlBridge?.lbStatus().catch(() => null) ?? {};
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
          await window.amlBridge?.lbDisconnect();
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
          await window.amlBridge?.lbSetToken(tok);
          const s = await window.amlBridge?.lbStatus();
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
      const histEnabledRaw = await window.amlBridge?.storeRead("historyEnabled").catch(() => null);
      const histIsEnabled = histEnabledRaw !== "false" && histEnabledRaw !== false;
      const histToggle = _amlIOSToggle(histIsEnabled, async (v) => {
        _histEnabled = v;
        await window.amlBridge?.storeWrite("historyEnabled", String(v)).catch(() => {
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
    function _buildDevSection(prefs) {
      const { wrap, body: devBody } = makeSection("Developer");
      const debugToggle = document.createElement("input");
      debugToggle.type = "checkbox";
      debugToggle.checked = !!prefs.debug;
      debugToggle.style.cssText = "width:16px;height:16px;accent-color:#fc3c44;cursor:pointer;";
      debugToggle.onchange = () => {
        window.amlBridge?.setPref("debug", debugToggle.checked);
      };
      devBody.appendChild(makeRow("Enable debug mode", debugToggle, "Opens DevTools and full console on next launch", true));
      return wrap;
    }
    let _settingsPreload = null;
    function _warmSettingsCache() {
      _settingsPreload = Promise.all([
        fetchDRM().catch(() => ({ state: {}, capabilities: {}, backend: {} })),
        fetch(`${ENGINE}/api/v1/tools`).then((r) => r.json()).catch(() => ({})),
        window.amlBridge.getPrefs().catch(() => ({}))
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
      closeBtn.id = "aml-settings-close";
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
      title.textContent = "AML Settings";
      title.style.cssText = FF + "font-size:15px;font-weight:600;margin:0;color:rgba(255,255,255,0.95);";
      const savedBadge = document.createElement("span");
      savedBadge.style.cssText = FF + "font-size:10px;color:#30d158;opacity:0;transition:opacity 0.3s;flex-shrink:0;";
      savedBadge.textContent = "\u2713 Saved";
      let _savedTimer = null;
      titleBar.append(title, savedBadge);
      dlg.appendChild(titleBar);
      const _bridge = window.amlBridge;
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
        dlg.classList.remove("aml-closing");
        dlg.classList.add("aml-opening");
        dlg.showModal();
        dlg.addEventListener("animationend", () => dlg.classList.remove("aml-opening"), { once: true });
      }
      const [drm, tools, prefs] = await (_settingsPreload ?? _warmSettingsCache());
      _warmSettingsCache();
      if (myGen !== _settingsGen) {
        _restoreProxy();
        return;
      }
      const drmState = drm?.state ?? drm ?? {};
      const drmSignedIn = drmState?.process === "running" && drmState?.session === "valid" || drmState?.authentication === "logged_in" || drmState?.fairplay === "ready" || drm?.capabilities?.cbcs === true;
      const [themeWrap, cacheWrap, { wrap: playbackWrap }, scrobbleWrap, historyWrap, libraryWrap] = await Promise.all([
        _buildThemeSection(prefs),
        _buildCacheSection(prefs),
        _buildPlaybackSection(prefs, drmSignedIn),
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
      const { wrap: audioWrap, onLosslessChange } = _buildAudioSection(prefs, drmSignedIn);
      dlg.appendChild(audioWrap);
      dlg.appendChild(cacheWrap);
      const { wrap: dlWrap, applyLossless: applyDlLossless } = _buildDownloadsSection(prefs, tools, drmSignedIn);
      dlg.appendChild(dlWrap);
      onLosslessChange(applyDlLossless);
      dlg.appendChild(playbackWrap);
      dlg.appendChild(_buildShortcutsSection().wrap);
      dlg.appendChild(scrobbleWrap);
      dlg.appendChild(historyWrap);
      dlg.appendChild(libraryWrap);
      dlg.appendChild(_buildDevSection(prefs));
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
      let cog = document.getElementById("aml-settings-cog");
      let dlBtn = document.getElementById("aml-downloads-btn");
      if (!cog) {
        cog = document.createElement("button");
        cog.id = "aml-settings-cog";
        cog.title = "AML Settings";
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
        dlBtn.id = "aml-downloads-btn";
        dlBtn.title = "Downloads";
        dlBtn.innerHTML = DOWNLOAD_SVG;
        _styleNavBtn(dlBtn);
        dlBtn.onclick = (e) => {
          e.stopPropagation();
          window.__amlToggleDownloads?.();
        };
        nav.appendChild(dlBtn);
      }
      _positionCogButtons(nav, accountRow, cog, dlBtn);
      if (!_cogResizeObs) {
        _cogResizeObs = new ResizeObserver(() => {
          const row = findAccountRow();
          const n = document.querySelector("nav.navigation") || document.querySelector("nav");
          const c = document.getElementById("aml-settings-cog");
          const d = document.getElementById("aml-downloads-btn");
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
    window.__amlOpenEngineSettings = openSettings;
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
      if (document.getElementById("aml-ctx-icons")) return;
      const li = (t) => `li.contextual-menu-item:has(button[title='${t}'])`;
      const con = (t) => `${li(t)} .contextual-menu-item__icon-container`;
      const svg = (t) => `${con(t)} > svg`;
      const PIN_TITLES = ["Pin Album", "Unpin Album", "Pin Music Video", "Unpin Music Video", "Pin Song", "Unpin Song", "Pin Playlist", "Unpin Playlist"];
      const TRASH_TITLES = ["Delete from Library", "Remove from Library"];
      const EMBED_TITLE = "Copy Embed Code";
      const ALL_CON = [...PIN_TITLES, ...TRASH_TITLES, EMBED_TITLE].map(con).join(",\n");
      const ALL_SVG = [...PIN_TITLES, ...TRASH_TITLES, EMBED_TITLE].map(svg).join(",\n");
      const EMBED_LI = li(EMBED_TITLE);
      const EMBED_CON = con(EMBED_TITLE);
      const s = document.createElement("style");
      s.id = "aml-ctx-icons";
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
      if (container._amlArmed) return;
      container._amlArmed = true;
      const inject = () => {
        if (container.querySelector("[data-aml]")) return;
        const span = document.createElement("span");
        span.setAttribute("data-aml", "1");
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
      let el = target;
      for (let i = 0; i < 25 && el && el !== document.body; i++) {
        const directHref = el.href || el.getAttribute?.("href") || "";
        if (directHref) {
          const info = _parseAMHref(directHref);
          if (info) return info;
        }
        const childLink = el.querySelector?.('a[href*="music.apple.com"]');
        if (childLink) {
          const info = _parseAMHref(childLink.href);
          if (info) return info;
        }
        el = el.parentElement;
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
        console.warn("[AML] startDownload: no track info");
        return;
      }
      const mk = window.MusicKit?.getInstance?.();
      const prefs = await window.amlBridge?.getPrefs().catch(() => ({})) || {};
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
        console.error("[AML] download error:", e);
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
      if (!menuRoot || menuRoot._amlSubmenuWired) return;
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
      menuRoot._amlSubmenuWired = true;
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
    if (!document.getElementById("aml-dl-kf")) {
      const _kfs = document.createElement("style");
      _kfs.id = "aml-dl-kf";
      _kfs.textContent = `
@keyframes aml-dl-pulse{0%,100%{opacity:0.55}50%{opacity:1}}
@keyframes aml-dl-dot{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes aml-dl-skel{0%{opacity:.4}50%{opacity:.8}100%{opacity:.4}}
.aml-dl-pill{display:inline-flex;align-items:center;padding:2px 7px;border-radius:20px;font-size:10px;font-weight:500;letter-spacing:0.1px;flex-shrink:0}
.aml-dl-pill-q{background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.38)}
.aml-dl-pill-r{background:rgba(255,214,10,0.13);color:rgba(255,210,80,0.85)}
.aml-dl-pill-dl{background:rgba(255,255,255,0.10);color:rgba(255,255,255,0.60)}
.aml-dl-pill-ok{background:rgba(48,209,88,0.14);color:#30d158}
.aml-dl-pill-err{background:rgba(255,69,58,0.15);color:#ff453a}
.aml-dl-pill-x{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.25)}
.aml-dl-skel-line{border-radius:3px;background:rgba(255,255,255,0.10);animation:aml-dl-skel 1.4s ease-in-out infinite}
.aml-dl-art-skel{background:linear-gradient(135deg,rgba(255,255,255,0.08) 0%,rgba(255,255,255,0.04) 100%);animation:aml-dl-skel 1.4s ease-in-out infinite}`;
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
    window.__amlToggleDownloads = () => {
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
      panel.id = "aml-downloads-panel";
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
      countBadge.id = "aml-dl-count";
      countBadge.style.cssText = "font-size:11px;color:rgba(255,255,255,0.30);font-weight:400;display:none;";
      titleGroup.append(title, countBadge);
      const btnGroup = document.createElement("div");
      btnGroup.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";
      const clearBtn = document.createElement("button");
      clearBtn.id = "aml-dl-cleardone";
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
      list.id = "aml-downloads-list";
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
      const list = document.getElementById("aml-downloads-list");
      if (!list) return;
      const countEl = document.getElementById("aml-dl-count");
      const clearEl = document.getElementById("aml-dl-cleardone");
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
      list.querySelectorAll("[data-job-id]").forEach((el) => {
        if (!newIds.has(el.dataset.jobId)) el.remove();
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
      queued: "aml-dl-pill aml-dl-pill-q",
      resolving: "aml-dl-pill aml-dl-pill-r",
      downloading: "aml-dl-pill aml-dl-pill-dl",
      tagging: "aml-dl-pill aml-dl-pill-dl",
      moving: "aml-dl-pill aml-dl-pill-dl",
      done: "aml-dl-pill aml-dl-pill-ok",
      failed: "aml-dl-pill aml-dl-pill-err",
      cancelled: "aml-dl-pill aml-dl-pill-x"
    };
    function buildJobRow(job) {
      const row = document.createElement("div");
      row.dataset.jobId = job.jobId;
      row.style.cssText = "padding:12px 16px;border-bottom:0.5px solid rgba(255,255,255,0.06);display:flex;gap:13px;align-items:flex-start;";
      const art = document.createElement("div");
      art.className = "aml-dl-art";
      art.style.cssText = "width:48px;height:48px;border-radius:9px;flex-shrink:0;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.5);margin-top:1px;";
      const artImg = document.createElement("img");
      artImg.style.cssText = "width:100%;height:100%;object-fit:cover;display:none;";
      art.appendChild(artImg);
      const artSkel = document.createElement("div");
      artSkel.className = "aml-dl-art-skel";
      artSkel.style.cssText = "width:100%;height:100%;";
      art.appendChild(artSkel);
      const col = document.createElement("div");
      col.className = "aml-dl-col";
      col.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:5px;";
      const titleRow = document.createElement("div");
      titleRow.style.cssText = "display:flex;align-items:center;gap:6px;";
      const name = document.createElement("span");
      name.className = "aml-dl-name";
      name.style.cssText = "flex:1;color:rgba(255,255,255,0.92);font-size:13px;font-weight:590;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-0.2px;";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "aml-dl-cancel";
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
      artist.className = "aml-dl-artist";
      artist.style.cssText = "color:rgba(255,255,255,0.40);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
      const pill = document.createElement("span");
      pill.className = "aml-dl-pill aml-dl-pill-q";
      metaRow.append(artist, pill);
      const progRow = document.createElement("div");
      progRow.className = "aml-dl-prog-row";
      progRow.style.cssText = "display:flex;align-items:center;gap:8px;";
      const bar = document.createElement("div");
      bar.style.cssText = "flex:1;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;";
      const fill = document.createElement("div");
      fill.className = "aml-dl-fill";
      fill.style.cssText = "height:100%;border-radius:2px;width:0%;transition:width 0.4s ease;background:rgba(255,255,255,0.85);";
      bar.appendChild(fill);
      const sizeLabel = document.createElement("span");
      sizeLabel.className = "aml-dl-size";
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
          name.style.cssText = "flex:1;height:11px;margin:1px 0;border-radius:3px;background:rgba(255,255,255,0.10);animation:aml-dl-skel 1.4s ease-in-out infinite;max-width:70%;";
        }
      }
      if (artist) {
        if (hasTitle) {
          artist.textContent = job.artistName || "";
          artist.style.cssText = "color:rgba(255,255,255,0.40);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;";
        } else {
          artist.textContent = "";
          artist.style.cssText = "flex:1;height:9px;margin:1px 0;border-radius:3px;background:rgba(255,255,255,0.07);animation:aml-dl-skel 1.4s ease-in-out infinite;max-width:45%;";
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
        fill.style.cssText = `height:100%;border-radius:2px;width:${pct2}%;transition:width 0.4s ease;background:${bg};animation:aml-dl-pulse 1.2s ease-in-out infinite;`;
      } else {
        fill.style.cssText = `height:100%;border-radius:2px;width:${pct2}%;transition:width 0.4s ease;background:${bg};animation:none;`;
      }
    }
    function _applyJobRetry(row, job, phase) {
      const col = row.querySelector(".aml-dl-col");
      let retryBtn = row.querySelector(".aml-dl-retry");
      let countdownEl = row.querySelector(".aml-dl-countdown");
      if (phase === "failed" || phase === "cancelled") {
        if (!retryBtn && col) {
          retryBtn = document.createElement("button");
          retryBtn.className = "aml-dl-retry";
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
            countdownEl.className = "aml-dl-countdown";
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
      const name = row.querySelector(".aml-dl-name");
      const artist = row.querySelector(".aml-dl-artist");
      const pill = row.querySelector(".aml-dl-pill");
      const fill = row.querySelector(".aml-dl-fill");
      const size = row.querySelector(".aml-dl-size");
      const artEl = row.querySelector(".aml-dl-art");
      const artImg = artEl?.querySelector("img");
      const artSkel = artEl?.querySelector(".aml-dl-art-skel");
      const cancelBtn = row.querySelector(".aml-dl-cancel");
      const progRow = row.querySelector(".aml-dl-prog-row");
      const phase = job.phase || "";
      const hasTitle = !!(job.title || job.output);
      const isTerminal = phase === "done" || phase === "failed" || phase === "cancelled";
      const isActive = phase === "downloading" || phase === "tagging" || phase === "moving" || phase === "resolving";
      _applyJobNameArtist(name, artist, hasTitle, job);
      if (pill) {
        pill.className = PILL_CLASS[phase] || "aml-dl-pill aml-dl-pill-q";
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
        _dlPrefs = await window.amlBridge?.getPrefs().catch(() => ({})) || {};
        if (seq === _pollSeq) renderJobs(Array.isArray(jobs) ? jobs : []);
      } catch (_) {
      }
    }
    function _tickCountdowns() {
      document.querySelectorAll(".aml-dl-countdown").forEach((el) => {
        const jobId = el.closest("[data-job-id]")?.dataset.jobId;
        if (!jobId) return;
        const entry = _failedAt.get(jobId);
        if (!entry) {
          el.textContent = "";
          return;
        }
        const secs = Math.max(0, Math.ceil((entry.deadline - Date.now()) / 1e3));
        el.textContent = secs > 0 ? `Auto-retry in ${secs}s` : "Retrying\u2026";
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
