/*
 * fairplay_device.h - FairPlay Device Certificate & ID Generation API
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay device certificate and ID generation.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/FAIRPLAY_DEVICE_CERT_SPEC.md v1.0
 *
 * This header defines the API for:
 * - Device unique identifier (device ID) generation and persistence
 * - Cryptographic key pair generation (RSA-2048, EC P-256)
 * - X.509 certificate creation (self-signed or CSR format)
 * - Certificate and key storage/retrieval
 * - Key wrapping/unwrapping for content key protection
 *
 * Compile with: gcc -std=c11 -pedantic -Wall -Wextra
 * Link with: -lssl -lcrypto -lpthread
 */

#ifndef FAIRPLAY_DEVICE_H
#define FAIRPLAY_DEVICE_H

#include "fairplay.h"
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <time.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * Error Codes
 * ============================================================================= */
/* All device-related error codes are defined in fairplay.h to avoid
 * duplicate definitions. The following are the device-specific codes:
 * 
 * FP_ERR_DEVICE_ID_GENERATION_FAILED  = -100
 * FP_ERR_DEVICE_ID_STORAGE_FAILED     = -101
 * FP_ERR_DEVICE_ID_NOT_FOUND          = -102
 * FP_ERR_DEVICE_ID_INVALID_FORMAT     = -103
 * FP_ERR_KEY_GENERATION_FAILED        = -104
 * FP_ERR_INVALID_DEVICE_KEY_SIZE      = -105
 * FP_ERR_INVALID_CURVE                = -106
 * FP_ERR_KEY_STORAGE_FAILED           = -107
 * FP_ERR_KEY_ENCRYPTION_FAILED        = -108
 * FP_ERR_KEY_DECRYPTION_FAILED        = -109
 * FP_ERR_CERTIFICATE_SIGNING_FAILED   = -110
 * FP_ERR_CERTIFICATE_STORAGE_FAILED   = -111
 * FP_ERR_CERTIFICATE_INVALID_FORMAT   = -112
 * FP_ERR_CERTIFICATE_INVALID_SIGNATURE= -113
 * FP_ERR_CERTIFICATE_EXPIRED          = -114
 * FP_ERR_CERTIFICATE_NOT_YET_VALID    = -115
 * FP_ERR_CSR_SIGNING_FAILED           = -116
 * FP_ERR_INVALID_PUBLIC_KEY           = -118
 * FP_ERR_INVALID_PRIVATE_KEY          = -119
 * FP_ERR_KEY_WRAPPING_FAILED          = -120
 * FP_ERR_KEY_UNWRAPPING_FAILED        = -121
 * FP_ERR_KEY_ENCRYPTED                = -122
 * FP_ERR_INVALID_PASSWORD             = -123
 * FP_ERR_CERTIFICATE_ENCODING_FAILED  = -124
 * FP_ERR_CREDENTIAL_RESET_FAILED      = -125
 */

/* =============================================================================
 * Constants
 * ============================================================================= */

/** Device ID size in bytes (UUID binary) */
#define FP_DEVICE_ID_SIZE 16

/** Device ID string size including null terminator (8-4-4-4-12 format) */
#define FP_DEVICE_ID_STRING_SIZE 37

/** Default RSA key size in bits */
#define FP_RSA_DEFAULT_BITS 2048

/** Minimum RSA key size in bits */
#define FP_RSA_MIN_BITS 1024

/** Maximum RSA key size in bits */
#define FP_RSA_MAX_BITS 4096

/** Default certificate validity period in years */
#define FP_CERT_DEFAULT_VALIDITY_YEARS 10

/** Default EC curve name */
#define FP_EC_DEFAULT_CURVE "prime256v1"  /* P-256 / secp256r1 */

/** Maximum certificate subject length */
#define FP_CERT_MAX_SUBJECT_LENGTH 256

/** Maximum certificate serial number length (hex) */
#define FP_CERT_MAX_SERIAL_LENGTH 32

/* =============================================================================
 * Data Types
 * ============================================================================= */

/**
 * Device ID structure
 * 
 * Represents a unique device identifier as both binary UUID and string.
 */
typedef struct {
    uint8_t bytes[FP_DEVICE_ID_SIZE];     /**< Binary UUID (16 bytes) */
    char string[FP_DEVICE_ID_STRING_SIZE]; /**< String representation (36 chars + null) */
} fp_device_id_t;

/**
 * Key pair format
 */
