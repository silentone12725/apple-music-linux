/*
 * drm_client.h — Public API for the DRM client.
 *
 * Clean-room implementation based on DRM_CLEANROOM_SPEC.md.
 * Does not reference the proprietary wrapper/drm_lib.* implementation.
 *
 * Thread safety: All functions are safe to call from multiple threads.
 * drm_init() must complete before any other call.
 */

#pragma once

#include "drm_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ── Lifecycle Functions ────────────────────────────────────────────────────*/

/**
 * Initialize the DRM client and acquire playback license.
 *
 * This function blocks until the FairPlay lease is acquired and account
 * tokens are cached. It may take 5-30 seconds depending on network and
 * authentication status.
 *
 * @param config  Initialization configuration (must remain valid during call)
 * @return        0 on success, -1 on failure
 *
 * @note          Must be called exactly once before any other drm_* function.
 * @note          If username/password are NULL, cached credentials are used.
 * @note          State callback is called with "RUNNING" on success.
 */
int drm_init(const struct drm_config *config);

/**
 * Release all DRM resources.
 *
 * After this function returns, no further calls to drm_* functions are valid
 * until drm_init() is called again.
 *
 * @note          Cached tokens in base_directory are preserved.
 * @note          No other API calls should be made during shutdown.
 */
void drm_shutdown(void);

/* ── Account Functions ──────────────────────────────────────────────────────*/

/**
 * Retrieve cached account information.
 *
 * Returns a JSON string containing storefront_id, dev_token, and music_token.
 *
 * @return        malloc'd JSON string (caller must free), or NULL on error
 *
 * @note          Returns NULL if drm_init() was not called or failed.
 * @note          Caller is responsible for freeing the returned string.
 */
char *drm_get_account(void);

/* ── URL Retrieval Functions ────────────────────────────────────────────────*/

/**
 * Get HLS playlist URL for streaming.
 *
 * Returns the HTTPS URL for the m3u8 playlist for the given asset.
 *
 * @param asset_id  Apple Music asset ID (64-bit)
 * @return          malloc'd URL string (caller must free), or NULL on error
 *
 * @note            URL is valid until lease expires (typically 24 hours).
 * @note            Caller is responsible for freeing the returned string.
 */
char *drm_get_hls_url(drm_adam_id_t asset_id);

/**
 * Get progressive MP4 URL and download key.
 *
 * Returns the progressive download URL and optional download key for offline
 * playback. Also indicates if an itun decryptor is available.
 *
 * @param asset_id        Apple Music asset ID
 * @param out_url         Output: malloc'd URL string (caller must free)
 * @param out_download_key Output: malloc'd download key (caller must free)
 * @param out_has_decryptor Output: 1 if itun decryptor available, 0 otherwise
 * @return                0 on success, -1 on failure
 *
 * @note                  out_url and out_download_key are NULL on failure.
 * @note                  Caller is responsible for freeing output strings.
 * @note                  Call drm_get_progressive_url() before drm_decrypt_itun().
 */
int drm_get_progressive_url(
    drm_adam_id_t asset_id,
    char **out_url,
    char **out_download_key,
    int *out_has_decryptor
);

/* ── Key Delivery Functions ─────────────────────────────────────────────────*/

/**
 * Open a FairPlay key delivery context for an asset.
 *
 * Creates or retrieves a cached key context for the given asset and media URI.
 * The context is used for sample decryption.
 *
 * @param asset_id_str  Asset ID as string
 * @param media_uri     Media URI from playlist or asset info
 * @return              Key context handle (opaque), or NULL on failure
 *
 * @note                Context is cached internally; repeated calls return same handle.
 * @note                Context is valid until drm_shutdown() is called.
 * @note                Context contains AES-128 keys for CBCS decryption.
 */
drm_key_context_handle_t drm_open_key_context(
    const char *asset_id_str,
    const char *media_uri
);

/**
 * Set the AES key and IV for a key context.
 *
 * After drm_open_key_context() creates a context with zero keys, call this
 * function to set the actual FairPlay content key obtained from license fetch.
 *
 * @param key_context   Handle from drm_open_key_context()
 * @param aes_key       16-byte AES-128 key
 * @param iv            16-byte initialization vector
 * @return              0 on success, -1 on failure
 *
 * @note                Must be called before any drm_decrypt_sample() calls.
 * @note                The key and IV are copied internally; caller can free them.
 */
int drm_set_key_context_key(
    drm_key_context_handle_t key_context,
    const uint8_t *aes_key,
    const uint8_t *iv
);

