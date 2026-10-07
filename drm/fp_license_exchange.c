/*
 * fp_license_exchange.c - High-Level License Exchange API Implementation
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay high-level license exchange.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "fp_license_exchange.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <endian.h>

#include <openssl/aes.h>
#include <openssl/evp.h>

/* =============================================================================
 * Helper Functions
 * ============================================================================= */

/**
 * Extract KID from media URI.
 * 
 * D4 fix: Return error for non-skd:// URIs instead of writing ASCII garbage.
 */
static fp_error_t extract_kid_from_uri(
    const char *media_uri,
    uint8_t kid[16]
) {
    /* Check if it's an skd:// URI */
    if (strncmp(media_uri, "skd://", 6) == 0) {
        return fp_parse_skd_uri(media_uri, kid);
    }
    
    /* For non-skd:// URIs, return error (KID cannot be reliably extracted) */
    return FP_ERR_PSSH_PARSE_FAILED;
}

/**
 * Get device GUID from storage.
 */
static fp_error_t get_device_guid(
    const char *storage_path,
    char *out_guid,
    size_t guid_size
) {
    fp_device_id_t device_id;
    fp_error_t err = fairplay_device_id_load(storage_path, &device_id);
    if (err != FP_OK) {
        return err;
    }
    
    /* Copy device ID string as GUID */
    strncpy(out_guid, device_id.string, guid_size - 1);
    out_guid[guid_size - 1] = '\0';
    
    return FP_OK;
}

/* =============================================================================
 * Public API Functions
 * ============================================================================= */

