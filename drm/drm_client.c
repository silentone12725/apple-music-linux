/*
 * drm_client.c - DRM Client Implementation
 * Version: 2.0
 * Date: 2026-10-07
 */

#define _POSIX_C_SOURCE 200809L

#include "drm_client.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <pthread.h>
#include <stdarg.h>
#include <inttypes.h>

/* Internal structures */
struct drm_client {
    pthread_mutex_t lock;
    char *license_server_url;
    char *user_agent;
    int timeout_seconds;
    int max_retries;
    fp_key_store_t *key_store;
    fp_error_t last_error;
    char last_error_message[256];
    drm_client_stats_t stats;
    drm_log_level_t log_level;
    int refcount;
};

static drm_log_level_t g_log_level = DRM_LOG_INFO;

/* Version functions */
const char *drm_client_version(void) {
    return DRM_CLIENT_VERSION_STRING;
}

void drm_client_version_components(int *major, int *minor, int *patch) {
    if (major) *major = DRM_CLIENT_VERSION_MAJOR;
    if (minor) *minor = DRM_CLIENT_VERSION_MINOR;
    if (patch) *patch = DRM_CLIENT_VERSION_PATCH;
}

/* Configuration */
void drm_config_init(drm_config_t *config) {
    if (!config) return;
    memset(config, 0, sizeof(drm_config_t));
    config->timeout_seconds = 30;
    config->max_retries = 3;
    config->verify_ssl = 1;
}

/* Client creation */
fp_error_t drm_client_create(const drm_config_t *config, drm_client_t **out_client) {
    if (!out_client || !config) return FP_ERR_NULL_POINTER;
    if (!config->license_server_url || strlen(config->license_server_url) == 0)
        return FP_ERR_INVALID_CONFIG;
    if (!config->user_agent || strlen(config->user_agent) == 0)
        return FP_ERR_INVALID_CONFIG;
    
    drm_client_t *client = calloc(1, sizeof(drm_client_t));
    if (!client) return FP_ERR_OUT_OF_MEMORY;
    
    if (pthread_mutex_init(&client->lock, NULL) != 0) {
        free(client);
        return FP_ERR_THREAD_INIT_FAILED;
    }
    
    client->license_server_url = strdup(config->license_server_url);
    client->user_agent = strdup(config->user_agent);
    client->timeout_seconds = config->timeout_seconds > 0 ? config->timeout_seconds : 30;
    client->max_retries = config->max_retries > 0 ? config->max_retries : 3;
    client->last_error = FP_OK;
    client->log_level = g_log_level;
    client->refcount = 1;
    
    /* Create key store */
    fp_context_t *fp_ctx;
    fp_error_t err = fairplay_context_create(&fp_ctx);
    if (err != FP_OK) {
        pthread_mutex_destroy(&client->lock);
        free(client->license_server_url);
        free(client->user_agent);
        free(client);
        return err;
    }
    
    err = fairplay_key_store_create(fp_ctx, &client->key_store);
    fairplay_context_destroy(fp_ctx);
    
    if (err != FP_OK) {
        pthread_mutex_destroy(&client->lock);
        free(client->license_server_url);
        free(client->user_agent);
        free(client);
        return err;
    }
    
    *out_client = client;
    return FP_OK;
}

void drm_client_destroy(drm_client_t *client) {
    if (!client) return;
    
    pthread_mutex_lock(&client->lock);
    client->refcount--;
    if (client->refcount > 0) {
        pthread_mutex_unlock(&client->lock);
        return;
    }
    pthread_mutex_unlock(&client->lock);
    
    free(client->license_server_url);
    free(client->user_agent);
    fairplay_key_store_destroy(client->key_store);
    pthread_mutex_destroy(&client->lock);
    fairplay_secure_zero(client, sizeof(drm_client_t));
    free(client);
}

