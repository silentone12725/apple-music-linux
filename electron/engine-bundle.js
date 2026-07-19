var __unused = (() => {
  const ENGINE = "http://127.0.0.1:20025";
  let _nativeSrcSet = null;
  let _nativePlay = null;
  let _ourBlobUrl = null;
  let _vlcMode = false;
  let _vlcPosMs = 0;
  let _vlcPaused = false;
  let _vlcPollTimer = null;
  let _vlcSeekTimer = null;
  let _vlcSeekFrozen = false;
  let _vlcRetryCount = 0;
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
          try {
            const t0 = performance.now();
            await fetch(`${ENGINE}/api/v1/vlc/seek`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ posMs: _vlcPosMs })
            });
            console.log(`[AML VLC] seek DONE  posMs=${_vlcPosMs}  rtt=${(performance.now() - t0).toFixed(0)}ms`);
          } catch (e) {
            console.warn(`[AML VLC] seek ERROR`, e);
          }
          _vlcSeekFrozen = false;
          console.log(`[AML VLC] seek UNFREEZE`);
          window.amlBridge?.mprisUpdate?.({ position: _vlcPosMs * 1e3, seeked: true });
          getMKAudio()?.dispatchEvent(new Event("playing"));
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
    let _prevState = null;
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
        if (!_vlcSeekFrozen) _vlcPosMs = posMs;
        if (_vlcPosMs !== prevPos) mkAudio.dispatchEvent(new Event("timeupdate"));
        if (++_tickCount % 4 === 0) {
          window.amlBridge?.mprisUpdate?.({ position: posMs * 1e3 });
        }
        if (_tickCount % 20 === 0) console.log(`[AML VLC] pos=${posMs}ms state=${state}`);
        if (state === _prevState) return;
        const prev = _prevState;
        _prevState = state;
        console.log(`[AML VLC] state: ${prev ?? "null"} \u2192 ${state}  posMs=${posMs}  frozen=${_vlcSeekFrozen}`);
        if (_vlcSeekFrozen) return;
        if (state === "playing") {
          _vlcPaused = false;
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
      mkAudio.pause = () => {
        console.log(`[AML VLC] pause() \u2192 pause`);
        _vlcPaused = true;
        mkAudio.dispatchEvent(new Event("pause"));
        fetch(`${ENGINE}/api/v1/vlc/pause`, { method: "POST" }).catch(() => {
        });
      };
      const vlcResp = await fetch(`${ENGINE}/api/v1/vlc/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: _sessionId, assetId: adamId, startMs: 0 }),
        signal: ctrl.signal
      });
      if (!vlcResp.ok) throw new Error(`VLC load: ${await vlcResp.text()}`);
      if (ctrl.signal.aborted) return;
      mkAudio.addEventListener("canplay", () => {
        if (!ctrl.signal.aborted) {
          _vlcPaused = false;
          mkAudio.dispatchEvent(new Event("playing"));
        }
      }, { once: true });
      mkAudio.dispatchEvent(new Event("canplay"));
      startVLCPoll(mkAudio);
      console.log(`[AML Engine] VLC playing +${((performance.now() - t0) / 1e3).toFixed(2)}s`);
      ctrl.signal.addEventListener("abort", () => {
        unbridgeDuration();
        stopVLCPoll();
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
    function sendMprisStatus(status) {
      const seeked = status === "Playing";
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
      if (s === PS?.playing) sendMprisStatus("Playing");
      else if (s === PS?.paused) sendMprisStatus("Paused");
      else if (s === PS?.stopped || s === PS?.none) sendMprisStatus("Stopped");
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
                backdrop-filter:blur(6px);
                -webkit-backdrop-filter:blur(6px);
            }
            #aml-settings-dialog::-webkit-scrollbar { width:4px; }
            #aml-settings-dialog::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.18);border-radius:2px; }
            @keyframes _aml-pop-in  { from{opacity:0;transform:scale(0.88)} to{opacity:1;transform:scale(1)} }
            @keyframes _aml-pop-out { from{opacity:1;transform:scale(1)}    to{opacity:0;transform:scale(0.88)} }
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
      function renderStatusRows(d) {
        const st = d.state ?? {};
        return [
          { label: "Wrapper process", ok: st.process === "running", text: st.process ?? "unknown" },
          { label: "FairPlay", ok: st.fairplay === "ready", text: st.fairplay ?? "unknown" },
          {
            label: "Session",
            ok: st.session === "valid" || d?.capabilities?.cbcs === true,
            text: st.session === "valid" ? "valid" : d?.capabilities?.cbcs === true ? "active (cbcs)" : st.session ?? "unknown",
            subtitle: "Authentication lease with Apple servers"
          },
          { label: "Backend", text: d.backend?.selected ?? "embedded", noDot: true }
        ];
      }
      const valEls = [];
      renderStatusRows(drm).forEach(({ label, ok, text, subtitle, noDot }, i, arr) => {
        const v = statusVal(text, noDot ? void 0 : ok);
        valEls.push({ el: v, noDot: !!noDot });
        stBody.appendChild(makeRow(label, v, subtitle, i === arr.length - 1));
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
          renderStatusRows(d).forEach(({ ok, text, noDot }, i) => {
            const v = valEls[i].el;
            v.innerHTML = "";
            if (!noDot) v.appendChild(dot(ok));
            v.appendChild(document.createTextNode(text));
          });
          if (isResolved(d)) clearInterval(poll);
        }, 2e3);
      }
      const { wrap: dWrap, body: dBody } = makeSection("Display");
      const blurVal = document.createElement("span");
      blurVal.style.cssText = FF + "font-size:12px;color:rgba(255,255,255,0.5);width:38px;text-align:right;";
      blurVal.textContent = `${prefs.glassBlur ?? 48}px`;
      const blurSl = document.createElement("input");
      blurSl.type = "range";
      blurSl.min = 0;
      blurSl.max = 80;
      blurSl.step = 4;
      blurSl.value = prefs.glassBlur ?? 48;
      blurSl.style.cssText = "flex:1;accent-color:#fc3c44;margin:0 10px;";
      blurSl.oninput = () => {
        blurVal.textContent = `${blurSl.value}px`;
        window.amlBridge.setGlassBlur(+blurSl.value);
      };
      const blurR = document.createElement("div");
      blurR.style.cssText = "display:flex;align-items:center;flex:1;";
      blurR.appendChild(blurSl);
      blurR.appendChild(blurVal);
      dBody.appendChild(makeRow("Background blur", blurR, null, false));
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
      dBody.appendChild(makeRow("Zoom", zoomR, null, false));
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = prefs.hideUpsell !== false;
      toggle.style.cssText = "width:16px;height:16px;accent-color:#fc3c44;cursor:pointer;";
      toggle.onchange = () => window.amlBridge.setTweak("hideUpsell", toggle.checked);
      dBody.appendChild(makeRow("Hide upsell banners", toggle, null, true));
      dlg.appendChild(dWrap);
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
      if (!dlg.open) {
        dlg.classList.remove("aml-closing");
        dlg.classList.add("aml-opening");
        dlg.showModal();
        dlg.addEventListener("animationend", () => dlg.classList.remove("aml-opening"), { once: true });
      }
    }
    function injectAMLMenuItem(list) {
      if (!list || list.querySelector("#aml-menu-item")) return;
      const isAccount = [...list.querySelectorAll(".contextual-menu-item__option-text")].some((el) => el.textContent.trim() === "Sign Out");
      if (!isAccount) return;
      const nativeLi = list.querySelector("li.contextual-menu-item");
      const nativeBtn = nativeLi?.querySelector("button");
      const li = document.createElement("li");
      li.id = "aml-menu-item";
      li.className = nativeLi?.className || "contextual-menu-item";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = nativeBtn?.className || "contextual-menu-item__option";
      btn.style.cssText = "width:100%;background:none;border:none;cursor:pointer;padding:0;color:inherit;font:inherit;text-align:left;";
      const wrapper = document.createElement("span");
      wrapper.className = "contextual-menu-item__option-wrapper";
      const text = document.createElement("span");
      text.className = "contextual-menu-item__option-text";
      text.textContent = "AML Settings";
      wrapper.appendChild(text);
      btn.appendChild(wrapper);
      li.appendChild(btn);
      btn.addEventListener("click", () => {
        document.querySelector(".account-menu--expanded .contextual-menu__trigger")?.click();
        openSettings();
      });
      const sep = document.createElement("li");
      sep.setAttribute("aria-hidden", "true");
      sep.style.cssText = "height:0.5px;background:rgba(255,255,255,0.12);margin:4px 8px;padding:0;list-style:none;pointer-events:none;";
      list.prepend(sep);
      list.prepend(li);
    }
    function tryInjectInOverlay(overlay) {
      const list = overlay.querySelector("ul.contextual-menu__list");
      if (list) {
        injectAMLMenuItem(list);
        return;
      }
      const obs = new MutationObserver(() => {
        const l = overlay.querySelector("ul.contextual-menu__list");
        if (l) {
          obs.disconnect();
          injectAMLMenuItem(l);
        }
      });
      obs.observe(overlay, { childList: true, subtree: true });
      setTimeout(() => obs.disconnect(), 3e3);
    }
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains("contextual-menu__overlay")) {
            tryInjectInOverlay(node);
          } else {
            const overlay = node.querySelector?.(".contextual-menu__overlay");
            if (overlay) tryInjectInOverlay(overlay);
          }
        }
      }
    }).observe(document.body, { childList: true });
    document.querySelectorAll(".contextual-menu__overlay").forEach(tryInjectInOverlay);
    window.__amlOpenEngineSettings = openSettings;
  })();
})();