fp_error_t fp_acquire_content_key(
    const char *storage_path,
    const char *media_uri,
    const char *auth_token,
    const char *storefront_id,
    drm_key_context_t **out_key_context
) {
    if (!storage_path || !media_uri || !out_key_context) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* D11 fix: Create device context before using it */
    fp_device_context_t *ctx = NULL;
    fp_error_t err = fairplay_device_context_create(&ctx);
    if (err != FP_OK) {
        return err;
    }
    
    fp_credentials_t *creds = NULL;
    bool generated_new = false;
    
    /* Load or generate device credentials */
    err = fairplay_credentials_ensure(
        storage_path, ctx, FP_KEY_TYPE_RSA, NULL, &creds, &generated_new
    );
    if (err != FP_OK) {
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Extract KID from media URI */
    uint8_t kid[16];
    err = extract_kid_from_uri(media_uri, kid);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Build SPC */
    uint8_t *spc = NULL;
    size_t spc_size = 0;
    
    err = fp_spc_build(
        creds->key_pair,
        kid,
        auth_token,
        media_uri,
        &spc,
        &spc_size
    );
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Get device GUID */
    char device_guid[64];
    err = get_device_guid(storage_path, device_guid, sizeof(device_guid));
    if (err != FP_OK) {
        fp_spc_free(spc, spc_size);
        fairplay_credentials_free(creds);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Setup HTTP config */
    fp_http_config_t http_config;
    fp_http_config_init(&http_config);
    
    /* Exchange SPC for CKC */
    fp_http_response_t *response = NULL;
    err = fp_license_exchange(
        &http_config,
        spc, spc_size,
        auth_token,
        storefront_id,
        device_guid,
        &response
    );
    
    fp_spc_free(spc, spc_size);
    fairplay_credentials_free(creds);
    
    if (err != FP_OK) {
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Parse CKC */
    fp_ckc_t ckc;
    err = fp_ckc_parse(
        response->response_data,
        response->response_size,
        &ckc
    );
    fp_http_response_free(response);
    
    if (err != FP_OK) {
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Unwrap content key */
    uint8_t content_key[16];
    
    /* Reload credentials for key unwrapping */
    err = fairplay_credentials_load(storage_path, NULL, &creds);
    if (err != FP_OK) {
        fp_ckc_free(&ckc);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    err = fp_ckc_unwrap_key(&ckc, creds->key_pair, content_key);
    fairplay_credentials_free(creds);
    
    if (err != FP_OK) {
        fp_ckc_free(&ckc);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Create key context */
    drm_key_context_t *key_ctx = calloc(1, sizeof(drm_key_context_t));
    if (!key_ctx) {
        fp_ckc_free(&ckc);
        fairplay_device_context_destroy(ctx);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Initialize key context */
    key_ctx->asset_id = strdup(media_uri);
    key_ctx->media_uri = strdup(media_uri);
    memcpy(key_ctx->aes_key, content_key, 16);
    
    /* Initialize base IV with KID */
    memcpy(key_ctx->base_iv, kid, 16);
    key_ctx->sample_number = 0;
    
    /* D1 fix: Copy expires_at BEFORE freeing CKC */
    key_ctx->expires_at = ckc.expires_at;
    
    /* Now safe to free CKC */
    fp_ckc_free(&ckc);
    
    key_ctx->recovery_epoch = 0;
    key_ctx->refcount = 1;
    
    pthread_mutex_init(&key_ctx->lock, NULL);
    
    /* Secure zero content_key */
    fairplay_secure_zero(content_key, 16);
    
    /* D11 fix: Destroy device context before returning */
    fairplay_device_context_destroy(ctx);
    
    *out_key_context = key_ctx;
    return FP_OK;
}

void fp_free_key_context(drm_key_context_t *ctx) {
    if (!ctx) return;
    
    pthread_mutex_lock(&ctx->lock);
    ctx->refcount--;
    if (ctx->refcount > 0) {
        pthread_mutex_unlock(&ctx->lock);
        return;
    }
    pthread_mutex_unlock(&ctx->lock);
    
    free(ctx->asset_id);
    free(ctx->media_uri);
    
    fairplay_secure_zero(ctx->aes_key, 16);
    fairplay_secure_zero(ctx->base_iv, 16);
    
    pthread_mutex_destroy(&ctx->lock);
    fairplay_secure_zero(ctx, sizeof(drm_key_context_t));
    free(ctx);
}

bool fp_is_key_context_expired(drm_key_context_t *ctx) {
    if (!ctx) return true;
    
    uint64_t now = (uint64_t)time(NULL);
    return now >= ctx->expires_at;
}

void fp_derive_sample_iv(
    drm_key_context_t *ctx,
    uint64_t sample_number,
    uint8_t out_iv[16]
) {
    if (!ctx || !out_iv) return;
    
    memcpy(out_iv, ctx->base_iv, 16);

    /* Add sample_number to out_iv as a 128-bit big-endian unsigned integer.
     * Split into upper and lower 64-bit halves to avoid uint64_t overflow
     * when sample_number + lower_half wraps around. */
    uint64_t lo, hi;
    memcpy(&lo, out_iv + 8, 8);
    memcpy(&hi, out_iv + 0, 8);
    lo = be64toh(lo);
    hi = be64toh(hi);

    uint64_t new_lo = lo + sample_number;
    uint64_t carry  = (new_lo < lo) ? 1 : 0;
    uint64_t new_hi = hi + carry;

    new_lo = htobe64(new_lo);
    new_hi = htobe64(new_hi);
    memcpy(out_iv + 8, &new_lo, 8);
    memcpy(out_iv + 0, &new_hi, 8);
}

fp_error_t fp_decrypt_sample(
    drm_key_context_t *ctx,
    uint64_t sample_number,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext
) {
    if (!ctx || !ciphertext || !out_plaintext) {
        return FP_ERR_NULL_POINTER;
    }
    
    if (ciphertext_size == 0) {
        return FP_OK;
    }
    
    /* D2 fix: CBC mode requires block-aligned input */
    if (ciphertext_size % 16 != 0) {
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    /* Derive IV for this sample */
    uint8_t iv[16];
    fp_derive_sample_iv(ctx, sample_number, iv);
    
    /* D2 fix: AES-128-CBC decryption (not CTR) */
    EVP_CIPHER_CTX *ctx_cipher = EVP_CIPHER_CTX_new();
    if (!ctx_cipher) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Initialize AES-128-CBC cipher */
    if (EVP_DecryptInit_ex(ctx_cipher, EVP_aes_128_cbc(), NULL, NULL, NULL) != 1) {
        EVP_CIPHER_CTX_free(ctx_cipher);
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    /* Set key and IV */
    if (EVP_DecryptInit_ex(ctx_cipher, NULL, NULL, ctx->aes_key, iv) != 1) {
        EVP_CIPHER_CTX_free(ctx_cipher);
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    /* CBC uses PKCS#7 padding by default */
    
    int out_len = 0;
    if (EVP_DecryptUpdate(ctx_cipher, out_plaintext, &out_len,
                          ciphertext, (int)ciphertext_size) != 1) {
        EVP_CIPHER_CTX_free(ctx_cipher);
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    int final_len = 0;
    uint8_t final_block[16];
    if (EVP_DecryptFinal_ex(ctx_cipher, final_block, &final_len) != 1) {
        EVP_CIPHER_CTX_free(ctx_cipher);
        return FP_ERR_DECRYPTION_FAILED;
    }
    
    /* Append final block if any */
    if (final_len > 0) {
        memcpy(out_plaintext + out_len, final_block, final_len);
    }
    
    EVP_CIPHER_CTX_free(ctx_cipher);
    
    return FP_OK;
}
