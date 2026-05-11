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
		Title:  "Apple Music",
		Width:  1200,
		Height: 800,
		Frameless: false, // Use the standard native OS title bar
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		// CRITICAL: Since we navigate away from localhost to Apple Music,
		// we must explicitly tell Wails to inject the JS bindings there,
		// otherwise Part 4 (Go <-> JS communication) won't work!
		BindingsAllowedOrigins: "https://music.apple.com",
		OnStartup: func(ctx context.Context) {
			app.startup(ctx)

			// Start the wrapper child process.
			if w, err := wrapperproc.StartWrapper(); err != nil {
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
		OnShutdown: func(ctx context.Context) {
			// Gracefully terminate the wrapper process on app exit.
			if app.wrapper != nil {
				app.wrapper.Stop()
			}
		},
		Bind: []interface{}{
			app,
		},
		Linux: &linux.Options{
			// Explicitly enable hardware acceleration for CSS backdrop-filter (glassmorphism)
			WebviewGpuPolicy: linux.WebviewGpuPolicyAlways,
		},
	})

	if err != nil {
		log.Fatal(err)
	}
}
