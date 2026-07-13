# Performance Benchmarks

Baseline measurements for tracking regressions and validating optimizations.
Each file is named `<scenario>-<date>.json`.

## Capture procedure

### Cold download (no segment cache)

```bash
# Clear the segment cache first
rm -rf ~/.cache/apple-music-cli/segments/

# Time a full ALAC download via engine
time curl -s -X POST http://localhost:8080/api/v1/export \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"<adamID>","outputDir":"/tmp/am-bench","capabilities":{"lossless":true},"options":{"embedArtwork":false,"embedLyrics":false}}' \
  | jq -r .jobId | xargs -I{} bash -c \
  'until curl -s http://localhost:8080/api/v1/export/{} | jq -e .phase=="done" > /dev/null; do sleep 1; done'
```

### Warm download (segment cache populated)

Run the same download a second time — segments are served from disk cache.

### Concurrent downloads

Use the browser verification tool's "5 simultaneous" button, or:

```bash
for i in 1 2 3 4 5; do
  curl -s -X POST http://localhost:8080/api/v1/export \
    -H 'Content-Type: application/json' \
    -d "{\"assetId\":\"<adamID$i>\",\"outputDir\":\"/tmp/am-bench-$i\",\"capabilities\":{\"lossless\":true}}" &
done
wait
```

### Memory and goroutine profile

```bash
# Add pprof to the engine (see engine/e2e/integration_test.go for a template)
curl -s http://localhost:8080/debug/pprof/goroutine > verification/benchmarks/goroutines-<scenario>-<date>.pb
curl -s http://localhost:8080/debug/pprof/heap      > verification/benchmarks/heap-<scenario>-<date>.pb
go tool pprof -text verification/benchmarks/goroutines-<scenario>-<date>.pb
```

## Baseline schema

Each benchmark file records:

```json
{
  "scenario":        "cold-alac-download",
  "adamID":          "1488408568",
  "storefront":      "us",
  "date":            "2026-07-02",
  "durationSec":     12.4,
  "outputBytes":     41234567,
  "goroutinesBefore": 8,
  "goroutinesAfter":  8,
  "segmentCacheHits": 0,
  "segmentCacheMisses": 14,
  "notes":           ""
}
```

## Targets (aspirational; not yet measured)

| Scenario | Target |
|----------|--------|
| Cold ALAC download (≈40 MB, 14 segments) | < 20 s on 100 Mbps |
| Warm ALAC download (all segments cached) | < 3 s |
| 5 concurrent ALAC sessions | < 60 s total |
| Goroutine delta after 10 sessions created+released | ≤ 2 |
| Memory growth after 100 sessions | < 50 MB |
