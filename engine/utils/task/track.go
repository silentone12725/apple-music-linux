package task

import (
	"context"

	"apple-music-cli/utils/ampapi"
)

type Track struct {
	ID         string
	Type       string
	Name       string
	Storefront string
	Language   string

	SaveDir    string
	SaveName   string
	SavePath   string
	Codec      string
	TaskNum    int
	TaskTotal  int
	M3u8       string
	WebM3u8    string
	DeviceM3u8 string
	Quality    string
	CoverPath  string

	Resp         ampapi.TrackRespData
	PreType      string // 上级类型 专辑或者歌单
	PreID        string // 上级ID
	DiscTotal    int
	AlbumData    ampapi.AlbumRespData
	PlaylistData ampapi.PlaylistRespData
}

func (t *Track) GetAlbumData(token string) error {
	return t.GetAlbumDataContext(context.Background(), token)
}

func (t *Track) GetAlbumDataContext(ctx context.Context, token string) error {
	var err error
	resp, err := ampapi.GetAlbumRespByHrefContext(ctx, t.Resp.Href, t.Language, token)
	if err != nil {
		return err
	}
	t.AlbumData = resp.Data[0]
	//尝试获取该track所在album的disk总数
	if len(resp.Data) > 0 {
		len := len(resp.Data[0].Relationships.Tracks.Data)
		if len > 0 {
			t.DiscTotal = resp.Data[0].Relationships.Tracks.Data[len-1].Attributes.DiscNumber
		}
	}

	return nil
}
