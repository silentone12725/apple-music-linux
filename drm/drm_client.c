/*
 * drm_client.c — DRM client implementation.
 *
 * Clean-room implementation based on DRM_CLEANROOM_SPEC.md.
 * Does not reference the proprietary wrapper/drm_lib.* implementation.
 *
 * Self-contained: Uses OpenSSL for AES-128 CBC decryption (no Android libraries).
 * Implements FairPlay IV derivation per spec (P4).
 */

/* Enable POSIX extensions for strdup */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <errno.h>
#include <openssl/aes.h>
#include <openssl/evp.h>

#include "drm_client.h"

/* ── Module State ───────────────────────────────────────────────────────────*/

struct drm_module_state {
    pthread_mutex_t lock;
    int initialized;
    int recovery_active;
    
    /* Callbacks */
    drm_auth_callback_t auth_callback;
    void *auth_user_data;
    drm_state_callback_t state_callback;
    void *state_user_data;
    
    /* Cached account info */
    char *storefront_id;
    char *dev_token;
    char *music_token;
    
    /* Paths */
    char *base_directory;
    char *lib64_directory;
    
    /* Key context cache (simple hash table) */
    struct drm_key_context_cache_entry *key_context_cache[DRM_KEY_CONTEXT_CACHE_SIZE];
    int key_context_count;
    
    /* Itun decryptor cache */
    struct drm_itun_context *itun_cache[DRM_ITUN_CACHE_SIZE];
    int itun_count;
};

static struct drm_module_state g_state = {
    .lock = PTHREAD_MUTEX_INITIALIZER,
    .initialized = 0,
    .recovery_active = 0,
};

/* ── File System Helper Functions (REQ-10.1) ───────────────────────────────*/

static const char *MPL_DB_DIR = "mpl_db";

static char *get_mpl_db_path(const char *filename)
{
    if (!g_state.base_directory || !filename) {
        return NULL;
    }
    
    size_t base_len = strlen(g_state.base_directory);
    size_t mpl_len = strlen(MPL_DB_DIR);
    size_t file_len = strlen(filename);
    
    char *path = malloc(base_len + 1 + mpl_len + 1 + file_len + 1);
    if (!path) {
        return NULL;
    }
    
    snprintf(path, base_len + mpl_len + file_len + 3,
             "%s/%s/%s", g_state.base_directory, MPL_DB_DIR, filename);
    return path;
}

static int ensure_mpl_db_dir(void)
{
    if (!g_state.base_directory) {
        return -1;
    }
    
    /* First ensure base directory exists */
    struct stat st;
    if (stat(g_state.base_directory, &st) != 0) {
        if (mkdir(g_state.base_directory, 0700) != 0 && errno != EEXIST) {
            return -1;
        }
    }
    
    char *dir_path = malloc(strlen(g_state.base_directory) + strlen(MPL_DB_DIR) + 2);
    if (!dir_path) {
        return -1;
    }
    
    snprintf(dir_path, strlen(g_state.base_directory) + strlen(MPL_DB_DIR) + 2,
             "%s/%s", g_state.base_directory, MPL_DB_DIR);
    
    int result = mkdir(dir_path, 0700);
    free(dir_path);
    
    return (result == 0 || errno == EEXIST) ? 0 : -1;
}

static int save_token(const char *filename, const char *content)
{
    if (!filename || !content) {
        return -1;
    }
    
    char *path = get_mpl_db_path(filename);
    if (!path) {
        return -1;
    }
    
    FILE *f = fopen(path, "w");
    free(path);
    
    if (!f) {
        return -1;
    }
    
    int result = fprintf(f, "%s", content) > 0 ? 0 : -1;
    fclose(f);
    
    return result;
}

static char *load_token(const char *filename)
{
    if (!filename) {
        return NULL;
    }
    
    char *path = get_mpl_db_path(filename);
    if (!path) {
        return NULL;
    }
    
    FILE *f = fopen(path, "r");
    free(path);
    
    if (!f) {
        return NULL;
    }
    
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    
    if (size <= 0 || size > 65536) {
        fclose(f);
        return NULL;
    }
    
    char *content = malloc(size + 1);
    if (!content) {
        fclose(f);
        return NULL;
    }
    
    size_t read_size = fread(content, 1, size, f);
    content[read_size] = '\0';
    fclose(f);
    
    return content;
}

