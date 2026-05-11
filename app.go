package main

import (
	"context"
	"fmt"
	"log"

	"apple-music-linux/wrapperproc"
	"github.com/zalando/go-keyring"
)

const (
	keyringService       = "apple-music-linux"
	keyringUserToken     = "media-user-token"
	keyringUserEmail     = "apple-id-email"
	keyringUserPassword  = "apple-id-password"
)

// App struct
type App struct {
	ctx     context.Context
	wrapper *wrapperproc.Wrapper
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
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

	// Check if Apple ID credentials are stored
	email, _, err := a.LoadAppleIDCredentials()
	if err != nil {
		log.Println("[Keyring] No stored Apple ID credentials found:", err)
	} else {
		log.Printf("[Keyring] Loaded Apple ID credentials for: %s", email)
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

// ── Apple ID email & password ──────────────────────────────────────────────

// StoreAppleIDCredentials saves the user's Apple ID email and password
// to the OS keyring (GNOME Keyring / KWallet), encrypted at rest.
func (a *App) StoreAppleIDCredentials(email, password string) error {
	if email == "" || password == "" {
		return fmt.Errorf("email and password cannot be empty")
	}
	if err := keyring.Set(keyringService, keyringUserEmail, email); err != nil {
		log.Println("[Keyring] Failed to store Apple ID email:", err)
		return err
	}
	if err := keyring.Set(keyringService, keyringUserPassword, password); err != nil {
		log.Println("[Keyring] Failed to store Apple ID password:", err)
		return err
	}
	log.Printf("[Keyring] Apple ID credentials stored for: %s", email)
	return nil
}

// LoadAppleIDCredentials retrieves the Apple ID email and password from the OS keyring.
// Returns ("", "", error) if credentials have not been stored yet.
func (a *App) LoadAppleIDCredentials() (string, string, error) {
	email, err := keyring.Get(keyringService, keyringUserEmail)
	if err != nil {
		return "", "", err
	}
	password, err := keyring.Get(keyringService, keyringUserPassword)
	if err != nil {
		return "", "", err
	}
	return email, password, nil
}

// HasAppleIDCredentials returns true if Apple ID credentials are already stored.
func (a *App) HasAppleIDCredentials() bool {
	email, _, err := a.LoadAppleIDCredentials()
	return err == nil && email != ""
}

// ClearAppleIDCredentials removes stored Apple ID credentials from the keyring.
func (a *App) ClearAppleIDCredentials() error {
	_ = keyring.Delete(keyringService, keyringUserEmail)
	_ = keyring.Delete(keyringService, keyringUserPassword)
	log.Println("[Keyring] Apple ID credentials cleared.")
	return nil
}

// Greet returns a greeting for the given name
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s, It's show time!", name)
}
