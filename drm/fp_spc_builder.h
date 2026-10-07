/*
 * fp_spc_builder.h - Signed Public Key (SPC) Builder
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay SPC construction.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 *
 * The SPC (Signed Public Key) is a binary blob sent to Apple's license server
 * to authenticate the device and request content keys.
 */

#ifndef FP_SPC_BUILDER_H
#define FP_SPC_BUILDER_H

#include "fairplay.h"
#include "fairplay_device.h"
#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * SPC Constants
 * ============================================================================= */

/** SPC header magic bytes */
#define FP_SPC_MAGIC "FPS2"

/** SPC format version */
#define FP_SPC_VERSION 1

/** Maximum SPC size (typical: 2-4 KB) */
#define FP_SPC_MAX_SIZE 4096

/** SPC nonce size */
#define FP_SPC_NONCE_SIZE 32

/** Maximum authentication data size */
#define FP_SPC_AUTH_MAX_SIZE 512

/* =============================================================================
 * SPC Structure (Internal)
 * ============================================================================= */

/**
 * SPC binary format (simplified TLV structure):
 * 
 * Offset  Size    Field
 * ------  ----    -----
 * 0       4       Magic ("FPS2")
 * 4       2       Version
 * 6       2       Flags
 * 8       4       Total length
 * 12      4       Certificate length
 * 16      var     Certificate (PEM or DER)
 * ...     32      Nonce (random)
 * ...     4       Key request length
 * ...     var     Key request (KID + params)
 * ...     8       Timestamp
 * ...     4       Auth data length
 * ...     var     Auth data
 * ...     4       Signature length
 * ...     var     Signature (RSA-PKCS1-v1.5 with SHA-256)
 */

/** SPC flags */
typedef enum {
    FP_SPC_FLAG_NONE            = 0x0000,
    FP_SPC_FLAG_SECURE_TRANSPORT = 0x0001,  /* Use HTTPS */
    FP_SPC_FLAG_DEVICE_CERT     = 0x0002,   /* Include device certificate */
    FP_SPC_FLAG_ENCRYPTED_KEY   = 0x0004    /* Key request is encrypted */
} fp_spc_flags_t;

/* =============================================================================
 * SPC Builder Functions
 * ============================================================================= */

/**
 * Build a Signed Public Key (SPC) blob.
 * 
 * Constructs the SPC binary format with:
 * - Device certificate
 * - Random nonce
 * - Key request (KID + parameters)
 * - Timestamp
 * - Authentication data
 * - RSA signature
 * 
 * @param device_key Device key pair (must be RSA)
 * @param kid Content key ID (16 bytes)
 * @param auth_token Apple Music auth token
 * @param media_uri Media URI (HLS playlist URL)
 * @param out_spc Output: allocated SPC blob (caller must free)
 * @param out_spc_size Output: size of SPC blob
 * @return FP_OK on success, error code otherwise
 * 
 * Errors:
 * - FP_ERR_NULL_POINTER: NULL argument
 * - FP_ERR_INVALID_KEY: Device key is not RSA
 * - FP_ERR_OUT_OF_MEMORY: Allocation failed
 * - FP_ERR_CERTIFICATE_SIGNING_FAILED: Signature generation failed
 */
fp_error_t fp_spc_build(
    const fp_key_pair_t *device_key,
    const uint8_t kid[16],
    const char *auth_token,
    const char *media_uri,
    uint8_t **out_spc,
    size_t *out_spc_size
);

/**
 * Free SPC memory.
 * 
 * Securely zeros and frees the SPC blob.
 * 
 * @param spc SPC blob to free (may be NULL)
 * @param spc_size Size of SPC blob (required for secure zeroing)
 */
void fp_spc_free(uint8_t *spc, size_t spc_size);

/**
 * Verify SPC signature.
 * 
 * Verifies the RSA signature on an SPC blob using the device public key.
 * 
 * @param spc SPC blob to verify
 * @param spc_size Size of SPC blob
 * @param public_key Device public key (PEM or DER)
 * @param public_key_size Size of public key
 * @return FP_OK if signature is valid, FP_ERR_CERTIFICATE_INVALID_SIGNATURE otherwise
 */
fp_error_t fp_spc_verify(
    const uint8_t *spc,
    size_t spc_size,
    const uint8_t *public_key,
    size_t public_key_size
);

/**
 * Parse KID from skd:// URI.
 * 
 * Extracts the content key ID from a FairPlay skd:// URI.
 * 
 * URI format: skd://<server>/<path>/<kid_hex>?params
 * Example: skd://23.45.67.89:443/123456/abcdef1234567890abcdef1234567890?fmt=ftyp
 * 
 * @param_uri skd:// URI string
 * @param kid Output: 16-byte KID
 * @return FP_OK on success, FP_ERR_PSSH_PARSE_FAILED if URI is malformed
 */
fp_error_t fp_parse_skd_uri(const char *uri, uint8_t kid[16]);

/**
 * Get SPC nonce.
 * 
 * Extracts the nonce from an SPC blob.
 * 
 * @param spc SPC blob
 * @param spc_size Size of SPC blob
 * @param nonce Output: 32-byte nonce
 * @return FP_OK on success, FP_ERR_CERTIFICATE_INVALID_FORMAT if SPC is malformed
 */
fp_error_t fp_spc_get_nonce(
    const uint8_t *spc,
    size_t spc_size,
    uint8_t nonce[FP_SPC_NONCE_SIZE]
);

#ifdef __cplusplus
}
#endif

#endif /* FP_SPC_BUILDER_H */
