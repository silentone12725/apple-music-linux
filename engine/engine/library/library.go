// Package library provides an encrypted local metadata cache for the user's
// Apple Music library — songs, playlists, and playlist membership — mirroring
// what Android's MediaLibrary and Windows' AMPLibraryAgent do with their local
// SQLite stores.
//
// Runtime: in-memory SQLite (modernc.org/sqlite) for fast indexed queries.
// Persistence: AES-256-GCM encrypted JSON at ~/.cache/apple-music-linux/library.enc.
// Key: 32-byte random key auto-generated at ~/.cache/apple-music-linux/library.key.
//
// Data is populated by the JS layer via Ingest() — MusicKit JS fetches from
// Apple's API (handling auth internally) and POSTs the result to the engine.
package library

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/go-resty/resty/v2"
)

const (
	apiBase    = "https://amp-api.music.apple.com"
	pageLimit  = 100
	syncMaxAge = 24 * time.Hour
)

// SongInfo is the minimal metadata we cache per library song.
type SongInfo struct {
	LibraryID  string `json:"lid"`
	CatalogID  string `json:"cid,omitempty"`
	Name       string `json:"name"`
	Artist     string `json:"artist"`
	Album      string `json:"album"`
	DurationMs int    `json:"ms"`
}

// PlaylistInfo is the minimal metadata we cache per library playlist.
type PlaylistInfo struct {
	LibraryID  string `json:"lid"`
	Name       string `json:"name"`
	TrackCount int    `json:"trackCount"`
}

// PlaylistTrack is one entry in an ordered playlist track list.
type PlaylistTrack struct {
	LibraryID string `json:"lid"`
	CatalogID string `json:"cid,omitempty"`
}

// Store is the library cache backed by in-memory SQLite with encrypted persistence.
type Store struct {
	db      *sql.DB
	saveMu  sync.Mutex // serialises save()
	keyPath string
	encPath string
}

// New creates a Store, initialises the in-memory schema, and loads any
// existing encrypted cache from disk.
func New(cacheDir string) *Store {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		log.Printf("[library] open in-memory db: %v", err)
		return &Store{keyPath: filepath.Join(cacheDir, "library.key"), encPath: filepath.Join(cacheDir, "library.enc")}
	}
	db.SetMaxOpenConns(1)
	s := &Store{
		db:      db,
		keyPath: filepath.Join(cacheDir, "library.key"),
		encPath: filepath.Join(cacheDir, "library.enc"),
	}
	s.initSchema()
	s.load()
	return s
}

func (s *Store) initSchema() {
	s.db.Exec(`
		CREATE TABLE IF NOT EXISTS songs (
			lid TEXT PRIMARY KEY, cid TEXT, name TEXT, artist TEXT, album TEXT, ms INTEGER
		);
		CREATE TABLE IF NOT EXISTS playlists (
			lid TEXT PRIMARY KEY, name TEXT, track_count INTEGER
		);
		CREATE TABLE IF NOT EXISTS playlist_tracks (
			playlist_id TEXT, position INTEGER, lid TEXT, cid TEXT,
			PRIMARY KEY (playlist_id, position)
		);
		CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
	`)
}

// ── Encryption helpers ────────────────────────────────────────────────────────

func (s *Store) encKey() ([]byte, error) {
	data, err := os.ReadFile(s.keyPath)
	if err == nil && len(data) == 32 {
		return data, nil
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}
	if err := os.WriteFile(s.keyPath, key, 0o600); err != nil {
		return nil, fmt.Errorf("write key: %w", err)
	}
	return key, nil
}

func (s *Store) encrypt(plain []byte) ([]byte, error) {
	key, err := s.encKey()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plain, nil), nil
}

func (s *Store) decrypt(data []byte) ([]byte, error) {
	key, err := s.encKey()
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(data) < gcm.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	return gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
}

// ── Persistence ───────────────────────────────────────────────────────────────

type diskCache struct {
	Songs     []SongInfo               `json:"songs"`
	Playlists []PlaylistInfo           `json:"playlists"`
	PlTracks  map[string][]PlaylistTrack `json:"playlistTracks"`
	SyncedAt  time.Time                `json:"syncedAt"`
}

