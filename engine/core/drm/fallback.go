package drm

import (
	"context"
	"fmt"
	"net"
	"sync"
	"time"
)

// fallbackBackend is a DRMBackend that starts a preferred backend and, if that
// backend fails to start, transparently falls back to a secondary one. It is
// itself a DRMBackend, so DRMManager and everything above it are unchanged and
// unaware that two implementations exist.
//
// Scope (deliberately bounded — see docs/design/backend-supervisor.md):
//   - Selection happens ONCE, at the first Start(). Fallback triggers only when
//     the preferred backend's Start() returns an error (e.g. Embedded's CGO
//     container fork fails, or rootfs is missing — the "this backend can't run
//     here" case). After selection, all calls (including crash-restart Start())
//     go to the chosen backend.
//   - There is NO runtime health-monitored hot-swap and NO reverse failover.
//     Those belong to a future BackendSupervisor once the backends diverge
//     (native DRM). Today both ultimately launch the same wrapper, so runtime
//     failover would only switch launch mechanisms, not the DRM implementation.
type fallbackBackend struct {
	preferred DRMBackend
	fallback  DRMBackend
	prefName  string
	fbName    string

	events chan DRMEvent

	mu             sync.Mutex
	active         DRMBackend
	activeName     string
	fallbackReason string // "" when the preferred backend was used
	forwarding     bool
}

// BackendSelection is implemented by composite backends that choose among
// multiple implementations. It lets the API layer surface which backend is
// active and why a fallback occurred, without the DRM package deciding logging.
type BackendSelection interface {
	ActiveName() string     // "" until the first Start selects a backend
	FallbackReason() string // "" when the preferred backend was used
}

// NewFallbackBackend wraps a preferred backend with a fallback. Both are wired
// with the same AuthSource and configuration; only one is ever started.
func NewFallbackBackend(preferred DRMBackend, prefName string, fallback DRMBackend, fbName string) DRMBackend {
	return &fallbackBackend{
		preferred: preferred,
		fallback:  fallback,
		prefName:  prefName,
		fbName:    fbName,
		events:    make(chan DRMEvent, 16),
	}
}

// ActiveName reports which backend was selected ("" before the first Start).
func (b *fallbackBackend) ActiveName() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.activeName
}

// FallbackReason reports why the fallback backend was chosen, or "" if the
// preferred backend started successfully.
func (b *fallbackBackend) FallbackReason() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.fallbackReason
}

func (b *fallbackBackend) SetAuthSource(a AuthSource) {
	// Either backend may become active, so both must be able to answer challenges.
	b.preferred.SetAuthSource(a)
	b.fallback.SetAuthSource(a)
}

func (b *fallbackBackend) Events() <-chan DRMEvent { return b.events }

func (b *fallbackBackend) Start(ctx context.Context, cfg BackendConfig) error {
	b.mu.Lock()
	active := b.active
	b.mu.Unlock()

	// Already selected (e.g. crash restart): restart the chosen backend only.
	if active != nil {
		return active.Start(ctx, cfg)
	}

	// First start: try preferred, then fall back on a Start error.
	if err := b.preferred.Start(ctx, cfg); err == nil {
		b.selectActive(b.preferred, b.prefName, "")
		return nil
	} else {
		prefErr := err
		// Clean up any partial state before switching.
		_ = b.preferred.Stop()
		if err := b.fallback.Start(ctx, cfg); err != nil {
			return fmt.Errorf("both backends failed to start: %s: %v; %s: %w",
				b.prefName, prefErr, b.fbName, err)
		}
		b.selectActive(b.fallback, b.fbName, prefErr.Error())
		return nil
	}
}

// selectActive records the chosen backend, emits a selection DRMEvent (the DRM
// package does not log directly), and forwards the backend's events onto the
// composite channel (once — backends expose a stable channel across restarts).
func (b *fallbackBackend) selectActive(be DRMBackend, name, reason string) {
	b.mu.Lock()
	b.active = be
	b.activeName = name
	b.fallbackReason = reason
	startFwd := !b.forwarding
	b.forwarding = true
	b.mu.Unlock()

	msg := "DRM backend selected: " + name
	if reason != "" {
		msg = fmt.Sprintf("DRM preferred backend %q failed (%s); using fallback %q", b.prefName, reason, name)
	}
	b.emit(DRMEvent{Snapshot: DRMSnapshot{Message: msg, Timestamp: time.Now()}, Intentional: true})

	if startFwd {
		go b.forward(be)
	}
}

// emit sends a composite-level event, best-effort (the stable reader is
// DRMManager.watchEvents; FallbackReason() is the authoritative status source).
func (b *fallbackBackend) emit(ev DRMEvent) {
	select {
	case b.events <- ev:
	default:
	}
}

func (b *fallbackBackend) forward(be DRMBackend) {
	for ev := range be.Events() {
		b.events <- ev
	}
}

// activeOr returns the active backend or nil (before the first successful Start).
func (b *fallbackBackend) activeOr() DRMBackend {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.active
}

func (b *fallbackBackend) Running() bool {
	if a := b.activeOr(); a != nil {
		return a.Running()
	}
	return false
}

func (b *fallbackBackend) Authenticate(ctx context.Context) error {
	if a := b.activeOr(); a != nil {
		return a.Authenticate(ctx)
	}
	return fmt.Errorf("drm: backend not started")
}

func (b *fallbackBackend) Stop() error {
	if a := b.activeOr(); a != nil {
		return a.Stop()
	}
	return nil
}

func (b *fallbackBackend) Decrypt(ctx context.Context, req DecryptRequest) (DecryptResponse, error) {
	if a := b.activeOr(); a != nil {
		return a.Decrypt(ctx, req)
	}
	return DecryptResponse{}, fmt.Errorf("drm: backend not started")
}

func (b *fallbackBackend) GetM3U8(ctx context.Context, adamID uint64) (string, error) {
	if a := b.activeOr(); a != nil {
		return a.GetM3U8(ctx, adamID)
	}
	return "", fmt.Errorf("drm: backend not started")
}

func (b *fallbackBackend) GetAccount(ctx context.Context) (AccountInfo, error) {
	if a := b.activeOr(); a != nil {
		return a.GetAccount(ctx)
	}
	return AccountInfo{}, fmt.Errorf("drm: backend not started")
}

func (b *fallbackBackend) DialCBCS(ctx context.Context) (net.Conn, error) {
	if a := b.activeOr(); a != nil {
		return a.DialCBCS(ctx)
	}
	return nil, fmt.Errorf("drm: backend not started")
}
