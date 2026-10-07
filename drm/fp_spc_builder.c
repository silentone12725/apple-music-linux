/*
 * fp_spc_builder.c - Signed Public Key (SPC) Builder Implementation
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay SPC construction.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 */

#define _POSIX_C_SOURCE 200809L

#include "fp_spc_builder.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <endian.h>

#include <openssl/evp.h>
#include <openssl/sha.h>
#include <openssl/pem.h>
#include <openssl/rand.h>

/* Define byte swap functions if not available */
#ifndef htobe16
#define htobe16(x) ((uint16_t)(((x) >> 8) | ((x) << 8)))
#endif
#ifndef htobe32
#define htobe32(x) ((uint32_t)(((x) >> 24) | (((x) >> 8) & 0x0000FF00) | \
                                (((x) << 8) & 0x00FF0000) | ((x) << 24)))
#endif
#ifndef htobe64
#define htobe64(x) ((uint64_t)(((x) >> 56) | \
                                (((x) >> 40) & 0x000000FF00000000ULL) | \
                                (((x) >> 24) & 0x00000000FF000000ULL) | \
                                (((x) >> 8) & 0x0000000000FF0000ULL) | \
                                (((x) << 8) & 0x000000000000FF00ULL) | \
                                (((x) << 24) & 0x00000000000000FF000000ULL) | \
                                (((x) << 40) & 0x0000000000000000FF00000000ULL) | \
                                ((x) << 56)))
#endif
#ifndef be16toh
#define be16toh htobe16
#endif
#ifndef be32toh
#define be32toh htobe32
#endif
#ifndef be64toh
#define be64toh htobe64
#endif

/* =============================================================================
 * Helper Functions
 * ============================================================================= */

/**
 * Convert hex character to value.
 */
static uint8_t hex_char_to_value(char c) {
    if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
    if (c >= 'a' && c <= 'f') return (uint8_t)(c - 'a' + 10);
    if (c >= 'A' && c <= 'F') return (uint8_t)(c - 'A' + 10);
    return 0xFF;
}

/**
 * Sign data with RSA private key using PKCS#1 v1.5 with SHA-256.
 * OpenSSL 3.0 compatible implementation.
 */
