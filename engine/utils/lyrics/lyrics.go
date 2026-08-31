package lyrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode"

	"github.com/beevik/etree"
)

type SongLyrics struct {
	Data []struct {
		Id         string `json:"id"`
		Type       string `json:"type"`
		Attributes struct {
			Ttml              string `json:"ttml"`
			TtmlLocalizations string `json:"ttmlLocalizations"`
			PlayParams        struct {
				Id          string `json:"id"`
				Kind        string `json:"kind"`
				CatalogId   string `json:"catalogId"`
				DisplayType int    `json:"displayType"`
			} `json:"playParams"`
		} `json:"attributes"`
	} `json:"data"`
}

func Get(storefront, songId, lrcType, language, lrcFormat, token, mediaUserToken string) (string, error) {
	return GetContext(context.Background(), storefront, songId, lrcType, language, lrcFormat, token, mediaUserToken)
}

func GetContext(ctx context.Context, storefront, songId, lrcType, language, lrcFormat, token, mediaUserToken string) (string, error) {
	if len(mediaUserToken) < 50 {
		return "", errors.New("MediaUserToken not set")
	}

	ttml, err := getSongLyricsContext(ctx, songId, storefront, token, mediaUserToken, lrcType, language)
	if err != nil {
		return "", err
	}

	switch lrcFormat {
	case "ttml":
		return ttml, nil
	case "vtt":
		return TtmlToVtt(ttml)
	case "srt":
		return TtmlToSrt(ttml)
	default:
		return TtmlToLrc(ttml)
	}
}

func getSongLyricsContext(ctx context.Context, songId string, storefront string, token string, userToken string, lrcType string, language string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET",
		fmt.Sprintf("https://amp-api.music.apple.com/v1/catalog/%s/songs/%s/%s?l=%s&extend=ttmlLocalizations", storefront, songId, lrcType, language), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Origin", "https://music.apple.com")
	req.Header.Set("Referer", "https://music.apple.com/")
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", token))
	cookie := http.Cookie{Name: "media-user-token", Value: userToken}
	req.AddCookie(&cookie)
	do, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer do.Body.Close()
	bodyBytes, err := io.ReadAll(do.Body)
	if err != nil {
		return "", fmt.Errorf("failed to read response body: %v", err)
	}
	
	obj := new(SongLyrics)
	_ = json.Unmarshal(bodyBytes, &obj)
	if obj.Data != nil && len(obj.Data) > 0 {
		if len(obj.Data[0].Attributes.Ttml) > 0 {
			return obj.Data[0].Attributes.Ttml, nil
		}
		return obj.Data[0].Attributes.TtmlLocalizations, nil
	} else {
		return "", fmt.Errorf("failed to get lyrics: HTTP %d - %s", do.StatusCode, string(bodyBytes))
	}
}