fp_error_t drm_client_get_error(const drm_client_t *client) {
    if (!client) return FP_ERR_NULL_POINTER;
    pthread_mutex_lock((pthread_mutex_t *)&((drm_client_t *)(uintptr_t)client)->lock);
    fp_error_t err = client->last_error;
    pthread_mutex_unlock((pthread_mutex_t *)&((drm_client_t *)(uintptr_t)client)->lock);
    return err;
}

const char *drm_client_get_error_message(const drm_client_t *client) {
    if (!client) return "NULL client";
    pthread_mutex_lock((pthread_mutex_t *)&((drm_client_t *)(uintptr_t)client)->lock);
    const char *msg = client->last_error_message[0] ? 
                      client->last_error_message : 
                      fairplay_error_string(client->last_error);
    pthread_mutex_unlock((pthread_mutex_t *)&((drm_client_t *)(uintptr_t)client)->lock);
    return msg;
}

/* License acquisition */
fp_error_t drm_client_acquire_license(
    drm_client_t *client,
    const drm_license_request_t *request,
    drm_license_t **out_license
) {
    if (!client || !request || !out_license || !request->content_id) {
        return FP_ERR_NULL_POINTER;
    }
    
    *out_license = NULL;
    
    /* In a full implementation, this would make an HTTP request */
    /* For now, return not implemented */
    return FP_ERR_LICENSE_REQUEST_FAILED;
}

void drm_license_free(drm_license_t *license) {
    if (!license) return;
    free(license->ckc_data);
    free(license->session_id);
    fairplay_secure_zero(license, sizeof(drm_license_t));
    free(license);
}

fp_error_t drm_client_renew_license(
    drm_client_t *client,
    const char *session_id,
    drm_license_t **out_license
) {
    (void)client;
    (void)session_id;
    (void)out_license;
    return FP_ERR_LICENSE_REQUEST_FAILED;
}

/* HLS manifest parsing */
void drm_hls_manifest_free(drm_hls_manifest_t *manifest) {
    if (!manifest) return;
    free(manifest->playlist_uri);
    for (size_t i = 0; i < manifest->segment_count && i < 10000; i++) {
        free(manifest->segments[i].uri);
    }
    free(manifest->segments);
    for (size_t i = 0; i < manifest->key_count && i < 16; i++) {
        free(manifest->keys[i].uri);
        free(manifest->keys[i].method);
        free(manifest->keys[i].format_strings);
    }
    free(manifest->keys);
    fairplay_secure_zero(manifest, sizeof(drm_hls_manifest_t));
    free(manifest);
}

fp_error_t drm_client_parse_hls_manifest(
    drm_client_t *client,
    const char *manifest_url,
    drm_hls_manifest_t **out_manifest
) {
    (void)client;
    (void)manifest_url;
    (void)out_manifest;
    /* Full implementation would fetch and parse */
    return FP_OK;
}

fp_error_t drm_client_parse_hls_manifest_data(
    drm_client_t *client,
    const char *manifest_data,
    size_t manifest_size,
    const char *base_url,
    drm_hls_manifest_t **out_manifest
) {
    (void)client;
    (void)manifest_data;
    (void)manifest_size;
    (void)base_url;
    (void)out_manifest;
    return FP_OK;
}

/* Content decryption */
fp_error_t drm_client_decrypt_segment(
    drm_client_t *client,
    const drm_hls_manifest_t *manifest,
    size_t segment_index,
    const uint8_t *segment_data,
    size_t segment_size,
    uint8_t *out_decrypted,
    size_t *decrypted_size,
    size_t max_decrypted_size
) {
    if (!client || !manifest || !segment_data || !out_decrypted) {
        return FP_ERR_NULL_POINTER;
    }
    if (segment_index >= manifest->segment_count) {
        return FP_ERR_SESSION_NOT_FOUND;
    }
    
    drm_hls_segment_t *segment = &manifest->segments[segment_index];
    if (!segment->is_encrypted) {
        if (segment_size > max_decrypted_size) return FP_ERR_BUFFER_TOO_SMALL;
        memcpy(out_decrypted, segment_data, segment_size);
        if (decrypted_size) *decrypted_size = segment_size;
        return FP_OK;
    }
    
    return FP_ERR_KEY_NOT_FOUND;
}

