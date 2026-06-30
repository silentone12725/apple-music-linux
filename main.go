package main

import (
	"context"
	"embed"
	"log"
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
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Apple Music",
		Width:     1200,
		Height:    800,
		Frameless: false, // Use the standard native OS title bar
		StartHidden:      true, // Stay invisible until the page has settled (no glitchy resize flash)
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
					time.Sleep(500 * time.Millisecond)
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
			WebviewGpuPolicy:    linux.WebviewGpuPolicyOnDemand,
			ProgramName:         "apple-music-linux",
		},
	})

	if err != nil {
		log.Fatal(err)
	}
}