/* Load file from arbitrary path (for credential files in base_directory) */
static char *load_file(const char *filepath)
{
    if (!filepath) {
        return NULL;
    }
    
    FILE *f = fopen(filepath, "r");
    if (!f) {
        return NULL;
    }
    
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    
    if (size <= 0 || size > 1024 * 1024) {  /* Max 1MB */
        fclose(f);
        return NULL;
    }
    
    char *content = malloc(size + 1);
    if (!content) {
        fclose(f);
        return NULL;
    }
    
    size_t read_size = fread(content, 1, size, f);
    content[read_size] = '\0';
    fclose(f);
    
    /* Remove trailing newline if present */
    while (read_size > 0 && (content[read_size-1] == '\n' || content[read_size-1] == '\r')) {
        content[--read_size] = '\0';
    }
    
    return content;
}

static void save_account_tokens(void)
{
    if (ensure_mpl_db_dir() != 0) {
        return;
    }
    
    if (g_state.storefront_id) {
        save_token("storefront_id", g_state.storefront_id);
    }
    if (g_state.dev_token) {
        save_token("dev_token", g_state.dev_token);
    }
    if (g_state.music_token) {
        save_token("music_token", g_state.music_token);
    }
}

static int load_account_tokens(void)
{
    char *token;
    int loaded = 0;
    
    /* First try to load from clean-room token files */
    token = load_token("storefront_id");
    if (token) {
        free(g_state.storefront_id);
        g_state.storefront_id = token;
        loaded++;
    }
    
    token = load_token("dev_token");
    if (token) {
        free(g_state.dev_token);
        g_state.dev_token = token;
        loaded++;
    }
    
    token = load_token("music_token");
    if (token) {
        free(g_state.music_token);
        g_state.music_token = token;
        loaded++;
    }
    
    /* If we have all tokens, we're done */
    if (loaded == 3) {
        return 0;
    }
    
    /* Try to load from original Apple Music credential files */
    if (g_state.base_directory) {
        char *cred_path = malloc(strlen(g_state.base_directory) + 32);
        if (cred_path) {
            /* Load MUSIC_TOKEN */
            snprintf(cred_path, strlen(g_state.base_directory) + 32,
                     "%s/MUSIC_TOKEN", g_state.base_directory);
            token = load_file(cred_path);
            if (token && !g_state.music_token) {
                g_state.music_token = token;
                loaded++;
            }
            
            /* Load STOREFRONT_ID */
            snprintf(cred_path, strlen(g_state.base_directory) + 32,
                     "%s/STOREFRONT_ID", g_state.base_directory);
            token = load_file(cred_path);
            if (token && !g_state.storefront_id) {
                g_state.storefront_id = token;
                loaded++;
            }
            
            /* dev_token is typically derived from session, use placeholder if not found */
            if (!g_state.dev_token) {
                g_state.dev_token = strdup("derived_from_session");
                loaded++;
            }
            
            free(cred_path);
        }
    }
    
    return (loaded == 3) ? 0 : -1;
}

/* ── Performance Timing Helpers (REQ-11.1) ──────────────────────────────────*/

double drm_get_time_seconds(void)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec + tv.tv_usec / 1000000.0;
}

double drm_get_time_ms(void)
{
    return drm_get_time_seconds() * 1000.0;
}

/* ── Simple Hash Function ───────────────────────────────────────────────────*/

static unsigned int hash_string(const char *str)
{
    unsigned int hash = 5381;
    int c;
    while ((c = (unsigned char)*str++)) {
        hash = ((hash << 5) + hash) + c;
    }
    return hash;
}

static unsigned int hash_key_context(const char *asset_id_str, const char *media_uri)
{
    unsigned int h1 = hash_string(asset_id_str);
    unsigned int h2 = hash_string(media_uri);
    return h1 ^ h2;
}

/* ── AES-128 CBC Decryption (REQ-8.1, REQ-8.2) ──────────────────────────────*/

/**
 * FairPlay IV derivation: prepend sample_number (big-endian) to base IV.
 *
 * The FairPlay IV is derived by XORing the base IV with a counter.
 * This follows the standard FairPlay pattern where each sample gets
 * a unique IV based on its sequence number.
 */
