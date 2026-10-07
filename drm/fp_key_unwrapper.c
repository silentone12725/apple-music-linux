/*
 * fp_key_unwrapper.c - Content Key Unwrapper Implementation
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay key unwrapping.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 */

#define _POSIX_C_SOURCE 200809L

#include "fp_key_unwrapper.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <openssl/evp.h>
#include <openssl/pem.h>

/* =============================================================================
 * Helper Functions
 * ============================================================================= */

/**
 * Load RSA private key from PEM/DER data.
 */
static EVP_PKEY *load_private_key(
    const uint8_t *private_key,
    size_t private_key_size
) {
    BIO *bio = BIO_new_mem_buf(private_key, (int)private_key_size);
    if (!bio) return NULL;
    
    EVP_PKEY *pkey = NULL;
    
    /* Try PEM format first */
    if (private_key_size > 10 && 
        private_key[0] == '-' && private_key[1] == '-') {
        pkey = PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL);
    }
    
    /* Try DER format if PEM failed */
    if (!pkey) {
        BIO_reset(bio);
        pkey = d2i_PrivateKey_bio(bio, NULL);
    }
    
    BIO_free(bio);
    return pkey;
}

/* =============================================================================
 * Public API Functions
 * ============================================================================= */

fp_error_t fp_unwrap_rsaes_oaep(
    const uint8_t *encrypted_key,
    size_t encrypted_key_size,
    const fp_key_pair_t *device_key,
    uint8_t out_content_key[16]
) {
    if (!encrypted_key || !device_key || !out_content_key) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Verify key type is RSA */
    if (device_key->type != FP_KEY_TYPE_RSA) {
        return FP_ERR_INVALID_KEY;  /* EC keys not supported for unwrapping */
    }
    
    /* Load device private key */
    EVP_PKEY *pkey = load_private_key(
        device_key->private_key,
        device_key->private_key_size
    );
    if (!pkey) {
        return FP_ERR_INVALID_PRIVATE_KEY;
    }
    
    /* Create decryption context (OpenSSL 3.0 pattern) */
    EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new(pkey, NULL);
    if (!ctx) {
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (EVP_PKEY_decrypt_init(ctx) != 1) {
        EVP_PKEY_CTX_free(ctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_KEY_UNWRAPPING_FAILED;
    }
    
    /* Set RSA-OAEP padding with SHA-256 */
    if (EVP_PKEY_CTX_set_rsa_padding(ctx, RSA_PKCS1_OAEP_PADDING) != 1) {
        EVP_PKEY_CTX_free(ctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_KEY_UNWRAPPING_FAILED;
    }
    
    if (EVP_PKEY_CTX_set_rsa_oaep_md(ctx, EVP_sha256()) != 1) {
        EVP_PKEY_CTX_free(ctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_KEY_UNWRAPPING_FAILED;
    }
    
    /* Get required output size */
    size_t decrypted_len = 0;
    if (EVP_PKEY_decrypt(ctx, NULL, &decrypted_len,
                         encrypted_key, encrypted_key_size) != 1) {
        EVP_PKEY_CTX_free(ctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_KEY_UNWRAPPING_FAILED;
    }
    
    /* Allocate and decrypt */
    uint8_t *decrypted = malloc(decrypted_len);
    if (!decrypted) {
        EVP_PKEY_CTX_free(ctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (EVP_PKEY_decrypt(ctx, decrypted, &decrypted_len,
                         encrypted_key, encrypted_key_size) != 1) {
        fairplay_secure_zero(decrypted, decrypted_len);
        free(decrypted);
        EVP_PKEY_CTX_free(ctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_KEY_UNWRAPPING_FAILED;
    }
    
    EVP_PKEY_CTX_free(ctx);
    EVP_PKEY_free(pkey);
    
    /* Verify decrypted key is 16 bytes */
    if (decrypted_len != 16) {
        fairplay_secure_zero(decrypted, decrypted_len);
        free(decrypted);
        return FP_ERR_INVALID_KEY_SIZE;
    }
    
    /* Copy content key */
    memcpy(out_content_key, decrypted, 16);
    fairplay_secure_zero(decrypted, 16);
    free(decrypted);
    
    return FP_OK;
}

fp_error_t fp_ckc_unwrap_key(
    const fp_ckc_t *ckc,
    const fp_key_pair_t *device_key,
    uint8_t out_content_key[16]
) {
    if (!ckc || !device_key || !out_content_key) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Validate CKC has encrypted key */
    if (ckc->encrypted_key_size == 0) {
        return FP_ERR_KEY_NOT_FOUND;
    }
    
    return fp_unwrap_rsaes_oaep(
        ckc->encrypted_key,
        ckc->encrypted_key_size,
        device_key,
        out_content_key
    );
}

bool fp_verify_content_key(const uint8_t content_key[16]) {
    if (!content_key) {
        return false;
    }
    
    /* Basic validation: key should not be all zeros or all 0xFF */
    bool all_zero = true;
    bool all_ff = true;
    
    for (size_t i = 0; i < 16; i++) {
        if (content_key[i] != 0) {
            all_zero = false;
        }
        if (content_key[i] != 0xFF) {
            all_ff = false;
        }
    }
    
    return !(all_zero || all_ff);
}
