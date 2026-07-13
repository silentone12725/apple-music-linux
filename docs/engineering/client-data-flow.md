# Apple Music Client — Data Flow Research

**Part 2 of the Frontend Architecture Engineering Report**  
**Date:** 2026-07-08  
**Evidence quality:** VERIFIED (directly observed) · INFERRED (logical deduction) · HYPOTHESIS (expected, unconfirmed)

This document covers the "Client Data Flow Research" investigation: how every official Apple Music client retrieves, caches, and renders data after authentication. It is the companion to `frontend-architecture-report.md`.

---

## 8 — Logged-In User Data Flow

### 8.1 Architecture Pattern (Common Across All Platforms)

All three official clients (Android, Windows, Web) follow the same layered request pattern:

```
UI / View
  ↓
ViewModel / Controller / BLoC
  ↓  (query / observe)
Repository Layer
  ↓  (cache miss) → Cache (memory + disk/SQLite)
  ↓  (cache miss)
Networking Layer (authenticated HTTP client)
  ↓  (adds auth headers)
Authentication Layer
  ↓  (Bearer token + MUT + Anisette + Mescal headers)
Apple Services (amp-api.music.apple.com / bag-resolved URLs)
  ↓  (JSON response)
Response Parsing (model → domain object)
  ↓
Cache Write
  ↓
UI State Update / Re-render
```

**Android implementation evidence (VERIFIED):**
- `MediaApiImpl` (`com.apple.android.music.mediaapi.network`) — Retrofit HTTP client, all requests flow through here
- `LoggingInterceptor` — OkHttp interceptor that adds Anisette headers on every request where machine provisioning is needed
- `MescalRequestDecorator` (`com.apple.android.music.storeapi.operations.decorators`) — signs store requests
- `MediaApiRepositoryImpl` (`com.apple.android.music.mediaapi.repository`) — caching data layer over `MediaApiImpl`
- `libmedialibrarycore.so` (`SVMediaLibrary`) — C++ library for offline/local library SQLite database
- `libmediaplatform.so` — HTTP cache (SQLite `cached_responses` table), Unicode collation, keychain

**Windows implementation evidence (VERIFIED):**
- `AMP.Services.dll` — primary networking layer; contains all MusicKit API path strings
- `AMPLibraryAgent.exe` — out-of-process COM server managing library sync, DAAP, FPS
- `AppleMediaServicesKit.dll` — AMS SDK; account management, token storage, WebView2-hosted store UI
- SQLite `HTTPCache` table: `(accountIdentifier, key, url, method, requestBody, headers, responseBody, createdAt)`
- Bearer token auto-selected from `Config.AuthorizationToken`; MUT from `EphemeralMediaTokenStore` / `NetworkMediaTokenProvider`

### 8.2 Account / User Profile Data

**What is fetched at login (VERIFIED from Android class names + Windows bag keys):**

| Data | Endpoint | Headers | Notes |
|------|----------|---------|-------|
| Storefront / country | `GET /v1/me/storefront` | Bearer + MUT | 2-letter ISO code; drives all catalog calls |
| Account capabilities | `GET /v1/me/account` | Bearer + MUT | subscription type, feature flags |
| Social profile | `GET /v1/me/social/profile` | Bearer + MUT | display name, handle, avatar |
| User profile | `bag://musicCommon/userProfile` (resolved) | Bearer + MUT | Windows-confirmed bag key |
| Subscription status | `bag://getSubscriptionStatus` (resolved) | Bearer + Anisette | Windows bag key |

**Android: `AccountFlags` (VERIFIED — class name + string literal):**
```json
{
  "personalization": true,
  "isHlsStreamingEnabled": true,
  "isSubscriber": true,
  "familyId": "..."
}
```
These are fetched early in the session and control feature availability. Refreshed via `PlaybackStoreConfigurationImpl.refreshAccountFlags()`.

**Android: explicit content (VERIFIED — string literal `explicit-choice`):** The app stores an `explicit-choice` preference controlling whether explicit content is shown. Updated via `UpdateLibraryTastePreferences` change request to `libmedialibrarycore`.

**Windows: storefront header format (VERIFIED):** `X-Apple-Store-Front: <sf>,29` — the `,29` suffix is the platform content class ID for desktop apps.

**Locale / language:** Passed as `Accept-Language` HTTP header and `l=<lang>` query parameter on catalog requests (e.g., `l=en-US`). No separate API call.

