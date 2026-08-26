package ampapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

func GetPlaylistRespContext(ctx context.Context, storefront string, id string, language string, token string, mut string) (*PlaylistResp, error) {
	var err error
	if token == "" {
		token, err = GetToken()
		if err != nil {
			return nil, err
		}
	}

	fetch := func(rawURL string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if mut != "" {
			req.Header.Set("Media-User-Token", mut)
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
		req.Header.Set("Origin", "https://music.apple.com")
		return apiClient.Do(req)
	}

	// Catalog playlist endpoint (works for Apple-curated and user-shared playlists).
	// Library playlists (/v1/me/library/playlists/) require a different path.
	baseURL := fmt.Sprintf("https://amp-api.music.apple.com/v1/catalog/%s/playlists/%s", storefront, id)
	q := url.Values{}
	q.Set("include", "tracks,artists")
	q.Set("include[songs]", "artists")
	q.Set("l", language)
	fullURL := baseURL + "?" + q.Encode()

	do, err := fetch(fullURL)
	if err != nil {
		return nil, err
	}
	defer do.Body.Close()
	if do.StatusCode != http.StatusOK {
		return nil, errors.New(do.Status)
	}
	obj := new(PlaylistResp)
	if err := json.NewDecoder(do.Body).Decode(obj); err != nil {
		return nil, err
	}
	if len(obj.Data) == 0 {
		return nil, fmt.Errorf("empty playlist response")
	}

	// Follow pagination for large playlists.
	next := obj.Data[0].Relationships.Tracks.Next
	for next != "" {
		do, err := fetch("https://amp-api.music.apple.com" + next)
		if err != nil {
			break
		}
		defer do.Body.Close()
		if do.StatusCode != http.StatusOK {
			break
		}
		page := new(TrackResp)
		if err := json.NewDecoder(do.Body).Decode(page); err != nil {
			break
		}
		obj.Data[0].Relationships.Tracks.Data = append(obj.Data[0].Relationships.Tracks.Data, page.Data...)
		next = page.Next
	}
	return obj, nil
}

// LibraryPlaylistTrackItem represents one track in a user library playlist.
// Library tracks use "library-songs" / "library-music-videos" types; the
// catalog ID lives in playParams.catalogId and is what the engine downloads.
type LibraryPlaylistTrackItem struct {
	ID   string `json:"id"`
	Type string `json:"type"` // "library-songs" | "library-music-videos"
	Attributes struct {
		Name       string `json:"name"`
		ArtistName string `json:"artistName"`
		PlayParams struct {
			CatalogId string `json:"catalogId"`
			Kind      string `json:"kind"` // "song" | "musicVideo"
		} `json:"playParams"`
	} `json:"attributes"`
}

type LibraryPlaylistTrackResp struct {
	Data []LibraryPlaylistTrackItem `json:"data"`
	Next string                     `json:"next"`
}

// GetLibraryPlaylistTracksContext fetches tracks from a user library playlist
// (IDs starting with "p."). Requires a valid MUT.
// Each track's CatalogId is the ID to pass to the export engine.
func GetLibraryPlaylistTracksContext(ctx context.Context, id, language, token, mut string) (*LibraryPlaylistTrackResp, error) {
	if mut == "" {
		return nil, errors.New("library playlist requires MUT (user must be signed in)")
	}
	if token == "" {
		var err error
		token, err = GetToken()
		if err != nil {
			return nil, err
		}
	}

	fetch := func(rawURL string) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Media-User-Token", mut)
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
		req.Header.Set("Origin", "https://music.apple.com")
		return apiClient.Do(req)
	}

	q := url.Values{}
	q.Set("include[library-songs]", "catalog")
	q.Set("include[library-music-videos]", "catalog")
	q.Set("l", language)
	q.Set("limit", "100")
	baseURL := fmt.Sprintf("https://amp-api.music.apple.com/v1/me/library/playlists/%s/tracks?%s", id, q.Encode())

	out := &LibraryPlaylistTrackResp{}
	next := baseURL
	for next != "" {
		resp, err := fetch(next)
		if err != nil {
			return nil, err
		}
		var page LibraryPlaylistTrackResp
		decErr := json.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if decErr != nil {
			return nil, decErr
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("library playlist HTTP %d", resp.StatusCode)
		}
		out.Data = append(out.Data, page.Data...)
		if strings.HasPrefix(page.Next, "/") {
			next = "https://amp-api.music.apple.com" + page.Next
		} else {
			next = page.Next
		}
	}
	if len(out.Data) == 0 {
		return nil, fmt.Errorf("library playlist %s: no tracks", id)
	}
	return out, nil
}

