/*
 * drm_linux.c — Linux-facing DRM API shim.
 *
 * Implements the flat C API that engine/core/drm/native_backend.go calls via CGO.
 * Key acquisition happens entirely in the Go layer (aacstream.AcquireKey via
 * Widevine); this layer only needs to:
 *
 *   1. Hold a key context (aes_key + base_iv).
 *   2. Do in-place AES-128-CBC sample decryption.
 *   3. Return account credentials read from drm/files/.
 *
 * Clean-room implementation.
 * Independently authored by AML DRM Team.
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "drm_types.h"
#include "fairplay.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#include <openssl/evp.h>

/* ── Module state ─────────────────────────────────────────────────────────── */

static char g_base_dir[4096];
static drm_state_callback_t  g_state_cb;
static void                 *g_state_ud;
static int                   g_initialized;
static pthread_mutex_t       g_init_lock = PTHREAD_MUTEX_INITIALIZER;

/* ── File helpers ─────────────────────────────────────────────────────────── */

static char *read_file_trimmed(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz <= 0) { fclose(f); return NULL; }
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    /* strip trailing whitespace / newlines */
    while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r' || buf[n-1] == ' '))
        buf[--n] = '\0';
    return buf;
}

/* ── AES-128-CBC in-place ─────────────────────────────────────────────────── */

/*
 * Derive IV: XOR base_iv with sample_number (big-endian, low 8 bytes).
 * With base_iv=zeros and sample_number=0 → IV=zeros (CBCS ALAC pattern).
 */
static void derive_iv(const uint8_t base_iv[16], uint64_t sn, uint8_t out[16])
{
    memcpy(out, base_iv, 16);
    for (int i = 0; i < 8; i++)
        out[15 - i] ^= (uint8_t)(sn >> (i * 8));
}

/* Decrypt `n` bytes in-place with AES-128-CBC (no padding). n must be a
 * multiple of 16. Returns 0 on success, -1 on error. */
static int aes128_cbc_decrypt(const uint8_t key[16], const uint8_t iv[16],
                               uint8_t *data, size_t n)
{
    if (n == 0 || (n & 0xf) != 0) return -1;

    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) return -1;

    int ok = EVP_DecryptInit_ex(ctx, EVP_aes_128_cbc(), NULL, key, iv);
    if (ok) EVP_CIPHER_CTX_set_padding(ctx, 0);

    int outlen = 0;
    if (ok) ok = EVP_DecryptUpdate(ctx, data, &outlen, data, (int)n);
    EVP_CIPHER_CTX_free(ctx);

    return (ok && (size_t)outlen == n) ? 0 : -1;
}

/* ── drm_init / drm_shutdown ──────────────────────────────────────────────── */

int drm_init(const struct drm_config *cfg)
{
    pthread_mutex_lock(&g_init_lock);

    if (cfg && cfg->base_directory && cfg->base_directory[0]) {
        strncpy(g_base_dir, cfg->base_directory, sizeof(g_base_dir) - 1);
        g_base_dir[sizeof(g_base_dir) - 1] = '\0';
    } else {
        g_base_dir[0] = '\0';
    }

    if (cfg) {
        g_state_cb = cfg->state_callback;
        g_state_ud = cfg->state_user_data;
    }

    g_initialized = 1;
    pthread_mutex_unlock(&g_init_lock);

    if (g_state_cb)
        g_state_cb(DRM_STATE_RUNNING, g_state_ud);

    return 0;
}

void drm_shutdown(void)
{
    pthread_mutex_lock(&g_init_lock);
    g_initialized = 0;
    g_base_dir[0] = '\0';
    g_state_cb = NULL;
    g_state_ud = NULL;
    pthread_mutex_unlock(&g_init_lock);
}

int drm_is_recovery_active(void) { return 0; }

/* ── drm_get_account ──────────────────────────────────────────────────────── */

/*
 * Returns a malloc'd JSON string:
 *   {"storefront_id":"<sf>","dev_token":"","music_token":"<mt>"}
 *
 * The Go layer parses this as AccountInfo and uses MusicToken for the
 * Widevine key request.  DevToken is fetched separately by the Go layer
 * via ampapi.GetToken() so we leave it empty here.
 */
