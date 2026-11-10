package drm

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"
)

// ErrLogoutPending is returned while a sign-out is running or a pending one could
// not be completed yet: no session may be started or reused until it finishes.
var ErrLogoutPending = errors.New("sign-out in progress or incomplete")

// ErrSignInRunning is returned by Authenticate while another sign-in is still in progress.
var ErrSignInRunning = errors.New("a sign-in is already running")

// gateState says whether sessions may be started or reused.
type gateState int

const (
	gateOpen       gateState = iota // no sign-out work
	gateSigningOut                  // a sign-out request owns the marker and the backend
	gateReplaying                   // a pending sign-out on disk is being (or still has to be) completed
)

// cleanupOp is the single cleanup pass that may run at a time. Callers that find
// one running join it: they wait on done after releasing gateMu.
type cleanupOp struct {
	done chan struct{}
	err  error
}

// signOutTiming bounds every wait in a sign-out. A test shortens them.
type signOutTiming struct {
	Route      time.Duration // the whole sign-out request
	AuthWait   time.Duration // waiting for a sign-in in progress to finish
	ReplayWait time.Duration // a start waiting on a pending sign-out's cleanup
}

var defaultSignOutTiming = signOutTiming{Route: 45 * time.Second, AuthWait: 15 * time.Second, ReplayWait: 15 * time.Second}

// SignOutResult is what a sign-out reports to the caller.
type SignOutResult struct {
	// ServerSignOut is "skipped" until the engine can sign out on Apple's servers.
	ServerSignOut string
	// Restart is set when the sign-out could not finish safely in this process (a
	// sign-in stuck in native code, or a cleanup that did not finish in time). The
	// request is recorded on disk; the caller answers, then the process exits and
	// the next one completes the sign-out before any session exists.
	Restart bool
}

// acquire takes a one-slot semaphore, giving up at the deadline or when ctx ends.
func acquire(ctx context.Context, sem chan struct{}, wait time.Duration) bool {
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case sem <- struct{}{}:
		return true
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
	}
}

func release(sem chan struct{}) { <-sem }

// startCleanupLocked starts the one cleanup pass. The caller holds gateMu. A replay
// moves the gate to replaying; a sign-out's own wipe keeps signingOut, and the
// sign-out decides the state afterwards.
func (m *DRMManager) startCleanupLocked() *cleanupOp {
	op := &cleanupOp{done: make(chan struct{})}
	m.cleanup = op
	if m.gate != gateSigningOut {
		m.gate = gateReplaying
	}
	go func() {
		// A pending request may meet a running backend (a backstop written while the
		// engine ran): stop it first, or storeservicescore writes the files back. No
		// start can run meanwhile: the gate is closed.
		if m.backend.Running() {
			_ = m.backend.Stop()
		}
		err := m.session.runPendingPass()
		m.gateMu.Lock()
		op.err = err
		m.cleanup = nil
		if err == nil && m.gate == gateReplaying {
			m.gate = gateOpen
		}
		m.gateMu.Unlock()
		close(op.done)
	}()
	return op
}

// waitOp waits for a cleanup pass without holding gateMu.
func waitOp(ctx context.Context, op *cleanupOp, wait time.Duration) error {
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-op.done:
		if op.err != nil {
			return fmt.Errorf("%w: %v", ErrLogoutPending, op.err)
		}
		return nil
	case <-t.C:
		return ErrLogoutPending
	case <-ctx.Done():
		return ctx.Err()
	}
}

// awaitClearGate is the gate check every start goes through, after the caller took
// authSem. It decides under gateMu, waits for a cleanup with gateMu released, and
// returns nil only once the gate is open and no sign-out request is on disk.
func (m *DRMManager) awaitClearGate(ctx context.Context, replay bool) error {
	for round := 0; round < 3; round++ {
		m.gateMu.Lock()
		var op *cleanupOp
		switch {
		case m.gate == gateSigningOut:
			m.gateMu.Unlock()
			return ErrLogoutPending
		case m.cleanup != nil:
			op = m.cleanup
		case m.session.hasPending():
			if !replay {
				m.gateMu.Unlock()
				return ErrLogoutPending
			}
			op = m.startCleanupLocked()
		default:
			m.gate = gateOpen
			m.gateMu.Unlock()
			return nil
		}
		m.gateMu.Unlock()
		if err := waitOp(ctx, op, m.timing.ReplayWait); err != nil {
			return err
		}
	}
	return ErrLogoutPending
}

// SignOutPending reports whether a sign-out is running or still has to complete.
func (m *DRMManager) SignOutPending() bool {
	m.gateMu.Lock()
	defer m.gateMu.Unlock()
	return m.gate != gateOpen || m.cleanup != nil || m.session.hasPending()
}

