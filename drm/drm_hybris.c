/*
 * drm_hybris.c — loads Apple's Android FairPlay libraries through libhybris.
 *
 * libandroidappmusic.so (and its dependencies, libCoreFP.so first) are loaded
 * from rootfs/system/lib64. The vendored wrapper in native/ then runs the
 * FairPlay session (login, lease, recovery); keys come from its getKdContext()
 * and samples are decrypted with NfcRKVnxuKZy04KWbdFu71Ou:
 *   int fn(void *ctx, uint32_t selector, void *cipher_in, void *plain_out, uint32_t len)
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>

extern void hybris_bind_lib_handles(void *ssc, void *apm, void *core);

/* Windows loads these libraries RTLD_GLOBAL so the later symbol lookups through the
 * wrapper see them; the Linux flags are unchanged. */
#ifdef _WIN32
#define HYBRIS_WIN_RTLD_GLOBAL RTLD_GLOBAL
#else
#define HYBRIS_WIN_RTLD_GLOBAL 0
#endif

#ifdef _WIN32
/* The Windows loader path does not use POSIX dlopen/dlsym.  Keep only the
 * flag values needed by the Android linker API. */
#include <windows.h>
#include <stdint.h>
#ifndef RTLD_NOW
#define RTLD_NOW 2
#endif
#ifndef RTLD_GLOBAL
#define RTLD_GLOBAL 0x100
#endif
static int hybris_setenv(const char *name, const char *value, int overwrite)
{
    if (!overwrite && getenv(name) != NULL) return 0;
    return _putenv_s(name, value != NULL ? value : "");
}
#define setenv hybris_setenv

/* bionic's DT_INIT_ARRAY constructors begin with "mov rax, fs:[0]" to read
 * the Android TLS base.  On Windows x86_64 the fs segment base is 0 in user
 * mode, so that read faults at address 0 before any bionic state is set up.
 *
 * Fix: allocate a minimal TLS block and set the fs base to it via WRFSBASE
 * (available in user mode on Windows 10 1511+ with FSGSBASE enabled in CR4).
 *
 * Slot layout (bionic/libc/private/bionic_tls.h, x86_64):
 *   [0] self-ptr  — fs:[0] must equal &tls[0] (glibc-style self-referential)
 *   [1] pthread*  — __get_thread() reads slot 1; code may dereference it
 *   [5] canary    — 0 is safe during init; ABI doesn't verify it in ctors
 */
static __attribute__((aligned(64))) uint64_t g_bionic_tls_slots[32];
static __attribute__((aligned(16))) uint64_t g_bionic_pthread_stub[64];
static uint64_t g_host_fs_base;
static int g_host_fs_saved;

void hybris_guest_fs_enter(void)
{
    __asm__ volatile("wrfsbase %0" ::"r"((uint64_t)(uintptr_t)g_bionic_tls_slots) : "memory");
}

void hybris_guest_fs_leave(void)
{
    __asm__ volatile("wrfsbase %0" ::"r"(g_host_fs_base) : "memory");
}

static void setup_bionic_fs_base_win(void)
{
    memset(g_bionic_tls_slots, 0, sizeof(g_bionic_tls_slots));
    memset(g_bionic_pthread_stub, 0, sizeof(g_bionic_pthread_stub));
    g_bionic_tls_slots[0] = (uint64_t)(uintptr_t)g_bionic_tls_slots;    /* self */
    g_bionic_tls_slots[1] = (uint64_t)(uintptr_t)g_bionic_pthread_stub; /* tid  */
    __asm__ volatile("wrfsbase %0" ::"r"((uint64_t)(uintptr_t)g_bionic_tls_slots) : "memory");
}
#else
#include <dlfcn.h>
#endif

#include "drm_hybris.h"
#include "embedded_loader.h"
#include "native/drm_lib.h"

/* ── Types for hybris functions ─────────────────────────────────────────────*/

typedef void *(*android_dlopen_fn)(const char *filename, int flags);
typedef void *(*android_dlsym_fn)(void *handle, const char *symbol);
typedef int (*android_dlclose_fn)(void *handle);

/* ── NfcRKVnxuKZy04KWbdFu71Ou signature ─────────────────────────────────────*/