static fp_error_t fp_spc_sign(
    const uint8_t *data,
    size_t data_size,
    const fp_key_pair_t *device_key,
    uint8_t *signature,
    size_t *signature_len
) {
    EVP_PKEY *pkey = NULL;
    
    /* Load private key */
    BIO *bio = BIO_new_mem_buf(device_key->private_key, 
                               (int)device_key->private_key_size);
    if (!bio) return FP_ERR_INVALID_PRIVATE_KEY;
    
    pkey = PEM_read_bio_PrivateKey(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (!pkey) return FP_ERR_INVALID_PRIVATE_KEY;
    
    /* Use EVP_DigestSign for PKCS#1 v1.5 with SHA-256 */
    EVP_MD_CTX *mdctx = EVP_MD_CTX_new();
    if (!mdctx) {
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (EVP_DigestSignInit(mdctx, NULL, EVP_sha256(), NULL, pkey) != 1) {
        EVP_MD_CTX_free(mdctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_CERTIFICATE_SIGNING_FAILED;
    }
    
    if (EVP_DigestSignUpdate(mdctx, data, data_size) != 1) {
        EVP_MD_CTX_free(mdctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_CERTIFICATE_SIGNING_FAILED;
    }
    
    if (EVP_DigestSignFinal(mdctx, signature, signature_len) != 1) {
        EVP_MD_CTX_free(mdctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_CERTIFICATE_SIGNING_FAILED;
    }
    
    EVP_MD_CTX_free(mdctx);
    EVP_PKEY_free(pkey);
    
    return FP_OK;
}

/**
 * Build authentication data.
 */
static fp_error_t fp_build_auth_data(
    const char *auth_token,
    const char *media_uri,
    const uint8_t nonce[32],
    uint8_t **out_auth,
    size_t *out_auth_size
) {
    /* Auth data format: auth_token + "|" + media_uri + "|" + nonce_hex */
    size_t token_len = auth_token ? strlen(auth_token) : 0;
    size_t uri_len = media_uri ? strlen(media_uri) : 0;
    size_t nonce_hex_len = 64;  /* 32 bytes = 64 hex chars */
    
    size_t auth_size = token_len + 1 + uri_len + 1 + nonce_hex_len;
    uint8_t *auth = malloc(auth_size + 1);
    
    if (!auth) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    size_t offset = 0;
    
    /* Add auth token */
    if (auth_token && token_len > 0) {
        memcpy(auth + offset, auth_token, token_len);
        offset += token_len;
    }
    
    /* Add separator */
    auth[offset++] = '|';
    
    /* Add media URI */
    if (media_uri && uri_len > 0) {
        memcpy(auth + offset, media_uri, uri_len);
        offset += uri_len;
    }
    
    /* Add separator */
    auth[offset++] = '|';
    
    /* Add nonce as hex */
    for (size_t i = 0; i < 32; i++) {
        sprintf((char*)(auth + offset), "%02x", nonce[i]);
        offset += 2;
    }
    
    auth[offset] = '\0';
    
    *out_auth = auth;
    *out_auth_size = offset;
    
    return FP_OK;
}

/* =============================================================================
 * Public API Functions
 * ============================================================================= */

fp_error_t fp_parse_skd_uri(const char *uri, uint8_t kid[16]) {
    if (!uri || !kid) return FP_ERR_NULL_POINTER;

    /* Two URI forms observed in the wild:
     *
     *  (1) Hex KID:  skd://<32 hex chars>[?...]
     *      Used by some content distributors; the 16-byte KID is embedded
     *      directly as a lowercase hex string after "skd://".
     *
     *  (2) Apple Music path:  skd://itunes.apple.com/p<id>/c<id>
     *      The URI is a content identifier, not a hex KID. Derive 16 bytes
     *      by taking the first 16 bytes of SHA-256(uri).
     */

    const char *skd_prefix = "skd://";
    size_t prefix_len = 6;
    if (strncmp(uri, skd_prefix, prefix_len) != 0) {
        return FP_ERR_PSSH_PARSE_FAILED;
    }

    const char *after_prefix = uri + prefix_len;

    /* Form (1): exactly 32 hex chars (optionally followed by '?') */
    const char *question_mark = strchr(after_prefix, '?');
    size_t segment_len = question_mark ?
                         (size_t)(question_mark - after_prefix) :
                         strlen(after_prefix);

    if (strchr(after_prefix, '/') == NULL && segment_len == 32) {
        /* Validate and decode hex KID */
        bool all_hex = true;
        for (size_t i = 0; i < 32 && all_hex; i++) {
            uint8_t v = hex_char_to_value(after_prefix[i]);
            if (v == 0xFF) all_hex = false;
        }
        if (all_hex) {
            for (size_t i = 0; i < 16; i++) {
                uint8_t high = hex_char_to_value(after_prefix[i * 2]);
                uint8_t low  = hex_char_to_value(after_prefix[i * 2 + 1]);
                kid[i] = (high << 4) | low;
            }
            return FP_OK;
        }
    }

    /* Form (2): path-style URI — derive KID as first 16 bytes of SHA-256(uri) */
    unsigned char digest[32];
    if (EVP_Digest(uri, strlen(uri), digest, NULL, EVP_sha256(), NULL) != 1) {
        return FP_ERR_PSSH_PARSE_FAILED;
    }
    memcpy(kid, digest, 16);
    return FP_OK;
}

fp_error_t fp_spc_build(
    const fp_key_pair_t *device_key,
    const uint8_t kid[16],
    const char *auth_token,
    const char *media_uri,
    uint8_t **out_spc,
    size_t *out_spc_size
) {
    if (!device_key || !kid || !out_spc || !out_spc_size) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Verify key type is RSA */
    if (device_key->type != FP_KEY_TYPE_RSA) {
        return FP_ERR_INVALID_KEY;
    }
    
    /* Generate random nonce */
    uint8_t nonce[FP_SPC_NONCE_SIZE];
    if (RAND_bytes(nonce, FP_SPC_NONCE_SIZE) != 1) {
        return FP_ERR_DEVICE_ID_GENERATION_FAILED;
    }
    
    /* Build authentication data */
    uint8_t *auth_data = NULL;
    size_t auth_data_size = 0;
    fp_error_t err = fp_build_auth_data(auth_token, media_uri, nonce, 
                                        &auth_data, &auth_data_size);
    if (err != FP_OK) {
        return err;
    }
    
    /* Calculate SPC size */
    size_t cert_size = device_key->public_key_size;
    size_t key_request_size = 16 + 8;  /* KID + placeholder */
    size_t timestamp_size = 8;
    size_t signature_size = 256;  /* RSA-2048 signature */
    
    /* SPC layout:
     * 0-3: Magic (4)
     * 4-5: Version (2)
     * 6-7: Flags (2)
     * 8-11: Total length (4)
     * 12-15: Certificate length (4)
     * 16-16+cert_size-1: Certificate (var)
     * ...: Nonce (32)
     * ...: Key request length (4)
     * ...: Key request (var)
     * ...: Timestamp (8)
     * ...: Auth data length (4)
     * ...: Auth data (var)
     * ...: Signature length (4)
     * ...: Signature (256)
     */
    
    size_t header_size = 16;
    size_t nonce_offset = header_size + cert_size;
    size_t key_req_len_offset = nonce_offset + FP_SPC_NONCE_SIZE;
    size_t key_req_offset = key_req_len_offset + 4;
    size_t timestamp_offset = key_req_offset + key_request_size;
    size_t auth_len_offset = timestamp_offset + timestamp_size;
    size_t auth_offset = auth_len_offset + 4;
    size_t sig_len_offset = auth_offset + auth_data_size;
    size_t sig_offset = sig_len_offset + 4;
    size_t total_size = sig_offset + signature_size;
    
    /* Allocate SPC buffer */
    uint8_t *spc = malloc(total_size);
    if (!spc) {
        free(auth_data);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    size_t offset = 0;
    
    /* Magic */
    memcpy(spc + offset, FP_SPC_MAGIC, 4);
    offset += 4;
    
    /* Version */
    uint16_t version = htobe16(FP_SPC_VERSION);
    memcpy(spc + offset, &version, 2);
    offset += 2;
    
    /* Flags */
    uint16_t flags = htobe16(FP_SPC_FLAG_SECURE_TRANSPORT | FP_SPC_FLAG_DEVICE_CERT);
    memcpy(spc + offset, &flags, 2);
    offset += 2;
    
    /* Total length — written now so it falls inside the signed region with its final value */
    uint32_t total_len_be = htobe32((uint32_t)total_size);
    memcpy(spc + offset, &total_len_be, 4);
    offset += 4;
    
    /* Certificate length */
    uint32_t cert_len = htobe32((uint32_t)cert_size);
    memcpy(spc + offset, &cert_len, 4);
    offset += 4;
    
    /* Certificate */
    memcpy(spc + offset, device_key->public_key, cert_size);
    offset += cert_size;
    
    /* Nonce */
    memcpy(spc + offset, nonce, FP_SPC_NONCE_SIZE);
    offset += FP_SPC_NONCE_SIZE;
    
    /* Key request length */
    uint32_t key_req_len = htobe32((uint32_t)key_request_size);
    memcpy(spc + offset, &key_req_len, 4);
    offset += 4;
    
    /* Key request (KID + placeholder) */
    memcpy(spc + offset, kid, 16);
    memset(spc + offset + 16, 0, 8);  /* Placeholder */
    offset += key_request_size;
    
    /* Timestamp */
    uint64_t timestamp = htobe64((uint64_t)time(NULL));
    memcpy(spc + offset, &timestamp, 8);
    offset += 8;
    
    /* Auth data length */
    uint32_t auth_len = htobe32((uint32_t)auth_data_size);
    memcpy(spc + offset, &auth_len, 4);
    offset += 4;
    
    /* Auth data */
    memcpy(spc + offset, auth_data, auth_data_size);
    offset += auth_data_size;
    
    /* Signature length */
    uint32_t sig_len = htobe32((uint32_t)signature_size);
    memcpy(spc + offset, &sig_len, 4);
    offset += 4;
    
    /* Sign the SPC (everything before signature) */
    size_t sig_data_len = offset;
    uint8_t signature[256];
    size_t actual_sig_len = sizeof(signature);
    
    err = fp_spc_sign(spc, sig_data_len, device_key, signature, &actual_sig_len);
    if (err != FP_OK) {
        fairplay_secure_zero(spc, total_size);
        free(spc);
        free(auth_data);
        return err;
    }

    /* Guard: RSA-2048 must always produce exactly signature_size bytes.
     * If not, the total_len field (already signed) would be wrong. */
    if (actual_sig_len != signature_size) {
        fairplay_secure_zero(spc, total_size);
        free(spc);
        free(auth_data);
        return FP_ERR_CERTIFICATE_SIGNING_FAILED;
    }

    /* sig_len field already holds the correct value (htobe32(signature_size));
     * no post-signing write needed or permitted — it would mutate the signed region. */

    /* Write signature bytes (outside the signed region) */
    memcpy(spc + sig_offset, signature, actual_sig_len);
    offset = sig_offset + actual_sig_len;

    free(auth_data);
    
    *out_spc = spc;
    *out_spc_size = offset;
    
    return FP_OK;
}

void fp_spc_free(uint8_t *spc, size_t spc_size) {
    if (spc) {
        fairplay_secure_zero(spc, spc_size);
        free(spc);
    }
}

fp_error_t fp_spc_get_nonce(
    const uint8_t *spc,
    size_t spc_size,
    uint8_t nonce[FP_SPC_NONCE_SIZE]
) {
    if (!spc || !nonce || spc_size < 48) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    
    /* Read certificate length */
    uint32_t cert_len;
    memcpy(&cert_len, spc + 12, 4);
    cert_len = be32toh(cert_len);
    
    /* Validate */
    if (16 + cert_len + FP_SPC_NONCE_SIZE > spc_size) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    
    /* Extract nonce */
    size_t nonce_offset = 16 + cert_len;
    memcpy(nonce, spc + nonce_offset, FP_SPC_NONCE_SIZE);
    
    return FP_OK;
}

fp_error_t fp_spc_verify(
    const uint8_t *spc,
    size_t spc_size,
    const uint8_t *public_key,
    size_t public_key_size
) {
    if (!spc || !public_key || spc_size < 48) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* D5 fix: Parse SPC structure to find signature length field */
    (void)public_key_size;
    
    /* Parse header */
    if (memcmp(spc, FP_SPC_MAGIC, 4) != 0) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    
    /* Read certificate length at offset 12 */
    uint32_t cert_len;
    memcpy(&cert_len, spc + 12, 4);
    cert_len = be32toh(cert_len);
    
    /* Calculate offsets matching fp_spc_build */
    size_t header_size = 16;
    size_t nonce_offset = header_size + cert_len;
    size_t key_req_len_offset = nonce_offset + FP_SPC_NONCE_SIZE;
    size_t key_req_offset = key_req_len_offset + 4;
    
    /* Read key request length */
    uint32_t key_req_len;
    if (spc_size < key_req_len_offset + 4) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    memcpy(&key_req_len, spc + key_req_len_offset, 4);
    key_req_len = be32toh(key_req_len);
    
    size_t timestamp_offset = key_req_offset + key_req_len;
    size_t auth_len_offset = timestamp_offset + 8;  /* timestamp is 8 bytes */
    
    /* Read auth data length */
    if (spc_size < auth_len_offset + 4) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    uint32_t auth_len;
    memcpy(&auth_len, spc + auth_len_offset, 4);
    auth_len = be32toh(auth_len);
    
    size_t auth_offset = auth_len_offset + 4;
    size_t sig_len_offset = auth_offset + auth_len;
    
    /* Read signature length from sig_len_offset */
    if (spc_size < sig_len_offset + 4) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    uint32_t sig_len;
    memcpy(&sig_len, spc + sig_len_offset, 4);
    sig_len = be32toh(sig_len);
    
    if (sig_len > 256 || spc_size < sig_len_offset + 4 + sig_len) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    
    /* Load public key */
    BIO *bio = BIO_new_mem_buf(public_key, (int)public_key_size);
    if (!bio) return FP_ERR_INVALID_PUBLIC_KEY;
    
    EVP_PKEY *pkey = PEM_read_bio_PUBKEY(bio, NULL, NULL, NULL);
    BIO_free(bio);
    if (!pkey) {
        bio = BIO_new_mem_buf(public_key, (int)public_key_size);
        pkey = d2i_PUBKEY_bio(bio, NULL);
        BIO_free(bio);
    }
    if (!pkey) return FP_ERR_INVALID_PUBLIC_KEY;
    
    /* Signature starts after signature length field */
    const uint8_t *signature = spc + sig_len_offset + 4;
    size_t data_len = sig_len_offset + 4;  /* Include signature length field */
    
    /* Verify signature */
    EVP_MD_CTX *mdctx = EVP_MD_CTX_new();
    if (!mdctx) {
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (EVP_DigestVerifyInit(mdctx, NULL, EVP_sha256(), NULL, pkey) != 1) {
        EVP_MD_CTX_free(mdctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_CERTIFICATE_INVALID_SIGNATURE;
    }
    
    if (EVP_DigestVerifyUpdate(mdctx, spc, data_len) != 1) {
        EVP_MD_CTX_free(mdctx);
        EVP_PKEY_free(pkey);
        return FP_ERR_CERTIFICATE_INVALID_SIGNATURE;
    }
    
    int result = EVP_DigestVerifyFinal(mdctx, signature, sig_len);
    EVP_MD_CTX_free(mdctx);
    EVP_PKEY_free(pkey);
    
    if (result != 1) {
        return FP_ERR_CERTIFICATE_INVALID_SIGNATURE;
    }
    
    return FP_OK;
}
