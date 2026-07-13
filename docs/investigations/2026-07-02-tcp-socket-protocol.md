# TCP Socket Protocol — FairPlay CBCS Decryption — 2026-07-02

## Status

**Runtime-verified 2026-07-02** against a live socat proxy trace
(`cbcs-trace.txt`, 341 MB, 5.3 M lines) capturing the full ALAC download
of adamID 1488408568 ("Blinding Lights", ~201 s, 14 segments).

Labels used in this document:
- **Verified Runtime** — observed directly in the socat hex trace
- **Verified Source** — read directly from `wrapper/main.c` (C implementation of the TCP server)
- **Observed in Legacy Code** — inferred from `utils/runv2/runv2.go`; consistent with trace but not individually byte-checked
- **Unknown** — not yet verified, still an open question

## What the socket is (and is not)

**Verified Runtime.** The socket at `Config.DecryptM3u8Port` is **not** a key
server. It is a **stateful bidirectional decryption proxy**:

- The client tells it *which key* to use (by sending the `skd://` key URI).
- The client sends *encrypted sample data*.
- The socket returns *decrypted sample data in-place*, same byte count.

The socket holds and manages the FairPlay keys internally.
The engine never sees key bytes.

## Transport

- Protocol: TCP (plain, no TLS) **[Observed in Legacy Code]**
- Address: `Config.DecryptM3u8Port` (e.g. `127.0.0.1:10020`) **[Observed in Legacy Code]**
- Connection lifetime: one connection per file download **[Verified Runtime]** — one socat session, 41.6 MB client ↔ 41.6 MB server
- Framing: raw binary, no TLS, no HTTP, no length framing at connection level **[Verified Runtime]**

## Session lifecycle

```
client                                    socket
  |                                         |
  |  [dial TCP]                             |
  |──────────────────────────────────────>  |
  |                                         |
  |  [fragment 0 only: no SwitchKeys]       |
  |    adamID msg: [len("0")] + "0"         |
  |    ──────────────────────────────────>  |
  |    keyURI msg: [len(URI)] + URI         |
  |    ──────────────────────────────────>  |
  |                                         |
  |  [fragments 1..N, only if seg.Key≠nil:] |
  |    SwitchKeys: [0x00 0x00 0x00 0x00]   |
  |    ──────────────────────────────────>  |
  |    adamID msg: [len] + adamID           |
  |    ──────────────────────────────────>  |
  |    keyURI msg: [len] + keyURI           |
  |    ──────────────────────────────────>  |
  |                                         |
  |  [each fragment, all samples:]          |
  |    uint32 LE: truncatedLen              |
  |    bytes: data[:truncatedLen]           |
  |    ──────────────────────────────────>  |
  |    bytes: decrypted data (same length)  |
  |    <──────────────────────────────────  |
  |    [per-sample; Flush after each send]  |
  |                                         |
  |  [after all fragments:]                 |
  |    Close: [0x00 0x00 0x00 0x00 0x00]   |
  |    [close TCP connection]               |
  |  ──────────────────────────────────>    |
```

## Message framing

### SendString(conn, s string) — **Verified Runtime**

```
1 byte:   uint8 — length of s
N bytes:  s (UTF-8)
```

Observed in trace at fragment 0 key setup (client bytes 0–41):
```
01 30                           # SendString("0")   → len=1, '0'
27 73 6b 64 3a 2f 2f ...        # SendString("skd://…P000000000…")  → len=39, URI
```

Observed at fragment 1 key rotation (client byte offset 2,427,374):
```
00 00 00 00                     # SwitchKeys (4 bytes)
0a 31 34 38 38 34 30 38 35 36 38  # SendString("1488408568") → len=10
25 73 6b 64 3a 2f 2f 69 74 75 …   # SendString("skd://itunes.apple.com/p1238037727/c6") → len=37
```

### SwitchKeys signal — **Verified Runtime + Verified Source**

```
4 bytes:  [0x00, 0x00, 0x00, 0x00]
```

Verified in trace: exactly **one** SwitchKeys appears in the 41.6 MB trace,
at client byte offset 2,427,374, immediately before the key setup for
fragment 1. Confirmed by `cmd/protoinspect` (tool-verified 2026-07-02): two key
sessions — preshare (161 samples, HLS seg 0) and real key (2010 samples, HLS segs
1–13). The TCP socket has no per-segment delimiter; segment boundaries are implicit.

**Runtime finding:** SwitchKeys is **NOT** sent before every non-first
fragment. It is sent only when the m3u8 library returns a non-nil `Key`
for that segment (i.e. when a new `#EXT-X-KEY` line appeared in the playlist
before that segment). For the ALAC playlist:
- Segment 0: `EXT-X-KEY` → `Key = prefetch URI` → no SwitchKeys (i==0)
- Segment 1: `EXT-X-KEY` → `Key = content URI` → SwitchKeys sent
- Segments 2–13: no new `EXT-X-KEY` → `Key = nil` → **no SwitchKeys sent**