func (s *Store) load() {
	if s.db == nil {
		return
	}
	data, err := os.ReadFile(s.encPath)
	if err != nil {
		return // no cache yet
	}
	plain, err := s.decrypt(data)
	if err != nil {
		log.Printf("[library] load decrypt: %v", err)
		return
	}
	var dc diskCache
	if err := json.Unmarshal(plain, &dc); err != nil {
		log.Printf("[library] load unmarshal: %v", err)
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[library] load begin tx: %v", err)
		return
	}
	defer tx.Rollback() //nolint:errcheck
	for _, sg := range dc.Songs {
		tx.Exec("INSERT OR REPLACE INTO songs(lid,cid,name,artist,album,ms) VALUES(?,?,?,?,?,?)",
			sg.LibraryID, sg.CatalogID, sg.Name, sg.Artist, sg.Album, sg.DurationMs)
	}
	for _, pl := range dc.Playlists {
		tx.Exec("INSERT OR REPLACE INTO playlists(lid,name,track_count) VALUES(?,?,?)",
			pl.LibraryID, pl.Name, pl.TrackCount)
	}
	for plID, tracks := range dc.PlTracks {
		for i, t := range tracks {
			tx.Exec("INSERT OR REPLACE INTO playlist_tracks(playlist_id,position,lid,cid) VALUES(?,?,?,?)",
				plID, i, t.LibraryID, t.CatalogID)
		}
	}
	tx.Exec("INSERT OR REPLACE INTO meta(key,value) VALUES('synced_at',?)",
		dc.SyncedAt.Format(time.RFC3339))
	if err := tx.Commit(); err != nil {
		log.Printf("[library] load commit: %v", err)
		return
	}
	log.Printf("[library] cache loaded: %d songs, %d playlists (synced %s ago)",
		len(dc.Songs), len(dc.Playlists), time.Since(dc.SyncedAt).Round(time.Second))
}

func (s *Store) save() {
	if s.db == nil {
		return
	}
	s.saveMu.Lock()
	defer s.saveMu.Unlock()

	// Dump all tables inside a read transaction so a concurrent Ingest() cannot
	// delete+reinsert between our individual queries, producing a split-brain JSON.
	rtx, err := s.db.Begin()
	if err != nil {
		log.Printf("[library] save begin read tx: %v", err)
		return
	}
	defer rtx.Rollback() //nolint:errcheck — read tx, rollback is always safe
	songs := s.querySongsInTx(rtx)
	pls := s.queryPlaylistsInTx(rtx)
	plTracks := s.queryAllPlaylistTracksInTx(rtx)
	syncedAt := s.querySyncedAtInTx(rtx)
	rtx.Commit() //nolint:errcheck — read-only, no changes to commit

	plain, err := json.Marshal(diskCache{Songs: songs, Playlists: pls, PlTracks: plTracks, SyncedAt: syncedAt})
	if err != nil {
		log.Printf("[library] save marshal: %v", err)
		return
	}
	enc, err := s.encrypt(plain)
	if err != nil {
		log.Printf("[library] save encrypt: %v", err)
		return
	}
	if err := os.WriteFile(s.encPath, enc, 0o600); err != nil {
		log.Printf("[library] save write: %v", err)
	}
}

// ── Query helpers ─────────────────────────────────────────────────────────────

// querySongs / queryPlaylists / queryAllPlaylistTracks / querySyncedAt all have
// *InTx variants used by save() so the full dump is one consistent snapshot.

func (s *Store) querySongs() []SongInfo { return s.querySongsInTx(nil) }
func (s *Store) querySongsInTx(tx *sql.Tx) []SongInfo {
	q := "SELECT lid,cid,name,artist,album,ms FROM songs"
	var rows *sql.Rows
	if tx != nil {
		rows, _ = tx.Query(q)
	} else {
		rows, _ = s.db.Query(q)
	}
	if rows == nil {
		return nil
	}
	defer rows.Close()
	var out []SongInfo
	for rows.Next() {
		var sg SongInfo
		rows.Scan(&sg.LibraryID, &sg.CatalogID, &sg.Name, &sg.Artist, &sg.Album, &sg.DurationMs)
		out = append(out, sg)
	}
	return out
}

func (s *Store) queryPlaylists() []PlaylistInfo { return s.queryPlaylistsInTx(nil) }
func (s *Store) queryPlaylistsInTx(tx *sql.Tx) []PlaylistInfo {
	q := "SELECT lid,name,track_count FROM playlists"
	var rows *sql.Rows
	if tx != nil {
		rows, _ = tx.Query(q)
	} else {
		rows, _ = s.db.Query(q)
	}
	if rows == nil {
		return nil
	}
	defer rows.Close()
	var out []PlaylistInfo
	for rows.Next() {
		var pl PlaylistInfo
		rows.Scan(&pl.LibraryID, &pl.Name, &pl.TrackCount)
		out = append(out, pl)
	}
	return out
}

