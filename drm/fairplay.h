/*
 * fairplay.h - FairPlay DRM Core API
 * 
 * Version: 2.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay DRM for Linux.
 * Independently authored by AML DRM Team.
 *
 * This header defines the public API for the FairPlay DRM core module.
 * It provides functions for PSSH parsing, key management, and AES-128 CBC decryption.
 *
 * Compile with: gcc -std=c11 -pedantic -Wall -Wextra
 * Link with: -lssl -lcrypto -lpthread
 */

#ifndef FAIRPLAY_H
#define FAIRPLAY_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/* =============================================================================
 * Version Information (REQ-009)
 * ============================================================================= */

#define FAIRPLAY_VERSION_MAJOR  2
#define FAIRPLAY_VERSION_MINOR  0
#define FAIRPLAY_VERSION_PATCH  0
#define FAIRPLAY_VERSION_STRING "2.0.0"

/**
 * Get the FairPlay library version string.
 * 
 * @return Static string containing version (e.g., "2.0.0")
 */
const char *fairplay_version(void);

/**
 * Get the FairPlay library version as components.
 * 
 * @param major Output: major version number
 * @param minor Output: minor version number  
 * @param patch Output: patch version number
 */
void fairplay_version_components(int *major, int *minor, int *patch);

/* =============================================================================
 * Error Codes (REQ-069, REQ-074)
 * ============================================================================= */

