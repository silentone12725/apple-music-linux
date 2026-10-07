/*
 * fp_ckc_parser.c - Content Key Container (CKC) Parser Implementation
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay CKC parsing.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
 */

#define _POSIX_C_SOURCE 200809L

#include "fp_ckc_parser.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <endian.h>

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
 * Safe string copy with null termination guarantee.
 */
static void safe_strncpy(char *dest, const char *src, size_t dest_size, size_t src_size) {
    if (dest_size == 0) return;
    
    size_t copy_size = src_size < dest_size - 1 ? src_size : dest_size - 1;
    memcpy(dest, src, copy_size);
    dest[copy_size] = '\0';
}

/**
 * Read big-endian value with bounds checking.
 */
static fp_error_t read_be_value(
    const uint8_t *data,
    size_t data_size,
    size_t offset,
    void *out,
    size_t out_size
) {
    if (offset + out_size > data_size) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    
    uint64_t tmp;
    memcpy(&tmp, data + offset, out_size);
    
    switch (out_size) {
        case 1:
            *(uint8_t *)out = (uint8_t)tmp;
            break;
        case 2:
            *(uint16_t *)out = be16toh((uint16_t)tmp);
            break;
        case 4:
            *(uint32_t *)out = be32toh((uint32_t)tmp);
            break;
        case 8:
            *(uint64_t *)out = be64toh(tmp);
            break;
        default:
            memcpy(out, data + offset, out_size);
            break;
    }
    
    return FP_OK;
}

/* =============================================================================
 * Public API Functions
 * ============================================================================= */

void fp_ckc_init(fp_ckc_t *ckc) {
    if (!ckc) return;
    
    memset(ckc, 0, sizeof(fp_ckc_t));
    ckc->expires_at = 0;
    ckc->lease_duration = 0;
    ckc->renewal_offset = 0;
    ckc->format_version = 0;
    ckc->flags = 0;
    ckc->raw_data = NULL;
    ckc->raw_size = 0;
}