static void derive_iv(const uint8_t *base_iv, uint64_t sample_number, uint8_t *out_iv)
{
    /* Start with base IV */
    memcpy(out_iv, base_iv, DRM_AES_BLOCK_SIZE);
    
    /* XOR first 8 bytes with sample number (big-endian) */
    uint8_t counter[8];
    for (int i = 7; i >= 0; i--) {
        counter[i] = sample_number & 0xFF;
        sample_number >>= 8;
    }
    
    for (int i = 0; i < 8; i++) {
        out_iv[i] ^= counter[i];
    }
}

/**
 * AES-128 CBC decryption using OpenSSL.
 *
 * Implements the standard AES-128 CBC mode as defined in FIPS 197.
 */
static int aes128_cbc_decrypt(const uint8_t *key, const uint8_t *iv,
                               uint8_t *data, uint32_t data_len)
{
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return -1;
    }
    
    int ret = -1;
    int len;
    
    /* Initialize decryption context */
    if (EVP_DecryptInit_ex(ctx, EVP_aes_128_cbc(), NULL, key, iv) != 1) {
        goto cleanup;
    }
    
    /* Disable padding (FairPlay CBCS doesn't use padding) */
    EVP_CIPHER_CTX_set_padding(ctx, 0);
    
    /* Decrypt first block */
    if (EVP_DecryptUpdate(ctx, data, &len, data, data_len) != 1) {
        goto cleanup;
    }
    
    /* Finalize */
    uint8_t final[DRM_AES_BLOCK_SIZE];
    int final_len = 0;
    if (EVP_DecryptFinal_ex(ctx, final, &final_len) != 1) {
        goto cleanup;
    }
    
    /* Append final block if any */
    if (final_len > 0) {
        memcpy(data + len, final, final_len);
    }
    
    ret = 0;
    
cleanup:
    EVP_CIPHER_CTX_free(ctx);
    return ret;
}

/**
 * AES-128 CBC decryption with PKCS#7 padding (for itun).
 */
static int aes128_cbc_decrypt_padded(const uint8_t *key, const uint8_t *iv,
                                      uint8_t *data, uint32_t input_len,
                                      uint32_t *output_len)
{
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return -1;
    }
    
    int ret = -1;
    int len;
    
    /* Initialize decryption context */
    if (EVP_DecryptInit_ex(ctx, EVP_aes_128_cbc(), NULL, key, iv) != 1) {
        goto cleanup;
    }
    
    /* Enable padding for itun */
    EVP_CIPHER_CTX_set_padding(ctx, 1);
    
    /* Decrypt */
    if (EVP_DecryptUpdate(ctx, data, &len, data, input_len) != 1) {
        goto cleanup;
    }
    
    /* Finalize and get output length */
    uint8_t final[DRM_AES_BLOCK_SIZE];
    int final_len = 0;
    if (EVP_DecryptFinal_ex(ctx, final, &final_len) != 1) {
        goto cleanup;
    }
    
    *output_len = (uint32_t)(len + final_len);
    if (final_len > 0) {
        memcpy(data + len, final, final_len);
    }
    
    ret = 0;
    
cleanup:
    EVP_CIPHER_CTX_free(ctx);
    return ret;
}

/* ── Key Context Cache Functions ────────────────────────────────────────────*/

static drm_key_context_handle_t create_key_context(const char *asset_id_str,
                                                    const char *media_uri)
{
    struct drm_key_context *ctx = calloc(1, sizeof(struct drm_key_context));
    if (!ctx) {
        return NULL;
    }
    
    ctx->asset_id_str = strdup(asset_id_str);
    ctx->media_uri = strdup(media_uri);
    
    if (!ctx->asset_id_str || !ctx->media_uri) {
        free(ctx->asset_id_str);
        free(ctx->media_uri);
        free(ctx);
        return NULL;
    }
    
    /* Initialize with default key (would be populated from FairPlay license) */
    memset(ctx->aes_key, 0, DRM_AES_KEY_SIZE);
    memset(ctx->iv, 0, DRM_AES_BLOCK_SIZE);
    ctx->sample_number = 0;
    ctx->ref_count = 1;
    pthread_mutex_init(&ctx->lock, NULL);
    
    return ctx;
}

static void destroy_key_context(drm_key_context_handle_t ctx)
{
    if (!ctx) return;
    
    pthread_mutex_lock(&ctx->lock);
    ctx->ref_count--;
    int should_free = (ctx->ref_count <= 0);
    pthread_mutex_unlock(&ctx->lock);
    
    if (should_free) {
        free(ctx->asset_id_str);
        free(ctx->media_uri);
        pthread_mutex_destroy(&ctx->lock);
        free(ctx);
    }
}

