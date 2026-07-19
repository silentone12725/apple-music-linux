const ENGINE = "http://127.0.0.1:20025";
const PLAY_COUNTS_KEY = "aml_play_counts";
const MAX_STORED_TRACKS = 200;
function getMUT() {
  const c = document.cookie.split(";").find((s) => s.trim().startsWith("media-user-token="));
  return c ? decodeURIComponent(c.trim().slice("media-user-token=".length)) : "";
}
function parseContentUrl(url) {
  const path = new URL(url, "https://music.apple.com").pathname;
  let m;
  if (m = path.match(/\/library\/playlists\/([^/?#]+)/)) {
    return { type: "library-playlist", id: m[1] };
  }
  if (m = path.match(/\/album\/(?:[^/]+\/)?([^/?#]+)/)) {
    return { type: "album", id: m[1] };
  }
  if (m = path.match(/\/playlist\/(?:[^/]+\/)?([^/?#]+)/)) {
    return { type: "playlist", id: m[1] };
  }
  return null;
}
function loadPlayCounts() {
  try {
    return JSON.parse(localStorage.getItem(PLAY_COUNTS_KEY) || "{}");
  } catch {
    return {};
  }
}
function savePlayCounts(counts) {
  const now = Date.now();
  const entries = Object.entries(counts);
  if (entries.length > MAX_STORED_TRACKS) {
    entries.sort(([, a], [, b]) => {
      const ageA = (now - (a.lastPlayed || 0)) / (1e3 * 3600 * 24 * 30);
      const ageB = (now - (b.lastPlayed || 0)) / (1e3 * 3600 * 24 * 30);
      const scoreA = a.count / (1 + ageA);
      const scoreB = b.count / (1 + ageB);
      return scoreB - scoreA;
    });
    counts = Object.fromEntries(entries.slice(0, MAX_STORED_TRACKS));
  }
  try {
    localStorage.setItem(PLAY_COUNTS_KEY, JSON.stringify(counts));
  } catch {
  }
}
class SmartCache {
  constructor() {
    this._jobs = {};
    this._counts = loadPlayCounts();
    const clearSlot = (ev) => {
      const jobId = ev.payload?.jobId;
      if (!jobId) return;
      for (const slot of Object.keys(this._jobs)) {
        if (this._jobs[slot] === jobId) {
          this._jobs[slot] = null;
          break;
        }
      }
    };
    window._amlEngine?.on("prefetch.done", clearSlot);
    window._amlEngine?.on("prefetch.cancelled", clearSlot);
  }
  // ── Context emission ───────────────────────────────────────────────────────
  async sendContext({ type, id, reason, slot, tracks, currentIndex, mk }) {
    const prevJobId = this._jobs[slot];
    if (prevJobId) {
      fetch(`${ENGINE}/api/v1/jobs/${prevJobId}`, { method: "DELETE" }).catch(() => {
      });
      this._jobs[slot] = null;
    }
    if (!tracks || tracks.length === 0) return;
    const sf = mk?.storefrontId ?? "us";
    const payload = {
      context: { type, id: id ?? null, reason },
      currentIndex: currentIndex ?? -1,
      tracks: tracks.map((t, i) => {
        const assetId = t?.id ?? t?.playParams?.id ?? t?.attributes?.playParams?.id;
        if (!assetId) return null;
        const entry = this._counts[assetId] ?? {};
        return {
          assetId,
          storefront: sf,
          metadata: {
            albumTrackIndex: t?.attributes?.trackNumber ?? i
          },
          signals: {
            favorite: t?.attributes?.loved ?? false,
            applePopularity: t?.attributes?.popularity ?? 0,
            playCount: entry.count ?? 0,
            lastPlayed: entry.lastPlayed ?? 0,
            queueDistance: currentIndex >= 0 ? Math.abs(i - currentIndex) : i
          }
        };
      }).filter(Boolean)
    };
    try {
      const resp = await fetch(`${ENGINE}/api/v1/playback/context`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (resp.ok) {
        const { jobId } = await resp.json();
        this._jobs[slot] = jobId;
        console.log(`[AML Cache] ${reason} \u2192 jobId=${jobId} slot=${slot} tracks=${payload.tracks.length}`);
      }
    } catch (e) {
      if (e.name !== "AbortError") console.warn("[AML Cache] sendContext:", e.message);
    }
  }
  // ── Playlist / album browse ────────────────────────────────────────────────
  // Called when user navigates to an album or editorial playlist page.
  // Fetches the track list from the engine catalog and sends album context.
  async onAlbumOpen(id, mk) {
    const sf = mk?.storefrontId ?? "us";
    try {
      const r = await fetch(`${ENGINE}/api/v1/catalog/albums/${id}?sf=${sf}`);
      if (!r.ok) return;
      const data = await r.json();
      const tracks = data?.data?.[0]?.relationships?.tracks?.data ?? data?.tracks ?? [];
      if (tracks.length === 0) return;
      await this.sendContext({
        type: "album",
        id,
        reason: "album-open",
        slot: "album",
        tracks,
        currentIndex: -1,
        mk
      });
    } catch (e) {
      console.warn("[AML Cache] onAlbumOpen:", e.message);
    }
  }
  async onPlaylistOpen(id, mk) {
    const sf = mk?.storefrontId ?? "us";
    try {
      const r = await fetch(`${ENGINE}/api/v1/catalog/playlists/${id}?sf=${sf}`);
      if (!r.ok) return;
      const data = await r.json();
      const tracks = data?.data?.[0]?.relationships?.tracks?.data ?? data?.tracks ?? [];
      if (tracks.length === 0) return;
      await this.sendContext({
        type: "playlist",
        id,
        reason: "playlist-open",
        slot: "playlist",
        tracks,
        currentIndex: -1,
        mk
      });
    } catch (e) {
      console.warn("[AML Cache] onPlaylistOpen:", e.message);
    }
  }
  // ── Queue lookahead ────────────────────────────────────────────────────────
  // Called from engine-playback.js on nowPlayingItemDidChange.
  // Warms the next 5 queue positions (engine decides actual count).
  async onTrackChange(mk) {
    const items = mk?.queue?.items ?? [];
    const pos = mk?.queue?.position ?? 0;
    if (items.length === 0) return;
    await this.sendContext({
      type: "queue",
      id: null,
      reason: "queue-change",
      slot: "queue",
      tracks: items,
      currentIndex: pos,
      mk
    });
  }
  // ── Play-count tracking ────────────────────────────────────────────────────
  recordPlay(trackId) {
    if (!trackId) return;
    const entry = this._counts[trackId] ?? { count: 0, lastPlayed: 0 };
    entry.count++;
    entry.lastPlayed = Date.now();
    this._counts[trackId] = entry;
    savePlayCounts(this._counts);
  }
  topPlayed(n) {
    return Object.entries(this._counts).sort(([, a], [, b]) => b.count - a.count).slice(0, n).map(([id]) => id);
  }
  // ── Startup warm ───────────────────────────────────────────────────────────
  // Warms top-10 most-played tracks immediately on app startup.
  async warmOnStartup(mk) {
    const ids = this.topPlayed(10);
    if (ids.length === 0) return;
    const tracks = ids.map((id) => ({ id }));
    await this.sendContext({
      type: "startup",
      id: null,
      reason: "startup",
      slot: "startup",
      tracks,
      currentIndex: -1,
      mk
    });
  }
  // ── Navigation observation ─────────────────────────────────────────────────
  // Monkey-patches history.pushState / replaceState and listens to popstate
  // so we detect SPA navigation without polling.
  observeNavigation(getMk) {
    const onNavigate = (url) => {
      const parsed = parseContentUrl(url);
      if (!parsed) return;
      const mk = getMk();
      if (!mk) return;
      if (parsed.type === "album") {
        this.onAlbumOpen(parsed.id, mk);
      } else if (parsed.type === "playlist") {
        this.onPlaylistOpen(parsed.id, mk);
      }
    };
    const wrap = (orig) => function(...args) {
      const rv = orig.apply(this, args);
      onNavigate(location.href);
      return rv;
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", () => onNavigate(location.href));
    onNavigate(location.href);
  }
}
window._amlSmartCache = new SmartCache();
