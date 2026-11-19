/*
 * stage12_probe.c — wire stub C++ providers into SessionBuilder and call make().
 *
 * Key advances over stage11:
 *   1. BundleInfoWrapper_make: return type changed to jobject — captures the
 *      C++ BundleInfoWrapper* returned by the factory.
 *   2. Stub C++ provider objects (IHTTPProvider, IMescalProvider,
 *      IAccountProvider, IFairPlayCoreProvider) with 20-entry noop vtables.
 *      These are pure C++ abstract interfaces with no JNI allocate function.
 *   3. SessionBuilder_set* called with stub providers before make().
 *   4. SessionBuilder_make return type changed to jobject — captures Session.
 *   5. Session getters probed to verify the returned Session is valid.
 *
 * Tests:
 *   1. BundleInfoWrapper_make → capture jobject, verify non-null C++ ptr
 *   2. SessionBuilder_allocate → verify C++ ptr
 *   3. Build 4 stub C++ providers with noop vtables
 *   4. SessionBuilder_set{HTTP,Mescal,Account,FairPlayCore}Provider
 *   5. SessionBuilder_make → capture Session jobject
 *   6. Session_getAccountProvider / Session_getAnisetteProvider probes
 *
 * Build: make  (from spike/newstack/stage12_session/)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>
#include <signal.h>
#include <ucontext.h>
#include <setjmp.h>
#include "../../../drm/embedded_loader.h"
#include "fake_jni.h"

/* ---- Recoverable SIGSEGV handler --------------------------------------- */
static jmp_buf  g_recover;
static volatile int g_in_safe = 0;
static volatile void *g_fault_addr = NULL;

static void sigsegv_handler(int sig, siginfo_t *si, void *ctx) {
    (void)sig; (void)ctx;
    g_fault_addr = si->si_addr;
    if (g_in_safe) {
        g_in_safe = 0;
        siglongjmp(g_recover, 1);
    }
    char buf[128];
    int n = snprintf(buf, sizeof(buf), "[SIGSEGV] fault at addr=%p (fatal)\n", si->si_addr);
    if (n > 0) { int r = write(2, buf, (size_t)n); (void)r; }
    signal(SIGSEGV, SIG_DFL);
    raise(SIGSEGV);
}

/* Call fn with recovery: returns 0 on success, 1 on SIGSEGV. */
#define SAFE_CALL(label, expr) do {                              \
    g_in_safe = 1;                                               \
    g_fault_addr = NULL;                                         \
    if (sigsetjmp(g_recover, 1) == 0) {                          \
        (expr);                                                  \
        g_in_safe = 0;                                           \
        printf("  %-38s → ok\n", (label));                       \
    } else {                                                     \
        printf("  %-38s → SIGSEGV at %p\n", (label), (void*)g_fault_addr); \
    }                                                            \
} while(0)

#define LIB64 "../../../drm/rootfs-6.5.2/system/lib64"

static FILE *g_sF[3];

static int shim_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) {
    (void)a; (void)b; (void)c; (void)d; return 0;
}
static void *shim_memchr_chk(const void *s, int c, size_t n, size_t bs) {
    (void)bs; return (void *)memchr(s, c, n);
}
static void *hook(const char *sym, const char *req) {
    if (!sym) return NULL;
    if (!strcmp(sym, "__register_atfork"))   return (void *)shim_atfork;
    if (!strcmp(sym, "__memchr_chk"))        return (void *)shim_memchr_chk;
    if (!strcmp(sym, "stdout"))  return (void *)stdout;
    if (!strcmp(sym, "stderr"))  return (void *)stderr;
    if (!strcmp(sym, "stdin"))   return (void *)stdin;
    if (!strcmp(sym, "__sF"))    return (void *)g_sF;
    return NULL;
}

/* ---- Stub C++ providers ------------------------------------------------- *
 * IHTTPProvider, IMescalProvider, IAccountProvider, IFairPlayCoreProvider    *
 * are pure C++ abstract interfaces with NO JNI allocate function.            *
 * We create raw C++ objects: vtable pointer at offset 0, noop stubs.         *
 * The setters just store these pointers — they don't call methods on them.   *
 * Virtual method dispatch only happens during perform().                     *
 * ------------------------------------------------------------------ */