typedef enum {
    FP_KEY_FORMAT_PEM = 0,  /**< PEM encoded (base64 with headers) */
    FP_KEY_FORMAT_DER = 1   /**< DER encoded (raw ASN.1) */
} fp_key_format_t;

/**
 * Key pair type
 */
typedef enum {
    FP_KEY_TYPE_RSA = 0,  /**< RSA key pair */
    FP_KEY_TYPE_EC = 1    /**< Elliptic Curve key pair */
} fp_key_type_t;

/**
 * Key pair structure
 */
typedef struct {
    fp_key_type_t type;           /**< Type of key pair */
    fp_key_format_t format;       /**< Encoding format */
    
    /* Private key */
    uint8_t *private_key;         /**< Private key data (allocated) */
    size_t private_key_size;      /**< Size of private key */
    
    /* Public key */
    uint8_t *public_key;          /**< Public key data (allocated) */
    size_t public_key_size;       /**< Size of public key */
    
    /* Key metadata */
    int key_bits;                 /**< Key size in bits (RSA) or curve bits (EC) */
    char *curve_name;             /**< Curve name for EC keys (allocated, NULL for RSA) */
    
    /* Optional encryption */
    bool is_encrypted;            /**< Whether private key is encrypted */
    char *encryption_password;    /**< Password for encrypted key (allocated, may be NULL) */
} fp_key_pair_t;

/**
 * Certificate validation result
 */
typedef struct {
    bool is_valid;                /**< Overall validation result */
    bool has_valid_signature;     /**< Signature verification result */
    bool is_within_validity;      /**< Certificate is within validity period */
    bool has_expected_subject;    /**< Subject matches expected device ID */
    
    /* Certificate metadata */
    uint8_t serial_number[FP_CERT_MAX_SERIAL_LENGTH]; /**< Serial number (binary) */
    size_t serial_number_size;    /**< Size of serial number */
    
    char subject[FP_CERT_MAX_SUBJECT_LENGTH]; /**< Subject DN */
    char issuer[FP_CERT_MAX_SUBJECT_LENGTH];  /**< Issuer DN */
    
    time_t not_before;            /**< Validity start time */
    time_t not_after;             /**< Validity end time */
    
    /* Error information */
    fp_error_t error_code;        /**< Error code if validation failed */
    char error_message[256];      /**< Human-readable error message */
} fp_cert_validation_result_t;

/**
 * Certificate structure
 */
typedef struct {
    fp_key_format_t format;       /**< Encoding format */
    
    uint8_t *data;                /**< Certificate data (allocated) */
    size_t data_size;             /**< Size of certificate data */
    
    /* Parsed fields (populated after validation) */
    fp_cert_validation_result_t validation;
} fp_certificate_t;

/**
 * Certificate Signing Request structure
 */
typedef struct {
    fp_key_format_t format;       /**< Encoding format */
    
    uint8_t *data;                /**< CSR data (allocated) */
    size_t data_size;             /**< Size of CSR data */
    
    char subject[FP_CERT_MAX_SUBJECT_LENGTH]; /**< Subject DN */
} fp_csr_t;

/**
 * Device credentials bundle
 * 
 * Contains all device credentials in one structure.
 */
typedef struct {
    fp_device_id_t device_id;     /**< Device identifier */
    fp_key_pair_t *key_pair;      /**< Key pair (allocated, may be NULL) */
    fp_certificate_t *certificate; /**< Certificate (allocated, may be NULL) */
} fp_credentials_t;

/**
 * Device context
 * 
 * Main context for device certificate operations.
 */
typedef struct fp_device_context fp_device_context_t;

/* =============================================================================
 * Device ID Functions (REQ-001, REQ-002, REQ-003)
 * ============================================================================= */

/**
 * Generate a new device ID (REQ-001).
 * 
 * Creates a cryptographically random UUID v4.
 * 
 * @param ctx Device context (may be NULL for standalone operation)
 * @param out_id Output: generated device ID
 * @return FP_OK on success, FP_ERR_DEVICE_ID_GENERATION_FAILED otherwise
 */
fp_error_t fairplay_device_id_generate(fp_device_context_t *ctx, fp_device_id_t *out_id);

/**
 * Generate and persist a new device ID.
 * 
 * Creates a new device ID and saves it to the specified storage path.
 * 
 * @param storage_path Directory path for credential storage
 * @param out_id Output: generated device ID
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_device_id_ensure(
    const char *storage_path,
    fp_device_id_t *out_id
);

/**
 * Load device ID from persistent storage (REQ-003).
 * 
 * @param storage_path Directory path for credential storage
 * @param out_id Output: loaded device ID
 * @return FP_OK on success, FP_ERR_DEVICE_ID_NOT_FOUND if not exists,
 *         FP_ERR_DEVICE_ID_INVALID_FORMAT if malformed
 */
