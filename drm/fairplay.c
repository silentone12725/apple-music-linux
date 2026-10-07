/*
 * fairplay.c - FairPlay DRM Core Implementation
 * 
 * Version: 2.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay DRM for Linux.
 * Independently authored by AML DRM Team.
 */

#define _POSIX_C_SOURCE 200809L

#include "fairplay.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <pthread.h>
#include <errno.h>
#include <cpuid.h>

#include <openssl/aes.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>

/* =============================================================================
 * Internal Constants
 * ============================================================================= */

#define FP_INTERNAL_ERROR(e) ((fp_error_t)(e))

/* FairPlay System ID as binary UUID */
static const uint8_t FP_SYSTEM_ID_BYTES[16] = {
    0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99,
    0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99
};

/* =============================================================================
 * Internal Data Structures
 * ============================================================================= */

struct fp_context {
    pthread_mutex_t lock;
    int refcount;
};

struct fp_key_store {
    pthread_mutex_t lock;
    fp_complete_key_t keys[FP_MAX_KEYS];
    size_t count;
    bool initialized;
};

struct fp_session {
    fp_context_t *context;
    fp_kid_t kid;
    fp_key_t key;
    fp_iv_t iv;
    uint64_t expires_at;
    bool has_key;
    bool has_iv;
};

/* =============================================================================
 * Global State
 * ============================================================================= */

static pthread_mutex_t g_init_lock = PTHREAD_MUTEX_INITIALIZER;
static int g_init_count = 0;
static bool g_has_aesni = false;
static bool g_has_openssl = true;

/* Base64 reverse table — built once at process level */
static signed char g_b64_rev[256];
static pthread_once_t g_b64_once = PTHREAD_ONCE_INIT;

static void fp_b64_init(void) {
    for (int i = 0; i < 256; i++) g_b64_rev[i] = -1;
    g_b64_rev['A'] = 0;  g_b64_rev['B'] = 1;  g_b64_rev['C'] = 2;  g_b64_rev['D'] = 3;
    g_b64_rev['E'] = 4;  g_b64_rev['F'] = 5;  g_b64_rev['G'] = 6;  g_b64_rev['H'] = 7;
    g_b64_rev['I'] = 8;  g_b64_rev['J'] = 9;  g_b64_rev['K'] = 10; g_b64_rev['L'] = 11;
    g_b64_rev['M'] = 12; g_b64_rev['N'] = 13; g_b64_rev['O'] = 14; g_b64_rev['P'] = 15;
    g_b64_rev['Q'] = 16; g_b64_rev['R'] = 17; g_b64_rev['S'] = 18; g_b64_rev['T'] = 19;
    g_b64_rev['U'] = 20; g_b64_rev['V'] = 21; g_b64_rev['W'] = 22; g_b64_rev['X'] = 23;
    g_b64_rev['Y'] = 24; g_b64_rev['Z'] = 25;
    g_b64_rev['a'] = 26; g_b64_rev['b'] = 27; g_b64_rev['c'] = 28; g_b64_rev['d'] = 29;
    g_b64_rev['e'] = 30; g_b64_rev['f'] = 31; g_b64_rev['g'] = 32; g_b64_rev['h'] = 33;
    g_b64_rev['i'] = 34; g_b64_rev['j'] = 35; g_b64_rev['k'] = 36; g_b64_rev['l'] = 37;
    g_b64_rev['m'] = 38; g_b64_rev['n'] = 39; g_b64_rev['o'] = 40; g_b64_rev['p'] = 41;
    g_b64_rev['q'] = 42; g_b64_rev['r'] = 43; g_b64_rev['s'] = 44; g_b64_rev['t'] = 45;
    g_b64_rev['u'] = 46; g_b64_rev['v'] = 47; g_b64_rev['w'] = 48; g_b64_rev['x'] = 49;
    g_b64_rev['y'] = 50; g_b64_rev['z'] = 51;
    g_b64_rev['0'] = 52; g_b64_rev['1'] = 53; g_b64_rev['2'] = 54; g_b64_rev['3'] = 55;
    g_b64_rev['4'] = 56; g_b64_rev['5'] = 57; g_b64_rev['6'] = 58; g_b64_rev['7'] = 59;
    g_b64_rev['8'] = 60; g_b64_rev['9'] = 61;
    g_b64_rev['+'] = 62; g_b64_rev['/'] = 63;
}

/* =============================================================================
 * Helper Functions
 * ============================================================================= */

