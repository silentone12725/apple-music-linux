/*
 * drm_linux.c — Linux-facing DRM API shim.
 *
 * The flat C API engine/core/drm/adamplay_backend.go calls via CGO for session
 * lifecycle and account credentials (read from drm/files/). FairPlay keys and
 * sample decryption go through drm_hybris.c and the Android libraries.
 *
 * Clean-room implementation.
 * Independently authored by Adam DRM Team.
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include "drm_types.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

/* ── Module state ─────────────────────────────────────────────────────────── */

static char g_base_dir[4096];
static drm_state_callback_t g_state_cb;
static void *g_state_ud;
static int g_initialized;
static pthread_mutex_t g_init_lock = PTHREAD_MUTEX_INITIALIZER;

/* ── File helpers ─────────────────────────────────────────────────────────── */

static char *read_file_trimmed(const char *path)
{
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    /* Credential files are a few hundred bytes; refuse anything absurd rather
     * than allocating whatever size a replaced file claims. */
    if (sz <= 0 || sz > 65536) {
        fclose(f);
        return NULL;
    }
    char *buf = malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    /* strip trailing whitespace / newlines */
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r' || buf[n - 1] == ' '))
        buf[--n] = '\0';
    return buf;
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
    /* Call under the lock: drm_shutdown clears the callback and its user data, which the caller
     * may free right after, so a call made after unlocking could reach freed memory. The callback
     * only queues the state (it never calls back into drm_*), so holding the lock is safe. */
    if (g_state_cb)
        g_state_cb(DRM_STATE_RUNNING, g_state_ud);
    pthread_mutex_unlock(&g_init_lock);

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

/* ── drm_get_account ──────────────────────────────────────────────────────── */

/*
 * Returns a malloc'd JSON string:
 *   {"storefront_id":"<sf>","dev_token":"","music_token":"<mt>"}
 *
 * The Go layer parses this as AccountInfo. DevToken is fetched separately
 * by the Go layer, so it is left empty here.
 */
/* Escape a string for use inside a JSON string literal. Returns malloc'd. */
static char *json_escape(const char *in)
{
    size_t len = strlen(in);
    char *out = malloc(len * 6 + 1);
    if (!out) return NULL;
    char *o = out;
    for (const unsigned char *p = (const unsigned char *)in; *p; p++) {
        if (*p == '"' || *p == '\\') {
            *o++ = '\\';
            *o++ = (char)*p;
        } else if (*p < 0x20) {
            o += sprintf(o, "\\u%04x", *p);
        } else {
            *o++ = (char)*p;
        }
    }
    *o = '\0';
    return out;
}

char *drm_get_account(void)
{
    char mt_path[4096], sf_path[4096];

    pthread_mutex_lock(&g_init_lock);
    /* A path that does not fit would be cut short and read the wrong file: refuse it. */
    int mt_n = snprintf(mt_path, sizeof(mt_path), "%s/MUSIC_TOKEN", g_base_dir);
    int sf_n = snprintf(sf_path, sizeof(sf_path), "%s/STOREFRONT_ID", g_base_dir);
    pthread_mutex_unlock(&g_init_lock);
    if (mt_n < 0 || (size_t)mt_n >= sizeof(mt_path) || sf_n < 0 || (size_t)sf_n >= sizeof(sf_path))
        return NULL;

    char *mt = read_file_trimmed(mt_path);
    char *sf = read_file_trimmed(sf_path);

    if (!mt || mt[0] == '\0') {
        free(mt);
        free(sf);
        return NULL;
    }

    /* Values come from files a user can edit: escape them, or a quote or
     * backslash would corrupt (or inject into) the JSON the Go layer parses. */
    char *mt_e = json_escape(mt);
    char *sf_e = json_escape(sf ? sf : "");
    free(mt);
    free(sf);
    if (!mt_e || !sf_e) {
        free(mt_e);
        free(sf_e);
        return NULL;
    }

    size_t len = 64 + strlen(mt_e) + strlen(sf_e);
    char *json = malloc(len);
    if (json)
        snprintf(json, len,
                 "{\"storefront_id\":\"%s\",\"dev_token\":\"\",\"music_token\":\"%s\"}",
                 sf_e, mt_e);
    free(mt_e);
    free(sf_e);
    return json;
}

/* ── HLS / progressive URL (delegated to Go layer) ───────────────────────── */

char *drm_get_hls_url(uint64_t id)
{
    (void)id;
    return NULL; /* Go provider builds the HLS URL from the catalog */
}

int drm_get_progressive_url(uint64_t id, char **url, char **dk, int *has_dec)
{
    (void)id;
    (void)url;
    (void)dk;
    (void)has_dec;
    return -1;
}

/* ── itun decryption (offline path — not used on streaming path) ──────────── */

int drm_decrypt_itun(uint64_t id, uint8_t *data, uint32_t in_sz, uint32_t *out_sz)
{
    (void)id;
    (void)data;
    (void)in_sz;
    (void)out_sz;
    return -1; /* not supported on the clean-room path */
}
