#include <pthread.h>
/*
 * hybris_stubs.c — provides all symbols declared in import.h via android_dlsym.
 *
 * Compiled into the host-native wrapper (glibc x86-64).
 * hybris_init_libs() must be called once before any stub is used.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <stdint.h>
#include "hybris_types.h"

extern int drm_lib_debug_enabled(void); /* drm_lib.c: ADAM_DRM_DEBUG */

/* hybris public API (from libhybris-core.so) */
extern void *android_dlopen(const char *filename, int flag);
extern void *android_dlsym(void *handle, const char *symbol);
extern const char *android_dlerror(void);
extern void android_update_LD_LIBRARY_PATH(const char *path);

#define RTLD_NOW_GLOBAL 0x102

static void *h_ssc = NULL;  /* libstoreservicescore.so */
static void *h_apm = NULL;  /* libandroidappmusic.so   */
static void *h_core = NULL; /* libCoreFP.so             */

/* The backend opens these libraries once while probing FairPlay. Re-opening
 * them through q.so on Windows can re-enter the guest linker and crash, so
 * the backend hands its existing handles to this resolver. */
void hybris_bind_lib_handles(void *ssc, void *apm, void *core) {
    if (ssc) h_ssc = ssc;
    if (apm) h_apm = apm;
    if (core) h_core = core;
}

/* ── vtable data arrays ──────────────────────────────────────────────────────
 * import.h declares these as "extern void *_ZTV...;" (single pointer).
 * main.c uses them as "&_ZTV... + 2" — taking the address of the symbol and
 * offsetting by 2 void* widths to reach vtable slot [2] (first virtual func).
 *
 * In the normal Android dlopen build the linker resolves the extern reference
 * so that &_ZTV... == the vtable address in the .so.  In the hybris build we
 * cannot alias Android memory, so we define each symbol as an 8-element array
 * and memcpy the vtable content from Android memory into it.  Then:
 *   &_ZTV... (from main.c's extern void* view) == &array[0]
 *   &_ZTV... + 2 == &array[2] == vtable slot [2]  ✓
 * ──────────────────────────────────────────────────────────────────────────── */
void *_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore22ProtocolDialogResponseENS_9allocatorIS2_EEEE[8];
void *_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore19CredentialsResponseENS_9allocatorIS2_EEEE[8];
void *_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore20RequestContextConfigENS_9allocatorIS2_EEEE[8];
void *_ZTVNSt6__ndk120__shared_ptr_emplaceIN13mediaplatform11HTTPMessageENS_9allocatorIS2_EEEE[8];

/* ── symbol resolver ─────────────────────────────────────────────────────── */
static void *sym(const char *name) {
    int dbg = drm_lib_debug_enabled();
    if (dbg) fprintf(stderr, "[trace] resolve %s h_ssc=%p h_apm=%p\n", name, h_ssc, h_apm);
    void *p = android_dlsym(h_ssc, name);
    if (!p) p = android_dlsym(h_apm, name);
    if (!p && h_core) p = android_dlsym(h_core, name);
    if (dbg) fprintf(stderr, "[trace] resolve %s -> %p\n", name, p);
    if (!p) { fprintf(stderr, "[hybris] FATAL: %s\n", name); abort(); }
    return p;
}


/* ── hand-built make_shared (newer Apple Music builds inline these instead of exporting them) ──────────────────────
 * libc++ make_shared lays out [control block: vptr, shared_owners, weak_owners, pad][object at +0x20]. The sizes and
 * the enable_shared_from_this offset are taken from the 5.2.1 libs' own inlined copies. */
static int have_export(const char *name) {
    return android_dlsym(h_ssc, name) || android_dlsym(h_apm, name) || (h_core && android_dlsym(h_core, name));
}

static void *emplace_vtable(const char *vtable_name) {
    void *v = sym(vtable_name);
    return (char *)v + 0x10;
}

/* Allocates the control block and object, runs `construct(obj)`, and wires up the shared_ptr and the object's
 * weak_this (esft_off is its byte offset in the object, or -1 when the class has none). */
static void make_shared_manual(struct shared_ptr *out, const char *vtable_name, size_t total_size, long esft_off,
                               void (*construct)(void *obj, void *arg), void *arg) {
    void **cb = calloc(1, total_size);
    cb[0] = emplace_vtable(vtable_name);
    char *obj = (char *)cb + 0x20;
    construct(obj, arg);
    out->obj = obj;
    out->ctrl_blk = cb;
    if (esft_off >= 0) {
        void **weak_this = (void **)(obj + esft_off);
        weak_this[0] = obj;
        weak_this[1] = cb;
        cb[2] = (void *)((uintptr_t)cb[2] + 1);   /* the weak reference held by weak_this */
    }
}

static void construct_request_context(void *obj, void *arg) {
    static void (__attribute__((sysv_abi)) *fn)(void *, union std_string *) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore14RequestContextC1ERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    fn(obj, arg);
}

static void construct_auth_flow(void *obj, void *arg) {
    static void (__attribute__((sysv_abi)) *fn)(void *, void *) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore16AuthenticateFlowC1ERKNSt6__ndk110shared_ptrINS_14RequestContextEEE");
    fn(obj, arg);
}

static void construct_presentation(void *obj, void *arg) {
    static void (__attribute__((sysv_abi)) *fn)(void *) = NULL;
    (void)arg;
    if (!fn) fn = sym("_ZN20androidstoreservices28AndroidPresentationInterfaceC1Ev");
    fn(obj);
}


/* ── RequestContextConfig callbacks (4.9.x / 5.x) ───────────────────────────────────────────────────────────────────
 * Newer Apple Music builds expect the host app to supply a set of std::function callbacks (cookies, a key/value store,
 * account updates). They are libc++ std::function objects: 32 bytes of inline storage plus a pointer to a callable
 * whose vtable is {~D1, ~D0, clone(), clone(dest), destroy, destroy_deallocate, operator(), target, target_type}.
 * Arguments reach operator() by reference (libc++ forwards _ArgTypes&&), and a non-trivial return value comes back
 * through a hidden pointer in rdi, with `this` in rsi. All state is in memory. */
#define SYSV __attribute__((sysv_abi))
struct rcc_callable { void **vptr; const char *name; };
struct rcc_function { char buf[32]; void *f; };   /* NDK libc++: inline buffer of 4 pointers, callable pointer at +0x20 */

static const char *rcc_str(const void *s, size_t *len) {
    const unsigned char *b = s;
    if (b[0] & 1) { const size_t *w = s; *len = w[1]; return (const char *)w[2]; }
    *len = b[0] >> 1;
    return (const char *)b + 1;
}

static void rcc_ret_string(void *sret, const char *s, size_t n) {
    unsigned char *b = sret;
    memset(sret, 0, 24);
    if (n <= 22) { b[0] = (unsigned char)(n << 1); if (n) memcpy(b + 1, s, n); return; }
    size_t cap = ((n + 1) | 1) + 16;
    char *d = malloc(cap);
    memcpy(d, s, n); d[n] = 0;
    size_t *w = sret; w[0] = cap | 1; w[1] = n; w[2] = (size_t)d;
}

#define RCC_KV_MAX 128
static struct { char *k, *v; } rcc_kv[RCC_KV_MAX];
static pthread_mutex_t rcc_mu = PTHREAD_MUTEX_INITIALIZER;

static char *rcc_dup(const void *s) { size_t n; const char *p = rcc_str(s, &n); char *d = malloc(n + 1); memcpy(d, p, n); d[n] = 0; return d; }

static void rcc_log(const char *name, const char *extra) {
    if (drm_lib_debug_enabled()) fprintf(stderr, "[rcc] %s %s\n", name, extra ? extra : "");
}