typedef int (*nfc_decrypt_fn)(void *ctx, uint32_t selector, void *cipher_in, void *plain_out, uint32_t len);

/* ── Forward declarations ────────────────────────────────────────────────────*/

int hybris_fairplay_init(const char *base_dir, const char *device_info, const char *lib64_dir,
                         const char *username, const char *password,
                         drm_auth_cb_t auth_cb, void *auth_ud);

/* ── Global module state ─────────────────────────────────────────────────────*/

static struct {
    pthread_mutex_t lock;
    int initialized;

    /* hybris host library (Linux) */
    void *hybris_core;
    android_dlopen_fn android_dlopen;
    android_dlsym_fn android_dlsym;
    android_dlclose_fn android_dlclose;

    /* libCoreFP.so (Android, loaded via hybris) */
    void *corefp_handle;

    /* libandroidappmusic.so (Android, loaded via hybris) — proven path */
    void *appmusic_handle;
    nfc_decrypt_fn nfc_decrypt; /* NfcRKVnxuKZy04KWbdFu71Ou */

    /* libstoreservicescore.so handle (dependency of appmusic, kept for dlsym) */
    void *ssc_handle;

    int appmusic_available; /* libandroidappmusic.so loaded */
    int fairplay_inited;    /* hybris_fairplay_init() succeeded */
} g_hybris = {
    .lock = PTHREAD_MUTEX_INITIALIZER,
    .initialized = 0,
};

/* ── Init ────────────────────────────────────────────────────────────────────*/

#ifndef _WIN32
/* __register_atfork: the guest's fork handlers never run here (no fork), so registering them is a no-op.
 * __memchr_chk: memchr with a destination-size check; the check is dropped. */
static int hybris_shim_register_atfork(void (*prepare)(void), void (*parent)(void), void (*child)(void), void *dso)
{
    (void)prepare;
    (void)parent;
    (void)child;
    (void)dso;
    return 0;
}

static void *hybris_shim_memchr_chk(const void *s, int c, size_t n, size_t buf_size)
{
    (void)buf_size;
    return memchr(s, c, n);
}

static void *hybris_libc_shim_hook(const char *symbol, const char *requester)
{
    (void)requester;
    if (!symbol) return NULL;
    if (strcmp(symbol, "__register_atfork") == 0) return (void *)hybris_shim_register_atfork;
    if (strcmp(symbol, "__memchr_chk") == 0) return (void *)hybris_shim_memchr_chk;
    return NULL;
}
#endif

int hybris_backend_init(
    const char *hybris_linker_dir,
    const char *lib64_dir,
    const char *hybris_core_path)
{
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
        /* Bionic logs "ANDROID_DATA/ANDROID_ROOT not set!" on every timezone
         * lookup when these are unset. Point them at the rootfs (<rootfs>/system
         * and <rootfs>/data, from <rootfs>/system/lib64); there is no tzdata in
         * either, so behaviour is unchanged. Existing values are kept. */
        char root[4096], data[4096];
        if (snprintf(root, sizeof(root), "%s/..", lib64_dir) < (int)sizeof(root))
            setenv("ANDROID_ROOT", root, 0);
        if (snprintf(data, sizeof(data), "%s/../../data", lib64_dir) < (int)sizeof(data))
            setenv("ANDROID_DATA", data, 0);
    }

    pthread_mutex_lock(&g_hybris.lock);
    if (g_hybris.initialized) {
        pthread_mutex_unlock(&g_hybris.lock);
        return 0;
    }

    /*
     * Install a dummy bionic fs base BEFORE any Android library loads.
     * bionic's DT_INIT_ARRAY constructors (and any library loaded by the
     * hybris core init) start with "mov rax, fs:[0]" to read the Android TLS
     * base.  On Windows x86_64 the fs segment base is 0 in user mode, so
     * that read faults at address 0.  Set it up once here so all subsequent
     * android_dlopen calls see a valid fs base.
     */