static void free_key_context_cache(void)
{
    for (int i = 0; i < DRM_KEY_CONTEXT_CACHE_SIZE; i++) {
        struct drm_key_context_cache_entry *entry = g_state.key_context_cache[i];
        while (entry) {
            struct drm_key_context_cache_entry *next = entry->next;
            destroy_key_context(entry->ctx);
            free(entry->asset_id_str);
            free(entry->media_uri);
            free(entry);
            entry = next;
        }
        g_state.key_context_cache[i] = NULL;
    }
    g_state.key_context_count = 0;
}

/* ── Itun Context Cache Functions ───────────────────────────────────────────*/

static drm_itun_context_handle_t create_itun_context(drm_adam_id_t asset_id)
{
    struct drm_itun_context *ctx = calloc(1, sizeof(struct drm_itun_context));
    if (!ctx) {
        return NULL;
    }
    
    ctx->asset_id = asset_id;
    memset(ctx->aes_key, 0, DRM_AES_KEY_SIZE);
    memset(ctx->iv, 0, DRM_AES_BLOCK_SIZE);
    ctx->valid = 1;
    pthread_mutex_init(&ctx->lock, NULL);
    
    return ctx;
}

static void destroy_itun_context(drm_itun_context_handle_t ctx)
{
    if (!ctx) return;
    
    pthread_mutex_destroy(&ctx->lock);
    free(ctx);
}

static void free_itun_cache(void)
{
    for (int i = 0; i < DRM_ITUN_CACHE_SIZE; i++) {
        if (g_state.itun_cache[i]) {
            destroy_itun_context(g_state.itun_cache[i]);
            g_state.itun_cache[i] = NULL;
        }
    }
    g_state.itun_count = 0;
}

static drm_itun_context_handle_t find_or_create_itun_context(drm_adam_id_t asset_id)
{
    /* Search existing */
    for (int i = 0; i < DRM_ITUN_CACHE_SIZE; i++) {
        if (g_state.itun_cache[i] && g_state.itun_cache[i]->asset_id == asset_id) {
            return g_state.itun_cache[i];
        }
    }
    
    /* Create new */
    for (int i = 0; i < DRM_ITUN_CACHE_SIZE; i++) {
        if (!g_state.itun_cache[i]) {
            g_state.itun_cache[i] = create_itun_context(asset_id);
            if (g_state.itun_cache[i]) {
                g_state.itun_count++;
            }
            return g_state.itun_cache[i];
        }
    }
    
    return NULL;
}

/* ── Helper Functions ───────────────────────────────────────────────────────*/

static void call_state_callback(const char *state_name)
{
    if (g_state.state_callback && state_name) {
        g_state.state_callback(state_name, g_state.state_user_data);
    }
}

static int call_auth_callback(const char *challenge_type, char *buffer, int size)
{
    if (g_state.auth_callback && challenge_type && buffer && size > 0) {
        g_state.auth_callback(challenge_type, buffer, size, g_state.auth_user_data);
        return buffer[0] != '\0';
    }
    return 0;
}

/* ── drm_init (REQ-4.1) ─────────────────────────────────────────────────────*/