typedef enum {
    FP_OK                          =  0,   /**< Success */
    
    /* Initialization errors (REQ-004) */
    FP_ERR_INIT_FAILED             = -1,   /**< Initialization failed */
    FP_ERR_INVALID_CONFIG          = -2,   /**< Invalid configuration */
    FP_ERR_NULL_POINTER            = -3,   /**< NULL pointer argument */
    FP_ERR_OUT_OF_MEMORY           = -4,   /**< Memory allocation failed */
    
    /* Parsing errors */
    FP_ERR_PSSH_PARSE_FAILED       = -5,   /**< PSSH parsing failed */
    FP_ERR_INVALID_SYSTEM_ID       = -6,   /**< Invalid FairPlay system ID */
    FP_ERR_INVALID_JSON            = -7,   /**< JSON parsing failed */
    FP_ERR_INVALID_BASE64          = -8,   /**< Base64 decoding failed */
    
    /* License errors */
    FP_ERR_LICENSE_REQUEST_FAILED  = -9,   /**< License request failed */
    FP_ERR_LICENSE_PARSE_FAILED    = -10,  /**< License parsing failed */
    FP_ERR_CKC_PARSE_FAILED        = -11,  /**< CKC parsing failed */
    
    /* Key errors */
    FP_ERR_KEY_NOT_FOUND           = -12,  /**< Key not found */
    FP_ERR_KEY_EXPIRED             = -13,  /**< Key has expired */
    FP_ERR_KEY_INVALID             = -14,  /**< Key format invalid */
    
    /* Decryption errors */
    FP_ERR_DECRYPTION_FAILED       = -15,  /**< Decryption operation failed */
    FP_ERR_INVALID_IV              = -16,  /**< Invalid initialization vector */
    FP_ERR_INVALID_KEY_SIZE        = -17,  /**< Key size not 16 bytes */
    FP_ERR_BUFFER_TOO_SMALL        = -18,  /**< Output buffer too small */
    
    /* Session errors */
    FP_ERR_SESSION_NOT_FOUND       = -19,  /**< Session not found */
    FP_ERR_SESSION_EXPIRED         = -20,  /**< Session has expired */
    FP_ERR_SESSION_INVALID_STATE   = -21,  /**< Invalid session state */
    
    /* Network errors */
    FP_ERR_NETWORK_TIMEOUT         = -22,  /**< Network operation timed out */
    FP_ERR_HTTP_ERROR              = -23,  /**< HTTP error response */
    FP_ERR_TLS_ERROR               = -24,  /**< TLS/SSL error */
    
    /* Thread errors */
    FP_ERR_THREAD_INIT_FAILED      = -25,  /**< Thread initialization failed */
    FP_ERR_LOCK_FAILED             = -26,  /**< Lock acquisition failed */
    
    /* Device certificate errors (from fairplay_device.h) */
    FP_ERR_DEVICE_ID_GENERATION_FAILED  = -100, /**< Device ID generation failed */
    FP_ERR_DEVICE_ID_STORAGE_FAILED     = -101, /**< Device ID storage failed */
    FP_ERR_DEVICE_ID_NOT_FOUND          = -102, /**< Device ID not found */
    FP_ERR_DEVICE_ID_INVALID_FORMAT     = -103, /**< Device ID invalid format */
    FP_ERR_KEY_GENERATION_FAILED        = -104, /**< Key generation failed */
    FP_ERR_INVALID_DEVICE_KEY_SIZE      = -105, /**< Invalid device key size */
    FP_ERR_INVALID_CURVE                = -106, /**< EC curve not supported */
    FP_ERR_KEY_STORAGE_FAILED           = -107, /**< Key storage failed */
    FP_ERR_KEY_ENCRYPTION_FAILED        = -108, /**< Key encryption failed */
    FP_ERR_KEY_DECRYPTION_FAILED        = -109, /**< Key decryption failed */
    FP_ERR_CERTIFICATE_SIGNING_FAILED   = -110, /**< Certificate signing failed */
    FP_ERR_CERTIFICATE_STORAGE_FAILED   = -111, /**< Certificate storage failed */
    FP_ERR_CERTIFICATE_INVALID_FORMAT   = -112, /**< Certificate invalid format */
    FP_ERR_CERTIFICATE_INVALID_SIGNATURE= -113, /**< Certificate invalid signature */
    FP_ERR_CERTIFICATE_EXPIRED          = -114, /**< Certificate expired */
    FP_ERR_CERTIFICATE_NOT_YET_VALID    = -115, /**< Certificate not yet valid */
    FP_ERR_CSR_SIGNING_FAILED           = -116, /**< CSR signing failed */
    FP_ERR_INVALID_PUBLIC_KEY           = -118, /**< Public key malformed */
    FP_ERR_INVALID_PRIVATE_KEY          = -119, /**< Private key malformed */
    FP_ERR_KEY_WRAPPING_FAILED          = -120, /**< Key wrapping failed */
    FP_ERR_KEY_UNWRAPPING_FAILED        = -121, /**< Key unwrapping failed */
    FP_ERR_KEY_ENCRYPTED                = -122, /**< Key encrypted, no password */
    FP_ERR_INVALID_PASSWORD             = -123, /**< Invalid password */
    FP_ERR_CERTIFICATE_ENCODING_FAILED  = -124, /**< Certificate encoding failed */
    FP_ERR_CREDENTIAL_RESET_FAILED      = -125, /**< Credential reset failed */
    FP_ERR_DEVICE_NOT_INITIALIZED       = -126, /**< Device module not initialized */
    FP_ERR_DEVICE_ALREADY_INITIALIZED   = -127, /**< Device module already initialized */
    FP_ERR_INVALID_KEY                  = -117, /**< Key is malformed or unusable */
    
    /* Generic error */
    FP_ERR_UNKNOWN                 = -99   /**< Unknown error */
} fp_error_t;

/**
 * Get human-readable error message (REQ-070).
 * 
 * @param error Error code
 * @return Static string describing the error
 */
const char *fairplay_error_string(fp_error_t error);

/* =============================================================================
 * Constants
 * ============================================================================= */

/** FairPlay System ID (UUID) - REQ-012 */
#define FAIRPLAY_SYSTEM_ID "99999999-9999-9999-9999-999999999999"

/** Key ID size in bytes - REQ-014, REQ-019 */
#define FP_KID_SIZE 16

/** Key size in bytes (AES-128) - REQ-035, REQ-051 */
#define FP_KEY_SIZE 16