static void fp_secure_zero(void *ptr, size_t size) {
    volatile uint8_t *p = (volatile uint8_t *)ptr;
    while (size--) {
        *p++ = 0;
    }
}

static uint64_t fp_current_time_impl(void) {
    struct timespec ts;
    /* Use CLOCK_REALTIME for Unix epoch time (required for expiration checks) */
    clock_gettime(CLOCK_REALTIME, &ts);
    return (uint64_t)ts.tv_sec;
}

static int fp_uuid_compare(const uint8_t *a, const uint8_t *b) {
    return memcmp(a, b, 16);
}

/* =============================================================================
 * Version Functions (REQ-009)
 * ============================================================================= */

const char *fairplay_version(void) {
    return FAIRPLAY_VERSION_STRING;
}

void fairplay_version_components(int *major, int *minor, int *patch) {
    if (major) *major = FAIRPLAY_VERSION_MAJOR;
    if (minor) *minor = FAIRPLAY_VERSION_MINOR;
    if (patch) *patch = FAIRPLAY_VERSION_PATCH;
}

/* =============================================================================
 * Error Functions (REQ-069, REQ-070)
 * ============================================================================= */

const char *fairplay_error_string(fp_error_t error) {
    switch (error) {
        case FP_OK:                     return "Success";
        case FP_ERR_INIT_FAILED:        return "Initialization failed";
        case FP_ERR_INVALID_CONFIG:     return "Invalid configuration";
        case FP_ERR_NULL_POINTER:       return "NULL pointer argument";
        case FP_ERR_OUT_OF_MEMORY:      return "Memory allocation failed";
        case FP_ERR_PSSH_PARSE_FAILED:  return "PSSH parsing failed";
        case FP_ERR_INVALID_SYSTEM_ID:  return "Invalid FairPlay system ID";
        case FP_ERR_INVALID_JSON:       return "JSON parsing failed";
        case FP_ERR_INVALID_BASE64:     return "Base64 decoding failed";
        case FP_ERR_LICENSE_REQUEST_FAILED: return "License request failed";
        case FP_ERR_LICENSE_PARSE_FAILED: return "License parsing failed";
        case FP_ERR_CKC_PARSE_FAILED:   return "CKC parsing failed";
        case FP_ERR_KEY_NOT_FOUND:      return "Key not found";
        case FP_ERR_KEY_EXPIRED:        return "Key has expired";
        case FP_ERR_KEY_INVALID:        return "Key format invalid";
        case FP_ERR_DECRYPTION_FAILED:  return "Decryption operation failed";
        case FP_ERR_INVALID_IV:         return "Invalid initialization vector";
        case FP_ERR_INVALID_KEY_SIZE:   return "Key size not 16 bytes";
        case FP_ERR_BUFFER_TOO_SMALL:   return "Output buffer too small";
        case FP_ERR_SESSION_NOT_FOUND:  return "Session not found";
        case FP_ERR_SESSION_EXPIRED:    return "Session has expired";
        case FP_ERR_SESSION_INVALID_STATE: return "Invalid session state";
        case FP_ERR_NETWORK_TIMEOUT:    return "Network operation timed out";
        case FP_ERR_HTTP_ERROR:         return "HTTP error response";
        case FP_ERR_TLS_ERROR:          return "TLS/SSL error";
        case FP_ERR_THREAD_INIT_FAILED: return "Thread initialization failed";
        case FP_ERR_LOCK_FAILED:        return "Lock acquisition failed";
        
        /* Device certificate errors */
        case FP_ERR_DEVICE_ID_GENERATION_FAILED:  return "Device ID generation failed";
        case FP_ERR_DEVICE_ID_STORAGE_FAILED:     return "Device ID storage failed";
        case FP_ERR_DEVICE_ID_NOT_FOUND:          return "Device ID not found";
        case FP_ERR_DEVICE_ID_INVALID_FORMAT:     return "Device ID invalid format";
        case FP_ERR_KEY_GENERATION_FAILED:        return "Key generation failed";
        case FP_ERR_INVALID_DEVICE_KEY_SIZE:      return "Invalid device key size";
        case FP_ERR_INVALID_CURVE:                return "EC curve not supported";
        case FP_ERR_KEY_STORAGE_FAILED:           return "Key storage failed";
        case FP_ERR_KEY_ENCRYPTION_FAILED:        return "Key encryption failed";
        case FP_ERR_KEY_DECRYPTION_FAILED:        return "Key decryption failed";
        case FP_ERR_CERTIFICATE_SIGNING_FAILED:   return "Certificate signing failed";
        case FP_ERR_CERTIFICATE_STORAGE_FAILED:   return "Certificate storage failed";
        case FP_ERR_CERTIFICATE_INVALID_FORMAT:   return "Certificate invalid format";
        case FP_ERR_CERTIFICATE_INVALID_SIGNATURE:return "Certificate invalid signature";
        case FP_ERR_CERTIFICATE_EXPIRED:          return "Certificate expired";
        case FP_ERR_CERTIFICATE_NOT_YET_VALID:    return "Certificate not yet valid";
        case FP_ERR_CSR_SIGNING_FAILED:           return "CSR signing failed";
        case FP_ERR_INVALID_PUBLIC_KEY:           return "Public key malformed";
        case FP_ERR_INVALID_PRIVATE_KEY:          return "Private key malformed";
        case FP_ERR_KEY_WRAPPING_FAILED:          return "Key wrapping failed";
        case FP_ERR_KEY_UNWRAPPING_FAILED:        return "Key unwrapping failed";
        case FP_ERR_KEY_ENCRYPTED:                return "Key encrypted, no password";
        case FP_ERR_INVALID_PASSWORD:             return "Invalid password";
        case FP_ERR_CERTIFICATE_ENCODING_FAILED:  return "Certificate encoding failed";
        case FP_ERR_CREDENTIAL_RESET_FAILED:      return "Credential reset failed";
        case FP_ERR_DEVICE_NOT_INITIALIZED:       return "Device module not initialized";
        case FP_ERR_DEVICE_ALREADY_INITIALIZED:   return "Device module already initialized";
        case FP_ERR_INVALID_KEY:                  return "Key is malformed or unusable";
        
        case FP_ERR_UNKNOWN:            return "Unknown error";
        default:                        return "Unknown error code";
    }
}

