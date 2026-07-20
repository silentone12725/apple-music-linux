package export

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	mp4tag "github.com/zhaarey/go-mp4tag"
)

// TrackMeta carries the metadata needed for tagging; populated from ampapi
// catalog responses before the download begins.
type TrackMeta struct {
	Title         string
	ArtistName    string
	AlbumArtist   string
	AlbumName     string
	TrackNumber   int
	TrackTotal    int
	DiscNumber    int
	DiscTotal     int
	ReleaseDate   string // "YYYY-MM-DD"
	Genre         string
	Composer      string
	Copyright     string
	RecordLabel   string
	Isrc          string
	UPC           string
	ContentRating string // "explicit" | "clean" | ""
	DurationMs    int
	ArtworkURL    string // template URL from Apple CDN
	HasLyrics     bool
}

// TagOptions mirrors the tag-related fields from ExportOptions.
type TagOptions struct {
	EmbedArtwork bool
	ArtworkSize  int
	Lyrics       string // pre-fetched LRC string; empty = don't embed
}

// TagFile embeds metadata into the file at path using go-mp4tag.
// The file must be an fMP4 that has already been written to disk.
// TagFile is called after atomicWrite completes — the temp → final rename
// happens before tagging so we tag the real output file.
func TagFile(path string, meta TrackMeta, opts TagOptions) error {
	t := &mp4tag.MP4Tags{
		Title:       meta.Title,
		Artist:      meta.ArtistName,
		Album:       meta.AlbumName,
		AlbumArtist: meta.AlbumArtist,
		TrackNumber: int16(meta.TrackNumber),
		TrackTotal:  int16(meta.TrackTotal),
		DiscNumber:  int16(meta.DiscNumber),
		DiscTotal:   int16(meta.DiscTotal),
		Composer:    meta.Composer,
		Date:        meta.ReleaseDate,
		Copyright:   meta.Copyright,
		Publisher:   meta.RecordLabel,
		Lyrics:      opts.Lyrics,
		Custom: map[string]string{
			"ISRC":        meta.Isrc,
			"UPC":         meta.UPC,
			"LABEL":       meta.RecordLabel,
			"RELEASETIME": meta.ReleaseDate,
			"PERFORMER":   meta.ArtistName,
		},
	}

	if len(meta.Genre) > 0 {
		t.CustomGenre = meta.Genre
	}

	switch meta.ContentRating {
	case "explicit":
		t.ItunesAdvisory = mp4tag.ItunesAdvisoryExplicit
	case "clean":
		t.ItunesAdvisory = mp4tag.ItunesAdvisoryClean
	default:
		t.ItunesAdvisory = mp4tag.ItunesAdvisoryNone
	}

	// Fetch and embed artwork.
	if opts.EmbedArtwork && meta.ArtworkURL != "" {
		if pic, err := fetchArtworkPicture(meta.ArtworkURL, opts.ArtworkSize); err == nil {
			t.Pictures = []*mp4tag.MP4Picture{pic}
		}
		// Non-fatal: tag without artwork if download fails.
	}

	mp4f, err := mp4tag.Open(path)
	if err != nil {
		return fmt.Errorf("mp4tag open %s: %w", path, err)
	}
	defer mp4f.Close()

	if err := mp4f.Write(t, []string{}); err != nil {
		return fmt.Errorf("mp4tag write: %w", err)
	}
	return nil
}

// fetchArtworkPicture downloads the artwork at urlTemplate (with size applied)
// and returns an MP4Picture ready to embed via mp4tag.
func fetchArtworkPicture(urlTemplate string, size int) (*mp4tag.MP4Picture, error) {
	if size <= 0 {
		size = 3000
	}
	url := artworkURL(urlTemplate, size)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("artwork HTTP %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	imgType := mp4tag.ImageTypeJPEG
	switch resp.Header.Get("Content-Type") {
	case "image/png":
		imgType = mp4tag.ImageTypePNG
	}

	return &mp4tag.MP4Picture{Format: imgType, Data: data}, nil
}

// artworkURL formats an Apple CDN artwork URL template by substituting
// {w} and {h} with the requested pixel size.
// Apple catalog URLs use the form https://…/{w}x{h}bb.jpg.
func artworkURL(tmpl string, size int) string {
	if size <= 0 {
		size = 3000
	}
	s := fmt.Sprintf("%d", size)
	r := strings.ReplaceAll(tmpl, "{w}", s)
	r = strings.ReplaceAll(r, "{h}", s)
	return r
}