/** IV size in bytes (AES-128 CBC) - REQ-053 */
#define FP_IV_SIZE 16

/** AES block size in bytes */
#define FP_AES_BLOCK_SIZE 16

/** Maximum number of keys in key store */
#define FP_MAX_KEYS 256

/** Maximum session ID */
#define FP_MAX_SESSIONS 64

/* =============================================================================
 * Data Types
 * ============================================================================= */

/**
 * Key Identifier (KID) - REQ-014, REQ-019
 * 
 * A 16-byte identifier for a decryption key.
 */
typedef struct {
    uint8_t bytes[FP_KID_SIZE];
} fp_kid_t;

/**
 * Decryption Key - REQ-035
 * 
 * A 16-byte AES-128 decryption key.
 */
typedef struct {
    uint8_t bytes[FP_KEY_SIZE];
} fp_key_t;

/**
 * Initialization Vector - REQ-053
 * 
 * A 16-byte IV for AES-128 CBC mode.
 */
typedef struct {
    uint8_t bytes[FP_IV_SIZE];
} fp_iv_t;

/**
 * Complete Key with metadata - REQ-044
 * 
 * Associates a key with its KID and expiration.
 */
typedef struct {
    fp_kid_t  kid;           /**< Key identifier */
    fp_key_t  key;           /**< Decryption key */
    uint64_t  expires_at;    /**< Expiration timestamp (Unix epoch seconds) */
    bool      is_persistent; /**< Whether key persists across sessions */
} fp_complete_key_t;

/**
 * PSSH Box Data - REQ-011
 * 
 * Protection System Specific Header structure.
 */
typedef struct {
    uint8_t system_id[16];   /**< Key system UUID (binary) */
    uint8_t kid_count;       /**< Number of KIDs */
    fp_kid_t *kids;          /**< Array of KIDs (allocated) */
    uint32_t data_size;      /**< Size of additional data */
    uint8_t *data;           /**< Additional PSSH data (allocated) */
} fp_pssh_t;

/**
 * Decryption Session - REQ-061, REQ-062
 * 
 * Represents an active decryption session.
 */
typedef struct fp_session fp_session_t;

/**
 * Key Store - REQ-041
 * 
 * Internal key storage (opaque type).
 */
typedef struct fp_key_store fp_key_store_t;

/**
 * Context - Main FairPlay context (REQ-001, REQ-003)
 * 
 * The main context for FairPlay operations.
 */
typedef struct fp_context fp_context_t;

/* =============================================================================
 * Context Management (REQ-001 through REQ-010)
 * ============================================================================= */

/**
 * Initialize the FairPlay library.
 * 
 * Must be called before any other FairPlay functions.
 * Thread-safe (REQ-006).
 * 
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_init(void);

/**
 * Shutdown the FairPlay library.
 * 
 * Releases all global resources. Safe to call multiple times (REQ-008).
 * 
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_shutdown(void);

/**
 * Create a new FairPlay context.
 * 
 * @param out_context Output: newly created context
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_context_create(fp_context_t **out_context);

/**
 * Destroy a FairPlay context.
 * 
 * Idempotent - safe to call with NULL or already-destroyed context (REQ-008).
 * 
 * @param context Context to destroy (may be NULL)
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_context_destroy(fp_context_t *context);

/* =============================================================================
 * Feature Detection (REQ-010)
 * ============================================================================= */

/**
 * Check if AES-NI hardware acceleration is available.
 * 
 * @return true if AES-NI is available, false otherwise
 */
bool fairplay_has_aesni(void);

/**
 * Check if the library was built with OpenSSL support.
 * 
 * @return true if OpenSSL support is available
 */
bool fairplay_has_openssl(void);

/* =============================================================================
 * PSSH Parsing (REQ-011 through REQ-020)
 * ============================================================================= */

