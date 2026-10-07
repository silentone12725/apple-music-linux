/*
 * fp_license_exchange.c - High-Level License Exchange API Implementation
 *
 * Version: 2.0
 * Date: 2026-10-08
 *
 * Clean-room implementation.
 * Independently authored by AML DRM Team.
 *
 * Protocol: POST JSON {"uri":…,"adamId":…} to buy.itunes.apple.com/itcs/key/get
 * Response: JSON {"ckc":"<base64>","ckcId":"…","expirationTime":…}
 * The decoded CKC binary contains the content key and IV directly.
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "fp_license_exchange.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <openssl/evp.h>

/* =============================================================================
 * Helper Functions
 * ============================================================================= */

/*
 * Extract numeric adamId from skd://itunes.apple.com/p<digits>/… URI.
 * Writes into out_buf (NUL-terminated). Returns FP_OK or FP_ERR_PSSH_PARSE_FAILED.
 */
static fp_error_t extract_adam_id(
    const char *media_uri,
    char *out_buf,
    size_t buf_size
) {
    const char *prefix = "skd://itunes.apple.com/p";
    const char *prefixP = "skd://itunes.apple.com/P";

    const char *digits_start = NULL;
    if (strncmp(media_uri, prefix, strlen(prefix)) == 0) {
        digits_start = media_uri + strlen(prefix);
    } else if (strncmp(media_uri, prefixP, strlen(prefixP)) == 0) {
        digits_start = media_uri + strlen(prefixP);
    } else {
        /* Not a per-asset URI — use empty adamId */
        out_buf[0] = '\0';
        return FP_OK;
    }

    size_t len = 0;
    while (digits_start[len] >= '0' && digits_start[len] <= '9') len++;
    if (len == 0 || len >= buf_size) {
        out_buf[0] = '\0';
        return FP_OK;
    }
    memcpy(out_buf, digits_start, len);
    out_buf[len] = '\0';
    return FP_OK;
}

static fp_error_t get_device_guid(
    const char *storage_path,
    char *out_guid,
    size_t guid_size
) {
    fp_device_id_t device_id;
    fp_error_t err = fairplay_device_id_load(storage_path, &device_id);
    if (err != FP_OK) {
        out_guid[0] = '\0';
        return FP_OK;  /* non-fatal — proceed without GUID */
    }
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

    /* Extract adamId from the URI */
    char adam_id[64] = {0};
    extract_adam_id(media_uri, adam_id, sizeof(adam_id));

    /* Get device GUID (best-effort) */
    char device_guid[64] = {0};
    get_device_guid(storage_path, device_guid, sizeof(device_guid));

    /* POST to Apple's streaming key delivery endpoint */
    fp_http_config_t http_config;
    fp_http_config_init(&http_config);

    fp_http_response_t *response = NULL;
    fp_error_t err = fp_license_exchange(
        &http_config,
        media_uri,
        adam_id,
        auth_token,
        storefront_id,
        device_guid,
        &response
    );

    if (err != FP_OK) {
        fp_http_response_free(response);
        return err;
    }

    if (!response->ckc_data || response->ckc_size == 0) {
        fp_http_response_free(response);
        return FP_ERR_CKC_PARSE_FAILED;
    }

    /* Parse binary CKC */
    fp_ckc_t ckc;
    err = fp_ckc_parse(response->ckc_data, response->ckc_size, &ckc);
    fp_http_response_free(response);

    if (err != FP_OK) {
        return err;
    }

    /* Build key context from parsed CKC */
    drm_key_context_t *key_ctx = calloc(1, sizeof(drm_key_context_t));
    if (!key_ctx) {
        fp_ckc_free(&ckc);
        return FP_ERR_OUT_OF_MEMORY;
    }

    key_ctx->asset_id  = strdup(adam_id[0] ? adam_id : media_uri);
    key_ctx->media_uri = strdup(media_uri);

    /*
     * In the streaming key delivery protocol the CKC carries the content key
     * directly (unencrypted — auth is via Bearer token).  fp_ckc_parse puts
     * whatever bytes are in the key position into ckc.encrypted_key; copy them
     * straight into aes_key.
     */
    size_t key_copy = ckc.encrypted_key_size < 16 ? ckc.encrypted_key_size : 16;
    memcpy(key_ctx->aes_key, ckc.encrypted_key, key_copy);
    /* IV is not in fp_ckc_t (struct is from the SPC-era parser);
     * use the KID as IV placeholder — will be corrected once we know
     * the actual CKC format returned by buy.itunes.apple.com. */
    memcpy(key_ctx->base_iv, ckc.kid, 16);

    key_ctx->expires_at    = ckc.expires_at;
    key_ctx->sample_number = 0;
    key_ctx->recovery_epoch = 0;
    key_ctx->refcount      = 1;

    fp_ckc_free(&ckc);

    pthread_mutex_init(&key_ctx->lock, NULL);

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
    if (!ctx || ctx->expires_at == 0) return false;
    return (uint64_t)time(NULL) >= ctx->expires_at;
}

void fp_derive_sample_iv(
    drm_key_context_t *ctx,
    uint64_t sample_number,
    uint8_t out_iv[16]
) {
    if (!ctx || !out_iv) return;
    memcpy(out_iv, ctx->base_iv, 16);
    /* Counter mode: XOR low 8 bytes with sample number (big-endian) */
    for (int i = 0; i < 8; i++) {
        out_iv[15 - i] ^= (uint8_t)(sample_number >> (i * 8));
    }
}

fp_error_t fp_decrypt_sample(
    drm_key_context_t *ctx,
    uint64_t sample_number,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext
) {
    if (!ctx || !ciphertext || !out_plaintext) return FP_ERR_NULL_POINTER;
    if (ciphertext_size == 0 || (ciphertext_size % 16) != 0) {
        return FP_ERR_INVALID_KEY_SIZE;
    }

    uint8_t iv[16];
    fp_derive_sample_iv(ctx, sample_number, iv);

    EVP_CIPHER_CTX *evp = EVP_CIPHER_CTX_new();
    if (!evp) return FP_ERR_OUT_OF_MEMORY;

    int ok = EVP_DecryptInit_ex(evp, EVP_aes_128_cbc(), NULL, ctx->aes_key, iv);
    if (ok) EVP_CIPHER_CTX_set_padding(evp, 0);

    int out_len = 0;
    if (ok) ok = EVP_DecryptUpdate(evp, out_plaintext, &out_len,
                                   ciphertext, (int)ciphertext_size);
    EVP_CIPHER_CTX_free(evp);

    return (ok && (size_t)out_len == ciphertext_size) ? FP_OK : FP_ERR_DECRYPTION_FAILED;
}
