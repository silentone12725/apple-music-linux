package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestEventsFinishWhenServerLifetimeEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	epoch := newEpochManager()
	api := &APIServer{shutdownCtx: ctx, epoch: epoch, events: newEventBus(epoch)}
	server := httptest.NewServer(http.HandlerFunc(api.handleEvents))
	defer server.Close()
	response, err := server.Client().Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	done := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, response.Body); done <- err }()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("SSE kept the server alive after shutdown cancellation")
	}
}