/**
 * Parse a PSSH box.
 * 
 * Parses the MP4 PSSH box format (ISO/IEC 14496-12).
 * Validates the system ID and extracts KIDs (REQ-011, REQ-012, REQ-013).
 * 
 * @param context FairPlay context
 * @param data PSSH box data (including size field)
 * @param size Size of PSSH data
 * @param out_pssh Output: parsed PSSH structure (must be freed with fairplay_pssh_free)
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_pssh_parse(
    fp_context_t *context,
    const uint8_t *data,
    size_t size,
    fp_pssh_t **out_pssh
);

/**
 * Free a parsed PSSH structure.
 * 
 * @param pssh PSSH structure to free (may be NULL)
 */
void fairplay_pssh_free(fp_pssh_t *pssh);

/**
 * Check if a PSSH uses the FairPlay system ID (REQ-012).
 * 
 * @param pssh PSSH structure to check
 * @return true if FairPlay system ID, false otherwise
 */
bool fairplay_pssh_is_fairplay(const fp_pssh_t *pssh);

/**
 * Get the primary KID from a PSSH (REQ-013).
 * 
 * @param pssh PSSH structure
 * @param out_kid Output: primary KID
 * @return FP_OK if KID found, FP_ERR_KEY_NOT_FOUND otherwise
 */
fp_error_t fairplay_pssh_get_primary_kid(const fp_pssh_t *pssh, fp_kid_t *out_kid);

/**
 * Get KID at index from PSSH (REQ-017).
 * 
 * @param pssh PSSH structure
 * @param index KID index (0-based)
 * @param out_kid Output: KID at index
 * @return FP_OK on success, FP_ERR_NULL_POINTER if index out of range
 */
fp_error_t fairplay_pssh_get_kid_at(const fp_pssh_t *pssh, size_t index, fp_kid_t *out_kid);

/**
 * Get the number of KIDs in a PSSH.
 * 
 * @param pssh PSSH structure
 * @return Number of KIDs
 */
size_t fairplay_pssh_kid_count(const fp_pssh_t *pssh);

/**
 * Compare two KIDs (REQ-020).
 * 
 * @param kid1 First KID
 * @param kid2 Second KID
 * @return 0 if equal, non-zero otherwise
 */
int fairplay_kid_compare(const fp_kid_t *kid1, const fp_kid_t *kid2);

/**
 * Copy a KID.
 * 
 * @param dest Destination KID
 * @param src Source KID
 */
void fairplay_kid_copy(fp_kid_t *dest, const fp_kid_t *src);

/**
 * Set KID from bytes.
 * 
 * @param kid Output: KID to set
 * @param bytes 16-byte array
 */
void fairplay_kid_set_bytes(fp_kid_t *kid, const uint8_t bytes[FP_KID_SIZE]);

/**
 * Format KID as hex string.
 * 
 * @param kid KID to format
 * @param out Buffer for hex string (must be at least 33 bytes)
 * @param out_size Size of output buffer
 * @return FP_OK on success, FP_ERR_BUFFER_TOO_SMALL otherwise
 */
fp_error_t fairplay_kid_to_hex(const fp_kid_t *kid, char *out, size_t out_size);

/* =============================================================================
 * Key Management (REQ-041 through REQ-050)
 * ============================================================================= */

/**
 * Create a key store (REQ-041).
 * 
 * @param context FairPlay context
 * @param out_store Output: newly created key store
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_key_store_create(fp_context_t *context, fp_key_store_t **out_store);

/**
 * Destroy a key store.
 * 
 * Clears all keys from memory (REQ-049).
 * 
 * @param store Key store to destroy (may be NULL)
 */
void fairplay_key_store_destroy(fp_key_store_t *store);

/**
 * Add a key to the key store (REQ-042).
 * 
 * @param store Key store
 * @param kid Key identifier
 * @param key Decryption key
 * @param expires_at Expiration timestamp (0 for no expiration)
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_key_store_add(
    fp_key_store_t *store,
    const fp_kid_t *kid,
    const fp_key_t *key,
    uint64_t expires_at
);

/**
 * Look up a key by KID (REQ-043).
 * 
 * @param store Key store
 * @param kid Key identifier to look up
 * @param out_key Output: decryption key
 * @return FP_OK on success, FP_ERR_KEY_NOT_FOUND otherwise
 */
