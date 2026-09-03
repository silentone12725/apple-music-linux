package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func (s *APIServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleMetrics returns session-open latency stats and circuit-breaker state.
// The ring holds the last 100 opens (ms each). avgMs and p95Ms are computed
// on the fly from the snapshot.
func (s *APIServer) handleMetrics(w http.ResponseWriter, r *http.Request) {
	samples := s.openLatency.Snapshot()
	var avgMs, p95Ms float64
	if len(samples) > 0 {
		sorted := make([]int64, len(samples))
		copy(sorted, samples)
		// insertion sort — at most 100 elements
		for i := 1; i < len(sorted); i++ {
			for j := i; j > 0 && sorted[j] < sorted[j-1]; j-- {
				sorted[j], sorted[j-1] = sorted[j-1], sorted[j]
			}
		}
		var sum int64
		for _, v := range sorted {
			sum += v
		}
		avgMs = float64(sum) / float64(len(sorted))
		p95Idx := int(float64(len(sorted))*0.95) - 1
		if p95Idx < 0 {
			p95Idx = 0
		}
		p95Ms = float64(sorted[p95Idx])
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"sessionOpen": map[string]any{
			"count":   len(samples),
			"avgMs":   avgMs,
			"p95Ms":   p95Ms,
			"samples": samples,
		},
		"circuitBreaker": map[string]any{
			"state": s.openCB.State(),
		},
	})
}