fp_error_t fairplay_device_id_load(
    const char *storage_path,
    fp_device_id_t *out_id
);

/**
 * Save device ID to persistent storage (REQ-002).
 * 
 * @param storage_path Directory path for credential storage
 * @param device_id Device ID to save
 * @return FP_OK on success, FP_ERR_DEVICE_ID_STORAGE_FAILED otherwise
 */
fp_error_t fairplay_device_id_save(
    const char *storage_path,
    const fp_device_id_t *device_id
);

/**
 * Format device ID as hex string.
 * 
 * @param device_id Device ID to format
 * @param out Output buffer for hex string
 * @param out_size Size of output buffer
 * @return FP_OK on success, FP_ERR_BUFFER_TOO_SMALL otherwise
 */
fp_error_t fairplay_device_id_to_hex(
    const fp_device_id_t *device_id,
    char *out,
    size_t out_size
);

/**
 * Parse device ID from hex string.
 * 
 * @param hex_string Hex string (32 or 36 characters, with or without dashes)
 * @param out_id Output: parsed device ID
 * @return FP_OK on success, FP_ERR_DEVICE_ID_INVALID_FORMAT otherwise
 */
fp_error_t fairplay_device_id_from_hex(
    const char *hex_string,
    fp_device_id_t *out_id
);

/* =============================================================================
 * Key Pair Functions (REQ-004, REQ-005)
 * ============================================================================= */

/**
 * Generate RSA key pair (REQ-004).
 * 
 * @param ctx Device context
 * @param key_bits Key size in bits (default: FP_RSA_DEFAULT_BITS)
 * @param format Output format (PEM or DER)
 * @param out_key_pair Output: generated key pair
 * @return FP_OK on success, FP_ERR_KEY_GENERATION_FAILED otherwise
 */
fp_error_t fairplay_keypair_generate_rsa(
    fp_device_context_t *ctx,
    int key_bits,
    fp_key_format_t format,
    fp_key_pair_t **out_key_pair
);

/**
 * Generate EC key pair (REQ-005).
 * 
 * @param ctx Device context
 * @param curve_name Curve name (e.g., "prime256v1" for P-256)
 * @param format Output format (PEM or DER)
 * @param out_key_pair Output: generated key pair
 * @return FP_OK on success, FP_ERR_KEY_GENERATION_FAILED otherwise
 */
fp_error_t fairplay_keypair_generate_ec(
    fp_device_context_t *ctx,
    const char *curve_name,
    fp_key_format_t format,
    fp_key_pair_t **out_key_pair
);

/**
 * Load key pair from memory.
 * 
 * @param private_key Private key data
 * @param private_key_size Size of private key
 * @param public_key Public key data (may be NULL, will be extracted)
 * @param public_key_size Size of public key (may be NULL)
 * @param format Key format (PEM or DER)
 * @param out_key_pair Output: loaded key pair
 * @return FP_OK on success, FP_ERR_INVALID_KEY otherwise
 */
fp_error_t fairplay_keypair_load(
    const uint8_t *private_key,
    size_t private_key_size,
    const uint8_t *public_key,
    size_t public_key_size,
    fp_key_format_t format,
    fp_key_pair_t **out_key_pair
);

/**
 * Save key pair to persistent storage (REQ-008).
 * 
 * @param storage_path Directory path for credential storage
 * @param key_pair Key pair to save
 * @param encrypt_private Whether to encrypt private key
 * @param encryption_password Password for encryption (may be NULL)
 * @return FP_OK on success, FP_ERR_KEY_STORAGE_FAILED otherwise
 */
fp_error_t fairplay_keypair_save(
    const char *storage_path,
    const fp_key_pair_t *key_pair,
    bool encrypt_private,
    const char *encryption_password
);

/**
 * Load key pair from persistent storage.
 * 
 * @param storage_path Directory path for credential storage
 * @param encryption_password Password for encrypted key (may be NULL)
 * @param out_key_pair Output: loaded key pair
 * @return FP_OK on success, FP_ERR_KEY_NOT_FOUND if not exists,
 *         FP_ERR_INVALID_KEY if malformed, FP_ERR_KEY_ENCRYPTED if password needed
 */
fp_error_t fairplay_keypair_load_from_storage(
    const char *storage_path,
    const char *encryption_password,
    fp_key_pair_t **out_key_pair
);

