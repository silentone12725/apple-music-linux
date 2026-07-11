package main

import (
	"context"
	"embed"
	"log"
	"os"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"apple-music-linux/wrapperproc"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed frontend/src/preload.js
var preloadJS string

func main() {
	// Disable NVIDIA explicit sync on the Wayland socket — fixes the "Error 71
	// (Protocol error) dispatching to Wayland display" crash that appears on
	// NVIDIA proprietary + WebKitGTK without sacrificing the DMA-BUF rendering
	// path (unlike WEBKIT_DISABLE_DMABUF_RENDERER which falls back to SHM).
	// Confirmed fix per NVIDIA EGL-Wayland 1.15 and Tauri/WebKitGTK issue trackers.
	os.Setenv("__NV_DISABLE_EXPLICIT_SYNC", "1")
	// Keep DMA-BUF compositing enabled for full hardware-accelerated blur/rendering.
	// (No WEBKIT_DISABLE_DMABUF_RENDERER — that would drop to the slow SHM path.)

	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Apple Music",
		Width:     1200,
		Height:    800,
		Frameless: false, // Use the standard native OS title bar
		StartHidden:      false, // Set to false to avoid GBM buffer allocation issues on X11
		BackgroundColour: options.NewRGBA(31, 31, 31, 255), // #1f1f1f
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// CRITICAL: Since we navigate away from localhost to Apple Music,
		// we must explicitly tell Wails to inject the JS bindings there,
		// otherwise Part 4 (Go <-> JS communication) won't work!
		BindingsAllowedOrigins: "https://music.apple.com",
		OnStartup: func(ctx context.Context) {
			patchCookieStorage() // MUST be called after GTK/WebKit initialization
			app.startup(ctx)

			// Start the wrapper child process with stdin left open; the
			// Settings terminal lets the user complete its interactive
			// Apple ID login (and any 2FA prompts) at any time.
			if w, err := wrapperproc.StartWrapper(ctx, ""); err != nil {
				log.Printf("[WrapperProc] Failed to start wrapper: %v", err)
			} else {
				app.wrapper = w
			}

			// Continuously inject our preload JS.
			// Because we navigate away from the local Vite server,
			// Wails' normal asset injection is bypassed.
			go func() {
				for {
					// 3s: each IIFE guards itself with a window.__wailsXxxActive
					// flag so re-evaluation is nearly free after first run — but
					// 500ms was still parsing/executing this 460-line script on the
					// WebKit main thread 2×/second indefinitely, saturating it and
					// causing click events to drop after a few minutes while the
					// compositor-thread-driven scroll remained unaffected.
					time.Sleep(3 * time.Second)
					runtime.WindowExecJS(ctx, preloadJS)
				}
			}()
		},
		OnDomReady: func(ctx context.Context) {
			// Navigate to Apple Music as the top-level page so cookies persist.
			// Login (Apple ID + 2FA) happens through the wrapper's own
			// interactive terminal, exposed via the Settings panel — this
			// page goes straight to Apple Music with no gate.
			runtime.WindowExecJS(ctx, `
				if (!window.location.hostname.includes('apple.com')) {
					window.location.href = 'https://music.apple.com';
				}
			`)
			// Delay showing the window slightly so the webview finishes its
			// first paint before becoming visible — eliminates the resize glitch.
			go func() {
				time.Sleep(800 * time.Millisecond)
				runtime.WindowShow(ctx)
			}()
		},
		OnShutdown: func(ctx context.Context) {
			// Gracefully terminate the wrapper process on app exit.
			if app.wrapper != nil {
				app.wrapper.Stop()
			}
			if err := app.StopStreamPlayback(); err != nil {
				log.Printf("[Player] Failed to stop playback: %v", err)
			}
		},
		Bind: []interface{}{
			app,
		},
		Linux: &linux.Options{
			// Explicitly enable hardware acceleration for CSS backdrop-filter (glassmorphism)
			WebviewGpuPolicy:    linux.WebviewGpuPolicyAlways,
			ProgramName:         "apple-music-linux",
		},
	})

	if err != nil {
		log.Fatal(err)
	}
}
