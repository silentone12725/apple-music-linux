/*
 * drm_types.h — Data structures for the DRM client.
 *
 * Clean-room implementation based on DRM_CLEANROOM_SPEC.md.
 * Does not reference the proprietary wrapper/drm_lib.* implementation.
 */

#pragma once

/* Enable POSIX extensions for strdup */
#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif

#include <stdint.h>
#include <stddef.h>
#include <pthread.h>

/* ── Constants (must be before struct definitions) ──────────────────────────*/

/** AES-128 key size in bytes */
#define DRM_AES_KEY_SIZE 16

/** AES block size in bytes */
#define DRM_AES_BLOCK_SIZE 16

/* ── Primitive Types ────────────────────────────────────────────────────────*/

/* 64-bit unsigned Apple Music asset identifier */
typedef uint64_t drm_adam_id_t;

/* 16-byte hex string device identifier */
typedef char drm_device_id_t[33];  /* 16 hex + null terminator */

/* Variable-length base64-encoded token */
typedef char *drm_token_t;

/* Null-terminated URL string */
typedef char *drm_url_t;

/* ── Callback Types ─────────────────────────────────────────────────────────*/

/**
 * Authentication callback: called when credentials or 2FA code is needed.
 *
 * @param challenge_type  "credentials" or "2fa"
 * @param output_buffer   Caller-provided buffer for response
 * @param buffer_size     Size of output_buffer in bytes
 * @param user_data       Opaque pointer passed to drm_init()
 *
 * For "credentials": write "username:password\0" to output_buffer
 * For "2fa": write "123456\0" (6-digit code) to output_buffer
 */
typedef void (*drm_auth_callback_t)(
    const char *challenge_type,
    char *output_buffer,
    int buffer_size,
    void *user_data
);

/**
 * State callback: called on DRM state transitions.
 *
 * @param state_name  One of: "STARTING", "LOGIN", "WAITING_2FA",
 *                    "INITIALIZING_FAIRPLAY", "RUNNING", "FAILED"
 * @param user_data   Opaque pointer passed to drm_init()
 */
typedef void (*drm_state_callback_t)(
    const char *state_name,
    void *user_data
);

/* ── Configuration Structure ────────────────────────────────────────────────*/

/**
 * DRM initialization configuration.
 *
 * All path fields should point to memory that remains valid during drm_init().
 */
struct drm_config {
    const char *base_directory;     /**< Path containing mpl_db/ directory */
    const char *lib64_directory;    /**< Path to system/lib64/ with Android .so files */
    const char *username;           /**< NULL for session-reuse; set for fresh login */
    const char *password;           /**< NULL for session-reuse; set for fresh login */
    const char *device_info;        /**< 9-field slash-separated device string, or NULL for default */
    int offline_only;               /**< 1 = force download method; 0 = play method */
    drm_auth_callback_t auth_callback;  /**< Called for credential/2FA challenges */
    void *auth_user_data;           /**< Opaque data passed to auth_callback */
    drm_state_callback_t state_callback; /**< Called on state transitions */
    void *state_user_data;          /**< Opaque data passed to state_callback */
};

/* ── Key Context Handle ─────────────────────────────────────────────────────*/

/**
 * FairPlay key delivery context for sample decryption.
 *
 * Contains AES-128 keys derived from the pssh box and license response.
 * The context is cached internally; repeated calls to drm_open_key_context()
 * with the same asset_id_str and media_uri return the same handle.
 */
struct drm_key_context {
    char *asset_id_str;           /* Asset ID as string (for caching) */
    char *media_uri;              /* Media URI (for caching) */
    uint8_t aes_key[DRM_AES_KEY_SIZE];  /* AES-128 decryption key */
    uint8_t iv[DRM_AES_BLOCK_SIZE];     /* Initialization vector base */
    uint64_t sample_number;        /* Current sample counter for IV derivation */
    int ref_count;                 /* Reference count for caching */
    pthread_mutex_t lock;          /* Thread safety for ref_count */
    void *hybris_ctx;              /* non-NULL: hybris SVFootHillPContext for this key */
    int   hybris_ctx_alien;        /* 1 = owned by libandroidappmusic.so, do not free */
};

