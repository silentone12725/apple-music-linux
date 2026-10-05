package library

import (
	"os"
	"path/filepath"
	"testing"
)

func song(id, cid, album string, disc, track int) amItem {
	var it amItem
	it.ID = id
	it.Attributes.Name = "Song " + id
	it.Attributes.PlayParams.CatalogID = cid
	it.Attributes.TrackNumber = track
	it.Attributes.DiscNumber = disc
	it.Relationships.Albums.Data = append(it.Relationships.Albums.Data, struct {
		ID string `json:"id"`
	}{ID: album})
	return it
}

// Album ordering, the albums table and the sync revision must survive a
// save/load cycle — i.e. an engine restart.
func TestPersistenceRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	var album amItem
	album.ID = "l.album1"
	album.Attributes.Name = "Album"
	album.Attributes.TrackCount = 3
	var pl amItem
	pl.ID = "p.1"
	pl.Attributes.Name = "Mix"

	s.Ingest(IngestPayload{
		Songs: []amItem{
			song("i.3", "103", "l.album1", 2, 1),
			song("i.1", "101", "l.album1", 1, 1),
			song("i.2", "102", "l.album1", 1, 2),
			song("i.2", "102", "l.album1", 1, 2), // duplicate ID must not abort the ingest
		},
		Albums:         []amItem{album},
		Playlists:      []amItem{pl},
		PlaylistTracks: map[string][]amItem{"p.1": {song("i.2", "102", "", 0, 0)}},
		Revision:       "rev-42",
	})
	s.save() // Ingest saves asynchronously; save synchronously for the test

	r := New(dir)
	got := r.SongsByAlbum("l.album1")
	want := []string{"i.1", "i.2", "i.3"}
	if len(got) != len(want) {
		t.Fatalf("SongsByAlbum after reload = %v, want %v", got, want)
	}
	for i, id := range want {
		if got[i].LibraryID != id {
			t.Fatalf("order[%d] = %s, want %s", i, got[i].LibraryID, id)
		}
	}
	songs, albums, playlists, syncedAt := r.Stats()
	if songs != 3 || albums != 1 || playlists != 1 || syncedAt.IsZero() {
		t.Fatalf("Stats after reload = %d songs, %d albums, %d playlists, synced %v", songs, albums, playlists, syncedAt)
	}
	var rev string
	r.db.QueryRow("SELECT value FROM meta WHERE key='revision'").Scan(&rev)
	if rev != "rev-42" {
		t.Fatalf("revision = %q", rev)
	}
	if tr := r.PlaylistTracks("p.1"); len(tr) != 1 || tr[0].CatalogID != "102" {
		t.Fatalf("PlaylistTracks = %v", tr)
	}
	if _, err := os.Stat(filepath.Join(dir, "library.enc.tmp")); !os.IsNotExist(err) {
		t.Fatal("temp file left behind after save")
	}
}

func TestLoadRejectsTamperedCache(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	// Direct insert: Ingest's background save could rewrite the file after tampering.
	if _, err := s.db.Exec("INSERT INTO songs(lid,cid,name,artist,album,ms) VALUES('i.1','1','n','a','b',1)"); err != nil {
		t.Fatal(err)
	}
	s.save()
	enc := filepath.Join(dir, "library.enc")
	b, _ := os.ReadFile(enc)
	b[len(b)-1] ^= 0xff
	os.WriteFile(enc, b, 0o600)
	if n, _, _, _ := New(dir).Stats(); n != 0 {
		t.Fatalf("tampered cache loaded %d songs", n)
	}
}

// A key file that is unreadable for any reason other than "absent" must not be replaced:
// minting a new key would overwrite the real one and orphan the encrypted cache.
func TestKeyIsNotRegeneratedOnReadFailure(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file permissions")
	}
	dir := t.TempDir()
	s := New(dir)
	first, err := s.encKey()
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, "library.key")
	if fi, err := os.Stat(keyPath); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v, mode %v", err, fi.Mode().Perm())
	}

	if err := os.Chmod(keyPath, 0); err != nil {
		t.Fatal(err)
	}
	s2 := New(dir) // a fresh process: no cached key
	if _, err := s2.encKey(); err == nil {
		t.Fatal("an unreadable key file must be an error, not a reason to generate a new key")
	}
	if err := os.Chmod(keyPath, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(keyPath)
	if err != nil || string(got) != string(first) {
		t.Fatal("the original key was overwritten")
	}
}

func TestKeyCreationIsExclusive(t *testing.T) {
	dir := t.TempDir()
	const racers = 8
	keys := make(chan string, racers)
	for i := 0; i < racers; i++ {
		go func() {
			k, err := New(dir).encKey()
			if err != nil {
				keys <- "error: " + err.Error()
				return
			}
			keys <- string(k)
		}()
	}
	first := <-keys
	for i := 1; i < racers; i++ {
		if k := <-keys; k != first {
			t.Fatal("concurrent starts ended up with different keys: the cache would be undecryptable by some of them")
		}
	}
}

// A store whose database failed to open must degrade to "empty", never panic.
func TestStoreWithoutDatabaseDoesNotPanic(t *testing.T) {
	s := &Store{}
	if s.Playlists() != nil || s.PlaylistTracks("x") != nil || s.SongsByAlbum("x") != nil {
		t.Error("expected empty results")
	}
	s.SetPlaylistTracks("x", nil)
	s.Ingest(IngestPayload{})
	if !s.NeedsSync() {
		t.Error("a store without a database always needs a sync")
	}
	_, _, _, _ = s.Stats()
}

// A dump written by a newer layout is ignored instead of half-loaded.
func TestLoadIgnoresNewerCacheFormat(t *testing.T) {
	dir := t.TempDir()
	s := New(dir)
	plain := []byte(`{"version":99,"songs":[{"libraryId":"x","name":"n"}]}`)
	enc, err := s.encrypt(plain)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "library.enc"), enc, 0o600); err != nil {
		t.Fatal(err)
	}
	s2 := New(dir)
	if songs, _, _, _ := s2.Stats(); songs != 0 {
		t.Fatalf("loaded %d songs from a newer format", songs)
	}
}
