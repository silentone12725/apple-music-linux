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
async function pipeToSourceBuffer(sb, audio, streamUrlOrResp, signal, ms, durationSec, t0) {
  const localSessionId = _sessionId;
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
    const FORWARD_SECS = 900;
    const BACKWARD_SECS = 900;
    const evictPlayed = async (aggressiveSecs = BACKWARD_SECS) => {
      if (ms.readyState !== "open" || sb.buffered.length === 0) return;
      const evictEnd = Math.max(0, audio.currentTime - aggressiveSecs);
      if (evictEnd > sb.buffered.start(0) + 1) {
        await sbRemove(sb.buffered.start(0), evictEnd);
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
      if (ms.readyState !== "open" || audio.error) throw new Error("MediaSource closed or audio error");
      if (_chunkCache && _chunkCache.sessionId === localSessionId && _chunkCache.byteSize < 80 * 1024 * 1024) {
        const copy = new Uint8Array(value.byteLength);
        copy.set(value);
        _chunkCache.chunks.push(copy);
        _chunkCache.byteSize += value.byteLength;
      }
      if (sb.buffered.length > 0 && audio.currentTime > sb.buffered.start(0) + BACKWARD_SECS + 1) {
        await evictPlayed();
      }
      while (ms.readyState === "open" && sb.buffered.length > 0 && sb.buffered.end(sb.buffered.length - 1) - audio.currentTime > FORWARD_SECS) {
        if (signal.aborted) throw new Error("aborted");
        await new Promise((r) => setTimeout(r, 500));
      }
      await waitUpdate();
      if (sb.updating) await waitUpdate();
      if (signal.aborted) throw new Error("aborted");
      if (ms.readyState !== "open" || audio.error) throw new Error("MediaSource closed or audio error");
      try {
        sb.appendBuffer(value);
      } catch (e) {
        if (e.name === "QuotaExceededError") {
          let appended = false;
          for (let attempt = 0; !appended; attempt++) {
            await new Promise((r) => setTimeout(r, 300));
            if (signal.aborted) throw new Error("aborted");
            const fallbackSecs = attempt >= 2 ? 30 : BACKWARD_SECS;
            await evictPlayed(fallbackSecs);
            await waitUpdate();
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
    await waitUpdate();
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
    }
  } finally {
    reader.cancel().catch(() => {
    });
  }
}
async function seekToTime(seekSec, audio, sb, ms) {
  if (ms.readyState === "closed") return;
  const bufferedRanges = Array.from({ length: sb.buffered.length }, (_, i) => `[${sb.buffered.start(i).toFixed(1)},${sb.buffered.end(i).toFixed(1)}]`).join(" ");
  console.log(`[AML Engine] seekToTime(${seekSec.toFixed(2)}) ct=${audio.currentTime.toFixed(2)} buffered=${bufferedRanges || "(empty)"} seekable=${_seekable} seekTarget=${_seekTarget}`);
  for (let i = 0; i < sb.buffered.length; i++) {
    if (seekSec >= sb.buffered.start(i) - 1 && seekSec < sb.buffered.end(i) + 1) {
      console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s \u2192 native (buffered)`);
      _seekTarget = -Infinity;
      const wasPlaying2 = !audio.paused;
      audio.addEventListener("seeked", () => {
        if (wasPlaying2 && audio.paused) _nativePlay().catch(() => {
        });
      }, { once: true });
      return;
    }
  }
  if (_chunkCache && _chunkCache.sessionId === _sessionId && _chunkCache.chunks.length > 0) {
    if (Math.abs(_seekTarget - seekSec) < 0.5) {
      console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s \u2192 cache guard (in-progress)`);
      return;
    }
    _seekTarget = seekSec;
    const wasPlaying2 = !audio.paused;
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
    const pipeCtrl2 = _pipeCtrl;
    console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s \u2192 cache re-inject (${(cacheSnap.byteSize / 1e6).toFixed(1)} MB, ${cacheSnap.chunks.length} chunks)`);
    const waitSBIdleC = () => new Promise((res) => {
      if (!sb.updating) return res();
      sb.addEventListener("updateend", res, { once: true });
      sb.addEventListener("error", res, { once: true });
    });
    (async () => {
      try {
        await waitSBIdleC();
        if (pipeCtrl2.signal.aborted || ms.readyState !== "open") return;
        if (sb.buffered.length > 0) sb.remove(0, Infinity);
        await waitSBIdleC();
        for (const chunk of cacheSnap.chunks) {
          if (pipeCtrl2.signal.aborted) return;
          await waitSBIdleC();
          if (pipeCtrl2.signal.aborted || ms.readyState !== "open") return;
          try {
            sb.appendBuffer(chunk);
          } catch (e) {
            if (e.name === "QuotaExceededError") {
              console.warn("[AML Engine] Cache re-inject: quota exceeded, stopping");
            }
            return;
          }
        }
        if (pipeCtrl2.signal.aborted || _seekFetchCtrl !== mySC) return;
        await waitSBIdleC();
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
            console.log("[AML Engine] Cache re-inject: re-applied endOfStream");
          }
        } else if (_seekable && _activeStreamBase) {
          const bufEnd = sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : seekSec;
          console.log(`[AML Engine] Cache re-inject done \u2192 resuming engine from ${bufEnd.toFixed(2)}s`);
          let resumeResp;
          try {
            resumeResp = await fetch(`${_activeStreamBase}&t=${bufEnd.toFixed(3)}`, { signal: pipeCtrl2.signal });
          } catch (_) {
            return;
          }
          if (!resumeResp.ok || pipeCtrl2.signal.aborted || _seekFetchCtrl !== mySC) {
            resumeResp?.body?.cancel();
            return;
          }
          await pipeToSourceBuffer(sb, audio, resumeResp, pipeCtrl2.signal, ms, _durationSec, performance.now());
        }
      } catch (e) {
        if (!pipeCtrl2.signal.aborted) console.error("[AML Engine] Cache re-inject error:", e.message);
      }
    })();
    audio.addEventListener("canplay", () => {
      if (pipeCtrl2.signal.aborted) return;
      _seekTarget = -Infinity;
      if (wasPlaying2) _nativePlay().catch(() => {
      });
    }, { once: true });
    return;
  }
  if (!_seekable) {
    console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s \u2192 not seekable`);
    return;
  }
  if (_streamComplete) {
    console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s \u2192 completed-mode re-fetch`);
    _seekTarget = -Infinity;
    _streamComplete = false;
  }
  if (Math.abs(_seekTarget - seekSec) < 0.5) {
    console.log(`[AML Engine] Seek ${seekSec.toFixed(2)}s \u2192 guard (in-progress)`);
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
    const signals = [mySeekCtrl.signal];
    if (_abortCtrl?.signal) signals.push(_abortCtrl.signal);
    resp = await fetch(seekUrl, { signal: AbortSignal.any(signals) });
  } catch (e) {
    if (e.name !== "AbortError") console.warn("[AML Engine] Seek fetch error:", e.message);
    return;
  }
  if (!resp.ok) {
    console.warn(`[AML Engine] Seek not supported for this stream (${resp.status}) \u2014 seeking only within buffered range`);
    return;
  }
  if (_abortCtrl?.signal.aborted || _seekFetchCtrl !== mySeekCtrl) {
    resp.body?.cancel();
    return;
  }
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
    _seekTarget = -Infinity;
    const buf = sb.buffered;
    const bStart = buf.length > 0 ? buf.start(0).toFixed(2) : "?";
    const bEnd = buf.length > 0 ? buf.end(buf.length - 1).toFixed(2) : "?";
    console.log(
      `[AML Engine] Seek ready \u2014 requested=${seekSec.toFixed(2)}s actualStart=${actualStart.toFixed(2)}s buffered=[${bStart},${bEnd}] currentTime=${audio.currentTime.toFixed(2)}s readyState=${audio.readyState} networkState=${audio.networkState}`
    );
    if (wasPlaying) _nativePlay().catch((e) => console.warn("[AML Engine] seek play():", e));
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
    const queuePos = mk.queue?.position ?? 0;
    const queueTracks = (mk.queue?.items ?? []).map((t) => ({
      assetId: t.id ?? t.playParams?.id ?? t.attributes?.playParams?.id,
      storefront: mk.storefrontId ?? "us"
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
      _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
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
      _engineCaps = { lossless: !!(snap.capabilities.cbcs ?? snap.capabilities.alac ?? snap.capabilities.lossless), atmos: !!snap.capabilities.atmos };
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
    const r = await fetch(`${ENGINE}api/v1/drm/status`);
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
        await fetch(`${ENGINE}api/v1/drm/logout`, { method: "POST" }).catch(() => {
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
        const r = await fetch(`${ENGINE}api/v1/drm/authenticate`, {
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
    [
      { label: "Wrapper process", ok: s.process === "running", text: s.process ?? "unknown" },
      { label: "FairPlay", ok: s.fairplay === "ready", text: s.fairplay ?? "unknown" },
      {
        label: "Session",
        ok: s.session === "valid" || drm?.capabilities?.cbcs === true,
        text: s.session === "valid" ? "valid" : drm?.capabilities?.cbcs === true ? "active (cbcs)" : s.session ?? "unknown",
        subtitle: "Authentication lease with Apple servers"
      },
      { label: "Backend", text: drm.backend?.selected ?? "embedded", noDot: true }
    ].forEach(({ label, ok, text, subtitle, noDot }, i, arr) => {
      stBody.appendChild(makeRow(label, statusVal(text, noDot ? void 0 : ok), subtitle, i === arr.length - 1));
    });
    const refreshRow = document.createElement("div");
    refreshRow.style.cssText = "padding:10px 0;border-top:0.5px solid rgba(255,255,255,0.07);margin-top:2px;";
    const refreshBtn = makeBtn("Refresh");
    refreshBtn.onclick = () => openSettings();
    refreshRow.appendChild(refreshBtn);
    stBody.appendChild(refreshRow);
    dlg.appendChild(stWrap);
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
  (function nukeGradients() {
    function kill(el) {
      const cs = getComputedStyle(el);
      if ((cs.position === "absolute" || cs.position === "fixed") && cs.backgroundImage.includes("gradient") && !el.textContent.trim() && el.tagName !== "BUTTON") {
        el.style.setProperty("display", "none", "important");
      }
    }
    const scan = () => document.querySelectorAll("*").forEach(kill);
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  })();
})();
