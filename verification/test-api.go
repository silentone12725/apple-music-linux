package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"time"
)

func main() {
	// Start the API server
	cmd := exec.Command("go", "run", ".", "--api", "8080")
	cmd.Dir = "/home/daksh/Git Projects/apple-music-cli"
	if err := cmd.Start(); err != nil {
		fmt.Printf("Failed to start API server: %v\n", err)
		return
	}
	defer func() {
		cmd.Process.Kill()
		cmd.Wait()
	}()

	// Wait for server to start
	time.Sleep(5 * time.Second)

	// Fetch SID
	reqBody := []byte(`{"assetId":"1887524263","capabilities":{"lossless":true}}`)
	resp, err := http.Post("http://127.0.0.1:8080/api/v1/playback", "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		fmt.Printf("Failed to get playback: %v\n", err)
		return
	}
	defer resp.Body.Close()

	var result struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fmt.Printf("Failed to decode response: %v\n", err)
		return
	}

	sid := result.SessionID
	fmt.Printf("Got Session: %s\n", sid)

	// Fetch Headers
	audioURL := fmt.Sprintf("http://127.0.0.1:8080/api/v1/playback/%s/audio?raw=1", sid)
	fmt.Printf("Fetching: %s\n", audioURL)
	
	headResp, err := http.Get(audioURL) // Do a GET since HEAD might be blocked
	if err != nil {
		fmt.Printf("Failed to get audio: %v\n", err)
		return
	}
	defer headResp.Body.Close()

	fmt.Printf("Response Status: %s\n", headResp.Status)
	fmt.Printf("Content-Length Header: %s\n", headResp.Header.Get("Content-Length"))
	
	// Read first 100 bytes to unblock the writer
	buf := make([]byte, 100)
	n, _ := headResp.Body.Read(buf)
	fmt.Printf("Read %d bytes successfully\n", n)
}