static void rcc_kv_get(void *sret, const void *key, const char *name) {
    char *k = rcc_dup(key); const char *val = "";
    pthread_mutex_lock(&rcc_mu);
    for (int i = 0; i < RCC_KV_MAX; i++) if (rcc_kv[i].k && !strcmp(rcc_kv[i].k, k)) { val = rcc_kv[i].v; break; }
    rcc_ret_string(sret, val, strlen(val));
    pthread_mutex_unlock(&rcc_mu);
    rcc_log(name, k); free(k);
}
static void rcc_kv_set(const void *key, const void *val, const char *name) {
    char *k = rcc_dup(key), *v = rcc_dup(val); int slot = -1;
    pthread_mutex_lock(&rcc_mu);
    for (int i = 0; i < RCC_KV_MAX; i++) { if (rcc_kv[i].k && !strcmp(rcc_kv[i].k, k)) { slot = i; break; } if (slot < 0 && !rcc_kv[i].k) slot = i; }
    if (slot >= 0) { free(rcc_kv[slot].k); free(rcc_kv[slot].v); rcc_kv[slot].k = k; rcc_kv[slot].v = v; k = v = NULL; }
    pthread_mutex_unlock(&rcc_mu);
    rcc_log(name, k ? k : "(stored)"); free(k); free(v);
}

/* one operator() per signature */
static void *SYSV rcc_op_get_cookie(void *sret, void *self, void *url, long *dsid) { (void)url; (void)dsid; rcc_ret_string(sret, "", 0); rcc_log(((struct rcc_callable *)self)->name, NULL); return sret; }
static void SYSV rcc_op_void_str_long(void *self, void *s, long *l) { (void)s; (void)l; rcc_log(((struct rcc_callable *)self)->name, NULL); }
static void SYSV rcc_op_void_str(void *self, void *s) { (void)s; rcc_log(((struct rcc_callable *)self)->name, NULL); }
static void SYSV rcc_op_void(void *self) { rcc_log(((struct rcc_callable *)self)->name, NULL); }
static void SYSV rcc_op_cookie_list(void *self, void *s, long *l, void *vec) { (void)s; (void)l; (void)vec; rcc_log(((struct rcc_callable *)self)->name, NULL); }
static void *SYSV rcc_op_get_value(void *sret, void *self, void *key) { rcc_kv_get(sret, key, ((struct rcc_callable *)self)->name); return sret; }
static void SYSV rcc_op_set_value(void *self, void *key, void *val) { rcc_kv_set(key, val, ((struct rcc_callable *)self)->name); }
static int SYSV rcc_op_bool(void *self) { rcc_log(((struct rcc_callable *)self)->name, NULL); return 0; }
static void *SYSV rcc_op_account_value(void *sret, void *self, long *dsid, void *key) { (void)dsid; (void)key; rcc_ret_string(sret, "", 0); rcc_log(((struct rcc_callable *)self)->name, NULL); return sret; }
static void *SYSV rcc_op_all_cookies(void *sret, void *self, unsigned long *dsid) { (void)dsid; memset(sret, 0, 24); rcc_log(((struct rcc_callable *)self)->name, NULL); return sret; }
static void SYSV rcc_op_status(void *self, long *a, int *b, int *c, int *d) { (void)a; (void)b; (void)c; (void)d; rcc_log(((struct rcc_callable *)self)->name, NULL); }
static void SYSV rcc_op_xtoken(void *self, long *dsid, void *tok) { (void)dsid; (void)tok; rcc_log(((struct rcc_callable *)self)->name, "(token received)"); }
static long SYSV rcc_op_dsid(void *self) { rcc_log(((struct rcc_callable *)self)->name, NULL); return 0; }
static void *SYSV rcc_op_play_integrity(void *sret, void *self, void *s) { (void)s; rcc_ret_string(sret, "", 0); rcc_log(((struct rcc_callable *)self)->name, "(empty token)"); return sret; }
static void SYSV rcc_op_proto_action(void *self, void *s, int *b) { (void)s; (void)b; rcc_log(((struct rcc_callable *)self)->name, NULL); }

static void SYSV rcc_dtor_noop(void *self) { (void)self; }
static void SYSV rcc_dtor_free(void *self) { free(self); }
static void *SYSV rcc_clone(void *self) { struct rcc_callable *c = malloc(sizeof *c); *c = *(struct rcc_callable *)self; return c; }
static void SYSV rcc_clone_into(void *self, void *dest) { *(struct rcc_callable *)dest = *(struct rcc_callable *)self; }
static void *SYSV rcc_target(void *self, void *ti) { (void)self; (void)ti; return NULL; }

static void rcc_install(void *cfg, const char *setter, const char *name, void *op) {
    if (!have_export(setter)) return;
    void **vt = malloc(9 * sizeof(void *));
    vt[0] = (void *)rcc_dtor_noop; vt[1] = (void *)rcc_dtor_free; vt[2] = (void *)rcc_clone; vt[3] = (void *)rcc_clone_into;
    vt[4] = (void *)rcc_dtor_noop; vt[5] = (void *)rcc_dtor_free; vt[6] = op; vt[7] = (void *)rcc_target; vt[8] = (void *)rcc_target;
    struct rcc_callable *c = malloc(sizeof *c); c->vptr = vt; c->name = name;
    struct rcc_function fn; memset(&fn, 0, sizeof fn); fn.f = c;
    void (SYSV *set)(void *, struct rcc_function *) = sym(setter);
    set(cfg, &fn);   /* the setter copies via clone(); the temporary is ours to release */
    ((void (SYSV *)(void *))vt[5])(c);   /* vt stays allocated: the setter's copies of the callable still point at it */
}

void install_request_context_callbacks(void *cfg) {
    /* The old libs export only setBagInvalidateCallback and work without any; install nothing there. */
    if (!have_export("_ZN17storeservicescore20RequestContextConfig20setGetCookieCallbackENSt6__ndk18functionIFNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEERS8_lEEE")) return;
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig20setGetCookieCallbackENSt6__ndk18functionIFNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEERS8_lEEE", "GetCookieCallback", (void *)rcc_op_get_cookie);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig20setSetCookieCallbackENSt6__ndk18functionIFvRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEElEEE", "SetCookieCallback", (void *)rcc_op_void_str_long);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig21setAddProfileCallbackENSt6__ndk18functionIFvRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEEEEE", "AddProfileCallback", (void *)rcc_op_void_str);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig24setBagInvalidateCallbackENSt6__ndk18functionIFvvEEE", "BagInvalidateCallback", (void *)rcc_op_void);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig24setGetCookieListCallbackENSt6__ndk18functionIFvRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEElRNS1_6vectorIS8_NS6_IS8_EEEEEEE", "GetCookieListCallback", (void *)rcc_op_cookie_list);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig25setGetValueForKeyCallbackENSt6__ndk18functionIFNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEERS8_EEE", "GetValueForKeyCallback", (void *)rcc_op_get_value);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig25setSetValueForKeyCallbackENSt6__ndk18functionIFvRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_EEE", "SetValueForKeyCallback", (void *)rcc_op_set_value);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig25setUseLegacyStoreCallbackENSt6__ndk18functionIFbvEEE", "UseLegacyStoreCallback", (void *)rcc_op_bool);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig26setGetAccountValueCallbackENSt6__ndk18functionIFNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEElRKS8_EEE", "GetAccountValueCallback", (void *)rcc_op_account_value);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig28setAllCookiesForUserCallbackENSt6__ndk18functionIFNS1_6vectorINS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEENS7_IS9_EEEEmEEE", "AllCookiesForUserCallback", (void *)rcc_op_all_cookies);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig29setUpdateAccountFlagsCallbackENSt6__ndk18functionIFvRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEEEEE", "UpdateAccountFlagsCallback", (void *)rcc_op_void_str);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig30setUpdateAccountStatusCallbackENSt6__ndk18functionIFvlbbbEEE", "UpdateAccountStatusCallback", (void *)rcc_op_status);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig30setUpdateAccountXTokenCallbackENSt6__ndk18functionIFvlRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEEEEE", "UpdateAccountXTokenCallback", (void *)rcc_op_xtoken);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig31setGetActiveAccountDSIDCallbackENSt6__ndk18functionIFlvEEE", "GetActiveAccountDSIDCallback", (void *)rcc_op_dsid);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig31setGetPlayIntegrityHashCallbackENSt6__ndk18functionIFNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEERS8_EEE", "GetPlayIntegrityHashCallback", (void *)rcc_op_play_integrity);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig34setUpdateAccountStoreFrontCallbackENSt6__ndk18functionIFvRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEEEEE", "UpdateAccountStoreFrontCallback", (void *)rcc_op_void_str);
    rcc_install(cfg, "_ZN17storeservicescore20RequestContextConfig35setCreateAccountProtoActionCallbackENSt6__ndk18functionIFvRNS1_12basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEEbEEE", "CreateAccountProtoActionCallback", (void *)rcc_op_proto_action);
}

