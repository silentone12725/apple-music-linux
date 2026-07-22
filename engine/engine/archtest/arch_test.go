// Package archtest verifies the engine's import-boundary invariants.
//
// These tests live in a subpackage (not the module root) deliberately: the
// module is named "main" in go.mod, and the Go toolchain refuses to build a
// test binary for the root package of a module named "main" ("cannot import
// main"). Any subpackage compiles fine, so the boundary checks — which only
// shell out to `go list` — live here.
//
// All test names are prefixed TestArch so CI can select them with
//
//	go test -run TestArch ./...
package archtest

import (
	"os/exec"
	"strings"
	"testing"
)

const repoRoot = "../.."

// directImports returns the packages that pkg imports directly (not transitively).
func directImports(t *testing.T, pkg string) []string {
	t.Helper()
	return goList(t, "-f", "{{range .Imports}}{{.}}\n{{end}}", pkg)
}

// deps returns the full transitive dependency list of pkg.
func deps(t *testing.T, pkg string) []string {
	t.Helper()
	return goList(t, "-deps", pkg)
}

func goList(t *testing.T, args ...string) []string {
	t.Helper()
	cmd := exec.Command("go", append([]string{"list"}, args...)...)
	cmd.Dir = repoRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list %v: %v\n%s", args, err, out)
	}
	var pkgs []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if s := strings.TrimSpace(line); s != "" {
			pkgs = append(pkgs, s)
		}
	}
	return pkgs
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// enginePackages lists all main/engine/* packages via `go list`.
func enginePackages(t *testing.T) []string {
	t.Helper()
	return goList(t, "apple-music-cli/engine/...")
}

// TestArchRunv3ImportedOnlyByFairplay: among engine packages, only
// engine/fairplay may import utils/runv3 directly.
func TestArchRunv3ImportedOnlyByFairplay(t *testing.T) {
	const runv3 = "apple-music-cli/utils/runv3"
	for _, pkg := range enginePackages(t) {
		imports := directImports(t, pkg)
		if contains(imports, runv3) && pkg != "apple-music-cli/engine/fairplay" {
			t.Errorf("%s directly imports %s; only engine/fairplay may", pkg, runv3)
		}
	}
	// And fairplay must actually import it (guards against silent refactors).
	if !contains(directImports(t, "apple-music-cli/engine/fairplay"), runv3) {
		t.Errorf("engine/fairplay no longer imports %s", runv3)
	}
}

func TestArchPlaybackDoesNotImportRunv3(t *testing.T) {
	if contains(directImports(t, "apple-music-cli/engine/playback"), "apple-music-cli/utils/runv3") {
		t.Error("engine/playback must not directly import utils/runv3")
	}
}

func TestArchAppleDoesNotImportRunv3(t *testing.T) {
	if contains(directImports(t, "apple-music-cli/engine/apple"), "apple-music-cli/utils/runv3") {
		t.Error("engine/apple must not directly import utils/runv3")
	}
}

func TestArchHLSDoesNotImportRunv3(t *testing.T) {
	if contains(directImports(t, "apple-music-cli/engine/hls"), "apple-music-cli/utils/runv3") {
		t.Error("engine/hls must not directly import utils/runv3")
	}
}

// TestArchMediaHasNoAppleSpecificDeps: engine/media is the provider-agnostic
// abstraction; none of its transitive deps may be Apple/DRM specific.
func TestArchMediaHasNoAppleSpecificDeps(t *testing.T) {
	forbidden := []string{"apple", "ampapi", "runv3", "fairplay"}
	for _, dep := range deps(t, "apple-music-cli/engine/media") {
		for _, bad := range forbidden {
			if strings.Contains(dep, bad) {
				t.Errorf("engine/media depends on %q (contains %q)", dep, bad)
			}
		}
	}
}

// TestArchNoCycles: `go build ./...` succeeds (import cycles fail the build).
func TestArchNoCycles(t *testing.T) {
	cmd := exec.Command("go", "build", "./...")
	cmd.Dir = repoRoot
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build ./... failed (possible import cycle):\n%s", out)
	}
}

// TestArchEngineDoesNotImportCmd: engine packages must never import cmd/*
// (CLI tools). A frontend depends on the engine, never the reverse.
func TestArchEngineDoesNotImportCmd(t *testing.T) {
	for _, pkg := range enginePackages(t) {
		for _, dep := range deps(t, pkg) {
			if strings.HasPrefix(dep, "apple-music-cli/cmd/") {
				t.Errorf("%s depends on %s (cmd/* must not be imported by engine)", pkg, dep)
			}
		}
	}
}