// cjkRanges covers all CJK, Hangul, Hiragana, Katakana, and related Unicode blocks.
var cjkRanges = &unicode.RangeTable{
	R16: []unicode.Range16{
		{0x1100, 0x11FF, 1}, // Hangul Jamo
		{0x2E80, 0x2EFF, 1}, // CJK Radicals Supplement
		{0x2F00, 0x2FDF, 1}, // Kangxi Radicals
		{0x2FF0, 0x2FFF, 1}, // Ideographic Description Characters
		{0x3000, 0x303F, 1}, // CJK Symbols and Punctuation
		{0x3040, 0x309F, 1}, // Hiragana
		{0x30A0, 0x30FF, 1}, // Katakana
		{0x3130, 0x318F, 1}, // Hangul Compatibility Jamo
		{0x31C0, 0x31EF, 1}, // CJK Strokes
		{0x31F0, 0x31FF, 1}, // Katakana Phonetic Extensions
		{0x3200, 0x32FF, 1}, // Enclosed CJK Letters and Months
		{0x3300, 0x33FF, 1}, // CJK Compatibility
		{0x3400, 0x4DBF, 1}, // CJK Unified Ideographs Extension A
		{0x4E00, 0x9FFF, 1}, // CJK Unified Ideographs
		{0xA960, 0xA97F, 1}, // Hangul Jamo Extended-A
		{0xAC00, 0xD7AF, 1}, // Hangul Syllables
		{0xD7B0, 0xD7FF, 1}, // Hangul Jamo Extended-B
		{0xF900, 0xFAFF, 1}, // CJK Compatibility Ideographs
		{0xFE30, 0xFE4F, 1}, // CJK Compatibility Forms
		{0xFF65, 0xFF9F, 1}, // Halfwidth Katakana
		{0xFFA0, 0xFFDC, 1}, // Halfwidth Jamo
	},
	R32: []unicode.Range32{
		{0x1AFF0, 0x1AFFF, 1}, // Kana Extended-B
		{0x1B000, 0x1B0FF, 1}, // Kana Supplement
		{0x1B100, 0x1B12F, 1}, // Kana Extended-A
		{0x1B130, 0x1B16F, 1}, // Small Kana Extension
		{0x1F200, 0x1F2FF, 1}, // Enclosed Ideographic Supplement
		{0x20000, 0x2A6DF, 1}, // CJK Unified Ideographs Extension B
		{0x2A700, 0x2B73F, 1}, // CJK Unified Ideographs Extension C
		{0x2B740, 0x2B81F, 1}, // CJK Unified Ideographs Extension D
		{0x2B820, 0x2CEAF, 1}, // CJK Unified Ideographs Extension E
		{0x2CEB0, 0x2EBEF, 1}, // CJK Unified Ideographs Extension F
		{0x2EBF0, 0x2EE5F, 1}, // CJK Unified Ideographs Extension I
		{0x2F800, 0x2FA1F, 1}, // CJK Compatibility Ideographs Supplement
		{0x30000, 0x3134F, 1}, // CJK Unified Ideographs Extension G
		{0x31350, 0x323AF, 1}, // CJK Unified Ideographs Extension H
	},
	LatinOffset: 0,
}

func containsCJK(s string) bool {
	for _, r := range s {
		if unicode.Is(cjkRanges, r) {
			return true
		}
	}
	return false
}

func TtmlToLrc(ttml string) (string, error) {
	parsedTTML := etree.NewDocument()
	err := parsedTTML.ReadFromString(ttml)
	if err != nil {
		return "", err
	}

	var lrcLines []string
	timingAttr := parsedTTML.FindElement("tt").SelectAttr("itunes:timing")
	if timingAttr != nil {
		if timingAttr.Value == "Word" {
			lrc, err := conventSyllableTTMLToLRC(ttml)
			return lrc, err
		}
		if timingAttr.Value == "None" {
			for _, p := range parsedTTML.FindElements("//p") {
				line := p.Text()
				line = strings.TrimSpace(line)
				if line != "" {
					lrcLines = append(lrcLines, line)
				}
			}
			return strings.Join(lrcLines, "\n"), nil
		}
	}

	itunesMeta := itunesMetadataElem(parsedTTML)
	for _, item := range parsedTTML.FindElement("tt").FindElement("body").ChildElements() {
		for _, lyric := range item.ChildElements() {
			beginAttr := lyric.SelectAttr("begin")
			if beginAttr == nil {
				return "", errors.New("no synchronised lyrics")
			}
			lm, ls, lms, err := parseLRCBeginTime(beginAttr.Value)
			if err != nil {
				return "", err
			}
			key := ""
			if kAttr := lyric.SelectAttr("itunes:key"); kAttr != nil {
				key = kAttr.Value
			}
			translitText := findTranslitText(itunesMeta, key)
			transText := findTransText(itunesMeta, key)
			var text string
			if a := lyric.SelectAttr("text"); a != nil {
				text = a.Value
			} else {
				text = elementChildText(lyric)
			}
			if transText != "" {
				lrcLines = append(lrcLines, fmt.Sprintf("[%02d:%02d.%02d]%s", lm, ls, lms, transText))
			}
			if translitText != "" && containsCJK(text) {
				lrcLines = append(lrcLines, fmt.Sprintf("[%02d:%02d.%02d]%s", lm, ls, lms, translitText))
			} else {
				lrcLines = append(lrcLines, fmt.Sprintf("[%02d:%02d.%02d]%s", lm, ls, lms, text))
			}
		}
	}
	return strings.Join(lrcLines, "\n"), nil
}

