package apple

import (
	"engine/core/hls"
	"engine/core/pipeline"
	"fmt"
)

// selectSongVariant only falls back from EC-3 to ALAC when the request permits
// lossless. It never labels AAC (or a missing/unknown codec) as Atmos or ALAC.
func selectSongVariant(master *hls.Master, requested string, allowALAC bool) (hls.Variant, pipeline.Codec, error) {
	codecs := []string{requested}
	if requested == "ec-3" && allowALAC {
		codecs = append(codecs, "alac")
	}
	for _, codec := range codecs {
		var label pipeline.Codec
		switch codec {
		case "ec-3":
			label = pipeline.CodecAtmos
		case "alac":
			label = pipeline.CodecALAC
		default:
			continue
		}
		if v, ok := master.SelectVariantByCodec(codec); ok {
			return v, label, nil
		}
	}
	return hls.Variant{}, "", fmt.Errorf("no HLS variant matching permitted codecs %v", codecs)
}
