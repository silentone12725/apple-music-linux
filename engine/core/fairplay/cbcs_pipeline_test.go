package fairplay

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"
	"io"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/itouakirai/mp4ff/mp4"

	"engine/core/hls"
	"engine/utils/alacstream"
)

const (
	testAdamID     = "1440833098"
	testContentKey = "skd://itunes.apple.com/p1469029813/c6"
	samplesPerFrag = 4
	sampleDur      = 4096
)

var (
	testIV     = bytes.Repeat([]byte{0xd1}, 16)
	prefetchAK = bytes.Repeat([]byte{0x11}, 16)
	contentAK  = bytes.Repeat([]byte{0x22}, 16)
)

// encryptedTrack is an Apple-style CBCS audio file: segment 0 under the shared
// prefetch key, every later segment under the track key, all with the same
// constant IV, and every fragment's tfdt left at 0 as Apple ships them.
type encryptedTrack struct {
	file  []byte
	plain [][][]byte // [fragment][sample] plaintext
}

func buildEncryptedTrack(t *testing.T, nFrags int) encryptedTrack {
	t.Helper()
	return buildEncryptedTrackWithPrefetch(t, nFrags, 1)
}

func buildEncryptedTrackWithPrefetch(t *testing.T, nFrags, prefetchFrags int) encryptedTrack {
	t.Helper()
	rng := rand.New(rand.NewSource(1))
	init := mp4.CreateEmptyInit()
	init.AddEmptyTrack(44100, "audio", "en")
	if err := init.Moov.Trak.SetAACDescriptor(2, 44100); err != nil {
		t.Fatal(err)
	}
	ipd, err := mp4.InitProtect(init, prefetchAK, testIV, "cbcs", make(mp4.UUID, 16), nil)
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := init.Encode(&out); err != nil {
		t.Fatal(err)
	}
	tr := encryptedTrack{}
	for f := 0; f < nFrags; f++ {
		frag, err := mp4.CreateFragment(uint32(f+1), 1)
		if err != nil {
			t.Fatal(err)
		}
		var plain [][]byte
		for s := 0; s < samplesPerFrag; s++ {
			// Sizes that are not multiples of 16 exercise the clear tail.
			data := make([]byte, 200+rng.Intn(300))
			rng.Read(data)
			plain = append(plain, append([]byte(nil), data...))
			frag.AddFullSample(mp4.FullSample{
				Sample:     mp4.Sample{Dur: sampleDur, Size: uint32(len(data))},
				DecodeTime: 0,
				Data:       data,
			})
		}
		key := contentAK
		if f < prefetchFrags {
			key = prefetchAK
		}
		if err := mp4.EncryptFragment(frag, key, testIV, ipd); err != nil {
			t.Fatal(err)
		}
		if err := frag.Encode(&out); err != nil {
			t.Fatal(err)
		}
		tr.plain = append(tr.plain, plain)
	}
	tr.file = out.Bytes()
	return tr
}

// fakeFairPlay speaks the wrapper's handle() protocol and decrypts each sample
// the way NfcRKVnxuKZy04KWbdFu71Ou does: AES-128-CBC from the constant IV.
type fakeFairPlay struct {
	ln   net.Listener
	mu   sync.Mutex
	keys []string // "adamID uri" for every key opened, in order
}

func newFakeFairPlay(t *testing.T, keys map[string][]byte) *fakeFairPlay {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeFairPlay{ln: ln}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.handle(c, keys)
		}
	}()
	return f
}

func readShort(r io.Reader) (string, error) {
	var n [1]byte
	if _, err := io.ReadFull(r, n[:]); err != nil {
		return "", err
	}
	b := make([]byte, n[0])
	_, err := io.ReadFull(r, b)
	return string(b), err
}