// elementChildText collects text from CharData and Element children of el.
func elementChildText(el *etree.Element) string {
	var parts []string
	for _, span := range el.Child {
		switch c := span.(type) {
		case *etree.CharData:
			parts = append(parts, c.Data)
		case *etree.Element:
			parts = append(parts, c.Text())
		}
	}
	return strings.Join(parts, "")
}

// parseLRCBeginTime parses an Apple TTML begin attribute to (m, s, cs) for LRC.
func parseLRCBeginTime(v string) (m, s, ms int, err error) {
	var h int
	if strings.Contains(v, ":") {
		_, err = fmt.Sscanf(v, "%d:%d:%d.%d", &h, &m, &s, &ms)
		if err != nil {
			_, err = fmt.Sscanf(v, "%d:%d.%d", &m, &s, &ms)
			if err != nil {
				_, err = fmt.Sscanf(v, "%d:%d", &m, &s)
			}
			h = 0
		}
	} else {
		_, err = fmt.Sscanf(v, "%d.%d", &s, &ms)
	}
	if err != nil {
		return 0, 0, 0, err
	}
	m += h * 60
	ms /= 10
	return m, s, ms, nil
}

// itunesMetadataElem finds the <iTunesMetadata> element in a TTML document.
func itunesMetadataElem(doc *etree.Document) *etree.Element {
	tt := doc.FindElement("tt")
	if tt == nil {
		return nil
	}
	head := tt.FindElement("head")
	if head == nil {
		return nil
	}
	meta := head.FindElement("metadata")
	if meta == nil {
		return nil
	}
	return meta.FindElement("iTunesMetadata")
}

// findTranslitText returns the transliteration string for the given lyric key.
func findTranslitText(itunesMeta *etree.Element, key string) string {
	if itunesMeta == nil || key == "" {
		return ""
	}
	tls := itunesMeta.FindElement("transliterations")
	if tls == nil {
		return ""
	}
	tl := tls.FindElement("transliteration")
	if tl == nil {
		return ""
	}
	node := tl.FindElement(fmt.Sprintf("text[@for='%s']", key))
	if node == nil {
		return ""
	}
	if a := node.SelectAttr("text"); a != nil {
		return a.Value
	}
	return elementChildText(node)
}

// findTransText returns the translation string for the given lyric key.
func findTransText(itunesMeta *etree.Element, key string) string {
	if itunesMeta == nil || key == "" {
		return ""
	}
	trs := itunesMeta.FindElement("translations")
	if trs == nil {
		return ""
	}
	tr := trs.FindElement("translation")
	if tr == nil {
		return ""
	}
	node := tr.FindElement(fmt.Sprintf("//text[@for='%s']", key))
	if node == nil {
		return ""
	}
	if a := node.SelectAttr("text"); a != nil {
		return a.Value
	}
	return elementChildText(node)
}

// TtmlToSrt converts Apple Music TTML to SubRip (SRT) subtitle format.
func TtmlToSrt(ttml string) (string, error) { return ttmlToSubtitle(ttml, "srt") }

// TtmlToVtt converts Apple Music TTML to WebVTT subtitle format.
func TtmlToVtt(ttml string) (string, error) { return ttmlToSubtitle(ttml, "vtt") }

