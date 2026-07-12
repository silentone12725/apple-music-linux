const ENGINE = "aml-engine:/";
let _nativeSrcSet = null;
let _nativePlay = null;
let _engineCaps = { lossless: false, atmos: false };
function blockAppleCDN() {
  if (window.__amlCDNBlocked) return;
  window.__amlCDNBlocked = true;
  const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
  _nativeSrcSet = desc.set;
  const isAppleCDN = (url) => url && !url.startsWith("blob:") && !url.startsWith("data:") && url !== "" && /mzstatic\.com|audio-ssl\.itunes\.apple\.com|akamaized\.net|cdn-apple\.com/i.test(url);
  Object.defineProperty(HTMLMediaElement.prototype, "src", {
    get: desc.get,
    set(val) {
      if (isAppleCDN(val)) {
        console.log("[AML Engine] Blocked CDN src:", val.slice(0, 80));
        return;
      }
      desc.set.call(this, val);
    },
    configurable: true,
    enumerable: desc.enumerable
  });
  const realSetAttr = HTMLMediaElement.prototype.setAttribute;
  HTMLMediaElement.prototype.setAttribute = function(name, val) {
    if (name === "src" && isAppleCDN(val)) return;
    return realSetAttr.call(this, name, val);
  };
  console.log("[AML Engine] Apple CDN audio blocked");
}
let _proxyInstalled = false;
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
    if (_sessionId && mkAudio.readyState >= 3) return _nativePlay();
    return new Promise(() => {
    });
  };
  console.log("[AML Engine] Play proxy installed");
}
function getMKAudio() {
  return document.getElementById("apple-music-player") || document.querySelector("audio") || null;
}
function getMKVideo() {
  for (const v of document.querySelectorAll("video")) {
    if (!v.closest(".editorial-video")) return v;
  }
  return null;
}
function waitForMKVideo(signal, timeoutMs = 1e4) {
  const immediate = getMKVideo();
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    const obs = new MutationObserver(() => {
      const el = getMKVideo();
      if (el) {
        obs.disconnect();
        resolve(el);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    signal.addEventListener("abort", () => {
      obs.disconnect();
      resolve(null);
    }, { once: true });
    setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}
function waitForMusicKit() {
  return new Promise((resolve) => {
    const check = () => {
      try {
        const mk = window.MusicKit?.getInstance?.();
        if (mk && "nowPlayingItem" in mk) return resolve(mk);
      } catch (_) {
      }
      setTimeout(check, 300);
    };
    check();
  });
}
function getMUT() {
  const c = document.cookie.split(";").find((s) => s.trim().startsWith("media-user-token="));
  return c ? decodeURIComponent(c.trim().slice("media-user-token=".length)) : "";
}
let _mkInstance = null;
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
let _sessionId = null;
let _durationSec = 0;
let _abortCtrl = null;
let _pipeCtrl = null;
let _generation = 0;
let _seekable = false;
let _activeSb = null;
let _activeMs = null;
let _activeStreamBase = "";
let _videoPipeCtrl = null;
function showQualityBadge(codec, sampleRate, bitDepth) {
  let badge = document.getElementById("aml-quality-badge");
  if (codec !== "alac") {
    if (badge) badge.style.display = "none";
    return;
  }
  const hiRes = sampleRate > 48e3 || bitDepth > 16;
  const text = hiRes ? `HI-RES LOSSLESS  \xB7  ${(sampleRate / 1e3).toFixed(0)} kHz / ${bitDepth}-bit` : "LOSSLESS";
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "aml-quality-badge";
    badge.style.cssText = 'font-size:8px;font-weight:700;letter-spacing:.07em;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:#30d158;border:1px solid #30d158;border-radius:3px;padding:1px 4px;pointer-events:none;z-index:9999;white-space:nowrap;';
    const lcd = document.querySelector(".player-lcd");
    if (lcd) {
      if (getComputedStyle(lcd).position === "static") lcd.style.position = "relative";
      badge.style.position = "absolute";
      badge.style.bottom = "3px";
      badge.style.left = "4px";
      lcd.appendChild(badge);
    } else {
      badge.style.position = "fixed";
      badge.style.bottom = "14px";
      badge.style.left = "50%";
      badge.style.transform = "translateX(-50%)";
      document.body.appendChild(badge);
    }
  }
  badge.textContent = text;
  badge.style.display = "";
}
function deleteSession(id) {
  if (id) fetch(`${ENGINE}/api/v1/playback/${id}`, { method: "DELETE" }).catch(() => {
  });
}
async function pipeToSourceBuffer(sb, audio, streamUrlOrResp, signal, ms, durationSec, t0) {
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
  const waitUpdate = () => new Promise((res, rej) => {
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
  const sbRemove = async (start, end) => {
    if (ms.readyState !== "open" || end <= start) return;
    await waitUpdate();
    if (ms.readyState !== "open") return;
    await new Promise((res, rej) => {
      sb.addEventListener("updateend", res, { once: true });
      sb.addEventListener("error", rej, { once: true });
      sb.remove(start, end);
    });
  };
  const evictPlayed = async () => {
    if (sb.buffered.length === 0) return;
    const ct = audio.currentTime;
    const bufStart = sb.buffered.start(0);
    const evictEnd = Math.max(0, ct - 30);
    if (evictEnd > bufStart + 1) {
      await sbRemove(bufStart, evictEnd);
    }
  };
  while (true) {
    if (signal.aborted) throw new Error("aborted");
    const { done, value } = await reader.read();
    if (done) {
      console.log(`[AML Engine] Stream done (${chunks} chunks) +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      break;
    }
    chunks++;
    await waitUpdate();
    if (sb.updating) await waitUpdate();
    try {
      sb.appendBuffer(value);
    } catch (e) {
      if (e.name === "QuotaExceededError") {
        await evictPlayed();
        await waitUpdate();
        sb.appendBuffer(value);
      } else {
        throw e;
      }
    }
  }
  await waitUpdate();
  if (ms.readyState === "open") {
    if (durationSec > 0) {
      try {
        ms.duration = durationSec;
      } catch (_) {
      }
    }
    ms.endOfStream();
    console.log(`[AML Engine] Stream complete +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
  }
}
async function seekToTime(seekSec, audio, sb, ms) {
  for (let i = 0; i < sb.buffered.length; i++) {
    if (seekSec >= sb.buffered.start(i) - 0.5 && seekSec < sb.buffered.end(i)) return;
  }
  if (!_seekable) return;
  const seekUrl = `${_activeStreamBase}&t=${seekSec.toFixed(3)}`;
  let resp;
  try {
    resp = await fetch(seekUrl, { signal: _abortCtrl?.signal });
  } catch (e) {
    if (e.name !== "AbortError") console.warn("[AML Engine] Seek fetch error:", e.message);
    return;
  }
  if (!resp.ok) {
    console.warn(`[AML Engine] Seek not supported for this stream (${resp.status}) \u2014 seeking only within buffered range`);
    return;
  }
  if (_abortCtrl?.signal.aborted) return;
  const actualStartHdr = resp.headers.get("X-Actual-Start");
  const actualStart = actualStartHdr ? parseFloat(actualStartHdr) : seekSec;
  console.log(`[AML Engine] Seek \u2192 ${seekSec.toFixed(2)}s (actual=${actualStart.toFixed(2)}s)`);
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
  _pipeCtrl = new AbortController();
  const pipeCtrl = _pipeCtrl;
  pipeToSourceBuffer(sb, audio, resp, pipeCtrl.signal, ms, _durationSec, performance.now()).catch((e) => {
    if (!pipeCtrl.signal.aborted) console.error("[AML Engine] Seek pipe error:", e.message);
  });
  audio.addEventListener("canplay", () => {
    if (pipeCtrl.signal.aborted) return;
    const buf = sb.buffered;
    const bStart = buf.length > 0 ? buf.start(0).toFixed(2) : "?";
    const bEnd = buf.length > 0 ? buf.end(buf.length - 1).toFixed(2) : "?";
    console.log(
      `[AML Engine] Seek ready \u2014 requested=${seekSec.toFixed(2)}s actualStart=${actualStart.toFixed(2)}s buffered=[${bStart},${bEnd}] currentTime=${audio.currentTime.toFixed(2)}s readyState=${audio.readyState} networkState=${audio.networkState}`
    );
    _nativePlay().catch((e) => console.warn("[AML Engine] seek play():", e));
  }, { once: true });
}
async function startMVVideoInjection(videoStreamPath, ctrl, mkAudio, t0) {
  const VIDEO_MIME = 'video/mp4; codecs="avc1.42E01E"';
  const videoEl = await waitForMKVideo(ctrl.signal, 1e4);
  if (!videoEl || ctrl.signal.aborted) {
    console.log("[AML Engine] MV: no video element found \u2014 video stream skipped");
    return;
  }
  console.log(`[AML Engine] MV: injecting video +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
  videoEl.muted = true;
  videoEl.defaultMuted = true;
  videoEl.load = () => {
  };
  const ms = new MediaSource();
  const blobUrl = URL.createObjectURL(ms);
  _nativeSrcSet.call(videoEl, blobUrl);
  delete videoEl.load;
  HTMLMediaElement.prototype.load.call(videoEl);
  videoEl.load = () => {
  };
  await new Promise((resolve, reject) => {
    ctrl.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    ms.addEventListener("sourceopen", resolve, { once: true });
  });
  URL.revokeObjectURL(blobUrl);
  const sb = ms.addSourceBuffer(VIDEO_MIME);
  _videoPipeCtrl = new AbortController();
  const pipeCtrl = _videoPipeCtrl;
  pipeToSourceBuffer(sb, videoEl, `${ENGINE}${videoStreamPath}?raw=1`, pipeCtrl.signal, ms, _durationSec, t0).catch((e) => {
    if (!pipeCtrl.signal.aborted) console.error("[AML Engine] Video pipe error:", e.message);
  });
  const onPlaying = () => videoEl.paused && videoEl.play().catch(() => {
  });
  const onPause = () => !videoEl.paused && videoEl.pause();
  const onSeeking = () => {
    videoEl.currentTime = mkAudio.currentTime;
  };
  mkAudio.addEventListener("playing", onPlaying);
  mkAudio.addEventListener("pause", onPause);
  mkAudio.addEventListener("seeking", onSeeking);
  ctrl.signal.addEventListener("abort", () => {
    mkAudio.removeEventListener("playing", onPlaying);
    mkAudio.removeEventListener("pause", onPause);
    mkAudio.removeEventListener("seeking", onSeeking);
    videoEl.pause();
    delete videoEl.load;
    if (_videoPipeCtrl) {
      _videoPipeCtrl.abort();
      _videoPipeCtrl = null;
    }
  }, { once: true });
  videoEl.addEventListener("canplay", () => {
    if (ctrl.signal.aborted) return;
    if (!mkAudio.paused) videoEl.play().catch(() => {
    });
  }, { once: true });
}
async function handleTrackChange(mk) {
  const item = mk.nowPlayingItem;
  if (!item) return;
  const myGen = ++_generation;
  if (_videoPipeCtrl) {
    _videoPipeCtrl.abort();
    _videoPipeCtrl = null;
  }
  if (_pipeCtrl) {
    _pipeCtrl.abort();
    _pipeCtrl = null;
  }
  if (_abortCtrl) {
    _abortCtrl.abort();
    _abortCtrl = null;
  }
  _activeSb = null;
  _activeMs = null;
  _activeStreamBase = "";
  unbridgeDuration();
  deleteSession(_sessionId);
  _sessionId = null;
  _durationSec = 0;
  _seekable = false;
  showQualityBadge(null);
  const adamId = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
  const sf = mk.storefrontId ?? "us";
  if (!adamId) {
    console.warn("[AML Engine] No Adam ID");
    return;
  }
  const isMV = item.type === "music-videos";
  const t0 = performance.now();
  console.log(`[AML Engine] \u2192 ${item.attributes?.name ?? adamId} (id=${adamId} sf=${sf})`);
  const mkAudio = getMKAudio();
  if (mkAudio) {
    mkAudio.pause();
    mkAudio.load = () => {
    };
    installPlayProxy(mkAudio);
  }
  try {
    const sessResp = await fetch(`${ENGINE}/api/v1/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assetId: adamId,
        storefront: sf,
        capabilities: {
          lossless: _engineCaps.lossless,
          video: isMV,
          atmos: false
        },
        token: mk.developerToken ?? "",
        mediaUserToken: getMUT()
      })
    });
    if (!sessResp.ok) throw new Error(`Session ${sessResp.status}: ${await sessResp.text()}`);
    const sess = await sessResp.json();
    if (myGen !== _generation) {
      deleteSession(sess.sessionId);
      return;
    }
    _sessionId = sess.sessionId;
    _durationSec = (sess.durationMs ?? 0) / 1e3;
    _seekable = sess.capabilities?.seekable ?? false;
    console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s seekable=${_seekable} +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
    showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);
    const needsTranscode = sess.codec === "alac" || sess.codec === "atmos";
    const audioPath = sess.streams?.audio ?? `/api/v1/playback/${_sessionId}/audio`;
    const streamBase = `${ENGINE}${audioPath}${needsTranscode ? "?transcode=aac" : "?raw=1"}`;
    const mime = 'audio/mp4; codecs="mp4a.40.2"';
    _abortCtrl = new AbortController();
    const ctrl = _abortCtrl;
    if (!mkAudio) throw new Error("MK audio element not found");
    const ms = new MediaSource();
    const blobUrl = URL.createObjectURL(ms);
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
    console.log(`[AML Engine] MSE sourceopen +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
    if (_durationSec > 0) {
      try {
        ms.duration = _durationSec;
      } catch (_) {
      }
    }
    const sb = ms.addSourceBuffer(mime);
    bridgeDuration(mk, _durationSec);
    sb.addEventListener("error", (e) => {
      console.error(`[AML Engine] SourceBuffer error readyState=${mkAudio.readyState} buffered.length=${sb.buffered.length}`, e);
    });
    mkAudio.addEventListener("loadedmetadata", function onMeta() {
      const snapToBuffer = (attempt) => {
        if (ctrl.signal.aborted) return;
        const blen = sb.buffered.length;
        if (blen > 0) {
          const bufStart = sb.buffered.start(0);
          if (bufStart > mkAudio.currentTime + 0.1) {
            mkAudio.currentTime = bufStart;
          }
        } else {
          sb.addEventListener("updateend", () => snapToBuffer(attempt + 1), { once: true });
        }
      };
      snapToBuffer(0);
    }, { once: true });
    _activeSb = sb;
    _activeMs = ms;
    _activeStreamBase = streamBase;
    _pipeCtrl = new AbortController();
    const pipeCtrl = _pipeCtrl;
    pipeToSourceBuffer(sb, mkAudio, streamBase, pipeCtrl.signal, ms, _durationSec, t0).catch((e) => {
      if (!pipeCtrl.signal.aborted) console.error("[AML Engine] MSE error:", e.message);
    });
    if (sess.type === "mv" && sess.streams?.video) {
      startMVVideoInjection(sess.streams.video, ctrl, mkAudio, t0).catch((e) => {
        if (!ctrl.signal.aborted) console.error("[AML Engine] MV video error:", e.message);
      });
    }
    const onSeeking = () => {
      if (ctrl.signal.aborted) return;
      seekToTime(mkAudio.currentTime, mkAudio, sb, ms);
    };
    const tryPlay = () => {
      console.log(`[AML Engine] tryPlay aborted=${ctrl.signal.aborted} readyState=${mkAudio.readyState} +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      if (ctrl.signal.aborted) return;
      console.log(`[AML Engine] canplay \u2192 play() +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      mkAudio.addEventListener("seeking", onSeeking);
      _nativePlay().catch((e) => console.warn("[AML Engine] play():", e));
    };
    if (mkAudio.readyState >= 3) {
      tryPlay();
    } else {
      mkAudio.addEventListener("canplay", tryPlay, { once: true });
    }
    ctrl.signal.addEventListener("abort", () => {
      mkAudio.removeEventListener("seeking", onSeeking);
      unbridgeDuration();
    }, { once: true });
  } catch (err) {
    if (!_abortCtrl?.signal.aborted) console.error("[AML Engine] Playback error:", err);
    if (mkAudio) delete mkAudio.load;
  }
}
async function setup() {
  if (window.__amlEngineMounted) return;
  window.__amlEngineMounted = true;
  blockAppleCDN();
  try {
    const msg = await window._amlEngine?.waitFor("engine.snapshot", 8e3);
    const snap = msg?.payload?.snapshot;
    const gen = msg?.meta?.generation ?? "?";
    const why = msg?.meta?.reason ?? "?";
    if (snap?.capabilities) {
      _engineCaps = { lossless: !!snap.capabilities.lossless, atmos: !!snap.capabilities.atmos };
    }
    console.log(`[AML Engine] Engine ready \u2014 drm.session=${snap?.drm?.session ?? "unknown"} lossless=${_engineCaps.lossless} gen=${gen} reason=${why}`);
  } catch (e) {
    console.warn("[AML Engine] Engine snapshot timeout:", e.message, "\u2014 continuing");
  }
  window._amlEngine?.on("drm", (snap) => {
    const sess = snap?.state?.session ?? "unknown";
    if (snap?.capabilities) {
      _engineCaps = { lossless: !!snap.capabilities.lossless, atmos: !!snap.capabilities.atmos };
    }
    console.log(`[AML Engine] DRM state \u2192 session=${sess} lossless=${_engineCaps.lossless}`);
  });
  const mk = await waitForMusicKit();
  console.log("[AML Engine] MusicKit ready");
  mk.addEventListener("nowPlayingItemDidChange", () => {
    handleTrackChange(mk);
    window._amlSmartCache?.onTrackChange(mk);
    const item = mk.nowPlayingItem;
    if (item) {
      const id = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
      window._amlSmartCache?.recordPlay(id);
    }
  });
  mk.addEventListener("playbackStateDidChange", () => {
    const PS = window.MusicKit?.PlaybackStates;
    console.log(`[AML Engine] state=${mk.playbackState} (playing=${PS?.playing})`);
  });
  const cache = window._amlSmartCache;
  if (cache) {
    cache.observeNavigation(() => mk);
    cache.warmOnStartup(mk);
  }
  if (mk.nowPlayingItem) handleTrackChange(mk);
}
setup().catch((e) => console.error("[AML Engine] setup:", e));
(function blockTitleTooltips() {
  const _sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    if (name === "title") return;
    return _sa.call(this, name, value);
  };
  const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "title");
  if (desc) {
    Object.defineProperty(HTMLElement.prototype, "title", {
      get: desc.get,
      set() {
      },
      configurable: true
    });
  }
  document.querySelectorAll("[title]").forEach((el) => el.removeAttribute("title"));
})();
(function clampSubmenus() {
  const PLAYER_BAR = 72;
  const PAD = 8;
  function clamp(el) {
    if (!el.isConnected) return;
    el.style.removeProperty("max-height");
    el.style.removeProperty("overflow-y");
    const rect = el.getBoundingClientRect();
    const limit = window.innerHeight - PLAYER_BAR - PAD;
    if (rect.bottom <= limit) return;
    const parent = el.parentElement;
    if (parent) {
      const overflow = rect.bottom - limit;
      const headroom = Math.max(0, rect.top - PAD);
      const shift = Math.min(overflow, headroom);
      if (shift > 0) {
        const curTop = parseFloat(parent.style.top) || 0;
        parent.style.top = curTop - shift + "px";
      }
    }
    const r2 = el.getBoundingClientRect();
    if (r2.bottom > limit) {
      const cap = Math.max(80, limit - r2.top);
      el.style.setProperty("max-height", cap + "px", "important");
      el.style.setProperty("overflow-y", "auto", "important");
    }
  }
  function clampAll() {
    document.querySelectorAll(
      "div.contextual-menu.contextual-menu--nested, div.contextual-menu.contextual-menu--in-submenu"
    ).forEach(clamp);
  }
  const bodyObs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const overlay = node.classList?.contains("contextual-menu__overlay") ? node : node.querySelector?.(".contextual-menu__overlay");
        if (!overlay) continue;
        const innerObs = new MutationObserver(() => setTimeout(clampAll, 0));
        innerObs.observe(overlay, { childList: true, subtree: true });
        const cleanupObs = new MutationObserver(() => {
          if (!overlay.isConnected) {
            innerObs.disconnect();
            cleanupObs.disconnect();
          }
        });
        cleanupObs.observe(document.body, { childList: true });
      }
    }
  });
  bodyObs.observe(document.body, { childList: true });
})();
