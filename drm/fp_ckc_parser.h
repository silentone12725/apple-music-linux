/*
 * fp_ckc_parser.h - Content Key Container (CKC) Parser
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay CKC parsing.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 *
 * The CKC (Content Key Container) is the response from Apple's license server
 * containing the encrypted content key and lease information.
 */

#ifndef FP_CKC_PARSER_H
#define FP_CKC_PARSER_H

#include "fairplay.h"
#include <stdint.h>
#include <stddef.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * CKC Constants
 * ============================================================================= */

/** CKC header magic bytes */
#define FP_CKC_MAGIC "CKC\x01"

/** CKC format version */
#define FP_CKC_VERSION 1

/** Maximum CKC size */
#define FP_CKC_MAX_SIZE 2048

/** KID size */
#define FP_CKC_KID_SIZE 16

/** Maximum encrypted key size (RSA-2048 = 256 bytes) */
#define FP_CKC_MAX_ENCRYPTED_KEY_SIZE 256

/** Maximum session ID size */
#define FP_CKC_MAX_SESSION_ID_SIZE 128

/** Maximum renewal URL size */
#define FP_CKC_MAX_RENEWAL_URL_SIZE 512

/* =============================================================================
 * CKC Structure
 * ============================================================================= */

/**
 * Content Key Container (CKC) parsed structure.
 * 
 * Contains the decrypted content key and lease information extracted
 * from the license server response.
 */
typedef struct {
    /* Key identification */
    uint8_t kid[FP_CKC_KID_SIZE];           /**< Content key ID */
    
    /* Encrypted content key */
    uint8_t encrypted_key[FP_CKC_MAX_ENCRYPTED_KEY_SIZE];  /**< RSA-encrypted key */
    size_t encrypted_key_size;              /**< Size of encrypted key */
    
    /* Lease information */
    uint64_t expires_at;                    /**< Expiration timestamp (Unix) */
    uint32_t lease_duration;                /**< Lease duration in seconds */
    uint32_t renewal_offset;                /**< Seconds before expiry to renew */
    
    /* Session tracking */
    char session_id[FP_CKC_MAX_SESSION_ID_SIZE];     /**< Session identifier */
    char renewal_url[FP_CKC_MAX_RENEWAL_URL_SIZE];   /**< URL for lease renewal */
    
    /* Metadata */
    uint32_t format_version;                /**< CKC format version */
    uint32_t flags;                         /**< CKC flags */
    
    /* Raw data (for re-encoding if needed) */
    uint8_t *raw_data;                      /**< Raw CKC blob (allocated) */
    size_t raw_size;                        /**< Size of raw data */
} fp_ckc_t;

/* =============================================================================
 * CKC Flags
 * ============================================================================= */

typedef enum {
    FP_CKC_FLAG_NONE            = 0x0000,
    FP_CKC_FLAG_RENEWABLE       = 0x0001,  /* Lease can be renewed */
    FP_CKC_FLAG_PERSISTENT      = 0x0002,  /* Persistent key (no expiry) */
    FP_CKC_FLAG_ENCRYPTED_IV    = 0x0004   /* IV is also encrypted */
} fp_ckc_flags_t;

/* =============================================================================
 * CKC Parser Functions
 * ============================================================================= */

/**
 * Parse a Content Key Container (CKC) blob.
 * 
 * Extracts the encrypted content key, KID, and lease information
 * from the license server response.
 * 
 * @param ckc_data Raw CKC blob from license server
 * @param ckc_size Size of CKC blob
 * @param out_ckc Output: parsed CKC structure
 * @return FP_OK on success, error code otherwise
 * 
 * Errors:
 * - FP_ERR_NULL_POINTER: NULL argument
 * - FP_ERR_CKC_PARSE_FAILED: CKC format is invalid
 * - FP_ERR_OUT_OF_MEMORY: Allocation failed
 * - FP_ERR_CERTIFICATE_INVALID_FORMAT: Malformed CKC
 */
fp_error_t fp_ckc_parse(
    const uint8_t *ckc_data,
    size_t ckc_size,
    fp_ckc_t *out_ckc
);

/**
 * Free CKC resources.
 * 
 * Frees any allocated memory in the CKC structure.
 * 
 * @param ckc CKC structure to free (may be NULL)
 */
void fp_ckc_free(fp_ckc_t *ckc);

/**
 * Check if CKC lease is expired.
 * 
 * @param ckc Parsed CKC structure
 * @return true if expired, false if still valid
 */
bool fp_ckc_is_expired(const fp_ckc_t *ckc);

/**
 * Get time until CKC expiry.
 * 
 * @param ckc Parsed CKC structure
 * @return Seconds until expiry, or 0 if expired
 */
uint32_t fp_ckc_time_until_expiry(const fp_ckc_t *ckc);

/**
 * Check if CKC should be renewed.
 * 
 * Returns true if the lease should be renewed based on the renewal_offset.
 * 
 * @param ckc Parsed CKC structure
 * @return true if renewal is recommended, false otherwise
 */
bool fp_ckc_should_renew(const fp_ckc_t *ckc);

/**
 * Initialize CKC structure.
 * 
 * Sets all fields to zero/empty values.
 * 
 * @param ckc CKC structure to initialize
 */
void fp_ckc_init(fp_ckc_t *ckc);

#ifdef __cplusplus
}
#endif

#endif /* FP_CKC_PARSER_H */