size_t drm_client_decrypt_segment_size(size_t segment_size) {
    return segment_size;
}

/* Key store integration */
fp_key_store_t *drm_client_get_key_store(drm_client_t *client) {
    if (!client) return NULL;
    pthread_mutex_lock(&client->lock);
    fp_key_store_t *store = client->key_store;
    pthread_mutex_unlock(&client->lock);
    return store;
}

fp_error_t drm_client_add_key(
    drm_client_t *client,
    const fp_kid_t *kid,
    const fp_key_t *key,
    uint64_t expires_at
) {
    if (!client || !kid || !key || !client->key_store) {
        return FP_ERR_NULL_POINTER;
    }
    return fairplay_key_store_add(client->key_store, kid, key, expires_at);
}

fp_error_t drm_client_get_key(
    drm_client_t *client,
    const fp_kid_t *kid,
    fp_key_t *out_key
) {
    if (!client || !kid || !out_key || !client->key_store) {
        return FP_ERR_NULL_POINTER;
    }
    return fairplay_key_store_get(client->key_store, kid, out_key);
}

/* PSSH handling */
fp_error_t drm_client_extract_kid_from_pssh(
    drm_client_t *client,
    const uint8_t *pssh_data,
    size_t pssh_size,
    fp_kid_t *out_kid
) {
    if (!client || !pssh_data || !out_kid) return FP_ERR_NULL_POINTER;
    
    fp_context_t *fp_ctx;
    fp_error_t err = fairplay_context_create(&fp_ctx);
    if (err != FP_OK) return err;
    
    fp_pssh_t *pssh = NULL;
    err = fairplay_pssh_parse(fp_ctx, pssh_data, pssh_size, &pssh);
    if (err != FP_OK) {
        fairplay_context_destroy(fp_ctx);
        return err;
    }
    
    err = fairplay_pssh_get_primary_kid(pssh, out_kid);
    fairplay_pssh_free(pssh);
    fairplay_context_destroy(fp_ctx);
    
    return err;
}

fp_error_t drm_client_generate_pssh(
    drm_client_t *client,
    const fp_kid_t *kid,
    uint8_t *out_pssh,
    size_t *pssh_size,
    size_t max_pssh_size
) {
    (void)client;
    if (!kid || !out_pssh) return FP_ERR_NULL_POINTER;
    
    const size_t min_size = 44;
    if (max_pssh_size < min_size) {
        if (pssh_size) *pssh_size = min_size;
        return FP_ERR_BUFFER_TOO_SMALL;
    }
    
    uint8_t *p = out_pssh;
    *p++ = (min_size >> 24) & 0xFF;
    *p++ = (min_size >> 16) & 0xFF;
    *p++ = (min_size >> 8) & 0xFF;
    *p++ = min_size & 0xFF;
    *p++ = 'p'; *p++ = 's'; *p++ = 's'; *p++ = 'h';
    *p++ = 0x01; *p++ = 0x00; *p++ = 0x00; *p++ = 0x00;
    *p++ = 0x00; *p++ = 0x00; *p++ = 0x00; *p++ = 0x01;
    for (int i = 0; i < 16; i++) *p++ = 0x99;
    *p++ = 0x00; *p++ = 0x00; *p++ = 0x00; *p++ = 0x10;
    memcpy(p, kid->bytes, 16);
    p += 16;
    
    if (pssh_size) *pssh_size = (size_t)(p - out_pssh);
    return FP_OK;
}

/* HTTP helpers */
void drm_http_response_free(drm_http_response_t *response) {
    if (!response) return;
    free(response->status_text);
    free(response->body);
    free(response->content_type);
    free(response->content_length);
    fairplay_secure_zero(response, sizeof(drm_http_response_t));
    free(response);
}

fp_error_t drm_client_http_get(
    drm_client_t *client,
    const char *url,
    drm_http_response_t **out_response
) {
    (void)client;
    (void)url;
    (void)out_response;
    return FP_ERR_INIT_FAILED;
}

