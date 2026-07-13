# Verification Artifacts

Every **Runtime Verified** claim in `CLAUDE.md` should have a reproducible
artifact stored here.  This directory is the physical evidence behind those
claims.

Do not mark a claim **Runtime Verified** in `CLAUDE.md` without adding the
corresponding artifact here and recording the capture method.

---

## Directory layout

```
verification/
  wire-traces/       socat -x -v captures; fed to cmd/protoinspect
  mp4box-reports/    MP4Box -info output for legacy and engine outputs
  output-hashes/     SHA-256 of legacy vs engine output files, same adamID
  pprof/             goroutine/heap/FD snapshots from load tests
  load-tests/        timing logs from concurrent-session tests
```

---

## How to capture each artifact type

### Wire traces (wire-traces/)

```bash
# Start transparent proxy on port 10021 → wrapper at 10020
socat -x -v TCP-LISTEN:10021,fork TCP:127.0.0.1:10020 2>&1 | tee verification/wire-traces/alac-<adamID>-<date>.txt &

# Point the downloader at port 10021 instead of 10020
# (change Config.DecryptM3u8Port temporarily, or use a config override)

# After download completes, parse the trace:
go run ./cmd/protoinspect verification/wire-traces/alac-<adamID>-<date>.txt
```

File naming: `<content-type>-<adamID>-<date>-<legacy|engine>.txt`

### MP4Box reports (mp4box-reports/)

```bash
# After downloading via legacy or engine:
MP4Box -info output.m4a 2>&1 | tee verification/mp4box-reports/<adamID>-<legacy|engine>-<date>.txt

# Key fields to record: codec, sample rate, fragment count, duration, bit depth
```

### Output hashes (output-hashes/)

```bash
# Download same track via legacy and engine; compare:
sha256sum legacy-output.m4a > verification/output-hashes/<adamID>-legacy-<date>.sha256
sha256sum engine-output.m4a > verification/output-hashes/<adamID>-engine-<date>.sha256
diff verification/output-hashes/<adamID>-legacy-<date>.sha256 \
     verification/output-hashes/<adamID>-engine-<date>.sha256

# If hashes differ, use cmd/mvcompare to find first difference:
go run ./cmd/mvcompare <legacy.m4a> <engine.m4a>
```

### pprof snapshots (pprof/)

```bash
# Add pprof endpoint to engine (import _ "net/http/pprof" in main.go)
# Run load test, then:
curl http://localhost:<port>/debug/pprof/goroutine > verification/pprof/goroutines-<scenario>-<date>.pb
curl http://localhost:<port>/debug/pprof/heap      > verification/pprof/heap-<scenario>-<date>.pb
go tool pprof -text verification/pprof/goroutines-<scenario>-<date>.pb
```

### Load test logs (load-tests/)

Record: scenario description, concurrent session count, duration, goroutine
count before/after, FD count before/after, any errors observed.

---

## Existing verified evidence

### ALAC wire trace — 2026-07-02 (adamID 1488408568)

Captured via socat. **Not stored here** (341 MB binary; too large for repo).
`cmd/protoinspect` output is the canonical summary; see
`docs/investigations/2026-07-02-tcp-socket-protocol.md`.

Reproduction: run socat proxy, download ALAC via legacy pipeline, parse with
`cmd/protoinspect`.

### ALAC output — MP4Box report (legacy pipeline, 2026-07-02)

Not stored here. Measurements recorded in `CLAUDE.md`:
- 40 MB fMP4, ftyp + moov + 14×(moof+mdat)
- 2171 samples, 00:03:21.569, alac 44100 Hz 24-bit

### ALAC output — MP4Box report (engine, 2026-07-02)

Not stored here. Measurements recorded in `CLAUDE.md`:
- 40 MB fMP4, same fragment count and duration as legacy

**Gap:** byte-for-byte SHA-256 comparison not yet performed.
This is open question OQ3 in `docs/parity-matrix.md`.

### Atmos output — MP4Box report (engine, 2026-07-02)

Not stored here. Measurements in `CLAUDE.md`:
- 19 MB fMP4, 14 fragments, 6252 samples, 00:03:20.064, ec-3 48000 Hz 6ch

**Gap:** legacy Atmos output hash not captured; wire trace not performed.
This is OQ1 and OQ2 in `docs/parity-matrix.md`.

---

## What to capture next

Priority order matches `docs/parity-matrix.md` §13:

1. **ALAC output hash comparison** (OQ3) — same adamID, legacy vs engine,
   SHA-256. Closes the byte-level parity question for ALAC.
2. **Engine CBCS wire trace** (OQ2) — socat proxy, download ALAC via engine,
   parse with protoinspect, compare KEY_SESSION structure with legacy trace.
3. **Atmos wire trace** (OQ1) — same approach, Atmos-capable track.
4. **AAC output hash comparison** (OQ4) — same adamID, legacy vs engine.
5. **Multi-storefront spot check** (OQ5) — one ALAC track in a non-us storefront.
6. **Goroutine/FD snapshot** (OQ8) — 100 concurrent sessions, pprof before/after.
