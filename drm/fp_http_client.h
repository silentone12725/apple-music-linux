/*
 * fp_http_client.h - HTTP License Exchange Client
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay HTTP license exchange.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 *
 * Handles HTTP communication with Apple's FairPlay license server.
 */

#ifndef FP_HTTP_CLIENT_H
#define FP_HTTP_CLIENT_H

#include "fairplay.h"
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * HTTP Client Constants
 * ============================================================================= */

/** Apple Music streaming key delivery endpoint (Widevine/web playback path) */
#define FP_LICENSE_SERVER_URL \
    "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense"

/** Default HTTP timeout (seconds) */
#define FP_HTTP_TIMEOUT_SECONDS 30

/** Default max retries */
#define FP_HTTP_MAX_RETRIES 3

/** Default retry backoff (milliseconds) */
#define FP_HTTP_RETRY_BACKOFF_MS 1000

/** Maximum response size */
#define FP_HTTP_MAX_RESPONSE_SIZE 65536

/** Maximum URL size */
#define FP_HTTP_MAX_URL_SIZE 2048

/* =============================================================================
 * HTTP Client Configuration
 * ============================================================================= */

/**
 * HTTP client configuration.
 */
typedef struct {
    const char *license_server_url;   /**< License server URL */
    const char *user_agent;           /**< User-Agent header */
    int timeout_seconds;              /**< Request timeout */
    int max_retries;                  /**< Maximum retry attempts */
    int retry_backoff_ms;             /**< Backoff between retries */
    bool verify_ssl;                  /**< Verify SSL certificates */
    const char *proxy_host;           /**< HTTP proxy host (optional) */
    int proxy_port;                   /**< HTTP proxy port (optional) */
} fp_http_config_t;

/* =============================================================================
 * HTTP Response Structure
 * ============================================================================= */

/**
 * HTTP response from license server.
 */
typedef struct {
    int http_status_code;             /**< HTTP status code (200, 401, etc.) */
    uint8_t *response_data;           /**< Raw response body (allocated) */
    size_t response_size;             /**< Size of raw response data */

    /* Decoded CKC binary (base64-decoded from JSON "ckc" field) */
    uint8_t *ckc_data;                /**< Decoded CKC binary (allocated, may be NULL) */
    size_t ckc_size;                  /**< Size of decoded CKC */

    /* Headers (commonly used) */
    char content_type[256];           /**< Content-Type header */
    char x_request_id[128];           /**< X-Request-ID header */

    /* Error information */
    int error_code;                   /**< Server error code (if any) */
    char error_message[512];          /**< Server error message */
} fp_http_response_t;

/* =============================================================================
 * HTTP Client Functions
 * ============================================================================= */

/**
 * Initialize HTTP configuration with defaults.
 * 
 * @param config Configuration structure to initialize
 */
void fp_http_config_init(fp_http_config_t *config);

/**
 * Fetch content key from Apple's streaming key delivery endpoint.
 *
 * Posts a JSON request with the media URI and adamId to
 * buy.itunes.apple.com/itcs/key/get, parses the JSON response, and
 * base64-decodes the returned CKC binary into out_response->ckc_data.
 *
 * @param config HTTP client configuration
 * @param media_uri Full skd:// URI (e.g. "skd://itunes.apple.com/p1234/c23")
 * @param adam_id Numeric asset ID string (e.g. "1882789761")
 * @param auth_token Apple Music Bearer token
 * @param storefront_id Storefront identifier (e.g. "143441")
 * @param device_guid Device GUID (may be NULL)
 * @param out_response Output: HTTP response (caller must free)
 * @return FP_OK on success, error code otherwise
 *
 * Errors:
 * - FP_ERR_NULL_POINTER: NULL argument
 * - FP_ERR_NETWORK_TIMEOUT: Request timed out
 * - FP_ERR_HTTP_ERROR: HTTP error response (4xx, 5xx)
 * - FP_ERR_OUT_OF_MEMORY: Allocation failed
 * - FP_ERR_CKC_PARSE_FAILED: Response JSON missing "ckc" field or invalid base64
 */
fp_error_t fp_license_exchange(
    const fp_http_config_t *config,
    const char *media_uri,
    const char *adam_id,
    const char *auth_token,
    const char *storefront_id,
    const char *device_guid,
    fp_http_response_t **out_response
);

/**
 * Free HTTP response resources.
 * 
 * @param response HTTP response to free (may be NULL)
 */
void fp_http_response_free(fp_http_response_t *response);

/**
 * Check if HTTP status code indicates success.
 * 
 * @param status_code HTTP status code
 * @return true if 2xx, false otherwise
 */
bool fp_http_is_success(int status_code);

/**
 * Check if HTTP status code indicates retryable error.
 * 
 * @param status_code HTTP status code
 * @return true if 5xx or 429, false otherwise
 */
bool fp_http_should_retry(int status_code);

#ifdef __cplusplus
}
#endif

#endif /* FP_HTTP_CLIENT_H */