**Source confirmation** (`wrapper/main.c`, `handle()`):  The inner sample loop
breaks on `uint32_t size == 0`; the outer loop immediately reads a new
adamID+URI.  SwitchKeys is purely a key-change signal — the server holds the
active FairPlay decrypt context until a new one is explicitly requested.
Key-change-only: **confirmed**.

### Close signal — **Verified Runtime**

```
5 bytes:  [0x00, 0x00, 0x00, 0x00, 0x00]
```

Verified: last 5 bytes of client stream (offset 41,611,803–41,611,807)
are `00 00 00 00 00`, followed by connection close.

SwitchKeys (4 bytes) and Close (5 bytes) differ by exactly one byte —
the 5th zero is the termination marker.

## Key setup sequence — **Verified Runtime**

From trace evidence, the actual per-fragment logic is:

```
if seg.Key != nil:
    if i != 0:
        send SwitchKeys  # [0x00 0x00 0x00 0x00]
    if seg.Key.URI == "skd://itunes.apple.com/P000000000/s1/e1":
        send SendString("0")     # prefetch: use cached key
    else:
        send SendString(adamID)  # content key: identify by adamID
    send SendString(seg.Key.URI)
# if seg.Key == nil: no key setup; socket uses key from previous fragment
```

Source: `runv2.downloadAndDecryptFile` — **Observed in Legacy Code, consistent with trace**

### The "0" vs adamID distinction — **Verified Source**

The prefetch key URI (`P000000000/s1/e1`) receives `"0"` as the adamID.
Content-specific URIs receive the real adamID string. Trace shows `"0"`
for fragment 0 and `"1488408568"` for fragment 1 as expected.

**Server-side** (`wrapper/main.c`, `getKdContext()`):

```c
uint8_t isPreshare = (strcmp("0", adam) == 0);
if (isPreshare) {
    // return cached preshareCtx (set during lease/startup) without network call
    pthread_mutex_lock(&g_ctx_mutex);
    void *cached = preshareCtx;
    pthread_mutex_unlock(&g_ctx_mutex);
    if (cached != NULL)
        return cached;
}
// real adamID: calls FPS endpoint
// "https://play.itunes.apple.com/WebObjects/MZPlay.woa/music/fps"
// with protocolType="simplified", keyFormat="com.apple.streamingkeydelivery"
// → getPersistentKey() → decryptContext() → kdContext
```

The `preshareCtx` is a globally cached FairPlay decrypt context populated during
the wrapper's lease/startup cycle. Sending `"0"` returns this shared context
without making any network calls to Apple. Sending a real adamID triggers a live
FairPlay key delivery request to Apple's FPS endpoint; returning `NULL` from that
request causes `getKdContext` to return `NULL`, and decryption would fail silently
(the server writes nothing back). Sending the wrong adamID would similarly cause
FPS to reject the request and return `NULL`.

## Sample data exchange (per fragment)

### ALAC: full-subsample decryption — **Verified Runtime**

ALAC uses full-subsamples (`DefaultSkipByteBlock == 0`).

```
client → socket:
    uint32 LE: truncatedLen = len(data) & ~0xF   # round down to 16B
    bytes: data[:truncatedLen]                    # encrypted bytes

socket → client:
    bytes: decrypted data (same length)
```

Trailing `len(data) % 16` bytes are not sent; they remain unchanged in
the output. **Observed in Legacy Code** (`cbcsFullSubsampleDecrypt`).

### Request/response interleaving — **Verified Runtime**

Samples are NOT batched per-fragment at the TCP level. The bufio writer
flushes after writing each sample's data (`cbcsDecryptRaw → conn.Flush()`).
The socket responds to each sample immediately. Observed in trace: client
and server writes interleave at sub-fragment granularity (8–18 KB per
TCP segment), not at fragment boundaries.

The overall pattern is **per-sample request/response**, coalesced by the
OS TCP stack into large segments. There is no fragment-level batching.

### Atmos / AVC: stripe (pattern) decryption — **Observed in Legacy Code; not runtime-verified**

Atmos (ec-3) and AVC content use pattern encryption (`DefaultSkipByteBlock > 0`).