/* ── Decryption Functions ───────────────────────────────────────────────────*/

/**
 * Decrypt a FairPlay-encrypted audio/video sample.
 *
 * Decrypts the sample in-place using AES-128 CBC with FairPlay-specific IV
 * derivation. The sample must be aligned to 16-byte boundary.
 *
 * @param key_context   Handle from drm_open_key_context()
 * @param sample_data   Encrypted sample (decrypted in-place)
 * @param sample_size   Sample size in bytes (must be multiple of 16)
 * @return              0 on success, -1 on failure
 *
 * @note                sample_data is modified in-place.
 * @note                sample_size is unchanged after decryption.
 * @note                Sample must be aligned to 16-byte boundary.
 */
int drm_decrypt_sample(
    drm_key_context_handle_t key_context,
    uint8_t *sample_data,
    uint32_t sample_size
);

/**
 * Decrypt a FairPlay-encrypted sample with explicit sample number.
 *
 * Same as drm_decrypt_sample() but allows specifying the sample number
 * explicitly. This is useful when the sample counter should be maintained
 * externally (e.g., per CBCS stream rather than per key context).
 *
 * @param key_context   Handle from drm_open_key_context()
 * @param sample_data   Encrypted sample (decrypted in-place)
 * @param sample_size   Sample size in bytes (must be multiple of 16)
 * @param sample_number Explicit sample number for IV derivation
 * @return              0 on success, -1 on failure
 *
 * @note                sample_data is modified in-place.
 * @note                sample_number is used for IV derivation (not incremented).
 * @note                Sample must be aligned to 16-byte boundary.
 */
int drm_decrypt_sample_at(
    drm_key_context_handle_t key_context,
    uint8_t *sample_data,
    uint32_t sample_size,
    uint64_t sample_number
);

/**
 * Decrypt a sample using the sample's first ciphertext block as the IV
 * derivation input. This matches the standalone Android wrapper's fallback
 * path, which derives a 16-byte value from the key-delivery context and the
 * first block rather than maintaining a process-global sample counter.
 */
int drm_decrypt_sample_with_sample_iv(
    drm_key_context_handle_t key_context,
    uint8_t *sample_data,
    uint32_t sample_size
);

/**
 * Decrypt an itun-encrypted progressive sample.
 *
 * Decrypts the sample using the itun decryptor created by
 * drm_get_progressive_url(). Output size may differ from input due to padding.
 *
 * @param asset_id      Must match drm_get_progressive_url() call
 * @param sample_data   Encrypted sample (decrypted in-place)
 * @param input_size    Input sample size in bytes
 * @param output_size   Output: decrypted sample size in bytes
 * @return              0 on success, -1 on failure
 *
 * @note                drm_get_progressive_url() must be called first.
 * @note                output_size may be less than input_size (padding removed).
 * @note                sample_data buffer must accommodate output_size bytes.
 */
int drm_decrypt_itun(
    drm_adam_id_t asset_id,
    uint8_t *sample_data,
    uint32_t input_size,
    uint32_t *output_size
);

/**
 * Decrypt multiple FairPlay-encrypted samples in a batch.
 *
 * Optimized version of drm_decrypt_sample() for decrypting multiple samples
 * from the same key context. Reduces lock contention and improves throughput.
 *
 * @param key_context   Handle from drm_open_key_context()
 * @param samples       Array of sample data pointers (decrypted in-place)
 * @param sample_sizes  Array of sample sizes (must all be multiples of 16)
 * @param count         Number of samples to decrypt
 * @return              0 on success, -1 on first failure (remaining samples untouched)
 *
 * @note                All samples are decrypted in-place.
 * @note                Sample sizes are unchanged after decryption.
 * @note                All samples must be aligned to 16-byte boundary.
 * @note                If decryption fails, no samples are modified.
 */
int drm_decrypt_samples_batch(
    drm_key_context_handle_t key_context,
    uint8_t **samples,
    const uint32_t *sample_sizes,
    uint32_t count
);

/* ── Status Functions ───────────────────────────────────────────────────────*/

/**
 * Check if lease recovery is currently in progress.
 *
 * @return  1 if lease recovery is in progress, 0 otherwise
 *
 * @note    Recovery is automatic; application does not need to trigger it.
 * @note    Application can display "Refreshing license..." when this returns 1.
 */
int drm_is_recovery_active(void);

/* ── Performance Helpers (for testing) ──────────────────────────────────────*/

