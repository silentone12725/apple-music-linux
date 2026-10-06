/*
 * drm_hybris.c — Hybris-based Android FairPlay library loader.
 *
 * Loads libCoreFP.so (7 obfuscated exports) and libandroidappmusic.so
 * (NfcRKVnxuKZy04KWbdFu71Ou) from the vseg Android rootfs via libhybris.
 *
 * Backend selection (in order):
 *   1. libCoreFP.so direct — experimental, requires context from CKC
 *   2. libandroidappmusic.so — proven path (same as vseg libdrm-native.so)
 *
 * libCoreFP.so exports (from static analysis of x86_64 Android build):
 *   dku592fbFAj(void*)            — 1-arg, dispatcher 0x58f870 — likely init/state
 *   lxpgvVMLd0S7uRl(void*)        — 1-arg, dispatcher 0x3a6b30 — likely get-cert
 *   fdjkDSAFjklaf2s(int, void*)   — 2-arg, dispatcher 0x3a6b30 — likely get-cert(type, out)
 *   X46O5IeS(int, void*, void*)   — 3-arg, dispatcher 0x58f870 — likely SPC/CKC op
 *   YlCJ3lg(6 args)               — 6-arg, dispatcher 0x58f870 — likely decrypt
 *   WIn9UJ86JKdV4dM(7 args+xmm0) — 7-arg+xmm0, dispatcher 0x58f870 — decrypt+IV
 *   JNI_OnLoad(JavaVM*, void*)     — JNI init (skipped for direct use)
 *
 * NfcRKVnxuKZy04KWbdFu71Ou signature (from Frida probe / frida_decryptor_replay.js):
 *   int fn(void *ctx, uint32_t selector, void *cipher_in, void *plain_out, uint32_t len)
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <stdint.h>
#include <setjmp.h>
#include <signal.h>
#include <pthread.h>

#include "drm_hybris.h"
#include "embedded_loader.h"
#include "native/drm_lib.h"

/* ── Types for hybris functions ─────────────────────────────────────────────*/

typedef void *(*android_dlopen_fn)(const char *filename, int flags);
typedef void *(*android_dlsym_fn)(void *handle, const char *symbol);
typedef int   (*android_dlclose_fn)(void *handle);

/* ── libCoreFP.so export function pointers ──────────────────────────────────*/

/* dku592fbFAj(void *ctx) — 1-arg, big dispatcher */
typedef int (*corefp_dku_fn)(void *);

/* lxpgvVMLd0S7uRl(void *ctx) — 1-arg, alt dispatcher (likely get-cert) */
typedef int (*corefp_lxp_fn)(void *);

/* fdjkDSAFjklaf2s(int type, void *out) — 2-arg, alt dispatcher */
typedef int (*corefp_fdj_fn)(int, void *);

/* X46O5IeS(int op, void *in, void *out) — 3-arg, big dispatcher (SPC/CKC) */
typedef int (*corefp_x46_fn)(int, void *, void *);

/*
 * YlCJ3lg — 6 args, big dispatcher.
 * Exact types unknown; using (void*, void*, void*, void*, uint32_t, uint32_t)
 * as a starting guess from arg-count analysis.
 */
typedef int (*corefp_ylc_fn)(void *, void *, void *, void *, uint32_t, uint32_t);

/*
 * WIn9UJ86JKdV4dM — 7 args + xmm0 (128-bit IV), big dispatcher.
 * Most likely the per-sample decrypt: (ctx, sel, in, out, len, iv_hi, iv_lo)
 * where iv_hi/iv_lo come from xmm0. Guessing integer types for now.
 */
typedef int (*corefp_win_fn)(void *, uint32_t, void *, void *, uint32_t, uint64_t, uint64_t);

/* ── NfcRKVnxuKZy04KWbdFu71Ou signature ─────────────────────────────────────*/

typedef int (*nfc_decrypt_fn)(void *ctx, uint32_t selector, void *cipher_in, void *plain_out, uint32_t len);

