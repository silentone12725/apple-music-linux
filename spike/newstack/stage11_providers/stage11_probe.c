/*
 * stage11_probe.c — verify real C++ object pointers from allocate() functions,
 * introspect vtable layout, and call SessionBuilder_make with real providers.
 *
 * Key advance over stage10:
 *   fake_CallVoidMethodA now stores args[0].j in fake_obj->address.
 *   This means allocate() functions set a real C++ pointer in the fake_obj.
 *   We pass fake_obj_t* as the second argument (not an integer jclass=42).
 *
 * Tests:
 *   1. IInterruptHandlerAdaptor_allocate → real C++ ptr + vtable dump
 *   2. INativeAnisetteProvider_allocate  → real C++ ptr + vtable dump
 *   3. SessionBuilder_allocate + make    → real session builder + providers
 *   4. SessionBuilder_setHTTPProvider   → wire providers to builder
 *
 * Build (from spike/newstack/stage11_providers/):
 *   make
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
#include "../../../drm/embedded_loader.h"
#include "fake_jni.h"

static void sigsegv_handler(int sig, siginfo_t *si, void *ctx) {
    (void)sig; (void)ctx;
    char buf[128];
    int n = snprintf(buf, sizeof(buf), "[SIGSEGV] fault at addr=%p\n", si->si_addr);
    if (n > 0) { int r = write(2, buf, (size_t)n); (void)r; }
    signal(SIGSEGV, SIG_DFL);
    raise(SIGSEGV);
}

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

/* No-op stub for minimal C++ provider vtable entries. */
static void stub_provider_noop(void) {}

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

