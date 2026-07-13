package main

// scheduler.go — parallel metadata prefetch for album/playlist downloads.
//
// While track N is downloading, metadata for tracks N+1 … N+lookahead is
// fetched in parallel.  ripTrack checks the cache first; on a hit it skips
// the per-track goroutines entirely.
//
// All prefetch goroutines are driven by a shared context so that cancellation
// (e.g. Ctrl-C or player exit) stops outstanding fetches immediately.

import (
	"context"
	"sync"

	"main/utils/lyrics"
	"main/utils/task"
)

const (
	schedWorkers   = 4 // max concurrent metadata fetch goroutines
	schedLookahead = 6 // how many tracks ahead to prefetch
)

// schedResult is the outcome of one track's metadata prefetch.
type schedResult struct {
	lrc string
	err error
}

// schedCache maps track.ID → buffered chan(1) carrying the result.
// Presence of an entry means a fetch has been started for that ID.
var schedCache sync.Map

// schedPool is a buffered channel acting as a semaphore to bound concurrency.
var schedPool = make(chan struct{}, schedWorkers)

// PrefetchMeta starts a background metadata fetch for track if one has not
// already been started.  ctx controls cancellation; if ctx is cancelled the
// goroutine records the cancellation error and exits without blocking.
func PrefetchMeta(ctx context.Context, track *task.Track, token, mediaUserToken string) {
	ch := make(chan schedResult, 1)
	if _, loaded := schedCache.LoadOrStore(track.ID, ch); loaded {
		return // already in flight or complete
	}
	go func() {
		// Acquire a worker slot, but stop if context is already done.
		select {
		case schedPool <- struct{}{}:
		case <-ctx.Done():
			ch <- schedResult{err: ctx.Err()}
			return
		}
		defer func() { <-schedPool }()

		res := schedResult{}

		// Fetch album data for playlist tracks (needed for per-track tags).
		if track.PreType == "playlists" && Config.UseSongInfoForPlaylist {
			if ctx.Err() == nil {
				track.GetAlbumDataContext(ctx, token)
			}
		}

		// Fetch lyrics if any output format is enabled.
		if (Config.EmbedLrc || Config.SaveLrcFile) && ctx.Err() == nil {
			lrcStr, err := lyrics.GetContext(
				ctx,
				track.Storefront, track.ID,
				Config.LrcType, Config.Language, Config.LrcFormat,
				token, mediaUserToken,
			)
			res.lrc = lrcStr
			res.err = err
		}

		ch <- res
	}()
}

// TakeMeta retrieves the pre-fetched result for trackID, blocking until it is
// ready.  Returns (zero, false) if no prefetch was started for this track.
func TakeMeta(trackID string) (schedResult, bool) {
	v, ok := schedCache.LoadAndDelete(trackID)
	if !ok {
		return schedResult{}, false
	}
	return <-v.(chan schedResult), true
}

// PrefetchAlbumMeta starts prefetch goroutines for the first schedLookahead
// tracks.  Call once per album/playlist before the download loop starts.
func PrefetchAlbumMeta(ctx context.Context, tracks []task.Track, token, mediaUserToken string) {
	n := schedLookahead
	if n > len(tracks) {
		n = len(tracks)
	}
	for i := 0; i < n; i++ {
		PrefetchMeta(ctx, &tracks[i], token, mediaUserToken)
	}
}