/**
 * Opaque handle for key delivery context.
 *
 * Obtained via drm_open_key_context(), used with drm_decrypt_sample().
 * Valid until drm_shutdown() is called.
 */
typedef struct drm_key_context *drm_key_context_handle_t;

/* ── Itun Decryptor Context ─────────────────────────────────────────────────*/

/**
 * Context for itun-encrypted progressive sample decryption.
 *
 * Created by drm_get_progressive_url(), used by drm_decrypt_itun().
 * Handles AES-128 CBC decryption with padding removal.
 */
struct drm_itun_context {
    drm_adam_id_t asset_id;       /* Asset ID this decryptor is for */
    uint8_t aes_key[DRM_AES_KEY_SIZE];  /* AES-128 decryption key */
    uint8_t iv[DRM_AES_BLOCK_SIZE];     /* Initialization vector */
    int valid;                     /* 1 if decryptor is ready */
    pthread_mutex_t lock;          /* Thread safety */
};

typedef struct drm_itun_context *drm_itun_context_handle_t;

/* ── Key Context Cache Entry ────────────────────────────────────────────────*/

/**
 * Cache entry for key context lookup.
 *
 * Used internally to cache key contexts by asset_id_str + media_uri.
 */
struct drm_key_context_cache_entry {
    char *asset_id_str;           /* Asset ID string (key) */
    char *media_uri;              /* Media URI (key) */
    drm_key_context_handle_t ctx; /* Cached context */
    struct drm_key_context_cache_entry *next; /* Next in hash chain */
};

/* ── Constants for Cache ────────────────────────────────────────────────────*/

/** Maximum number of cached key contexts (hash buckets) */
#define DRM_KEY_CONTEXT_CACHE_SIZE 64

/** Maximum total key contexts across all buckets (LRU cap) */
#define DRM_KEY_CONTEXT_MAX_TOTAL 256

/** Maximum number of cached itun decryptors */
#define DRM_ITUN_CACHE_SIZE 16

/* ── Account Information Structure ──────────────────────────────────────────*/

/**
 * Account information returned by drm_get_account().
 *
 * The JSON string has this structure:
 * {
 *   "storefront_id": "<2-char country code>",
 *   "dev_token": "<base64-encoded device token>",
 *   "music_token": "<base64-encoded music access token>"
 * }
 */
typedef struct drm_account_info drm_account_info_t;

/* ── Constants ──────────────────────────────────────────────────────────────*/

/** Default device info string (9 fields, slash-separated) */
#define DRM_DEFAULT_DEVICE_INFO \
    "Music/4.9/Android/10/Samsung S9/7663313/en-US/en-US/dc28071e981c439e"

/** FairPlay scheme ID: 0x66707332 = "fps2" in ASCII */
#define DRM_FAIRPLAY_SCHEME_ID 0x66707332UL

/** Maximum authentication buffer size */
#define DRM_AUTH_BUFFER_SIZE 256

/** Android ID length in hex characters */
#define DRM_ANDROID_ID_LENGTH 16

/* ── State Names ────────────────────────────────────────────────────────────*/

#define DRM_STATE_STARTING              "STARTING"
#define DRM_STATE_LOGIN                 "LOGIN"
#define DRM_STATE_WAITING_2FA           "WAITING_2FA"
#define DRM_STATE_INITIALIZING_FAIRPLAY "INITIALIZING_FAIRPLAY"
#define DRM_STATE_RUNNING               "RUNNING"
#define DRM_STATE_FAILED                "FAILED"

/* ── Challenge Types ────────────────────────────────────────────────────────*/

#define DRM_CHALLENGE_CREDENTIALS "credentials"
#define DRM_CHALLENGE_2FA         "2fa"
