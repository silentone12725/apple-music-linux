package ampapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

type TrackResp struct {
	Href string          `json:"href"`
	Next string          `json:"next"`
	Data []TrackRespData `json:"data"`
}

// 类型为song 或者 music-video
type TrackRespData struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Href       string `json:"href"`
	Attributes struct {
		Previews []struct {
			URL string `json:"url"`
		} `json:"previews"`
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
		ArtistName        string   `json:"artistName"`
		URL               string   `json:"url"`
		DiscNumber        int      `json:"discNumber"`
		GenreNames        []string `json:"genreNames"`
		ExtendedAssetUrls struct {
			EnhancedHls string `json:"enhancedHls"`
		} `json:"extendedAssetUrls"`
		HasTimeSyncedLyrics  bool     `json:"hasTimeSyncedLyrics"`
		IsMasteredForItunes  bool     `json:"isMasteredForItunes"`
		IsAppleDigitalMaster bool     `json:"isAppleDigitalMaster"`
		ContentRating        string   `json:"contentRating"`
		DurationInMillis     int      `json:"durationInMillis"`
		ReleaseDate          string   `json:"releaseDate"`
		Name                 string   `json:"name"`
		Isrc                 string   `json:"isrc"`
		AudioTraits          []string `json:"audioTraits"`
		HasLyrics            bool     `json:"hasLyrics"`
		AlbumName            string   `json:"albumName"`
		PlayParams           struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"playParams"`
		TrackNumber  int    `json:"trackNumber"`
		AudioLocale  string `json:"audioLocale"`
		ComposerName string `json:"composerName"`
	} `json:"attributes"`
	Relationships struct {
		Artists struct {
			Href string `json:"href"`
			Data []struct {
				ID         string `json:"id"`
				Type       string `json:"type"`
				Href       string `json:"href"`
				Attributes struct {
					Name string `json:"name"`
				} `json:"attributes"`
			} `json:"data"`
		} `json:"artists"`
		Albums struct {
			Href string `json:"href"`
			Data []struct {
				ID         string `json:"id"`
				Type       string `json:"type"`
				Href       string `json:"href"`
				Attributes struct {
					ArtistName string `json:"artistName"`
					Artwork    struct {
						Width      int    `json:"width"`
						Height     int    `json:"height"`
						URL        string `json:"url"`
						BgColor    string `json:"bgColor"`
						TextColor1 string `json:"textColor1"`
						TextColor2 string `json:"textColor2"`
						TextColor3 string `json:"textColor3"`
						TextColor4 string `json:"textColor4"`
					} `json:"artwork"`
					GenreNames          []string `json:"genreNames"`
					IsCompilation       bool     `json:"isCompilation"`
					IsComplete          bool     `json:"isComplete"`
					IsMasteredForItunes bool     `json:"isMasteredForItunes"`
					IsPrerelease        bool     `json:"isPrerelease"`
					IsSingle            bool     `json:"isSingle"`
					Name                string   `json:"name"`
					PlayParams          struct {
						ID   string `json:"id"`
						Kind string `json:"kind"`
					} `json:"playParams"`
					ReleaseDate string `json:"releaseDate"`
					TrackCount  int    `json:"trackCount"`
					Upc         string `json:"upc"`
					URL         string `json:"url"`
				} `json:"attributes"`
			} `json:"data"`
		} `json:"albums"`
	} `json:"relationships"`
}

// maxTrackPages bounds "next"-link pagination so a looping or runaway API
// response cannot keep a request going forever.
const maxTrackPages = 200

// apiBase is the Apple Music API origin that "next" links are relative to.
var apiBase = "https://amp-api.music.apple.com"

// fetchTrackPages follows Apple's "next" links from next and returns the
// tracks on every following page. mut is optional ("" to omit). Each response is closed before the next
// request (a defer inside the loop kept every page open until return).
func fetchTrackPages(ctx context.Context, next, token, mut string) ([]TrackRespData, error) {
	var out []TrackRespData
	for pages := 0; next != ""; pages++ {
		if pages >= maxTrackPages {
			return out, fmt.Errorf("track pagination exceeded %d pages", maxTrackPages)
		}
		req, err := http.NewRequestWithContext(ctx, "GET", apiBase+next, nil)
		if err != nil {
			return out, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if mut != "" { // user-shared playlists need the listener's token on every page
			req.Header.Set("Media-User-Token", mut)
		}
		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Origin", "https://music.apple.com")
		query := req.URL.Query()
		query.Set("omit[resource]", "autos")
		query.Set("include", "artists")
		query.Set("extend", "editorialVideo,extendedAssetUrls")
		req.URL.RawQuery = query.Encode()
		resp, err := apiClient.Do(req)
		if err != nil {
			return out, err
		}
		page := new(TrackResp)
		if resp.StatusCode != http.StatusOK {
			err = errors.New(resp.Status)
		} else {
			err = json.NewDecoder(resp.Body).Decode(page)
		}
		resp.Body.Close()
		if err != nil {
			return out, err
		}
		out = append(out, page.Data...)
		next = page.Next
	}
	return out, nil
}