/*
 * Noop stub returning NULL (safe for "get a pointer" virtuals).
 * Also serves void virtuals since the return value is ignored.
 */
static void *stub_vfn(void) { return NULL; }

#define STUB_VT_SIZE 24
static uintptr_t g_stub_vtable[STUB_VT_SIZE];

static void init_stub_vtable(void) {
    for (int i = 0; i < STUB_VT_SIZE; i++)
        g_stub_vtable[i] = (uintptr_t)stub_vfn;
}

/*
 * A minimal C++ object: vtable pointer at offset 0, 7 data words.
 * Caller sets cxx.vtable_ptr = (uintptr_t)g_stub_vtable before use.
 */
typedef struct { uintptr_t vtable_ptr; uintptr_t data[7]; } stub_cxx_t;

static fake_obj_t *make_stub_provider(stub_cxx_t *cxx) {
    cxx->vtable_ptr = (uintptr_t)g_stub_vtable;
    fake_obj_t *o = fake_alloc_obj(0);
    o->address = (jlong)(uintptr_t)cxx;
    return o;
}

/* Four stub C++ provider objects (static lifetime). */
static stub_cxx_t s_http_cxx;
static stub_cxx_t s_mescal_cxx;
static stub_cxx_t s_account_cxx;
static stub_cxx_t s_fairplay_cxx;

/* ---- Helpers ------------------------------------------------------------ */
static void *hybrid_load(const char *name) {
    void *h = embedded_dlopen(name, RTLD_NOW | RTLD_GLOBAL);
    if (!h) fprintf(stderr, "embedded_dlopen(%s): %s\n", name, embedded_dlerror());
    else printf("[+] loaded %s\n", name);
    return h;
}

static void *resolve_sym(const char *sym) {
    void *fn = embedded_dlsym(sym);
    if (fn) printf("  [sym] %-60s OK  %p\n", sym, fn);
    else    printf("  [sym] %-60s MISSING\n", sym);
    return fn;
}

