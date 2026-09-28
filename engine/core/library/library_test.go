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
