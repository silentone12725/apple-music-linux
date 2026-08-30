package task

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/fatih/color"
	"github.com/olekukonko/tablewriter"

	"engine/utils/ampapi"
)

type Album struct {
	Storefront string
	ID         string

	SaveDir   string
	SaveName  string
	Codec     string
	CoverPath string

	Language string
	Resp     ampapi.AlbumResp
	Name     string
	Tracks   []Track
}

func NewAlbum(st string, id string) *Album {
	a := new(Album)
	a.Storefront = st
	a.ID = id

	//fmt.Println("Album created")
	return a

}

func (a *Album) GetResp(token, l string) error {
	var err error
	a.Language = l
	resp, err := ampapi.GetAlbumResp(a.Storefront, a.ID, a.Language, token)
	if err != nil {
		return errors.New("error getting album response")
	}
	a.Resp = *resp
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

			Resp:      trackData,
			PreType:   "albums",
			DiscTotal: a.Resp.Data[0].Relationships.Tracks.Data[len-1].Attributes.DiscNumber,
			PreID:     a.ID,
			AlbumData: a.Resp.Data[0],
		})
	}
	return nil
}

func (a *Album) GetArtwork() string {
	return a.Resp.Data[0].Attributes.Artwork.URL
}

// parseTrackSelection parses a comma/range selection string (e.g. "1,3-5,7")
// against arr (1-based indices) and returns the selected indices.
// Returns arr unchanged when input is "all".
func parseTrackSelection(input string, arr []int) []int {
	if input == "all" {
		return arr
	}
	selected := []int{}
	for _, part := range strings.Split(input, ",") {
		if strings.Contains(part, "-") {
			rangeParts := strings.Split(part, "-")
			if len(rangeParts) != 2 {
				fmt.Println("Invalid range:", part)
				continue
			}
			start, err1 := strconv.Atoi(strings.TrimSpace(rangeParts[0]))
			end, err2 := strconv.Atoi(strings.TrimSpace(rangeParts[1]))
			if err1 != nil || err2 != nil {
				fmt.Println("Invalid range:", part)
				continue
			}
			if start < 1 || end > len(arr) || start > end {
				fmt.Println("Range out of range:", part)
				continue
			}
			for i := start; i <= end; i++ {
				selected = append(selected, i)
			}
		} else {
			num, err := strconv.Atoi(strings.TrimSpace(part))
			if err != nil {
				fmt.Println("Invalid option:", part)
				continue
			}
			if num > 0 && num <= len(arr) {
				selected = append(selected, num)
			} else {
				fmt.Println("Option out of range:", part)
			}
		}
	}
	return selected
}

func (a *Album) ShowSelect() []int {
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
		trackName := fmt.Sprintf("%02d. %s", track.Attributes.TrackNumber, track.Attributes.Name)
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
	table.SetCaption(true, fmt.Sprintf("Storefront: %s, %d tracks missing", strings.ToUpper(a.Storefront), meta.Data[0].Attributes.TrackCount-trackTotal))
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