static void dump_obj(const char *label, fake_obj_t *o) {
    printf("  [obj] %s: class_id=0x%lx  address=0x%lx\n",
           label, o ? (unsigned long)o->class_id : 0, o ? (unsigned long)o->address : 0);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    struct sigaction sa = {0};
    sa.sa_flags = SA_SIGINFO | SA_NODEFER;
    sa.sa_sigaction = sigsegv_handler;
    sigaction(SIGSEGV, &sa, NULL);

    printf("=== stage12 session probe ===\n\n");

    g_sF[0] = stdin; g_sF[1] = stdout; g_sF[2] = stderr;
    init_stub_vtable();

    setenv("HYBRIS_LINKER_DIR",      "../../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", LIB64, 1);
    setenv("HYBRIS_ANDROID_LIB64",   LIB64, 1);
    setenv("ANDROID_ROOT",  "/tmp/newstack-root", 0);
    setenv("ANDROID_DATA",  "/tmp/newstack-data", 0);
    mkdir("/tmp/newstack-data", 0700);

    if (embedded_loader_init() != 0) {
        fprintf(stderr, "hybris init: %s\n", embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    hybrid_load("libz.so");
    hybrid_load("libm.so");
    hybrid_load("libc++_shared.so");
    void *hams = hybrid_load("libAMSKit.so");
    if (!hams) return 1;

    /* Patch javacpp field-ID globals.
     * JNI_OnLoad normally populates these by calling GetFieldID("address"),
     * GetFieldID("position"), etc.  Under our fake JNI it never does, so the
     * BSS slots stay zero and every setter hits the null-ptr early-exit path.
     *
     * BundleInfoWrapper_make (5-String variant) has ELF VMA 0x4f73b0; subtract
     * from the runtime address to get the library load base.
     */
    {
        const char *anchor_sym =
            "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
            "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
            "Ljava_lang_String_2Ljava_lang_String_2";
        uintptr_t anchor = (uintptr_t)embedded_dlsym(anchor_sym);
        if (!anchor) { fprintf(stderr, "FATAL: anchor symbol not found\n"); return 1; }
        uintptr_t lib_base = anchor - 0x4f73b0UL;
        printf("[javacpp-patch] anchor=0x%lx  lib_base=0x%lx\n", anchor, lib_base);
        /* Globals at ELF VMA 0x90b5a8–0x90b5d0 (6 consecutive pointer-size slots) */
        *(jfieldID *)(lib_base + 0x90b5a8) = FID_ADDRESS;    /* "address" (thiz + provider sub-obj) */
        *(jfieldID *)(lib_base + 0x90b5b0) = FID_POSITION;   /* "position" */
        *(jfieldID *)(lib_base + 0x90b5b8) = FID_LIMIT;      /* "limit" */
        *(jfieldID *)(lib_base + 0x90b5c0) = FID_CAPACITY;   /* "capacity" */
        *(jfieldID *)(lib_base + 0x90b5c8) = FID_OTHER;      /* GetObjectField fid (ignored by fake) */
        *(jfieldID *)(lib_base + 0x90b5d0) = FID_ADDRESS;    /* "address" on the returned sub-object */
        printf("[javacpp-patch] globals written OK\n");
    }
    printf("\n");

    JNIEnv *env = fake_jni_env();

    /* ------------------------------------------------------------------ *
     * Test 1: BundleInfoWrapper_make (String variant, static factory)     *
     *   Return type is jobject — the factory allocates the wrapper and    *
     *   returns it.  fake_AllocObject in our JNI creates a fake_obj_t;   *
     *   SetLongField/CallVoidMethodA stores the C++ ptr into it.          *
     * ------------------------------------------------------------------ */
    printf("[test 1] BundleInfoWrapper_make\n");
    const char *s_bimake =
        "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
        "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
        "Ljava_lang_String_2Ljava_lang_String_2";
    typedef jobject (*fn_binfo_t)(JNIEnv *, jclass,
        jobject, jobject, jobject, jobject, jobject);
    fn_binfo_t make_binfo = (fn_binfo_t)resolve_sym(s_bimake);
    fake_obj_t *binfo_obj = NULL;
    if (make_binfo) {
        fake_obj_t *bs1 = fake_byteptr("com.apple.android.music");
        fake_obj_t *bs2 = fake_byteptr("1586");
        fake_obj_t *bs3 = fake_byteptr("6.5.2");
        fake_obj_t *bs4 = fake_byteptr("23B74");
        fake_obj_t *bs5 = fake_byteptr("Android 14");
        jobject ret = make_binfo(env, (jclass)(uintptr_t)42, bs1, bs2, bs3, bs4, bs5);
        binfo_obj = (fake_obj_t *)ret;
        dump_obj("BundleInfoWrapper", binfo_obj);
        free(bs1); free(bs2); free(bs3); free(bs4); free(bs5);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 2: SessionBuilder_allocate                                     *
     * ------------------------------------------------------------------ */
    printf("[test 2] SessionBuilder_allocate\n");
    const char *s_sballoc = "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_allocate";
    typedef void (*fn_sballoc_t)(JNIEnv *, jobject);
    fn_sballoc_t alloc_sb = (fn_sballoc_t)resolve_sym(s_sballoc);
    fake_obj_t *sb_obj = NULL;
    if (alloc_sb) {
        sb_obj = fake_alloc_obj(0);
        alloc_sb(env, sb_obj);
        dump_obj("SessionBuilder", sb_obj);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 3: Stub C++ providers                                          *
     *   IHTTPProvider, IMescalProvider, IAccountProvider,                *
     *   IFairPlayCoreProvider have NO JNI allocate functions — pure C++. *
     *   We create raw stub objects with 24-entry noop vtables.           *
     * ------------------------------------------------------------------ */
    printf("[test 3] Create stub C++ providers\n");
    fake_obj_t *http_prov    = make_stub_provider(&s_http_cxx);
    fake_obj_t *mescal_prov  = make_stub_provider(&s_mescal_cxx);
    fake_obj_t *account_prov = make_stub_provider(&s_account_cxx);
    fake_obj_t *fp_prov      = make_stub_provider(&s_fairplay_cxx);
    printf("  http_prov    C++ = %p\n", (void*)(uintptr_t)http_prov->address);
    printf("  mescal_prov  C++ = %p\n", (void*)(uintptr_t)mescal_prov->address);
    printf("  account_prov C++ = %p\n", (void*)(uintptr_t)account_prov->address);
    printf("  fp_prov      C++ = %p\n", (void*)(uintptr_t)fp_prov->address);
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 4: SessionBuilder_set* — wire providers into the builder.     *
     *   Each setter calls GetLongField(env, provider_obj, fid) to get    *
     *   the C++ ptr and stores it in the SessionBuilder struct.           *
     * ------------------------------------------------------------------ */
    printf("[test 4] SessionBuilder_set* providers\n");
    if (!sb_obj || !sb_obj->address) { printf("  SKIP: no SessionBuilder\n\n"); goto test5; }

    {
        typedef void (*fn_set_t)(JNIEnv *, jobject, jobject);
        fn_set_t set_http    = (fn_set_t)resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setHTTPProvider");
        fn_set_t set_mescal  = (fn_set_t)resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setMescalProvider");
        fn_set_t set_account = (fn_set_t)resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setAccountProvider");
        fn_set_t set_fp      = (fn_set_t)resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setFairPlayCoreProvider");

#define DUMP_SB(label) do { \
    if (sb_obj && sb_obj->address) { \
        uintptr_t *_c = (uintptr_t*)(uintptr_t)sb_obj->address; \
        printf("  [dump %s] cxx[0x00]=0x%lx [0x08]=0x%lx [0x10]=0x%lx [0x18]=0x%lx\n", label, _c[0],_c[1],_c[2],_c[3]); \
        printf("            [0x20]=0x%lx [0x28]=0x%lx [0x30]=0x%lx [0x38]=0x%lx\n", _c[4],_c[5],_c[6],_c[7]); \
        printf("            [0x40]=0x%lx [0x48]=0x%lx [0x50]=0x%lx [0x58]=0x%lx\n", _c[8],_c[9],_c[10],_c[11]); \
    } } while(0)

        DUMP_SB("before-setHTTP");
        g_jni_trace = 1;
        if (set_http)    SAFE_CALL("setHTTPProvider",         set_http(env, sb_obj, http_prov));
        g_jni_trace = 0;
        DUMP_SB("after-setHTTP");
        if (set_mescal)  SAFE_CALL("setMescalProvider",       set_mescal(env, sb_obj, mescal_prov));
        DUMP_SB("after-setMescal");
        if (set_account) SAFE_CALL("setAccountProvider",      set_account(env, sb_obj, account_prov));
        DUMP_SB("after-setAccount");
        if (set_fp)      SAFE_CALL("setFairPlayCoreProvider",  set_fp(env, sb_obj, fp_prov));
        DUMP_SB("after-setFP");

        /* Dump the SessionBuilder C++ struct AFTER all setters. */
    }
    printf("\n");

test5:;
    /* ------------------------------------------------------------------ *
     * Test 5: SessionBuilder_make (BytePointer variant)                  *
     *   Now that providers are set, make() should populate the Session   *
     *   without hitting the null-provider assert.                         *
     *   Return type is jobject — capture the Session.                    *
     * ------------------------------------------------------------------ */
    printf("[test 5] SessionBuilder_make\n");
    const char *s_sbmake =
        "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_make__"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2ZB";
    typedef jobject (*fn_sbmake_t)(JNIEnv *, jobject,
        jobject, jobject, jobject, jobject, jobject,
        jobject, jobject, jobject, jobject,
        jobject,
        jobject, jobject,
        jboolean, jbyte);
    fn_sbmake_t sb_make = (fn_sbmake_t)resolve_sym(s_sbmake);
    fake_obj_t *session_obj = NULL;

    if (sb_make && sb_obj && sb_obj->address) {
        fake_obj_t *sp1  = fake_byteptr("com.apple.android.music");
        fake_obj_t *sp2  = fake_byteptr("6.5.2");
        fake_obj_t *sp3  = fake_byteptr("1586");
        fake_obj_t *sp4  = fake_byteptr("android");
        fake_obj_t *sp5  = fake_byteptr("14.0");
        fake_obj_t *sp6  = fake_byteptr("x86_64");
        fake_obj_t *sp7  = fake_byteptr("linux");
        fake_obj_t *sp8  = fake_byteptr("en_US");
        fake_obj_t *sp9  = fake_byteptr("143441");
        fake_obj_t *sp10 = fake_byteptr("");
        fake_obj_t *sp11 = fake_byteptr("");

        printf("  sb_obj->address = 0x%lx\n", (unsigned long)sb_obj->address);
        jobject make_ret = NULL;
        SAFE_CALL("SessionBuilder_make",
            make_ret = sb_make(env, sb_obj,
                               sp1, sp2, sp3, sp4, sp5, sp6, sp7, sp8, sp9,
                               binfo_obj, sp10, sp11,
                               JNI_FALSE, (jbyte)0));
        session_obj = (fake_obj_t *)make_ret;
        dump_obj("Session (returned)", session_obj);

        free(sp1); free(sp2); free(sp3); free(sp4); free(sp5);
        free(sp6); free(sp7); free(sp8); free(sp9); free(sp10); free(sp11);
    } else {
        printf("  SKIP: no SessionBuilder\n");
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 6: Session getter probes                                       *
     *   If we got a Session, try getAccountProvider etc. to confirm the  *
     *   Session's internal state is accessible.                           *
     * ------------------------------------------------------------------ */
    printf("[test 6] Session getter probes\n");
    if (session_obj && session_obj->address) {
        typedef jobject (*fn_sess_get_t)(JNIEnv *, jobject);
        fn_sess_get_t get_account = (fn_sess_get_t)resolve_sym(
            "Java_com_apple_mediaservices_amskit_bindings_Session_getAccountProvider");
        fn_sess_get_t get_anisette = (fn_sess_get_t)resolve_sym(
            "Java_com_apple_mediaservices_amskit_bindings_Session_getAnisetteProvider");
        fn_sess_get_t get_mescal = (fn_sess_get_t)resolve_sym(
            "Java_com_apple_mediaservices_amskit_bindings_Session_getMescalProvider");

        if (get_account) {
            jobject r = get_account(env, session_obj);
            fake_obj_t *o = (fake_obj_t*)r;
            printf("  getAccountProvider  → C++ addr=0x%lx\n",
                   (unsigned long)(o ? o->address : 0));
        }
        if (get_anisette) {
            jobject r = get_anisette(env, session_obj);
            fake_obj_t *o = (fake_obj_t*)r;
            printf("  getAnisetteProvider → C++ addr=0x%lx\n",
                   (unsigned long)(o ? o->address : 0));
        }
        if (get_mescal) {
            jobject r = get_mescal(env, session_obj);
            fake_obj_t *o = (fake_obj_t*)r;
            printf("  getMescalProvider   → C++ addr=0x%lx\n",
                   (unsigned long)(o ? o->address : 0));
        }
    } else {
        printf("  SKIP: no Session object\n");
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 7: Symbol scan for perform and IdMSBagService                  *
     * ------------------------------------------------------------------ */
    printf("[test 7] perform + IdMSBagService symbol scan\n");
    resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_perform__"
        "Lcom_apple_mediaservices_amskit_bindings_Session_2"
        "Lcom_apple_mediaservices_amskit_bindings_DialogResult_2"
        "Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2");
    resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_performICloudAuthentication__"
        "Lcom_apple_mediaservices_amskit_bindings_Session_2"
        "Lcom_apple_mediaservices_amskit_bindings_IdMSBagService_2"
        "Lcom_apple_mediaservices_amskit_bindings_AMSURL_2"
        "Ljava_lang_String_2");
    resolve_sym("Java_com_apple_mediaservices_amskit_bindings_Session__1close");
    resolve_sym("Java_com_apple_mediaservices_amskit_bindings_Session_setAnisetteProvider");
    printf("\n");

    /* cleanup */
    free(http_prov); free(mescal_prov); free(account_prov); free(fp_prov);
    if (sb_obj)      free(sb_obj);
    if (binfo_obj)   free(binfo_obj);
    if (session_obj) free(session_obj);

    printf("=== probe done ===\n");
    return 0;
}