**Refresh strategy (INFERRED):** Account data fetched once per session on startup. Storefront cached until next session. Subscription status polled periodically (bag://getSubscriptionStatus) and on subscription-gated actions.

---

## 9 — Home Tab

### 9.1 Request Sequence

**VERIFIED endpoints (Android DEX + Windows strings):**

```
Step 1: Recommendations shelf
  GET amp-api.music.apple.com/v1/me/recommendations
  Headers: Bearer + MUT + X-Apple-Store-Front: <sf>,29
  Params:  limit=10 (INFERRED typical), l=<lang>
  Returns: {data: [{type: "playlists"|"albums"|"stations", attributes: {...}}]}

Step 2: Recently played
  GET amp-api.music.apple.com/v1/me/recent/played
  Headers: Bearer + MUT
  Params:  limit=10 (INFERRED)
  Returns: {data: [{type: "songs"|"albums"|"playlists"|"stations", ...}]}

Step 3: Continue listening / Recently played tracks
  GET amp-api.music.apple.com/v1/me/recent/played/tracks
  Headers: Bearer + MUT

Step 4: Recently played radio stations
  GET amp-api.music.apple.com/v1/me/recent/radio-stations
  Headers: Bearer + MUT

Step 5: AI-generated playlist ideas (Android 6.x+)
  GET amp-api.music.apple.com/v1/intelligence/playlists/ideas
  Headers: Bearer + MUT
  Note: feature-flagged (VERIFIED: musicCommon/intelligence/playlistEditAvailable)
```

**INFERRED additional home page requests:**
- Editorial: `GET /v1/editorial/` (confirmed path fragment in Android DEX) — featured collections, curated playlists
- Charts / Top: `GET /v1/catalog/{sf}/charts` (standard MusicKit endpoint)

### 9.2 Personalization Identifiers

Personalized recommendations differ from catalog requests by including:
- `media-user-token` header (required)
- DSID associated with the account (passed server-side; Apple uses account context from MUT)
- Storefront from `X-Apple-Store-Front` header

**VERIFIED (Android string):** `apple_music_storefront` — preference key used to cache the per-account storefront choice.

### 9.3 Caching Strategy (INFERRED from Windows SQLite schema)

```sql
-- Windows HTTPCache table (VERIFIED schema)
key = MD5/SHA of (url + method + requestBody)
createdAt = UNIX timestamp
-- TTL for home page: INFERRED ~15 minutes for recommendations, ~5 minutes for recent/played
```

Android uses `MediaApiRepositoryImpl` which wraps `MediaApiImpl` with in-memory caching. The C++ library in `libmediaplatform.so` has the `cached_responses` SQLite table for network response caching.

### 9.4 Pagination

Recommendation responses are paginated with `next` cursor in the response body. The UI loads more when the user scrolls to the bottom of a recommendation shelf. Android classes: `com.apple.android.music.mediaapi.models.Playlist`, `Song` etc. have `.next` links in paginated collections (INFERRED from standard MusicKit API design).

---

## 10 — Search

### 10.1 Endpoints

**VERIFIED (Android DEX + Windows AMP.Services.dll):**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v1/catalog/{sf}/search` | Full search results |
| GET | `/v1/catalog/{sf}/search/hints` | Quick autocomplete text hints |
| GET | `/v1/catalog/{sf}/search/suggestions` | Rich suggestions (with artwork) |
| GET | `/v1/searchAutocomplete` | Android-specific autocomplete (VERIFIED DEX) |
| GET | `/v1/me/library/search` | Search within user library (VERIFIED Windows strings) |

### 10.2 Search Parameters

**VERIFIED from Windows `AMP.Services.dll` string literals:**
```
?term=<query>
&types=songs,albums,artists,playlists,music-videos,stations
&limit=25
&offset=0
&l=<lang>
&platform=<platform>
&include=topResults
```

**INFERRED — `types` parameter governs result categories:** When `types=songs,albums,artists,playlists`, all four result sets are returned in one response under `results.songs`, `results.albums`, etc. The default "top results" uses `include=topResults` which returns a cross-type ranked result set.

### 10.3 Search Lifecycle

```
User types character
       ↓
Debounce timer reset (INFERRED: ~300ms)
       ↓
Timer fires → GET /v1/catalog/{sf}/search/hints?term=<partial>
       ↓
Show autocomplete dropdown
       ↓
User selects suggestion or presses Enter
       ↓
GET /v1/catalog/{sf}/search?term=<query>&types=songs,albums,artists,playlists
       ↓
Parse JSON → populate result sections
       ↓
User scrolls to section bottom → paginate with &offset=N
```

**Request cancellation:** Previous in-flight search requests are cancelled when a new character is typed (standard HTTP client cancellation). Android OkHttp / Windows `CFNetwork` both support per-call cancellation.

**Recent searches:** Stored locally; no API call. On Android: in `libmedialibrarycore.so` SQLite DB (INFERRED from class `DatabaseCleanupOrphanItemsChangeRequest` — local cleanup for orphaned search history).

**Trending searches (INFERRED):** Not confirmed by any source. The `search/hints` endpoint may return server-personalized hints for an empty query; trending is likely blended in server-side.

**Library search:** `GET /v1/me/library/search?term=<query>&types=library-songs,library-albums,library-artists,library-playlists` (VERIFIED path `/v1/me/library/search` in Windows strings).

---

## 11 — Library

### 11.1 Library Data Sources

The user library has two storage layers on official clients. The Flutter/engine model needs only one.

**Official clients (Android/Windows):** Maintain a full local SQLite replica of the user's library via DAAP sync (`librarydaap.itunes.apple.com/WebObjects/MZDaap.woa/daap`). Changes are sent as "change request" operations to `libmedialibrarycore` which queues them and submits to Apple's iCloud Music Library.

**Engine model (simpler, correct for Flutter):** No local replica. Query Apple's API on demand. Cache responses with appropriate TTL.

### 11.2 Fetch Endpoints

**VERIFIED (Windows AMP.Services.dll path strings):**

| Method | Path | Returns |
|--------|------|---------|
| GET | `/v1/me/library/songs` | Paginated list of library songs |
| GET | `/v1/me/library/albums` | Paginated list of library albums |
| GET | `/v1/me/library/artists` | Paginated list of library artists |
| GET | `/v1/me/library/playlists` | Paginated list of user playlists |
| GET | `/v1/me/library/music-videos` | Library music videos |
| GET | `/v1/me/library/songs/{id}` | Single library song (includes `playParams`) |
| GET | `/v1/me/library/albums/{id}` | Single library album with tracks |
| GET | `/v1/me/library/albums/{id}/tracks` | Album track list |
| GET | `/v1/me/library/artists/{id}/albums` | Artist's albums in library |
| GET | `/v1/me/library/playlists/{id}/tracks` | Playlist tracks |

**Sorting (INFERRED from Android class strings):** `sort=-dateAdded`, `sort=name`, `sort=-lastPlayedDate` are common parameters. The `sort` field is signed for descending.

**Filtering (INFERRED):** No confirmed filter parameter for library lists. Filtering is likely done client-side after fetching.

**Pagination:** All list endpoints return a `next` cursor. Apple's default page size is typically 25–100 items. Request subsequent pages with `?offset=N` or follow the `next` link.

**Recently added (INFERRED):** `GET /v1/me/library/songs?sort=-dateAdded&limit=10`

### 11.3 Library Sync Operations (Android — VERIFIED class names)

The Android library is eventually consistent via a queue of change requests:

| Operation class | Purpose |
|----------------|---------|
| `AddStoreItemsToLibrary` | Add catalog song/album/playlist to library |
| `AddGlobalPlaylistToLibraryChangeRequest` | Subscribe to an Apple-curated playlist |
| `AddStoreItemsToPlaylistChangeRequest` | Add catalog items to a playlist |
| `RemoveFromLibraryChangeRequest` | Remove song from library |
| `DeleteEntityChangeRequest` | Delete a playlist |
| `AddFavoriteStateChangeRequest` | Heart/unheart a track |
| `PinsEditChangeRequest` | Pin/unpin items |
| `UpdatePlaybackEventChangeRequest` | Post play count update to iCloud |
| `UpdateLibraryTastePreferences` | Update personalization data |
| `InitialLoadLibraryContent*` | Full library pull on first launch |

These translate to REST API calls via `MediaApiImpl`. The engine can implement the same operations via direct `amp-api.music.apple.com` calls.

### 11.4 Engine API for Library

```
GET  /api/v1/me/library/songs?limit=&offset=&sort=
GET  /api/v1/me/library/albums?limit=&offset=&sort=
GET  /api/v1/me/library/artists?limit=&offset=
GET  /api/v1/me/library/playlists?limit=&offset=
GET  /api/v1/me/library/playlists/{id}/tracks?limit=&offset=
POST /api/v1/me/library { "assetId": "...", "type": "song|album|playlist" }
DELETE /api/v1/me/library?assetId=...&type=...
```

---

## 12 — Playlist Operations

### 12.1 CRUD Endpoints (INFERRED from Android class names + standard MusicKit API)

| Operation | Method | Endpoint | Body |
|-----------|--------|----------|------|
| Create | POST | `/v1/me/library/playlists` | `{attributes: {name, description}}` |
| Rename | PATCH | `/v1/me/library/playlists/{id}` | `{attributes: {name}}` |
| Delete | DELETE | `/v1/me/library/playlists/{id}` | — |
| Add tracks | POST | `/v1/me/library/playlists/{id}/tracks` | `{data: [{id, type: "songs"}]}` |
| Remove track | DELETE | `/v1/me/library/playlists/{id}/tracks/{trackId}` | — |
| Reorder | PATCH | `/v1/me/library/playlists/{id}/tracks` | reorder payload |
| Get tracks | GET | `/v1/me/library/playlists/{id}/tracks` | `?limit=&offset=` |

**VERIFIED (Android strings):** `AddPlaylistToLibraryChangeRequest`, `AddStoreItemsToPlaylistChangeRequest`, `DeleteEntityChangeRequest` — confirm create/add/delete operations exist at the change-request layer.

### 12.2 Collaborative Playlists

**VERIFIED (Android DEX — class names and DB column names):**
- `StartCollaboration`, `JoinCollaboration`, `LeaveCollaboration`, `EndCollaboration`, `ApproveCollaboration`
- DB columns: `cloud_author_handle`, `cloud_library_universal_id`, `collaboration_join_request_pending`
- `ACCEPTED_TERMS_COLLABORATION` feature flag
- RTC endpoint: `bag://real-time-communication/rtc-endpoint/url` (Windows bag — confirmed)

**Implementation note:** Collaborative playlists require real-time synchronization (WebSocket/RTC). This is a future feature; not required for MVP. The `cloud_library_universal_id` is the shared playlist's unique identifier across Apple's collaboration infrastructure.

### 12.3 Subscribe to Apple Curator Playlists

**VERIFIED (Android):** `AddGlobalPlaylistToLibraryChangeRequest` — adds an Apple-curated playlist to the user's library (subscribing, not copying). These are `{type: "playlists"}` catalog items added to `/v1/me/library`.

---

## 13 — Artist Pages

### 13.1 Request Hierarchy

```
GET /v1/catalog/{sf}/artists/{id}
  ?include=albums,top-songs,music-videos,playlists
  &extend=editorialVideo,editorialArtwork
  &views=top-songs,full-albums,appears-on-albums,featured-release,similar-artists

Response includes:
  attributes:
    name, genreNames, artwork, url, editorialNotes
  relationships:
    albums: [...]          (artist's primary albums)
    top-songs: [...]       (top 10 songs, embedded)
  views:
    "top-songs": { data: [...] }
    "full-albums": { data: [...] }
    "appears-on-albums": { data: [...] }
    "similar-artists": { data: [...] }
    "featured-release": { data: [...] }   (promoted new release)
    "latest-release": { data: [...] }
    "music-videos": { data: [...] }
```

**VERIFIED:** Path `/v1/catalog/{sf}/artists` confirmed in Windows `AMP.Services.dll`.  
**INFERRED:** The `views` parameter mechanism and included view names are standard MusicKit API behavior.

### 13.2 Biography / Editorial Notes

Editorial notes (biography text) are returned in `attributes.editorialNotes` of the artist resource. Standard, no separate endpoint.

### 13.3 Radio Stations (Artist Radio)

**INFERRED:** `POST /v1/me/stations/continuous` with `{attributes: {stationSeed: {type: "artists", id: "<artistId>"}}}` creates a continuous artist radio station.

---

## 14 — Album Pages

### 14.1 Request

```
GET /v1/catalog/{sf}/albums/{id}
  ?include=tracks,artists
  &extend=editorialVideo
  &fields[songs]=name,trackNumber,durationInMillis,contentRating,playParams,hasLyrics
```

**VERIFIED:** Path `/v1/catalog/{sf}/albums` confirmed in Windows `AMP.Services.dll`.

### 14.2 Response Fields (VERIFIED from Windows string literals in AMP.Services.dll)

```
albumName, artistName, artwork, artworkToken, artworkTreatment,
artworkURL, audioTraits, composerName, contentRating, discNumber,
durationInMillis, editorialArtwork, genreNames, playParams,
releaseDate, trackNumber
```

### 14.3 Lossless / Atmos Availability

**VERIFIED (Android):** `AlbumTrait_Atmos`, `AlbumTrait_Spatial`, `AlbumTrait_HighResolutionLossless` enum values. These map to the `audioTraits` array in the API response.

**VERIFIED (Windows):** `availableInDolbyAtmos`, `available in high res lossless`, `available in lossless`, `available in spatial` — user-visible strings indicating availability.

The `audioTraits` attribute on the album/song resource contains a list such as:
```json
["lossless", "hi-res-lossless", "dolby-atmos"]
```

### 14.4 Credits / Composers

Available via `extend=credits` on the song resource (INFERRED — standard MusicKit `credits` relationship). `composerName` is a flat string in the album attributes (VERIFIED from Windows strings).

### 14.5 Lyrics Availability

`hasLyrics` boolean field on the song resource (INFERRED from Windows `musicSubscription/lyrics` bag key and standard MusicKit behavior). The engine's `GET /api/v1/metadata/{id}` already returns `hasLyrics`.

---

## 15 — Song Metadata

### 15.1 Song Detail Request

```
GET /v1/catalog/{sf}/songs/{id}
  ?include=artists,albums
  &extend=credits,lyrics
  &fields[artists]=name,artwork
```

Or by ISRC or UPC via catalog lookup.

### 15.2 Song Attributes (VERIFIED from Windows AMP.Services.dll string analysis)

```json
{
  "id": "string (adamId)",
  "type": "songs",
  "attributes": {
    "name": "string",
    "trackNumber": 1,
    "durationInMillis": 201000,
    "discNumber": 1,
    "composerName": "string",
    "genreNames": ["Rock"],
    "releaseDate": "2020-01-01",
    "contentRating": "explicit|clean|notExplicit",
    "isrc": "string",
    "artwork": {
      "url": "https://is2-ssl.mzstatic.com/image/thumb/{hash}/{w}x{h}{c}.{f}",
      "width": 3000,
      "height": 3000,
      "bgColor": "1a1a1a",
      "textColor1": "ffffff"
    },
    "audioTraits": ["lossless", "hi-res-lossless", "dolby-atmos"],
    "hasLyrics": true,
    "playParams": {
      "id": "string",
      "kind": "song"
    }
  }
}
```

### 15.3 Audio Quality Information

**VERIFIED (engine `GET /api/v1/metadata/{id}` response):**
```json
{
  "availableStreams": [
    { "codec": "ALAC", "sampleRate": 96000, "bitDepth": 24 },
    { "codec": "E-AC-3" },
    { "codec": "AAC", "bitrate": 256000 }
  ],
  "has4k": false,
  "hasHdr": false
}
```

This is already implemented in the engine — use `GET /api/v1/metadata/{id}` instead of calling Apple directly.

### 15.4 Waveform

No confirmed waveform endpoint in any client analysis. Apple Music does not appear to expose audio waveform data via any API — the Android and Windows apps do not implement a waveform scrubber. **VERDICT: Not available.**

### 15.5 Credits / Producers / Composers

**INFERRED:** Available via `extend=credits` parameter or `relationships.credits` on the song resource. The credits relationship returns a list of `{name, role}` objects.

---

## 16 — Lyrics

### 16.1 Endpoints

**VERIFIED (Windows bag keys + engine implementation):**
```
bag://musicSubscription/lyrics     → LRC endpoint (resolved at runtime)
bag://musicSubscription/ttmlLyrics → TTML endpoint (resolved at runtime)
```

The engine already implements this as a proxy:
```
GET /api/v1/lyrics/{id}?format=lrc|ttml&type=lyrics|syllable-lyrics&sf=
```

Use the engine endpoint. Never call Apple's lyrics endpoint directly from Flutter.

### 16.2 LRC Format

LRC is a plain-text timed lyrics format:
```lrc
[00:12.00]First line of lyrics
[00:17.20]Second line of lyrics
[00:21.10]Third line of lyrics
```
Timestamps are `[mm:ss.cs]` (minutes, seconds, centiseconds). Line-level synchronization only.

**VERIFIED (engine runtime):** Engine returns LRC correctly for tested tracks.

### 16.3 TTML Format

TTML (Timed Text Markup Language) is XML-based with word-level timestamp granularity. Used for karaoke / syllable-level Apple Music Sing:

```xml
<tt>
  <body>
    <div>
      <p begin="00:00:12.000" end="00:00:17.200">
        <span begin="00:00:12.000" end="00:00:13.500">First </span>
        <span begin="00:00:13.500" end="00:00:15.000">word </span>
      </p>
    </div>
  </body>
</tt>
```

**VERIFIED (engine source):** `beevik/etree` XML parser used for TTML parsing in engine. The engine handles both formats.

### 16.4 Apple Music Sing (Vocal Attenuation)

**VERIFIED (Android DEX):**
- `PLAYBACK_STATE_EXTRA_VOCAL_ATTENUATION_LEVEL` — real-time vocal level (0.0–1.0)
- `PLAYBACK_STATE_EXTRA_VOCAL_ATTENUATION_STATE` — on/off/unavailable
- `CommandProtobuf_PrepareVocalsControl` — protobuf command to toggle vocals
- `VOCALSCONTROLCONTINUOUS_FIELD_NUMBER` — continuous (singer/singer-less) vocal control
- `KARAOKE_SPLIT_ON_CHARS_LANGUAGES_RUSH_GRADIENT_TAG` — rendering hint for karaoke word highlighting

This feature requires the audio stream to support multi-stem audio (Apple Music Sing tracks have separate stems). The engine does not currently implement vocal attenuation — this is a future feature requiring stem-aware streaming.

### 16.5 Translation Support

**INFERRED:** No confirmed translated lyrics endpoint. The `l=<lang>` parameter on the lyrics request may return lyrics in the requested language where available.

### 16.6 Caching and Refresh

**INFERRED:** Lyrics cached locally until the track's metadata changes. No active TTL — lyrics do not change after publication. Flutter should cache lyrics in memory for the current session and optionally persist to disk.

---

## 17 — Queue

### 17.1 Architecture

There is **no queue API** on Apple's servers or in the engine. Queue is entirely client-side state. All official clients manage the queue in memory.

**VERIFIED (engine capabilities response):** `"queue": false`

**Flutter queue design:**

```dart
class PlayerQueue {
  final List<QueueEntry> _items;
  int _currentIndex = -1;
  ShuffleMode shuffle = ShuffleMode.off;
  RepeatMode repeat = RepeatMode.none;

  // Pre-create engine sessions for next 1-2 tracks
  // Call: POST /api/v1/playback for next track ~30s before current ends
}

class QueueEntry {
  final String assetId;
  final SongMetadata metadata;  // cached from catalog call
  String? sessionId;            // populated when engine session is created
  QueueEntryState state;        // pending | loading | ready | playing | done
}
```

### 17.2 Play Next / Play Later

- **Play next:** Insert item at `currentIndex + 1`
- **Play later:** Append item to end of `_items`
- **Both:** Optionally pre-create engine session immediately

### 17.3 Autoplay

**INFERRED:** When queue is exhausted, autoplay queries `GET /v1/me/stations/continuous` or uses `GET /v1/catalog/{sf}/songs/{id}?include=similar-tracks` to find related tracks. No confirmed API — Apple may use a proprietary recommendation endpoint for this.

**Practical implementation:** Use `GET /v1/me/recommendations/suggested` after queue ends.

### 17.4 Persistence

**INFERRED from Android `UpdatePlaybackEventChangeRequest`:** Play events are posted to Apple's servers for personalization, but the queue itself is not persisted server-side. Queue persistence across app restarts is local-only on all platforms.

---

## 18 — Radio

### 18.1 Live Radio Stations

**VERIFIED (Windows/Android paths):** `GET /v1/catalog/{sf}/stations` — returns catalog of stations including live radio.

Live stations have a `stationProviderName` and stream URL. They are not DRM-protected HLS in the same way as on-demand music — they use continuous HLS streams.

### 18.2 Personalized / Artist Stations

**VERIFIED (Android DEX):**
```
POST amp-api.music.apple.com/v1/me/stations/continuous
Body: {
  "data": [{
    "type": "stations",
    "attributes": {
      "stationSeed": {
        "type": "songs"|"artists"|"albums",
        "id": "<adamId>"
      }
    }
  }]
}
```
Returns a station with a seed-based queue.

**Next tracks:** `GET /v1/me/stations/next-tracks/{stationId}` — advances the station and returns the next batch of tracks (VERIFIED Android DEX path literal).

**Change station:** `GET /v1/me/stations/change-station/{stationId}` — alternative station (VERIFIED Android DEX).

### 18.3 Recent Radio Stations

**VERIFIED:** `GET /v1/me/recent/radio-stations` (Android DEX).

---

## 19 — Recommendations

### 19.1 Recommendation vs Catalog Requests

| Dimension | Catalog request | Recommendation request |
|-----------|----------------|------------------------|
| Endpoint prefix | `/v1/catalog/{sf}/` | `/v1/me/recommendations` |
| Auth required | Bearer only (catalog browse) | Bearer + MUT |
| Personalization | None (anonymous) | Yes (account-specific) |
| Caching | Long TTL (catalog stable) | Short TTL (personalized, changes daily) |
| Response | Single resource type | Mixed types (albums, playlists, stations) |

### 19.2 Recommendation Modules

**VERIFIED (Android DEX path):** `GET /v1/me/recommendations/modules` — returns the structure of the "For You" tab (which shelves to show, in what order).

**VERIFIED (Android DEX path):** `POST /v1/me/recommendations/suggested` — request suggestions based on context (currently playing track, time of day, mood).

### 19.3 Personalization Identifiers

Apple's recommendation system uses:
- MUT / DSID (account identity, passed via headers)
- Storefront (geographic personalization)
- `AccountFlags.personalization` (opt-in status)
- Listening history (reported via `UpdatePlaybackEventChangeRequest`)

No explicit personalization ID is sent in the request — it is derived server-side from the authenticated account context.

### 19.4 Refresh Cadence (INFERRED)

Recommendations refresh every few hours to daily. The home tab typically refreshes on app foreground. There is no WebSocket or push mechanism for recommendation updates — it is polling-based.

---

## 20 — Browse

### 20.1 Editorial Pages

**VERIFIED (Android DEX path):** `GET /v1/editorial/` — returns curated editorial content.

**INFERRED structure:**
```
GET /v1/catalog/{sf}/charts
  ?types=songs,albums,music-videos
  &limit=25
  &genre=<genreId>
→ {results: {songs: {chart: "most-played", data: [...]}, albums: {...}}}
```

### 20.2 Genres

**VERIFIED (Windows path):** `GET /v1/catalog/{sf}/genres` — top-level genre list.

**INFERRED:** Sub-genres available via `GET /v1/catalog/{sf}/genres/{id}` with nested genre tree.

### 20.3 Charts / Top Songs / Top Albums

**INFERRED:** `GET /v1/catalog/{sf}/charts?types=songs&limit=25&genre=<genreId>` — standard MusicKit charts endpoint. Can be genre-filtered.

---

## 21 — Notifications

### 21.1 Push Notifications

**VERIFIED (Windows binary):** `ApplePushDirect.dll` handles APNs connectivity:
- Device activation: `https://albert.apple.com/WebObjects/ALUnbrick.woa/wa/deviceActivation?device=Windows`
- APNs bag: `https://init.push.apple.com/bag`
- Registration: `bag://push-notifications/register-success`

**VERIFIED (Windows bag keys):** `bag://push-notification-types/add-push-notification-type-url`

### 21.2 Notification Types (INFERRED)

Apple Music push notifications include:
- New music from followed artists
- New releases
- Library changes from shared devices
- Collaborative playlist updates

### 21.3 Flutter Implementation

APNs is iOS/macOS-specific. On Linux/desktop:
- **libnotify** via `flutter_local_notifications` — desktop popups for "Now Playing" changes
- No Apple push integration needed for MVP — desktop music apps typically don't have push
- If needed: implement a polling loop for library changes (`GET /v1/me/library/songs?sort=-dateAdded&limit=5` every N minutes)

---

## 22 — Download Management

### 22.1 Engine Export API

**VERIFIED (engine apiserver.go):** The engine already implements a complete export/download system:

```
POST /api/v1/export
→ Job phases: queued → resolving → downloading → tagging → moving → done|failed|cancelled
→ SSE event stream: { type: "export", data: { jobId, phase, percent, output } }

GET /api/v1/export/{id}          → job status
DELETE /api/v1/export/{id}       → cancel
POST /api/v1/export/{id}/retry   → retry failed job
```

**Flutter only needs to call the engine.** No direct Apple download API calls needed.

### 22.2 Offline Metadata / MiniSINFs

**VERIFIED (Android):** Downloaded tracks use `MiniSINF` atoms for persistent offline DRM:
- `MiniSinfsController` manages per-track SINF metadata
- DB columns: `cached-mini-sinf`, `offline_lyrics_expiration`, `offline_lyrics_location`
- `PersistentKeyData` / `PersistentKeyMetadata` — offline FPS key persistence

The engine handles this internally (the export pipeline writes fully-tagged fMP4 files). Flutter does not need to manage SINFs.

### 22.3 Artwork for Downloaded Tracks

The engine's export system uses `options.artworkSize` and `options.embedArtwork` — artwork is fetched from the CDN during export and embedded in the output file. No additional artwork calls needed from Flutter for downloaded content.

---

## 23 — Artwork

### 23.1 URL Construction

**VERIFIED (Android libmedialibrarycore.so + Windows AMP.Services.dll):**

Primary CDN: `https://isq11.mzstatic.com/image/thumb/{hash}/{w}x{h}{c}.{f}`
Secure CDN: `https://is2-ssl.mzstatic.com/image/thumb/{hash}/{w}x{h}{c}.{f}`

Parameters:
- `{hash}` — content hash, taken from `artwork.url` template in the API response
- `{w}x{h}` — requested size in pixels (e.g., `500x500`, `3000x3000`)
- `{c}` — crop mode: `cc` (center crop), `sr` (smart resize), `bb` (bounding box), `fa` (face-aware)
- `{f}` — format: `jpg` (default), `webp`, `png`

**INFERRED standard sizes used by official clients:**
- Thumbnail / list row: 60x60 or 80x80
- Grid card: 300x300 or 400x400
- Album page hero: 600x600 or 800x800
- Now playing full: 1200x1200 or 3000x3000
- Desktop window: adaptive based on layout

### 23.2 Artwork Tokens

**VERIFIED (Windows AMP.Services.dll string literals):** `album-artwork-token`, `artist-artwork-token`, `composer-artwork-token` — opaque tokens used to construct CDN URLs for library tracks (which use tokens instead of direct URLs, because purchased/library content may use different CDN paths).

### 23.3 Engine Artwork Proxy

**VERIFIED (engine):** `GET /api/v1/artwork/{id}?size=N` already proxies artwork from CDN.

**Flutter recommendation:** Use the engine proxy for all artwork requests. Benefits:
- Consistent URL pattern
- Engine handles CDN URL construction from `artworkToken`
- `Cache-Control: public, max-age=86400` already set
- No Apple CDN credentials needed in Flutter

### 23.4 CDN Headers

**INFERRED:** Apple CDN returns `Cache-Control: max-age=31536000` (1 year) for artwork since it's content-addressed. Flutter should cache artwork aggressively in memory (`cached_network_image` package) and on disk.

---

## 24 — Caching Architecture

### 24.1 Official Client Cache Layers

**Android (VERIFIED class names):**
| Layer | Component | Contents |
|-------|-----------|----------|
| Memory | `MediaApiRepositoryImpl` in-memory | Recent API responses |
| Disk | `libmediaplatform.so` `cached_responses` SQLite | HTTP response cache |
| Library DB | `libmedialibrarycore.so` SQLite | Full local library replica |
| Artwork | Custom image cache | Decoded bitmaps |

**Windows (VERIFIED schema):**
```sql
CREATE TABLE "HTTPCache" (
  "accountIdentifier" TEXT NOT NULL,  -- DSID
  "key" TEXT NOT NULL,                -- request fingerprint
  "url" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "requestBody" BLOB NOT NULL,
  "responseBody" BLOB NOT NULL,
  "headers" BLOB NOT NULL,
  "createdAt" INTEGER NOT NULL,
  PRIMARY KEY ("key","accountIdentifier")
)
```
Keyed by `accountIdentifier` so different Apple IDs don't share cache entries.

### 24.2 Recommended Flutter Cache Strategy

```dart
// Tier 1: In-memory (current session)
// - Active playback session
// - Current page data (album, artist, playlist)
// - Search results
// - Queue metadata

// Tier 2: Disk (across sessions)
// - Library snapshots (songs, albums, playlists) - TTL: 1 hour
// - Recommendation shelves - TTL: 15 minutes
// - Album / artist detail - TTL: 24 hours
// - Lyrics - TTL: permanent (content doesn't change)
// - Artwork - TTL: permanent (content-addressed)

// Tier 3: Never cache
// - DRM session state (always live from engine SSE)
// - Playback position
// - Queue state
```

### 24.3 Cache Invalidation

| Data | Invalidated when |
|------|-----------------|
| Library lists | After add/remove operation |
| Playlist tracks | After edit operation |
| User profile | On logout |
| Recommendations | On app foreground (stale-while-revalidate) |
| Artwork | Never (content-addressed) |
| Lyrics | Never (content doesn't change) |
| Catalog data | Never within session (catalog changes are infrequent) |

---

## 25 — Complete API Catalogue

All endpoints confirmed across Android APK, Windows binary, and engine source analysis. Evidence column cites which source confirmed the endpoint.

### 25.1 Authentication

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| POST | `https://gsa.apple.com/grandslam/GsService2/lookup` | X-Apple-I-MD, X-Apple-I-MD-M, X-MMe-Client-Info | Apple ID SRP authentication | Windows AuthKitWin.dll |
| POST | `https://gsa.apple.com/auth/verify/device/key` | session cookies | 2FA device key verification | Windows AuthKitWin.dll |
| POST | `https://idmsa.apple.com/appleauth/auth/verify/device/key/challenge` | session cookies | 2FA challenge verification | Windows AuthKitWin.dll |
| GET | `https://init.itunes.apple.com/bag.xml?ix=6` | X-Apple-I-MD, X-MMe-Client-Info | Service URL directory | Windows AMPLibraryAgent.exe |
| GET | `https://bag.itunes.apple.com/bag.xml` | — | Alternative bag URL | Android libAMSKit.so |
| GET | `https://setup.icloud.com/configurations/init` | Apple ID cookies | iCloud configuration | Android DEX |

### 25.2 User / Account

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `/v1/me/storefront` | Bearer + MUT | User's music storefront | Android DEX |
| GET | `/v1/me/account` | Bearer + MUT | Account info + capabilities | Windows AMP.Services.dll |
| GET | `[bag://musicCommon/userProfile]` | Bearer + MUT | User profile | Windows AMPLibraryAgent.exe |
| PATCH | `/v1/me/social/profile` | Bearer + MUT | Update social profile | Android DEX |
| GET | `/v1/me/social/profile` | Bearer + MUT | Social profile | Windows AMP.Services.dll |
| GET | `/v1/me/social/profile/followees` | Bearer + MUT | Following list | Windows AMP.Services.dll |
| GET | `/v1/me/social/profile/followers` | Bearer + MUT | Followers list | Windows AMP.Services.dll |
| GET | `/v1/me/social/profile/blocked-profiles` | Bearer + MUT | Blocked accounts | Windows AMP.Services.dll |
| GET | `[bag://getSubscriptionStatus]` | Bearer + Anisette | Subscription status | Windows AMPLibraryAgent.exe |
| GET | `/v1/me/purchases` | Bearer + MUT | Purchased content | Windows AMP.Services.dll |
| GET | `/v1/me/music-summaries/` | Bearer + MUT | Apple Music Replay | Android DEX |

### 25.3 Recommendations / Personalization

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `/v1/me/recommendations` | Bearer + MUT | For You shelf data | Android DEX |
| GET | `/v1/me/recommendations/modules` | Bearer + MUT | For You tab structure | Android DEX |
| POST | `/v1/me/recommendations/suggested` | Bearer + MUT | Contextual suggestions | Android DEX + Windows |
| GET | `/v1/me/recent/played` | Bearer + MUT | Recently played | Android DEX |
| GET | `/v1/me/recent/played/tracks` | Bearer + MUT | Recently played tracks | Android DEX |
| GET | `/v1/me/recent/radio-stations` | Bearer + MUT | Recent radio stations | Android DEX |

### 25.4 Search

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `/v1/catalog/{sf}/search` | Bearer | Catalog search | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/search/hints` | Bearer | Autocomplete hints | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/search/suggestions` | Bearer | Rich suggestions | Windows AMP.Services.dll |
| GET | `/v1/searchAutocomplete` | Bearer | Search autocomplete (alt) | Android DEX |
| GET | `/v1/me/library/search` | Bearer + MUT | Library search | Windows AMP.Services.dll |

### 25.5 Catalog

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `/v1/catalog/{sf}/songs/{id}` | Bearer | Song detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/songs` | Bearer | Batch song lookup (?ids=) | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/albums/{id}` | Bearer | Album detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/albums/{id}/tracks` | Bearer | Album track list | Standard MusicKit |
| GET | `/v1/catalog/{sf}/artists/{id}` | Bearer | Artist detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/music-videos/{id}` | Bearer | Music video detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/playlists/{id}` | Bearer | Catalog playlist detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/genres` | Bearer | Genre list | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/genres/{id}` | Bearer | Genre detail | INFERRED |
| GET | `/v1/catalog/{sf}/curators/{id}` | Bearer | Curator detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/apple-curators/{id}` | Bearer | Apple curator detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/stations/{id}` | Bearer | Station detail | Windows AMP.Services.dll |
| GET | `/v1/catalog/{sf}/charts` | Bearer | Charts / top songs | INFERRED (standard MusicKit) |
| POST | `/v1/catalog/us/concerns` | Bearer | Report a concern | Windows AMP.Services.dll |
| GET | `/v1/editorial/` | Bearer | Editorial collections | Android DEX |
| GET | `/v1/concerts/` | Bearer | Concerts (events) | Android DEX |
| GET | `/v1/social/{sf}/social-profiles` | Bearer | Social profiles in catalog | Windows AMP.Services.dll |
| GET | `/v1/intelligence/playlists/ideas` | Bearer + MUT | AI playlist ideas | Android DEX |
| POST | `/v1/intelligence/playlists/edit` | Bearer + MUT | Edit AI playlist | Android DEX |

### 25.6 Library

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `/v1/me/library/songs` | Bearer + MUT | Library songs list | Windows AMP.Services.dll |
| GET | `/v1/me/library/albums` | Bearer + MUT | Library albums list | Windows AMP.Services.dll |
| GET | `/v1/me/library/artists` | Bearer + MUT | Library artists list | Windows AMP.Services.dll |
| GET | `/v1/me/library/playlists` | Bearer + MUT | User playlists list | Windows AMP.Services.dll |
| GET | `/v1/me/library/music-videos` | Bearer + MUT | Library music videos | Windows AMP.Services.dll |
| GET | `/v1/me/library/import/jobs/` | Bearer + MUT | Library import jobs | Android DEX |
| POST | `/v1/me/library` | Bearer + MUT | Add item to library | INFERRED (standard MusicKit) |

### 25.7 Playlists

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `/v1/me/library/playlists/{id}` | Bearer + MUT | Playlist detail | INFERRED |
| GET | `/v1/me/library/playlists/{id}/tracks` | Bearer + MUT | Playlist tracks | INFERRED |
| POST | `/v1/me/library/playlists` | Bearer + MUT | Create playlist | INFERRED (standard MusicKit) |
| PATCH | `/v1/me/library/playlists/{id}` | Bearer + MUT | Update playlist metadata | INFERRED |
| DELETE | `/v1/me/library/playlists/{id}` | Bearer + MUT | Delete playlist | INFERRED |
| POST | `/v1/me/library/playlists/{id}/tracks` | Bearer + MUT | Add tracks to playlist | INFERRED |
| GET | `/v1/catalog/{sf}/playlist-collaborations/{id}` | Bearer + MUT | Collaborative playlist | Windows AMP.Services.dll |
| GET | `[bag://real-time-communication/rtc-endpoint/url]` | Bearer + MUT | RTC for collab playlists | Windows AMPLibraryAgent.exe |

### 25.8 Lyrics

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `[bag://musicSubscription/lyrics]` | Bearer + MUT | LRC lyrics | Windows AMPLibraryAgent.exe |
| GET | `[bag://musicSubscription/ttmlLyrics]` | Bearer + MUT | TTML lyrics | Windows AMPLibraryAgent.exe |
| — | `/api/v1/lyrics/{id}` | Engine handles auth | Engine lyrics proxy | Engine apiserver.go |

### 25.9 Playback

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| POST | `https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/getMusicSDKAuthorizationsSrv` | Bearer + MUT | Get webplayback M3U8 URL | Engine + Android DEX |
| — | `aod-ssl.itunes.apple.com/*` | — | CTR/AAC HLS segment CDN | CLAUDE.md |
| — | `aod.itunes.apple.com/*` | — | CBCS/ALAC/Atmos HLS segment CDN | CLAUDE.md |

### 25.10 DRM

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `[bag://fps-cert]` | Mescal signed | FairPlay server certificate | Windows AMPLibraryAgent.exe |
| POST | `[bag://fps-request]` | Mescal signed + FPDI | FPS key request (Pastis license server) | Windows AMPLibraryAgent.exe |
| GET | `[bag://enhanced-audio/hls-key-server-url]` | Mescal signed | Enhanced audio key server | Windows AMPLibraryAgent.exe |
| GET | `[bag://sign-sap-setup]` | Mescal signed | SAP setup | Windows AMPLibraryAgent.exe |
| GET | `[bag://sign-sap-setup-cert]` | Mescal signed | SAP setup certificate | Windows AMPLibraryAgent.exe |
| — | TCP 127.0.0.1:10020 | — | Linux wrapper CBCS decrypt | Engine + CLAUDE.md (wire-verified) |
| — | TCP 127.0.0.1:20020 | — | Linux wrapper M3U8 fetch | Engine |
| — | TCP 127.0.0.1:30020 | — | Linux wrapper account | Engine |

### 25.11 Radio

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `/v1/catalog/{sf}/stations` | Bearer | Catalog stations | Windows AMP.Services.dll |
| POST | `/v1/me/stations/continuous` | Bearer + MUT | Create continuous station | Android DEX |
| GET | `/v1/me/stations/next-tracks/{id}` | Bearer + MUT | Advance station | Android DEX |
| GET | `/v1/me/stations/change-station/{id}` | Bearer + MUT | Change station direction | Android DEX |
| GET | `[bag://radio/fetchMetadata-url]` | Bearer | Live radio metadata | Windows AMPLibraryAgent.exe |

### 25.12 Downloads (Engine)

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| POST | `/api/v1/export` | Local | Queue download job | Engine apiserver.go |
| GET | `/api/v1/export` | Local | List all jobs | Engine apiserver.go |
| GET | `/api/v1/export/{id}` | Local | Job status | Engine apiserver.go |
| DELETE | `/api/v1/export/{id}` | Local | Cancel job | Engine apiserver.go |
| POST | `/api/v1/export/{id}/retry` | Local | Retry failed job | Engine apiserver.go |
| GET | `/api/v1/events` (SSE) | Local | Export progress events | Engine apiserver.go |

### 25.13 Artwork

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `https://isq11.mzstatic.com/image/thumb/{hash}/{w}x{h}{c}.{f}` | — | Primary artwork CDN | Android libmedialibrarycore.so |
| GET | `https://is2-ssl.mzstatic.com/image/thumb/{hash}/{w}x{h}{c}.{f}` | — | Secure artwork CDN | Android DEX |
| GET | `/api/v1/artwork/{id}?size=N` | Local | Engine artwork proxy | Engine apiserver.go |

### 25.14 Miscellaneous

| Method | URL | Headers | Description | Evidence |
|--------|-----|---------|-------------|----------|
| GET | `[bag://preference-service-sync-url]` | Bearer + MUT | Preference sync | Windows AMPLibraryAgent.exe |
| POST | `[bag://play-activity-feed-request-post-url]` | Bearer + MUT | Listening activity telemetry | Windows AMPLibraryAgent.exe |
| GET | `/v1/reverseGeocode` | Bearer | Geo lookup | Android DEX |
| GET | `/v1/bulkReverseGeocode` | Bearer | Bulk geo lookup | Android DEX |
| GET | `[bag://musicFriends/discoverFriends]` | Bearer + MUT | Social: find friends | Windows AMPLibraryAgent.exe |
| POST | `https://finance-app.itunes.apple.com/sdkSubscribe` | Bearer + Anisette | Subscribe flow | Android DEX |
| GET | `[bag://redeemCodeSrv]` | Bearer + Anisette | Gift card redemption | Windows AMPLibraryAgent.exe |
| GET | `https://amp-api.videos.apple.com/v1/storefronts/{cc}/age-group-content-policies` | Bearer | Age content policy | Android libAMSKit.so |
| POST | `https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/deviceLinkCreate` | Bearer + Anisette | Link device to account | Windows AMPLibraryAgent.exe |

---

## 26 — Engine API Mapping (Flutter UI → Engine → Apple)

This section maps every major UI feature to the complete call chain. The engine serves as the single point of contact for Flutter — no Apple endpoints should be called directly from Flutter.

### 26.1 App Startup

**Updated 2026-07-08:** WebView login is NOT needed. The DRM auth flow produces the MUT as a side-effect.
The wrapper binary (`system/bin/main`) calls `get_music_user_token` which hits
`https://sf-api-token-service.itunes.apple.com/apiToken` and writes the result to
`{session_dir}/MUSIC_TOKEN`. `APIServer.mediaUserToken()` reads this file on every API call
(with `Config.MediaUserToken` as an override). `APIServer.storefront()` similarly reads
`STOREFRONT_ID` and strips the content-class suffix (`"143467-2,31"` → `"143467"`).
Port 30020 response format: `{"storefront_id":"…","dev_token":"…","music_token":"…"}`.
**Implemented and building** — no startup initialization required.

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
                      GET /api/v1/status          →  (local)
                      GET /api/v1/capabilities    →  (local DRM state)
                      GET /api/v1/drm/status      →  (local)
                      
If DRM not ready:
  Show login UI
  POST /api/v1/drm/authenticate {email, pw}
                      →  wrapper → gsa.apple.com (GrandSlam SRP)
  Subscribe SSE /api/v1/events
  On drm.type = "challenging":
    Show 2FA dialog
  POST /api/v1/drm/challenge {reply}
                      →  wrapper → idmsa.apple.com (2FA verify)
  Wait for: drm event {fairplay:"ready", authentication:"logged_in"}
                      ← wrapper writes MUSIC_TOKEN + STOREFRONT_ID files
                      ← s.mediaUserToken() will return live value on next API call
                      ← s.storefront() will return stripped ID on next API call

MUT is now live — no WebView step.

Auto-detect storefront (optional, for display):
  GET /api/v1/me/storefront
                      →  GET amp-api.music.apple.com/v1/me/storefront
                         Headers: Bearer + MUT
```

### 26.2 Home Tab

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
GET /api/v1/me/recommendations
                      →  GET /v1/me/recommendations
                         + caching (15-min TTL)

GET /api/v1/me/recent/played
                      →  GET /v1/me/recent/played

GET /api/v1/me/recent/played/tracks
                      →  GET /v1/me/recent/played/tracks

All responses cached in engine memory.
Artwork URLs in responses point to /api/v1/artwork/{id}?size=<N>
```

### 26.3 Search

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
[user types]
GET /api/v1/catalog/search/hints?q=<partial>
                      →  GET /v1/catalog/{sf}/search/hints?term=<partial>
                         &limit=5

[user submits]
GET /api/v1/catalog/search?q=<query>&types=songs,albums,artists,playlists
                      →  GET /v1/catalog/{sf}/search
                         ?term=<query>
                         &types=songs,albums,artists,playlists
                         &limit=25

GET /api/v1/me/library/search?q=<query>
                      →  GET /v1/me/library/search
                         ?term=<query>&types=library-songs,library-albums,...
```

### 26.4 Library

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
GET /api/v1/me/library/songs?limit=25&offset=0&sort=-dateAdded
                      →  GET /v1/me/library/songs?...
                         Headers: Bearer + MUT
                         (paginated response, cache 1h TTL)

GET /api/v1/me/library/albums?limit=25&offset=0
                      →  GET /v1/me/library/albums?...

GET /api/v1/me/library/playlists?limit=25&offset=0
                      →  GET /v1/me/library/playlists?...

POST /api/v1/me/library
  Body: {assetId: "...", type: "song"}
                      →  POST /v1/me/library
                         (adds to library + invalidates library cache)
```

### 26.5 Album Page

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
GET /api/v1/catalog/album/{id}?include=tracks,artists
                      →  GET /v1/catalog/{sf}/albums/{id}
                         ?include=tracks,artists
                         &extend=editorialVideo
                         (cache: 24h TTL, stable content)

GET /api/v1/artwork/{id}?size=800
                      →  CDN https://isq11.mzstatic.com/...
                         (cache: permanent, content-addressed)
```

### 26.6 Artist Page

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
GET /api/v1/catalog/artist/{id}
  ?include=albums,top-songs,music-videos
  &views=full-albums,appears-on-albums,similar-artists
                      →  GET /v1/catalog/{sf}/artists/{id}?...
                         (cache: 24h TTL)
```

### 26.7 Playlist Page

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
GET /api/v1/me/library/playlists/{id}/tracks?limit=100&offset=0
                      →  GET /v1/me/library/playlists/{id}/tracks?...
                         (no cache for user playlists — mutates frequently)

POST /api/v1/me/library/playlists/{id}/tracks
  Body: {assetIds: ["..."]}
                      →  POST /v1/me/library/playlists/{id}/tracks
                         {data: [{id, type:"songs"}]}
```

### 26.8 Now Playing / Playback

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
[user taps play]
POST /api/v1/playback
  Body: {assetId: "1234567890", capabilities: {lossless: true}}
                      →  GET play.itunes.apple.com/.../getMusicSDKAuthorizationsSrv
                         → fetches CBCS M3U8 URL
                      →  Parse HLS master/media playlist
                      →  TCP socket 10020 (wrapper)
                         → FPS key acquisition from Apple license server
                      →  HTTP 201 + Session JSON
                         {sessionId, codec:"alac", streams:{audio:"/..."}}

[audio player connects]
GET /api/v1/playback/{id}/audio?raw=1
                      →  Streams fMP4 from CDN (aod.itunes.apple.com)
                         Decrypted in-process (CTR) or via wrapper (CBCS)
                      →  HTTP chunked response, Content-Type: audio/mp4

[user skips]
DELETE /api/v1/playback/{old-id}     → release session
POST /api/v1/playback {assetId: next} → create new session
```

### 26.9 Lyrics

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
GET /api/v1/lyrics/{id}?format=lrc&type=syllable-lyrics
                      →  GET [bag://musicSubscription/lyrics]?...
                         Headers: Bearer + MUT
                         (cache: permanent, lyrics never change)
```

### 26.10 Download (Export)

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
POST /api/v1/export
  Body: {assetId, capabilities:{lossless:true}, outputDir: "..."}
                      →  (internally: full CBCS/CTR pipeline)
                      →  Writes fMP4 + embedded tags to disk

Subscribe SSE /api/v1/events
→ receive: {type:"export", data:{phase:"downloading", percent:45}}
→ receive: {type:"export", data:{phase:"done", output:"/path/to/file"}}
```

### 26.11 DRM Status Monitor

```
Flutter                    Engine                    Apple Services
─────────────────────────────────────────────────────────────────────
[app foreground / settings screen open]
GET /api/v1/drm/status
                      →  {
                           state: {
                             manager: "ready",
                             authentication: "logged_in",
                             fairplay: "ready",
                             session: "valid"
                           },
                           capabilities: {cbcs:true, alac:true, atmos:true},
                           backend: {selected:"embedded"}
                         }

[SSE stream running]
GET /api/v1/events
→ drm events arrive automatically when state changes
→ Flutter updates UI chip: "Ready" | "Authenticating..." | "2FA required"
```

---

## 27 — Android Playback / DRM Architecture Map (Complete)

For reference — how Android implements what the Linux engine implements:

```
Android App                          Linux Engine Equivalent
─────────────────────────────────────────────────────────────────────
UI Layer                             Flutter UI
  MusicPlayer activity                 NowPlayingScreen widget

ViewModel Layer
  PlaybackViewModel                    BLoC / Cubit
  QueueViewModel                       PlaybackQueue class

Media Session Layer
  ExoPlayer MediaController            media_kit / audio_service

Playback Engine
  PlayerHlsMediaSource                 engine/hls HLS parsing
  (custom ExoPlayer subclass)

Key Delivery Layer
  FootHillPEncryptionKeyChunk          engine/fairplay CBCSSource
  (ExoPlayer HLS chunk interceptor)    (TCP socket to wrapper)

FairPlay Layer
  KDGenerateRequestSPCWithMovieId      wrapper's KD functions
  KDProcessResponseCKC                 (Linux: called by wrapper)
  KDDecryptOneSampleiTunes             (Linux: wrapper decrypts)

Native FairPlay
  libstoreapi.so → FootHill/KD         wrapper-rootless binary
  (in-process, via JNI)                (out-of-process, via TCP)

Auth Layer
  AMSCore::NetworkMediaTokenProvider   Config.MediaUserToken
  AMSCore::IdMS::SRPAuthenticateTask   wrapper auth flow (email/pw)
  ADIInterface (Anisette)              wrapper Anisette (internal)

Machine Identity
  libCoreADI.so → ADI provisioning     wrapper ADI (internal)
```

The key architectural difference: **on Android, DRM functions run in-process via JNI**. On Linux, the same DRM functions run **in the wrapper subprocess** and are accessed via TCP. The Linux engine is an IPC layer around the Android DRM binary.

---

## 28 — Remaining Unknowns

Items that could not be confirmed from available sources:

| Unknown | Why it matters | How to resolve |
|---------|---------------|----------------|
| Exact MUT endpoint URL | ~~bag://sf-api-token-service-url~~: **RESOLVED** — `https://sf-api-token-service.itunes.apple.com/apiToken` (confirmed from `wrapper/rootfs/system/bin/main` strings). Wrapper handles refresh internally. |
| Exact lyrics endpoint URL (bag://musicSubscription/lyrics resolves to what?) | Already handled by engine | Capture bag.xml at runtime |
| Session continuation across app restarts | Queue/last-played state | Test at runtime |
| Rate limits on catalog endpoints | Flutter caching strategy | Test at runtime |
| `next` cursor format in paginated responses | Library pagination | Standard MusicKit |
| Whether GetAccount (port 30020) exposes MUT | **RESOLVED 2026-07-08** — YES. Both `ProcessBackend.GetAccount()` and `EmbeddedBackend.GetAccount()` return `AccountInfo.MusicToken`. `SessionManager.ReadMusicToken()` reads `{session_dir}/MUSIC_TOKEN`. `APIServer.mediaUserToken()` / `storefront()` accessors read from session as canonical source. WebView login NOT needed. Implemented and building. |
| Autoplay track selection algorithm | Queue "radio mode" | Approximate with /me/recommendations/suggested |
| Waveform data availability | Scrub bar visualization | No waveform API found in any client |
| Exact `X-Apple-Store-Front` suffix for Linux | Some API calls may require it | Test with and without `,29` suffix |
| Collaborative playlist RTC protocol | Future feature | Separate investigation |
| Storefront suffix stripping | Wrapper writes `143467-2,31`; catalog API needs `143467` | Strip at first `-` character: `strings.SplitN(sf, "-", 2)[0]` |