#ifdef _WIN32
    fprintf(stderr, "[drm] calling setup_bionic_fs_base_win\n");
    fflush(stderr);
    if (!g_host_fs_saved) {
        __asm__ volatile("rdfsbase %0" : "=r"(g_host_fs_base));
        g_host_fs_saved = 1;
    }
    setup_bionic_fs_base_win();
    fprintf(stderr, "[drm] fs base set, tls[0]=%p\n", (void *)(uintptr_t)g_bionic_tls_slots[0]);
    fflush(stderr);
#endif

    /*
     * Load libhybris-core.so and all Android .so dependencies. Linux loads the
     * embedded core from an anonymous memfd; Windows loads the supplied native
     * module and both paths hand Android libraries to android_dlopen().
     */
#ifdef _WIN32
    if (embedded_loader_init_path(hybris_core_path) != 0) {
#else
    (void)hybris_core_path;
    if (embedded_loader_init() != 0) {
#endif
        fprintf(stderr, "[hybris] embedded_loader_init failed: %s\n",
                embedded_dlerror());
        pthread_mutex_unlock(&g_hybris.lock);
        return -1;
    }

#ifndef _WIN32
    /* Newer Apple Music builds (4.9.x/5.x) import two libc symbols that bionic's libc.so here does not define. */
    embedded_set_hook_callback(hybris_libc_shim_hook);
#endif

    /*
     * Wire android_dlopen/dlsym to the embedded loader wrappers.
     * Signatures are identical to the raw hybris exports, so no casts needed.
     */
    g_hybris.android_dlopen = embedded_dlopen;
    g_hybris.android_dlsym = embedded_dlsym_in;
    g_hybris.android_dlclose = NULL; /* not exposed by embedded loader */

    /* libandroidappmusic.so depends on libCoreFP.so; load it first. */
    fprintf(stderr, "[drm] loading libCoreFP.so\n");
    fflush(stderr);
    g_hybris.corefp_handle = g_hybris.android_dlopen("libCoreFP.so", RTLD_NOW | HYBRIS_WIN_RTLD_GLOBAL);
    fprintf(stderr, "[drm] libCoreFP.so handle=%p\n", g_hybris.corefp_handle);
    fflush(stderr);
    if (!g_hybris.corefp_handle)
        fprintf(stderr, "[hybris] libCoreFP.so: load failed\n");

    /* ── Load libandroidappmusic.so (proven path) ── */
    /* Must also load libstoreservicescore.so first (dependency) */
    fprintf(stderr, "[drm] loading libstoreservicescore.so\n");
    fflush(stderr);
    g_hybris.ssc_handle = g_hybris.android_dlopen("libstoreservicescore.so", RTLD_NOW | RTLD_GLOBAL);
    fprintf(stderr, "[drm] libstoreservicescore.so handle=%p\n", g_hybris.ssc_handle);
    fflush(stderr);
    if (!g_hybris.ssc_handle)
        fprintf(stderr, "[hybris] libstoreservicescore.so: load failed (may still work)\n");

    fprintf(stderr, "[drm] loading libandroidappmusic.so\n");
    fflush(stderr);
    g_hybris.appmusic_handle = g_hybris.android_dlopen("libandroidappmusic.so", RTLD_NOW | HYBRIS_WIN_RTLD_GLOBAL);
    fprintf(stderr, "[drm] libandroidappmusic.so handle=%p\n", g_hybris.appmusic_handle);
    fflush(stderr);
    if (g_hybris.appmusic_handle) {
#ifdef _WIN32
        void *nfc_symbol = g_hybris.android_dlsym(
            g_hybris.appmusic_handle, "NfcRKVnxuKZy04KWbdFu71Ou");
        memcpy(&g_hybris.nfc_decrypt, &nfc_symbol,
               sizeof(g_hybris.nfc_decrypt));
#else
        g_hybris.nfc_decrypt = (nfc_decrypt_fn)
                                   g_hybris.android_dlsym(g_hybris.appmusic_handle,
                                                          "NfcRKVnxuKZy04KWbdFu71Ou");
#endif

        g_hybris.appmusic_available = (g_hybris.nfc_decrypt != NULL);
        DRM_DEBUG("[hybris] libandroidappmusic.so: NfcRK=%s\n",
                  g_hybris.nfc_decrypt != NULL ? "resolved" : "missing");
    } else {
        fprintf(stderr, "[hybris] libandroidappmusic.so: load failed\n");
    }

    if (!g_hybris.appmusic_available) {
        fprintf(stderr, "[hybris] no usable backend — giving up\n");
        pthread_mutex_unlock(&g_hybris.lock);
        return -1;
    }

#ifdef _WIN32
    /* Share the handles opened above with the native wrapper. Its symbol
     * forwarding layer must not open the same guest libraries a second time. */
    hybris_bind_lib_handles(g_hybris.ssc_handle, g_hybris.appmusic_handle,
                            g_hybris.corefp_handle);
#endif

    g_hybris.initialized = 1;
    DRM_DEBUG("[hybris] initialized\n");
#ifdef _WIN32
    hybris_guest_fs_leave();
#endif
    pthread_mutex_unlock(&g_hybris.lock);
    return 0;
}