func (f *fakeFairPlay) handle(c net.Conn, keys map[string][]byte) {
	defer c.Close()
	r := bufio.NewReader(c)
	for {
		adam, err := readShort(r)
		if err != nil || adam == "" {
			return
		}
		uri, err := readShort(r)
		if err != nil {
			return
		}
		f.mu.Lock()
		f.keys = append(f.keys, adam+" "+uri)
		f.mu.Unlock()
		want := testAdamID
		if uri == cbcsPrefetchKey {
			want = "0"
		}
		key, ok := keys[uri]
		if !ok || adam != want {
			return // handle(): no key context → drop the connection
		}
		block, _ := aes.NewCipher(key)
		for {
			var sz [4]byte
			if _, err := io.ReadFull(r, sz[:]); err != nil {
				return
			}
			n := binary.LittleEndian.Uint32(sz[:])
			if n == 0 {
				break
			}
			buf := make([]byte, n)
			if _, err := io.ReadFull(r, buf); err != nil {
				return
			}
			cipher.NewCBCDecrypter(block, testIV).CryptBlocks(buf, buf)
			if _, err := c.Write(buf); err != nil {
				return
			}
		}
	}
}

func (f *fakeFairPlay) opened() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.keys...)
}

func serveFile(t *testing.T, data []byte) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(data)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

type decodedFragment struct {
	tfdt    uint64
	samples [][]byte
}

// decodeOutput parses the stream the pipeline wrote and checks that it is a
// clean, unencrypted fMP4.
func decodeOutput(t *testing.T, out []byte) []decodedFragment {
	t.Helper()
	r := bufio.NewReader(bytes.NewReader(out))
	init, off, err := alacstream.ReadInitSegment(r)
	if err != nil {
		t.Fatal(err)
	}
	if typ := init.Moov.Trak.Mdia.Minf.Stbl.Stsd.Children[0].Type(); typ != "mp4a" {
		t.Fatalf("sample entry %q: the output still advertises encryption", typ)
	}
	trex := init.Moov.Mvex.Trex
	var frags []decodedFragment
	for {
		frag, next, err := alacstream.ReadNextFragment(r, off)
		if err != nil {
			t.Fatal(err)
		}
		if frag == nil {
			return frags
		}
		off = next
		traf := frag.Moof.Traf
		if has, _ := traf.ContainsSencBox(); has || traf.Saiz != nil || traf.Saio != nil {
			t.Fatal("encryption boxes left in an output fragment")
		}
		full, err := frag.GetFullSamples(trex)
		if err != nil {
			t.Fatal(err)
		}
		d := decodedFragment{tfdt: traf.Tfdt.BaseMediaDecodeTime()}
		for _, s := range full {
			d.samples = append(d.samples, s.Data)
		}
		frags = append(frags, d)
	}
}

func checkFragments(t *testing.T, got []decodedFragment, want [][][]byte, firstFrag int) {
	t.Helper()
	if len(got) != len(want)-firstFrag {
		t.Fatalf("got %d fragments, want %d", len(got), len(want)-firstFrag)
	}
	for i, g := range got {
		f := firstFrag + i
		if wantT := uint64(f * samplesPerFrag * sampleDur); g.tfdt != wantT {
			t.Errorf("fragment %d tfdt = %d, want %d (decode times must be monotonic)", f, g.tfdt, wantT)
		}
		for s := range want[f] {
			if !bytes.Equal(g.samples[s], want[f][s]) {
				t.Fatalf("fragment %d sample %d does not decrypt to the original", f, s)
			}
		}
	}
}

func TestCBCSPipelineDecryptsPrefetchAndContentKeys(t *testing.T) {
	tr := buildEncryptedTrack(t, 5)
	fp := newFakeFairPlay(t, map[string][]byte{cbcsPrefetchKey: prefetchAK, testContentKey: contentAK})
	keys := []string{cbcsPrefetchKey, testContentKey, "", "", ""}

	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := CBCSSource(testAdamID, DialerFromAddr(fp.ln.Addr().String()), serveFile(t, tr.file), keys, 0).Stream(ctx, &out); err != nil {
		t.Fatal(err)
	}
	checkFragments(t, decodeOutput(t, out.Bytes()), tr.plain, 0)

	// Exactly upstream's key sequence: the prefetch key under "0", then the bare
	// content URI under the track's adamID — no ",<kid>" suffix.
	want := []string{"0 " + cbcsPrefetchKey, testAdamID + " " + testContentKey}
	if got := fp.opened(); len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("keys opened = %q, want %q", got, want)
	}
}

