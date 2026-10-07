/*
 * drm_client.h - DRM Client API
 * 
 * Version: 2.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay DRM client for Linux.
 * Independently authored by AML DRM Team.
 *
 * This header defines the high-level DRM client API for:
 * - License acquisition
 * - HLS manifest parsing
 * - Content decryption workflow
 *
 * Compile with: gcc -std=c11 -pedantic -Wall -Wextra
 * Link with: -lssl -lcrypto -lpthread
 */

#ifndef DRM_CLIENT_H
#define DRM_CLIENT_H

#include "fairplay.h"
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * Version Information
 * ============================================================================= */

#define DRM_CLIENT_VERSION_MAJOR  2
#define DRM_CLIENT_VERSION_MINOR  0
#define DRM_CLIENT_VERSION_PATCH  0
#define DRM_CLIENT_VERSION_STRING "2.0.0"

const char *drm_client_version(void);
void drm_client_version_components(int *major, int *minor, int *patch);

/* =============================================================================
 * Configuration (REQ-002)
 * ============================================================================= */

/**
 * DRM Client Configuration
 * 
 * Required fields:
 * - license_server_url: URL of the license acquisition server
 * - user_agent: User-Agent string for HTTP requests
 * 
 * Optional fields (use defaults if not set):
 * - timeout_seconds: HTTP timeout (default: 30)
 * - max_retries: Maximum retry attempts (default: 3)
 * - proxy_host, proxy_port: HTTP proxy settings
 */
typedef struct {
    const char *license_server_url;  /* Required (REQ-002) */
    const char *user_agent;          /* Required (REQ-002) */
    
    const char *proxy_host;          /* Optional */
    int proxy_port;                  /* Optional */
    
    int timeout_seconds;             /* Required, default 30 (REQ-027) */
    int max_retries;                 /* Optional, default 3 (REQ-029) */
    
    /* Extended options */
    bool verify_ssl;                 /* Verify SSL certificates (default: true) */
    const char *client_id;           /* Optional client identifier */
    const char *device_id;           /* Optional device identifier (REQ-023) */
} drm_config_t;

/**
 * Initialize configuration with defaults.
 */
void drm_config_init(drm_config_t *config);

/* =============================================================================
 * DRM Client Handle
 * ============================================================================= */

/**
 * DRM Client Handle (REQ-003)
 * 
 * Opaque handle to a DRM client instance.
 */
typedef struct drm_client drm_client_t;

/**
 * Create a DRM client instance.
 * 
 * @param config Configuration structure (must remain valid during client lifetime)
 * @param out_client Output: newly created client
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_create(const drm_config_t *config, drm_client_t **out_client);

/**
 * Destroy a DRM client instance.
 * 
 * @param client Client to destroy (may be NULL)
 */
void drm_client_destroy(drm_client_t *client);

/**
 * Get the last error for a client.
 * 
 * @param client DRM client
 * @return Last error code
 */
fp_error_t drm_client_get_error(const drm_client_t *client);

/**
 * Get human-readable error message.
 * 
 * @param client DRM client
 * @return Error message string
 */
const char *drm_client_get_error_message(const drm_client_t *client);

/* =============================================================================
 * License Acquisition (REQ-021 through REQ-040)
 * ============================================================================= */

/**
 * License Request Options
 */
typedef struct {
    const fp_kid_t *content_id;      /* Required: Content/Key ID */
    const char *pssh_b64;            /* Optional: Base64-encoded PSSH */
    const char *session_id;          /* Optional: Session identifier */
    bool force_renewal;              /* Force license renewal */
} drm_license_request_t;

/**
 * License Response
 */
typedef struct {
    fp_kid_t content_id;             /* Content ID from response */
    fp_key_t decryption_key;         /* Decryption key (REQ-034, REQ-035) */
    uint64_t expires_at;             /* Expiration time (REQ-036) */
    uint64_t lease_duration;         /* Lease duration in seconds (REQ-037) */
    
    /* Optional fields */
    char *ckc_data;                  /* CKC data (allocated, free with drm_license_free) */
    size_t ckc_size;
    char *session_id;                /* Session ID (allocated) */
    
    bool has_key;                    /* Whether decryption key was provided */
    bool is_persistent;              /* Whether license is persistent */
} drm_license_t;

