/*
 * fp_key_unwrapper.h - Content Key Unwrapper
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay key unwrapping.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 *
 * Unwraps the encrypted content key from the CKC using RSAES-OAEP decryption.
 */

#ifndef FP_KEY_UNWRAPPER_H
#define FP_KEY_UNWRAPPER_H

#include "fairplay.h"
#include "fairplay_device.h"
#include "fp_ckc_parser.h"
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * Key Unwrapper Functions
 * ============================================================================= */

/**
 * Unwrap content key from CKC using RSAES-OAEP.
 * 
 * Decrypts the encrypted content key from the CKC using the device's
 * RSA private key with RSAES-OAEP padding and SHA-256.
 * 
 * OpenSSL 3.0 compatible implementation using EVP_PKEY_CTX.
 * 
 * @param ckc Parsed CKC structure containing encrypted key
 * @param device_key Device key pair (must be RSA)
 * @param out_content_key Output: 16-byte AES content key
 * @return FP_OK on success, error code otherwise
 * 
 * Errors:
 * - FP_ERR_NULL_POINTER: NULL argument
 * - FP_ERR_INVALID_KEY: Device key is not RSA
 * - FP_ERR_INVALID_PRIVATE_KEY: Cannot load private key
 * - FP_ERR_KEY_UNWRAPPING_FAILED: Decryption failed
 * - FP_ERR_INVALID_KEY_SIZE: Decrypted key is not 16 bytes
 * - FP_ERR_OUT_OF_MEMORY: Allocation failed
 */
fp_error_t fp_ckc_unwrap_key(
    const fp_ckc_t *ckc,
    const fp_key_pair_t *device_key,
    uint8_t out_content_key[16]
);

/**
 * Unwrap content key directly from encrypted data.
 * 
 * Alternative API that takes raw encrypted key data instead of a CKC.
 * 
 * @param encrypted_key Encrypted content key
 * @param encrypted_key_size Size of encrypted key
 * @param device_key Device key pair (must be RSA)
 * @param out_content_key Output: 16-byte AES content key
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fp_unwrap_rsaes_oaep(
    const uint8_t *encrypted_key,
    size_t encrypted_key_size,
    const fp_key_pair_t *device_key,
    uint8_t out_content_key[16]
);

/**
 * Verify content key integrity.
 * 
 * Performs basic validation on the unwrapped content key.
 * 
 * @param content_key 16-byte content key to verify
 * @return true if key appears valid, false otherwise
 */
bool fp_verify_content_key(const uint8_t content_key[16]);

#ifdef __cplusplus
}
#endif

#endif /* FP_KEY_UNWRAPPER_H */