/* Print the vtable of a C++ object whose pointer is in fake_obj->address. */
static void dump_vtable(const char *label, fake_obj_t *obj, int nentries) {
    jlong cxx_ptr = obj ? obj->address : 0;
    if (!cxx_ptr || (uintptr_t)cxx_ptr < 0x1000) {
        printf("  [vtable] %s: no C++ ptr\n", label);
        return;
    }
    uintptr_t *cxx = (uintptr_t*)(uintptr_t)cxx_ptr;
    uintptr_t vtab = cxx[0];
    printf("  [vtable] %s: C++ obj=%p  vtable=%p\n", label, (void*)cxx_ptr, (void*)vtab);
    if (!vtab || (uintptr_t)vtab < 0x1000) return;
    uintptr_t *vt = (uintptr_t*)vtab;
    for (int i = 0; i < nentries; i++) {
        printf("           vt[%2d] = %p\n", i, (void*)vt[i]);
    }
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    struct sigaction sa = {0};
    sa.sa_flags = SA_SIGINFO;
    sa.sa_sigaction = sigsegv_handler;
    sigaction(SIGSEGV, &sa, NULL);

    printf("=== stage11 providers probe ===\n\n");

    g_sF[0] = stdin; g_sF[1] = stdout; g_sF[2] = stderr;

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
    printf("\n");

    JNIEnv *env = fake_jni_env();

    /* ------------------------------------------------------------------ *
     * Test 1: IInterruptHandlerAdaptor_allocate                           *
     *   Pass a real fake_obj_t* as 'this'. After the call, fake_obj->     *
     *   address should hold the real C++ pointer (via CallVoidMethodA).   *
     * ------------------------------------------------------------------ */
    printf("[test 1] IInterruptHandlerAdaptor_allocate\n");
    const char *s1 = "Java_com_apple_mediaservices_amskit_authentication_IInterruptHandlerAdaptor_allocate";
    typedef void (*fn_alloc1_t)(JNIEnv *, jobject);
    fn_alloc1_t alloc_handler = (fn_alloc1_t)resolve_sym(s1);
    fake_obj_t *handler_obj = NULL;
    if (alloc_handler) {
        handler_obj = fake_alloc_obj(0);
        alloc_handler(env, handler_obj);
        printf("  → fake_obj->address = 0x%lx\n", handler_obj->address);
        dump_vtable("IInterruptHandlerAdaptor", handler_obj, 8);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 2: INativeAnisetteProvider_allocate                            *
     *   Same pattern — pass fake_obj_t* as 'this'.                        *
     * ------------------------------------------------------------------ */
    printf("[test 2] INativeAnisetteProvider_allocate\n");
    const char *s2 = "Java_com_apple_mediaservices_amskit_bindings_INativeAnisetteProvider_allocate";
    typedef void (*fn_alloc2_t)(JNIEnv *, jobject);
    fn_alloc2_t alloc_anisette = (fn_alloc2_t)resolve_sym(s2);
    fake_obj_t *anisette_obj = NULL;
    if (alloc_anisette) {
        anisette_obj = fake_alloc_obj(0);
        alloc_anisette(env, anisette_obj);
        printf("  → fake_obj->address = 0x%lx\n", anisette_obj->address);
        dump_vtable("INativeAnisetteProvider", anisette_obj, 8);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 3: SessionBuilder_allocate                                      *
     * ------------------------------------------------------------------ */
    printf("[test 3] SessionBuilder_allocate\n");
    const char *s3 = "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_allocate";
    typedef void (*fn_sb_alloc_t)(JNIEnv *, jobject);
    fn_sb_alloc_t alloc_sb = (fn_sb_alloc_t)resolve_sym(s3);
    fake_obj_t *sb_obj = NULL;
    if (alloc_sb) {
        sb_obj = fake_alloc_obj(0);
        alloc_sb(env, sb_obj);
        printf("  → fake_obj->address = 0x%lx\n", sb_obj->address);
        dump_vtable("SessionBuilder", sb_obj, 6);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 4: SessionBuilder_make (BytePointer variant, 9+binfo+2+Z+B)    *
     *   Now sb_obj has a real C++ ptr so GetLongField(env, sb_obj, fid)   *
     *   returns the actual SessionBuilder* and C++ code can proceed.      *
     * ------------------------------------------------------------------ */
    printf("[test 4] SessionBuilder_make\n");
    const char *s4 =
        "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_make__"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2ZB";
    typedef void (*fn_sbmake_t)(JNIEnv *, jobject,
        jobject, jobject, jobject, jobject, jobject,
        jobject, jobject, jobject, jobject,
        jobject,
        jobject, jobject,
        jboolean, jbyte);
    fn_sbmake_t sb_make = (fn_sbmake_t)resolve_sym(s4);

    fake_obj_t *result_obj = NULL;
    if (sb_make && sb_obj && sb_obj->address) {
        /* BundleInfoWrapper: build it first */
        const char *s_binfo =
            "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
            "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
            "Ljava_lang_String_2Ljava_lang_String_2";
        typedef void (*fn_binfo_t)(JNIEnv *, jobject, jobject, jobject, jobject, jobject, jobject);
        fn_binfo_t make_binfo = (fn_binfo_t)resolve_sym(s_binfo);
        fake_obj_t *binfo_obj = fake_alloc_obj(0);
        if (make_binfo) {
            fake_obj_t *bs1 = fake_byteptr("com.apple.android.music");
            fake_obj_t *bs2 = fake_byteptr("1586");
            fake_obj_t *bs3 = fake_byteptr("6.5.2");
            fake_obj_t *bs4 = fake_byteptr("23B74");
            fake_obj_t *bs5 = fake_byteptr("Android 14");
            make_binfo(env, binfo_obj, bs1, bs2, bs3, bs4, bs5);
            printf("  binfo C++ ptr = 0x%lx\n", binfo_obj->address);
            free(bs1); free(bs2); free(bs3); free(bs4); free(bs5);
        }

        /* result_obj receives the Session (or Expected<Session>) */
        result_obj = fake_alloc_obj(0);

        /* The BytePointer make variant: sb_obj is thiz.
         * Since sb_obj->address is now valid, GetLongField returns the real
         * C++ SessionBuilder* and the constructor proceeds. */
        fake_obj_t *sp1  = fake_byteptr("com.apple.android.music"); /* bundleID */
        fake_obj_t *sp2  = fake_byteptr("6.5.2");                   /* appVersion */
        fake_obj_t *sp3  = fake_byteptr("1586");                     /* build */
        fake_obj_t *sp4  = fake_byteptr("android");                  /* platform */
        fake_obj_t *sp5  = fake_byteptr("14.0");                     /* osVersion */
        fake_obj_t *sp6  = fake_byteptr("x86_64");                   /* deviceModel */
        fake_obj_t *sp7  = fake_byteptr("linux");                    /* hardwareModel */
        fake_obj_t *sp8  = fake_byteptr("en_US");                    /* locale */
        fake_obj_t *sp9  = fake_byteptr("143441");                   /* storefront */
        fake_obj_t *sp10 = fake_byteptr("");                         /* extra1 */
        fake_obj_t *sp11 = fake_byteptr("");                         /* extra2 */

        printf("  calling sb_make (sb_obj->address=0x%lx)...\n", sb_obj->address);
        sb_make(env, sb_obj,
                sp1, sp2, sp3, sp4, sp5, sp6, sp7, sp8, sp9,
                binfo_obj,
                sp10, sp11,
                JNI_FALSE, (jbyte)0);
        printf("  → sb_obj->address after make = 0x%lx\n", sb_obj->address);
        printf("  → returned (no crash)\n");

        free(sp1); free(sp2); free(sp3); free(sp4); free(sp5);
        free(sp6); free(sp7); free(sp8); free(sp9); free(sp10); free(sp11);
        free(binfo_obj);
    } else if (!sb_obj || !sb_obj->address) {
        printf("  SKIP: sb_obj has no C++ ptr\n");
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Test 5: SessionBuilder setters — vtable inspection                 *
     *   List setHTTPProvider, setMescalProvider, setAccountProvider.     *
     *   We do NOT call them: SessionBuilder's C++ vtable is nil until a  *
     *   full constructor path is wired (stage12 work).                   *
     * ------------------------------------------------------------------ */
    printf("[test 5] SessionBuilder setter symbol check\n");
    resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setHTTPProvider");
    resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setMescalProvider");
    resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setAccountProvider");
    resolve_sym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setFairPlayCoreProvider");
    resolve_sym("Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_perform__Lcom_apple_mediaservices_amskit_bindings_Session_2Lcom_apple_mediaservices_amskit_bindings_DialogResult_2Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2");
    printf("  → symbol check only (calling requires full constructor path)\n");
    printf("\n");

    /* ------------------------------------------------------------------ *
     * Cleanup                                                              *
     * ------------------------------------------------------------------ */
    if (handler_obj)  free(handler_obj);
    if (anisette_obj) free(anisette_obj);
    if (sb_obj)       free(sb_obj);
    if (result_obj)   free(result_obj);

    printf("=== probe done ===\n");
    return 0;
}
