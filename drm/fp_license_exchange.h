/*
 * fp_license_exchange.h - High-Level License Exchange API
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay high-level license exchange.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 *
 * Provides a simplified API for acquiring content keys from Apple's
 * FairPlay license server.
 */

#ifndef FP_LICENSE_EXCHANGE_H
#define FP_LICENSE_EXCHANGE_H

#include "fairplay.h"
#include "fairplay_device.h"
#include "fp_spc_builder.h"
#include "fp_ckc_parser.h"
#include "fp_http_client.h"
#include "fp_key_unwrapper.h"
#include <stdint.h>
#include <stddef.h>
#include <pthread.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * Key Context Structure
 * ============================================================================= */

/**
 * Content key context for sample decryption.
 * 
 * Contains the AES content key and associated metadata needed
 * for decrypting media samples.
 */
typedef struct drm_key_context {
    char *asset_id;                 /**< Asset identifier */
    char *media_uri;                /**< Media URI (HLS playlist) */
    uint8_t aes_key[16];            /**< AES-128 content key */
    uint8_t base_iv[16];            /**< Base initialization vector */
    uint64_t sample_number;         /**< Current sample number for counter mode */
    uint64_t expires_at;            /**< Key expiration timestamp */
    pthread_mutex_t lock;           /**< Thread safety lock */
    int recovery_epoch;             /**< Recovery epoch for lease tracking */
    int refcount;                   /**< Reference count */
} drm_key_context_t;

/* =============================================================================
 * License Exchange Functions
 * ============================================================================= */

/**
 * Acquire content key for media.
 * 
 * High-level API that orchestrates the complete license exchange:
 * 1. Load or generate device credentials
 * 2. Build SPC (Signed Public Key)
 * 3. Send SPC to license server via HTTP
 * 4. Parse CKC (Content Key Container) response
 * 5. Unwrap content key using RSAES-OAEP
 * 6. Create key context for sample decryption
 * 
 * @param storage_path Path to device credentials storage
 * @param media_uri Media URI (HLS playlist or skd:// URI)
 * @param auth_token Apple Music authentication token
 * @param storefront_id Storefront identifier
 * @param out_key_context Output: allocated key context (caller must free)
 * @return FP_OK on success, error code otherwise
 * 
 * Errors:
 * - FP_ERR_NULL_POINTER: NULL argument
 * - FP_ERR_DEVICE_ID_NOT_FOUND: No device credentials
 * - FP_ERR_LICENSE_REQUEST_FAILED: License server error
 * - FP_ERR_CKC_PARSE_FAILED: Invalid CKC response
 * - FP_ERR_KEY_UNWRAPPING_FAILED: Decryption failed
 */
fp_error_t fp_acquire_content_key(
    const char *storage_path,
    const char *media_uri,
    const char *auth_token,
    const char *storefront_id,
    drm_key_context_t **out_key_context
);

/**
 * Free key context resources.
 * 
 * @param ctx Key context to free (may be NULL)
 */
void fp_free_key_context(drm_key_context_t *ctx);

/**
 * Check if key context is expired.
 * 
 * @param ctx Key context to check
 * @return true if expired, false if still valid
 */
bool fp_is_key_context_expired(drm_key_context_t *ctx);

/**
 * Derive IV for sample decryption.
 * 
 * Computes the IV for a specific sample using counter mode.
 * 
 * @param ctx Key context
 * @param sample_number Sample number (0-based)
 * @param out_iv Output: 16-byte IV
 */
void fp_derive_sample_iv(
    drm_key_context_t *ctx,
    uint64_t sample_number,
    uint8_t out_iv[16]
);

/**
 * Decrypt sample using AES-CTR.
 * 
 * Decrypts a media sample using the content key and derived IV.
 * 
 * @param ctx Key context
 * @param sample_number Sample number
 * @param ciphertext Encrypted sample data
 * @param ciphertext_size Size of ciphertext
 * @param out_plaintext Output buffer (must be >= ciphertext_size)
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fp_decrypt_sample(
    drm_key_context_t *ctx,
    uint64_t sample_number,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext
);

#ifdef __cplusplus
}
#endif

#endif /* FP_LICENSE_EXCHANGE_H */