/**
 * Request a license for content.
 * 
 * Generates a license request (REQ-021, REQ-022), sends it to the license server
 * (REQ-024 through REQ-026), and parses the response (REQ-031 through REQ-034).
 * 
 * Implements retry logic with exponential backoff (REQ-028, REQ-030).
 * 
 * @param client DRM client
 * @param request License request parameters
 * @param out_license Output: license response (must be freed with drm_license_free)
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_acquire_license(
    drm_client_t *client,
    const drm_license_request_t *request,
    drm_license_t **out_license
);

/**
 * Free a license response.
 * 
 * @param license License to free (may be NULL)
 */
void drm_license_free(drm_license_t *license);

/**
 * Renew an existing license (REQ-046).
 * 
 * @param client DRM client
 * @param session_id Session ID from original license
 * @param out_license Output: renewed license
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_renew_license(
    drm_client_t *client,
    const char *session_id,
    drm_license_t **out_license
);

/* =============================================================================
 * HLS Manifest Parsing (REQ-101 through REQ-110)
 * ============================================================================= */

/**
 * HLS Key Format
 */
typedef enum {
    DRM_HLS_KEY_NONE = 0,
    DRM_HLS_KEY_AES128 = 1,    /* METHOD=AES-128 (REQ-104) */
    DRM_HLS_KEY_SAMPLES = 2,   /* METHOD=SAMPLE-AES */
    DRM_HLS_KEY_CENC = 3       /* METHOD=CENC */
} drm_hls_key_format_t;

/**
 * HLS Key Information (extracted from EXT-X-KEY)
 */
typedef struct {
    drm_hls_key_format_t format;   /* Encryption method (REQ-104) */
    char *uri;                     /* KEYURI (REQ-103) */
    uint8_t iv[16];                /* IV from manifest (REQ-105) */
    bool has_iv;                   /* Whether IV was specified */
    char *method;                  /* METHOD string */
    char *format_strings;          /* FORMAT strings */
} drm_hls_key_t;

/**
 * HLS Segment Information
 */
typedef struct {
    char *uri;                     /* Segment URI */
    double duration;               /* Segment duration in seconds */
    uint64_t media_sequence;       /* Media sequence number */
    bool is_encrypted;             /* Whether segment is encrypted */
    drm_hls_key_t *key;            /* Associated key (if encrypted) */
} drm_hls_segment_t;

/**
 * HLS Manifest Information
 */
typedef struct {
    char *playlist_uri;            /* Original playlist URI */
    double target_duration;        /* TARGETDURATION */
    uint64_t media_sequence;       /* First media sequence number */
    bool is_vod;                   /* Whether this is VOD (ENDLIST) */
    
    /* Segment information */
    drm_hls_segment_t *segments;   /* Array of segments (allocated) */
    size_t segment_count;          /* Number of segments */
    
    /* Key information */
    drm_hls_key_t *keys;           /* Array of unique keys (allocated) */
    size_t key_count;              /* Number of unique keys */
} drm_hls_manifest_t;

/**
 * Parse an HLS manifest.
 * 
 * @param client DRM client
 * @param manifest_url URL of the HLS manifest
 * @param out_manifest Output: parsed manifest (must be freed with drm_hls_manifest_free)
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_parse_hls_manifest(
    drm_client_t *client,
    const char *manifest_url,
    drm_hls_manifest_t **out_manifest
);

/**
 * Parse HLS manifest from data.
 * 
 * @param client DRM client
 * @param manifest_data Manifest content
 * @param manifest_size Size of manifest data
 * @param base_url Base URL for resolving relative URIs (REQ-106)
 * @param out_manifest Output: parsed manifest
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_parse_hls_manifest_data(
    drm_client_t *client,
    const char *manifest_data,
    size_t manifest_size,
    const char *base_url,
    drm_hls_manifest_t **out_manifest
);

/**
 * Free an HLS manifest.
 * 
 * @param manifest Manifest to free (may be NULL)
 */
void drm_hls_manifest_free(drm_hls_manifest_t *manifest);

/* =============================================================================
 * Content Decryption Workflow
 * ============================================================================= */