char *drm_get_account(void)
{
    char mt_path[4096], sf_path[4096];

    snprintf(mt_path, sizeof(mt_path), "%s/MUSIC_TOKEN",    g_base_dir);
    snprintf(sf_path, sizeof(sf_path), "%s/STOREFRONT_ID",  g_base_dir);

    char *mt = read_file_trimmed(mt_path);
    char *sf = read_file_trimmed(sf_path);

    if (!mt || mt[0] == '\0') {
        free(mt);
        free(sf);
        return NULL;
    }

    /* Allocate enough room for both values plus JSON scaffolding */
    size_t len = 64 + (mt ? strlen(mt) : 0) + (sf ? strlen(sf) : 0);
    char *json = malloc(len);
    if (!json) { free(mt); free(sf); return NULL; }

    snprintf(json, len,
             "{\"storefront_id\":\"%s\",\"dev_token\":\"\",\"music_token\":\"%s\"}",
             sf ? sf : "", mt);

    free(mt);
    free(sf);
    return json;
}

/* ── HLS / progressive URL (delegated to Go layer) ───────────────────────── */

char *drm_get_hls_url(uint64_t id)
{
    (void)id;
    return NULL;  /* Go provider builds the HLS URL from the catalog */
}

int drm_get_progressive_url(uint64_t id, char **url, char **dk, int *has_dec)
{
    (void)id; (void)url; (void)dk; (void)has_dec;
    return -1;
}

/* ── Key context ──────────────────────────────────────────────────────────── */

/*
 * drm_open_key_context: allocate and return a key context.
 *
 * The actual content key is injected by the Go layer immediately after via
 * drm_set_key_context_key() — the Go layer fetches it through Widevine
 * (aacstream.AcquireKey) before calling us.  We allocate the struct with a
 * zero key so the context is safe to hold even before the key arrives.
 */
drm_key_context_handle_t drm_open_key_context(const char *asset_id,
                                               const char *media_uri)
{
    struct drm_key_context *kc = calloc(1, sizeof(*kc));
    if (!kc) return NULL;

    kc->asset_id_str = asset_id  ? strdup(asset_id)  : NULL;
    kc->media_uri    = media_uri ? strdup(media_uri) : NULL;
    kc->ref_count    = 1;
    memset(kc->aes_key, 0, sizeof(kc->aes_key));
    memset(kc->iv,      0, sizeof(kc->iv));
    kc->sample_number = 0;

    if (pthread_mutex_init(&kc->lock, NULL) != 0) {
        free(kc->asset_id_str);
        free(kc->media_uri);
        free(kc);
        return NULL;
    }

    return kc;
}

int drm_set_key_context_key(drm_key_context_handle_t kc,
                             const uint8_t *key, const uint8_t *iv)
{
    if (!kc || !key) return -1;

    pthread_mutex_lock(&kc->lock);
    memcpy(kc->aes_key, key, DRM_AES_KEY_SIZE);
    if (iv)
        memcpy(kc->iv, iv, DRM_AES_BLOCK_SIZE);
    else
        memset(kc->iv, 0, DRM_AES_BLOCK_SIZE);
    pthread_mutex_unlock(&kc->lock);

    return 0;
}

/* ── Sample decryption ────────────────────────────────────────────────────── */

/*
 * drm_decrypt_sample_at: decrypt `n` bytes in-place with derived IV.
 *
 * IV = derive_iv(kc->iv, sample_number).
 * For CBCS ALAC: kc->iv=zeros, sample_number=0 → IV=zeros.
 * Only whole 16-byte blocks are decrypted (CBCS partial-block pass-through).
 */