/*
 * SVFootHillPContext constructor — builds a decrypt context from CKC bytes.
 * Mangled name for: SVFootHillPContext::SVFootHillPContext(
 *     const std::string &ckc, const unsigned long &selector)
 */
typedef void (*pcontext_ctor_str_ulong_fn)(
    void *self,
    const void *ckc_string,   /* libc++ std::string ptr */
    const unsigned long *selector
);

/* ── Forward declarations ────────────────────────────────────────────────────*/

int hybris_fairplay_init(const char *base_dir, const char *device_info, const char *lib64_dir,
                         const char *username, const char *password);

/* ── Global module state ─────────────────────────────────────────────────────*/

static struct {
    pthread_mutex_t lock;
    int initialized;

    /* hybris host library (Linux) */
    void *hybris_core;
    android_dlopen_fn  android_dlopen;
    android_dlsym_fn   android_dlsym;
    android_dlclose_fn android_dlclose;

    /* libCoreFP.so (Android, loaded via hybris) */
    void *corefp_handle;
    corefp_dku_fn  fp_dku;   /* dku592fbFAj */
    corefp_lxp_fn  fp_lxp;   /* lxpgvVMLd0S7uRl */
    corefp_fdj_fn  fp_fdj;   /* fdjkDSAFjklaf2s */
    corefp_x46_fn  fp_x46;   /* X46O5IeS */
    corefp_ylc_fn  fp_ylc;   /* YlCJ3lg */
    corefp_win_fn  fp_win;   /* WIn9UJ86JKdV4dM */

    /* libandroidappmusic.so (Android, loaded via hybris) — proven path */
    void *appmusic_handle;
    nfc_decrypt_fn          nfc_decrypt;        /* NfcRKVnxuKZy04KWbdFu71Ou */
    pcontext_ctor_str_ulong_fn pcontext_ctor;   /* SVFootHillPContext ctor */

    /* libstoreservicescore.so handle (dependency of appmusic, kept for dlsym) */
    void *ssc_handle;

    int corefp_available;   /* libCoreFP.so loaded and exports resolved */
    int appmusic_available; /* libandroidappmusic.so loaded */
    int fairplay_inited;    /* hybris_fairplay_init() succeeded */
} g_hybris = {
    .lock = PTHREAD_MUTEX_INITIALIZER,
    .initialized = 0,
};

/* ── libc++ std::string helpers ─────────────────────────────────────────────*/

/*
 * Build a libc++ (NDK r19b) std::string from a byte array.
 * Short-string optimisation: if len < 16, store inline (byte0 = len<<1).
 * Long form: byte0 = len<<1|1, bytes 8-15 = len, bytes 16-23 = data ptr.
 *
 * We always allocate on heap so long-form is always safe.
 */
struct libcxx_string {
    uint8_t repr[24]; /* 24 bytes: cap+flag | pad | len | ptr (long form) */
    char   *heap;
};

static void libcxx_string_init(struct libcxx_string *s, const uint8_t *data, size_t len)
{
    memset(s, 0, sizeof(*s));
    s->heap = malloc(len + 1);
    if (!s->heap) return;
    memcpy(s->heap, data, len);
    s->heap[len] = '\0';

    /* long form: bit0 = 1 */
    s->repr[0] = 0x01; /* flags: long form, no capacity stored */
    /* bytes 8..15: length as uint64_t little-endian */
    uint64_t u = (uint64_t)len;
    memcpy(s->repr + 8, &u, 8);
    /* bytes 16..23: data pointer */
    void *p = s->heap;
    memcpy(s->repr + 16, &p, sizeof(void *));
}

static void libcxx_string_destroy(struct libcxx_string *s)
{
    free(s->heap);
    s->heap = NULL;
}

/* ── SIGSEGV guard for probing ───────────────────────────────────────────────*/

static __thread sigjmp_buf g_probe_jmp;
static __thread int        g_probe_active;

static void probe_segv_handler(int sig)
{
    (void)sig;
    if (g_probe_active) siglongjmp(g_probe_jmp, 1);
}