/**
 * Free a key pair structure.
 * 
 * @param key_pair Key pair to free (may be NULL)
 */
void fairplay_keypair_free(fp_key_pair_t *key_pair);

/**
 * Get key pair type.
 * 
 * @param key_pair Key pair
 * @return Key type (RSA or EC)
 */
fp_key_type_t fairplay_keypair_get_type(const fp_key_pair_t *key_pair);

/**
 * Get key size in bits.
 * 
 * @param key_pair Key pair
 * @return Key size in bits
 */
int fairplay_keypair_get_bits(const fp_key_pair_t *key_pair);

/* =============================================================================
 * Certificate Functions (REQ-006, REQ-007, REQ-009, REQ-012)
 * ============================================================================= */

/**
 * Create self-signed certificate (REQ-006).
 * 
 * @param ctx Device context
 * @param key_pair Key pair for certificate
 * @param device_id Device ID to include in subject
 * @param validity_years Certificate validity period in years
 * @param format Output format (PEM or DER)
 * @param out_certificate Output: created certificate
 * @return FP_OK on success, FP_ERR_CERTIFICATE_SIGNING_FAILED otherwise
 */
fp_error_t fairplay_cert_create_self_signed(
    fp_device_context_t *ctx,
    const fp_key_pair_t *key_pair,
    const fp_device_id_t *device_id,
    int validity_years,
    fp_key_format_t format,
    fp_certificate_t **out_certificate
);

/**
 * Create Certificate Signing Request (REQ-007).
 * 
 * @param ctx Device context
 * @param key_pair Key pair for CSR
 * @param device_id Device ID to include in subject
 * @param format Output format (PEM or DER)
 * @param out_csr Output: created CSR
 * @return FP_OK on success, FP_ERR_CSR_SIGNING_FAILED otherwise
 */
fp_error_t fairplay_cert_create_csr(
    fp_device_context_t *ctx,
    const fp_key_pair_t *key_pair,
    const fp_device_id_t *device_id,
    fp_key_format_t format,
    fp_csr_t **out_csr
);

/**
 * Load certificate from memory.
 * 
 * @param data Certificate data
 * @param data_size Size of certificate data
 * @param format Certificate format (PEM or DER)
 * @param out_certificate Output: loaded certificate
 * @return FP_OK on success, FP_ERR_CERTIFICATE_INVALID_FORMAT otherwise
 */
fp_error_t fairplay_cert_load(
    const uint8_t *data,
    size_t data_size,
    fp_key_format_t format,
    fp_certificate_t **out_certificate
);

/**
 * Save certificate to persistent storage (REQ-009).
 * 
 * @param storage_path Directory path for credential storage
 * @param certificate Certificate to save
 * @return FP_OK on success, FP_ERR_CERTIFICATE_STORAGE_FAILED otherwise
 */
fp_error_t fairplay_cert_save(
    const char *storage_path,
    const fp_certificate_t *certificate
);

/**
 * Load certificate from persistent storage.
 * 
 * @param storage_path Directory path for credential storage
 * @param out_certificate Output: loaded certificate
 * @return FP_OK on success, FP_ERR_KEY_NOT_FOUND if not exists
 */
fp_error_t fairplay_cert_load_from_storage(
    const char *storage_path,
    fp_certificate_t **out_certificate
);

/**
 * Validate certificate (REQ-012).
 * 
 * @param certificate Certificate to validate
 * @param expected_device_id Expected device ID in subject (may be NULL)
 * @param out_result Output: validation result
 * @return FP_OK if validation completed, error code otherwise
 */
fp_error_t fairplay_cert_validate(
    const fp_certificate_t *certificate,
    const fp_device_id_t *expected_device_id,
    fp_cert_validation_result_t *out_result
);

/**
 * Free a certificate structure.
 * 
 * @param certificate Certificate to free (may be NULL)
 */
void fairplay_cert_free(fp_certificate_t *certificate);

/**
 * Free a CSR structure.
 * 
 * @param csr CSR to free (may be NULL)
 */
void fairplay_csr_free(fp_csr_t *csr);

/* =============================================================================
 * Key Wrapping Functions (REQ-010, REQ-011)
 * ============================================================================= */

