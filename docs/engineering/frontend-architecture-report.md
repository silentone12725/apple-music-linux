# Apple Music Linux Client — Frontend Architecture Engineering Report

**Date:** 2026-07-08  
**Scope:** Multi-platform investigation of Apple Music clients (Web/Android/Windows/Linux)  
**Purpose:** Inform frontend architecture and authentication/network layer decisions  
**Evidence quality labels:** VERIFIED (directly observed in source/binary) · INFERRED (logical deduction) · HYPOTHESIS (expected but unconfirmed)

---

## Executive Summary

**Recommended frontend: Flutter.** The existing `apple-music-linux` project is not adaptable — it has no custom UI; it is a webview wrapper around Apple's own SPA. Adapting it would mean discarding it entirely and building from scratch anyway.

**Recommended IPC:** Extend the existing REST + SSE model. The engine's current HTTP API is already the right design. Add catalog/library proxy endpoints to the engine so the Flutter UI never talks to Apple directly.

**MUT acquisition — SOLVED (2026-07-08):** The engine already obtains the MUT as part of the DRM auth flow. The wrapper's port 30020 returns `{"storefront_id":"…","dev_token":"…","music_token":"…"}`; `SessionManager.ReadMusicToken()` reads it from the `MUSIC_TOKEN` file; and both `ProcessBackend.GetAccount()` and `EmbeddedBackend.GetAccount()` expose it via `AccountInfo.MusicToken`. `APIServer` now exposes `mediaUserToken()` and `storefront()` accessor methods that read from the session as the canonical source, with `Config` as an override — no WebView login needed for MUT. See §2.3 and §2.6 for the updated flow.

**Three-phase migration:**
- Phase 1 (3–4 weeks): Flutter shell + playback only; DRM auth flow provides MUT; engine as-is
- Phase 2 (6–8 weeks): Catalog/library/search; extend engine with proxy endpoints  
- Phase 3 (4–6 weeks): MPRIS, notifications, download management, full polish

---

## Part 1 — Platform Investigation Summary

### 1.1 apple-music-linux (Reference Frontend)

**VERIFIED findings:**

This project is not a client in the traditional sense. It contains two independent implementations that share the same core trick: navigate a native browser (WebKitGTK or Electron/Chromium) to `https://music.apple.com`, and intercept the resulting session.

**Wails implementation** (`app.go`, `main.go`):
- Framework: Wails v2 (Go + WebKitGTK webview)
- The Go binary sets `BindingsAllowedOrigins: "https://music.apple.com"` and immediately navigates to `music.apple.com` from `OnDomReady`
- There is no custom UI layer. The "frontend" is Apple's own SPA.
- `frontend/src/preload.js` is injected via `runtime.WindowExecJS` every 3 seconds and polls `window.MusicKit.getInstance()` for playback state
- When a song plays and `music.playbackState === 2`, the preload calls `window.go.main.App.StartStreamPlayback(trackUrl)`, which spawns `apple-music-cli --stream <url>` as a subprocess
- The webview's MusicKit audio is muted (`music.player.volume = 0`) to avoid double playback
- `media-user-token` is extracted from `document.cookie` and stored in the OS keyring (`zalando/go-keyring`, service `"apple-music-linux"`)

**Electron implementation** (`electron/main.mjs`):
- More feature-complete: node-pty terminal, xterm.js UI for wrapper login, glass morphism effects
- Same core trick: `persist:apple-music` named partition auto-persists cookies
- Intercepts Apple ID OAuth popups via `setWindowOpenHandler` (redirecting to same window)
- `electron/wrapper.cjs`: manages `wrapper-rootless` process with node-pty, probes TCP port 10020 every 5s for health
- Glass effects via MutationObserver + canvas color sampling from album artwork

**What this project does NOT provide:**
- Any direct HTTP calls to `api.music.apple.com` or equivalent
- Any catalog browsing, search, or library APIs in Go/JS
- Any MusicKit developer token
- Any artwork, lyrics, or metadata pipeline in code
- Any playback position tracking, queue management, or seek support

**Portability assessment:** The Wails and Electron implementations are completely non-portable for a Flutter frontend. The only reusable knowledge is: (a) the `media-user-token` cookie extraction pattern, and (b) the wrapper port assignments (10020/20020/30020).

---

### 1.2 Engine (Existing API)

**VERIFIED — complete HTTP route table:**

| Method | Path | Auth? | Description |
|--------|------|-------|-------------|
| GET | `/api/v1/status` | No | Health check |
| GET | `/api/v1/capabilities` | No | Feature flags + DRM state summary |
| GET | `/api/v1/events` | No | SSE stream (DRM, export, playback events) |
| POST | `/api/v1/playback` | Yes | Create playback session |
| GET | `/api/v1/playback/{id}/audio` | No | Stream audio fMP4 (`?raw=1`, `?transcode=aac\|flac`) |
| GET | `/api/v1/playback/{id}/video` | No | Stream video fMP4 (music videos) |
| DELETE | `/api/v1/playback/{id}` | No | Release session |
| GET | `/api/v1/metadata/{id}` | No | Song/MV metadata + available stream list |
| GET | `/api/v1/artwork/{id}` | No | Artwork proxy (CDN → client, `?size=N`) |
| GET | `/api/v1/lyrics/{id}` | No | LRC or TTML lyrics (`?format=lrc\|ttml`) |
| POST | `/api/v1/export` | Yes | Queue download job |
| GET | `/api/v1/export` | No | List all export jobs |
| GET | `/api/v1/export/{id}` | No | Single job status |
| DELETE | `/api/v1/export/{id}` | No | Cancel job |
| POST | `/api/v1/export/{id}/retry` | No | Retry failed job |
| GET | `/api/v1/drm/status` | No | Full DRM state snapshot |
| POST | `/api/v1/drm/authenticate` | No | Start Apple ID login (async) |
| POST | `/api/v1/drm/challenge` | No | Submit 2FA / device approval code |
| POST | `/api/v1/drm/logout` | No | Stop backend, clear session |
| DELETE | `/api/v1/drm/session` | No | Clear on-disk session files |
| GET | `/api/v1/debug/runtime` | No | Go runtime metrics |
| GET | `/debug/pprof/*` | No | pprof profiles |

**Auth requirement:** POST /api/v1/playback and POST /api/v1/export require both a bearer token (auto-fetched at startup) and a non-empty MUT (from session or config override). `checkAuth` uses `s.mediaUserToken()` which reads the session file when `Config.MediaUserToken` is not set. Otherwise returns 401.

**SSE event types:**
- `drm` — DRM state machine transitions (authentication, fairplay, session, recovery states)
- `export` — export job phase transitions and progress percent
- `playback.created` — emitted after POST /api/v1/playback succeeds

**What the engine does NOT implement** (confirmed absent, not just undocumented):
- Catalog search, browse
- Library songs/albums/artists/playlists (user library)
- Recommendations / For You / Recently Played
- User profile, storefront detection (storefront auto-read from session via `s.storefront()` — see §2.3)
- Queue management (`capabilities.queue == false`)
- Playback position, seek, repeat, shuffle
- MUT acquisition: ~~not implemented~~ **SOLVED** — DRM auth flow writes `MUSIC_TOKEN`; `s.mediaUserToken()` accessor reads it from session (§2.3)
- Radio / live stations (`capabilities.radio == false`)
- Notifications
- Download management UI (export API exists; no library management)

---

### 1.3 Android (com.apple.android.music 6.5.0-beta)

**VERIFIED from DEX string analysis + native library inspection:**

**Auth stack (layered):**