func (s *Store) queryAllPlaylistTracks() map[string][]PlaylistTrack {
	return s.queryAllPlaylistTracksInTx(nil)
}
func (s *Store) queryAllPlaylistTracksInTx(tx *sql.Tx) map[string][]PlaylistTrack {
	q := "SELECT playlist_id,lid,cid FROM playlist_tracks ORDER BY playlist_id,position"
	var rows *sql.Rows
	if tx != nil {
		rows, _ = tx.Query(q)
	} else {
		rows, _ = s.db.Query(q)
	}
	if rows == nil {
		return nil
	}
	defer rows.Close()
	out := map[string][]PlaylistTrack{}
	for rows.Next() {
		var plID string
		var t PlaylistTrack
		rows.Scan(&plID, &t.LibraryID, &t.CatalogID)
		out[plID] = append(out[plID], t)
	}
	return out
}

func (s *Store) querySyncedAt() time.Time { return s.querySyncedAtInTx(nil) }
func (s *Store) querySyncedAtInTx(tx *sql.Tx) time.Time {
	var val string
	if tx != nil {
		tx.QueryRow("SELECT value FROM meta WHERE key='synced_at'").Scan(&val)
	} else {
		s.db.QueryRow("SELECT value FROM meta WHERE key='synced_at'").Scan(&val)
	}
	if val == "" {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339, val)
	return t
}

// ── Public API ────────────────────────────────────────────────────────────────

// NeedsSync reports whether a sync should run.
// Uses a time-gate rather than a count-gate so a genuinely empty library
// (user has no Apple Music songs) doesn't trigger an infinite retry loop.
// Returns true only when no sync has ever completed or the last sync is stale.
func (s *Store) NeedsSync() bool {
	if s.db == nil {
		return true
	}
	t := s.querySyncedAt()
	if t.IsZero() {
		return true // never synced
	}
	return time.Since(t) > syncMaxAge
}