func ttmlToSubtitle(ttml, format string) (string, error) {
	doc := etree.NewDocument()
	if err := doc.ReadFromString(ttml); err != nil {
		return "", err
	}
	tt := doc.FindElement("tt")
	if tt == nil {
		return "", errors.New("no <tt> element")
	}
	if attr := tt.SelectAttr("itunes:timing"); attr != nil && attr.Value == "None" {
		return "", nil // untimed lyrics — no subtitle possible
	}
	body := tt.FindElement("body")
	if body == nil {
		return "", errors.New("no <body> in TTML")
	}

	var entries []string
	idx := 1
	for _, div := range body.FindElements("div") {
		for _, p := range div.ChildElements() {
			beginStr := p.SelectAttrValue("begin", "")
			endStr := p.SelectAttrValue("end", "")
			if beginStr == "" || endStr == "" {
				continue
			}
			beginMs := parseTtmlMs(beginStr)
			endMs := parseTtmlMs(endStr)

			// Prefer text attribute; fall back to child content.
			text := p.SelectAttrValue("text", "")
			if text == "" {
				var parts []string
				for _, child := range p.Child {
					switch c := child.(type) {
					case *etree.CharData:
						parts = append(parts, c.Data)
					case *etree.Element:
						parts = append(parts, c.Text())
					}
				}
				text = strings.TrimSpace(strings.Join(parts, ""))
			}
			if text == "" {
				continue
			}

			if format == "srt" {
				entries = append(entries, fmt.Sprintf("%d\n%s --> %s\n%s", idx, msToSubTime(beginMs, ','), msToSubTime(endMs, ','), text))
			} else {
				entries = append(entries, fmt.Sprintf("%s --> %s\n%s", msToSubTime(beginMs, '.'), msToSubTime(endMs, '.'), text))
			}
			idx++
		}
	}
	if len(entries) == 0 {
		return "", nil
	}
	joined := strings.Join(entries, "\n\n") + "\n"
	if format == "vtt" {
		return "WEBVTT\n\n" + joined, nil
	}
	return joined, nil
}

// parseTtmlMs parses an Apple TTML time value to milliseconds.
// Handles: "HH:MM:SS.mmm", "MM:SS.mmm", "SS.mmm", and variants without fractions.
func parseTtmlMs(t string) int {
	dotIdx := strings.LastIndex(t, ".")
	intPart := t
	fracStr := ""
	if dotIdx >= 0 {
		intPart = t[:dotIdx]
		fracStr = t[dotIdx+1:]
	}

	var h, m, s int
	n, _ := fmt.Sscanf(intPart, "%d:%d:%d", &h, &m, &s)
	if n < 3 {
		n2, _ := fmt.Sscanf(intPart, "%d:%d", &m, &s)
		if n2 < 2 {
			s, _ = strconv.Atoi(intPart)
		}
	}

	totalMs := (h*3600+m*60+s) * 1000
	if fracStr != "" {
		fracStr += strings.Repeat("0", max(0, 3-len(fracStr)))
		if len(fracStr) > 3 {
			fracStr = fracStr[:3]
		}
		ms, _ := strconv.Atoi(fracStr)
		totalMs += ms
	}
	return totalMs
}

func msToSubTime(ms int, sep byte) string {
	h := ms / 3600000; ms -= h * 3600000
	m := ms / 60000; ms -= m * 60000
	s := ms / 1000; ms -= s * 1000
	return fmt.Sprintf("%02d:%02d:%02d%c%03d", h, m, s, sep, ms)
}

func conventSyllableTTMLToLRC(ttml string) (string, error) {
	parsedTTML := etree.NewDocument()
	if err := parsedTTML.ReadFromString(ttml); err != nil {
		return "", err
	}
	itunesMeta := itunesMetadataElem(parsedTTML)
	var lrcLines []string
	divs := parsedTTML.FindElement("tt").FindElement("body").FindElements("div")
	for _, div := range divs {
		for _, item := range div.ChildElements() {
			var lrcSyllables []string
			var i int
			var endTime, translitLine, transLine string
			key := item.SelectAttrValue("itunes:key", "")
			for _, lyrics := range item.Child {
				if _, ok := lyrics.(*etree.CharData); ok {
					if i > 0 {
						lrcSyllables = append(lrcSyllables, " ")
					}
					continue
				}
				lyric := lyrics.(*etree.Element)
				if lyric.SelectAttr("begin") == nil {
					continue
				}
				beginTime, err := parseSyllableTime(lyric.SelectAttrValue("begin", ""), i)
				if err != nil {
					return "", err
				}
				endTime, err = parseSyllableTime(lyric.SelectAttrValue("end", ""), 1)
				if err != nil {
					return "", err
				}
				var text string
				if a := lyric.SelectAttr("text"); a != nil {
					text = a.Value
				} else {
					text = elementChildText(lyric)
				}
				lrcSyllables = append(lrcSyllables, beginTime+text)
				if i == 0 {
					transBeginTime, _ := parseSyllableTime(lyric.SelectAttrValue("begin", ""), -1)
					translitLine, transLine = buildSyllabicAnnotations(itunesMeta, key, transBeginTime)
				}
				i++
			}
			if transLine != "" {
				lrcLines = append(lrcLines, transLine)
			}
			if translitLine != "" && containsCJK(strings.Join(lrcSyllables, "")) {
				lrcLines = append(lrcLines, translitLine)
			} else {
				lrcLines = append(lrcLines, strings.Join(lrcSyllables, "")+endTime)
			}
		}
	}
	return strings.Join(lrcLines, "\n"), nil
}