// TestArchDRMDoesNotImportFairplay: engine/drm must not import engine/fairplay.
// CBCSDialer is defined in engine/fairplay so that fairplay can define it without
// importing drm — enforcing a one-way drm → ??? dependency (drm is standalone).
func TestArchDRMDoesNotImportFairplay(t *testing.T) {
	if contains(deps(t, "apple-music-cli/engine/drm"), "apple-music-cli/engine/fairplay") {
		t.Error("engine/drm must not import engine/fairplay (CBCSDialer lives in fairplay to prevent this cycle)")
	}
}

// TestArchFairplayDoesNotImportDRM: engine/fairplay must not import engine/drm.
// CBCSDialer is defined in engine/fairplay so that fairplay remains importable
// without pulling in the full DRM subsystem.
func TestArchFairplayDoesNotImportDRM(t *testing.T) {
	if contains(deps(t, "apple-music-cli/engine/fairplay"), "apple-music-cli/engine/drm") {
		t.Error("engine/fairplay must not import engine/drm")
	}
}

// TestArchEngineDoesNotImportTUI: engine packages must never import the TUI
// layer (tui.go, survey, tablewriter pulled in only by the CLI).
func TestArchEngineDoesNotImportTUI(t *testing.T) {
	forbidden := []string{
		"github.com/AlecAivazis/survey",
		"github.com/olekukonko/tablewriter",
		"github.com/fatih/color",
	}
	for _, pkg := range enginePackages(t) {
		for _, dep := range deps(t, pkg) {
			for _, bad := range forbidden {
				if strings.HasPrefix(dep, bad) {
					t.Errorf("%s depends on %q (TUI-only dependency)", pkg, dep)
				}
			}
		}
	}
}

// TestArchEngineDoesNotDirectlyImportStructs: engine packages must not
// DIRECTLY import utils/structs (the CLI ConfigSet).  Transitive exposure
// through utils/runv2 is a known Temporary Bridge (see docs/dependency-audit.md
// §Phase3); it will be eliminated when runv2 functions are moved into
// engine/fairplay.  Until then only direct imports are enforced here.
func TestArchEngineDoesNotDirectlyImportStructs(t *testing.T) {
	const structs = "apple-music-cli/utils/structs"
	for _, pkg := range enginePackages(t) {
		if contains(directImports(t, pkg), structs) {
			t.Errorf("%s directly imports %s (CLI config must not be a direct engine dep)", pkg, structs)
		}
	}
	// Document the known transitive path so it's not invisible:
	// engine/fairplay → utils/runv2 → utils/structs.
	// Upgrade this check to use deps() once Phase 3 is complete.
}

// TestArchRunv2ImportedOnlyByFairplay: only engine/fairplay may import
// utils/runv2 directly. This matches the dependency-audit ISL/TB classification.
// When Phase 3 of the decommissioning plan completes, this test should be
// updated to assert that engine/fairplay no longer imports runv2 either.
func TestArchRunv2ImportedOnlyByFairplay(t *testing.T) {
	const runv2 = "apple-music-cli/utils/runv2"
	for _, pkg := range enginePackages(t) {
		if contains(directImports(t, pkg), runv2) && pkg != "apple-music-cli/engine/fairplay" {
			t.Errorf("%s directly imports %s; only engine/fairplay may", pkg, runv2)
		}
	}
	// Guard: fairplay must actually import it until Phase 3 is complete.
	if !contains(directImports(t, "apple-music-cli/engine/fairplay"), runv2) {
		t.Log("engine/fairplay no longer imports runv2 — Phase 3 may be complete; update this test")
	}
}

// TestArchExportDoesNotDirectlyImportEngineInternals: engine/export interacts
// with media acquisition only through the engine/playback.Manager API.  It
// must not directly import engine/apple, engine/hls, or engine/fairplay —
// those are playback-internal packages.
// Note: transitive exposure through engine/playback is expected and permitted.
func TestArchExportDoesNotDirectlyImportEngineInternals(t *testing.T) {
	exportImports := directImports(t, "apple-music-cli/engine/export")
	forbidden := []string{"apple-music-cli/engine/apple", "apple-music-cli/engine/hls", "apple-music-cli/engine/fairplay"}
	for _, imp := range exportImports {
		for _, bad := range forbidden {
			if imp == bad {
				t.Errorf("engine/export directly imports %q — use engine/playback.Manager API instead", bad)
			}
		}
	}
}