int drm_init(const struct drm_config *config)
{
    if (!config) {
        fprintf(stderr, "[drm] drm_init: null config\n");
        call_state_callback(DRM_STATE_FAILED);
        return -1;
    }
    
    pthread_mutex_lock(&g_state.lock);
    
    /* Debug: print config */
    fprintf(stderr, "[drm] drm_init: base_directory=%s\n", config->base_directory ? config->base_directory : "NULL");
    fprintf(stderr, "[drm] drm_init: username=%s\n", config->username ? config->username : "NULL");
    fprintf(stderr, "[drm] drm_init: password=%s\n", config->password ? (strlen(config->password) > 0 ? "SET" : "EMPTY") : "NULL");
    
    /* Free existing state if re-initializing */
    if (g_state.initialized) {
        free(g_state.storefront_id);
        g_state.storefront_id = NULL;
        free(g_state.dev_token);
        g_state.dev_token = NULL;
        free(g_state.music_token);
        g_state.music_token = NULL;
        free(g_state.base_directory);
        g_state.base_directory = NULL;
        free(g_state.lib64_directory);
        g_state.lib64_directory = NULL;
        free_key_context_cache();
        free_itun_cache();
    }
    
    /* Store paths */
    if (config->base_directory) {
        g_state.base_directory = strdup(config->base_directory);
    }
    if (config->lib64_directory) {
        g_state.lib64_directory = strdup(config->lib64_directory);
    }
    
    /* Store callbacks */
    g_state.auth_callback = config->auth_callback;
    g_state.auth_user_data = config->auth_user_data;
    g_state.state_callback = config->state_callback;
    g_state.state_user_data = config->state_user_data;
    
    pthread_mutex_unlock(&g_state.lock);
    
    /* Notify state transition */
    call_state_callback(DRM_STATE_STARTING);
    
    /* Try to load cached tokens first (REQ-10.1) */
    int has_cached_tokens = (load_account_tokens() == 0);
    
    /* Debug: print loaded tokens */
    fprintf(stderr, "[drm] drm_init: has_cached_tokens=%d\n", has_cached_tokens);
    fprintf(stderr, "[drm] drm_init: storefront_id=%s\n", g_state.storefront_id ? g_state.storefront_id : "NULL");
    fprintf(stderr, "[drm] drm_init: dev_token=%s\n", g_state.dev_token ? (strlen(g_state.dev_token) > 0 ? "SET" : "EMPTY") : "NULL");
    fprintf(stderr, "[drm] drm_init: music_token=%s\n", g_state.music_token ? (strlen(g_state.music_token) > 0 ? "SET" : "EMPTY") : "NULL");
    
    /* Simulate login if credentials provided (REQ-5.1) */
    if (config->username && config->password) {
        call_state_callback(DRM_STATE_LOGIN);
        
        /* Check if 2FA is needed (REQ-5.1) */
        char auth_buffer[DRM_AUTH_BUFFER_SIZE];
        memset(auth_buffer, 0, sizeof(auth_buffer));
        
        /* Simulate 2FA challenge */
        /* In real impl, this would check server response */
        if (0) {  /* Placeholder for 2FA detection */
            call_state_callback(DRM_STATE_WAITING_2FA);
            if (!call_auth_callback(DRM_CHALLENGE_2FA, auth_buffer, sizeof(auth_buffer))) {
                call_state_callback(DRM_STATE_FAILED);
                return -1;
            }
        }
        
        /* Fresh login: set new tokens */
        g_state.storefront_id = strdup("US");
        g_state.dev_token = strdup("placeholder_dev_token_base64");
        g_state.music_token = strdup("placeholder_music_token_base64");
    } else if (!has_cached_tokens) {
        /* No credentials and no cached tokens */
        call_state_callback(DRM_STATE_FAILED);
        return -1;
    }
    /* else: using cached tokens, already loaded above */
    
    /* Simulate FairPlay initialization */
    call_state_callback(DRM_STATE_INITIALIZING_FAIRPLAY);
    
    /* Placeholder implementation: In production, this would:
     * - Load Android libraries via libhybris (optional)
     * - Create request context with device configuration
     * - Authenticate if credentials provided
     * - Acquire playback lease from Apple servers
     * - Initialize FairPlay session */
    
    g_state.initialized = 1;
    
    /* Save tokens to file system (REQ-10.1) */
    save_account_tokens();
    
    call_state_callback(DRM_STATE_RUNNING);
    
    return 0;
}

/* ── drm_shutdown (REQ-4.2) ─────────────────────────────────────────────────*/

void drm_shutdown(void)
{
    pthread_mutex_lock(&g_state.lock);
    
    /* Prevent double shutdown */
    if (!g_state.initialized) {
        pthread_mutex_unlock(&g_state.lock);
        return;
    }
    
    /* Clear callbacks */
    g_state.auth_callback = NULL;
    g_state.state_callback = NULL;
    
    /* Free cached data */
    free(g_state.storefront_id);
    g_state.storefront_id = NULL;
    free(g_state.dev_token);
    g_state.dev_token = NULL;
    free(g_state.music_token);
    g_state.music_token = NULL;
    
    /* Free paths */
    free(g_state.base_directory);
    g_state.base_directory = NULL;
    free(g_state.lib64_directory);
    g_state.lib64_directory = NULL;
    
    /* Free caches */
    free_key_context_cache();
    free_itun_cache();
    
    g_state.initialized = 0;
    g_state.recovery_active = 0;
    
    pthread_mutex_unlock(&g_state.lock);
}

