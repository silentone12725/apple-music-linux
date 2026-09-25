package playback

import (
	"context"
	"testing"
)

// Private sessions back exports: an export's Release must never delete a
// session that playback is still serving, so private opens bypass both the
// reuse index and in-flight merging.

func TestOpenPrivate_DoesNotReusePlaybackSession(t *testing.T) {
	p := &stubProvider{}
	m := newTestManager(p)
	req := OpenRequest{AssetID: "a", Storefront: "us"}

	play, err := m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("playback Open: %v", err)
	}
	priv := req
	priv.Private = true
	exp, err := m.Open(context.Background(), priv)
	if err != nil {
		t.Fatalf("private Open: %v", err)
	}
	if exp.ID == play.ID {
		t.Fatal("private Open returned the playback session")
	}
	if p.calls != 2 {
		t.Fatalf("provider calls = %d, want 2", p.calls)
	}
}

func TestOpenPrivate_NotIndexed(t *testing.T) {
	m := newTestManager(&stubProvider{})
	req := OpenRequest{AssetID: "a", Storefront: "us", Private: true}
	s, err := m.Open(context.Background(), req)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	for k, id := range m.assetIndex {
		if id == s.ID {
			t.Fatalf("private session indexed under %q", k)
		}
	}
	// A later non-private Open must not pick up the private session.
	req.Private = false
	pub, _ := m.Open(context.Background(), req)
	if pub.ID == s.ID {
		t.Fatal("non-private Open reused a private session")
	}
}

func TestOpenPrivate_ReleaseLeavesPlaybackSession(t *testing.T) {
	m := newTestManager(&stubProvider{})
	req := OpenRequest{AssetID: "a", Storefront: "us"}
	play, _ := m.Open(context.Background(), req)

	priv := req
	priv.Private = true
	exp, _ := m.Open(context.Background(), priv)
	m.Release(exp.ID)

	if _, ok := m.GetSession(play.ID); !ok {
		t.Fatal("releasing a private session removed the playback session")
	}
	if again, _ := m.Open(context.Background(), req); again.ID != play.ID {
		t.Fatal("playback session no longer indexed for reuse after private release")
	}
}

func TestOpenPrivate_TwoOpensAreIndependent(t *testing.T) {
	m := newTestManager(&stubProvider{})
	req := OpenRequest{AssetID: "a", Storefront: "us", Private: true}
	s1, _ := m.Open(context.Background(), req)
	s2, _ := m.Open(context.Background(), req)
	if s1.ID == s2.ID {
		t.Fatal("two private Opens returned the same session")
	}
	if len(m.assetIndex) != 0 {
		t.Fatalf("assetIndex has %d entries, want 0", len(m.assetIndex))
	}
	m.Release(s1.ID)
	if _, ok := m.GetSession(s2.ID); !ok {
		t.Fatal("releasing one private session removed the other")
	}
}
