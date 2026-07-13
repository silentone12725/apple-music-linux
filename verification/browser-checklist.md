# Browser Verification Checklist

Human-in-the-loop release checklist.
Open `verification/api-test.html` in each target browser while the engine is running.

Mark each item: ✅ Pass · ❌ Fail · ⚠ Partial · — Not applicable

---

## Connection

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 1 | Engine connects (status dot turns green) | | | |
| 2 | Capabilities endpoint returns `downloads: true` | | | |
| 3 | SSE event stream connects and stays open | | | |

---

## Metadata + Artwork + Lyrics

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 4 | Song metadata returns title, artist, album, duration | | | |
| 5 | MV metadata returns has-video flag | | | |
| 6 | Artwork loads and renders for a song | | | |
| 7 | Artwork loads and renders for a MV | | | |
| 8 | Lyrics return LRC for a track that has them | | | |
| 9 | Lyrics return 404 for an instrumental track | | | |
| 10 | Metadata 404 for a bogus Adam ID | | | |

---

## Audio playback

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 11 | AAC stream plays in `<audio>` element | | | |
| 12 | ALAC stream plays in `<audio>` element | | | |
| 13 | Atmos stream plays (may require compatible hardware) | | | |
| 14 | Audio plays to completion without errors | | | |
| 15 | Seek to 30 s position, playback resumes correctly | | | |
| 16 | Pause and resume work without buffering gaps | | | |
| 17 | Browser native controls show correct duration | | | |
| 18 | Create session → play → delete session → no crash | | | |

---

## Music Video playback

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 19 | MV audio stream plays in `<audio>` | | | |
| 20 | MV video stream plays in `<video>` | | | |
| 21 | Video and audio are in sync (approximate, by eye) | | | |
| 22 | Correct resolution shown in browser devtools | | | |

---

## Concurrent sessions

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 23 | 3 simultaneous sessions open without error | | | |
| 24 | 5 simultaneous sessions open without error | | | |
| 25 | Each session plays correctly when opened together | | | |
| 26 | All sessions release cleanly after test | | | |

---

## Cancellation

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 27 | `AbortController` cancel mid-stream returns quickly (<2 s) | | | |
| 28 | SSE shows no error after abort | | | |
| 29 | Session can be deleted after abort | | | |
| 30 | Browser tab close / refresh does not leave server stuck | | | |

---

## Export (download to file)

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 31 | Export AAC track: job accepted (202) | | | |
| 32 | Export ALAC track: job accepted (202) | | | |
| 33 | SSE events show phase transitions (resolving → downloading → tagging → done) | | | |
| 34 | Output file exists on disk at expected path | | | |
| 35 | Output file has correct tags (verify with `exiftool` or Picard) | | | |
| 36 | Output file has embedded artwork | | | |
| 37 | Output file has embedded lyrics (if track supports it) | | | |
| 38 | Skip overwrite policy: second export of same track reports "skipped" | | | |
| 39 | Export job list (`GET /api/v1/export`) shows all jobs | | | |
| 40 | Cancel an in-flight export: job transitions to `cancelled` | | | |
| 41 | Retry a failed export: new job accepted | | | |
| 42 | Unicode title/artist in filename renders correctly on disk | | | |

---

## Error handling

| # | Check | Chrome | Firefox | Mobile |
|---|-------|--------|---------|--------|
| 43 | POST playback with invalid Adam ID returns useful error | | | |
| 44 | GET audio for non-existent session ID returns 404 | | | |
| 45 | POST export with missing `assetId` returns 400 | | | |
| 46 | GET lyrics for unavailable region returns 404 | | | |
| 47 | Response body on error is JSON with a descriptive message | | | |

---

## Multi-browser notes

| Browser | Version tested | OS | Notes |
|---------|---------------|-----|-------|
| Chrome  | | | |
| Firefox | | | |
| Safari  | | | |
| Mobile Chrome (Android) | | | |
| Mobile Safari (iOS) | | | |

---

## Sign-off

| Release | Date | Tester | Result |
|---------|------|--------|--------|
| | | | |

Blocking failures (❌ items) must be resolved before releasing.
