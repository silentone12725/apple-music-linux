package ampapi

import (
	"net/http"
	"time"
)

// apiClient is shared across all ampapi helpers. The 30 s timeout prevents
// goroutine leaks when Apple's CDN is slow or unresponsive. MaxIdleConnsPerHost
// is raised from the default 2 so CDN connections are reused under burst export
// load rather than opened and closed per request.
var apiClient = &http.Client{
	Timeout: 30 * time.Second,
	Transport: &http.Transport{
		MaxIdleConnsPerHost: 20,
	},
}