func (s *APIServer) handleTools(w http.ResponseWriter, r *http.Request) {
	ffPath, ffErr := exec.LookPath("ffmpeg")
	ffInfo := map[string]any{"available": ffErr == nil, "path": ffPath}
	if ffErr == nil {
		if out, err := exec.Command(ffPath, "-version").Output(); err == nil {
			// First line: "ffmpeg version 6.1.1 Copyright ..."
			line := strings.SplitN(string(out), "\n", 2)[0]
			if parts := strings.Fields(line); len(parts) >= 3 && parts[0] == "ffmpeg" && parts[1] == "version" {
				ffInfo["version"] = parts[2]
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ffmpeg": ffInfo})
}

// handleRuntimeStats reports scalar Go runtime metrics for the benchmark
// harness. These are process-internal (goroutine count, heap, GC) and cannot be
// observed from outside via /proc, so the engine self-reports them here.
func (s *APIServer) handleRuntimeStats(w http.ResponseWriter, r *http.Request) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	resp := map[string]any{
		"goroutines":      runtime.NumGoroutine(),
		"heapAllocBytes":  m.HeapAlloc,
		"heapSysBytes":    m.HeapSys,
		"stackSysBytes":   m.StackSys,
		"totalAllocBytes": m.TotalAlloc,
		"numGC":           m.NumGC,
		"gcPauseTotalNs":  m.PauseTotalNs,
		"nextGCBytes":     m.NextGC,
	}
	if s.scheduler != nil {
		resp["prefetch"] = s.scheduler.Stats()
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *APIServer) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	// Capabilities now reflect DRMManager state rather than a raw TCP probe.
	// DRMManager.Status() gives a complete snapshot including whether FairPlay
	// is initialised and what content types are available.
	snap := s.dm.Status()
	cap := snap.Capabilities
	writeJSON(w, http.StatusOK, map[string]any{
		"lossless":   cap.ALAC,
		"hiRes":      cap.HiRes,
		"atmos":      cap.Atmos,
		"musicVideo": true,
		"downloads":  true,
		"lyrics":     true,

		// DRM status detail for frontends that want to show granular state.
		"drm": map[string]any{
			"process":  snap.State.Process.String(),
			"fairplay": snap.State.FairPlay.String(),
			"session":  snap.State.Session.String(),
			"cbcs":     cap.CBCS,
		},
	})
}

func (s *APIServer) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	fl.Flush()

	// Parse Last-Event-ID sent by reconnecting clients.
	var replayAfter int64 = -1 // -1 = first-time connect; skip replay
	if lei := r.Header.Get("Last-Event-ID"); lei != "" {
		if id, err := strconv.ParseInt(lei, 10, 64); err == nil && id >= 0 {
			replayAfter = id
		}
	}

	// Atomically subscribe and snapshot replay events in one lock acquisition.
	// Any event emitted after this point goes into `ch`; events emitted before
	// it are in the ring.  No gap can form between the two sets.
	subID, ch, replayEvents, replayTruncated := s.events.subscribeAndReplay(replayAfter)
	defer s.events.unsubscribe(subID)

	// envelopeMeta carries transport metadata present in every event.
	// reason and snapshot are omitted on non-snapshot events.
	// Separating meta from payload makes it trivial to add future fields
	// (NodeID, EngineVersion, TraceID) without touching payload schemas.
	type envelopeMeta struct {
		ID         int64       `json:"id"`
		Generation uint64      `json:"generation"`
		Reason     EpochReason `json:"reason,omitempty"`
		Snapshot   bool        `json:"snapshot,omitempty"`
	}
	type wireEnvelope struct {
		Meta    envelopeMeta    `json:"meta"`
		Payload json.RawMessage `json:"payload"`
	}

	// Helper: marshal data → raw bytes → wrap in envelope → write SSE frame.
	// json.RawMessage avoids a second encode of the payload bytes.
	// isSnapshot=true adds reason + snapshot flag to meta; false omits both.
	writeEv := func(id int64, typ string, data any, gen uint64, isSnapshot bool, reason EpochReason) {
		raw, _ := json.Marshal(data)
		meta := envelopeMeta{ID: id, Generation: gen}
		if isSnapshot {
			meta.Reason = reason
			meta.Snapshot = true
		}
		env, _ := json.Marshal(wireEnvelope{Meta: meta, Payload: raw})
		fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", id, typ, env)
		fl.Flush()
	}

	// engine.snapshot reports current epoch + the reason it last advanced so
	// clients can answer "why did generation jump?" without a separate query.
	epochInfo := s.epoch.Current()

	drmSnap := s.dm.Status()
	cap := drmSnap.Capabilities
	snapshotState := map[string]any{
		"drm": map[string]any{
			"state":    drmSnap.State,
			"session":  drmSnap.State.Session.String(),
			"cbcs":     cap.CBCS,
			"lossless": cap.ALAC,
			"hiRes":    cap.HiRes,
			"atmos":    cap.Atmos,
		},
		"capabilities": map[string]any{
			"lossless":   cap.ALAC,
			"hiRes":      cap.HiRes,
			"atmos":      cap.Atmos,
			"musicVideo": true,
		},
	}
	if s.scheduler != nil {
		snapshotState["prefetch"] = s.scheduler.Stats()
	}
	writeEv(s.events.nextID(), "engine.snapshot", map[string]any{
		"version":  1,
		"snapshot": snapshotState,
	}, epochInfo.Generation, true, epochInfo.Reason)

	// If the ring evicted events the client missed, signal resync rather than
	// silently applying an incomplete delta replay.
	if replayTruncated {
		oldest, newest := s.events.ringBounds()
		writeEv(s.events.nextID(), "replay.truncated", map[string]any{
			"requestedAfter":  replayAfter,
			"oldestAvailable": oldest,
			"newestAvailable": newest,
			"reason":          "history_evicted",
		}, epochInfo.Generation, false, "")
	} else {
		// Replay missed events from the ring buffer (empty on first connect).
		// Replayed events carry their original generation so the client can
		// order them relative to the current snapshot.
		for _, ev := range replayEvents {
			writeEv(ev.ID, ev.Type, ev.Data, ev.Generation, false, "")
		}
	}

	// 30-second named ping event keeps proxies from closing idle connections
	// and gives clients a watchdog signal they can act on.
	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			writeEv(s.events.nextID(), "ping", map[string]int64{"ts": time.Now().UnixMilli()}, epochInfo.Generation, false, "")
		case ev, ok := <-ch:
			if !ok {
				return
			}
			writeEv(ev.ID, ev.Type, ev.Data, ev.Generation, false, "")
		}
	}
}