/* ── Windows: dummy bionic TLS so DT_INIT_ARRAY constructors don't fault ─── */
#ifdef _WIN32
/* bionic's DT_INIT_ARRAY constructors start with "mov rax, fs:[0]" to read
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
static __attribute__((aligned(64))) uint64_t bionic_tls_slots[32];
static __attribute__((aligned(16))) uint64_t bionic_pthread_stub[64];

static void setup_bionic_fs_base(void) {
    memset(bionic_tls_slots,   0, sizeof(bionic_tls_slots));
    memset(bionic_pthread_stub, 0, sizeof(bionic_pthread_stub));
    bionic_tls_slots[0] = (uint64_t)(uintptr_t)bionic_tls_slots;   /* self */
    bionic_tls_slots[1] = (uint64_t)(uintptr_t)bionic_pthread_stub; /* tid  */
    __asm__ volatile("wrfsbase %0" :: "r"((uint64_t)(uintptr_t)bionic_tls_slots) : "memory");
}
#endif /* _WIN32 */

/* ── init: load Android libs, patch vtables ─────────────────────────────── */
/* Returns 0 on success, -1 if an Android lib cannot be loaded. It must not
 * exit: in library mode (libdrm-native.so inside the Go engine) that would
 * take the whole engine down instead of just disabling DRM. */
int hybris_init_libs(const char *lib64) {
    char path[512];

    /* hybris_backend_init() loads the Android libraries before
     * hybris_fairplay_init() enters drm_lib_init().  Library mode calls this
     * function from both paths, so do not reconfigure q.so or reload the
     * already-loaded namespace on the second call. */
#ifdef _WIN32
    if (h_ssc && h_apm) return 0;
#endif

    /* pre-load implicit system libs so verneed checks pass.
     * On Windows the Q linker handles bionic (libc/libm/libdl) through its own
     * protected namespace; explicit android_dlopen of them crashes, so skip. */
#ifndef _WIN32
    static const char *preload[] = { "libdl.so", "libc.so", "libm.so", NULL };
    for (int i = 0; preload[i]; i++) {
        snprintf(path, sizeof(path), "%s/%s", lib64, preload[i]);
        android_dlopen(path, RTLD_NOW_GLOBAL);
    }
#endif

#ifdef _WIN32
    /* Install a dummy fs base so bionic's DT_INIT_ARRAY constructors don't
     * fault at fs:[0] — must happen before the first android_dlopen that
     * triggers bionic loading (see setup_bionic_fs_base above). */
    setup_bionic_fs_base();

    /* On Windows the Android linker uses ':' as LD_LIBRARY_PATH separator,
     * which conflicts with Windows drive letters ("C:\...").  Strip the drive
     * letter so the library search path has no embedded ':', e.g.
     * "C:\rootfs\system\lib64" → "\rootfs\system\lib64" (drive-relative).
     * Windows resolves this to the same directory as the full path. */
    {
        const char *lib_search = (lib64[1] == ':') ? lib64 + 2 : lib64;
        android_update_LD_LIBRARY_PATH(lib_search);
    }
#endif

    snprintf(path, sizeof(path), "%s/libstoreservicescore.so", lib64);
    h_ssc = android_dlopen(path, RTLD_NOW_GLOBAL);
    if (!h_ssc) { fprintf(stderr, "[hybris] cannot load libstoreservicescore.so: %s\n", android_dlerror()); return -1; }

    snprintf(path, sizeof(path), "%s/libandroidappmusic.so", lib64);
    h_apm = android_dlopen(path, RTLD_NOW_GLOBAL);
    if (!h_apm) { fprintf(stderr, "[hybris] cannot load libandroidappmusic.so: %s\n", android_dlerror()); return -1; }

    /* copy vtable content into our local arrays so &_ZTV... + 2 == vtable[2] */
#define PATCHV(arr, sym_name) do { \
    void *p = android_dlsym(h_ssc, sym_name); \
    if (!p) p = android_dlsym(h_apm, sym_name); \
    if (p) memcpy(arr, p, 8 * sizeof(void*)); \
    else fprintf(stderr, "[hybris] warning: vtable %s not found\n", sym_name); \
} while(0)

    PATCHV(_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore22ProtocolDialogResponseENS_9allocatorIS2_EEEE,
           "_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore22ProtocolDialogResponseENS_9allocatorIS2_EEEE");
    PATCHV(_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore19CredentialsResponseENS_9allocatorIS2_EEEE,
           "_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore19CredentialsResponseENS_9allocatorIS2_EEEE");
    PATCHV(_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore20RequestContextConfigENS_9allocatorIS2_EEEE,
           "_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore20RequestContextConfigENS_9allocatorIS2_EEEE");
    PATCHV(_ZTVNSt6__ndk120__shared_ptr_emplaceIN13mediaplatform11HTTPMessageENS_9allocatorIS2_EEEE,
           "_ZTVNSt6__ndk120__shared_ptr_emplaceIN13mediaplatform11HTTPMessageENS_9allocatorIS2_EEEE");

    if (drm_lib_debug_enabled()) fprintf(stderr, "[hybris] libs loaded\n");
    return 0;
}

/* ── special cases ───────────────────────────────────────────────────────── */

/* curl: provided by system libcurl, no stub needed */

/* Android log → stderr: warnings and errors always (ANDROID_LOG_WARN = 5),
 * verbose/debug/info only with ADAM_DRM_DEBUG. */
static int android_log_wanted(int prio) { return prio >= 5 || drm_lib_debug_enabled(); }

int __android_log_print(int prio, const char *tag, const char *fmt, ...) {
    if (!android_log_wanted(prio)) return 0;
    char buf[1024];
    va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
    fprintf(stderr, "[%s] %s\n", tag, buf);
    return 0;
}
int __android_log_write(int prio, const char *tag, const char *text) {
    if (android_log_wanted(prio)) fprintf(stderr, "[%s] %s\n", tag, text);
    return 0;
}

/* resolv: no-op on glibc */
void _resolv_set_nameservers_for_net(unsigned netid, const char **servers,
                                     int numservers, const char *domains) {
    (void)netid; (void)servers; (void)numservers; (void)domains;
}