#define PROBE_CALL(label, expr)                                                 \
    do {                                                                        \
        struct sigaction sa_new = {0}, sa_old;                                  \
        sa_new.sa_handler = probe_segv_handler;                                 \
        sigemptyset(&sa_new.sa_mask);                                           \
        sigaction(SIGSEGV, &sa_new, &sa_old);                                   \
        g_probe_active = 1;                                                     \
        int _rv = -999;                                                         \
        if (sigsetjmp(g_probe_jmp, 1) == 0) { _rv = (int)(intptr_t)(expr); }   \
        else { fprintf(stderr, "[hybris] " label ": SIGSEGV\n"); }              \
        g_probe_active = 0;                                                     \
        sigaction(SIGSEGV, &sa_old, NULL);                                      \
        if (_rv != -999) fprintf(stderr, "[hybris] " label ": rv=%d\n", _rv);   \
    } while (0)

/* ── Init ────────────────────────────────────────────────────────────────────*/

int hybris_backend_init(
    const char *hybris_linker_dir,
    const char *lib64_dir,
    const char *hybris_core_path)
{
    (void)hybris_core_path;

    /* libhybris-core.so dlopens its Android linker shim (q.so) from
     * $HYBRIS_LINKER_DIR (default /tmp/hybris-linker); it must be set before
     * the embedded core is loaded. */
    if (hybris_linker_dir && hybris_linker_dir[0])
        setenv("HYBRIS_LINKER_DIR", hybris_linker_dir, 1);
    /* Bionic system libs (libc/libm/libdl/libz/libcurl/...) are not embedded;
     * hybris resolves them from the Android lib64 dir, as in the vseg backend. */
    if (lib64_dir && lib64_dir[0]) {
        setenv("HYBRIS_LD_LIBRARY_PATH", lib64_dir, 1);
        setenv("HYBRIS_ANDROID_LIB64", lib64_dir, 1);
    }

    pthread_mutex_lock(&g_hybris.lock);
    if (g_hybris.initialized) { pthread_mutex_unlock(&g_hybris.lock); return 0; }

    /*
     * Load libhybris-core.so and all Android .so dependencies from their
     * embedded binary blobs via anonymous memfds — no rootfs directory needed.
     */
    if (embedded_loader_init() != 0) {
        fprintf(stderr, "[hybris] embedded_loader_init failed: %s\n",
                embedded_dlerror());
        pthread_mutex_unlock(&g_hybris.lock);
        return -1;
    }

    /*
     * Wire android_dlopen/dlsym to the embedded loader wrappers.
     * Signatures are identical to the raw hybris exports, so no casts needed.
     */
    g_hybris.android_dlopen  = embedded_dlopen;
    g_hybris.android_dlsym   = embedded_dlsym_in;
    g_hybris.android_dlclose = NULL; /* not exposed by embedded loader */

    /* ── Load libCoreFP.so (experimental direct path) ── */
    /* Loaded by real path from HYBRIS_LD_LIBRARY_PATH (rootfs/system/lib64) */
    g_hybris.corefp_handle = g_hybris.android_dlopen("libCoreFP.so", RTLD_NOW);
    if (g_hybris.corefp_handle) {
        g_hybris.fp_dku = (corefp_dku_fn) g_hybris.android_dlsym(g_hybris.corefp_handle, "dku592fbFAj");
        g_hybris.fp_lxp = (corefp_lxp_fn) g_hybris.android_dlsym(g_hybris.corefp_handle, "lxpgvVMLd0S7uRl");
        g_hybris.fp_fdj = (corefp_fdj_fn) g_hybris.android_dlsym(g_hybris.corefp_handle, "fdjkDSAFjklaf2s");
        g_hybris.fp_x46 = (corefp_x46_fn) g_hybris.android_dlsym(g_hybris.corefp_handle, "X46O5IeS");
        g_hybris.fp_ylc = (corefp_ylc_fn) g_hybris.android_dlsym(g_hybris.corefp_handle, "YlCJ3lg");
        g_hybris.fp_win = (corefp_win_fn)  g_hybris.android_dlsym(g_hybris.corefp_handle, "WIn9UJ86JKdV4dM");

        g_hybris.corefp_available =
            (g_hybris.fp_dku && g_hybris.fp_lxp && g_hybris.fp_fdj &&
             g_hybris.fp_x46 && g_hybris.fp_ylc && g_hybris.fp_win);

        fprintf(stderr, "[hybris] libCoreFP.so: %s (dku=%p lxp=%p fdj=%p x46=%p ylc=%p win=%p)\n",
                g_hybris.corefp_available ? "all exports resolved" : "partial",
                (void*)g_hybris.fp_dku, (void*)g_hybris.fp_lxp,
                (void*)g_hybris.fp_fdj, (void*)g_hybris.fp_x46,
                (void*)g_hybris.fp_ylc, (void*)g_hybris.fp_win);
    } else {
        fprintf(stderr, "[hybris] libCoreFP.so: load failed\n");
    }

    /* ── Load libandroidappmusic.so (proven path) ── */
    /* Must also load libstoreservicescore.so first (dependency) */
    g_hybris.ssc_handle = g_hybris.android_dlopen("libstoreservicescore.so", RTLD_NOW | RTLD_GLOBAL);
    if (!g_hybris.ssc_handle)
        fprintf(stderr, "[hybris] libstoreservicescore.so: load failed (may still work)\n");

    g_hybris.appmusic_handle = g_hybris.android_dlopen("libandroidappmusic.so", RTLD_NOW);
    if (g_hybris.appmusic_handle) {
        g_hybris.nfc_decrypt = (nfc_decrypt_fn)
            g_hybris.android_dlsym(g_hybris.appmusic_handle, "NfcRKVnxuKZy04KWbdFu71Ou");
        g_hybris.pcontext_ctor = (pcontext_ctor_str_ulong_fn)
            g_hybris.android_dlsym(g_hybris.appmusic_handle,
                "_ZN18SVFootHillPContextC1ERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEERKm");

        g_hybris.appmusic_available = (g_hybris.nfc_decrypt != NULL);
        fprintf(stderr, "[hybris] libandroidappmusic.so: NfcRK=%p pcontext_ctor=%p\n",
                (void*)g_hybris.nfc_decrypt, (void*)g_hybris.pcontext_ctor);
    } else {
        fprintf(stderr, "[hybris] libandroidappmusic.so: load failed\n");
    }

    if (!g_hybris.corefp_available && !g_hybris.appmusic_available) {
        fprintf(stderr, "[hybris] no usable backend — giving up\n");
        pthread_mutex_unlock(&g_hybris.lock);
        return -1;
    }

    g_hybris.initialized = 1;
    fprintf(stderr, "[hybris] initialized: corefp=%d appmusic=%d\n",
            g_hybris.corefp_available, g_hybris.appmusic_available);
    pthread_mutex_unlock(&g_hybris.lock);
    return 0;
}