/* =============================================================================
 * Feature Detection (REQ-010)
 * ============================================================================= */

bool fairplay_has_aesni(void) {
    return g_has_aesni;
}

bool fairplay_has_openssl(void) {
    return g_has_openssl;
}

/* =============================================================================
 * Context Management (REQ-001 through REQ-008)
 * ============================================================================= */

fp_error_t fairplay_init(void) {
    pthread_mutex_lock(&g_init_lock);
    
    if (g_init_count > 0) {
        g_init_count++;
        pthread_mutex_unlock(&g_init_lock);
        return FP_OK;
    }
    
    /* Detect AES-NI */
#ifdef __x86_64__
    unsigned int eax, ebx, ecx, edx;
    if (__get_cpuid(1, &eax, &ebx, &ecx, &edx)) {
        g_has_aesni = (ecx & (1 << 25)) != 0;
    }
#endif
    
    g_init_count = 1;
    pthread_mutex_unlock(&g_init_lock);
    
    return FP_OK;
}

fp_error_t fairplay_shutdown(void) {
    pthread_mutex_lock(&g_init_lock);
    
    if (g_init_count <= 0) {
        pthread_mutex_unlock(&g_init_lock);
        return FP_OK;
    }
    
    g_init_count--;
    if (g_init_count == 0) {
        /* Global cleanup would go here */
    }
    
    pthread_mutex_unlock(&g_init_lock);
    return FP_OK;
}

fp_error_t fairplay_context_create(fp_context_t **out_context) {
    if (!out_context) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_context_t *ctx = calloc(1, sizeof(fp_context_t));
    if (!ctx) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (pthread_mutex_init(&ctx->lock, NULL) != 0) {
        free(ctx);
        return FP_ERR_THREAD_INIT_FAILED;
    }
    
    ctx->refcount = 1;
    *out_context = ctx;
    return FP_OK;
}

fp_error_t fairplay_context_destroy(fp_context_t *context) {
    if (!context) {
        return FP_OK;
    }

    pthread_mutex_lock(&context->lock);
    int remaining = --context->refcount;
    pthread_mutex_unlock(&context->lock);

    if (remaining > 0) {
        return FP_OK;
    }

    /* refcount reached zero — no other thread holds this context */
    pthread_mutex_destroy(&context->lock);
    fp_secure_zero(context, sizeof(fp_context_t));
    free(context);

    return FP_OK;
}

/* =============================================================================
 * PSSH Functions (REQ-011 through REQ-020)
 * ============================================================================= */