/**
 * Decrypt an HLS segment.
 * 
 * High-level function that:
 * 1. Looks up the appropriate key for the segment
 * 2. Derives or uses the IV
 * 3. Decrypts the segment data
 * 
 * @param client DRM client
 * @param manifest HLS manifest containing key information
 * @param segment_index Index of segment to decrypt (0-based)
 * @param segment_data Encrypted segment data
 * @param segment_size Size of segment data
 * @param out_decrypted Output buffer for decrypted data
 * @param decrypted_size Output: size of decrypted data
 * @param max_decrypted_size Maximum output buffer size
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_decrypt_segment(
    drm_client_t *client,
    const drm_hls_manifest_t *manifest,
    size_t segment_index,
    const uint8_t *segment_data,
    size_t segment_size,
    uint8_t *out_decrypted,
    size_t *decrypted_size,
    size_t max_decrypted_size
);

/**
 * Get the required output buffer size for a segment.
 * 
 * @param segment_size Size of encrypted segment
 * @return Required output buffer size
 */
size_t drm_client_decrypt_segment_size(size_t segment_size);

/* =============================================================================
 * Key Store Integration
 * ============================================================================= */

/**
 * Get the internal key store from a client.
 * 
 * @param client DRM client
 * @return Key store handle, or NULL if not available
 */
fp_key_store_t *drm_client_get_key_store(drm_client_t *client);

/**
 * Add a key directly to the client's key store.
 * 
 * @param client DRM client
 * @param kid Key identifier
 * @param key Decryption key
 * @param expires_at Expiration timestamp
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_add_key(
    drm_client_t *client,
    const fp_kid_t *kid,
    const fp_key_t *key,
    uint64_t expires_at
);

/**
 * Get a key from the client's key store.
 * 
 * @param client DRM client
 * @param kid Key identifier
 * @param out_key Output: decryption key
 * @return DRM_OK on success, FP_ERR_KEY_NOT_FOUND otherwise
 */
fp_error_t drm_client_get_key(
    drm_client_t *client,
    const fp_kid_t *kid,
    fp_key_t *out_key
);

/* =============================================================================
 * PSSH Handling
 * ============================================================================= */

/**
 * Extract KID from PSSH data.
 * 
 * @param client DRM client
 * @param pssh_data PSSH box data
 * @param pssh_size Size of PSSH data
 * @param out_kid Output: extracted KID
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_extract_kid_from_pssh(
    drm_client_t *client,
    const uint8_t *pssh_data,
    size_t pssh_size,
    fp_kid_t *out_kid
);

/**
 * Generate PSSH from KID.
 * 
 * Creates a FairPlay PSSH box for the given KID.
 * 
 * @param client DRM client
 * @param kid Key identifier
 * @param out_pssh Output buffer for PSSH data
 * @param pssh_size Output: size of PSSH data
 * @param max_pssh_size Maximum output buffer size
 * @return DRM_OK on success, DRM_ERR_BUFFER_TOO_SMALL otherwise
 */
fp_error_t drm_client_generate_pssh(
    drm_client_t *client,
    const fp_kid_t *kid,
    uint8_t *out_pssh,
    size_t *pssh_size,
    size_t max_pssh_size
);

/* =============================================================================
 * HTTP Helpers
 * ============================================================================= */

/**
 * HTTP Response structure
 */
typedef struct {
    int status_code;               /* HTTP status code */
    char *status_text;             /* Status text (allocated) */
    
    char *body;                    /* Response body (allocated) */
    size_t body_size;              /* Size of response body */
    
    char *content_type;            /* Content-Type header (allocated) */
    char *content_length;          /* Content-Length header (allocated) */
} drm_http_response_t;

/**
 * Perform an HTTP GET request.
 * 
 * @param client DRM client
 * @param url URL to fetch
 * @param out_response Output: HTTP response
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_http_get(
    drm_client_t *client,
    const char *url,
    drm_http_response_t **out_response
);

/**
 * Perform an HTTP POST request.
 * 
 * @param client DRM client
 * @param url URL to POST to
 * @param body Request body
 * @param body_size Size of request body
 * @param content_type Content-Type header
 * @param out_response Output: HTTP response
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_http_post(
    drm_client_t *client,
    const char *url,
    const char *body,
    size_t body_size,
    const char *content_type,
    drm_http_response_t **out_response
);

/**
 * Free an HTTP response.
 * 
 * @param response Response to free (may be NULL)
 */
void drm_http_response_free(drm_http_response_t *response);

/* =============================================================================
 * URL Utilities
 * ============================================================================= */