fp_error_t fairplay_key_store_get(
    const fp_key_store_t *store,
    const fp_kid_t *kid,
    fp_key_t *out_key
);

/**
 * Check if a key exists in the store.
 * 
 * @param store Key store
 * @param kid Key identifier to check
 * @return true if key exists, false otherwise
 */
bool fairplay_key_store_has(const fp_key_store_t *store, const fp_kid_t *kid);

/**
 * Remove a key from the store.
 * 
 * @param store Key store
 * @param kid Key identifier to remove
 * @return FP_OK on success, FP_ERR_KEY_NOT_FOUND if not present
 */
fp_error_t fairplay_key_store_remove(fp_key_store_t *store, const fp_kid_t *kid);

/**
 * Clear all keys from the store (REQ-049).
 * 
 * @param store Key store
 */
void fairplay_key_store_clear(fp_key_store_t *store);

/**
 * Check if a key has expired (REQ-045).
 * 
 * @param store Key store
 * @param kid Key identifier to check
 * @return true if key exists and is expired, false otherwise
 */
bool fairplay_key_store_is_expired(const fp_key_store_t *store, const fp_kid_t *kid);

/**
 * Get the number of keys in the store.
 * 
 * @param store Key store
 * @return Number of keys
 */
size_t fairplay_key_store_count(const fp_key_store_t *store);

/* =============================================================================
 * Decryption (REQ-051 through REQ-060)
 * ============================================================================= */

/**
 * Decrypt data using AES-128 CBC (REQ-051, REQ-054).
 * 
 * @param key Decryption key (16 bytes)
 * @param iv Initialization vector (16 bytes)
 * @param ciphertext Encrypted data
 * @param ciphertext_size Size of ciphertext
 * @param out_plaintext Output buffer for decrypted data
 * @param plaintext_size Output: actual size of plaintext
 * @param max_plaintext_size Maximum size of output buffer
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_decrypt_aes128_cbc(
    const fp_key_t *key,
    const fp_iv_t *iv,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext,
    size_t *plaintext_size,
    size_t max_plaintext_size
);

/**
 * Get required output buffer size for decryption.
 * 
 * For AES-CBC, output size equals input size.
 * 
 * @param ciphertext_size Size of ciphertext
 * @return Required output buffer size
 */
size_t fairplay_decrypt_required_size(size_t ciphertext_size);

/**
 * Create IV from segment number (for streaming).
 * 
 * Generates an IV based on segment number for HLS streaming.
 * This is one common method; others may use explicit IV from manifest.
 * 
 * @param out_iv Output: generated IV
 * @param segment_number HLS segment number
 */
void fairplay_iv_from_segment(fp_iv_t *out_iv, uint64_t segment_number);

/**
 * Set IV from bytes (REQ-052).
 * 
 * @param iv Output: IV to set
 * @param bytes 16-byte array
 */
void fairplay_iv_set_bytes(fp_iv_t *iv, const uint8_t bytes[FP_IV_SIZE]);

/**
 * Format IV as hex string.
 * 
 * @param iv IV to format
 * @param out Buffer for hex string (must be at least 33 bytes)
 * @param out_size Size of output buffer
 * @return FP_OK on success, FP_ERR_BUFFER_TOO_SMALL otherwise
 */
fp_error_t fairplay_iv_to_hex(const fp_iv_t *iv, char *out, size_t out_size);

/* =============================================================================
 * Session Management (REQ-061 through REQ-068)
 * ============================================================================= */

