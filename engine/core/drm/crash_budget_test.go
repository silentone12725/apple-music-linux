package drm

import (
	"context"
	"testing"
	"time"
)

// crashStub embeds DRMBackend for the methods handleCrash never calls.
type crashStub struct {
	DRMBackend
	events chan DRMEvent
	starts int
}

func (c *crashStub) SetAuthSource(AuthSource)                   {}
func (c *crashStub) Events() <-chan DRMEvent                    { return c.events }
func (c *crashStub) Running() bool                              { return false }
func (c *crashStub) Start(context.Context, BackendConfig) error { c.starts++; return nil }

func TestCrashBudgetCountsOnlyConsecutiveCrashes(t *testing.T) {
	stub := &crashStub{events: make(chan DRMEvent)}
	m := NewDRMManager(stub, NewSessionManager(t.TempDir()), nil, BackendConfig{},
		RestartPolicy{MaxCrashRestarts: 2, RestartBackoff: []time.Duration{time.Millisecond}, StartupTimeout: time.Second})

	// Crash loop: restarts immediately crash again → budget exhausts.
	m.handleCrash()
	m.handleCrash()
	m.handleCrash()
	if stub.starts != 2 || m.Status().State.Manager != ManagerFailed {
		t.Fatalf("crash loop: starts=%d manager=%v, want 2 restarts then failed", stub.starts, m.Status().State.Manager)
	}

	// A crash after a long healthy run gets a fresh budget.
	m.setManagerState(ManagerReady)
	m.lastStart.Store(time.Now().Add(-2 * crashResetWindow).UnixNano())
	m.handleCrash()
	if stub.starts != 3 {
		t.Fatalf("after healthy run: starts=%d, want 3 (budget reset)", stub.starts)
	}
}

type logoutStub struct {
	crashStub
}

func (logoutStub) Stop() error { return nil }

func TestLogoutReleasesRecoveryWaitersAndToleratesNilSink(t *testing.T) {
	stub := &logoutStub{crashStub{events: make(chan DRMEvent)}}
	m := NewDRMManager(stub, NewSessionManager(t.TempDir()), nil, BackendConfig{}, DefaultRestartPolicy)
	m.mergeAndEmit(DRMSnapshot{State: DRMState{Recovery: RecoveryRefreshing}})
	if active, _ := m.recoveryActive(); !active {
		t.Fatal("setup: recovery not active")
	}
	_, gate := m.recoveryActive()
	if err := m.Logout(context.Background()); err != nil { // nil sink must not panic
		t.Fatal(err)
	}
	select {
	case <-gate:
	case <-time.After(time.Second):
		t.Fatal("Decrypt waiters stay parked after logout")
	}
}