| Layer | Component | Role |
|-------|-----------|------|
| Machine provisioning | CoreADI (`libCoreADI.so`, `libstoreapi.so` `ADIInterface`) | Anisette V3 OTP generation; produces `X-Apple-I-MD` + `X-Apple-I-MD-M` per request |
| Apple ID login | GrandSlam SRP (`libAMSKit.so` `AMSCore::IdMS::SRPAuthenticateTask`) | Password auth via `gsa.apple.com/grandslam/GsService2/lookup` (SRP-6a); yields IDMS token |
| Session keepalive | `AMSCore::IdMS::HeartbeatTask` | Refreshes `idmsHeartbeatToken` |
| Music access | `AMSCore::NetworkMediaTokenProvider` (`libAMSKit.so`) | Fetches `media-user-token` from `bag://sf-api-token-service-url`; has independent issue/expiry dates |
| Store request signing | Mescal (`IMescalProvider`) | Signs store HTTP requests; produces `X-Apple-MD`, `X-Apple-MD-M`, `X-Apple-AMD*` headers |
| FairPlay (DRM) | FPDI (`libFPDIFor3P.so`, `libstoreapi.so`) | Signs DRM license challenges; produces `X-Apple-FPDISignature` |

**Key confirmed API endpoints:**
```
amp-api.music.apple.com/v1/catalog/{storefront}/...
amp-api.music.apple.com/v1/me/library/{albums,songs,artists,playlists}
amp-api.music.apple.com/v1/me/recommendations
amp-api.music.apple.com/v1/me/recent/played
amp-api.music.apple.com/v1/me/recent/radio-stations
amp-api.music.apple.com/v1/me/storefront
amp-api.music.apple.com/v1/me/social/profile
amp-api.music.apple.com/v1/intelligence/playlists/ideas    (AI playlists, 6.x+)
amp-api.music.apple.com/v1/searchAutocomplete
play.itunes.apple.com/WebObjects/MZPlay.woa/wa/getMusicSDKAuthorizationsSrv
bag.itunes.apple.com/bag.xml                              (service URL discovery)
gsa.apple.com/grandslam/GsService2/lookup                 (Apple ID auth)
```

**DRM approach:**
- `PROTECTION_TYPE_PASTIS_FMP4` = Apple's internal name for FairPlay-over-HLS-fMP4 (what the engine calls CBCS)
- Key delivery: `KDGenerateRequestSPCWithMovieId` → Apple FPS license server → `KDProcessResponseCKC` → `KDDecryptOneSampleiTunes`
- ExoPlayer integration via custom `PlayerFootHillPDataSource` and `PlayerHlsMediaSource`
- **No Widevine** for content decryption — all DRM through Apple's proprietary FairPlay (FootHill/KD) stack
- Linux wrapper provides these KD functions as a TCP service; Android executes them in-process via JNI

**Audio formats confirmed:** AAC LC, HE-AAC, ALAC, FLAC (decoder present), AC-3/E-AC-3 (Atmos), DTS:X Lossless

---

### 1.4 Windows (AppleMusicWin 1.1540.23042.0)

**VERIFIED from binary string analysis:**

**Architecture:** Full port of Apple frameworks to Win32 — `CoreFoundation.dll`, `AVFoundationCF.dll`, `objc.dll`, `libdispatch.dll`, `CFNetwork.dll`, `CoreMedia.dll`. UI is WinUI 3 (XAML). Not a webview wrapper. Store/purchase UI uses WebView2 with a JavaScript bridge (`window.AMS.*` action classes).

**iTunes Bag architecture:** All service URLs are resolved dynamically from `https://init.itunes.apple.com/bag.xml?ix=6` at runtime. The bag file is the canonical source of truth for endpoint URLs. Key bag entries:

```
bag://sf-api-token-service-url              → Media User Token endpoint
bag://fps-cert                              → FairPlay certificate URL
bag://fps-request                           → FairPlay key request URL  
bag://enhanced-audio/hls-key-server-url     → Enhanced audio HLS key server
bag://musicSubscription/lyrics              → LRC lyrics endpoint
bag://musicSubscription/ttmlLyrics          → TTML lyrics endpoint
bag://musicCommon/userProfile               → User profile endpoint
bag://sign-sap-setup                        → SAP setup (FPS initialization)
bag://sign-sap-setup-cert                   → SAP setup certificate
bag://musicCommon/musicMescal/primeUrl      → Mescal session prime
bag://play-activity-feed-request-post-url  → Listening activity telemetry
bag://real-time-communication/rtc-endpoint/url → Collaborative playlists RTC
bag://preference-service-sync-url          → Preference sync
```

**Complete MusicKit API path list** (literal strings in `AMP.Services.dll`):
```
/v1/catalog/{storefront}/albums
/v1/catalog/{storefront}/artists
/v1/catalog/{storefront}/songs
/v1/catalog/{storefront}/playlists
/v1/catalog/{storefront}/music-videos
/v1/catalog/{storefront}/stations
/v1/catalog/{storefront}/genres
/v1/catalog/{storefront}/curators
/v1/catalog/{storefront}/apple-curators
/v1/catalog/{storefront}/search
/v1/catalog/{storefront}/search/hints
/v1/catalog/{storefront}/search/suggestions
/v1/catalog/{storefront}/tv-episodes
/v1/catalog/{storefront}/tv-seasons
/v1/catalog/{storefront}/tv-shows
/v1/me/account
/v1/me/library/songs
/v1/me/library/albums
/v1/me/library/artists
/v1/me/library/playlists
/v1/me/library/music-videos
/v1/me/library/search
/v1/me/purchases
/v1/me/recommendations/suggested
/v1/me/social/profile
/v1/me/social/profile/followees
/v1/me/social/profile/followers
/v1/me/social/profile/blocked-profiles
/v1/social/{storefront}/social-profiles
```

**Auth headers (exhaustive, VERIFIED across DLLs):**
```
Authorization: Bearer <dev-token>
media-user-token: <MUT>
X-Apple-Store-Front: <sf>,29              (storefront + content class suffix)
X-Apple-I-MD: <Anisette OTP>
X-Apple-I-MD-M: <Anisette machine ID>
X-Apple-MD: <Mescal OTP>
X-Apple-MD-M: <Mescal machine ID>
X-Apple-AMD, X-Apple-AMD-Action, X-Apple-AMD-Data, X-Apple-AMD-M   (older Mescal path)
X-Apple-FPDISignature                     (DRM license requests only)
X-Dsid, X-DSID                           (account DSID)
X-Request-Timestamp                       (prevents replay)
```