/* ── FairPlay session (wrapper library: lease, recovery, key contexts) ───────*/

/*
 * The FairPlay request context, authentication state, playback lease (with the
 * Android-style automatic refresh / recovery state machine) and key-context
 * derivation come from the vendored host-native wrapper in native/ (drm_lib_*).
 */
extern int   aml_lib_init_guarded(const drm_lib_config_t *cfg);
extern void *aml_open_kd_ctx_guarded(const char *adam, const char *uri);
extern int   aml_get_mv_guarded(unsigned long adam, char **out_url, char **out_dk,
                                int *out_has_itun);
extern int   aml_decrypt_itun_guarded(unsigned long adam, uint8_t *sample, uint32_t in_size,
                                      uint32_t *out_size);

static void wrapper_state_cb(const char *state, void *ud)
{
    (void)ud;
    fprintf(stderr, "[hybris] wrapper state: %s\n", state);
}

int hybris_fairplay_init(const char *base_dir, const char *device_info,
                         const char *lib64_dir, const char *username, const char *password)
{
    if (!g_hybris.initialized || !g_hybris.appmusic_available) return -1;
    if (g_hybris.fairplay_inited) return 0;

    drm_lib_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.base_dir    = base_dir;
    cfg.lib64_dir   = lib64_dir;
    cfg.device_info = device_info;
    /* NULL for session reuse; set for a first login, which must happen here: the library's
     * own account database is empty until it has logged in. */
    cfg.username    = username;
    cfg.password    = password;
    cfg.state_cb    = wrapper_state_cb;

    int rc = aml_lib_init_guarded(&cfg);
    if (rc == 0) g_hybris.fairplay_inited = 1;
    return rc;
}