/* ── Bionic-compatible std::function callback objects ────────────────────────
 *
 * SVPlaybackLeaseManagerC2 expects two Bionic std::__ndk1::function<> objects
 * passed by const reference.  Passing glibc std::function objects crashes
 * because the copy constructor calls through Bionic's vtable which doesn't
 * match glibc's internal layout.
 *
 * Bionic NDK r21 libc++ std::__ndk1::function<F> uses the OLD field order:
 *   __f_ comes FIRST, __buf_ comes SECOND (opposite of newer LLVM libc++):
 *
 *   std::function<F> (32 bytes):
 *   [0..7]:  __f_      = &__buf_[0] when SBO (= self + 8); NULL = empty
 *   [8..15]: __buf_[0] = vptr of __func  (= &vtab[2])
 *   [16..23]: __buf_[1] = fn pointer (the stored callable)
 *   [24..31]: __buf_[2] = allocator state (zeroed for stateless)
 *
 * SBO path: Bionic checks (void*)__f_ == &__buf_[0], i.e. self[0] == self+8.
 * If true it calls __f_->__clone(__base* dst) to copy __func into dest's __buf_.
 *
 * The vtable layout for __base<R(Args...)> (Bionic NDK r21, vptr → vtab[2]):
 *   vptr[0] = vtab[2] ~__base() regular destructor
 *   vptr[1] = vtab[3] ~__base() deleting destructor
 *   vptr[2] = vtab[4] __clone() const → heap copy
 *   vptr[3] = vtab[5] __clone(__base*) const → SBO placement copy
 *   vptr[4] = vtab[6] __destroy() → SBO destroy (no free)
 *   vptr[5] = vtab[7] __destroy_and_delete() → destroy + heap free
 *   vptr[6] = vtab[8] operator()(Args&&...) → invoke
 *
 * Virtual functions receive `self = &__buf_[0]` (the __func object), so:
 *   self[0] = vptr, self[1] = fn ptr, self[2] = allocator.
 * ──────────────────────────────────────────────────────────────────────────── */

/* callbacks exported from main.cpp */
extern void endLeaseCbExport(const int *code_ptr);
extern void pbErrCbExport(void *arg);

/* ── endLeaseCallback: std::function<void(const int&)> ─────────────────────*/

/* These are entered through the guest std::function vtable, so the guest calls
 * them with the SysV AMD64 ABI (this in rdi). On Windows the wrapper is built
 * for the host MS ABI, so without sysv_abi the args land in the wrong registers
 * (self/dst read as null) and the clone's memcpy faults. The inner callback
 * (endLeaseCbExport) is a host function, so that call stays host-ABI. */
static void __attribute__((sysv_abi)) vf_el_destroy(void *self) { (void)self; }
static void __attribute__((sysv_abi)) vf_el_destroy_and_delete(void *self) { free(self); }
static void *__attribute__((sysv_abi)) vf_el_clone_heap(void *self) {
    void *copy = malloc(3 * sizeof(void *));
    memcpy(copy, self, 3 * sizeof(void *));
    return copy;
}
static void __attribute__((sysv_abi)) vf_el_clone_sbo(void *self, void *dst) {
    memcpy(dst, self, 3 * sizeof(void *));
}
static void __attribute__((sysv_abi)) vf_el_invoke(void *self, const int *code) {
    void (*fn)(const int *) = (void (*)(const int *))((void **)self)[1];
    fn(code);
}

static void *vtab_endlease[9] = {
    (void *)0,                      /* [0] offset-to-top */
    (void *)0,                      /* [1] RTTI          */
    (void *)vf_el_destroy,          /* [2] ~__base() regular */
    (void *)vf_el_destroy_and_delete, /* [3] ~__base() deleting */
    (void *)vf_el_clone_heap,       /* [4] __clone() → heap  */
    (void *)vf_el_clone_sbo,        /* [5] __clone(dst) → SBO */
    (void *)vf_el_destroy,          /* [6] __destroy()        */
    (void *)vf_el_destroy_and_delete, /* [7] __destroy_and_delete() */
    (void *)vf_el_invoke,           /* [8] operator()(const int&) */
};

/* 32-byte buffer; set up by hybris_init_callbacks() */
uint8_t endLeaseCallback[32];

/* ── pbErrCallback: std::function<void(const shared_ptr<StoreErrorCond>&)> ─*/

static void __attribute__((sysv_abi)) vf_pe_destroy(void *self) { (void)self; }
static void __attribute__((sysv_abi)) vf_pe_destroy_and_delete(void *self) { free(self); }
static void *__attribute__((sysv_abi)) vf_pe_clone_heap(void *self) {
    void *copy = malloc(3 * sizeof(void *));
    memcpy(copy, self, 3 * sizeof(void *));
    return copy;
}
static void __attribute__((sysv_abi)) vf_pe_clone_sbo(void *self, void *dst) {
    memcpy(dst, self, 3 * sizeof(void *));
}
static void __attribute__((sysv_abi)) vf_pe_invoke(void *self, void *arg) {
    void (*fn)(void *) = (void (*)(void *))((void **)self)[1];
    fn(arg);
}

static void *vtab_pberr[9] = {
    (void *)0,
    (void *)0,
    (void *)vf_pe_destroy,
    (void *)vf_pe_destroy_and_delete,
    (void *)vf_pe_clone_heap,
    (void *)vf_pe_clone_sbo,
    (void *)vf_pe_destroy,
    (void *)vf_pe_destroy_and_delete,
    (void *)vf_pe_invoke,
};

uint8_t pbErrCallback[32];

/* Call once from main() after init(), before SVPlaybackLeaseManagerC2.
 *
 * Bionic NDK r21 libc++ std::function<F> (32 bytes) OLD layout:
 *   [0..7]:  __f_   = &__buf_[0] = self+8  (SBO path: __f_ points into __buf_)
 *   [8..15]: __buf_[0] = vptr of __func (= &vtab[2])
 *   [16..23]: __buf_[1] = fn pointer
 *   [24..31]: __buf_[2] = allocator (zeroed for stateless)
 *
 * SBO check in Bionic: (void*)__f_ == &__buf_[0]  →  self[0] == self+8
 * Invoke: self->__f_->operator()(args)
 *         = obj at (self+8), vptr=*(self+8)=&vtab[2], call vptr[6]
 */
void hybris_init_callbacks(void) {
    uint8_t *el = endLeaseCallback;
    ((void **)el)[0] = el + 8;                    /* __f_ = &__buf_[0]    */
    ((void **)el)[1] = &vtab_endlease[2];          /* __func vptr          */
    ((void **)el)[2] = (void *)endLeaseCbExport;   /* fn ptr               */
    ((void **)el)[3] = NULL;                       /* allocator (zeroed)   */

    uint8_t *pe = pbErrCallback;
    ((void **)pe)[0] = pe + 8;
    ((void **)pe)[1] = &vtab_pberr[2];
    ((void **)pe)[2] = (void *)pbErrCbExport;
    ((void **)pe)[3] = NULL;
}

/* ── function stubs ──────────────────────────────────────────────────────── */

void _ZN20androidstoreservices30SVSubscriptionStatusMgrFactory6createEv(struct shared_ptr *out) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN20androidstoreservices30SVSubscriptionStatusMgrFactory6createEv");
    fn(out);
}

void _ZN20androidstoreservices27SVSubscriptionStatusMgrImpl33checkSubscriptionStatusFromSourceERKNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEEERKNS_23SVSubscriptionStatusMgr26SVSubscriptionStatusSourceE(
    struct shared_ptr *a, void *b, struct shared_ptr *c, int *d) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*,void*,struct shared_ptr*,int*) = NULL;
    if (!fn) fn = sym("_ZN20androidstoreservices27SVSubscriptionStatusMgrImpl33checkSubscriptionStatusFromSourceERKNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEEERKNS_23SVSubscriptionStatusMgr26SVSubscriptionStatusSourceE");
    fn(a,b,c,d);
}

