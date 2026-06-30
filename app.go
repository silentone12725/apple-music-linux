package main

import (
	"context"
	"fmt"
	"log"

	"apple-music-linux/cliplayer"
	"apple-music-linux/wrapperproc"
	"github.com/zalando/go-keyring"
)

const (
	keyringService   = "apple-music-linux"
	keyringUserToken = "media-user-token"
)

// App struct
type App struct {
	ctx     context.Context
	wrapper *wrapperproc.Wrapper
	player  *cliplayer.Player
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{player: cliplayer.New()}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Attempt to load a previously stored token on startup
	token, err := a.LoadCredentials()
	if err != nil {
		log.Println("[Keyring] No stored media-user-token found:", err)
	} else {
		log.Printf("[Keyring] Loaded stored media-user-token (%d chars)", len(token))
	}
}

// ── media-user-token (session token from cookie) ──────────────────────────

// StoreCredentials saves the Apple Music media-user-token to the OS keyring.
func (a *App) StoreCredentials(token string) error {
	if token == "" {
		return fmt.Errorf("token cannot be empty")
	}
	err := keyring.Set(keyringService, keyringUserToken, token)
	if err != nil {
		log.Println("[Keyring] Failed to store media-user-token:", err)
		return err
	}
	log.Printf("[Keyring] Stored media-user-token (%d chars)", len(token))
	return nil
}

// LoadCredentials retrieves the Apple Music media-user-token from the OS keyring.
func (a *App) LoadCredentials() (string, error) {
	return keyring.Get(keyringService, keyringUserToken)
}

// ── Wrapper process terminal (Settings panel) ─────────────────────────────

// WrapperSendInput logs the wrapper in. The wrapper binary takes its Apple ID
// credentials as a "-L email:password" startup flag rather than over stdin,
// so submitting a line from the Settings terminal stops any running wrapper
// and relaunches it with that login.
func (a *App) WrapperSendInput(text string) error {
	if text == "" {
		return fmt.Errorf("login is empty (expected email:password)")
	}
	if a.wrapper != nil {
		a.wrapper.Stop()
	}
	w, err := wrapperproc.StartWrapper(a.ctx, text)
	if err != nil {
		return err
	}
	a.wrapper = w
	return nil
}

// WrapperLogs returns the buffered wrapper output so the Settings terminal
// can render history on open; live updates arrive via the "wrapper:log" event.
func (a *App) WrapperLogs() []string {
	if a.wrapper == nil {
		return nil
	}
	return a.wrapper.Logs()
}

// StartStreamPlayback launches apple-music-cli stream playback for a track URL.
func (a *App) StartStreamPlayback(url string) error {
	if url == "" {
		return fmt.Errorf("track url is empty")
	}
	if a.player == nil {
		return fmt.Errorf("player not initialized")
	}
	mediaToken, err := a.LoadCredentials()
	if err != nil {
		return fmt.Errorf("missing media-user-token: %w", err)
	}
	return a.player.StartStream(url, mediaToken)
}

// StopStreamPlayback stops any active apple-music-cli playback.
func (a *App) StopStreamPlayback() error {
	if a.player == nil {
		return nil
	}
	return a.player.Stop()
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}