int hybris_lease_recovery_active(void)
{
    return drm_lib_is_recovery_active();
}

extern volatile unsigned g_decrypt_epoch;

unsigned hybris_decrypt_epoch(void)
{
    return __atomic_load_n(&g_decrypt_epoch, __ATOMIC_SEQ_CST);
}

/* ── Context construction from CKC ──────────────────────────────────────────*/

/*
 * SVFootHillPContext layout (from frida_pcontext_probe.js analysis):
 *   +0x00: vtable pointer
 *   +0x08: (unknown)
 *   +0x10: (unknown)
 *   +0x18: pointer to opaque FairPlay handle (what NfcRK reads as arg0)
 *
 * We allocate 0x100 bytes, zero it, call the ctor with CKC string + selector,
 * then verify that +0x18 is non-NULL (handle was set).
 */
#define PCONTEXT_SIZE 0x100

void *hybris_backend_open_kd_ctx(
    const uint8_t *ckc_data,
    uint32_t ckc_len,
    uint32_t selector)
{
    if (!g_hybris.initialized) return NULL;

    /* ── Try libCoreFP.so direct path via X46O5IeS ── */
    if (g_hybris.corefp_available) {
        /*
         * X46O5IeS(int op, void *in, void *out):
         *   Hypothesis: op=3 or op=4 = "process CKC → key context"
         *   in  = {ckc_data, ckc_len} descriptor
         *   out = output key context buffer
         *
         * We try op values 0..7. The correct one will write a non-NULL
         * pointer into the output buffer without segfaulting.
         */
        struct { const uint8_t *data; uint32_t len; uint32_t pad; } in_desc = {
            .data = ckc_data, .len = ckc_len, .pad = 0
        };
        uint8_t out_buf[512];

        for (int op = 0; op <= 7; op++) {
            memset(out_buf, 0, sizeof(out_buf));
            int rv = -1;
            struct sigaction sa_new = {0}, sa_old;
            sa_new.sa_handler = probe_segv_handler;
            sigemptyset(&sa_new.sa_mask);
            sigaction(SIGSEGV, &sa_new, &sa_old);
            g_probe_active = 1;
            if (sigsetjmp(g_probe_jmp, 1) == 0)
                rv = g_hybris.fp_x46(op, &in_desc, out_buf);
            g_probe_active = 0;
            sigaction(SIGSEGV, &sa_old, NULL);

            if (rv == 0) {
                /* Check if out_buf contains a non-NULL pointer at offset 0 */
                void *maybe_ctx;
                memcpy(&maybe_ctx, out_buf, sizeof(void *));
                if (maybe_ctx) {
                    fprintf(stderr, "[hybris] X46O5IeS(op=%d) succeeded: ctx=%p\n", op, maybe_ctx);
                    void **ctx_wrapper = malloc(sizeof(void *) * 2);
                    if (!ctx_wrapper) return NULL;
                    ctx_wrapper[0] = maybe_ctx;
                    ctx_wrapper[1] = (void *)(uintptr_t)selector;
                    return ctx_wrapper;
                }
            }
            fprintf(stderr, "[hybris] X46O5IeS(op=%d): rv=%d out[0..7]=%016llx\n",
                    op, rv, *(unsigned long long *)out_buf);
        }
        fprintf(stderr, "[hybris] X46O5IeS: no op produced a context — falling through to appmusic path\n");
    }

    /* ── Proven path: libandroidappmusic.so → SVFootHillPContext ctor ── */
    if (!g_hybris.appmusic_available || !g_hybris.pcontext_ctor) {
        fprintf(stderr, "[hybris] open_kd_ctx: no backend available\n");
        return NULL;
    }

    uint8_t *pctx = calloc(1, PCONTEXT_SIZE);
    if (!pctx) return NULL;

    struct libcxx_string ckc_str;
    libcxx_string_init(&ckc_str, ckc_data, ckc_len);

    unsigned long sel = (unsigned long)selector;

    struct sigaction sa_new = {0}, sa_old;
    sa_new.sa_handler = probe_segv_handler;
    sigemptyset(&sa_new.sa_mask);
    sigaction(SIGSEGV, &sa_new, &sa_old);
    g_probe_active = 1;
    int faulted = 0;
    if (sigsetjmp(g_probe_jmp, 1) != 0) faulted = 1;
    if (!faulted)
        g_hybris.pcontext_ctor(pctx, ckc_str.repr, &sel);
    g_probe_active = 0;
    sigaction(SIGSEGV, &sa_old, NULL);

    libcxx_string_destroy(&ckc_str);

    if (faulted) {
        fprintf(stderr, "[hybris] pcontext_ctor: SIGSEGV — context construction failed\n");
        free(pctx);
        return NULL;
    }

    /* Verify: handle should be at pctx+0x18 */
    void *handle;
    memcpy(&handle, pctx + 0x18, sizeof(void *));
    fprintf(stderr, "[hybris] pcontext constructed: self=%p handle@+0x18=%p\n", (void*)pctx, handle);

    if (!handle) {
        fprintf(stderr, "[hybris] pcontext: handle at +0x18 is NULL — CKC processing may have failed\n");
        free(pctx);
        return NULL;
    }

    return pctx;
}

