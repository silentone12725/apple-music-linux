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

#ifdef __cplusplus
}
#endif
