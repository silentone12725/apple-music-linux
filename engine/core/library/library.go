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
	"errors"
	"fmt"
	"io"
	"io/fs"
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
	LibraryID   string `json:"lid"`
	CatalogID   string `json:"cid,omitempty"`
	Name        string `json:"name"`
	Artist      string `json:"artist"`
	Album       string `json:"album"`
	AlbumID     string `json:"albumId,omitempty"`
	DurationMs  int    `json:"ms"`
	TrackNumber int    `json:"track,omitempty"`
	DiscNumber  int    `json:"disc,omitempty"`
}

// AlbumInfo is the minimal metadata we cache per library album.
type AlbumInfo struct {
	LibraryID  string `json:"lid"`
	CatalogID  string `json:"cid,omitempty"`
	Name       string `json:"name"`
	Artist     string `json:"artist"`
	TrackCount int    `json:"trackCount"`
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
	key     []byte // cached encryption key; loaded once in encKey()
	keyMu   sync.Mutex
}

// New creates a Store, initialises the in-memory schema, and loads any
// existing encrypted cache from disk.
func New(cacheDir string) *Store {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		log.Printf("[library] open in-memory db: %v", err)
		return &Store{keyPath: filepath.Join(cacheDir, "library.key"), encPath: filepath.Join(cacheDir, "library.enc")}
	}
	// ":memory:" gives every connection its own empty database, so there must be exactly
	// one connection and it must never be recycled.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	db.SetConnMaxIdleTime(0)
	s := &Store{
		db:      db,
		keyPath: filepath.Join(cacheDir, "library.key"),
		encPath: filepath.Join(cacheDir, "library.enc"),
	}
	if err := s.initSchema(); err != nil {
		log.Printf("[library] init schema: %v — library cache disabled", err)
		db.Close() //nolint:errcheck
		s.db = nil
		return s
	}
	s.load()
	return s
}

