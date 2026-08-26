package ampapi

import (
	"net/http"
	"time"
)

// apiClient is shared across all ampapi helpers. The 30 s timeout prevents
// goroutine leaks when Apple's CDN is slow or unresponsive.
var apiClient = &http.Client{Timeout: 30 * time.Second}