fp_error_t fp_ckc_parse(
    const uint8_t *ckc_data,
    size_t ckc_size,
    fp_ckc_t *out_ckc
) {
    if (!ckc_data || !out_ckc || ckc_size < 8) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_ckc_init(out_ckc);
    
    /* Check magic bytes */
    if (memcmp(ckc_data, FP_CKC_MAGIC, 4) != 0) {
        /* Try alternative magic or raw format */
        /* Some implementations may not have magic bytes */
    }
    
    size_t offset = 0;
    
    /* Skip magic if present */
    if (memcmp(ckc_data, FP_CKC_MAGIC, 4) == 0) {
        offset = 4;
    }
    
    /* Read format version (4 bytes) */
    fp_error_t err = read_be_value(ckc_data, ckc_size, offset, 
                                   &out_ckc->format_version, 4);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 4;
    
    /* Read flags (4 bytes) */
    err = read_be_value(ckc_data, ckc_size, offset, &out_ckc->flags, 4);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 4;
    
    /* Read KID (16 bytes) */
    if (offset + FP_CKC_KID_SIZE > ckc_size) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    memcpy(out_ckc->kid, ckc_data + offset, FP_CKC_KID_SIZE);
    offset += FP_CKC_KID_SIZE;
    
    /* Read encrypted key length (4 bytes) */
    uint32_t enc_key_len;
    err = read_be_value(ckc_data, ckc_size, offset, &enc_key_len, 4);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 4;
    
    /* Validate encrypted key length */
    if (enc_key_len == 0 || enc_key_len > FP_CKC_MAX_ENCRYPTED_KEY_SIZE) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    
    if (offset + enc_key_len > ckc_size) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    
    /* Read encrypted key */
    memcpy(out_ckc->encrypted_key, ckc_data + offset, enc_key_len);
    out_ckc->encrypted_key_size = enc_key_len;
    offset += enc_key_len;
    
    /* Read expiration timestamp (8 bytes) */
    err = read_be_value(ckc_data, ckc_size, offset, &out_ckc->expires_at, 8);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 8;
    
    /* Read lease duration (4 bytes) */
    err = read_be_value(ckc_data, ckc_size, offset, &out_ckc->lease_duration, 4);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 4;
    
    /* Read renewal offset (4 bytes) */
    err = read_be_value(ckc_data, ckc_size, offset, &out_ckc->renewal_offset, 4);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 4;
    
    /* Read session ID length (4 bytes) */
    uint32_t session_id_len;
    err = read_be_value(ckc_data, ckc_size, offset, &session_id_len, 4);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 4;
    
    /* Read session ID */
    if (session_id_len > 0) {
        /* D10 fix: Always advance offset, regardless of whether we store the field */
        if (offset + session_id_len > ckc_size) {
            return FP_ERR_CKC_PARSE_FAILED;
        }
        /* Only store if within size limit */
        if (session_id_len < FP_CKC_MAX_SESSION_ID_SIZE) {
            safe_strncpy(out_ckc->session_id, (const char *)(ckc_data + offset),
                        FP_CKC_MAX_SESSION_ID_SIZE, session_id_len);
        }
        offset += session_id_len;
    }
    
    /* Read renewal URL length (4 bytes) */
    uint32_t renewal_url_len;
    err = read_be_value(ckc_data, ckc_size, offset, &renewal_url_len, 4);
    if (err != FP_OK) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    offset += 4;
    
    /* Read renewal URL */
    if (renewal_url_len > 0) {
        /* D10 fix: Always advance offset, regardless of whether we store the field */
        if (offset + renewal_url_len > ckc_size) {
            return FP_ERR_CKC_PARSE_FAILED;
        }
        /* Only store if within size limit */
        if (renewal_url_len < FP_CKC_MAX_RENEWAL_URL_SIZE) {
            safe_strncpy(out_ckc->renewal_url, (const char*)(ckc_data + offset),
                        FP_CKC_MAX_RENEWAL_URL_SIZE, renewal_url_len);
        }
        offset += renewal_url_len;
    }
    
    /* Store raw data for potential re-encoding */
    out_ckc->raw_data = malloc(ckc_size);
    if (out_ckc->raw_data) {
        memcpy(out_ckc->raw_data, ckc_data, ckc_size);
        out_ckc->raw_size = ckc_size;
    }
    
    return FP_OK;
}

void fp_ckc_free(fp_ckc_t *ckc) {
    if (!ckc) return;
    
    if (ckc->raw_data) {
        fairplay_secure_zero(ckc->raw_data, ckc->raw_size);
        free(ckc->raw_data);
        ckc->raw_data = NULL;
    }
    
    fairplay_secure_zero(ckc->kid, FP_CKC_KID_SIZE);
    fairplay_secure_zero(ckc->encrypted_key, ckc->encrypted_key_size);
    
    fp_ckc_init(ckc);
}

bool fp_ckc_is_expired(const fp_ckc_t *ckc) {
    if (!ckc) return true;
    
    /* Persistent keys don't expire */
    if (ckc->flags & FP_CKC_FLAG_PERSISTENT) {
        return false;
    }
    
    uint64_t now = (uint64_t)time(NULL);
    return now >= ckc->expires_at;
}

uint32_t fp_ckc_time_until_expiry(const fp_ckc_t *ckc) {
    if (!ckc) return 0;
    
    /* Persistent keys have infinite time */
    if (ckc->flags & FP_CKC_FLAG_PERSISTENT) {
        return UINT32_MAX;
    }
    
    uint64_t now = (uint64_t)time(NULL);
    if (now >= ckc->expires_at) {
        return 0;
    }
    
    return (uint32_t)(ckc->expires_at - now);
}

bool fp_ckc_should_renew(const fp_ckc_t *ckc) {
    if (!ckc) return false;
    
    /* Check if renewable */
    if (!(ckc->flags & FP_CKC_FLAG_RENEWABLE)) {
        return false;
    }
    
    /* Check if we're within the renewal window */
    uint32_t time_left = fp_ckc_time_until_expiry(ckc);
    return time_left <= ckc->renewal_offset;
}