```
decryptBlockLen = DefaultCryptByteBlock * 16
skipBlockLen    = DefaultSkipByteBlock  * 16
count           = ((len(data) - decryptBlockLen) / (decryptBlockLen + skipBlockLen)) + 1
totalLen        = count * decryptBlockLen

client → socket:
    uint32 LE: totalLen                          # total encrypted bytes (non-contiguous)
    for each stripe:
        bytes: data[pos : pos+decryptBlockLen]   # send encrypted stripe
        # [skip skipBlockLen bytes — not sent]

socket → client:
    for each stripe:
        bytes: decrypted stripe, decryptBlockLen bytes
```

Source: `runv2.cbcsStripeDecrypt`

## Total bytes — **Verified Runtime**

For adamID 1488408568 ALAC (14 segments, 2,171 samples, 201 s):

| Direction     | Total bytes |
|---------------|------------|
| Client → Socket | 41,611,808 |
| Socket → Client | 41,603,024 |
| Difference    | 8,784 |

The ~8.8 KB difference is the client-side overhead:
- Fragment 0 key setup: 42 bytes (`01 30` + `27` + 39-char URI)
- Fragment 1 key setup: 53 bytes (`00 00 00 00` + `0a` + 10-char adamID + `25` + 37-char URI)
- 2,171 samples × 4-byte uint32 length prefix = 8,684 bytes
- Close signal: 5 bytes
- Total overhead: 42 + 53 + 8,684 + 5 = 8,784 ✓

## Output file verification — **Verified Runtime**

The decrypted output (`alac-out.mp4`) was verified by:

- **mp4box** (GPAC): `14 fragments - 2171 samples - Media Duration 00:03:21.569` ✓
- **Structure**: 30 top-level boxes (`ftyp` + `moov` + 14×`moof+mdat`), all
  byte-contiguous
- **tfdt**: monotonically increasing from 0 to 194.397 s, final fragment at
  194.4 s + 78 samples × 4096/44100 = 201.5 s total ✓
- **trun sample sizes**: sum matches mdat body size for every fragment ✓
- **ffprobe note**: ffprobe reports `Duration: 00:00:14.95` — this is a
  known ffmpeg quirk with HLS CMAF fMP4 files (`hlsf` brand). The duration
  shown is fragment 0's duration only. The actual file is complete and
  correctly structured; mp4box reads it correctly.

## MP4 box handling — **Observed in Legacy Code**

Before any TCP communication, the init segment is processed:

1. `mp4.DecryptInit(init)` — extracts `DecryptTrackInfo` per track
2. Encryption boxes (`sbgp`, `sgpd` with `seig`/`seam` grouping) removed from `stbl`
3. `SanitizeInit` removes duplicate `ec-3` or `alac` boxes from `stsd`

After each fragment:
1. `traf.RemoveEncryptionBoxes()` — removes `senc`, `saiz`, `saio`
2. `moof.RemovePsshs()` — removes PSSH boxes
3. `trun.DataOffset` adjusted for removed bytes

## Resolved questions

1. **SwitchKeys semantics** — **Verified Source.** The server's `handle()` inner
   sample loop breaks on `size == 0`; the outer loop then reads a new adamID+URI.
   SwitchKeys is purely a "change key" signal: the server holds the active FairPlay
   decrypt context across all fragments until a new one is requested. Sending
   SwitchKeys when the key hasn't changed would cause a redundant FPS network call
   on the server (wasteful but not incorrect). **Conclusion: key-change-only, not
   per-fragment.**

2. **"0" vs adamID** — **Verified Source.** See `getKdContext()` notes in "The '0'
   vs adamID distinction" above. Sending the wrong adamID causes FPS rejection and
   silent decryption failure.

## Open questions (Unknown)

1. **Error signalling** — how does the socket indicate decryption failure?
   If `getKdContext()` returns `NULL` (FPS rejected the adamID), the server likely
   closes the connection or writes garbage. Not observed.

2. **WebPlayback CBCS key URIs** — catalog uses `P000000000/s1/e1`.
   WebPlayback CBCS uses `afs_<adamID>_<n>_a_/…`. Whether the socket
   handles both identically is unknown.

3. **Connection reuse** — can one connection handle multiple tracks/files?
   Legacy code opens a new connection per file. Not tested.

4. **Atmos decryption** — stripe (pattern) decryption path not runtime-verified;
   only the ALAC full-subsample path was traced.

## How to reproduce the trace

```bash
# Start socat proxy (in a terminal)
socat -x -v TCP-LISTEN:10021,fork TCP:127.0.0.1:10020 2>&1 | tee /tmp/cbcs-trace.txt

# Create proxy config
cp config.yaml /tmp/config-proxy.yaml
# edit: decrypt-m3u8-port: "127.0.0.1:10021"

# Run legacy ALAC download through proxy
cd /tmp
go run trace_main.go /tmp/config-proxy.yaml alac-out.mp4

# Verify output
MP4Box -info alac-out.mp4 2>&1 | grep -E "Duration|fragments|samples"
```
