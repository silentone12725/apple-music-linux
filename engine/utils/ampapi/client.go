package ampapi

import (
	"net/http"
	"time"
)

// apiClient is shared across all ampapi helpers. The 30 s timeout prevents
// goroutine leaks when Apple's CDN is slow or unresponsive. MaxIdleConnsPerHost
// is raised from the default 2 so CDN connections are reused under burst export
// load rather than opened and closed per request.
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"

var apiClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		MaxIdleConnsPerHost: 20,
	},
}