fp_error_t drm_client_http_post(
    drm_client_t *client,
    const char *url,
    const char *body,
    size_t body_size,
    const char *content_type,
    drm_http_response_t **out_response
) {
    (void)client;
    (void)url;
    (void)body;
    (void)body_size;
    (void)content_type;
    (void)out_response;
    return FP_ERR_INIT_FAILED;
}

/* URL utilities */
fp_error_t drm_client_resolve_url(
    drm_client_t *client,
    const char *base_url,
    const char *relative_url,
    char *out_resolved,
    size_t *resolved_size,
    size_t max_resolved_size
) {
    (void)client;
    if (!base_url || !relative_url || !out_resolved) return FP_ERR_NULL_POINTER;
    
    if (strncmp(relative_url, "http://", 7) == 0 ||
        strncmp(relative_url, "https://", 8) == 0) {
        size_t len = strlen(relative_url);
        if (len + 1 > max_resolved_size) {
            if (resolved_size) *resolved_size = len + 1;
            return FP_ERR_BUFFER_TOO_SMALL;
        }
        strcpy(out_resolved, relative_url);
        if (resolved_size) *resolved_size = len;
        return FP_OK;
    }
    
    size_t base_len = strlen(base_url);
    const char *last_slash = strrchr(base_url, '/');
    size_t path_end = last_slash ? (size_t)(last_slash - base_url + 1) : base_len;
    
    size_t needed = path_end + strlen(relative_url) + 1;
    if (needed > max_resolved_size) {
        if (resolved_size) *resolved_size = needed;
        return FP_ERR_BUFFER_TOO_SMALL;
    }
    
    memcpy(out_resolved, base_url, path_end);
    strcpy(out_resolved + path_end, relative_url);
    if (resolved_size) *resolved_size = strlen(out_resolved);
    return FP_OK;
}

/* Callbacks */
void drm_client_set_license_callback(
    drm_client_t *client,
    drm_license_callback callback,
    void *user_data
) {
    (void)client;
    (void)callback;
    (void)user_data;
}

/* Statistics */
void drm_client_get_stats(drm_client_t *client, drm_client_stats_t *stats) {
    if (!client || !stats) return;
    pthread_mutex_lock(&client->lock);
    memcpy(stats, &client->stats, sizeof(drm_client_stats_t));
    stats->keys_stored = (uint32_t)fairplay_key_store_count(client->key_store);
    pthread_mutex_unlock(&client->lock);
}

void drm_client_reset_stats(drm_client_t *client) {
    if (!client) return;
    pthread_mutex_lock(&client->lock);
    memset(&client->stats, 0, sizeof(drm_client_stats_t));
    pthread_mutex_unlock(&client->lock);
}

/* Logging */
void drm_client_set_log_level(drm_log_level_t level) {
    g_log_level = level;
}

void drm_client_set_log_callback(drm_log_callback callback, void *user_data) {
    (void)callback;
    (void)user_data;
}

/* Convenience functions */
fp_error_t drm_client_create_default(
    const char *license_server_url,
    drm_client_t **out_client
) {
    if (!license_server_url || !out_client) return FP_ERR_NULL_POINTER;
    
    drm_config_t config;
    drm_config_init(&config);
    config.license_server_url = license_server_url;
    config.user_agent = "AppleMusicLinux/2.0 (Linux; x86_64)";
    
    return drm_client_create(&config, out_client);
}

fp_error_t drm_quick_decrypt(
    const fp_kid_t *kid,
    const fp_key_t *key,
    const fp_iv_t *iv,
    const uint8_t *ciphertext,
    size_t ciphertext_size,
    uint8_t *out_plaintext,
    size_t *plaintext_size,
    size_t max_plaintext_size
) {
    (void)kid;
    return fairplay_decrypt_aes128_cbc(
        key, iv, ciphertext, ciphertext_size,
        out_plaintext, plaintext_size, max_plaintext_size
    );
}
