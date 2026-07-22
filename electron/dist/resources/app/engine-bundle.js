var _amlEngine = (() => {
  const ENGINE = window._amlEngineURL || "http://127.0.0.1:20025";
  (() => {
    const _orig = console.log;
    console.log = (...args) => {
      if (typeof args[0] === "string" && args[0].includes("eventQueue overflow")) return;
      _orig.apply(console, args);
    };
  })();
  let _nativeSrcSet = null;
  let _nativePlay = null;
  let _ourBlobUrl = null;
  let _vlcMode = false;
  let _vlcPosMs = 0;
  let _vlcPaused = false;
  let _vlcPollTimer = null;
  let _vlcSeekTimer = null;
  let _vlcSeekFrozen = false;
  let _vlcSeekOffsetMs = 0;
  let _vlcRetryCount = 0;
  let _vlcPrevState = null;
  let _vlcLoading = false;
  let _seekBurstLog = 0;
  let _engineCaps = { lossless: false, atmos: false };
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
        console.log(`[AML VLC] audio.play() \u2192 resume`);
        _vlcPaused = false;
        const p = new Promise((resolve) => _resolvers.push(resolve));
        mkAudio.dispatchEvent(new Event("playing"));
        if (_vlcLoading) mkAudio.dispatchEvent(new Event("waiting"));
        fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
        });
        return p;
      }
      if (_sessionId) _nativePlay().catch(() => {
      });
      return new Promise(() => {
      });
    };
    console.log("[AML Engine] Play proxy installed");
  }
  function installMKSeekInterceptor(mk2) {
    if (mk2.__amlSeekIntercepted) return;
    mk2.__amlSeekIntercepted = true;
    const _origSeek = mk2.seekToTime.bind(mk2);
    mk2.seekToTime = async function(seekSec) {
      const audio = getMKAudio();
      if (_vlcMode) {
        _vlcPosMs = Math.round(seekSec * 1e3);
        _vlcSeekFrozen = true;
        console.log(`[AML VLC] seekToTime(${seekSec.toFixed(3)})  target=${_vlcPosMs}ms  debounce-reset`);
        if (audio) {
          audio.dispatchEvent(new Event("seeking"));
          audio.dispatchEvent(new Event("seeked"));
        }
        clearTimeout(_vlcSeekTimer);
        _vlcSeekTimer = setTimeout(async () => {
          _vlcSeekTimer = null;
          console.log(`[AML VLC] seek FIRE  posMs=${_vlcPosMs}`);
          getMKAudio()?.dispatchEvent(new Event("waiting"));
          const seekTarget = _vlcPosMs;
          let actualStartMs = seekTarget;
          try {
            const t0 = performance.now();
            const seekResp = await fetch(`${ENGINE}/api/v1/vlc/seek`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ posMs: seekTarget, sessionId: _sessionId })
            });
            const seekData = await seekResp.json().catch(() => ({}));
            actualStartMs = seekData.actualStartMs ?? seekTarget;
            console.log(`[AML VLC] seek DONE  target=${seekTarget}ms  actualStart=${actualStartMs}ms  rtt=${(performance.now() - t0).toFixed(0)}ms`);
            _vlcPosMs = actualStartMs;
          } catch (e) {
            console.warn(`[AML VLC] seek ERROR`, e);
          }
          _vlcSeekOffsetMs = actualStartMs;
          _vlcPrevState = null;
          _vlcSeekFrozen = false;
          _seekBurstLog = 15;
          console.log(`[AML VLC] seek UNFREEZE  offset=${_vlcSeekOffsetMs}ms`);
          window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1e3, seeked: true });
        }, 150);
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
          const mk2 = window.MusicKit?.getInstance?.();
          if (mk2 && "nowPlayingItem" in mk2) return resolve(mk2);
        } catch (_) {
        }
        setTimeout(check, 50);
      };
      check();
    });
  }
  function getMUT() {
    const c = document.cookie.split(";").find((s) => s.trim().startsWith("media-user-token="));
    return c ? decodeURIComponent(c.trim().slice("media-user-token=".length)) : "";
  }
  let _mkInstance = null;
  function bridgeDuration(mk2, durationSec) {
    _mkInstance = mk2;
    try {
      Object.defineProperty(mk2, "currentPlaybackDuration", {
        get: () => durationSec,
        configurable: true
      });
    } catch (_) {
    }
    const item = mk2.nowPlayingItem;
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
  let _currentAssetId = null;
  let _durationSec = 0;
  let _abortCtrl = null;
  let _generation = 0;
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
    _vlcPrevState = null;
    let _errCount = 0;
    let _tickCount = 0;
    let _vlcLengthSet = false;
    let _vlcFetching = false;
    _vlcPollTimer = setInterval(async () => {
      if (_vlcFetching) return;
      _vlcFetching = true;
      try {
        const r = await fetch(`${ENGINE}/api/v1/vlc/time`);
        if (!r.ok) return;
        _errCount = 0;
        const { posMs, lengthMs, state } = await r.json();
        if (!_vlcLengthSet && lengthMs > 0) {
          _vlcLengthSet = true;
          _durationSec = lengthMs / 1e3;
          bridgeDuration(mk, _durationSec);
        }
        const prevPos = _vlcPosMs;
        if (!_vlcSeekFrozen && posMs > 0) _vlcPosMs = _vlcSeekOffsetMs + posMs;
        if (_vlcPosMs !== prevPos) mkAudio.dispatchEvent(new Event("timeupdate"));
        if (++_tickCount % 4 === 0) {
          window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1e3 });
        }
        if (_seekBurstLog > 0) {
          _seekBurstLog--;
          console.log(`[AML VLC seek] tick posMs=${posMs} state=${state} offset=${_vlcSeekOffsetMs} pos=${_vlcPosMs} frozen=${_vlcSeekFrozen}`);
        } else if (_tickCount % 20 === 0) {
          console.log(`[AML VLC] pos=${posMs}ms state=${state}`);
        }
        if (state === _vlcPrevState) return;
        const prev = _vlcPrevState;
        _vlcPrevState = state;
        console.log(`[AML VLC] state: ${prev ?? "null"} \u2192 ${state}  posMs=${posMs}  frozen=${_vlcSeekFrozen}`);
        if (_vlcSeekFrozen) return;
        if (state === "playing") {
          _vlcPaused = false;
          _vlcLoading = false;
          if (prev !== "paused") mkAudio.dispatchEvent(new Event("playing"));
        }
        if (state === "paused") {
          _vlcPaused = true;
          mkAudio.dispatchEvent(new Event("pause"));
        }
        if (state === "ended" || state === "stopped" && (prev === "playing" || prev === "ended")) {
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
          const _mkInst = window.MusicKit?.getInstance?.();
          if (_mkInst) {
            console.log("[AML VLC] ended \u2192 skipToNextItem");
            let _advanced = false;
            const _clearAdvance = () => {
              _advanced = true;
              clearTimeout(_skipTimer);
            };
            _mkInst.addEventListener("nowPlayingItemDidChange", _clearAdvance, { once: true });
            const _skipTimer = setTimeout(() => {
              if (!_advanced) {
                console.warn("[AML VLC] skipToNextItem stalled \u2192 ended fallback");
                try {
                  delete mkAudio.load;
                } catch (_) {
                }
                mkAudio.dispatchEvent(new Event("ended"));
              }
            }, 3e3);
            _mkInst.skipToNextItem().catch((e) => {
              _clearAdvance();
              console.warn("[AML VLC] skipToNextItem failed:", e?.message, "\u2192 ended fallback");
              try {
                delete mkAudio.load;
              } catch (_) {
              }
              mkAudio.dispatchEvent(new Event("ended"));
            });
          } else {
            mkAudio.dispatchEvent(new Event("ended"));
          }
        }
      } catch (_) {
        if (++_errCount >= 5) stopVLCPoll();
      } finally {
        _vlcFetching = false;
      }
    }, 250);
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
  async function handleTrackChange(mk2) {
    const item = mk2.nowPlayingItem;
    if (!item) return;
    const myGen = ++_generation;
    if (_abortCtrl) {
      _abortCtrl.abort();
      _abortCtrl = null;
    }
    _ourBlobUrl = null;
    _vlcMode = false;
    _vlcPosMs = 0;
    _vlcPaused = false;
    _vlcSeekFrozen = false;
    _vlcRetryCount = 0;
    _vlcSeekOffsetMs = 0;
    _vlcPrevState = null;
    _vlcLoading = false;
    _seekBurstLog = 0;
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
    const adamId = item.playParams?.catalogId ?? item.attributes?.playParams?.catalogId ?? item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
    const sf = mk2.storefrontId ?? "us";
    if (!adamId) {
      console.warn("[AML Engine] No Adam ID");
      return;
    }
    _currentAssetId = adamId;
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
    await waitForLossless(800);
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
          token: mk2.developerToken ?? "",
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
      console.log(`[AML Engine] Session ${_sessionId} codec=${sess.codec} dur=${_durationSec.toFixed(1)}s +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);
      if (!mkAudio) throw new Error("MK audio element not found");
      _abortCtrl = new AbortController();
      const ctrl = _abortCtrl;
      showQualityBadge(sess.codec, sess.sampleRate, sess.bitDepth);
      bridgeDuration(mk2, _durationSec);
      const queuePos = mk2.queue?.position ?? 0;
      const queueTracks = (mk2.queue?.items ?? []).map((t) => ({
        assetId: t.id ?? t.playParams?.id ?? t.attributes?.playParams?.id,
        storefront: mk2.storefrontId ?? "us"
      })).filter((t) => t.assetId);
      if (queueTracks.length) {
        fetch(`${ENGINE}/api/v1/vlc/queue`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tracks: queueTracks, currentIndex: queuePos })
        }).catch(() => {
        });
      }
      _vlcMode = true;
      const _silentMs = new MediaSource();
      const _silentUrl = URL.createObjectURL(_silentMs);
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
        // seeks routed through mk.seekToTime interceptor
        configurable: true
      });
      const _volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
      let _vlcVolume = Math.round((_volDesc.get.call(mkAudio) ?? 1) * 100) || 100;
      let _vlcMuted = false;
      let _vlcPreMuteVol = _vlcVolume;
      const _postVlcVol = (vol) => fetch(`${ENGINE}/api/v1/vlc/volume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vol })
      }).catch(() => {});
      Object.defineProperty(mkAudio, "volume", {
        get: () => _vlcVolume / 100,
        set: (v) => {
          _vlcVolume = Math.max(0, Math.min(200, Math.round(v * 100)));
          if (_vlcVolume > 0) _vlcMuted = false;
          _postVlcVol(_vlcMuted ? 0 : _vlcVolume);
        },
        configurable: true
      });
      Object.defineProperty(mkAudio, "muted", {
        get: () => _vlcMuted,
        set: (v) => {
          _vlcMuted = !!v;
          if (_vlcMuted) { _vlcPreMuteVol = _vlcVolume || 100; _postVlcVol(0); }
          else { _vlcVolume = _vlcPreMuteVol; _postVlcVol(_vlcVolume); }
        },
        configurable: true
      });
      mkAudio.pause = () => {
        console.log(`[AML VLC] pause() \u2192 pause`);
        _vlcPaused = true;
        mkAudio.dispatchEvent(new Event("pause"));
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
        _vlcLoading = false;
        URL.revokeObjectURL(_silentUrl);
        delete mkAudio.paused;
        _vlcPaused = false;
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
    try {
      const msg = await window._amlEngine?.waitFor("engine.snapshot", 4e3);
      const snap = msg?.payload?.snapshot;
      const gen = msg?.meta?.generation ?? "?";
      const why = msg?.meta?.reason ?? "?";
      _snapshotEventId = msg?.meta?.id ?? -1;
      if (snap?.capabilities) {
        _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
      }
      console.log(`[AML Engine] Engine ready \u2014 drm.session=${snap?.drm?.session ?? "unknown"} lossless=${_engineCaps.lossless} gen=${gen} reason=${why} snapshotId=${_snapshotEventId}`);
    } catch (e) {
      console.warn("[AML Engine] Engine snapshot timeout:", e.message, "\u2014 continuing");
    }
    window.amlBridge?.getPrefs().then((p) => {
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
      }
      console.log(`[AML Engine] DRM state \u2192 session=${sess} lossless=${_engineCaps.lossless}`);
      if (!wasLossless && _engineCaps.lossless) _losslessWaitDone = false;
      if (snap?.challenge?.type === "credentials") {
        console.log("[AML Engine] DRM credential challenge \u2014 opening sign-in form");
        window.__amlOpenEngineSettings?.();
      }
    });
    const mk2 = await waitForMusicKit();
    console.log("[AML Engine] MusicKit ready");
    const _origMKPlay = mk2.play.bind(mk2);
    const _origMKPause = mk2.pause.bind(mk2);
    mk2.play = function() {
      if (_vlcMode) {
        console.log("[AML VLC] mk.play() \u2192 resume");
        _vlcPaused = false;
        fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
        });
      }
      return _origMKPlay().catch(() => {
      });
    };
    mk2.pause = function() {
      if (_vlcMode) {
        console.log("[AML VLC] mk.pause() \u2192 pause");
        _vlcPaused = true;
        getMKAudio()?.dispatchEvent(new Event("pause"));
        fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
        });
      }
      return _origMKPause();
    };
    installMKSeekInterceptor(mk2);
    function mprisTrackId(item) {
      const id = item?.id ?? item?.playParams?.id ?? item?.attributes?.playParams?.id ?? "unknown";
      return `/com/apple/music/track/${String(id).replace(/[^A-Za-z0-9_]/g, "_")}`;
    }
    function sendMprisMetadata(item) {
      if (!window.amlBridge?.mprisUpdate || !item) return;
      const a = item.attributes ?? {};
      const artTemplate = a.artwork?.url ?? "";
      const artUrl = artTemplate.replace("{w}", "500").replace("{h}", "500");
      window.amlBridge.mprisUpdate({
        metadata: {
          "mpris:trackid": mprisTrackId(item),
          "mpris:length": Math.round((a.durationInMillis ?? 0) * 1e3),
          "xesam:title": a.name ?? "",
          "xesam:artist": [a.artistName ?? ""],
          "xesam:album": a.albumName ?? "",
          "mpris:artUrl": artUrl
        }
      });
    }
    function sendMprisStatus(status, { isResume = false } = {}) {
      const seeked = isResume && status === "Playing" && _vlcPosMs > 0;
      window.amlBridge?.mprisUpdate?.({ status, position: _vlcPosMs * 1e3, seeked });
    }
    window.amlBridge?.onMprisCmd?.((cmd) => {
      if (cmd && typeof cmd === "object") {
        if (cmd.type === "seek") {
          mk2.seekToTime(Math.max(0, (_vlcPosMs + cmd.deltaMs) / 1e3));
        } else if (cmd.type === "setPosition") {
          mk2.seekToTime(Math.max(0, cmd.ms / 1e3));
        }
        return;
      }
      switch (cmd) {
        case "play":
          mk2.play().catch(() => {
          });
          break;
        case "pause":
          mk2.pause();
          break;
        case "playpause":
          mk2.playbackState === window.MusicKit?.PlaybackStates?.playing ? mk2.pause() : mk2.play().catch(() => {
          });
          break;
        case "next":
          mk2.skipToNextItem().catch(() => {
          });
          break;
        case "previous":
          mk2.skipToPreviousItem().catch(() => {
          });
          break;
      }
    });
    mk2.addEventListener("nowPlayingItemDidChange", () => {
      handleTrackChange(mk2);
      window._amlSmartCache?.onTrackChange(mk2);
      const item = mk2.nowPlayingItem;
      if (item) {
        const id = item.id ?? item.playParams?.id ?? item.attributes?.playParams?.id;
        window._amlSmartCache?.recordPlay(id);
        sendMprisMetadata(item);
      } else {
        sendMprisStatus("Stopped");
      }
    });
    mk2.addEventListener("playbackStateDidChange", () => {
      const PS = window.MusicKit?.PlaybackStates;
      console.log(`[AML Engine] state=${mk2.playbackState} (playing=${PS?.playing})`);
      const s = mk2.playbackState;
      if (s === PS?.playing) {
        if (!_vlcMode || _vlcPosMs > 0) sendMprisStatus("Playing", { isResume: _vlcPaused });
      } else if (s === PS?.paused) {
        sendMprisStatus("Paused");
      } else if (s === PS?.stopped || s === PS?.none) {
        sendMprisStatus("Stopped");
      }
      if (!_vlcMode) return;
      if (s === PS?.playing) {
        console.log("[AML VLC] playbackStateDidChange \u2192 playing \u2192 resume");
        _vlcPaused = false;
        fetch(`${ENGINE}/api/v1/vlc/resume`, { method: "POST" }).catch(() => {
        });
      } else if (s === PS?.paused) {
        console.log("[AML VLC] playbackStateDidChange \u2192 paused \u2192 pause");
        _vlcPaused = true;
        fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
        });
      }
    });
    const cache = window._amlSmartCache;
    if (cache) {
      cache.observeNavigation(() => mk2);
      cache.warmOnStartup(mk2);
    }
    if (mk2.nowPlayingItem) handleTrackChange(mk2);
  }
  setup().catch((e) => console.error("[AML Engine] setup:", e));
  window.addEventListener("unhandledrejection", (e) => {
    if (e.reason?.message?.includes("play() method was called without a previous")) {
      e.preventDefault();
    }
  });
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
    function buildAccountSection(drm, onRefresh) {
      const { wrap, body } = makeSection("Engine Account");
      const drmState = drm?.state ?? drm ?? {};
      const isSignedIn = drmState?.session === "valid" || drmState?.authentication === "logged_in" || drmState?.fairplay === "ready" || drm?.capabilities?.cbcs === true;
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
          const auth = status.state?.authentication;
          const session = status.state?.session;
          if (session === "valid" || auth === "logged_in" || status.state?.fairplay === "ready" || status.capabilities?.cbcs === true) {
            clearInterval(t);
            onRefresh();
            return;
          }
          if (auth === "challenging") {
            clearInterval(t);
            renderChallenge();
            return;
          }
          if (auth === "failed") {
            clearInterval(t);
            msgEl.textContent = status.message || "Authentication failed.";
            return;
          }
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
      return dlg;
    }
    function closeSettings() {
      const dlg = document.getElementById("aml-settings-dialog");
      if (!dlg?.open) return;
      dlg.classList.replace("aml-opening", "aml-closing") || dlg.classList.add("aml-closing");
      dlg.addEventListener("animationend", () => {
        dlg.classList.remove("aml-closing");
        dlg.close();
      }, { once: true });
    }
    async function openSettings() {
      const dlg = getDialog();
      dlg.innerHTML = "";
      const titleBar = document.createElement("div");
      titleBar.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:18px 0 4px;";
      const title = document.createElement("h1");
      title.textContent = "AML Settings";
      title.style.cssText = FF + "font-size:15px;font-weight:600;margin:0;color:rgba(255,255,255,0.95);";
      const closeBtn = document.createElement("button");
      closeBtn.textContent = "\u2715";
      closeBtn.style.cssText = FF + "background:rgba(255,255,255,0.1);border:none;border-radius:50%;width:22px;height:22px;cursor:pointer;color:rgba(255,255,255,0.55);font-size:11px;display:flex;align-items:center;justify-content:center;";
      closeBtn.onclick = closeSettings;
      titleBar.appendChild(title);
      titleBar.appendChild(closeBtn);
      dlg.appendChild(titleBar);
      const drm = await fetchDRM().catch(() => ({ state: {}, capabilities: {}, backend: {} }));
      const prefs = await window.amlBridge.getPrefs().catch(() => ({}));
      const s = drm.state ?? {};
      dlg.appendChild(buildAccountSection(drm, openSettings));
      const { wrap: stWrap, body: stBody } = makeSection("Engine Status");
      function spinner() {
        const s2 = document.createElement("span");
        s2.className = "_aml-spinner";
        return s2;
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
      dlg.appendChild(stWrap);
      const isResolved = (d) => {
        const st = d.state ?? {};
        return st.process === "running" && st.fairplay === "ready" && (st.session === "valid" || d?.capabilities?.cbcs === true);
      };
      if (!isResolved(drm)) {
        const poll = setInterval(async () => {
          if (!dlg.isConnected) {
            clearInterval(poll);
            return;
          }
          const d = await fetchDRM().catch(() => null);
          if (!d) return;
          renderStatusRows(d).forEach((row, i) => applyStatusRow(valEls[i].el, row));
          if (isResolved(d)) clearInterval(poll);
        }, 2e3);
      }
      const { wrap: dWrap, body: dBody } = makeSection("Display");
      const RST = FF + "border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.45);border-radius:4px;padding:2px 6px;font-size:11px;cursor:pointer;margin-left:6px;flex-shrink:0;";
      function makeResetBtn(label, onClick) {
        const b = document.createElement("button");
        b.title = `Reset ${label}`;
        b.textContent = "\u21BA";
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
      dBody.appendChild(makeRow("Background blur", bgBlurR, "Wallpaper blur behind the window", false));
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
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = prefs.hideUpsell !== false;
      toggle.style.cssText = "width:16px;height:16px;accent-color:#fc3c44;cursor:pointer;";
      toggle.onchange = () => window.amlBridge.setTweak("hideUpsell", toggle.checked);
      dBody.appendChild(makeRow("Hide upsell banners", toggle, null, true));
      dlg.appendChild(dWrap);
      const { wrap: thWrap, body: thBody } = makeSection("Theme");
      const thInfo = await window.amlBridge.getThemeInfo().catch(() => ({ blurAvailable: false, themeMode: "accent", themePalette: null, themePresets: [], customCssPath: null, systemAccent: "#fc3c44", themeAppearance: "dark" }));
      const blurAvail = !!thInfo.blurAvailable;
      let curMode = thInfo.themeMode || (blurAvail ? "blur" : "accent");
      let curPalette = thInfo.themePalette;
      let thPresets = thInfo.themePresets || [];
      let curAppearance = thInfo.themeAppearance || "dark";
      function genPalette(hex, appearance) {
        if (!appearance) appearance = curAppearance;
        hex = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#fc3c44";
        const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
        const d = mx - mn, s2 = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        let h = 0;
        if (d) {
          if (mx === r) h = ((g - b) / d + 6) % 6;
          else if (mx === g) h = (b - r) / d + 2;
          else h = (r - g) / d + 4;
          h *= 60;
        }
        const hi = Math.round(h), si = Math.round(s2 * 100);
        if (appearance === "light") {
          return { accent: hex, bgColor: `hsla(${hi},${Math.round(si * 0.25)}%,96%,1)`, navBg: `hsla(${hi},${Math.round(si * 0.3)}%,91%,0.95)`, navBorder: `hsla(${hi},${Math.round(si * 0.6)}%,30%,0.15)`, accentActive: `hsla(${hi},${si}%,45%,0.15)` };
        }
        return { accent: hex, bgColor: `hsla(${hi},${Math.round(si * 0.5)}%,10%,1)`, navBg: `hsla(${hi},${Math.round(si * 0.8)}%,14%,0.72)`, navBorder: `hsla(${hi},${Math.round(si * 0.7)}%,50%,0.25)`, accentActive: `hsla(${hi},${Math.round(si * 0.9)}%,60%,0.28)` };
      }
      function cssColorToHex(str) {
        if (/^#[0-9a-fA-F]{6}$/.test(str)) return str;
        const m = str.match(/hsla?\((\d+),\s*([\d.]+)%,\s*([\d.]+)%/);
        if (!m) return "#336699";
        const h = +m[1] / 360, s2 = +m[2] / 100, l = +m[3] / 100, a = s2 * Math.min(l, 1 - l);
        const f = (n) => {
          const k = (n + h * 12) % 12;
          return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        };
        return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
      }
      const modeRow = document.createElement("div");
      modeRow.style.cssText = "padding:12px 0;border-bottom:0.5px solid rgba(255,255,255,0.07);";
      const modeSeg = document.createElement("div");
      modeSeg.style.cssText = "display:flex;background:rgba(255,255,255,0.06);border-radius:8px;padding:2px;gap:2px;";
      const thModes = [
        { label: "Blur", value: "blur", disabled: !blurAvail, tip: blurAvail ? "" : "Only on Hyprland / KDE" },
        { label: "Accent", value: "accent", disabled: false, tip: "" },
        { label: "Custom CSS", value: "custom", disabled: false, tip: "" }
      ];
      const thContentArea = document.createElement("div");
      function renderThemeContent(mode) {
        thContentArea.innerHTML = "";
        if (mode === "blur") {
          const info = document.createElement("div");
          info.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.4);padding:12px 0;";
          info.textContent = blurAvail ? "Wallpaper is blurred and shown behind the app. Adjust intensity with the Background blur slider above." : "Blur is only available on Hyprland and KDE. Your current desktop does not support it.";
          thContentArea.appendChild(info);
        } else if (mode === "accent") {
          if (!curPalette) curPalette = genPalette(thInfo.systemAccent || "#fc3c44");
          renderPaletteEditor(thContentArea);
        } else {
          renderCustomCss(thContentArea);
        }
      }
      function renderPaletteEditor(container) {
        container.innerHTML = "";
        const pal = curPalette || genPalette(thInfo.systemAccent || "#fc3c44");
        const appRow = document.createElement("div");
        appRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 0 8px;";
        const appLabel = document.createElement("span");
        appLabel.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);flex:1;";
        appLabel.textContent = "Appearance";
        const appSeg = document.createElement("div");
        appSeg.style.cssText = "display:flex;background:rgba(255,255,255,0.06);border-radius:6px;padding:2px;gap:2px;";
        ["Dark", "Light"].forEach((label) => {
          const val = label.toLowerCase();
          const btn = document.createElement("button");
          btn.textContent = label;
          const activeStyle = "background:rgba(255,255,255,0.18);color:rgba(255,255,255,0.95);";
          const inactiveStyle = "background:transparent;color:rgba(255,255,255,0.4);";
          btn.style.cssText = `${FF}border:none;border-radius:5px;padding:3px 12px;font-size:12px;cursor:pointer;transition:all 0.15s;${curAppearance === val ? activeStyle : inactiveStyle}`;
          btn.onclick = async () => {
            curAppearance = val;
            window.amlBridge.setThemeAppearance(val);
            appSeg.querySelectorAll("button").forEach((b) => {
              b.style.background = "transparent";
              b.style.color = "rgba(255,255,255,0.4)";
            });
            btn.style.background = "rgba(255,255,255,0.18)";
            btn.style.color = "rgba(255,255,255,0.95)";
            const info = await window.amlBridge.getThemeInfo().catch(() => null);
            if (info?.themePalette) {
              curPalette = info.themePalette;
              renderPaletteEditor(container);
            }
          };
          appSeg.appendChild(btn);
        });
        appRow.appendChild(appLabel);
        appRow.appendChild(appSeg);
        container.appendChild(appRow);
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
          picker.value = cssColorToHex(pal[key] || "#336699");
          picker.style.cssText = "position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;";
          picker.oninput = () => {
            pal[key] = picker.value;
            swatchWrap.style.background = picker.value;
            curPalette = { ...pal };
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
            curPalette = newPal;
            renderPaletteEditor(container);
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
          if (!thPresets.length) {
            const none = document.createElement("span");
            none.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.25);";
            none.textContent = "No saved presets";
            presetList.appendChild(none);
            return;
          }
          thPresets.forEach(({ name, builtin }) => {
            const chip = document.createElement("div");
            chip.style.cssText = `display:flex;align-items:center;gap:4px;background:${builtin ? "rgba(252,60,68,0.18)" : "rgba(255,255,255,0.1)"};border-radius:20px;padding:3px 8px 3px 12px;cursor:default;${builtin ? "border:1px solid rgba(252,60,68,0.35);" : ""}`;
            const cl = document.createElement("span");
            cl.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.8);cursor:pointer;";
            cl.textContent = name;
            cl.onclick = () => {
              const pr = thPresets.find((x) => x.name === name);
              if (pr) {
                curPalette = pr.palette;
                window.amlBridge.applyThemePreset(name);
                renderPaletteEditor(container);
              }
            };
            chip.appendChild(cl);
            if (!builtin) {
              const del = document.createElement("button");
              del.textContent = "\xD7";
              del.style.cssText = "border:none;background:transparent;color:rgba(255,255,255,0.35);cursor:pointer;font-size:14px;padding:0 0 0 4px;line-height:1;";
              del.onclick = () => {
                thPresets = thPresets.filter((x) => x.name !== name);
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
        actRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding-bottom:12px;";
        const saveBtn = makeBtn("Save preset");
        saveBtn.onclick = async () => {
          const name = prompt("Preset name:");
          if (!name || !name.trim()) return;
          const newPresets = await window.amlBridge.saveThemePreset(name.trim());
          if (newPresets) {
            thPresets = newPresets;
            renderPresets();
          }
        };
        const exportBtn = makeBtn("Export");
        exportBtn.onclick = async () => {
          const name = prompt("Preset name to export (leave blank for current palette):") || "current";
          await window.amlBridge.exportThemePreset(name);
        };
        const importBtn = makeBtn("Import");
        importBtn.onclick = async () => {
          const preset = await window.amlBridge.importThemePreset();
          if (preset) {
            thPresets = thPresets.filter((x) => x.name !== preset.name);
            thPresets.push(preset);
            renderPresets();
          }
        };
        actRow.appendChild(saveBtn);
        actRow.appendChild(exportBtn);
        actRow.appendChild(importBtn);
        container.appendChild(actRow);
      }
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
          const p = loadPrefs?.() ?? {};
          p.customCssPath = null;
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
      thModes.forEach(({ label, value, disabled, tip }) => {
        const btn = document.createElement("button");
        btn.textContent = label;
        btn.disabled = disabled;
        if (tip) btn.title = tip;
        const isActive = value === curMode;
        btn.style.cssText = `flex:1;padding:5px 0;border:none;border-radius:6px;${FF}font-size:12px;cursor:${disabled ? "not-allowed" : "pointer"};transition:background .15s,color .15s;` + (isActive ? "background:rgba(255,255,255,0.18);color:rgba(255,255,255,0.88);font-weight:500;" : "background:transparent;color:rgba(255,255,255,0.38);") + (disabled ? "opacity:0.3;" : "");
        btn.onclick = () => {
          if (disabled) return;
          curMode = value;
          modeSeg.querySelectorAll("button").forEach((b, i) => {
            const a = thModes[i].value === curMode;
            b.style.background = a ? "rgba(255,255,255,0.18)" : "transparent";
            b.style.color = a ? "rgba(255,255,255,0.88)" : "rgba(255,255,255,0.38)";
            b.style.fontWeight = a ? "500" : "";
          });
          window.amlBridge.setThemeMode(value);
          renderThemeContent(value);
        };
        modeSeg.appendChild(btn);
      });
      modeRow.appendChild(modeSeg);
      thBody.appendChild(modeRow);
      thBody.appendChild(thContentArea);
      renderThemeContent(curMode);
      dlg.appendChild(thWrap);
      const { wrap: cWrap, body: cBody } = makeSection("Playback Cache");
      const cacheStats = await fetch(`${ENGINE}/api/v1/cache/stats`).then((r) => r.json()).catch(() => null);
      const persist = cacheStats?.persistent;
      if (persist?.available !== false) {
        const usedMB = Math.round((persist?.sizeBytes ?? 0) / (1024 * 1024));
        const limitMB = Math.round((persist?.limitBytes ?? 500 * 1024 * 1024) / (1024 * 1024));
        const ttlDays = persist?.ttlDays ?? 5;
        const pct = limitMB > 0 ? Math.min(100, Math.round(usedMB / limitMB * 100)) : 0;
        const barWrap = document.createElement("div");
        barWrap.style.cssText = "flex:1;";
        const barBg = document.createElement("div");
        barBg.style.cssText = "height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;";
        const barFill = document.createElement("div");
        barFill.style.cssText = `height:100%;width:${pct}%;background:#fc3c44;border-radius:2px;`;
        barBg.appendChild(barFill);
        const barLabel = document.createElement("div");
        barLabel.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.4);";
        barLabel.textContent = `${usedMB} MB / ${limitMB} MB`;
        barWrap.appendChild(barBg);
        barWrap.appendChild(barLabel);
        cBody.appendChild(makeRow("Song cache used", barWrap, "Frequently played songs cached to disk", false));
        const szVal = document.createElement("span");
        szVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:50px;text-align:right;";
        szVal.textContent = `${limitMB} MB`;
        const szSl = document.createElement("input");
        szSl.type = "range";
        szSl.min = 100;
        szSl.max = 1e4;
        szSl.step = 100;
        szSl.value = limitMB;
        szSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
        szSl.oninput = () => {
          szVal.textContent = `${szSl.value} MB`;
        };
        szSl.onchange = () => {
          const v = +szSl.value;
          window.amlBridge?.setPref("persistLimitMB", v);
          fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ persistLimitMB: v }) }).catch(() => {
          });
        };
        const szRow = document.createElement("div");
        szRow.style.cssText = "display:flex;align-items:center;flex:1;";
        szRow.appendChild(szSl);
        szRow.appendChild(szVal);
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
        cBody.appendChild(makeRow("Expiry", ttlWrap, "Songs unused longer than this are removed", false));
        const clearBtn = makeBtn("Clear Cache");
        clearBtn.onclick = () => {
          fetch(`${ENGINE}/api/v1/cache/playback`, { method: "DELETE" }).then(() => openSettings()).catch(() => {
          });
        };
        const clearRow = document.createElement("div");
        clearRow.style.cssText = "padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);margin-top:2px;";
        clearRow.appendChild(clearBtn);
        cBody.appendChild(clearRow);
      }
      const prewarm = cacheStats?.prewarm;
      const pwUsedMB = Math.round((prewarm?.sizeBytes ?? 0) / (1024 * 1024));
      const pwLimitMB = Math.round((prewarm?.limitBytes ?? 1024 * 1024 * 1024) / (1024 * 1024));
      const pwPct = pwLimitMB > 0 ? Math.min(100, Math.round(pwUsedMB / pwLimitMB * 100)) : 0;
      const pwBarWrap = document.createElement("div");
      pwBarWrap.style.cssText = "flex:1;";
      const pwBarBg = document.createElement("div");
      pwBarBg.style.cssText = "height:4px;background:rgba(255,255,255,0.12);border-radius:2px;overflow:hidden;margin-bottom:4px;";
      const pwBarFill = document.createElement("div");
      pwBarFill.style.cssText = `height:100%;width:${pwPct}%;background:#0a84ff;border-radius:2px;`;
      pwBarBg.appendChild(pwBarFill);
      const pwBarLabel = document.createElement("div");
      pwBarLabel.style.cssText = FF + "font-size:11px;color:rgba(255,255,255,0.4);";
      pwBarLabel.textContent = `${pwUsedMB} MB / ${pwLimitMB} MB`;
      pwBarWrap.appendChild(pwBarBg);
      pwBarWrap.appendChild(pwBarLabel);
      cBody.appendChild(makeRow("Pre-warm buffer", pwBarWrap, "Next 2 tracks pre-loaded in memory", false));
      const pwSzVal = document.createElement("span");
      pwSzVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:50px;text-align:right;";
      pwSzVal.textContent = `${pwLimitMB} MB`;
      const pwSzSl = document.createElement("input");
      pwSzSl.type = "range";
      pwSzSl.min = 100;
      pwSzSl.max = 4096;
      pwSzSl.step = 128;
      pwSzSl.value = pwLimitMB;
      pwSzSl.style.cssText = "flex:1;accent-color:#0a84ff;margin:0 10px;";
      pwSzSl.oninput = () => {
        pwSzVal.textContent = `${pwSzSl.value} MB`;
      };
      pwSzSl.onchange = () => {
        const v = +pwSzSl.value;
        window.amlBridge?.setPref("prewarmLimitMB", v);
        fetch(`${ENGINE}/api/v1/cache/config`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prewarmLimitMB: v }) }).catch(() => {
        });
      };
      const pwSzRow = document.createElement("div");
      pwSzRow.style.cssText = "display:flex;align-items:center;flex:1;";
      pwSzRow.appendChild(pwSzSl);
      pwSzRow.appendChild(pwSzVal);
      cBody.appendChild(makeRow("Pre-warm size limit", pwSzRow, null, true));
      dlg.appendChild(cWrap);
      const { wrap: devWrap, body: devBody } = makeSection("Developer");
      const debugToggle = document.createElement("input");
      debugToggle.type = "checkbox";
      debugToggle.checked = !!prefs.debug;
      debugToggle.style.cssText = "width:16px;height:16px;accent-color:#0a84ff;cursor:pointer;";
      debugToggle.onchange = () => {
        window.amlBridge?.setPref("debug", debugToggle.checked);
      };
      devBody.appendChild(makeRow("Enable debug mode", debugToggle, "Opens DevTools and full console on next launch", true));
      dlg.appendChild(devWrap);
      if (!dlg.open) {
        dlg.classList.remove("aml-closing");
        dlg.classList.add("aml-opening");
        dlg.showModal();
        dlg.addEventListener("animationend", () => dlg.classList.remove("aml-opening"), { once: true });
      }
    }
    const COG_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%" style="display:block;padding:17%"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.05-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>`;
    function findAccountRow() {
      return document.querySelector('nav.navigation [class*="account"]') || document.querySelector('nav.navigation [class*="Account"]') || document.querySelector('[class*="navigation-account"]') || document.querySelector('[class*="NavigationAccount"]') || document.querySelector('nav.navigation [aria-haspopup="true"]') || document.querySelector('nav.navigation [aria-haspopup="menu"]');
    }
    function mountSettingsCog() {
      if (document.getElementById("aml-settings-cog")) return;
      const accountRow = findAccountRow();
      if (!accountRow) return;
      const avatarEl = accountRow.querySelector('img, [class*="avatar"], [class*="Avatar"], [class*="profile"], [class*="Profile"]');
      const avatarSize = avatarEl ? Math.round(avatarEl.getBoundingClientRect().width) || 28 : 28;
      const sz = Math.max(avatarSize, 28) + "px";
      const cog = document.createElement("button");
      cog.id = "aml-settings-cog";
      cog.title = "AML Settings";
      cog.innerHTML = COG_SVG;
      cog.style.cssText = [
        "position:absolute",
        "right:10px",
        "top:50%",
        "transform:translateY(-50%)",
        "z-index:100",
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
        "box-sizing:border-box"
      ].join(";");
      cog.onmouseenter = () => {
        cog.style.background = "rgba(255,255,255,0.20)";
        cog.style.color = "rgba(255,255,255,0.9)";
      };
      cog.onmouseleave = () => {
        cog.style.background = "rgba(255,255,255,0.10)";
        cog.style.color = "rgba(255,255,255,0.55)";
      };
      cog.onclick = (e) => {
        e.stopPropagation();
        openSettings();
      };
      const parent = accountRow.closest('li, [class*="account"], [class*="Account"]') || accountRow;
      if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
      parent.appendChild(cog);
    }
    const cogWatcher = new MutationObserver(() => {
      if (findAccountRow() && !document.getElementById("aml-settings-cog")) mountSettingsCog();
    });
    if (findAccountRow()) mountSettingsCog();
    cogWatcher.observe(document.documentElement, { childList: true, subtree: true });
    window.__amlOpenEngineSettings = openSettings;
  })();
})();
