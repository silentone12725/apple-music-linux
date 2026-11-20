package ampapi

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
)

// maxTokenPageBytes bounds the web player page and script scanned for the developer token.
const maxTokenPageBytes = 32 << 20

func GetToken() (string, error) {
	req, err := http.NewRequest("GET", "https://music.apple.com", nil)
	if err != nil {
		return "", err
	}

	resp, err := apiClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxTokenPageBytes))
	if err != nil {
		return "", err
	}

	regex := regexp.MustCompile(`/assets/index~[^/]+\.js`)
	indexJsUri := regex.FindString(string(body))
	if indexJsUri == "" {
		return "", fmt.Errorf("token: web player script not found on music.apple.com")
	}

	req, err = http.NewRequest("GET", "https://music.apple.com"+indexJsUri, nil)
	if err != nil {
		return "", err
	}

	resp, err = apiClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err = io.ReadAll(io.LimitReader(resp.Body, maxTokenPageBytes))
	if err != nil {
		return "", err
	}

	regex = regexp.MustCompile(`eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+`)
	token := regex.FindString(string(body))
	if token == "" {
		// An empty token with a nil error went on as an empty bearer and failed later as an unexplained 401.
		return "", fmt.Errorf("token: no developer token found in the web player script")
	}

	return token, nil
}