/**
 * Create a decryption session (REQ-061).
 * 
 * @param context FairPlay context
 * @param kid Content key identifier
 * @param out_session Output: newly created session
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_session_create(
    fp_context_t *context,
    const fp_kid_t *kid,
    fp_session_t **out_session
);

/**
 * Destroy a decryption session (REQ-064, REQ-065).
 * 
 * @param session Session to destroy (may be NULL)
 */
void fairplay_session_destroy(fp_session_t *session);

/**
 * Set the decryption key for a session.
 * 
 * @param session Decryption session
 * @param key Decryption key
 * @param expires_at Expiration timestamp
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_session_set_key(
    fp_session_t *session,
    const fp_key_t *key,
    uint64_t expires_at
);

/**
 * Set the IV for a session.
 * 
 * @param session Decryption session
 * @param iv Initialization vector
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_session_set_iv(fp_session_t *session, const fp_iv_t *iv);

/**
 * Decrypt a segment using the session.
 * 
 * @param session Decryption session
 * @param segment_number Segment number (for IV derivation if needed)
 * @param ciphertext Encrypted segment data
 * @param ciphertext_size Size of ciphertext
 * @param out_plaintext Output buffer
 * @param plaintext_size Output: actual plaintext size
 * @param max_plaintext_size Maximum output buffer size
 * @return FP_OK on success, error code otherwise
 */
fp_error_t fairplay_session_decrypt(
    fp_session_t *session,
    uint64_t segment_number,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext,
    size_t *plaintext_size,
    size_t max_plaintext_size
);

/**
 * Check if session has a valid key.
 * 
 * @param session Decryption session
 * @return true if session has a key, false otherwise
 */
bool fairplay_session_has_key(const fp_session_t *session);

/**
 * Check if session key has expired (REQ-045).
 * 
 * @param session Decryption session
 * @return true if key is expired, false otherwise
 */
bool fairplay_session_is_expired(const fp_session_t *session);

/**
 * Get session KID.
 * 
 * @param session Decryption session
 * @return Pointer to session KID
 */
const fp_kid_t *fairplay_session_get_kid(const fp_session_t *session);

/* =============================================================================
 * Utility Functions
 * ============================================================================= */

/**
 * Base64 encode data.
 * 
 * @param data Data to encode
 * @param data_size Size of data
 * @param out Output buffer
 * @param out_size Size of output buffer (including null terminator)
 * @return FP_OK on success, FP_ERR_BUFFER_TOO_SMALL otherwise
 */
fp_error_t fairplay_base64_encode(
    const uint8_t *data,
    size_t data_size,
    char *out,
    size_t out_size
);

/**
 * Base64 decode data.
 * 
 * @param data Base64 encoded string
 * @param out Output buffer for decoded data
 * @param out_size Output: actual decoded size
 * @param max_out_size Maximum output buffer size
 * @return FP_OK on success, FP_ERR_INVALID_BASE64 otherwise
 */
fp_error_t fairplay_base64_decode(
    const char *data,
    uint8_t *out,
    size_t *out_size,
    size_t max_out_size
);

/**
 * Get required Base64 encoded size.
 * 
 * @param data_size Size of data to encode
 * @return Required output buffer size (including null terminator)
 */
size_t fairplay_base64_encoded_size(size_t data_size);

/**
 * Secure memory zero (REQ-077).
 * 
 * Zeros memory in a way that resists optimization.
 * 
 * @param ptr Memory to zero
 * @param size Size to zero
 */
void fairplay_secure_zero(void *ptr, size_t size);

/**
 * Get current Unix timestamp.
 * 
 * @return Current time in seconds since epoch
 */
uint64_t fairplay_current_time(void);

/* =============================================================================
 * Thread Safety (REQ-006, REQ-082, REQ-083)
 * ============================================================================= */

/* All public API functions are thread-safe unless otherwise noted.
 * Contexts and key stores maintain internal locks for concurrent access.
 * Individual sessions are not thread-safe and should be used from a single thread.
 */

#ifdef __cplusplus
}
#endif

#endif /* FAIRPLAY_H */