/**
 * Get current time in seconds (for performance testing).
 *
 * @return  Current time in seconds since epoch
 */
double drm_get_time_seconds(void);

/**
 * Get current time in milliseconds (for performance testing).
 *
 * @return  Current time in milliseconds since epoch
 */
double drm_get_time_ms(void);

/* ── HTTPS / Network Functions (for Apple API communication) ────────────────*/

/**
 * Initialize HTTPS connection pool for Apple API calls.
 *
 * Sets up SSL context with certificate validation and connection pooling.
 * Must be called after drm_init().
 *
 * @param use_http2  1 to enable HTTP/2, 0 for HTTP/1.1 only
 * @return           0 on success, -1 on failure
 *
 * @note             Enables certificate pinning for Apple domains.
 * @note             Connection pool size is limited to 16 concurrent connections.
 */
int drm_https_init(int use_http2);

/**
 * Shutdown HTTPS connection pool.
 *
 * Closes all pooled connections and releases SSL resources.
 *
 * @note             Called automatically by drm_shutdown().
 */
void drm_https_shutdown(void);

/**
 * Fetch data from Apple API endpoint over HTTPS.
 *
 * @param url        HTTPS URL (e.g., https://buy.itunes.apple.com/...)
 * @param method     HTTP method (GET, POST, PUT, DELETE)
 * @param body       Request body (NULL for GET)
 * @param body_len   Request body length
 * @param out_data   Output: malloc'd response body (caller must free)
 * @param out_len    Output: response body length
 * @param out_status Output: HTTP status code
 * @return           0 on success, -1 on failure
 *
 * @note             Handles redirects automatically (max 5).
 * @note             Uses connection pooling for repeated calls.
 * @note             Implements exponential backoff retry (3 attempts).
 */
int drm_https_fetch(
    const char *url,
    const char *method,
    const uint8_t *body,
    uint32_t body_len,
    uint8_t **out_data,
    uint32_t *out_len,
    int *out_status
);

/* ── Cookie Management ──────────────────────────────────────────────────────*/

/**
 * Initialize cookie jar.
 *
 * Loads cookies from drm/files/cookies.txt if it exists.
 *
 * @return  0 on success, -1 on failure
 */
int drm_cookie_init(void);

/**
 * Shutdown cookie jar and save cookies to disk.
 */
void drm_cookie_shutdown(void);

/**
 * Get cookie header value for a URL.
 *
 * @param url     Target URL
 * @param out_buf Output buffer for "name=value; name2=value2" string
 * @param buf_size Size of out_buf
 * @return        0 on success, -1 on failure
 */
int drm_cookie_get_for_url(const char *url, char *out_buf, size_t buf_size);

/**
 * Parse and store Set-Cookie headers from response.
 *
 * @param set_cookie  Set-Cookie header value(s)
 */
void drm_cookie_parse_set_cookie(const char *set_cookie);

/* ── JWT Token Parsing ──────────────────────────────────────────────────────*/

/**
 * Parse JWT token and extract claims.
 *
 * @param token       JWT token string
 * @param out_payload Output: malloc'd JSON payload (caller must free)
 * @param out_len     Output: payload length
 * @return            0 on success, -1 on failure
 */
int drm_jwt_parse(const char *token, char **out_payload, uint32_t *out_len);

/**
 * Extract claim value from JWT payload.
 *
 * @param payload     JSON payload from drm_jwt_parse()
 * @param claim       Claim name (e.g., "sub", "email", "name")
 * @param out_value   Output: malloc'd claim value (caller must free)
 * @return            0 on success, -1 if claim not found
 */
int drm_jwt_get_claim(const char *payload, const char *claim, char **out_value);

/* ── Device GUID Management ─────────────────────────────────────────────────*/

/**
 * Get or generate device GUID.
 *
 * Loads from adi.pb if exists, otherwise generates new UUID.
 *
 * @param out_guid    Output: 36-char UUID string (with hyphens)
 * @param buf_size    Size of out_guid (must be >= 37)
 * @return            0 on success, -1 on failure
 */
int drm_device_guid_get(char *out_guid, size_t buf_size);

/**
 * Set device GUID (for initial configuration).
 *
 * @param guid        36-char UUID string (with hyphens)
 * @return            0 on success, -1 on failure
 */
int drm_device_guid_set(const char *guid);

/**
 * Check if device GUID is configured.
 *
 * @return  1 if configured, 0 if not
 */
int drm_device_guid_is_configured(void);

#ifdef __cplusplus
}
#endif