// PlaylistTracks returns the ordered track list for a playlist ID, or nil if not cached.
func (s *Store) PlaylistTracks(playlistID string) []PlaylistTrack {
	if s.db == nil {
		return nil
	}
	rows, err := s.db.Query(
		"SELECT lid,cid FROM playlist_tracks WHERE playlist_id=? ORDER BY position", playlistID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var tracks []PlaylistTrack
	for rows.Next() {
		var t PlaylistTrack
		rows.Scan(&t.LibraryID, &t.CatalogID)
		tracks = append(tracks, t)
	}
	return tracks // nil if no rows (= not cached)
}

// Playlists returns all cached playlists.
func (s *Store) Playlists() []PlaylistInfo {
	return s.queryPlaylists()
}

// Stats returns current cache size info.
func (s *Store) Stats() (songs, playlists int, syncedAt time.Time) {
	if s.db == nil {
		return
	}
	s.db.QueryRow("SELECT COUNT(*) FROM songs").Scan(&songs)
	s.db.QueryRow("SELECT COUNT(*) FROM playlists").Scan(&playlists)
	syncedAt = s.querySyncedAt()
	return
}

// SetPlaylistTracks caches a fetched track list for a playlist.
func (s *Store) SetPlaylistTracks(playlistID string, tracks []PlaylistTrack) {
	if s.db == nil {
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback() //nolint:errcheck
	tx.Exec("DELETE FROM playlist_tracks WHERE playlist_id=?", playlistID)
	for i, t := range tracks {
		tx.Exec("INSERT INTO playlist_tracks(playlist_id,position,lid,cid) VALUES(?,?,?,?)",
			playlistID, i, t.LibraryID, t.CatalogID)
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[library] set playlist tracks commit: %v", err)
		return
	}
	go s.save()
}

// IngestPayload is sent by the JS library sync function.
// Items match the Apple Music API response schema.
type IngestPayload struct {
	Songs          []amItem            `json:"songs"`
	Playlists      []amItem            `json:"playlists"`
	PlaylistTracks map[string][]amItem `json:"playlistTracks"` // playlistID → items
	Revision       string              `json:"revision"`        // opaque revision token for delta sync
}

// Ingest replaces the cache with pre-fetched library data from the JS layer.
// MusicKit JS owns authentication; the engine stores and encrypts the result.
func (s *Store) Ingest(p IngestPayload) {
	if s.db == nil {
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[library] ingest begin tx: %v", err)
		return
	}
	defer tx.Rollback() //nolint:errcheck
	tx.Exec("DELETE FROM songs")
	tx.Exec("DELETE FROM playlists")
	tx.Exec("DELETE FROM playlist_tracks")

	for _, item := range p.Songs {
		cid := item.Attributes.PlayParams.CatalogID
		if cid == "" {
			cid = item.Attributes.PlayParams.ID
		}
		tx.Exec("INSERT INTO songs(lid,cid,name,artist,album,ms) VALUES(?,?,?,?,?,?)",
			item.ID, cid, item.Attributes.Name, item.Attributes.ArtistName,
			item.Attributes.AlbumName, item.Attributes.DurationInMillis)
	}
	for _, item := range p.Playlists {
		tx.Exec("INSERT INTO playlists(lid,name,track_count) VALUES(?,?,?)",
			item.ID, item.Attributes.Name, item.Attributes.TrackCount)
	}
	for plID, items := range p.PlaylistTracks {
		for i, item := range items {
			cid := item.Attributes.PlayParams.CatalogID
			if cid == "" {
				cid = item.Attributes.PlayParams.ID
			}
			tx.Exec("INSERT INTO playlist_tracks(playlist_id,position,lid,cid) VALUES(?,?,?,?)",
				plID, i, item.ID, cid)
		}
	}
	tx.Exec("INSERT OR REPLACE INTO meta(key,value) VALUES('synced_at',?)",
		time.Now().Format(time.RFC3339))
	if p.Revision != "" {
		tx.Exec("INSERT OR REPLACE INTO meta(key,value) VALUES('revision',?)", p.Revision)
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[library] ingest commit: %v", err)
		return
	}

	songs, pls, _ := s.Stats()
	log.Printf("[library] ingested: %d songs, %d playlists", songs, pls)
	go s.save() // encrypt and persist in background
}

// FetchPlaylistTracksOnce fetches one playlist's track list directly from the
// Apple Music API without a full sync. Used as a live fallback when a
// cross-playlist click arrives before the cache is populated.
func FetchPlaylistTracksOnce(ctx context.Context, token, mut, playlistID string) ([]PlaylistTrack, error) {
	c := resty.New().
		SetBaseURL(apiBase).
		SetHeader("Authorization", "Bearer "+token).
		SetHeader("Music-User-Token", mut)
	return fetchPlaylistTracks(ctx, c, playlistID)
}

// ── Apple Music API types (used by IngestPayload and FetchPlaylistTracksOnce) ─

type amResponse struct {
	Data []amItem `json:"data"`
	Next string   `json:"next"`
}

type amItem struct {
	ID         string       `json:"id"`
	Type       string       `json:"type"`
	Attributes amAttributes `json:"attributes"`
}

type amAttributes struct {
	Name             string      `json:"name"`
	ArtistName       string      `json:"artistName"`
	AlbumName        string      `json:"albumName"`
	DurationInMillis int         `json:"durationInMillis"`
	TrackCount       int         `json:"trackCount"`
	PlayParams       amPlayParams `json:"playParams"`
}

type amPlayParams struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	IsLibrary bool   `json:"isLibrary"`
	CatalogID string `json:"catalogId"`
}

func fetchPlaylistTracks(ctx context.Context, c *resty.Client, playlistID string) ([]PlaylistTrack, error) {
	var all []PlaylistTrack
	path := fmt.Sprintf("/v1/me/library/playlists/%s/tracks", playlistID)
	params := map[string]string{"limit": fmt.Sprintf("%d", pageLimit)}
	for path != "" {
		var resp amResponse
		r, err := c.R().SetContext(ctx).SetQueryParams(params).SetResult(&resp).Get(path)
		if err != nil {
			return nil, err
		}
		if r.IsError() {
			return nil, fmt.Errorf("API %s: %s", path, r.Status())
		}
		for _, item := range resp.Data {
			t := PlaylistTrack{
				LibraryID: item.ID,
				CatalogID: item.Attributes.PlayParams.CatalogID,
			}
			if t.CatalogID == "" {
				t.CatalogID = item.Attributes.PlayParams.ID
			}
			all = append(all, t)
		}
		// Apple's next URL omits the limit param on page 2+; re-attach it.
		if resp.Next != "" && !strings.Contains(resp.Next, "limit=") {
			path = resp.Next + fmt.Sprintf("&limit=%d", pageLimit)
		} else {
			path = resp.Next
		}
		params = nil
	}
	return all, nil
}