void hybris_backend_close_kd_ctx(void *ctx)
{
    free(ctx);
}

/* ── URI-based context ───────────────────────────────────────────────────────*/

void *hybris_open_kd_ctx_from_uri(const char *adam, const char *uri)
{
    if (!g_hybris.initialized || !g_hybris.fairplay_inited) {
        fprintf(stderr, "[hybris] open_kd_ctx_from_uri: FairPlay session not ready\n");
        return NULL;
    }
    if (!adam || !uri) return NULL;
    if (drm_lib_is_recovery_active()) {
        fprintf(stderr, "[hybris] key context refused: lease recovery in progress\n");
        return NULL;
    }
    void *ctx = aml_open_kd_ctx_guarded(adam, uri);
    fprintf(stderr, "[hybris] key ctx adam=%s uri=%s: %p\n", adam, uri, ctx);
    return ctx;
}

/* ── Progressive MV (itun) ───────────────────────────────────────────────────*/

int hybris_get_progressive(unsigned long adam, char **out_url, char **out_dk,
                           int *out_has_itun)
{
    if (!g_hybris.initialized || !g_hybris.fairplay_inited) {
        fprintf(stderr, "[hybris] get_progressive: FairPlay session not ready\n");
        return -1;
    }
    if (!out_url || !out_dk || !out_has_itun) return -1;
    if (drm_lib_is_recovery_active()) {
        fprintf(stderr, "[hybris] progressive URL refused: lease recovery in progress\n");
        return -1;
    }
    return aml_get_mv_guarded(adam, out_url, out_dk, out_has_itun);
}

int hybris_decrypt_itun(unsigned long adam, uint8_t *sample, uint32_t in_size,
                        uint32_t *out_size)
{
    if (!g_hybris.initialized || !g_hybris.fairplay_inited) return -1;
    if (!sample || !out_size) return -1;
    return aml_decrypt_itun_guarded(adam, sample, in_size, out_size);
}

/* ── Decryption ──────────────────────────────────────────────────────────────*/

int hybris_backend_decrypt(void *ctx, uint32_t selector, uint8_t *data, uint32_t len)
{
    (void)selector;
    if (!ctx || !data || !g_hybris.fairplay_inited) return -1;
    uint32_t whole = len & ~0xfU;
    if (whole == 0) return 0;
    return drm_lib_decrypt(ctx, data, whole);
}

/* ── Probe ───────────────────────────────────────────────────────────────────*/