// parseSyllableTime formats a TTML time value into an LRC/syllable timestamp string.
// newLine=0 → "[mm:ss.cs]<mm:ss.cs>", newLine=-1 → "[mm:ss.cs]", else → "<mm:ss.cs>".
func parseSyllableTime(timeValue string, newLine int) (string, error) {
	var h, m, s, ms int
	var err error
	if strings.Contains(timeValue, ":") {
		_, err = fmt.Sscanf(timeValue, "%d:%d:%d.%d", &h, &m, &s, &ms)
		if err != nil {
			_, err = fmt.Sscanf(timeValue, "%d:%d.%d", &m, &s, &ms)
			h = 0
		}
	} else {
		_, err = fmt.Sscanf(timeValue, "%d.%d", &s, &ms)
	}
	if err != nil {
		return "", err
	}
	m += h * 60
	ms /= 10
	switch newLine {
	case 0:
		return fmt.Sprintf("[%02d:%02d.%02d]<%02d:%02d.%02d>", m, s, ms, m, s, ms), nil
	case -1:
		return fmt.Sprintf("[%02d:%02d.%02d]", m, s, ms), nil
	default:
		return fmt.Sprintf("<%02d:%02d.%02d>", m, s, ms), nil
	}
}

// buildSyllabicAnnotations builds translitLine and transLine for a syllabic TTML line.
func buildSyllabicAnnotations(itunesMeta *etree.Element, key, transBeginTime string) (translitLine, transLine string) {
	if itunesMeta == nil || key == "" {
		return "", ""
	}
	sharedTimestamp := ""
	// Syllabic transliteration (per-span timestamps).
	if tls := itunesMeta.FindElement("transliterations"); tls != nil {
		if tl := tls.FindElement("transliteration"); tl != nil {
			if node := tl.FindElement(fmt.Sprintf("text[@for='%s']", key)); node != nil {
				var parts []string
				var transStartTime string
				for i, span := range node.ChildElements() {
					if span.Tag != "span" {
						continue
					}
					spanBegin := span.SelectAttrValue("begin", "")
					if spanBegin == "" {
						continue
					}
					ts, err := parseSyllableTime(spanBegin, 2)
					if err != nil {
						continue
					}
					if i == 0 {
						transStartTime, _ = parseSyllableTime(spanBegin, -1)
						sharedTimestamp = transStartTime
					}
					parts = append(parts, ts+span.Text())
				}
				translitLine = transStartTime + strings.Join(parts, " ")
			}
		}
	}
	// Translation (single text string).
	if trs := itunesMeta.FindElement("translations"); trs != nil {
		if tr := trs.FindElement("translation"); tr != nil {
			if node := tr.FindElement(fmt.Sprintf("//text[@for='%s']", key)); node != nil {
				var transTxt string
				if a := node.SelectAttr("text"); a != nil {
					transTxt = a.Value
				} else {
					for _, span := range node.Child {
						if c, ok := span.(*etree.CharData); ok {
							transTxt += c.Data
						}
					}
				}
				prefix := sharedTimestamp
				if prefix == "" {
					prefix = transBeginTime
				}
				transLine = prefix + transTxt
			}
		}
	}
	return translitLine, transLine
}