/**
 * Wrap content key with device public key (REQ-010).
 * 
 * Encrypts a content key using the device public key.
 * For RSA: Uses RSAES-OAEP with SHA-256.
 * For EC: Uses ECIES.
 * 
 * @param content_key Content key to wrap
 * @param content_key_size Size of content key
 * @param public_key Public key data
 * @param public_key_size Size of public key
 * @param key_type Type of public key (RSA or EC)
 * @param out_wrapped_key Output: wrapped key
 * @param wrapped_key_size Output: size of wrapped key
 * @return FP_OK on success, FP_ERR_KEY_WRAPPING_FAILED otherwise
 */
fp_error_t fairplay_key_wrap(
    const uint8_t *content_key,
    size_t content_key_size,
    const uint8_t *public_key,
    size_t public_key_size,
    fp_key_type_t key_type,
    uint8_t **out_wrapped_key,
    size_t *wrapped_key_size
);

/**
 * Unwrap content key with device private key (REQ-011).
 * 
 * Decrypts a wrapped content key using the device private key.
 * 
 * @param wrapped_key Wrapped key to unwrap
 * @param wrapped_key_size Size of wrapped key
 * @param private_key Private key data
 * @param private_key_size Size of private key
 * @param password Password for encrypted private key (may be NULL)
 * @param key_type Type of private key (RSA or EC)
 * @param out_content_key Output: unwrapped content key
 * @param content_key_size Output: size of content key
 * @return FP_OK on success, FP_ERR_KEY_UNWRAPPING_FAILED otherwise
 */
fp_error_t fairplay_key_unwrap(
    const uint8_t *wrapped_key,
    size_t wrapped_key_size,
    const uint8_t *private_key,
    size_t private_key_size,
    const char *password,
    fp_key_type_t key_type,
    uint8_t **out_content_key,
    size_t *content_key_size
);

/* =============================================================================
 * Credential Management (REQ-014)
 * ============================================================================= */

/**
 * Ensure all device credentials exist (REQ-014 helper).
 * 
 * Checks for existing credentials and generates new ones if needed.
 * This is a convenience function that orchestrates the full credential setup.
 * 
 * @param storage_path Directory path for credential storage
 * @param ctx Device context
 * @param key_type Desired key type (RSA or EC)
 * @param encryption_password Password for key encryption (may be NULL)
 * @param out_credentials Output: credentials bundle
 * @param generated_new Output: true if new credentials were generated
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_credentials_ensure(
    const char *storage_path,
    fp_device_context_t *ctx,
    fp_key_type_t key_type,
    const char *encryption_password,
    fp_credentials_t **out_credentials,
    bool *generated_new
);

/**
 * Load all device credentials from storage.
 * 
 * @param storage_path Directory path for credential storage
 * @param encryption_password Password for encrypted key (may be NULL)
 * @param out_credentials Output: credentials bundle
 * @return FP_OK on success, FP_ERR_DEVICE_ID_NOT_FOUND if incomplete
 */
fp_error_t fairplay_credentials_load(
    const char *storage_path,
    const char *encryption_password,
    fp_credentials_t **out_credentials
);

/**
 * Reset device credentials (REQ-014).
 * 
 * Removes all device credentials from storage.
 * 
 * @param storage_path Directory path for credential storage
 * @return FP_OK on success, FP_ERR_CREDENTIAL_RESET_FAILED otherwise
 */
fp_error_t fairplay_credentials_reset(const char *storage_path);

/**
 * Free credentials bundle.
 * 
 * @param credentials Credentials bundle to free (may be NULL)
 */
void fairplay_credentials_free(fp_credentials_t *credentials);

/* =============================================================================
 * Device Context Management
 * ============================================================================= */

/**
 * Create device context.
 * 
 * @param out_ctx Output: newly created context
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_device_context_create(fp_device_context_t **out_ctx);

/**
 * Destroy device context.
 * 
 * @param ctx Context to destroy (may be NULL)
 */
void fairplay_device_context_destroy(fp_device_context_t *ctx);

/**
 * Get human-readable error string for device errors.
 * 
 * @param error Error code
 * @return Static string describing the error
 */
const char *fairplay_device_error_string(fp_error_t error);

/* =============================================================================
 * Convenience Functions
 * ============================================================================= */

/**
 * Quick device ID generation.
 * 
 * Convenience function for simple device ID generation without context.
 * 
 * @param out_id Output: generated device ID
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_quick_device_id(fp_device_id_t *out_id);

/**
 * Quick credentials generation.
 * 
 * Convenience function for generating all credentials in memory.
 * 
 * @param out_credentials Output: credentials bundle
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_quick_credentials(fp_credentials_t **out_credentials);

#ifdef __cplusplus
}
#endif

#endif /* FAIRPLAY_DEVICE_H */