func TestCBCSSeekStartsMidTrackWithTheContentKey(t *testing.T) {
	tr := buildEncryptedTrack(t, 5)
	fp := newFakeFairPlay(t, map[string][]byte{cbcsPrefetchKey: prefetchAK, testContentKey: contentAK})
	segDur := float64(samplesPerFrag*sampleDur) / 44100
	media := &hls.CBCSMedia{
		FileURL:          serveFile(t, tr.file),
		KeyURIs:          []string{cbcsPrefetchKey, testContentKey, "", "", ""},
		SegmentDurations: []float64{segDur, segDur, segDur, segDur, segDur},
	}
	src, actual := CBCSSeekableSource(testAdamID, DialerFromAddr(fp.ln.Addr().String()), media, 0).SourceFrom(2.5 * segDur)
	if actual != 2*segDur {
		t.Fatalf("seek landed at %.3fs, want the start of fragment 2 (%.3fs)", actual, 2*segDur)
	}
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := src.Stream(ctx, &out); err != nil {
		t.Fatal(err)
	}
	checkFragments(t, decodeOutput(t, out.Bytes()), tr.plain, 2)
	if got := fp.opened(); len(got) != 1 || got[0] != testAdamID+" "+testContentKey {
		t.Fatalf("a seek past segment 1 must open only the content key, got %q", got)
	}
}

// A later declared content key must be opened, including after the usual
// prefetch-to-content transition has already happened.
func TestCBCSHonorsLaterKeyTags(t *testing.T) {
	tr := buildEncryptedTrack(t, 4)
	const laterKey = "skd://itunes.apple.com/p1/c99"
	fp := newFakeFairPlay(t, map[string][]byte{cbcsPrefetchKey: prefetchAK, testContentKey: contentAK, laterKey: contentAK})
	keys := []string{cbcsPrefetchKey, testContentKey, "", laterKey}

	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := CBCSSource(testAdamID, DialerFromAddr(fp.ln.Addr().String()), serveFile(t, tr.file), keys, 0).Stream(ctx, &out); err != nil {
		t.Fatal(err)
	}
	checkFragments(t, decodeOutput(t, out.Bytes()), tr.plain, 0)
	if got := fp.opened(); len(got) != 3 || got[2] != testAdamID+" "+laterKey {
		t.Fatalf("keys opened = %q, want prefetch, content and later keys", got)
	}
}

func TestCBCSPipelineDecryptsTwoPrefetchSegments(t *testing.T) {
	tr := buildEncryptedTrackWithPrefetch(t, 5, 2)
	fp := newFakeFairPlay(t, map[string][]byte{cbcsPrefetchKey: prefetchAK, testContentKey: contentAK})
	keys := []string{cbcsPrefetchKey, "", testContentKey, "", ""}
	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := CBCSSource(testAdamID, DialerFromAddr(fp.ln.Addr().String()), serveFile(t, tr.file), keys, 0).Stream(ctx, &out); err != nil {
		t.Fatal(err)
	}
	checkFragments(t, decodeOutput(t, out.Bytes()), tr.plain, 0)
	if got := fp.opened(); len(got) != 2 || got[1] != testAdamID+" "+testContentKey {
		t.Fatalf("keys opened = %q, want sentinel then the delayed content key", got)
	}
}

// A key FairPlay cannot open must fail the stream, never pass ciphertext through.
func TestCBCSUnknownKeyFailsInsteadOfEmittingCiphertext(t *testing.T) {
	tr := buildEncryptedTrack(t, 3)
	fp := newFakeFairPlay(t, map[string][]byte{cbcsPrefetchKey: prefetchAK})
	keys := []string{cbcsPrefetchKey, testContentKey, ""}

	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err := CBCSSource(testAdamID, DialerFromAddr(fp.ln.Addr().String()), serveFile(t, tr.file), keys, 0).Stream(ctx, &out)
	if err == nil {
		t.Fatal("stream succeeded although the content key could not be opened")
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("stream hung instead of failing")
	}
	for _, f := range decodeOutputPrefix(out.Bytes()) {
		if f > 0 {
			t.Fatalf("fragment %d was written although its key never opened", f)
		}
	}
}

// decodeOutputPrefix returns the indexes of the fragments fully present in out.
func decodeOutputPrefix(out []byte) []int {
	r := bufio.NewReader(bytes.NewReader(out))
	_, off, err := alacstream.ReadInitSegment(r)
	if err != nil {
		return nil
	}
	var idx []int
	for i := 0; ; i++ {
		frag, next, err := alacstream.ReadNextFragment(r, off)
		if err != nil || frag == nil {
			return idx
		}
		off = next
		idx = append(idx, i)
	}
}