void hybris_corefp_probe(void)
{
    if (!g_hybris.corefp_available) {
        fprintf(stderr, "[hybris] probe: libCoreFP.so not loaded\n");
        return;
    }
    fprintf(stderr, "[hybris] === libCoreFP.so probe (NULL/zero inputs) ===\n");

    /* Each call guarded — a crash advances to the next function */
    PROBE_CALL("dku592fbFAj(NULL)",       g_hybris.fp_dku(NULL));
    PROBE_CALL("lxpgvVMLd0S7uRl(NULL)",   g_hybris.fp_lxp(NULL));
    PROBE_CALL("fdjkDSAFjklaf2s(0,NULL)", g_hybris.fp_fdj(0, NULL));
    PROBE_CALL("fdjkDSAFjklaf2s(1,NULL)", g_hybris.fp_fdj(1, NULL));
    PROBE_CALL("X46O5IeS(0,NULL,NULL)",   g_hybris.fp_x46(0, NULL, NULL));
    PROBE_CALL("X46O5IeS(1,NULL,NULL)",   g_hybris.fp_x46(1, NULL, NULL));
    PROBE_CALL("X46O5IeS(2,NULL,NULL)",   g_hybris.fp_x46(2, NULL, NULL));
    PROBE_CALL("X46O5IeS(3,NULL,NULL)",   g_hybris.fp_x46(3, NULL, NULL));
    PROBE_CALL("YlCJ3lg(0,0,0,0,0,0)",   g_hybris.fp_ylc(NULL, NULL, NULL, NULL, 0, 0));
    PROBE_CALL("WIn9UJ86JKdV4dM(0,0,0,0,0,0,0)", g_hybris.fp_win(NULL, 0, NULL, NULL, 0, 0, 0));

    /*
     * Try lxpgvVMLd0S7uRl with a plausible output buffer — this export calls
     * the alternate dispatcher and may be "get_certificate".
     * The buffer is likely: [uint32_t len][bytes...] or a libc++ std::string.
     * Try passing a large buffer to capture the full certificate.
     */
    uint8_t cert_buf[8192] = {0};
    PROBE_CALL("lxpgvVMLd0S7uRl(cert_buf)", g_hybris.fp_lxp(cert_buf));
    if (cert_buf[0] != 0) {
        fprintf(stderr, "[hybris] lxpgvVMLd0S7uRl: first 64 bytes:\n");
        for (int i = 0; i < 64; i++) fprintf(stderr, "%02x", cert_buf[i]);
        fprintf(stderr, "\n");
        /* Check if it's a libc++ string (long form: bit0 of byte 0 = 1) */
        if (cert_buf[0] & 1) {
            uint64_t slen = 0;
            memcpy(&slen, cert_buf + 8, 8);
            void *sdata = NULL;
            memcpy(&sdata, cert_buf + 16, 8);
            fprintf(stderr, "[hybris] lxpgvVMLd0S7uRl: libc++ long string: len=%llu data_ptr=%p\n",
                    (unsigned long long)slen, sdata);
            if (sdata && slen > 0 && slen < 65536) {
                fprintf(stderr, "[hybris] first 32 cert bytes: ");
                unsigned char *p = (unsigned char *)sdata;
                for (uint64_t i = 0; i < slen && i < 32; i++) fprintf(stderr, "%02x", p[i]);
                fprintf(stderr, "\n");
            }
        }
    }

    uint8_t out2[8192] = {0};
    PROBE_CALL("fdjkDSAFjklaf2s(0,out2)", g_hybris.fp_fdj(0, out2));
    if (out2[0] != 0) {
        fprintf(stderr, "[hybris] fdjkDSAFjklaf2s(0): first 64 bytes:\n");
        for (int i = 0; i < 64; i++) fprintf(stderr, "%02x", out2[i]);
        fprintf(stderr, "\n");
    }

    fprintf(stderr, "[hybris] === probe done ===\n");
}

/* ── Shutdown ────────────────────────────────────────────────────────────────*/