fp_error_t fairplay_pssh_parse(
    fp_context_t *context,
    const uint8_t *data,
    size_t size,
    fp_pssh_t **out_pssh
) {
    (void)context;
    
    if (!out_pssh || !data) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* PSSH minimum size: 4 (size) + 4 (type) + 4 (version) + 4 (kid count) + 16 (system ID) = 32 */
    if (size < 32) {
        return FP_ERR_PSSH_PARSE_FAILED;
    }
    
    /* Parse box size (first 4 bytes, big-endian) */
    uint32_t box_size = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
    if (box_size > size) {
        return FP_ERR_PSSH_PARSE_FAILED;
    }
    
    /* Parse box type (bytes 4-7): should be "pssh" */
    if (data[4] != 'p' || data[5] != 's' || data[6] != 's' || data[7] != 'h') {
        return FP_ERR_PSSH_PARSE_FAILED;
    }
    
    /* Parse version and flags (bytes 8-11) */
    uint8_t version = data[8];
    if (version > 1) {
        return FP_ERR_PSSH_PARSE_FAILED;
    }
    
    /* Parse KID count (bytes 12-15, big-endian) */
    uint32_t kid_count = (data[12] << 24) | (data[13] << 16) | (data[14] << 8) | data[15];
    if (kid_count == 0 || kid_count > 256) {
        return FP_ERR_PSSH_PARSE_FAILED;
    }
    
    /* Allocate PSSH structure */
    fp_pssh_t *pssh = calloc(1, sizeof(fp_pssh_t));
    if (!pssh) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Copy system ID (bytes 16-31) */
    memcpy(pssh->system_id, &data[16], 16);
    
    /* Allocate and copy KIDs */
    pssh->kid_count = (uint8_t)kid_count;
    pssh->kids = calloc(kid_count, sizeof(fp_kid_t));
    if (!pssh->kids) {
        free(pssh);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    for (uint32_t i = 0; i < kid_count; i++) {
        /* Each KID entry: 4-byte size field + 16-byte KID data */
        size_t size_field_offset = 32 + (i * 20);
        size_t kid_offset = size_field_offset + 4;  /* Skip the 4-byte size field */
        if (kid_offset + 16 > size) {
            fairplay_pssh_free(pssh);
            return FP_ERR_PSSH_PARSE_FAILED;
        }
        memcpy(pssh->kids[i].bytes, &data[kid_offset], 16);
    }
    
    /* Copy additional data if present */
    size_t data_offset = 32 + (kid_count * 20);  /* 4 bytes size + 16 bytes KID per entry */
    if (size > data_offset) {
        pssh->data_size = (uint32_t)(size - data_offset);
        pssh->data = malloc(pssh->data_size);
        if (pssh->data) {
            memcpy(pssh->data, &data[data_offset], pssh->data_size);
        }
    }
    
    *out_pssh = pssh;
    return FP_OK;
}

void fairplay_pssh_free(fp_pssh_t *pssh) {
    if (!pssh) return;
    
    if (pssh->kids) {
        fp_secure_zero(pssh->kids, pssh->kid_count * sizeof(fp_kid_t));
        free(pssh->kids);
    }
    if (pssh->data) {
        fp_secure_zero(pssh->data, pssh->data_size);
        free(pssh->data);
    }
    fp_secure_zero(pssh, sizeof(fp_pssh_t));
    free(pssh);
}

bool fairplay_pssh_is_fairplay(const fp_pssh_t *pssh) {
    if (!pssh) return false;
    return fp_uuid_compare(pssh->system_id, FP_SYSTEM_ID_BYTES) == 0;
}

fp_error_t fairplay_pssh_get_primary_kid(const fp_pssh_t *pssh, fp_kid_t *out_kid) {
    if (!pssh || !out_kid || pssh->kid_count == 0) {
        return FP_ERR_KEY_NOT_FOUND;
    }
    
    fairplay_kid_copy(out_kid, &pssh->kids[0]);
    return FP_OK;
}

fp_error_t fairplay_pssh_get_kid_at(const fp_pssh_t *pssh, size_t index, fp_kid_t *out_kid) {
    if (!pssh || !out_kid || index >= pssh->kid_count) {
        return FP_ERR_NULL_POINTER;
    }
    
    fairplay_kid_copy(out_kid, &pssh->kids[index]);
    return FP_OK;
}

size_t fairplay_pssh_kid_count(const fp_pssh_t *pssh) {
    return pssh ? pssh->kid_count : 0;
}

int fairplay_kid_compare(const fp_kid_t *kid1, const fp_kid_t *kid2) {
    if (!kid1 || !kid2) return 1;
    return memcmp(kid1->bytes, kid2->bytes, FP_KID_SIZE);
}

void fairplay_kid_copy(fp_kid_t *dest, const fp_kid_t *src) {
    if (dest && src) {
        memcpy(dest->bytes, src->bytes, FP_KID_SIZE);
    }
}

void fairplay_kid_set_bytes(fp_kid_t *kid, const uint8_t bytes[FP_KID_SIZE]) {
    if (kid && bytes) {
        memcpy(kid->bytes, bytes, FP_KID_SIZE);
    }
}

fp_error_t fairplay_kid_to_hex(const fp_kid_t *kid, char *out, size_t out_size) {
    if (!kid || !out || out_size < 33) {
        return FP_ERR_BUFFER_TOO_SMALL;
    }
    
    for (int i = 0; i < FP_KID_SIZE; i++) {
        sprintf(out + (i * 2), "%02x", kid->bytes[i]);
    }
    out[FP_KID_SIZE * 2] = '\0';
    
    return FP_OK;
}

/* =============================================================================
 * Key Store Functions (REQ-041 through REQ-050)
 * ============================================================================= */

fp_error_t fairplay_key_store_create(fp_context_t *context, fp_key_store_t **out_store) {
    (void)context;
    
    if (!out_store) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_key_store_t *store = calloc(1, sizeof(fp_key_store_t));
    if (!store) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (pthread_mutex_init(&store->lock, NULL) != 0) {
        free(store);
        return FP_ERR_THREAD_INIT_FAILED;
    }
    
    store->initialized = true;
    store->count = 0;
    
    *out_store = store;
    return FP_OK;
}

static void fp_key_store_clear_locked(fp_key_store_t *store) {
    for (size_t i = 0; i < store->count; i++) {
        fp_secure_zero(&store->keys[i], sizeof(fp_complete_key_t));
    }
    store->count = 0;
}

void fairplay_key_store_destroy(fp_key_store_t *store) {
    if (!store || !store->initialized) return;

    pthread_mutex_lock(&store->lock);
    fp_key_store_clear_locked(store);
    pthread_mutex_unlock(&store->lock);

    pthread_mutex_destroy(&store->lock);
    fp_secure_zero(store, sizeof(fp_key_store_t));
    free(store);
}

fp_error_t fairplay_key_store_add(
    fp_key_store_t *store,
    const fp_kid_t *kid,
    const fp_key_t *key,
    uint64_t expires_at
) {
    if (!store || !kid || !key) {
        return FP_ERR_NULL_POINTER;
    }
    
    pthread_mutex_lock(&store->lock);
    
    if (store->count >= FP_MAX_KEYS) {
        pthread_mutex_unlock(&store->lock);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Check if key already exists */
    for (size_t i = 0; i < store->count; i++) {
        if (fairplay_kid_compare(&store->keys[i].kid, kid) == 0) {
            /* Update existing key */
            fairplay_kid_copy(&store->keys[i].kid, kid);
            memcpy(store->keys[i].key.bytes, key->bytes, FP_KEY_SIZE);
            store->keys[i].expires_at = expires_at;
            pthread_mutex_unlock(&store->lock);
            return FP_OK;
        }
    }
    
    /* Add new key */
    fp_complete_key_t *new_key = &store->keys[store->count];
    fairplay_kid_copy(&new_key->kid, kid);
    memcpy(new_key->key.bytes, key->bytes, FP_KEY_SIZE);
    new_key->expires_at = expires_at;
    new_key->is_persistent = false;
    
    store->count++;
    pthread_mutex_unlock(&store->lock);
    
    return FP_OK;
}

fp_error_t fairplay_key_store_get(
    const fp_key_store_t *store,
    const fp_kid_t *kid,
    fp_key_t *out_key
) {
    if (!store || !kid || !out_key) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Use const_cast via pointer arithmetic to avoid const warning */
    pthread_mutex_t *lock = (pthread_mutex_t *)&((fp_key_store_t *)(uintptr_t)store)->lock;
    pthread_mutex_lock(lock);
    
    for (size_t i = 0; i < store->count; i++) {
        if (fairplay_kid_compare(&store->keys[i].kid, kid) == 0) {
            memcpy(out_key->bytes, store->keys[i].key.bytes, FP_KEY_SIZE);
            pthread_mutex_unlock(lock);
            return FP_OK;
        }
    }
    
    pthread_mutex_unlock(lock);
    return FP_ERR_KEY_NOT_FOUND;
}

bool fairplay_key_store_has(const fp_key_store_t *store, const fp_kid_t *kid) {
    if (!store || !kid) return false;
    
    pthread_mutex_t *lock = (pthread_mutex_t *)&((fp_key_store_t *)(uintptr_t)store)->lock;
    pthread_mutex_lock(lock);
    
    for (size_t i = 0; i < store->count; i++) {
        if (fairplay_kid_compare(&store->keys[i].kid, kid) == 0) {
            pthread_mutex_unlock(lock);
            return true;
        }
    }
    
    pthread_mutex_unlock(lock);
    return false;
}

fp_error_t fairplay_key_store_remove(fp_key_store_t *store, const fp_kid_t *kid) {
    if (!store || !kid) {
        return FP_ERR_NULL_POINTER;
    }
    
    pthread_mutex_lock(&store->lock);
    
    for (size_t i = 0; i < store->count; i++) {
        if (fairplay_kid_compare(&store->keys[i].kid, kid) == 0) {
            fp_secure_zero(&store->keys[i], sizeof(fp_complete_key_t));
            memmove(&store->keys[i], &store->keys[i + 1],
                    (store->count - i - 1) * sizeof(fp_complete_key_t));
            store->count--;
            pthread_mutex_unlock(&store->lock);
            return FP_OK;
        }
    }
    
    pthread_mutex_unlock(&store->lock);
    return FP_ERR_KEY_NOT_FOUND;
}

void fairplay_key_store_clear(fp_key_store_t *store) {
    if (!store || !store->initialized) return;

    pthread_mutex_lock(&store->lock);
    fp_key_store_clear_locked(store);
    pthread_mutex_unlock(&store->lock);
}

bool fairplay_key_store_is_expired(const fp_key_store_t *store, const fp_kid_t *kid) {
    if (!store || !kid) return false;
    
    pthread_mutex_t *lock = (pthread_mutex_t *)&((fp_key_store_t *)(uintptr_t)store)->lock;
    pthread_mutex_lock(lock);
    
    for (size_t i = 0; i < store->count; i++) {
        if (fairplay_kid_compare(&store->keys[i].kid, kid) == 0) {
            bool expired = (store->keys[i].expires_at > 0) &&
                          (fairplay_current_time() >= store->keys[i].expires_at);
            pthread_mutex_unlock(lock);
            return expired;
        }
    }
    
    pthread_mutex_unlock(lock);
    return false;
}

size_t fairplay_key_store_count(const fp_key_store_t *store) {
    if (!store || !store->initialized) return 0;
    
    pthread_mutex_t *lock = (pthread_mutex_t *)&((fp_key_store_t *)(uintptr_t)store)->lock;
    pthread_mutex_lock(lock);
    size_t count = store->count;
    pthread_mutex_unlock(lock);
    
    return count;
}

/* =============================================================================
 * Decryption Functions (REQ-051 through REQ-060)
 * ============================================================================= */

fp_error_t fairplay_decrypt_aes128_cbc(
    const fp_key_t *key,
    const fp_iv_t *iv,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext,
    size_t *plaintext_size,
    size_t max_plaintext_size
) {
    if (!key || !iv || !ciphertext || !out_plaintext) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* AES-CBC output size equals input size */
    if (plaintext_size) {
        if (ciphertext_size > max_plaintext_size) {
            return FP_ERR_BUFFER_TOO_SMALL;
        }
        *plaintext_size = ciphertext_size;
    } else {
        if (ciphertext_size > max_plaintext_size) {
            return FP_ERR_BUFFER_TOO_SMALL;
        }
    }
    
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (EVP_DecryptInit_ex(ctx, EVP_aes_128_cbc(), NULL,
                           key->bytes, iv->bytes) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    /* Disable padding for raw block decryption */
    EVP_CIPHER_CTX_set_padding(ctx, 0);
    
    int plaintext_len = 0;
    if (EVP_DecryptUpdate(ctx, out_plaintext, &plaintext_len,
                          ciphertext, (int)ciphertext_size) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    int final_len = 0;
    uint8_t final_block[FP_AES_BLOCK_SIZE];
    if (EVP_DecryptFinal_ex(ctx, final_block, &final_len) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    /* Append final block if present */
    if (final_len > 0) {
        memcpy(out_plaintext + plaintext_len, final_block, (size_t)final_len);
        plaintext_len += final_len;
    }
    
    if (plaintext_size) {
        *plaintext_size = (size_t)plaintext_len;
    }
    
    EVP_CIPHER_CTX_free(ctx);
    return FP_OK;
}

size_t fairplay_decrypt_required_size(size_t ciphertext_size) {
    return ciphertext_size;
}

void fairplay_iv_from_segment(fp_iv_t *out_iv, uint64_t segment_number) {
    if (!out_iv) return;
    
    fp_secure_zero(out_iv->bytes, FP_IV_SIZE);
    
    /* Encode segment number as big-endian in last 8 bytes */
    out_iv->bytes[8]  = (uint8_t)(segment_number >> 56) & 0xFF;
    out_iv->bytes[9]  = (uint8_t)(segment_number >> 48) & 0xFF;
    out_iv->bytes[10] = (uint8_t)(segment_number >> 40) & 0xFF;
    out_iv->bytes[11] = (uint8_t)(segment_number >> 32) & 0xFF;
    out_iv->bytes[12] = (uint8_t)(segment_number >> 24) & 0xFF;
    out_iv->bytes[13] = (uint8_t)(segment_number >> 16) & 0xFF;
    out_iv->bytes[14] = (uint8_t)(segment_number >> 8) & 0xFF;
    out_iv->bytes[15] = (uint8_t)(segment_number) & 0xFF;
}

void fairplay_iv_set_bytes(fp_iv_t *iv, const uint8_t bytes[FP_IV_SIZE]) {
    if (iv && bytes) {
        memcpy(iv->bytes, bytes, FP_IV_SIZE);
    }
}

fp_error_t fairplay_iv_to_hex(const fp_iv_t *iv, char *out, size_t out_size) {
    if (!iv || !out || out_size < 33) {
        return FP_ERR_BUFFER_TOO_SMALL;
    }
    
    for (int i = 0; i < FP_IV_SIZE; i++) {
        sprintf(out + (i * 2), "%02x", iv->bytes[i]);
    }
    out[FP_IV_SIZE * 2] = '\0';
    
    return FP_OK;
}

/* =============================================================================
 * Session Functions (REQ-061 through REQ-068)
 * ============================================================================= */

fp_error_t fairplay_session_create(
    fp_context_t *context,
    const fp_kid_t *kid,
    fp_session_t **out_session
) {
    if (!context || !kid || !out_session) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_session_t *session = calloc(1, sizeof(fp_session_t));
    if (!session) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    session->context = context;
    fairplay_kid_copy(&session->kid, kid);
    session->has_key = false;
    session->has_iv = false;
    session->expires_at = 0;
    
    *out_session = session;
    return FP_OK;
}

void fairplay_session_destroy(fp_session_t *session) {
    if (!session) return;
    
    fp_secure_zero(session, sizeof(fp_session_t));
    free(session);
}

fp_error_t fairplay_session_set_key(
    fp_session_t *session,
    const fp_key_t *key,
    uint64_t expires_at
) {
    if (!session || !key) {
        return FP_ERR_NULL_POINTER;
    }
    
    memcpy(session->key.bytes, key->bytes, FP_KEY_SIZE);
    session->expires_at = expires_at;
    session->has_key = true;
    
    return FP_OK;
}

fp_error_t fairplay_session_set_iv(fp_session_t *session, const fp_iv_t *iv) {
    if (!session || !iv) {
        return FP_ERR_NULL_POINTER;
    }
    
    memcpy(session->iv.bytes, iv->bytes, FP_IV_SIZE);
    session->has_iv = true;
    
    return FP_OK;
}

fp_error_t fairplay_session_decrypt(
    fp_session_t *session,
    uint64_t segment_number,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext,
    size_t *plaintext_size,
    size_t max_plaintext_size
) {
    if (!session || !ciphertext || !out_plaintext) {
        return FP_ERR_NULL_POINTER;
    }
    
    if (!session->has_key) {
        return FP_ERR_SESSION_INVALID_STATE;
    }
    
    /* Check expiration */
    if (session->expires_at > 0 && fairplay_current_time() >= session->expires_at) {
        return FP_ERR_SESSION_EXPIRED;
    }
    
    /* Use session IV or derive from segment number */
    fp_iv_t iv;
    if (session->has_iv) {
        memcpy(iv.bytes, session->iv.bytes, FP_IV_SIZE);
    } else {
        fairplay_iv_from_segment(&iv, segment_number);
    }
    
    return fairplay_decrypt_aes128_cbc(
        &session->key, &iv, ciphertext, ciphertext_size,
        out_plaintext, plaintext_size, max_plaintext_size
    );
}

bool fairplay_session_has_key(const fp_session_t *session) {
    return session ? session->has_key : false;
}

bool fairplay_session_is_expired(const fp_session_t *session) {
    if (!session || !session->has_key) return false;
    return (session->expires_at > 0) &&
           (fairplay_current_time() >= session->expires_at);
}

const fp_kid_t *fairplay_session_get_kid(const fp_session_t *session) {
    return session ? &session->kid : NULL;
}

/* =============================================================================
 * Utility Functions
 * ============================================================================= */

static const char g_base64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fp_error_t fairplay_base64_encode(
    const uint8_t *data,
    size_t data_size,
    char *out,
    size_t out_size
) {
    if (!data || !out) {
        return FP_ERR_NULL_POINTER;
    }
    
    size_t encoded_size = fairplay_base64_encoded_size(data_size);
    if (out_size < encoded_size) {
        return FP_ERR_BUFFER_TOO_SMALL;
    }
    
    size_t out_idx = 0;
    size_t i = 0;
    
    while (i < data_size) {
        uint32_t octet_a = i < data_size ? data[i++] : 0;
        uint32_t octet_b = i < data_size ? data[i++] : 0;
        uint32_t octet_c = i < data_size ? data[i++] : 0;
        
        uint32_t triple = (octet_a << 16) + (octet_b << 8) + octet_c;
        
        out[out_idx++] = g_base64_table[(triple >> 18) & 0x3F];
        out[out_idx++] = g_base64_table[(triple >> 12) & 0x3F];
        out[out_idx++] = g_base64_table[(triple >> 6) & 0x3F];
        out[out_idx++] = g_base64_table[triple & 0x3F];
    }
    
    /* Add padding */
    size_t padding = data_size % 3;
    if (padding == 1) {
        out[encoded_size - 3] = '=';
        out[encoded_size - 2] = '=';
    } else if (padding == 2) {
        out[encoded_size - 2] = '=';
    }
    
    out[encoded_size - 1] = '\0';
    return FP_OK;
}

fp_error_t fairplay_base64_decode(
    const char *data,
    uint8_t *out,
    size_t *out_size,
    size_t max_out_size
) {
    if (!data || !out) {
        return FP_ERR_NULL_POINTER;
    }
    
    size_t data_len = strlen(data);
    if (data_len == 0 || data_len % 4 != 0) {
        return FP_ERR_INVALID_BASE64;
    }
    
    /* Calculate output size */
    size_t decoded_size = (data_len / 4) * 3;
    size_t padding = 0;
    
    if (data[data_len - 1] == '=') padding++;
    if (data[data_len - 2] == '=') padding++;
    decoded_size -= padding;
    
    if (decoded_size > max_out_size) {
        return FP_ERR_BUFFER_TOO_SMALL;
    }
    
    pthread_once(&g_b64_once, fp_b64_init);
    const signed char *b64_rev = g_b64_rev;
    
    size_t out_idx = 0;
    for (size_t i = 0; i < data_len; i += 4) {
        unsigned char c = (unsigned char)data[i];
        unsigned char d = (unsigned char)data[i + 1];
        unsigned char e = (unsigned char)data[i + 2];
        unsigned char f = (unsigned char)data[i + 3];
        
        /* Handle padding */
        int a = (c == '=') ? 0 : b64_rev[c];
        int b = (d == '=') ? 0 : b64_rev[d];
        int c_val = (e == '=') ? 0 : b64_rev[e];
        int d_val = (f == '=') ? 0 : b64_rev[f];
        
        if (a < 0 || b < 0 || c_val < 0 || d_val < 0) {
            return FP_ERR_INVALID_BASE64;
        }
        
        uint32_t triple = (a << 18) + (b << 12) + (c_val << 6) + d_val;
        
        if (out_idx < decoded_size) out[out_idx++] = (triple >> 16) & 0xFF;
        if (out_idx < decoded_size) out[out_idx++] = (triple >> 8) & 0xFF;
        if (out_idx < decoded_size) out[out_idx++] = triple & 0xFF;
    }
    
    if (out_size) *out_size = decoded_size;
    return FP_OK;
}

size_t fairplay_base64_encoded_size(size_t data_size) {
    return ((data_size + 2) / 3) * 4 + 1; /* +1 for null terminator */
}

void fairplay_secure_zero(void *ptr, size_t size) {
    fp_secure_zero(ptr, size);
}

uint64_t fairplay_current_time(void) {
    return fp_current_time_impl();
}