// Logout signs the account out: the session ends, Apple's account files go, and
// the device identity stays, so signing in again here normally needs no code.
func (m *DRMManager) Logout(ctx context.Context) (SignOutResult, error) {
	return m.signOut(ctx, scopeAccount)
}

// ForgetDevice signs out and also removes the device identity, like "Deauthorize
// This Computer": the next sign-in comes from a new device and asks for a code.
func (m *DRMManager) ForgetDevice(ctx context.Context) (SignOutResult, error) {
	return m.signOut(ctx, scopeDevice)
}

func (m *DRMManager) signOut(ctx context.Context, scope logoutScope) (SignOutResult, error) {
	res := SignOutResult{ServerSignOut: "skipped"}
	deadline := time.Now().Add(m.timing.Route)
	left := func() time.Duration { return max(time.Until(deadline), 0) }

	// One sign-out request at a time: a second one (e.g. Forget This Device right
	// after Sign Out) waits and then runs with its own scope.
	if !acquire(ctx, m.signOutSem, left()) {
		return res, errors.New("another sign-out is still running")
	}
	defer release(m.signOutSem)

	// A replay in progress finishes first, so this request's marker is not consumed
	// by a pass that started with a weaker scope.
	m.gateMu.Lock()
	if op := m.cleanup; op != nil {
		m.gateMu.Unlock()
		if err := waitOp(ctx, op, left()); err != nil && errors.Is(err, ErrLogoutPending) && left() == 0 {
			return m.restartPath(res, "a pending sign-out did not finish")
		}
		m.gateMu.Lock()
	}
	// Close the gate and record the request as one step: a start that checks the
	// gate after this sees signingOut, one that checked before ran its replay before
	// the marker existed.
	prev := m.gate
	m.gate = gateSigningOut
	if err := m.session.MarkLogoutPending(scope); err != nil {
		m.gate = prev
		m.gateMu.Unlock()
		return res, fmt.Errorf("record sign-out: %w", err)
	}
	m.gateMu.Unlock()
	m.setManagerState(ManagerShuttingDown)

	// End a sign-in waiting for a verification code, then wait for the sign-in to
	// return: nothing may stop the backend or delete files under it.
	m.auth.Abort()
	if !acquire(ctx, m.authSem, min(m.timing.AuthWait, left())) {
		return m.restartPath(res, "a sign-in did not finish")
	}
	defer release(m.authSem)

	stopErr := m.backend.Stop()
	if stopErr != nil {
		stopErr = fmt.Errorf("logout stop: %w", stopErr)
	}

	m.gateMu.Lock()
	op := m.startCleanupLocked()
	m.gateMu.Unlock()
	t := time.NewTimer(left())
	defer t.Stop()
	select {
	case <-op.done:
	case <-t.C:
		return m.restartPath(res, "the sign-out cleanup did not finish in time")
	}
	m.gateMu.Lock()
	if op.err != nil {
		// The request stays on disk; later starts retry or join the cleanup.
		m.gate = gateReplaying
	} else {
		m.gate = gateOpen
	}
	m.gateMu.Unlock()
	if op.err != nil {
		return res, errors.Join(stopErr, fmt.Errorf("clear session: %w", op.err))
	}

	// emitMu only around copy+send: holding it across backend.Stop would deadlock
	// with a login blocked on a 2FA challenge.
	m.emitMu.Lock()
	m.mu.Lock()
	m.snapshot.State = DRMState{
		Manager:        ManagerReady,
		Process:        ProcessStopped,
		Authentication: AuthLoggedOut,
		FairPlay:       FairPlayUnknown,
		Session:        SessionEmpty,
		Recovery:       RecoveryUnknown,
	}
	m.snapshot.Capabilities = CapabilityState{}
	m.snapshot.Challenge = nil
	snap := m.snapshot
	m.mu.Unlock()
	if m.sink != nil {
		m.sink(snap)
	}
	m.emitMu.Unlock()
	return res, stopErr
}

// restartPath leaves the recorded request for the next process: the gate stays
// closed here, nothing is stopped or deleted under native code that may still be
// running, and the caller answers and then ends the process.
func (m *DRMManager) restartPath(res SignOutResult, why string) (SignOutResult, error) {
	log.Printf("[drm] sign-out finishes after the engine restarts: %s", why)
	m.restartPending.Store(true)
	res.Restart = true
	return res, fmt.Errorf("sign-out finishes after the engine restarts: %s", why)
}

// RestartPending reports that a sign-out needs the process to restart.
func (m *DRMManager) RestartPending() bool { return m.restartPending.Load() }