/* ── drm_get_account (REQ-4.3) ──────────────────────────────────────────────*/

char *drm_get_account(void)
{
    pthread_mutex_lock(&g_state.lock);
    
    if (!g_state.initialized ||
        !g_state.storefront_id ||
        !g_state.dev_token ||
        !g_state.music_token) {
        pthread_mutex_unlock(&g_state.lock);
        return NULL;
    }
    
    /* Build JSON: {"storefront_id":"…","dev_token":"…","music_token":"…"} */
    size_t len = strlen(g_state.storefront_id) + 
                 strlen(g_state.dev_token) + 
                 strlen(g_state.music_token) + 80;
    
    char *buf = malloc(len);
    if (buf) {
        snprintf(buf, len,
            "{\"storefront_id\":\"%s\",\"dev_token\":\"%s\",\"music_token\":\"%s\"}",
            g_state.storefront_id,
            g_state.dev_token,
            g_state.music_token);
    }
    
    pthread_mutex_unlock(&g_state.lock);
    return buf;
}

/* ── drm_get_hls_url (REQ-4.4) ──────────────────────────────────────────────*/

char *drm_get_hls_url(drm_adam_id_t asset_id)
{
    pthread_mutex_lock(&g_state.lock);
    int initialized = g_state.initialized;
    pthread_mutex_unlock(&g_state.lock);
    
    if (!initialized) {
        return NULL;
    }
    
    /* Placeholder: Returns deterministic URL based on asset_id.
     * Production: Request HLS URL from Apple servers. */
    
    /* Return a realistic-looking placeholder URL */
    char url[256];
    snprintf(url, sizeof(url),
             "https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/"
             "m4a/%04lld/%04lld/%04lld/stream.m3u8",
             (long long)(asset_id / 1000000) % 10000,
             (long long)(asset_id / 1000) % 10000,
             (long long)asset_id % 10000);
    
    return strdup(url);
}

/* ── drm_get_progressive_url (REQ-4.5) ──────────────────────────────────────*/

int drm_get_progressive_url(
    drm_adam_id_t asset_id,
    char **out_url,
    char **out_download_key,
    int *out_has_decryptor)
{
    if (!out_url || !out_download_key || !out_has_decryptor) {
        return -1;
    }
    
    pthread_mutex_lock(&g_state.lock);
    int initialized = g_state.initialized;
    pthread_mutex_unlock(&g_state.lock);
    
    if (!initialized) {
        *out_url = NULL;
        *out_download_key = NULL;
        *out_has_decryptor = 0;
        return -1;
    }
    
    /* Create itun decryptor context for this asset (called outside lock) */
    drm_itun_context_handle_t itun_ctx = find_or_create_itun_context(asset_id);
    
    /* Placeholder: Returns deterministic URL and download key based on asset_id.
     * Production: Request progressive URL from Apple servers. */
    
    char url[256];
    snprintf(url, sizeof(url),
             "https://video-ssl.itunes.apple.com/itunes-assets/Video/"
             "%04lld/%04lld/%04lld/video.m4a",
             (long long)(asset_id / 1000000) % 10000,
             (long long)(asset_id / 1000) % 10000,
             (long long)asset_id % 10000);
    
    *out_url = strdup(url);
    
    /* Generate a placeholder download key */
    char download_key[65];
    snprintf(download_key, sizeof(download_key),
             "%016llx%016llx%016llx%016llx",
             (unsigned long long)(asset_id >> 48),
             (unsigned long long)((asset_id >> 32) & 0xFFFF),
             (unsigned long long)((asset_id >> 16) & 0xFFFF),
             (unsigned long long)(asset_id & 0xFFFF));
    *out_download_key = strdup(download_key);
    
    *out_has_decryptor = (itun_ctx != NULL && itun_ctx->valid) ? 1 : 0;
    
    return 0;
}

/* ── drm_open_key_context (REQ-4.6) ─────────────────────────────────────────*/

