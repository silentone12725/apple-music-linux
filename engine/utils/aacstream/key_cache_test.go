package aacstream

import (
	"sync"
	"testing"
)

func clearKeyCache() { keyCache.Range(func(k, _ any) bool { keyCache.Delete(k); return true }) }

// ── cacheKeyFor ───────────────────────────────────────────────────────────────

func TestCacheKeyFor_Deterministic(t *testing.T) {
	k1 := cacheKeyFor("kid1", "uri1")
	k2 := cacheKeyFor("kid1", "uri1")
	if k1 != k2 {
		t.Fatalf("cacheKeyFor not deterministic: %q != %q", k1, k2)
	}
}

func TestCacheKeyFor_Distinct(t *testing.T) {
	k1 := cacheKeyFor("kid1", "uri1")
	k2 := cacheKeyFor("kid2", "uri1")
	k3 := cacheKeyFor("kid1", "uri2")
	if k1 == k2 {
		t.Error("kid1:uri1 == kid2:uri1 — KID not distinguished")
	}
	if k1 == k3 {
		t.Error("kid1:uri1 == kid1:uri2 — URI not distinguished")
	}
	if k2 == k3 {
		t.Error("kid2:uri1 == kid1:uri2 — collision on distinct inputs")
	}
}

// ── InvalidateKey ─────────────────────────────────────────────────────────────

func TestInvalidateKey_RemovesFromCache(t *testing.T) {
	clearKeyCache()
	ck := cacheKeyFor("kid-del", "uri-del")
	keyCache.Store(ck, []byte{0xde, 0xad})

	if _, ok := keyCache.Load(ck); !ok {
		t.Fatal("pre-condition: key not stored")
	}
	InvalidateKey("kid-del", "uri-del")
	if _, ok := keyCache.Load(ck); ok {
		t.Fatal("key still present after InvalidateKey")
	}
}

func TestInvalidateKey_NoOpWhenAbsent(t *testing.T) {
	clearKeyCache()
	InvalidateKey("never-stored", "uri-x") // must not panic
}

func TestInvalidateKey_Idempotent(t *testing.T) {
	clearKeyCache()
	ck := cacheKeyFor("kid-idem", "uri-idem")
	keyCache.Store(ck, []byte{0x01})

	InvalidateKey("kid-idem", "uri-idem")
	InvalidateKey("kid-idem", "uri-idem") // second call — must not panic
}

// ── Cache store / hit ─────────────────────────────────────────────────────────

func TestKeyCache_StoreAndLoad(t *testing.T) {
	clearKeyCache()
	want := []byte{0xaa, 0xbb, 0xcc}
	keyCache.Store(cacheKeyFor("kid-pop", "uri-pop"), want)

	v, ok := keyCache.Load(cacheKeyFor("kid-pop", "uri-pop"))
	if !ok {
		t.Fatal("expected cache hit")
	}
	got := v.([]byte)
	if string(got) != string(want) {
		t.Fatalf("wrong bytes: got %v, want %v", got, want)
	}
}

// ── AutoInvalidateOnDecryptFailure ────────────────────────────────────────────

// TestAutoInvalidateOnDecryptFailure simulates the fairplayDecryptor.Decrypt path:
// on any error, InvalidateKey is called with the stored kid+uri so the next
// AcquireKey bypasses the cache and fetches fresh material from the CDM.
func TestAutoInvalidateOnDecryptFailure(t *testing.T) {
	clearKeyCache()
	const kid = "kid-auto"
	const uri = "uri-auto"

	// Seed a stale key (as if AcquireKey ran successfully before).
	keyCache.Store(cacheKeyFor(kid, uri), []byte{0xba, 0xd0, 0x00})

	if _, ok := keyCache.Load(cacheKeyFor(kid, uri)); !ok {
		t.Fatal("pre-condition: key not in cache")
	}

	// Simulate the auto-invalidation that fairplayDecryptor.Decrypt performs on error.
	InvalidateKey(kid, uri)

	if _, ok := keyCache.Load(cacheKeyFor(kid, uri)); ok {
		t.Fatal("stale key still present after simulated decrypt failure — auto-invalidation broken")
	}
}

// ── Concurrency ───────────────────────────────────────────────────────────────

func TestKeyCache_ConcurrentSafe(t *testing.T) {
	// Run with -race to detect data races on the sync.Map.
	clearKeyCache()
	const N = 300
	var wg sync.WaitGroup
	wg.Add(N)
	for i := 0; i < N; i++ {
		i := i
		go func() {
			defer wg.Done()
			kid := "kid-concurrent"
			uri := "uri-concurrent"
			ck := cacheKeyFor(kid, uri)
			switch i % 3 {
			case 0:
				keyCache.Store(ck, []byte{byte(i)})
			case 1:
				keyCache.Load(ck)
			case 2:
				InvalidateKey(kid, uri)
			}
		}()
	}
	wg.Wait()
	// No panics reaching here = pass. The race detector flags any races.
}