/**
 * Resolve a relative URL against a base URL.
 * 
 * @param base_url Base URL
 * @param relative_url Relative URL
 * @param out_resolved Output buffer for resolved URL
 * @param resolved_size Output: size of resolved URL
 * @param max_resolved_size Maximum output buffer size
 * @return DRM_OK on success, DRM_ERR_BUFFER_TOO_SMALL otherwise
 */
fp_error_t drm_client_resolve_url(
    drm_client_t *client,
    const char *base_url,
    const char *relative_url,
    char *out_resolved,
    size_t *resolved_size,
    size_t max_resolved_size
);

/* =============================================================================
 * Callbacks (for async operations)
 * ============================================================================= */

/**
 * License callback function type
 */
typedef void (*drm_license_callback)(
    fp_error_t error,
    drm_license_t *license,
    void *user_data
);

/**
 * HTTP callback function type
 */
typedef void (*drm_http_callback)(
    fp_error_t error,
    drm_http_response_t *response,
    void *user_data
);

/**
 * Set license acquisition callback.
 * 
 * @param client DRM client
 * @param callback Callback function
 * @param user_data User data passed to callback
 */
void drm_client_set_license_callback(
    drm_client_t *client,
    drm_license_callback callback,
    void *user_data
);

/* =============================================================================
 * Statistics and Debugging
 * ============================================================================= */

/**
 * DRM Client Statistics
 */
typedef struct {
    uint64_t licenses_requested;    /* Total license requests */
    uint64_t licenses_success;      /* Successful license requests */
    uint64_t licenses_failed;       /* Failed license requests */
    
    uint64_t segments_decrypted;    /* Total segments decrypted */
    uint64_t bytes_decrypted;       /* Total bytes decrypted */
    
    uint64_t http_requests;         /* Total HTTP requests */
    uint64_t http_retries;          /* Total HTTP retries */
    
    uint32_t active_sessions;       /* Current active sessions */
    uint32_t keys_stored;           /* Current keys in store */
} drm_client_stats_t;

/**
 * Get client statistics.
 * 
 * @param client DRM client
 * @param stats Output: statistics structure
 */
void drm_client_get_stats(drm_client_t *client, drm_client_stats_t *stats);

/**
 * Reset client statistics.
 * 
 * @param client DRM client
 */
void drm_client_reset_stats(drm_client_t *client);

/* =============================================================================
 * Logging
 * ============================================================================= */

/**
 * Log level
 */
typedef enum {
    DRM_LOG_ERROR = 0,
    DRM_LOG_WARN = 1,
    DRM_LOG_INFO = 2,
    DRM_LOG_DEBUG = 3,
    DRM_LOG_VERBOSE = 4
} drm_log_level_t;

/**
 * Log callback function type
 */
typedef void (*drm_log_callback)(
    drm_log_level_t level,
    const char *message,
    void *user_data
);

/**
 * Set the log level.
 * 
 * @param level Log level
 */
void drm_client_set_log_level(drm_log_level_t level);

/**
 * Set the log callback.
 * 
 * @param callback Log callback function
 * @param user_data User data passed to callback
 */
void drm_client_set_log_callback(drm_log_callback callback, void *user_data);

/* =============================================================================
 * Convenience Functions
 * ============================================================================= */

/**
 * Initialize DRM client with default configuration.
 * 
 * Convenience function that creates a client with sensible defaults.
 * 
 * @param license_server_url License server URL
 * @param out_client Output: newly created client
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_client_create_default(
    const char *license_server_url,
    drm_client_t **out_client
);

/**
 * Quick decrypt function.
 * 
 * Convenience function for simple decryption scenarios.
 * 
 * @param kid Key ID
 * @param key Decryption key
 * @param iv Initialization vector
 * @param ciphertext Encrypted data
 * @param ciphertext_size Size of ciphertext
 * @param out_plaintext Output buffer
 * @param plaintext_size Output: plaintext size
 * @param max_plaintext_size Maximum output size
 * @return DRM_OK on success, error code otherwise
 */
fp_error_t drm_quick_decrypt(
    const fp_kid_t *kid,
    const fp_key_t *key,
    const fp_iv_t *iv,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext,
    size_t *plaintext_size,
    size_t max_plaintext_size
);

#ifdef __cplusplus
}
#endif

#endif /* DRM_CLIENT_H */
