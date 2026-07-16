(() => {
  const ENGINE = "aml-engine:/";
  let _nativeSrcSet = null;
  let _nativePlay = null;
  let _ourBlobUrl = null;
  let _vlcMode = false;
  let _vlcPosMs = 0;
  let _vlcPollTimer = null;
  let _engineCaps = { lossless: false, atmos: false };
  let _flacSupported = false;
  let _losslessWaitDone = false;
  let _snapshotEventId = -1;
  function stubDRM() {
    if (window.__amlDRMStubbed) return;
    window.__amlDRMStubbed = true;
    const _origRMKSA = navigator.requestMediaKeySystemAccess?.bind(navigator);
    navigator.requestMediaKeySystemAccess = async function(keySystem, configs) {
      if (_origRMKSA) {
        try {
          return await _origRMKSA(keySystem, configs);
        } catch (_) {
        }
      }
      const fakeSession = {
        sessionId: "",
        expiration: NaN,
        closed: Promise.resolve(),
        keyStatuses: /* @__PURE__ */ new Map(),
        addEventListener: () => {
        },
        removeEventListener: () => {
        },
        dispatchEvent: () => false,
        generateRequest: async () => {
        },
        load: async () => false,
        update: async () => {
        },
        close: async () => {
        },
        remove: async () => {
        }
      };
      const fakeMediaKeys = {
        createSession: () => fakeSession,
        setServerCertificate: async () => true
      };
      return {
        keySystem,
        getConfiguration: () => configs && configs[0] || {},
        createMediaKeys: async () => fakeMediaKeys
      };
    };
    const _origSMK = HTMLMediaElement.prototype.setMediaKeys;
    HTMLMediaElement.prototype.setMediaKeys = async function(keys) {
      if (!keys) {
        try {
          return await _origSMK.call(this, null);
        } catch (_) {
        }
        return;
      }
      if (typeof MediaKeys !== "undefined" && keys instanceof MediaKeys) {
        return _origSMK.call(this, keys);
      }
    };
    console.log("[AML Engine] DRM stub installed");
  }
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
      if (_vlcMode) {
        fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
        });
      }
      if (_sessionId) _nativePlay().catch(() => {
      });
      return new Promise(() => {
      });
    };
    console.log("[AML Engine] Play proxy installed");
  }
  function installMKSeekInterceptor(mk) {
    if (mk.__amlSeekIntercepted) return;
    mk.__amlSeekIntercepted = true;
    const _origSeek = mk.seekToTime.bind(mk);
    const _nativeCTSet = window.__amlNativeCTSet || Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime")?.set;
    mk.seekToTime = async function(seekSec) {
      const audio = getMKAudio();
      if (_vlcMode) {
        _vlcPosMs = Math.round(seekSec * 1e3);
        if (audio) {
          audio.dispatchEvent(new Event("seeking"));
          audio.dispatchEvent(new Event("seeked"));
        }
        fetch(`${ENGINE}/api/v1/vlc/seek`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ posMs: _vlcPosMs })
        }).catch(() => {
        });
      } else if (audio && _nativeCTSet && _activeSb && _activeMs) {
        _ourSeekPending = true;
        _ourSeekTarget = seekSec;
        _nativeCTSet.call(audio, seekSec);
      } else {
        return _origSeek(seekSec).catch(() => {
        });
      }
    };
    console.log("[AML Engine] MK seek interceptor installed");
  }
  function getMKAudio() {
    return document.getElementById("apple-music-player") || document.querySelector("audio") || null;
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
  let _seekTarget = -Infinity;
  let _ourSeekPending = false;
  let _ourSeekTarget = -Infinity;
  let _streamComplete = false;
  let _seekFetchCtrl = null;
  let _chunkCache = null;
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
  function stopVLCPoll() {
    if (_vlcPollTimer) {
      clearInterval(_vlcPollTimer);
      _vlcPollTimer = null;
    }
  }
  function startVLCPoll(mkAudio) {
    stopVLCPoll();
    _vlcPollTimer = setInterval(async () => {
      try {
        const r = await fetch(`${ENGINE}/api/v1/vlc/time`);
        if (!r.ok) return;
        const { posMs, state } = await r.json();
        _vlcPosMs = posMs;
        mkAudio.dispatchEvent(new Event("timeupdate"));
        if (state === "ended") {
          stopVLCPoll();
          mkAudio.dispatchEvent(new Event("ended"));
        }
      } catch (_) {
      }
    }, 50);
  }
  function waitForLossless(timeoutMs) {
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
    _ourBlobUrl = null;
    _vlcMode = false;
    _vlcPosMs = 0;
    stopVLCPoll();
    unbridgeDuration();
    deleteSession(_sessionId);
    _sessionId = null;
    _durationSec = 0;
    _seekable = false;
    _seekTarget = -Infinity;
    _ourSeekPending = false;
    _ourSeekTarget = -Infinity;
    _streamComplete = false;
    if (_seekFetchCtrl) {
      _seekFetchCtrl.abort();
      _seekFetchCtrl = null;
    }
    _chunkCache = null;
    showQualityBadge(null);
    const adamId = item.playParams?.catalogId ?? item.attributes?.playParams?.catalogId ?? item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
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
      if (!mkAudio.paused) mkAudio.pause();
      mkAudio.load = () => {
      };
      installPlayProxy(mkAudio);
    }
    await waitForLossless(2500);
    if (myGen !== _generation) return;
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
      _chunkCache = { sessionId: _sessionId, chunks: [], byteSize: 0 };
      console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s seekable=${_seekable} +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);
      if (!mkAudio) throw new Error("MK audio element not found");
      _abortCtrl = new AbortController();
      const ctrl = _abortCtrl;
      showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);
      bridgeDuration(mk, _durationSec);
      _vlcMode = true;
      const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
      _nativeSrcSet.call(mkAudio, SILENT_WAV);
      mkAudio.loop = true;
      delete mkAudio.load;
      HTMLMediaElement.prototype.load.call(mkAudio);
      mkAudio.load = () => {
      };
      _vlcPosMs = 0;
      Object.defineProperty(mkAudio, "currentTime", {
        get: () => _vlcPosMs / 1e3,
        set: () => {
        },
        // seeks routed through mk.seekToTime interceptor
        configurable: true
      });
      const _volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
      let _vlcVolume = Math.round((_volDesc.get.call(mkAudio) ?? 1) * 100);
      Object.defineProperty(mkAudio, "volume", {
        get: () => _vlcVolume / 100,
        set: (v) => {
          _vlcVolume = Math.max(0, Math.min(200, Math.round(v * 100)));
          fetch(`${ENGINE}/api/v1/vlc/volume`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ vol: _vlcVolume })
          }).catch(() => {
          });
        },
        configurable: true
      });
      const _origPause = HTMLMediaElement.prototype.pause.bind(mkAudio);
      mkAudio.pause = () => {
        _origPause();
        fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
        });
      };
      const vlcResp = await fetch(`${ENGINE}/api/v1/vlc/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: _sessionId, startMs: 0 }),
        signal: ctrl.signal
      });
      if (!vlcResp.ok) throw new Error(`VLC load: ${await vlcResp.text()}`);
      if (ctrl.signal.aborted) return;
      mkAudio.addEventListener("canplay", () => {
        if (!ctrl.signal.aborted) _nativePlay().catch((e) => console.warn("[AML Engine] play():", e));
      }, { once: true });
      mkAudio.dispatchEvent(new Event("canplay"));
      startVLCPoll(mkAudio);
      console.log(`[AML Engine] VLC playing +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      ctrl.signal.addEventListener("abort", () => {
        unbridgeDuration();
        stopVLCPoll();
      }, { once: true });
    } catch (err) {
      if (!_abortCtrl?.signal.aborted) console.error("[AML Engine] Playback error:", err);
      if (mkAudio) delete mkAudio.load;
    }
  }
  async function setup() {
    if (window.__amlEngineMounted) return;
    window.__amlEngineMounted = true;
    stubDRM();
    blockAppleCDN();
    _flacSupported = MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
    console.log(`[AML Engine] FLAC MSE: ${_flacSupported ? "supported \u2014 lossless via FLAC transcode" : "not supported \u2014 will transcode to AAC"}`);
    try {
      const msg = await window._amlEngine?.waitFor("engine.snapshot", 8e3);
      const snap = msg?.payload?.snapshot;
      const gen = msg?.meta?.generation ?? "?";
      const why = msg?.meta?.reason ?? "?";
      _snapshotEventId = msg?.meta?.id ?? -1;
      if (snap?.capabilities) {
        _engineCaps = { lossless: !!snap.capabilities.lossless, atmos: !!snap.capabilities.atmos };
      }
      console.log(`[AML Engine] Engine ready \u2014 drm.session=${snap?.drm?.session ?? "unknown"} lossless=${_engineCaps.lossless} gen=${gen} reason=${why} snapshotId=${_snapshotEventId}`);
    } catch (e) {
      console.warn("[AML Engine] Engine snapshot timeout:", e.message, "\u2014 continuing");
    }
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
        _engineCaps = { lossless: !!(snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
      }
      console.log(`[AML Engine] DRM state \u2192 session=${sess} lossless=${_engineCaps.lossless}`);
      if (!wasLossless && _engineCaps.lossless) _losslessWaitDone = false;
    });
    const mk = await waitForMusicKit();
    console.log("[AML Engine] MusicKit ready");
    installMKSeekInterceptor(mk);
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
})();