func GetPlaylistResp(storefront string, id string, language string, token string) (*PlaylistResp, error) {
	var err error
	if token == "" {
		token, err = GetToken()
		if err != nil {
			return nil, err
		}
	}

	req, err := http.NewRequest("GET", fmt.Sprintf("https://amp-api.music.apple.com/v1/catalog/%s/playlists/%s", storefront, id), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
	req.Header.Set("Origin", "https://music.apple.com")
	query := url.Values{}
	query.Set("omit[resource]", "autos")
	query.Set("include", "tracks,artists,record-labels")
	query.Set("include[songs]", "artists")
	//query.Set("fields[artists]", "name,artwork")
	//query.Set("fields[albums:albums]", "artistName,artwork,name,releaseDate,url")
	//query.Set("fields[record-labels]", "name")
	query.Set("extend", "editorialVideo,extendedAssetUrls")
	query.Set("l", language)
	req.URL.RawQuery = query.Encode()
	do, err := apiClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer do.Body.Close()
	if do.StatusCode != http.StatusOK {
		return nil, errors.New(do.Status)
	}
	obj := new(PlaylistResp)
	err = json.NewDecoder(do.Body).Decode(&obj)
	if err != nil {
		return nil, err
	}
	if len(obj.Data[0].Relationships.Tracks.Next) > 0 {
		next := obj.Data[0].Relationships.Tracks.Next
		for {
			req, err := http.NewRequest("GET", fmt.Sprintf("https://amp-api.music.apple.com%s", next), nil)
			if err != nil {
				return nil, err
			}
			req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))
			req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
			req.Header.Set("Origin", "https://music.apple.com")
			query := req.URL.Query()
			query.Set("omit[resource]", "autos")
			query.Set("include", "artists")
			query.Set("extend", "editorialVideo,extendedAssetUrls")
			req.URL.RawQuery = query.Encode()
			do, err := apiClient.Do(req)
			if err != nil {
				return nil, err
			}
			defer do.Body.Close()
			if do.StatusCode != http.StatusOK {
				return nil, errors.New(do.Status)
			}
			obj2 := new(TrackResp)
			err = json.NewDecoder(do.Body).Decode(&obj2)
			if err != nil {
				return nil, err
			}
			obj.Data[0].Relationships.Tracks.Data = append(obj.Data[0].Relationships.Tracks.Data, obj2.Data...)
			next = obj2.Next
			if len(next) == 0 {
				break
			}
		}
	}
	return obj, nil
}

type PlaylistResp struct {
	Href string             `json:"href"`
	Next string             `json:"next"`
	Data []PlaylistRespData `json:"data"`
}

type PlaylistRespData struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Href       string `json:"href"`
	Attributes struct {
		Artwork struct {
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			URL        string `json:"url"`
			BgColor    string `json:"bgColor"`
			TextColor1 string `json:"textColor1"`
			TextColor2 string `json:"textColor2"`
			TextColor3 string `json:"textColor3"`
			TextColor4 string `json:"textColor4"`
		} `json:"artwork"`
		ArtistName           string   `json:"artistName"`
		IsSingle             bool     `json:"isSingle"`
		URL                  string   `json:"url"`
		IsComplete           bool     `json:"isComplete"`
		GenreNames           []string `json:"genreNames"`
		TrackCount           int      `json:"trackCount"`
		IsMasteredForItunes  bool     `json:"isMasteredForItunes"`
		IsAppleDigitalMaster bool     `json:"isAppleDigitalMaster"`
		ContentRating        string   `json:"contentRating"`
		ReleaseDate          string   `json:"releaseDate"`
		Name                 string   `json:"name"`
		RecordLabel          string   `json:"recordLabel"`
		Upc                  string   `json:"upc"`
		AudioTraits          []string `json:"audioTraits"`
		Copyright            string   `json:"copyright"`
		PlayParams           struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"playParams"`
		IsCompilation  bool `json:"isCompilation"`
		EditorialVideo struct {
			MotionTall struct {
				Video string `json:"video"`
			} `json:"motionTallVideo3x4"`
			MotionSquare struct {
				Video string `json:"video"`
			} `json:"motionSquareVideo1x1"`
			MotionDetailTall struct {
				Video string `json:"video"`
			} `json:"motionDetailTall"`
			MotionDetailSquare struct {
				Video string `json:"video"`
			} `json:"motionDetailSquare"`
		} `json:"editorialVideo"`
	} `json:"attributes"`
	Relationships struct {
		RecordLabels struct {
			Href string        `json:"href"`
			Data []interface{} `json:"data"`
		} `json:"record-labels"`
		Artists struct {
			Href string `json:"href"`
			Data []struct {
				ID         string `json:"id"`
				Type       string `json:"type"`
				Href       string `json:"href"`
				Attributes struct {
					Name    string `json:"name"`
					Artwork struct {
						Url string `json:"url"`
					} `json:"artwork"`
				} `json:"attributes"`
			} `json:"data"`
		} `json:"artists"`
		Tracks TrackResp `json:"tracks"`
	} `json:"relationships"`
}