void _ZN17storeservicescore14RequestContext24setFairPlayDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(void *obj, union std_string *path) {
    static void (__attribute__((sysv_abi)) *fn)(void*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore14RequestContext24setFairPlayDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    fn(obj,path);
}

void _ZN14FootHillConfig6configERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE(union std_string *cfg) {
    static void (__attribute__((sysv_abi)) *fn)(union std_string*) = NULL;
    static int by_value = 0;
    if (!fn) {
        /* Newer Apple Music builds (4.9.x/5.x) take the string by value instead of by const&. A non-trivial by-value
         * parameter is still passed as a pointer to the caller's object, so the call itself is the same. */
        const char *old_name = "_ZN14FootHillConfig6configERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE";
        const char *new_name = "_ZN14FootHillConfig6configENSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE";
        void *p = android_dlsym(h_apm, old_name);
        if (!p) { p = android_dlsym(h_apm, new_name); by_value = p != NULL; }
        fn = p ? (void (__attribute__((sysv_abi)) *)(union std_string*))p : sym(old_name);
    }
    if (drm_lib_debug_enabled())
        fprintf(stderr, "[trace] FootHill fn=%p by_value=%d cfg=%p cap=%zx size=%zx data=%p\n",
                (void *)fn, by_value, (void *)cfg, cfg->cap, cfg->size, (void *)cfg->data);
    if (by_value && cfg->size <= 22) {
        /* The newer code reads a properly formed libc++ string (the wrapper's cap=1 long form is not valid there):
         * use the short form, size in the first byte and the characters inline. */
        union std_string own;
        memset(&own, 0, sizeof own);
        own.mark = (uint8_t)(cfg->size << 1);
        memcpy(own.str, (const void *)cfg->data, cfg->size);
        fn(&own);
    } else fn(cfg);
}

void _ZNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEE11make_sharedIJRNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEEEEES3_DpOT_(
    struct shared_ptr *out, union std_string *str) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*,union std_string*) = NULL;
    if (!fn && have_export("_ZNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEE11make_sharedIJRNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEEEEES3_DpOT_")) fn = sym("_ZNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEE11make_sharedIJRNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEEEEES3_DpOT_");
    if (!fn && !have_export("_ZNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEE11make_sharedIJRNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEEEEES3_DpOT_")) {
        make_shared_manual(out, "_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore14RequestContextENS_9allocatorIS2_EEEE",
                           0x5e0, 0, construct_request_context, str);
        return;
    }
    fn(out,str);
}

void _ZNSt6__ndk110shared_ptrIN20androidstoreservices28AndroidPresentationInterfaceEE11make_sharedIJEEES3_DpOT_(struct shared_ptr *out) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*) = NULL;
    if (!fn && have_export("_ZNSt6__ndk110shared_ptrIN20androidstoreservices28AndroidPresentationInterfaceEE11make_sharedIJEEES3_DpOT_")) fn = sym("_ZNSt6__ndk110shared_ptrIN20androidstoreservices28AndroidPresentationInterfaceEE11make_sharedIJEEES3_DpOT_");
    if (!fn && !have_export("_ZNSt6__ndk110shared_ptrIN20androidstoreservices28AndroidPresentationInterfaceEE11make_sharedIJEEES3_DpOT_")) {
        make_shared_manual(out, "_ZTVNSt6__ndk120__shared_ptr_emplaceIN20androidstoreservices28AndroidPresentationInterfaceENS_9allocatorIS2_EEEE",
                           0x120, 0x18, construct_presentation, NULL);
        return;
    }
    fn(out);
}

void _ZN20androidstoreservices28AndroidPresentationInterface16setDialogHandlerEPFvlNSt6__ndk110shared_ptrIN17storeservicescore14ProtocolDialogEEENS2_INS_36AndroidProtocolDialogResponseHandlerEEEE(
    void *obj, void (__attribute__((sysv_abi)) *handler)(int64_t, struct shared_ptr *, struct shared_ptr *)) {
    static void (__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZN20androidstoreservices28AndroidPresentationInterface16setDialogHandlerEPFvlNSt6__ndk110shared_ptrIN17storeservicescore14ProtocolDialogEEENS2_INS_36AndroidProtocolDialogResponseHandlerEEEE");
    fn(obj,(void*)handler);
}

void _ZN20androidstoreservices28AndroidPresentationInterface21setCredentialsHandlerEPFvNSt6__ndk110shared_ptrIN17storeservicescore18CredentialsRequestEEENS2_INS_33AndroidCredentialsResponseHandlerEEEE(
    void *obj, void (__attribute__((sysv_abi)) *handler)(struct shared_ptr *, struct shared_ptr *)) {
    static void (__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZN20androidstoreservices28AndroidPresentationInterface21setCredentialsHandlerEPFvNSt6__ndk110shared_ptrIN17storeservicescore18CredentialsRequestEEENS2_INS_33AndroidCredentialsResponseHandlerEEEE");
    fn(obj,(void*)handler);
}

void _ZN17storeservicescore14RequestContext24setPresentationInterfaceERKNSt6__ndk110shared_ptrINS_21PresentationInterfaceEEE(
    void *obj, struct shared_ptr *iface) {
    static void (__attribute__((sysv_abi)) *fn)(void*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore14RequestContext24setPresentationInterfaceERKNSt6__ndk110shared_ptrINS_21PresentationInterfaceEEE");
    fn(obj,iface);
}

void _ZNSt6__ndk110shared_ptrIN17storeservicescore16AuthenticateFlowEE11make_sharedIJRNS0_INS1_14RequestContextEEEEEES3_DpOT_(
    struct shared_ptr *out, struct shared_ptr *ctx) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*,struct shared_ptr*) = NULL;
    if (!fn && have_export("_ZNSt6__ndk110shared_ptrIN17storeservicescore16AuthenticateFlowEE11make_sharedIJRNS0_INS1_14RequestContextEEEEEES3_DpOT_")) fn = sym("_ZNSt6__ndk110shared_ptrIN17storeservicescore16AuthenticateFlowEE11make_sharedIJRNS0_INS1_14RequestContextEEEEEES3_DpOT_");
    if (!fn) {
        make_shared_manual(out, "_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore16AuthenticateFlowENS_9allocatorIS2_EEEE",
                           0x100, 8, construct_auth_flow, ctx);
        return;
    }
    fn(out,ctx);
}

void _ZN17storeservicescore16AuthenticateFlow3runEv(void *obj) {
    static void (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore16AuthenticateFlow3runEv");
    fn(obj);
}

struct shared_ptr *_ZNK17storeservicescore16AuthenticateFlow8responseEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore16AuthenticateFlow8responseEv");
    return fn(obj);
}

int _ZNK17storeservicescore20AuthenticateResponse12responseTypeEv(void *obj) {
    static int (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore20AuthenticateResponse12responseTypeEv");
    return fn(obj);
}

void _ZN22SVPlaybackLeaseManagerC2ERKNSt6__ndk18functionIFvRKiEEERKNS1_IFvRKNS0_10shared_ptrIN17storeservicescore19StoreErrorConditionEEEEEE(
    void *obj, void *endcb, void *errcb) {
    static void (__attribute__((sysv_abi)) *fn)(void*,void*,void*) = NULL;
    if (!fn) fn = sym("_ZN22SVPlaybackLeaseManagerC2ERKNSt6__ndk18functionIFvRKiEEERKNS1_IFvRKNS0_10shared_ptrIN17storeservicescore19StoreErrorConditionEEEEEE");
    fn(obj,endcb,errcb);
}

void _ZN22SVPlaybackLeaseManager25refreshLeaseAutomaticallyERKb(void *obj, uint8_t *flag) {
    static void (__attribute__((sysv_abi)) *fn)(void*,uint8_t*) = NULL;
    if (!fn) fn = sym("_ZN22SVPlaybackLeaseManager25refreshLeaseAutomaticallyERKb");
    fn(obj,flag);
}

void _ZN22SVPlaybackLeaseManager12requestLeaseERKb(void *obj, uint8_t *flag) {
    static void (__attribute__((sysv_abi)) *fn)(void*,uint8_t*) = NULL;
    if (!fn) fn = sym("_ZN22SVPlaybackLeaseManager12requestLeaseERKb");
    fn(obj,flag);
}

/* zero-arg functions */
void *_ZN21SVFootHillSessionCtrl8instanceEv() {
    static void *(__attribute__((sysv_abi)) *fn)(void) = NULL;
    if (!fn) fn = sym("_ZN21SVFootHillSessionCtrl8instanceEv");
    return fn();
}
void *_ZN21SVFootHillSessionCtrl7destroyEv() {
    static void *(__attribute__((sysv_abi)) *fn)(void) = NULL;
    if (!fn) fn = sym("_ZN21SVFootHillSessionCtrl7destroyEv");
    return fn();
}

void _ZN21SVFootHillSessionCtrl9cleanKeysERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE(
    void *obj, union std_string *key) {
    static void (__attribute__((sysv_abi)) *fn)(void*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN21SVFootHillSessionCtrl9cleanKeysERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE");
    fn(obj,key);
}

void _ZN21SVFootHillSessionCtrl16getPersistentKeyERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEES8_S8_S8_S8_S8_S8_S8_(
    struct shared_ptr *ret, void *obj,
    union std_string *a, union std_string *b, union std_string *c, union std_string *d,
    union std_string *e, union std_string *f, union std_string *g, union std_string *h) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*,void*,
                      union std_string*,union std_string*,union std_string*,union std_string*,
                      union std_string*,union std_string*,union std_string*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN21SVFootHillSessionCtrl16getPersistentKeyERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEES8_S8_S8_S8_S8_S8_S8_");
    fn(ret,obj,a,b,c,d,e,f,g,h);
}

void _ZN21SVFootHillSessionCtrl14decryptContextERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEERKN11SVDecryptor15SVDecryptorTypeERKb(
    struct shared_ptr *ret, void *obj, union std_string *ckc) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*,void*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN21SVFootHillSessionCtrl14decryptContextERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEERKN11SVDecryptor15SVDecryptorTypeERKb");
    fn(ret,obj,ckc);
}

void _ZNSt6__ndk110shared_ptrI18SVFootHillPContextED2Ev(struct shared_ptr *sp) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*) = NULL;
    if (!fn && have_export("_ZNSt6__ndk110shared_ptrI18SVFootHillPContextED2Ev"))
        fn = sym("_ZNSt6__ndk110shared_ptrI18SVFootHillPContextED2Ev");
    if (!fn) {
        /* Not exported by newer builds: release the strong reference the way libc++'s shared_ptr destructor does. */
        void **cb = sp->ctrl_blk;
        if (!cb) return;
        if (__atomic_fetch_add((long *)&cb[1], -1, __ATOMIC_ACQ_REL) == 0) {
            ((void (__attribute__((sysv_abi)) *)(void *))((void **)cb[0])[2])(cb);   /* __on_zero_shared */
            static void (__attribute__((sysv_abi)) *release_weak)(void *) = NULL;
            if (!release_weak) release_weak = sym("_ZNSt6__ndk119__shared_weak_count14__release_weakEv");
            release_weak(cb);
        }
        return;
    }
    fn(sp);
}