void hybris_backend_shutdown(void)
{
    pthread_mutex_lock(&g_hybris.lock);
    if (!g_hybris.initialized) { pthread_mutex_unlock(&g_hybris.lock); return; }

    if (g_hybris.appmusic_handle && g_hybris.android_dlclose)
        g_hybris.android_dlclose(g_hybris.appmusic_handle);
    if (g_hybris.corefp_handle && g_hybris.android_dlclose)
        g_hybris.android_dlclose(g_hybris.corefp_handle);

    embedded_loader_shutdown();

    memset(&g_hybris, 0, sizeof(g_hybris));
    pthread_mutex_init(&g_hybris.lock, NULL);
    pthread_mutex_unlock(&g_hybris.lock);
}

/* ── Standalone probe entry point ───────────────────────────────────────────*/

#ifdef COREFP_PROBE_MAIN

/*
 * Derive the FairPlay base directory from the lib64 directory.
 * lib64_dir = .../rootfs/system/lib64
 * Returns   = .../rootfs/data/data/com.apple.android.music/files
 * Caller must free() the result.
 */
static char *derive_base_dir(const char *lib64_dir)
{
    if (!lib64_dir) return NULL;

    size_t n = strlen(lib64_dir);
    while (n > 0 && lib64_dir[n-1] == '/') n--;

    const char *sys_lib64 = "/system/lib64";
    size_t sl = strlen(sys_lib64);
    if (n >= sl && strncmp(lib64_dir + n - sl, sys_lib64, sl) == 0)
        n -= sl;

    const char *data_suffix = "/data/data/com.apple.android.music/files";
    char *result = malloc(n + strlen(data_suffix) + 1);
    if (!result) return NULL;
    memcpy(result, lib64_dir, n);
    strcpy(result + n, data_suffix);
    return result;
}
/*
 * Standalone probe binary.
 *
 * Usage:
 *   ./corefp_probe [hybris_linker_dir] [lib64_dir] [hybris_core_path]
 *
 * Defaults use vseg paths:
 *   hybris_linker_dir = /home/daksh/Git Projects/apple-music-linux-vseg/drm/hybris-linker
 *   lib64_dir         = /home/daksh/Git Projects/apple-music-linux-vseg/drm/rootfs/system/lib64
 *   hybris_core_path  = /home/daksh/Git Projects/apple-music-linux-vseg/drm/libhybris-core.so
 */
int main(int argc, char **argv)
{
    const char *linker_dir = argc > 1 ? argv[1]
        : "/home/daksh/Git Projects/apple-music-linux-vseg/drm/hybris-linker";
    const char *lib64_dir  = argc > 2 ? argv[2]
        : "/home/daksh/Git Projects/apple-music-linux-vseg/drm/rootfs/system/lib64";
    const char *core_path  = argc > 3 ? argv[3]
        : "/home/daksh/Git Projects/apple-music-linux-vseg/drm/libhybris-core.so";

    fprintf(stderr, "[probe] hybris_linker_dir = %s\n", linker_dir);
    fprintf(stderr, "[probe] lib64_dir         = %s\n", lib64_dir);
    fprintf(stderr, "[probe] hybris_core_path  = %s\n", core_path);

    int rc = hybris_backend_init(linker_dir, lib64_dir, core_path);
    if (rc != 0) {
        fprintf(stderr, "[probe] init failed — check paths above\n");
        return 1;
    }

    /* For the probe, derive base_dir from lib64_dir and call fairplay_init */
    char *bdir = derive_base_dir(lib64_dir);
    if (bdir) {
        hybris_fairplay_init(bdir, NULL, lib64_dir);
        free(bdir);
    }

    /* Optional: test URI key context (argv[4] = skd:// URI) */
    if (argc > 4) {
        fprintf(stderr, "[probe] testing hybris_open_kd_ctx_from_uri(%s)\n", argv[4]);
        void *kctx = hybris_open_kd_ctx_from_uri("0", argv[4]);
        fprintf(stderr, "[probe] hybris_open_kd_ctx_from_uri result: %p\n", kctx);
    }

    hybris_corefp_probe();
    hybris_backend_shutdown();
    return 0;
}
#endif /* COREFP_PROBE_MAIN */