/* ── FairPlay session (wrapper library: lease, recovery, key contexts) ───────*/

/*
 * The FairPlay request context, authentication state, playback lease (with the
 * Android-style automatic refresh / recovery state machine) and key-context
 * derivation come from the vendored host-native wrapper in native/ (drm_lib_*).
 */
extern int aml_lib_init_guarded(const drm_lib_config_t *cfg);
extern int aml_lib_login_guarded(const char *username, const char *password);
extern void *aml_open_kd_ctx_guarded(const char *adam, const char *uri);

static void wrapper_state_cb(const char *state, void *ud)
{
    (void)ud;
    fprintf(stderr, "[hybris] wrapper state: %s\n", state);
}

int hybris_fairplay_init(const char *base_dir, const char *device_info,
                         const char *lib64_dir,
                         const char *username, const char *password,
                         drm_auth_cb_t auth_cb, void *auth_ud)
{
    if (!g_hybris.initialized || !g_hybris.appmusic_available) return -1;
    if (g_hybris.fairplay_inited) {
        /* Already initialized — if new credentials are supplied, log in now. */
        if (username && password)
            return aml_lib_login_guarded(username, password);
        return 0;
    }

    drm_lib_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.base_dir = base_dir;
    cfg.lib64_dir = lib64_dir;
    cfg.device_info = device_info;
    cfg.username = username;
    cfg.password = password;
    cfg.state_cb = wrapper_state_cb;
    cfg.auth_cb = auth_cb; /* 2FA codes come from the app, not the terminal */
    cfg.auth_ud = auth_ud;

    int rc = aml_lib_init_guarded(&cfg);
    if (rc == 0) g_hybris.fairplay_inited = 1;
    return rc;
}

/* ── URI-based context ───────────────────────────────────────────────────────*/

extern pthread_mutex_t g_fp_call_mutex;
extern volatile unsigned g_decrypt_epoch;

void *hybris_open_kd_ctx_from_uri(const char *adam, const char *uri, unsigned *epoch)
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
    pthread_mutex_lock(&g_fp_call_mutex);
    if (epoch) *epoch = __atomic_load_n(&g_decrypt_epoch, __ATOMIC_SEQ_CST);
    void *ctx = aml_open_kd_ctx_guarded(adam, uri);
    pthread_mutex_unlock(&g_fp_call_mutex);
    if (!ctx)
        fprintf(stderr, "[hybris] key context failed for adam=%s uri=%s\n", adam, uri);
    else
        DRM_DEBUG("[hybris] key ctx adam=%s uri=%s: %p\n", adam, uri, ctx);
    return ctx;
}

/* ── Decryption ──────────────────────────────────────────────────────────────*/

int hybris_backend_decrypt(void *ctx, unsigned epoch, uint8_t *data, uint32_t len)
{
    if (!ctx || !data || !g_hybris.fairplay_inited) return -1;
    uint32_t whole = len & ~0xfU;
    if (whole == 0) return 0;
    pthread_mutex_lock(&g_fp_call_mutex);
    int ret;
    if (epoch != __atomic_load_n(&g_decrypt_epoch, __ATOMIC_SEQ_CST))
        ret = HYBRIS_ERR_STALE_CONTEXT; /* freed by a lease refresh; reopen the key */
    else
        ret = drm_lib_decrypt(ctx, data, whole);
    pthread_mutex_unlock(&g_fp_call_mutex);
    return ret;
}