**FairPlay (Windows):** `CoreFP.dll` + `CoreLSKD.dll` + `CoreKE.dll` + `AVCFContentKeySession` (ports of Apple's macOS FPS stack). The "Pastis" name confirmed for the FPS license server. `bag://fps-cert` + `bag://fps-request` resolve to the actual server URLs.

**HLS custom tags** embedded in Apple Music streams (`com.apple.hls.*`):
- Skip markers: `com.apple.hls.skip.{N}.start/.duration/.type` (skip intros, credits)
- Content ratings: `com.apple.hls.rating-tag`, `com.apple.hls.cs-rating`
- Streaming metadata: `com.apple.hls.title`, `.genre`, `.release-date`, `.description`
- Photosensitivity: `com.apple.hls.photosensitivity-info.*`
- Audio asset metadata: `com.apple.hls.audioAssetMetadata`

---

## Part 2 — Authentication Report

### 2.1 Architecture Overview

Apple Music authentication has three distinct token classes that serve different purposes. All official clients implement all three; the Linux engine currently has partial coverage.

```
┌─────────────────────────────────────────────────────────┐
│ Token Class       │ Header              │ Purpose        │
├─────────────────────────────────────────────────────────┤
│ Developer Token   │ Authorization:      │ Catalog API    │
│ (Bearer)          │ Bearer <token>      │ access (anon)  │
├─────────────────────────────────────────────────────────┤
│ Media User Token  │ media-user-token:   │ Subscription   │
│ (MUT)             │ <token>             │ content, lib,  │
│                   │                     │ lyrics, DL     │
├─────────────────────────────────────────────────────────┤
│ Anisette Headers  │ X-Apple-I-MD:       │ Store API      │
│ (machine identity)│ X-Apple-I-MD-M:     │ signing /      │
│                   │ X-Apple-MD:         │ Mescal req     │
│                   │ X-Apple-MD-M:       │ auth           │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Developer Bearer Token

**What it is:** A short-lived JWT that grants read access to Apple's public catalog API (`amp-api.music.apple.com/v1/catalog/*`). It is NOT tied to a user account. It does NOT authorize downloads, library access, or lossless playback.

**How it is obtained:**
- Official path: MusicKit developer program (Apple developer account, registered app)
- Engine path: `ampapi.GetToken()` scrapes `music.apple.com` HTML to extract the embedded developer token from the page's `<script>` tags (same token Apple's web player uses)
- This auto-fetch approach works currently because Apple embeds their own developer token in the SPA bundle

**Current engine status:** VERIFIED working. The engine auto-fetches at startup (`main.go` startup sequence). Falls back to `Config.AuthorizationToken` from config.yaml.

**Flutter implication:** The Flutter client does NOT need to manage this token. The engine provides it. All catalog API calls should be proxied through the engine.

### 2.3 Media User Token (MUT)

**What it is:** A user-specific token issued by Apple Music that grants:
- Subscription-gated content (ALAC, Atmos, downloads)
- Personal library access (GET /v1/me/library/*)
- Recommendations, recently played, user profile
- Lyrics API
- Download/export

**Technical details (VERIFIED from Android + Windows analysis):**
- Managed by `AMSCore::NetworkMediaTokenProvider` (Apple's library)
- Has explicit `issueDate`, `expiryDate` (VERIFIED from Android `MediaToken.hasExpired`, `lifetimeRemaining`)
- Fetched from `bag://sf-api-token-service-url` endpoint (Windows bag analysis)
- Also referenced as `musicUserToken`, `x-apple-music-user-token`
- Distinct from the IDMS tokens — it is music-service-specific

**How official clients obtain it:**
1. Android: AMSKit library calls `NetworkMediaTokenProvider` which hits `bag://sf-api-token-service-url` using the IDMS session
2. Windows: Same via `AppleMediaServicesKit.dll` + `EphemeralMediaTokenStore`
3. Web (apple-music-linux): Extracted from `document.cookie` (`media-user-token` cookie set by Apple's SPA after login)
4. iOS/macOS: Obtained through `MusicKit.MusicSubscription.current`

**Current engine status — SOLVED (2026-07-08):** The MUT is already available from the DRM session after `POST /api/v1/drm/authenticate`. No WebView login is needed. Three independent paths exist within the engine:

1. **`SessionManager.ReadMusicToken()`** — reads `{session_dir}/MUSIC_TOKEN`, written by the wrapper immediately after login. Already used by `IsSessionValid()`.
2. **`AccountInfo.MusicToken`** — returned by `GetAccount()` (HTTP GET to port 30020) on both `ProcessBackend` and `EmbeddedBackend`. The wrapper binary confirms this with the strings `get_music_user_token`, `g_music_token`, and the exact response template `{"storefront_id":"%s","dev_token":"%s","music_token":"%s"}`.
3. **Apple endpoint** — the wrapper fetches MUT from `https://sf-api-token-service.itunes.apple.com/apiToken` (confirmed from strings analysis of `wrapper/rootfs/system/bin/main`); this is the same endpoint referenced by `bag://sf-api-token-service-url` on Windows.

**Integration design — accessor pattern (implemented in `apiserver.go`):**

Rather than copying the MUT into `Config` at startup (which would create duplicated state and miss wrapper token refreshes), `APIServer` exposes two accessor methods that treat the session as the canonical source and `Config` as an override:

```go
func (s *APIServer) mediaUserToken() string {
    if Config.MediaUserToken != "" {
        return Config.MediaUserToken   // manual override / testing
    }
    if s.session != nil {
        if mt := s.session.ReadMusicToken(); mt != "" {
            return mt                  // live session value
        }
    }
    return ""
}

func (s *APIServer) storefront() string {
    if Config.Storefront != "" {
        return Config.Storefront
    }
    if s.session != nil {
        if sf := s.session.ReadStorefrontID(); sf != "" {
            return strings.SplitN(sf, "-", 2)[0]  // strip ",31" suffix
        }
    }
    return ""
}
```

All handler call sites (`handleCreatePlayback`, `handleMetadata`, `handleArtwork`, `handleLyrics`, `handleExportCreate`) and `checkAuth` use these accessors. `Config.MediaUserToken`/`Config.Storefront` remain as manual overrides but are no longer required when a valid session exists.

**Advantages over copying into Config:** no duplicated state, no synchronization issues, automatic pickup of wrapper token refreshes, `config.yaml` remains the override path for manual/testing use.

**Storefront suffix:** The wrapper writes `143467-2,31` (storefront + content-class suffix). `storefront()` strips at the first `-` to get `143467`. `Config.Storefront` holds a clean value (e.g. `"in"`) when set manually.

**Remaining MUT concern:** Auto-refresh on token expiry. The wrapper's `AMSKit`-equivalent handles expiry internally and re-fetches from `sf-api-token-service.itunes.apple.com`. Because `mediaUserToken()` reads the file on every call rather than caching, the refreshed token is picked up without any engine restart.

### 2.4 Anisette / Machine Provisioning

**What it is:** A machine-identity OTP system Apple uses to authenticate requests to store APIs. Not required for basic catalog access. Required for: purchase, subscription management, some personalized endpoints.

**How it works (VERIFIED from Android + Windows):**
1. `ADIProvisioningStart` → Apple server → returns provisioning data
2. `ADIProvisioningEnd` → machine is provisioned, gets a stable machine ID
3. Per-request: `ADIOTPRequest` generates OTP → `X-Apple-I-MD` (OTP data) + `X-Apple-I-MD-M` (machine ID)

**Engine status:** Not implemented at the Go level. The DRM wrapper provides this for DRM-related calls. Catalog API calls from the engine use only `Authorization: Bearer` + `media-user-token` without Anisette.

**Flutter implication:** For basic catalog/library/playback — Anisette is not required. `Authorization: Bearer <token>` + `media-user-token: <MUT>` is sufficient for all `amp-api.music.apple.com/v1/` endpoints. Anisette is needed only for store actions (purchases, subscription management) which are out of scope.

### 2.5 Storefront

**What it is:** A 2-letter ISO 3166-1 country code (e.g., `"us"`, `"gb"`, `"in"`) that determines which catalog and pricing region the user is in.

**How it is resolved:**
- Official: `GET amp-api.music.apple.com/v1/me/storefront` (requires MUT)
- Windows header: `X-Apple-Store-Front: <sf>,29` — the `,29` suffix is the "content class" for desktop apps
- Engine: `Config.Storefront` from config.yaml (must be set manually currently)

**Flutter implication:** After MUT acquisition, call `GET /api/v1/me/storefront` (once engine proxies it) or directly `GET amp-api.music.apple.com/v1/me/storefront` to auto-detect storefront. Cache it. All subsequent catalog calls use this storefront.

### 2.6 Complete Login Flow for Flutter Client

**Updated 2026-07-08 — WebView login NOT required for MUT.**

```
1. User opens app (no session)
   ↓
2. App subscribes to GET /api/v1/events (SSE stream)
   ↓
3. App calls POST /api/v1/drm/authenticate { "email": "...", "password": "..." }
   ↓
4. On SSE event drm.type = "challenging":
   → Show 2FA code input to user
   → POST /api/v1/drm/challenge { "reply": "123456" }
   ↓
5. On SSE event drm.fairplay = "ready" AND drm.authentication = "logged_in":
   → Wrapper has authenticated; MUSIC_TOKEN file is now populated
   → Engine s.mediaUserToken() reads MUSIC_TOKEN on every API call (no init step needed)
   → Engine s.storefront() reads STOREFRONT_ID, strips suffix "143467-2,31" → "143467"
   ↓
6. App is fully authenticated. All requests use:
   → Bearer token: auto-fetched by engine at startup
   → MUT: s.mediaUserToken() — live from session, Config as override
   → Storefront: s.storefront() — live from session, Config as override
```

**No WebView needed.** The DRM authenticate + challenge flow is already implemented and produces the MUT as a side effect. The accessor pattern in `apiserver.go` (`mediaUserToken()` / `storefront()`) reads directly from the session on every call — no startup initialization required, no duplicated state, and wrapper token refreshes are picked up automatically. **This is implemented and building.**

---

## Part 3 — API Report

### 3.1 Apple Music REST API (amp-api.music.apple.com)

**Base URL:** `https://amp-api.music.apple.com/v1/`

**Required headers for all authenticated calls:**
```http
Authorization: Bearer <developer-token>
media-user-token: <MUT>
Accept-Language: en-US,en;q=0.9
```

**Recommended headers (match official client behavior):**
```http
X-Apple-Store-Front: <sf>,29
Origin: https://music.apple.com
```

#### Catalog Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/catalog/{sf}/songs/{id}` | Single song metadata |
| GET | `/v1/catalog/{sf}/songs?ids=` | Batch song lookup (up to 300 IDs) |
| GET | `/v1/catalog/{sf}/albums/{id}` | Album detail with tracks |
| GET | `/v1/catalog/{sf}/artists/{id}` | Artist detail |
| GET | `/v1/catalog/{sf}/playlists/{id}` | Playlist detail with tracks |
| GET | `/v1/catalog/{sf}/music-videos/{id}` | Music video detail |
| GET | `/v1/catalog/{sf}/genres` | Top-level genres |
| GET | `/v1/catalog/{sf}/search` | Search catalog (`?term=&types=songs,albums,...`) |
| GET | `/v1/catalog/{sf}/search/hints` | Search autocomplete hints |
| GET | `/v1/catalog/{sf}/search/suggestions` | Rich search suggestions |
| GET | `/v1/catalog/{sf}/stations` | Radio stations |
| GET | `/v1/catalog/{sf}/curators/{id}/playlists` | Apple curator playlists |

**Common query parameters:**
- `include` — related resources to embed (e.g., `include=tracks,artists`)
- `extend` — additional attributes (e.g., `extend=extendedAssetUrls,offers`)
- `fields` — attribute projection (reduce payload size)
- `limit` — page size (max 100 for most endpoints, 300 for batch)
- `offset` — pagination offset
- `l` — language for localized strings (e.g., `l=en-US`)
- `platform` — platform hint (e.g., `platform=web`)

#### User Library Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/me/library/songs` | Library songs (paginated) |
| GET | `/v1/me/library/albums` | Library albums |
| GET | `/v1/me/library/artists` | Library artists |
| GET | `/v1/me/library/playlists` | User playlists |
| GET | `/v1/me/library/playlists/{id}/tracks` | Playlist tracks |
| POST | `/v1/me/library/playlists` | Create playlist |
| POST | `/v1/me/library/playlists/{id}/tracks` | Add tracks |
| DELETE | `/v1/me/library/playlists/{id}/tracks/{trackId}` | Remove track |
| GET | `/v1/me/library/search` | Search user library |
| GET | `/v1/me/library/songs/{id}` | Library song (with `playParams`) |
| POST | `/v1/me/library` | Add catalog item to library |

#### Personalization Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/me/recommendations` | For You / personalized |
| POST | `/v1/me/recommendations/suggested` | Suggested tracks for context |
| GET | `/v1/me/recent/played` | Recently played (albums, playlists, stations) |
| GET | `/v1/me/recent/played/tracks` | Recently played tracks |
| GET | `/v1/me/recent/radio-stations` | Recently played radio stations |
| GET | `/v1/me/storefront` | User's Apple Music storefront |
| GET | `/v1/me/account` | Account info |
| GET | `/v1/me/social/profile` | User social profile |
| PATCH | `/v1/me/social/profile` | Update social profile |
| GET | `/v1/me/music-summaries/` | Apple Music Replay data |

**Key response fields (VERIFIED from Android class names and Windows strings):**
- Tracks: `adamId`, `albumName`, `artistName`, `artwork`, `artworkToken`, `audioTraits`, `composerName`, `contentRating`, `discNumber`, `durationInMillis`, `genreNames`, `playParams`, `releaseDate`, `trackNumber`
- Artwork: `{width}x{height}{c}.{ext}` template URL pattern (CDN: `isq11.mzstatic.com`)
- `playParams.id` — the ID used in `POST /api/v1/playback` on the engine
- `audioTraits` — array containing `lossless`, `hi-res-lossless`, `dolby-atmos`, `spatial-audio`

#### Lyrics

**VERIFIED from Windows bag keys:**
- LRC: `bag://musicSubscription/lyrics` → resolved at runtime
- TTML: `bag://musicSubscription/ttmlLyrics` → resolved at runtime
- The engine already implements a lyrics proxy at `GET /api/v1/lyrics/{id}` — use this instead of calling Apple directly

#### Artwork URL Construction

**VERIFIED from Android `libmedialibrarycore.so`:**
```
https://isq11.mzstatic.com/image/thumb/{hash}/{w}x{h}{c}.{f}
```
- `{w}x{h}` — requested dimensions (e.g., `500x500`, `3000x3000`)
- `{c}` — crop mode: `cc` (center crop), `sr` (smart resize), `bb` (bounding box)
- `{f}` — format: `jpg`, `webp`, `png`

The engine's `GET /api/v1/artwork/{id}?size=N` already handles this — Flutter should use the engine proxy rather than constructing URLs directly.

---

### 3.2 Webplayback / SDK Authorization

**VERIFIED (Android + engine source):**
```
POST https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/getMusicSDKAuthorizationsSrv
```
The engine uses this for webplayback asset selection (CTR/Widevine path for AAC). The response contains the M3U8 URL for the requested asset flavor.

The engine calls this internally via `engine/apple/provider.go fetchWebplayback`. Flutter does not need to call this directly.

---

### 3.3 Existing Engine API (Current State)

See Part 1.2 for the full route table. The engine handles:
- ✅ Playback (create session, stream audio/video)
- ✅ Metadata (song/MV info + available stream list)
- ✅ Artwork (proxied, size-parameterized)
- ✅ Lyrics (LRC and TTML, proxied)
- ✅ Export/download jobs
- ✅ DRM management (authenticate, challenge, logout, status)
- ✅ SSE event bus
- ✅ pprof diagnostics

### 3.4 Required Engine API Additions

These additions are needed for a full Flutter client. They proxy Apple's API through the engine so the Flutter UI has no Apple dependencies.

**Priority 1 (required for basic UI):**

```
GET  /api/v1/catalog/{id}?type=song|album|artist|playlist|mv&sf=
     → Catalog item detail (any type)

GET  /api/v1/catalog/search?q=&types=&limit=&offset=&sf=
     → Catalog search

GET  /api/v1/me/storefront
     → Detect user storefront (requires MUT)

GET  /api/v1/me/library/songs?limit=&offset=
GET  /api/v1/me/library/albums?limit=&offset=
GET  /api/v1/me/library/artists?limit=&offset=
GET  /api/v1/me/library/playlists?limit=&offset=
GET  /api/v1/me/library/playlists/{id}/tracks?limit=&offset=
     → User library browsing

PUT  /api/v1/config
     Body: { "mediaUserToken": "...", "storefront": "..." }
     → Allow frontend to inject MUT without restarting engine
```

**Priority 2 (required for personalization):**
```
GET  /api/v1/me/recommendations?limit=&offset=
GET  /api/v1/me/recent/played?limit=
GET  /api/v1/me/recent/played/tracks?limit=
     → Home screen content

POST /api/v1/me/library?assetId=&type=song|album|playlist
DELETE /api/v1/me/library?assetId=&type=song|album|playlist
     → Library management
```

**Priority 3 (quality of life):**
```
POST /api/v1/me/library/playlists
     Body: { "name": "...", "description": "..." }
POST /api/v1/me/library/playlists/{id}/tracks
     Body: { "assetIds": ["..."] }
DELETE /api/v1/me/library/playlists/{id}/tracks/{trackId}
     → Playlist management

GET  /api/v1/catalog/{sf}/charts?types=&limit=
     → Charts / Browse page
```

---

## Part 4 — Playback Report

### 4.1 Complete Playback Lifecycle

```
User taps "Play" on a track
        │
        ▼
[Flutter] POST /api/v1/playback
  {
    "assetId": "<adamID>",
    "storefront": "us",
    "capabilities": { "lossless": true }
  }
        │
        ▼  [Engine]
  apple.Provider.Open()
    ├─ If ALAC/Atmos: webplayback → CBCS path
    │    fetchWebplayback() → catalog ExtendedAssetUrls.EnhancedHls
    │    OpenMediaCBCS() → skd:// EXT-X-KEY → CBCSSource
    │    DialCBCS() → TCP socket 127.0.0.1:10020 (wrapper)
    │    Send adamID + keyURIs → receive decrypted keys
    │
    └─ If AAC: webplayback CTR path
         fetchWebplayback() → FlavorCTR256 asset URL
         OpenMedia() → data:;base64,[kid] EXT-X-KEY → HLSSource
         runv3.AcquireKey() → Widevine CDM challenge → Apple endpoint → key
         Decrypt in-process (AES-CTR)
        │
        ▼
  Session created (TTL: 4 hours)
  SSE emits: { type: "playback.created", data: { sessionId, codec } }
        │
        ▼
[Flutter] HTTP 201 + Session JSON
  {
    "sessionId": "...",
    "type": "song",
    "codec": "alac",
    "sampleRate": 96000,
    "bitDepth": 24,
    "streams": { "audio": "/api/v1/playback/{id}/audio" },
    "title": "...",
    "artistName": "...",
    "durationMs": 201000,
    "artworkUrl": "/api/v1/artwork/{id}?size=500"
  }
        │
        ▼
[Flutter Audio Player]
  GET /api/v1/playback/{id}/audio?raw=1      ← for ALAC/Atmos (native codec)
  GET /api/v1/playback/{id}/audio            ← for AAC (already in correct format)
  GET /api/v1/playback/{id}/audio?transcode=flac  ← optional FLAC output
        │
        ▼
[Engine streams fMP4]
  CBCSSource → TCP socket → segment bytes → fmp4 reassembly → HTTP response body
        │
        ▼
[Flutter] Audio player receives chunked fMP4 stream
  → Decode + render to audio output
  → Update MPRIS position
  → Show progress
```

### 4.2 Format Selection Logic (Engine)

| Requested | Capability | Engine path | Output codec |
|-----------|------------|-------------|--------------|
| `lossless: true` | DRM ready | CBCS (wrapper TCP) | ALAC |
| `lossless: true, hiRes: true` | DRM ready | CBCS (wrapper TCP) | ALAC up to 192kHz |
| `atmos: true` | DRM ready | CBCS (wrapper TCP) | E-AC-3 |
| `video: true` | Always | CTR (Widevine) | H.264 + AAC |
| default | Always | CTR (Widevine) | AAC 256 kbps |

**Audio URL modes:**
- `?raw=1` — native codec (ALAC fMP4, E-AC-3 fMP4)
- `?transcode=aac` — ffmpeg → AAC 256 kbps (browser-compatible)
- `?transcode=flac` — ffmpeg → FLAC (lossless, widely supported)
- Default (no param) — AAC for ALAC/Atmos, native for AAC

### 4.3 Queue Management

The engine has no queue. This is correct by design — the queue belongs in the Flutter UI layer, not the engine. The engine is stateless with respect to "what plays next."

**Flutter queue design:**
```dart
class PlaybackQueue {
  final List<QueueItem> items;  // ordered list of { assetId, sessionId? }
  int currentIndex;
  RepeatMode repeat;
  bool shuffle;
  
  // Pre-buffer: create engine session for next track while current plays
  // Engine sessions are cheap; create 1–2 ahead
}
```

**Pre-buffering:** The engine session creation (`POST /api/v1/playback`) is the expensive operation (catalog fetch, HLS parse, key acquisition). Flutter should `POST /api/v1/playback` for the next track ~30 seconds before the current one ends, then immediately call `GET .../audio` when it's time to play. This eliminates inter-track gaps.

### 4.4 Seek Support

**Current limitation:** The engine's audio stream is a one-shot HTTP GET that streams from the beginning. There is no seek support — the engine provides no `/api/v1/playback/{id}/seek` endpoint, and the pipeline does not support random access.

**Flutter workaround options:**
1. **Accept no seek** — acceptable for streaming player MVP
2. **Client-side seek via range requests** — if the engine returns `Accept-Ranges: bytes`, the audio player can seek by issuing range requests (depends on fMP4 structure and whether the player can parse it)
3. **Engine-side seek** — significant work; requires parsing fMP4 moov box for fragment offset table

This is an open engineering decision. For Phase 1, no seek is acceptable.

### 4.5 Transport Controls

The Flutter audio player needs to:
- Call `DELETE /api/v1/playback/{id}` when stopping or skipping
- Create new session via `POST /api/v1/playback` for next/previous track
- Track session IDs per queue item
- Handle 404 from `GET .../audio` if session expired (TTL 4h) — re-create session

---

## Part 5 — DRM Report

### 5.1 Architecture Overview

Apple Music DRM uses **FairPlay Streaming (FPS)** — Apple's proprietary key delivery protocol layered over HLS. The internal Apple codename for this scheme is **PASTIS** (confirmed across Android APK and Windows binary analysis).

There are two DRM sub-modes, both using FPS but with different key delivery transports:

| Mode | Apple name | Key delivery | Linux implementation |
|------|------------|--------------|----------------------|
| CBCS | PASTIS/FMP4 | TCP socket (wrapper) | `engine/fairplay/cbcs.go` + wrapper |
| CTR | Widevine-compat | HTTPS (Widevine CDM) | `engine/fairplay/license.go` + `runv3` |

The "CTR mode" is not actually Widevine — it is Apple's own key server that happens to accept Widevine-formatted CDM challenges. The Widevine L3 CDM is used as a protocol adapter, not as the actual DRM system.

### 5.2 PASTIS / CBCS Key Delivery

**Flow (VERIFIED: Android → FPDI/KD functions; Linux: socat wire trace 2026-07-02):**

```
1. Engine fetches HLS master playlist
   ↓
2. Engine parses EXT-X-KEY: URI="skd://itunes.apple.com/..."
   → URI scheme "skd" = FairPlay Streaming key URI
   ↓
3. CBCSSource connects to wrapper TCP socket (127.0.0.1:10020)
   ↓
4. Engine sends KEY_SETUP message: adamID + keyURIs
   (Android equivalent: KDGenerateRequestSPCWithMovieId + KDProcessResponseCKC)
   ↓
5. Wrapper authenticates with Apple's FPS license server
   - SAP setup (bag://sign-sap-setup) if needed
   - SPC (Server Playback Context) challenge generated
   - Apple returns CKC (Content Key Context)
   ↓
6. Wrapper returns decrypted segment key bytes via TCP
   ↓
7. Engine reassembles fMP4 fragments using received keys
   ↓
8. Engine streams plaintext fMP4 to Flutter client
```

**Wire-verified (Linux, adamID 1488408568, ALAC track):**
- 2 key sessions: preshare key (161 samples, HLS seg 0), real key (2010 samples, segs 1–13)
- 1 SWITCH_KEYS for the entire stream
- 41,611,808 total wire bytes for a 3:21 track at ALAC 44.1kHz/24-bit

### 5.3 Component Responsibilities

```
Flutter UI
  ↕ REST API
Engine (Go)
  ├── Session management (4h TTL)
  ├── Apple catalog fetch (webplayback API)
  ├── HLS playlist parsing (engine/hls)
  ├── CTR key acquisition (engine/fairplay/license.go + runv3)
  ├── CBCS key exchange (engine/fairplay/cbcs.go + TCP socket)
  ├── fMP4 stream assembly
  └── HTTP stream to client
        ↕ TCP socket (CBCS) or HTTPS (CTR)
DRM Wrapper (Android binary)
  ├── Apple ID session management
  ├── Anisette provisioning (ADI)
  ├── FPS SAP setup
  ├── CKC key decryption (KD functions)
  └── TCP server (port 10020 decrypt, 20020 M3U8, 30020 account)
        ↕ HTTPS
Apple Servers
  ├── FPS license server (bag://fps-request) → CKC responses
  ├── Webplayback (play.itunes.apple.com) → M3U8 URLs
  └── Catalog (amp-api.music.apple.com) → metadata
```

**Flutter's DRM responsibility: zero.** Flutter calls `POST /api/v1/playback` and `GET .../audio`. The entire DRM chain is invisible to it.

### 5.4 DRM State Machine (Engine)

The Flutter UI must handle DRM states exposed via `GET /api/v1/drm/status` and SSE events:

| State | User-visible action |
|-------|---------------------|
| `authentication: "logged_out"` | Show login screen |
| `authentication: "logging_in"` | Show "Connecting to Apple Music..." |
| `authentication: "challenging"` + `challenge.type: "two_factor"` | Show 2FA input dialog |
| `authentication: "challenging"` + `challenge.type: "device_approval"` | Show "Check your device" screen |
| `authentication: "logged_in"` + `fairplay: "ready"` | Ready to play lossless |
| `fairplay: "failed"` | Show error; offer retry |
| `session: "expired"` | Show "Session expired, please re-login" |

---

## Part 6 — Recommended Architecture

### 6.1 Frontend Recommendation: Flutter

**Option A (apple-music-linux) verdict: Discard.** This project is a webview wrapper, not a UI library. It has no custom screens, no widget library, no state management, and no Apple API integration. "Adapting" it would mean building a new Flutter app and using none of the existing code. The only reusable concepts are: (a) the MUT cookie extraction pattern (one function), (b) the wrapper port numbers (three constants).

**Option B (Flutter) verdict: Proceed.**

| Dimension | Flutter assessment |
|-----------|-------------------|
| Linux support | First-class since Flutter 3.7; GTK4 backend; Wayland-native via GTK |
| Performance | Native compiled (Dart AOT); GPU-accelerated Skia/Impeller rendering |
| UI flexibility | Full custom rendering; blur, gradients, custom paint; not limited to platform widgets |
| Animations | 60/120fps; physics-based; hero transitions; custom curve controllers |
| Liquid glass / acrylic | Full custom painting via `CustomPainter`; backdrop filter blur; frosted glass effects |
| MPRIS | `dbus` package; implement `org.mpris.MediaPlayer2` interface |
| Desktop integration | `system_tray`, `hotkey_manager`, `window_manager` packages |
| Notifications | `flutter_local_notifications` supports Linux (libnotify) |
| Wayland | GTK4 backend supports Wayland; no X11 requirement |
| HDR | Depends on compositor/driver; Flutter renders sRGB by default; HDR requires platform channel |
| Cross-platform | Same codebase for Android/iOS/Web/Windows/macOS with layout adaptation |
| Packaging | AppImage, Flatpak, deb via standard Flutter Linux build toolchain |
| Engine integration | HTTP client (`dio`) → `127.0.0.1:<port>` REST; SSE via `http` package event streaming |
| Auth | DRM auth flow provides MUT automatically; `flutter_secure_storage` for token cache (optional redundancy) |
| State management | `flutter_riverpod` (recommended) or `bloc` |

**Concern: Audio playback.** The engine streams fMP4 over HTTP. Flutter needs to play this. Options:
- `just_audio` with `AudioSource.uri` pointing to `http://127.0.0.1:<port>/api/v1/playback/{id}/audio` — works for AAC/FLAC transcode paths; ALAC fMP4 may require custom decoder
- `dart:ffi` + `libmpv` — most flexible; can decode ALAC, E-AC-3, any codec mpv supports; requires packaging `libmpv.so`
- **Recommendation:** `libmpv` via `dart:ffi` or the `media_kit` Flutter package (which wraps libmpv). Use `?transcode=flac` path for maximum compatibility without native ALAC decoder.

### 6.2 IPC Recommendation: REST + SSE (Extend Existing)

The engine's existing REST + SSE architecture is correct. No change to the IPC layer is needed.

**Rationale for REST over alternatives:**
- **gRPC:** Unnecessary complexity for a local daemon. REST is sufficient, easier to debug with curl, no protobuf schema maintenance. The performance difference over loopback is immeasurable.
- **Unix socket:** Performance identical to TCP loopback on Linux. REST over TCP is more debuggable and requires no socket file management.
- **WebSocket (full duplex):** Worth adding **only** for the DRM challenge flow, where the current SSE + polling pattern is awkward. A WebSocket at `ws://localhost:<port>/api/v1/drm/ws` would make the 2FA challenge loop bidirectional. Not urgent.
- **Named pipe / IPC:** No benefit over localhost TCP for this use case.

**Keep:** REST for request-response. SSE for push events. Consider: WebSocket for the DRM challenge flow only.

### 6.3 Project Layout

```
apple-music-flutter/           # New Flutter project (separate repo)
├── lib/
│   ├── main.dart
│   ├── app.dart               # App widget, theme, routing
│   ├── core/
│   │   ├── engine/            # Engine API client
│   │   │   ├── engine_client.dart      # HTTP client, base URL config
│   │   │   ├── engine_events.dart      # SSE event parsing
│   │   │   ├── models/                 # PlaybackSession, ExportJob, DRMSnapshot, etc.
│   │   │   └── repositories/          # PlaybackRepository, ExportRepository, etc.
│   │   ├── apple_api/         # Direct Apple Music API (catalog/library)
│   │   │   ├── apple_client.dart       # amp-api.music.apple.com HTTP client
│   │   │   ├── models/                 # Song, Album, Artist, Playlist, etc.
│   │   │   └── repositories/          # CatalogRepository, LibraryRepository
│   │   ├── auth/
│   │   │   ├── auth_service.dart       # MUT lifecycle (reads from engine after DRM auth)
│   │   │   └── drm_service.dart        # DRM auth flow (POST /drm/authenticate → SSE → challenge)
│   │   └── mpris/
│   │       └── mpris_service.dart      # org.mpris.MediaPlayer2 via dbus
│   ├── features/
│   │   ├── home/              # Home tab (recommendations, recently played)
│   │   ├── search/            # Search tab
│   │   ├── library/           # Library tab (songs, albums, artists, playlists)
│   │   ├── now_playing/       # Now playing screen (full-screen player)
│   │   ├── album/             # Album detail page
│   │   ├── artist/            # Artist detail page
│   │   ├── playlist/          # Playlist detail page
│   │   ├── lyrics/            # Lyrics display (LRC sync, TTML karaoke)
│   │   ├── downloads/         # Download management (export jobs)
│   │   └── settings/          # Engine config, DRM status, audio quality
│   └── shared/
│       ├── widgets/           # ArtworkWidget, TrackRow, AlbumCard, etc.
│       ├── theme/             # Colors, typography, glass morphism
│       └── utils/             # Duration formatting, etc.
├── pubspec.yaml
└── linux/                     # Flutter Linux-specific files

apple-music-engine-dev/        # Existing engine (this repo)
├── apiserver.go               # Engine HTTP server
├── engine/                    # Core engine packages
├── cmd/                       # Diagnostic tools
└── config.yaml                # Runtime configuration
```

### 6.4 Engine API Package Structure

For the new engine endpoints (catalog/library proxy), add:

```
engine/
├── catalog/                   # New: Apple Music catalog proxy
│   ├── client.go              # amp-api.music.apple.com HTTP client
│   ├── models.go              # Song, Album, Artist, Playlist types
│   └── cache.go               # In-memory + optional disk cache
├── library/                   # New: User library proxy
│   └── client.go
└── userinfo/                  # New: Storefront, profile
    └── client.go
```

Add routes to `apiserver.go`:
```go
// Catalog
r.GET("/api/v1/catalog/search", s.handleCatalogSearch)
r.GET("/api/v1/catalog/:type/:id", s.handleCatalogItem)

// Library
r.GET("/api/v1/me/library/:type", s.handleLibrary)
r.POST("/api/v1/me/library/:type/:id", s.handleLibraryAdd)
r.DELETE("/api/v1/me/library/:type/:id", s.handleLibraryRemove)
r.GET("/api/v1/me/library/playlists/:id/tracks", s.handlePlaylistTracks)

// Personalization
r.GET("/api/v1/me/recommendations", s.handleRecommendations)
r.GET("/api/v1/me/recent/played", s.handleRecentlyPlayed)
r.GET("/api/v1/me/storefront", s.handleStorefront)

// Config
r.PUT("/api/v1/config", s.handleConfigUpdate)
```

### 6.5 Authentication Implementation

**Updated 2026-07-08:** WebView login is NOT needed. The DRM auth flow (`POST /api/v1/drm/authenticate`) produces the MUT as a side-effect. After `drm.authentication = "logged_in"`, `s.mediaUserToken()` reads the MUSIC_TOKEN session file on every subsequent API call — no initialization step, no duplicated state. The Flutter client only needs to drive the DRM auth UI.

```dart
// drm_service.dart
class DrmService {
  final EngineClient _engine;
  final StreamController<DrmEvent> _events = StreamController.broadcast();

  Stream<DrmEvent> get drmEvents => _events.stream;

  Future<void> authenticate(String email, String password) async {
    await _engine.post('/api/v1/drm/authenticate',
        body: {'email': email, 'password': password});
    // SSE stream from /api/v1/events will emit drm events
  }

  Future<void> submitChallenge(String code) async {
    await _engine.post('/api/v1/drm/challenge', body: {'reply': code});
  }

  // After drm.authentication = "logged_in":
  // Engine's s.mediaUserToken() reads MUSIC_TOKEN from session on every call.
  // Call GET /api/v1/capabilities to confirm MUT is live (checkAuth passes).
}

// login_screen.dart
// Shows email/password → on submit calls drmService.authenticate()
// Subscribes to SSE events → on drm.type = "challenging" shows 2FA dialog
// On drm.authentication = "logged_in" → navigate to home
// No WebView required.
```

**MUT refresh:** The wrapper auto-refreshes the MUT via `https://sf-api-token-service.itunes.apple.com/apiToken`. A restart of the engine (or a `GET /api/v1/drm/status` + session `ReadMusicToken()` call) always returns the current token. No client-side refresh logic is needed.

---

## Part 7 — Migration Roadmap

### Phase 1 — Core Playback Shell (3–4 weeks)

**Goal:** Play ALAC/Atmos/AAC from a Flutter UI. Minimal viable product.

**Deliverables:**
- Flutter project scaffolding with `libmpv` / `media_kit` audio backend
- Engine client package (`EngineClient` with base URL config)
- DRM login flow (POST /drm/authenticate → SSE events → challenge dialog)
- Simple search-by-ID playback (enter an Adam ID, tap play)
- Now-playing screen: artwork, title, artist, progress indicator (time-only, no seek bar)
- MPRIS2 basic integration: play/pause/stop/next/prev, title/artist/album/artwork
- Engine: `mediaUserToken()` / `storefront()` accessors on `APIServer` — **already implemented**; reads session as canonical source with `Config` as override

**Estimated difficulty:** Medium. The engine does all the hard work; Flutter integration is straightforward HTTP + audio.

**Risks:**
- ALAC fMP4 playback in `media_kit` on Linux — test early; if it doesn't work, fall back to `?transcode=flac`
- MUT token expiry handling: if the wrapper's auto-refresh fails, a DRM re-auth may be needed; design a graceful 401 re-login flow

---

### Phase 2 — Catalog, Library, Search (6–8 weeks)

**Goal:** Full music browsing experience. User can discover and queue tracks.

**Engine additions:**
- `GET /api/v1/catalog/search` — proxied catalog search
- `GET /api/v1/catalog/:type/:id` — album/artist/song/playlist detail
- `GET /api/v1/me/library/:type` — library browsing (songs, albums, artists, playlists)
- `GET /api/v1/me/recommendations` — home page content
- `GET /api/v1/me/recent/played` — recently played
- `GET /api/v1/me/storefront` — storefront detection
- `POST /api/v1/me/library/:type/:id` — add to library

**Flutter additions:**
- Home tab: recommendations shelf, recently played row
- Search tab: debounced search, result categories (songs/albums/artists/playlists)
- Library tab: songs, albums, artists, playlists with sorting/filtering
- Album detail page: tracklist, metadata, play/download actions
- Artist detail page: albums, top songs, music videos
- Playlist detail page: tracklist, play, add to library
- Queue management: play next, play later, queue view
- Storefront auto-detection on login

**Estimated difficulty:** Medium-high for engine additions (Apple API client package, caching layer). Low-medium for Flutter UI (standard list/grid layouts).

---

### Phase 3 — Polish, Downloads, Advanced Features (4–6 weeks)

**Goal:** Production-quality client.

**Features:**
- Download manager UI (progress, cancel, retry) backed by existing `/api/v1/export` API
- Lyrics display: LRC karaoke scroll, TTML word-level highlighting
- Audio quality selector: auto / AAC / lossless / hi-res lossless / Atmos
- MPRIS2 full implementation: shuffle, repeat, seek (when available), rating
- Linux desktop notifications (libnotify): now playing, download complete
- Settings screen: DRM status, backend selector, audio output, quality settings
- Wayland-native window management (title bar, window controls)
- Artwork caching with LRU eviction
- Glass morphism / blur effects on album art backgrounds
- System media controls (GNOME, KDE shell integration via MPRIS)
- App packaging: Flatpak manifest, `.desktop` file, icon at standard sizes
- Seek support investigation and implementation if feasible

**Estimated difficulty:** Medium. Most features use existing engine API or standard Flutter packages.

---

### Phase 4 — Platform Expansion and Plugin Architecture (ongoing)

**Goal:** Expand to other platforms; build extensibility.

**Options:**
- **macOS/Windows:** Flutter codebase is already cross-platform; engine runs on macOS/Windows (with appropriate DRM backend); thin platform channel additions for native media keys
- **Plugin architecture:** Export the `EngineClient` as a separate Dart package; allow third-party plugins (Last.fm scrobbling, Discord RPC, custom output routing)
- **MUT auto-refresh:** Investigate wrapper GetAccount endpoint to enable silent token refresh
- **Collaborative playlists:** `bag://real-time-communication/rtc-endpoint/url` (RTC-based)
- **AI playlists:** `GET /v1/intelligence/playlists/ideas` (Android 6.x feature; likely requires MUT)
- **Apple Music Replay:** `GET /v1/me/music-summaries/`

---

## Appendix A — Complete URL Inventory

All domains/endpoints confirmed across all four source artifacts:

### Apple Music API
```
amp-api.music.apple.com                         # MusicKit catalog + user API
  /v1/catalog/{sf}/songs
  /v1/catalog/{sf}/albums
  /v1/catalog/{sf}/artists
  /v1/catalog/{sf}/playlists
  /v1/catalog/{sf}/music-videos
  /v1/catalog/{sf}/stations
  /v1/catalog/{sf}/genres
  /v1/catalog/{sf}/search
  /v1/catalog/{sf}/search/hints
  /v1/catalog/{sf}/search/suggestions
  /v1/catalog/{sf}/curators
  /v1/catalog/{sf}/apple-curators
  /v1/me/library/{songs,albums,artists,playlists,music-videos}
  /v1/me/library/search
  /v1/me/library/import/jobs/
  /v1/me/recommendations
  /v1/me/recommendations/modules
  /v1/me/recommendations/suggested
  /v1/me/recent/played
  /v1/me/recent/played/tracks
  /v1/me/recent/radio-stations
  /v1/me/music-summaries/
  /v1/me/storefront
  /v1/me/account
  /v1/me/social/profile
  /v1/me/stations/continuous
  /v1/intelligence/playlists/ideas               (AI playlists)
  /v1/intelligence/playlists/edit
  /v1/editorial/
  /v1/reverseGeocode
  /v1/searchAutocomplete

amp-api.videos.apple.com                        # Apple TV+ (not needed)
  /v1/storefronts/{countryCode}/age-group-content-policies
```

### Authentication
```
gsa.apple.com
  /grandslam/GsService2/lookup                  # Apple ID SRP auth (GrandSlam)
  /auth/verify/device/key                       # 2FA device key verification

idmsa.apple.com
  /appleauth/auth/verify/device/key/challenge   # 2FA challenge

grandslam-it.apple.com, grandslam-uat.apple.com # Test environments only
```

### Playback / DRM
```
play.itunes.apple.com
  /WebObjects/MZPlay.woa/wa/getMusicSDKAuthorizationsSrv   # Webplayback M3U8 + MUT

bag.itunes.apple.com                            # iTunes Bag (endpoint directory)
  /bag.xml?ix=6

init.itunes.apple.com                           # Primary bag fetch
  /bag.xml?ix=6

[bag://fps-cert]        → Apple FPS server certificate URL
[bag://fps-request]     → FPS key request URL (Pastis license server)
[bag://enhanced-audio/hls-key-server-url] → Enhanced audio key server URL
[bag://sf-api-token-service-url]          → Media User Token endpoint
```

### CDN / Artwork
```
isq11.mzstatic.com                              # Primary artwork CDN
  /image/thumb/{hash}/{w}x{h}{c}.{f}
is2-ssl.mzstatic.com                            # Secure artwork CDN
aod-ssl.itunes.apple.com                        # CTR/AAC HLS segments CDN
aod.itunes.apple.com                            # CBCS/ALAC/Atmos HLS segments CDN
```

### Store / Finance
```
buy.itunes.apple.com
  /WebObjects/MZFinance.woa/wa/deviceLinkCreate
  /WebObjects/MZFinance.woa/wa/deviceLinkResult
finance-app.itunes.apple.com
  /sdkSubscribe
  /subscribe
librarydaap.itunes.apple.com                    # DAAP library sync
albert.apple.com
  /WebObjects/ALUnbrick.woa/wa/deviceActivation  # APNs device activation
```

### Deep Links / URI Schemes
```
musics://                                       # Apple Music deep link
music://                                        # Apple Music deep link
itms://                                         # iTunes legacy
music.apple.com/{locale}/lyrics/{adamId}?ts=&te=&l=&tk=  # Lyrics deep link
music.apple.com/x-pl-artist/{id}               # Artist deep link
```

---

## Appendix B — HLS Custom Tags Reference

Custom `EXT-X-SESSION-DATA` tags embedded in Apple Music HLS playlists (VERIFIED, Windows binary):

| Tag | Value type | Description |
|-----|-----------|-------------|
| `com.apple.hls.title` | String | Track title |
| `com.apple.hls.genre` | String | Genre |
| `com.apple.hls.release-date` | ISO8601 | Release date |
| `com.apple.hls.description` | String | Description |
| `com.apple.hls.duration` | Number | Total duration (seconds) |
| `com.apple.hls.rating-tag` | String | Rating tag |
| `com.apple.hls.rating-image` | URL | Rating badge image |
| `com.apple.hls.cs-rating` | String | Content rating string |
| `com.apple.hls.accessibility` | String | Accessibility info |
| `com.apple.hls.skip.{N}.start` | Number | Skip marker start (seconds) |
| `com.apple.hls.skip.{N}.duration` | Number | Skip marker duration |
| `com.apple.hls.skip.{N}.type` | String | Skip type (intro, credits, recap) |
| `com.apple.hls.skip.{N}.label` | String | Skip button label |
| `com.apple.hls.skip.{N}.target` | Number | Skip to position |
| `com.apple.hls.photosensitivity-info.*` | various | Photosensitivity warning |
| `com.apple.hls.up-next.start` | Number | "Up Next" panel show time |
| `com.apple.hls.audioAssetMetadata` | JSON | Audio asset metadata blob |

---

## Appendix C — Engine Config Fields (Flutter-relevant subset)

```yaml
# Optional override — engine reads MUT from session (MUSIC_TOKEN file) when this is empty
media-user-token: ""          # Leave blank to use session value; set explicitly to override

# Auto-fetched at startup (no action needed)
authorization-token: ""       # Bearer token; engine auto-fetches from music.apple.com

# Should be auto-detected after login
storefront: "us"              # Use /v1/me/storefront after MUT is set

# Quality preferences (expose in Flutter settings UI)
lrc-type: "lyrics"            # lyrics | syllable-lyrics
lrc-format: "lrc"             # lrc | ttml
alac-max: 192000              # Max ALAC sample rate
atmos-max: 2768               # Max Atmos bitrate
mv-max: 2160                  # Max music video height

# DRM backend (recommend: leave as default)
backend:
  preferred: auto             # auto | embedded | process
  fallback: process
```