drm_key_context_handle_t drm_open_key_context(
    const char *asset_id_str,
    const char *media_uri)
{
    if (!asset_id_str || !media_uri) {
        return NULL;
    }
    
    pthread_mutex_lock(&g_state.lock);
    int initialized = g_state.initialized;
    pthread_mutex_unlock(&g_state.lock);
    
    if (!initialized) {
        return NULL;
    }
    
    /* Compute hash for cache lookup */
    unsigned int hash = hash_key_context(asset_id_str, media_uri);
    int bucket = hash % DRM_KEY_CONTEXT_CACHE_SIZE;
    
    pthread_mutex_lock(&g_state.lock);
    
    /* Search for existing context */
    struct drm_key_context_cache_entry *entry = g_state.key_context_cache[bucket];
    while (entry) {
        if (strcmp(entry->asset_id_str, asset_id_str) == 0 &&
            strcmp(entry->media_uri, media_uri) == 0) {
            /* Found - increment ref count */
            pthread_mutex_lock(&entry->ctx->lock);
            entry->ctx->ref_count++;
            pthread_mutex_unlock(&entry->ctx->lock);
            pthread_mutex_unlock(&g_state.lock);
            return entry->ctx;
        }
        entry = entry->next;
    }
    
    /* Create new context */
    drm_key_context_handle_t ctx = create_key_context(asset_id_str, media_uri);
    if (!ctx) {
        pthread_mutex_unlock(&g_state.lock);
        return NULL;
    }
    
    /* Add to cache */
    entry = calloc(1, sizeof(struct drm_key_context_cache_entry));
    if (entry) {
        entry->asset_id_str = strdup(asset_id_str);
        entry->media_uri = strdup(media_uri);
        entry->ctx = ctx;
        entry->next = g_state.key_context_cache[bucket];
        g_state.key_context_cache[bucket] = entry;
        g_state.key_context_count++;
    }
    
    pthread_mutex_unlock(&g_state.lock);
    
    return ctx;
}

/* ── drm_decrypt_sample (REQ-4.7) ───────────────────────────────────────────*/

int drm_decrypt_sample(
    drm_key_context_handle_t key_context,
    uint8_t *sample_data,
    uint32_t sample_size)
{
    if (!key_context || !sample_data) {
        return -1;
    }
    
    /* Check alignment (REQ-4.7: sample_size must be multiple of 16) */
    if (sample_size % DRM_AES_BLOCK_SIZE != 0) {
        fprintf(stderr, "[drm] drm_decrypt_sample: size %u not aligned to 16 bytes\n",
                sample_size);
        return -1;
    }
    
    /* Lock context for thread-safe sample number increment */
    pthread_mutex_lock(&key_context->lock);
    uint64_t sample_num = key_context->sample_number++;
    pthread_mutex_unlock(&key_context->lock);
    
    /* Derive IV for this sample (FairPlay IV derivation) */
    uint8_t iv[DRM_AES_BLOCK_SIZE];
    derive_iv(key_context->iv, sample_num, iv);
    
    /* Perform AES-128 CBC decryption (REQ-8.1) */
    return aes128_cbc_decrypt(key_context->aes_key, iv, sample_data, sample_size);
}

/* ── drm_decrypt_itun (REQ-4.8) ─────────────────────────────────────────────*/

int drm_decrypt_itun(
    drm_adam_id_t asset_id,
    uint8_t *sample_data,
    uint32_t input_size,
    uint32_t *output_size)
{
    if (!sample_data || !output_size) {
        return -1;
    }
    
    pthread_mutex_lock(&g_state.lock);
    drm_itun_context_handle_t ctx = NULL;
    for (int i = 0; i < DRM_ITUN_CACHE_SIZE; i++) {
        if (g_state.itun_cache[i] && g_state.itun_cache[i]->asset_id == asset_id) {
            ctx = g_state.itun_cache[i];
            break;
        }
    }
    pthread_mutex_unlock(&g_state.lock);
    
    if (!ctx || !ctx->valid) {
        fprintf(stderr, "[drm] drm_decrypt_itun: no decryptor for asset %llu\n",
                (unsigned long long)asset_id);
        return -1;
    }
    
    /* Perform AES-128 CBC decryption with padding (REQ-8.3) */
    return aes128_cbc_decrypt_padded(ctx->aes_key, ctx->iv,
                                      sample_data, input_size, output_size);
}

/* ── drm_is_recovery_active (REQ-4.9) ───────────────────────────────────────*/

int drm_is_recovery_active(void)
{
    pthread_mutex_lock(&g_state.lock);
    int active = g_state.recovery_active;
    pthread_mutex_unlock(&g_state.lock);
    
    return active;
}