void **_ZNK18SVFootHillPContext9kdContextEv(void *obj) {
    static void **(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK18SVFootHillPContext9kdContextEv");
    return fn(obj);
}

long NfcRKVnxuKZy04KWbdFu71Ou(void *a, uint32_t b, void *c, void *d, size_t e) {
    static long (__attribute__((sysv_abi)) *fn)(void*,uint32_t,void*,void*,size_t) = NULL;
    if (!fn) fn = sym("NfcRKVnxuKZy04KWbdFu71Ou");
    return fn(a,b,c,d,e);
}

void _ZN17storeservicescore22ProtocolDialogResponse17setSelectedButtonERKNSt6__ndk110shared_ptrINS_14ProtocolButtonEEE(
    void *obj, struct shared_ptr *btn) {
    static void (__attribute__((sysv_abi)) *fn)(void*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore22ProtocolDialogResponse17setSelectedButtonERKNSt6__ndk110shared_ptrINS_14ProtocolButtonEEE");
    fn(obj,btn);
}

union std_string *_ZNK17storeservicescore14ProtocolDialog5titleEv(void *obj) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore14ProtocolDialog5titleEv");
    return fn(obj);
}
union std_string *_ZNK17storeservicescore14ProtocolDialog7messageEv(void *obj) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore14ProtocolDialog7messageEv");
    return fn(obj);
}
union std_string *_ZNK17storeservicescore18CredentialsRequest5titleEv(void *obj) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore18CredentialsRequest5titleEv");
    return fn(obj);
}
union std_string *_ZNK17storeservicescore18CredentialsRequest7messageEv(void *obj) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore18CredentialsRequest7messageEv");
    return fn(obj);
}
uint8_t _ZNK17storeservicescore18CredentialsRequest28requiresHSA2VerificationCodeEv(void *obj) {
    static uint8_t (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore18CredentialsRequest28requiresHSA2VerificationCodeEv");
    return fn(obj);
}

void _ZN20androidstoreservices28AndroidPresentationInterface28handleProtocolDialogResponseERKlRKNSt6__ndk110shared_ptrIN17storeservicescore22ProtocolDialogResponseEEE(
    void *obj, int64_t *j, struct shared_ptr *resp) {
    static void (__attribute__((sysv_abi)) *fn)(void*,int64_t*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN20androidstoreservices28AndroidPresentationInterface28handleProtocolDialogResponseERKlRKNSt6__ndk110shared_ptrIN17storeservicescore22ProtocolDialogResponseEEE");
    fn(obj,j,resp);
}

void _ZN20androidstoreservices28AndroidPresentationInterface25handleCredentialsResponseERKNSt6__ndk110shared_ptrIN17storeservicescore19CredentialsResponseEEE(
    void *obj, struct shared_ptr *resp) {
    static void (__attribute__((sysv_abi)) *fn)(void*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN20androidstoreservices28AndroidPresentationInterface25handleCredentialsResponseERKNSt6__ndk110shared_ptrIN17storeservicescore19CredentialsResponseEEE");
    fn(obj,resp);
}

void _ZN17storeservicescore22ProtocolDialogResponseC1Ev(void *obj) {
    static void (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore22ProtocolDialogResponseC1Ev");
    fn(obj);
}
void _ZN17storeservicescore19CredentialsResponseC1Ev(void *obj) {
    static void (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore19CredentialsResponseC1Ev");
    fn(obj);
}
void _ZN17storeservicescore19CredentialsResponse11setUserNameERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(void *obj, union std_string *s) {
    static void (__attribute__((sysv_abi)) *fn)(void*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore19CredentialsResponse11setUserNameERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    fn(obj,s);
}
void _ZN17storeservicescore19CredentialsResponse11setPasswordERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(void *obj, union std_string *s) {
    static void (__attribute__((sysv_abi)) *fn)(void*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore19CredentialsResponse11setPasswordERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    fn(obj,s);
}
void _ZN17storeservicescore19CredentialsResponse15setResponseTypeENS0_12ResponseTypeE(void *obj, int t) {
    static void (__attribute__((sysv_abi)) *fn)(void*,int) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore19CredentialsResponse15setResponseTypeENS0_12ResponseTypeE");
    fn(obj,t);
}

struct std_vector *_ZNK17storeservicescore14ProtocolDialog7buttonsEv(void *obj) {
    static struct std_vector *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore14ProtocolDialog7buttonsEv");
    return fn(obj);
}
union std_string *_ZNK17storeservicescore14ProtocolButton5titleEv(void *obj) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore14ProtocolButton5titleEv");
    return fn(obj);
}

void _ZN17storeservicescore10DeviceGUID8instanceEv(struct shared_ptr *out) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore10DeviceGUID8instanceEv");
    fn(out);
}

void _ZN17storeservicescore10DeviceGUID9configureERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_RKjRKb(
    void *ret, void *obj, union std_string *id1, union std_string *id2,
    unsigned int *api, uint8_t *flag) {
    static void (__attribute__((sysv_abi)) *fn)(void*,void*,union std_string*,union std_string*,unsigned int*,uint8_t*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore10DeviceGUID9configureERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_RKjRKb");
    fn(ret,obj,id1,id2,api,flag);
}

uint8_t _ZN13mediaplatform26DebugLogEnabledForPriorityENS_11LogPriorityE(void) {
    /* always return 0 (disabled) — avoids spamming logs */
    return 0;
}

void _ZN17storeservicescore20RequestContextConfigC2Ev(void *obj) {
    static void (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore20RequestContextConfigC2Ev");
    fn(obj);
}
void _ZN17storeservicescore20RequestContextConfig9setCPFlagEb(void *obj, uint8_t flag) {
    static void (__attribute__((sysv_abi)) *fn)(void*,uint8_t) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore20RequestContextConfig9setCPFlagEb");
    fn(obj,flag);
}

#define CFG_SETTER(name) \
void name(void *obj, union std_string *s) { \
    static void (__attribute__((sysv_abi)) *fn)(void*,union std_string*) = NULL; \
    if (!fn) fn = sym(#name); \
    fn(obj,s); \
}
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig20setBaseDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig19setClientIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig20setVersionIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig21setPlatformIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig17setProductVersionERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig14setDeviceModelERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig15setBuildVersionERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig19setLocaleIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig21setLanguageIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
CFG_SETTER(_ZN17storeservicescore20RequestContextConfig24setFairPlayDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE)
#undef CFG_SETTER

void _ZN17storeservicescore14RequestContext4initERKNSt6__ndk110shared_ptrINS_20RequestContextConfigEEE(
    void *obj, void *unused, struct shared_ptr *cfg) {
    static void (__attribute__((sysv_abi)) *fn)(void*,void*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore14RequestContext4initERKNSt6__ndk110shared_ptrINS_20RequestContextConfigEEE");
    fn(obj,unused,cfg);
}

void _ZN21RequestContextManager9configureERKNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEEE(struct shared_ptr *ctx) {
    static void (__attribute__((sysv_abi)) *fn)(struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN21RequestContextManager9configureERKNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEEE");
    fn(ctx);
}

struct shared_ptr *_ZN22SVPlaybackLeaseManager12requestAssetERKmRKNSt6__ndk16vectorINS2_12basic_stringIcNS2_11char_traitsIcEENS2_9allocatorIcEEEENS7_IS9_EEEERKb(
    void *obj, void *unused, unsigned long *adamId, struct std_vector *flavors, uint8_t *offline) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*,void*,unsigned long*,struct std_vector*,uint8_t*) = NULL;
    if (!fn) fn = sym("_ZN22SVPlaybackLeaseManager12requestAssetERKmRKNSt6__ndk16vectorINS2_12basic_stringIcNS2_11char_traitsIcEENS2_9allocatorIcEEEENS7_IS9_EEEERKb");
    return fn(obj,unused,adamId,flavors,offline);
}

int _ZNK23SVPlaybackAssetResponse13hasValidAssetEv(void *obj) {
    static int (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK23SVPlaybackAssetResponse13hasValidAssetEv");
    return fn(obj);
}
struct shared_ptr *_ZNK23SVPlaybackAssetResponse13playbackAssetEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK23SVPlaybackAssetResponse13playbackAssetEv");
    return fn(obj);
}
int _ZNK23SVPlaybackAssetResponse9errorCodeEv(void *obj) {
    static int (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK23SVPlaybackAssetResponse9errorCodeEv");
    return fn(obj);
}
union std_string *_ZNK23SVPlaybackAssetResponse12errorMessageEv(void *obj, void *out) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZNK23SVPlaybackAssetResponse12errorMessageEv");
    return fn(obj,out);
}

union std_string *_ZNK17storeservicescore13PlaybackAsset9URLStringEv(void *obj, uint8_t *out) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*,uint8_t*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore13PlaybackAsset9URLStringEv");
    return fn(obj,out);
}
union std_string *_ZNK17storeservicescore13PlaybackAsset7flavorEv(void *obj, void *out) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore13PlaybackAsset7flavorEv");
    return fn(obj,out);
}
union std_string *_ZNK17storeservicescore13PlaybackAsset11downloadKeyEv(void *obj, void *out) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore13PlaybackAsset11downloadKeyEv");
    return fn(obj,out);
}

union std_string *_ZNK17storeservicescore14RequestContext20storeFrontIdentifierERKNSt6__ndk110shared_ptrINS_6URLBagEEE(
    void *obj, void *unused, struct shared_ptr *urlbag) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*,void*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore14RequestContext20storeFrontIdentifierERKNSt6__ndk110shared_ptrINS_6URLBagEEE");
    return fn(obj,unused,urlbag);
}

void _ZN21SVFootHillSessionCtrl16resetAllContextsEv(void *obj) {
    static void (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN21SVFootHillSessionCtrl16resetAllContextsEv");
    fn(obj);
}

void _ZN8FootHillC2ERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEES8_(
    void *obj, union std_string *root, union std_string *lib) {
    static void (__attribute__((sysv_abi)) *fn)(void*,union std_string*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN8FootHillC2ERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEES8_");
    fn(obj,root,lib);
}
void _ZN8FootHill24defaultContextIdentifierEv(void *obj) {
    static void (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN8FootHill24defaultContextIdentifierEv");
    fn(obj);
}

/* HTTPMessageC2: (obj, url*, method*) */
void *_ZN13mediaplatform11HTTPMessageC2ENSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES7_(
    void *obj, union std_string *url, union std_string *method) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,union std_string*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN13mediaplatform11HTTPMessageC2ENSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES7_");
    return fn(obj,url,method);
}

void _ZN13mediaplatform11HTTPMessage9setHeaderERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(
    void *obj, union std_string *name, union std_string *val) {
    static void (__attribute__((sysv_abi)) *fn)(void*,union std_string*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN13mediaplatform11HTTPMessage9setHeaderERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_");
    fn(obj,name,val);
}

void _ZN13mediaplatform11HTTPMessage11setBodyDataEPcm(void *obj, char *data, unsigned long len) {
    static void (__attribute__((sysv_abi)) *fn)(void*,char*,unsigned long) = NULL;
    if (!fn) fn = sym("_ZN13mediaplatform11HTTPMessage11setBodyDataEPcm");
    fn(obj,data,len);
}

void *_ZN17storeservicescore10DeviceGUID4guidEv(void *obj, void *out) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore10DeviceGUID4guidEv");
    return fn(obj,out);
}

char *_ZNK13mediaplatform4Data5bytesEv(void *data) {
    static char *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK13mediaplatform4Data5bytesEv");
    return fn(data);
}

size_t _ZNK13mediaplatform4Data6lengthEv(void *data) {
    static size_t (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK13mediaplatform4Data6lengthEv");
    return fn(data);
}

void *_ZN17storeservicescore10URLRequestC2ERKNSt6__ndk110shared_ptrIN13mediaplatform11HTTPMessageEEERKNS2_INS_14RequestContextEEE(
    void *obj, struct shared_ptr *msg, struct shared_ptr *ctx) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,struct shared_ptr*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore10URLRequestC2ERKNSt6__ndk110shared_ptrIN13mediaplatform11HTTPMessageEEERKNS2_INS_14RequestContextEEE");
    return fn(obj,msg,ctx);
}

void *_ZN17storeservicescore10URLRequest19setRequestParameterERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(
    void *obj, union std_string *key, union std_string *val) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,union std_string*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore10URLRequest19setRequestParameterERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_");
    return fn(obj,key,val);
}

void *_ZN17storeservicescore10URLRequest3runEv(void *obj) {
    static void *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore10URLRequest3runEv");
    return fn(obj);
}
struct shared_ptr *_ZNK17storeservicescore10URLRequest5errorEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore10URLRequest5errorEv");
    return fn(obj);
}
struct shared_ptr *_ZNK17storeservicescore10URLRequest8responseEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore10URLRequest8responseEv");
    return fn(obj);
}
struct shared_ptr *_ZNK17storeservicescore11URLResponse18underlyingResponseEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore11URLResponse18underlyingResponseEv");
    return fn(obj);
}

void *_ZN17storeservicescore15PurchaseRequestC2ERKNSt6__ndk110shared_ptrINS_14RequestContextEEE(
    void *obj, struct shared_ptr *ctx) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,struct shared_ptr*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore15PurchaseRequestC2ERKNSt6__ndk110shared_ptrINS_14RequestContextEEE");
    return fn(obj,ctx);
}
void *_ZN17storeservicescore15PurchaseRequest23setProcessDialogActionsEb(void *obj, int flag) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,int) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore15PurchaseRequest23setProcessDialogActionsEb");
    return fn(obj,flag);
}
void *_ZN17storeservicescore15PurchaseRequest12setURLBagKeyERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(void *obj, union std_string *s) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore15PurchaseRequest12setURLBagKeyERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    return fn(obj,s);
}
void *_ZN17storeservicescore15PurchaseRequest16setBuyParametersERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(void *obj, union std_string *s) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,union std_string*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore15PurchaseRequest16setBuyParametersERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    return fn(obj,s);
}
void *_ZN17storeservicescore15PurchaseRequest3runEv(void *obj) {
    static void *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore15PurchaseRequest3runEv");
    return fn(obj);
}
struct shared_ptr *_ZNK17storeservicescore15PurchaseRequest8responseEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore15PurchaseRequest8responseEv");
    return fn(obj);
}
struct shared_ptr *_ZN17storeservicescore16PurchaseResponse5errorEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore16PurchaseResponse5errorEv");
    return fn(obj);
}
struct std_vector _ZNK17storeservicescore16PurchaseResponse5itemsEv(void *obj) {
    static struct std_vector (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore16PurchaseResponse5itemsEv");
    return fn(obj);
}
struct std_vector _ZNK17storeservicescore12PurchaseItem6assetsEv(void *obj) {
    static struct std_vector (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore12PurchaseItem6assetsEv");
    return fn(obj);
}
union std_string *_ZNK17storeservicescore13PurchaseAsset3URLEv(void *obj, void *out) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore13PurchaseAsset3URLEv");
    return fn(obj,out);
}
union std_string *_ZNK17storeservicescore13PurchaseAsset11downloadKeyEv(void *obj, void *out) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore13PurchaseAsset11downloadKeyEv");
    return fn(obj,out);
}
#ifdef _WIN32
struct native_error_code *_ZNK17storeservicescore19StoreErrorCondition9errorCodeEv(void *obj) {
    static struct native_error_code *(__attribute__((sysv_abi)) *fn)(void *) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore19StoreErrorCondition9errorCodeEv");
    return fn(obj);
}
#else
int _ZNK17storeservicescore19StoreErrorCondition9errorCodeEv(void *obj) {
    static int (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore19StoreErrorCondition9errorCodeEv");
    return fn(obj);
}
#endif
const char *_ZNK17storeservicescore19StoreErrorCondition4whatEv(void *obj) {
    static const char *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore19StoreErrorCondition4whatEv");
    return fn(obj);
}
struct shared_ptr *_ZNK17storeservicescore20AuthenticateResponse5errorEv(void *obj) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore20AuthenticateResponse5errorEv");
    return fn(obj);
}
union std_string *_ZNK17storeservicescore20AuthenticateResponse15customerMessageEv(void *obj) {
    static union std_string *(__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore20AuthenticateResponse15customerMessageEv");
    return fn(obj);
}
void *_ZN17storeservicescore14RequestContext8fairPlayEv(void *obj, void *out) {
    static void *(__attribute__((sysv_abi)) *fn)(void*,void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore14RequestContext8fairPlayEv");
    return fn(obj,out);
}
struct std_vector _ZN17storeservicescore8FairPlay21getSubscriptionStatusEv(void *obj) {
    static struct std_vector (__attribute__((sysv_abi)) *fn)(void*) = NULL;
    if (!fn) fn = sym("_ZN17storeservicescore8FairPlay21getSubscriptionStatusEv");
    return fn(obj);
}

/* itun FairPlay decryption */
struct std_vector *_ZNK17storeservicescore13PlaybackAsset5sinfsEv(
    struct std_vector *ret, void *playbackAsset) {
    static struct std_vector *(__attribute__((sysv_abi)) *fn)(struct std_vector*,void*) = NULL;
    if (!fn) fn = sym("_ZNK17storeservicescore13PlaybackAsset5sinfsEv");
    return fn(ret,playbackAsset);
}

struct shared_ptr *_ZN18SVDecryptorFactory6createERKN11SVDecryptor15SVDecryptorTypeEPKhRKjS5_S7_RKNS0_20SVDecryptorTrackTypeERKbSC_(
    struct shared_ptr *ret, int *protType, const uint8_t *keyData, uint32_t *keyLen,
    const uint8_t *ivData, uint32_t *ivLen, int *trackType, uint8_t *b1, uint8_t *b2) {
    static struct shared_ptr *(__attribute__((sysv_abi)) *fn)(struct shared_ptr*,int*,const uint8_t*,uint32_t*,
                                    const uint8_t*,uint32_t*,int*,uint8_t*,uint8_t*) = NULL;
    if (!fn) fn = sym("_ZN18SVDecryptorFactory6createERKN11SVDecryptor15SVDecryptorTypeEPKhRKjS5_S7_RKNS0_20SVDecryptorTrackTypeERKbSC_");
    return fn(ret,protType,keyData,keyLen,ivData,ivLen,trackType,b1,b2);
}

void _ZN17SVPastisDecryptor13decryptSampleEPKhRKjPj(
    void *decryptor, const uint8_t *data, const uint32_t *len, uint32_t *outLen) {
    static void (__attribute__((sysv_abi)) *fn)(void*,const uint8_t*,const uint32_t*,uint32_t*) = NULL;
    if (!fn) fn = sym("_ZN17SVPastisDecryptor13decryptSampleEPKhRKjPj");
    fn(decryptor,data,len,outLen);
}