// initSchema creates the tables. The database lives in memory and is rebuilt from the
// encrypted dump on every start, so the schema is simply its current shape; the dump
// carries its own format version (see cacheFormatVersion).
func (s *Store) initSchema() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS songs (
			lid TEXT PRIMARY KEY, cid TEXT, name TEXT, artist TEXT, album TEXT, ms INTEGER,
			album_id TEXT NOT NULL DEFAULT '', track_number INTEGER NOT NULL DEFAULT 0,
			disc_number INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS idx_songs_album_id ON songs(album_id);
		CREATE TABLE IF NOT EXISTS playlists (
			lid TEXT PRIMARY KEY, name TEXT, track_count INTEGER
		);
		CREATE TABLE IF NOT EXISTS playlist_tracks (
			playlist_id TEXT, position INTEGER, lid TEXT, cid TEXT,
			PRIMARY KEY (playlist_id, position)
		);
		CREATE TABLE IF NOT EXISTS albums (
			lid TEXT PRIMARY KEY, cid TEXT, name TEXT, artist TEXT, track_count INTEGER
		);
		CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
	`)
	return err
}

// ── Encryption helpers ────────────────────────────────────────────────────────

func (s *Store) encKey() ([]byte, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	if len(s.key) == 32 {
		return s.key, nil
	}
	read := func() ([]byte, error) {
		data, err := os.ReadFile(s.keyPath)
		if err != nil {
			return nil, err
		}
		if len(data) != 32 {
			return nil, fmt.Errorf("key file wrong length %d (expected 32) — delete %s to reset", len(data), s.keyPath)
		}
		return data, nil
	}
	data, err := read()
	if err == nil {
		s.key = data
		return s.key, nil
	}
	// Only a missing file means "no key yet". Any other failure (permissions, I/O) must
	// not mint a new key: that would overwrite the real one and orphan the cache.
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("read key: %w", err)
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate key: %w", err)
	}
	// O_EXCL: if another process created the key since our read, use theirs.
	f, err := os.OpenFile(s.keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			if data, rerr := read(); rerr == nil {
				s.key = data
				return s.key, nil
			}
		}
		return nil, fmt.Errorf("write key: %w", err)
	}
	if _, err := f.Write(key); err != nil {
		f.Close()
		os.Remove(s.keyPath) //nolint:errcheck
		return nil, fmt.Errorf("write key: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(s.keyPath) //nolint:errcheck
		return nil, fmt.Errorf("write key: %w", err)
	}
	s.key = key
	return s.key, nil
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

// cacheFormatVersion is the layout of the encrypted dump. A dump from a newer layout is
// ignored (and rebuilt by the next sync) rather than half-understood.
const cacheFormatVersion = 1

type diskCache struct {
	Version   int                        `json:"version,omitempty"`
	Songs     []SongInfo                 `json:"songs"`
	Albums    []AlbumInfo                `json:"albums"`
	Playlists []PlaylistInfo             `json:"playlists"`
	PlTracks  map[string][]PlaylistTrack `json:"playlistTracks"`
	SyncedAt  time.Time                  `json:"syncedAt"`
	Revision  string                     `json:"revision,omitempty"`
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
	if dc.Version > cacheFormatVersion {
		log.Printf("[library] cache format v%d is newer than this build understands (v%d) — ignoring it", dc.Version, cacheFormatVersion)
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[library] load begin tx: %v", err)
		return
	}
	defer tx.Rollback() //nolint:errcheck
	if err := loadTx(tx, &dc); err != nil {
		log.Printf("[library] load: %v", err)
		return
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[library] load commit: %v", err)
		return
	}
	log.Printf("[library] cache loaded: %d songs, %d playlists (synced %s ago)",
		len(dc.Songs), len(dc.Playlists), time.Since(dc.SyncedAt).Round(time.Second))
}

func loadTx(tx *sql.Tx, dc *diskCache) error {
	for _, sg := range dc.Songs {
		if _, err := tx.Exec("INSERT OR REPLACE INTO songs(lid,cid,name,artist,album,album_id,ms,track_number,disc_number) VALUES(?,?,?,?,?,?,?,?,?)",
			sg.LibraryID, sg.CatalogID, sg.Name, sg.Artist, sg.Album, sg.AlbumID, sg.DurationMs, sg.TrackNumber, sg.DiscNumber); err != nil {
			return fmt.Errorf("songs: %w", err)
		}
	}
	for _, al := range dc.Albums {
		if _, err := tx.Exec("INSERT OR REPLACE INTO albums(lid,cid,name,artist,track_count) VALUES(?,?,?,?,?)",
			al.LibraryID, al.CatalogID, al.Name, al.Artist, al.TrackCount); err != nil {
			return fmt.Errorf("albums: %w", err)
		}
	}
	for _, pl := range dc.Playlists {
		if _, err := tx.Exec("INSERT OR REPLACE INTO playlists(lid,name,track_count) VALUES(?,?,?)",
			pl.LibraryID, pl.Name, pl.TrackCount); err != nil {
			return fmt.Errorf("playlists: %w", err)
		}
	}
	for plID, tracks := range dc.PlTracks {
		for i, t := range tracks {
			if _, err := tx.Exec("INSERT OR REPLACE INTO playlist_tracks(playlist_id,position,lid,cid) VALUES(?,?,?,?)",
				plID, i, t.LibraryID, t.CatalogID); err != nil {
				return fmt.Errorf("playlist_tracks: %w", err)
			}
		}
	}
	if _, err := tx.Exec("INSERT OR REPLACE INTO meta(key,value) VALUES('synced_at',?)",
		dc.SyncedAt.Format(time.RFC3339)); err != nil {
		return fmt.Errorf("meta: %w", err)
	}
	if dc.Revision != "" {
		if _, err := tx.Exec("INSERT OR REPLACE INTO meta(key,value) VALUES('revision',?)", dc.Revision); err != nil {
			return fmt.Errorf("meta: %w", err)
		}
	}
	return nil
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
	albums := queryAlbumsInTx(rtx)
	pls := s.queryPlaylistsInTx(rtx)
	plTracks := s.queryAllPlaylistTracksInTx(rtx)
	syncedAt := s.querySyncedAtInTx(rtx)
	var revision string
	rtx.QueryRow("SELECT value FROM meta WHERE key='revision'").Scan(&revision) //nolint:errcheck — absent is fine
	rtx.Commit()                                                                //nolint:errcheck — read-only, no changes to commit

	plain, err := json.Marshal(diskCache{Version: cacheFormatVersion, Songs: songs, Albums: albums, Playlists: pls, PlTracks: plTracks, SyncedAt: syncedAt, Revision: revision})
	if err != nil {
		log.Printf("[library] save marshal: %v", err)
		return
	}
	enc, err := s.encrypt(plain)
	if err != nil {
		log.Printf("[library] save encrypt: %v", err)
		return
	}
	// Write-then-rename so a crash mid-save never leaves a truncated library.enc.
	tmp := s.encPath + ".tmp"
	if err := os.WriteFile(tmp, enc, 0o600); err != nil {
		log.Printf("[library] save write: %v", err)
		return
	}
	if err := os.Rename(tmp, s.encPath); err != nil {
		os.Remove(tmp)
		log.Printf("[library] save rename: %v", err)
	}
}

// ── Query helpers ─────────────────────────────────────────────────────────────

// querySongs / queryPlaylists / queryAllPlaylistTracks / querySyncedAt all have
// *InTx variants used by save() so the full dump is one consistent snapshot.

func (s *Store) querySongsInTx(tx *sql.Tx) []SongInfo {
	if tx == nil && s.db == nil {
		return nil
	}
	q := "SELECT lid,cid,name,artist,album,album_id,ms,track_number,disc_number FROM songs"
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
		if err := rows.Scan(&sg.LibraryID, &sg.CatalogID, &sg.Name, &sg.Artist, &sg.Album, &sg.AlbumID, &sg.DurationMs, &sg.TrackNumber, &sg.DiscNumber); err != nil {
			log.Printf("[library] scan song: %v", err)
			continue
		}
		out = append(out, sg)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[library] read songs: %v", err)
		return nil
	}
	return out
}

func queryAlbumsInTx(tx *sql.Tx) []AlbumInfo {
	rows, err := tx.Query("SELECT lid,cid,name,artist,track_count FROM albums")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []AlbumInfo
	for rows.Next() {
		var al AlbumInfo
		if err := rows.Scan(&al.LibraryID, &al.CatalogID, &al.Name, &al.Artist, &al.TrackCount); err != nil {
			log.Printf("[library] scan album: %v", err)
			continue
		}
		out = append(out, al)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[library] read albums: %v", err)
		return nil
	}
	return out
}

func (s *Store) queryPlaylists() []PlaylistInfo { return s.queryPlaylistsInTx(nil) }
func (s *Store) queryPlaylistsInTx(tx *sql.Tx) []PlaylistInfo {
	if tx == nil && s.db == nil {
		return nil
	}
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
		if err := rows.Scan(&pl.LibraryID, &pl.Name, &pl.TrackCount); err != nil {
			log.Printf("[library] scan playlist: %v", err)
			continue
		}
		out = append(out, pl)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[library] read playlists: %v", err)
		return nil // a partial list must not pass for the whole library
	}
	return out
}

func (s *Store) queryAllPlaylistTracksInTx(tx *sql.Tx) map[string][]PlaylistTrack {
	if tx == nil && s.db == nil {
		return nil
	}
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
		if err := rows.Scan(&plID, &t.LibraryID, &t.CatalogID); err != nil {
			log.Printf("[library] scan playlist track: %v", err)
			continue
		}
		out[plID] = append(out[plID], t)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[library] read playlist tracks: %v", err)
		return nil
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
		if err := rows.Scan(&t.LibraryID, &t.CatalogID); err != nil {
			log.Printf("[library] scan playlist track: %v", err)
			return nil
		}
		tracks = append(tracks, t)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[library] read playlist %s: %v", playlistID, err)
		return nil
	}
	return tracks // nil if no rows (= not cached)
}

// SongsByAlbum returns ordered tracks for a library album ID (e.g. "l.1OBwMCC").
// Returns nil when the album is not in the local DB (not yet synced or album_id absent).
func (s *Store) SongsByAlbum(albumID string) []PlaylistTrack {
	if s.db == nil || albumID == "" {
		return nil
	}
	rows, err := s.db.Query(
		"SELECT lid, cid FROM songs WHERE album_id = ? ORDER BY disc_number ASC, track_number ASC, rowid ASC", albumID)
	if err != nil || rows == nil {
		return nil
	}
	defer rows.Close()
	var out []PlaylistTrack
	for rows.Next() {
		var t PlaylistTrack
		if err := rows.Scan(&t.LibraryID, &t.CatalogID); err != nil {
			log.Printf("[library] scan album track: %v", err)
			return nil
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[library] read album %s: %v", albumID, err)
		return nil
	}
	return out
}

// Playlists returns all cached playlists.
func (s *Store) Playlists() []PlaylistInfo {
	return s.queryPlaylists()
}

// Stats returns current cache size info.
func (s *Store) Stats() (songs, albums, playlists int, syncedAt time.Time) {
	if s.db == nil {
		return
	}
	s.db.QueryRow("SELECT COUNT(*) FROM songs").Scan(&songs)
	s.db.QueryRow("SELECT COUNT(*) FROM albums").Scan(&albums)
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
	if _, err := tx.Exec("DELETE FROM playlist_tracks WHERE playlist_id=?", playlistID); err != nil {
		log.Printf("[library] set playlist tracks delete: %v", err)
		return
	}
	for i, t := range tracks {
		if _, err := tx.Exec("INSERT INTO playlist_tracks(playlist_id,position,lid,cid) VALUES(?,?,?,?)",
			playlistID, i, t.LibraryID, t.CatalogID); err != nil {
			log.Printf("[library] set playlist tracks insert: %v", err)
			return
		}
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
	Albums         []amItem            `json:"albums"`
	Playlists      []amItem            `json:"playlists"`
	PlaylistTracks map[string][]amItem `json:"playlistTracks"` // playlistID → items
	Revision       string              `json:"revision"`       // opaque revision token for delta sync
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
	for _, q := range []string{"DELETE FROM songs", "DELETE FROM albums", "DELETE FROM playlists", "DELETE FROM playlist_tracks"} {
		if _, err := tx.Exec(q); err != nil {
			log.Printf("[library] ingest %s: %v", q, err)
			return
		}
	}

	if err := ingestSongs(tx, p.Songs); err != nil {
		log.Printf("[library] %v", err)
		return
	}
	if err := ingestAlbums(tx, p.Albums); err != nil {
		log.Printf("[library] %v", err)
		return
	}
	if err := ingestPlaylists(tx, p.Playlists); err != nil {
		log.Printf("[library] %v", err)
		return
	}
	if err := ingestPlaylistTracks(tx, p.PlaylistTracks); err != nil {
		log.Printf("[library] %v", err)
		return
	}

	if _, err := tx.Exec("INSERT OR REPLACE INTO meta(key,value) VALUES('synced_at',?)",
		time.Now().Format(time.RFC3339)); err != nil {
		log.Printf("[library] ingest meta: %v", err)
		return
	}
	if p.Revision != "" {
		if _, err := tx.Exec("INSERT OR REPLACE INTO meta(key,value) VALUES('revision',?)", p.Revision); err != nil {
			log.Printf("[library] ingest meta: %v", err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[library] ingest commit: %v", err)
		return
	}

	log.Printf("[library] ingested: %d songs, %d albums, %d playlists", len(p.Songs), len(p.Albums), len(p.Playlists))
	go s.save()
}

func ingestSongs(tx *sql.Tx, songs []amItem) error {
	stmt, err := tx.Prepare("INSERT OR REPLACE INTO songs(lid,cid,name,artist,album,album_id,ms,track_number,disc_number) VALUES(?,?,?,?,?,?,?,?,?)")
	if err != nil {
		return fmt.Errorf("ingest prepare songs: %w", err)
	}
	defer stmt.Close()
	for _, item := range songs {
		cid := item.Attributes.PlayParams.CatalogID
		if cid == "" {
			cid = item.Attributes.PlayParams.ID
		}
		if cid == "" && len(item.Relationships.Catalog.Data) > 0 {
			cid = item.Relationships.Catalog.Data[0].ID
		}
		albumID := ""
		if len(item.Relationships.Albums.Data) > 0 {
			albumID = item.Relationships.Albums.Data[0].ID
		}
		if _, err := stmt.Exec(item.ID, cid, item.Attributes.Name, item.Attributes.ArtistName,
			item.Attributes.AlbumName, albumID, item.Attributes.DurationInMillis,
			item.Attributes.TrackNumber, item.Attributes.DiscNumber); err != nil {
			return fmt.Errorf("ingest song %s: %w", item.ID, err)
		}
	}
	return nil
}

func ingestAlbums(tx *sql.Tx, albums []amItem) error {
	stmt, err := tx.Prepare("INSERT OR REPLACE INTO albums(lid,cid,name,artist,track_count) VALUES(?,?,?,?,?)")
	if err != nil {
		return fmt.Errorf("ingest prepare albums: %w", err)
	}
	defer stmt.Close()
	for _, item := range albums {
		cid := item.Attributes.PlayParams.CatalogID
		if cid == "" {
			cid = item.Attributes.PlayParams.ID
		}
		if cid == "" && len(item.Relationships.Catalog.Data) > 0 {
			cid = item.Relationships.Catalog.Data[0].ID
		}
		if _, err := stmt.Exec(item.ID, cid, item.Attributes.Name, item.Attributes.ArtistName, item.Attributes.TrackCount); err != nil {
			return fmt.Errorf("ingest album %s: %w", item.ID, err)
		}
	}
	return nil
}

func ingestPlaylists(tx *sql.Tx, playlists []amItem) error {
	stmt, err := tx.Prepare("INSERT OR REPLACE INTO playlists(lid,name,track_count) VALUES(?,?,?)")
	if err != nil {
		return fmt.Errorf("ingest prepare playlists: %w", err)
	}
	defer stmt.Close()
	for _, item := range playlists {
		if _, err := stmt.Exec(item.ID, item.Attributes.Name, item.Attributes.TrackCount); err != nil {
			return fmt.Errorf("ingest playlist %s: %w", item.ID, err)
		}
	}
	return nil
}

func ingestPlaylistTracks(tx *sql.Tx, tracks map[string][]amItem) error {
	stmt, err := tx.Prepare("INSERT INTO playlist_tracks(playlist_id,position,lid,cid) VALUES(?,?,?,?)")
	if err != nil {
		return fmt.Errorf("ingest prepare playlist_tracks: %w", err)
	}
	defer stmt.Close()
	for plID, items := range tracks {
		for i, item := range items {
			cid := item.Attributes.PlayParams.CatalogID
			if cid == "" {
				cid = item.Attributes.PlayParams.ID
			}
			if _, err := stmt.Exec(plID, i, item.ID, cid); err != nil {
				return fmt.Errorf("ingest playlist %s track %d: %w", plID, i, err)
			}
		}
	}
	return nil
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

type amRelationships struct {
	Albums struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	} `json:"albums"`
	Catalog struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	} `json:"catalog"`
}

type amItem struct {
	ID            string          `json:"id"`
	Type          string          `json:"type"`
	Attributes    amAttributes    `json:"attributes"`
	Relationships amRelationships `json:"relationships"`
}

type amAttributes struct {
	Name             string       `json:"name"`
	ArtistName       string       `json:"artistName"`
	AlbumName        string       `json:"albumName"`
	DurationInMillis int          `json:"durationInMillis"`
	TrackCount       int          `json:"trackCount"`
	TrackNumber      int          `json:"trackNumber"`
	DiscNumber       int          `json:"discNumber"`
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
