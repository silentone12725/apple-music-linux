package task

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"

	"engine/utils/ampapi"
)

type Playlist struct {
	Storefront string
	ID         string

	SaveDir   string
	SaveName  string
	Codec     string
	CoverPath string

	Language string
	Resp     ampapi.PlaylistResp
	Name     string
	Tracks   []Track
}

func NewPlaylist(st string, id string) *Playlist {
	a := new(Playlist)
	a.Storefront = st
	a.ID = id

	//fmt.Println("Album created")
	return a

}

func (a *Playlist) GetResp(token, l string) error {
	var err error
	a.Language = l
	resp, err := ampapi.GetPlaylistResp(a.Storefront, a.ID, a.Language, token)
	if err != nil {
		return errors.New("error getting album response")
	}
	a.Resp = *resp

	a.Resp.Data[0].Attributes.ArtistName = "Apple Music"
	//简化高频调用名称
	a.Name = a.Resp.Data[0].Attributes.Name
	//fmt.Println("Getting album response")
	//从resp中的Tracks数据中提取trackData信息到新的Track结构体中
	for i, trackData := range a.Resp.Data[0].Relationships.Tracks.Data {
		len := len(a.Resp.Data[0].Relationships.Tracks.Data)
		a.Tracks = append(a.Tracks, Track{
			ID:         trackData.ID,
			Type:       trackData.Type,
			Name:       trackData.Attributes.Name,
			Language:   a.Language,
			Storefront: a.Storefront,

			//SaveDir:   filepath.Join(a.SaveDir, a.SaveName),
			//Codec:     a.Codec,
			TaskNum:   i + 1,
			TaskTotal: len,
			M3u8:      trackData.Attributes.ExtendedAssetUrls.EnhancedHls,
			WebM3u8:   trackData.Attributes.ExtendedAssetUrls.EnhancedHls,
			//CoverPath: a.CoverPath,

			Resp:    trackData,
			PreType: "playlists",
			//DiscTotal: a.Resp.Data[0].Relationships.Tracks.Data[len-1].Attributes.DiscNumber, 在它处获取
			PreID:        a.ID,
			PlaylistData: a.Resp.Data[0],
		})
	}
	return nil
}

func (a *Playlist) GetArtwork() string {
	return a.Resp.Data[0].Attributes.Artwork.URL
}

func (a *Playlist) ShowSelect() []int {
	meta := a.Resp
	trackTotal := len(meta.Data[0].Relationships.Tracks.Data)
	arr := make([]int, trackTotal)
	for i := 0; i < trackTotal; i++ {
		arr[i] = i + 1
	}
	selected := []int{}
	var data [][]string
	for trackNum, track := range meta.Data[0].Relationships.Tracks.Data {
		trackNum++
		trackName := fmt.Sprintf("%s - %s", track.Attributes.Name, track.Attributes.ArtistName)
		data = append(data, []string{fmt.Sprint(trackNum),
			trackName,
			track.Attributes.ContentRating,
			track.Type})

	}
	table := tablewriter.NewWriter(os.Stdout)
	table.SetHeader([]string{"", "Track Name", "Rating", "Type"})
	//table.SetFooter([]string{"", "", "Footer", "Footer4"})
	table.SetRowLine(false)
	//table.SetAutoMergeCells(true)
	table.SetCaption(true, fmt.Sprintf("Playlists: %d tracks", trackTotal))
	table.SetHeaderColor(tablewriter.Colors{},
		tablewriter.Colors{tablewriter.FgRedColor, tablewriter.Bold},
		tablewriter.Colors{tablewriter.FgBlackColor, tablewriter.Bold},
		tablewriter.Colors{tablewriter.FgBlackColor, tablewriter.Bold})

	table.SetColumnColor(tablewriter.Colors{tablewriter.FgCyanColor},
		tablewriter.Colors{tablewriter.Bold, tablewriter.FgRedColor},
		tablewriter.Colors{tablewriter.Bold, tablewriter.FgBlackColor},
		tablewriter.Colors{tablewriter.Bold, tablewriter.FgBlackColor})
	for _, row := range data {
		if row[2] == "explicit" {
			row[2] = "E"
		} else if row[2] == "clean" {
			row[2] = "C"
		} else {
			row[2] = "None"
		}
		if row[3] == "music-videos" {
			row[3] = "MV"
		} else if row[3] == "songs" {
			row[3] = "SONG"
		}
		table.Append(row)
	}
	//table.AppendBulk(data)
	table.Render()
	fmt.Println("Please select from the track options above (multiple options separated by commas, ranges supported, or type 'all' to select all)")
	cyanColor := color.New(color.FgCyan)
	cyanColor.Print("select: ")
	reader := bufio.NewReader(os.Stdin)
	input, err := reader.ReadString('\n')
	if err != nil {
		fmt.Println(err)
	}
	input = strings.TrimSpace(input)
	if input == "all" {
		fmt.Println("You have selected all options:")
	}
	selected = parseTrackSelection(input, arr)
	return selected
}