int drm_decrypt_sample_at(drm_key_context_handle_t kc,
                           uint8_t *data, uint32_t n, uint64_t sn)
{
    if (!kc || !data) return -1;

    /* Truncate to whole blocks */
    uint32_t blocks = (n >> 4) << 4;
    if (blocks == 0) return 0;

    pthread_mutex_lock(&kc->lock);
    uint8_t iv[16];
    derive_iv(kc->iv, sn, iv);
    uint8_t key[16];
    memcpy(key, kc->aes_key, 16);
    pthread_mutex_unlock(&kc->lock);

    int ret = aes128_cbc_decrypt(key, iv, data, blocks);
    fairplay_secure_zero(key, sizeof(key));
    fairplay_secure_zero(iv,  sizeof(iv));
    return ret;
}

/* drm_decrypt_sample: same as drm_decrypt_sample_at(kc, data, n, 0). */
int drm_decrypt_sample(drm_key_context_handle_t kc, uint8_t *data, uint32_t n)
{
    return drm_decrypt_sample_at(kc, data, n, 0);
}

/*
 * drm_decrypt_sample_with_sample_iv: decrypt using the IV that is embedded
 * as the first 16 bytes of the sample blob.  Not used by the CBCS ALAC path;
 * provided for API completeness.
 */
int drm_decrypt_sample_with_sample_iv(drm_key_context_handle_t kc,
                                       uint8_t *data, uint32_t n)
{
    if (!kc || !data || n < 16) return -1;

    /* First 16 bytes are the IV; ciphertext follows */
    const uint8_t *iv = data;
    uint8_t *ct = data + 16;
    uint32_t ct_n = n - 16;
    uint32_t blocks = (ct_n >> 4) << 4;
    if (blocks == 0) return 0;

    pthread_mutex_lock(&kc->lock);
    uint8_t key[16];
    memcpy(key, kc->aes_key, 16);
    pthread_mutex_unlock(&kc->lock);

    int ret = aes128_cbc_decrypt(key, iv, ct, blocks);
    fairplay_secure_zero(key, sizeof(key));
    return ret;
}

/* ── itun decryption (offline path — not used on streaming path) ──────────── */

int drm_decrypt_itun(uint64_t id, uint8_t *data, uint32_t in_sz, uint32_t *out_sz)
{
    (void)id; (void)data; (void)in_sz; (void)out_sz;
    return -1;  /* not supported on the clean-room path */
}

/* ── Misc stubs ───────────────────────────────────────────────────────────── */

int drm_decrypt_samples_batch(drm_key_context_handle_t kc,
                               uint8_t **samples, const uint32_t *sizes, uint32_t count)
{
    if (!kc || !samples || !sizes) return -1;
    for (uint32_t i = 0; i < count; i++) {
        if (drm_decrypt_sample(kc, samples[i], sizes[i]) != 0)
            return -1;
    }
    return 0;
}

int  drm_https_init(int h2)         { (void)h2; return 0; }
void drm_https_shutdown(void)       {}
int  drm_https_fetch(const char *u, const char *m, const uint8_t *b, uint32_t bl,
                     uint8_t **od, uint32_t *ol, int *os)
     { (void)u;(void)m;(void)b;(void)bl;(void)od;(void)ol;(void)os; return -1; }

int  drm_cookie_init(void)          { return 0; }
void drm_cookie_shutdown(void)      {}
int  drm_cookie_init_at(const char *d) { (void)d; return 0; }
int  drm_cookie_get_for_url(const char *u, char *b, size_t s)
     { (void)u;(void)b;(void)s; return -1; }
void drm_cookie_parse_set_cookie(const char *s)                  { (void)s; }
void drm_cookie_parse_set_cookie_for_host(const char *s, const char *h)
     { (void)s;(void)h; }

int  drm_jwt_parse(const char *t, char **p, uint32_t *l)
     { (void)t;(void)p;(void)l; return -1; }
int  drm_jwt_get_claim(const char *p, const char *c, char **v)
     { (void)p;(void)c;(void)v; return -1; }

int  drm_device_guid_get(char *b, size_t s)  { (void)b;(void)s; return -1; }
int  drm_device_guid_set(const char *g)      { (void)g; return -1; }
int  drm_device_guid_is_configured(void)     { return 0; }

double drm_get_time_seconds(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

double drm_get_time_ms(void)
{
    return drm_get_time_seconds() * 1000.0;
}
