/*
 * stage10_amskit_probe.c — verify that libAMSKit.so loads via hybris and
 * responds to calls via a minimal fake JNI env.
 *
 * libAMSKit.so is x86_64 Android NDK — still needs hybris because it links
 * against bionic libc.so, not Linux glibc.  Extra shims needed:
 *   stdout / __sF  — bionic data symbols; return glibc equivalents.
 *
 * Goals:
 *   1. Load libAMSKit.so through the existing embedded hybris loader.
 *   2. Call IInterruptHandlerAdaptor_allocate(env, cls) with fake JNIEnv.
 *   3. Call BundleInfoWrapper_make with string args.
 *   4. Log results to confirm the C++ layer is reachable.
 *
 * Build (from spike/newstack/stage10_amskit/):
 *   make
 *
 * Run:
 *   make run
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

/* rootfs-6.5.2 has libAMSKit.so + all system dependencies (libz, liblog, etc.).
 * Paths are relative from spike/newstack/stage10_amskit/ where the binary runs. */
#define LIB64 "../../../drm/rootfs-6.5.2/system/lib64"

/* ---- bionic data-symbol shims ------------------------------------------- */
/* Bionic exposes stdout/stderr/stdin as __sF[0..2].
 * We redirect them to our glibc FILE* pointers.
 * hybris routes all stdio function calls to glibc, so these FILE* handles
 * will be accepted correctly by glibc's fprintf/fputs/etc. */
static FILE *g_sF[3];  /* __sF shim: [0]=stdin, [1]=stdout, [2]=stderr */

/* ---- hook callback -------------------------------------------------------- */
static int shim_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) {
    (void)a; (void)b; (void)c; (void)d; return 0;
}
static void *shim_memchr_chk(const void *s, int c, size_t n, size_t bs) {
    (void)bs; return (void *)memchr(s, c, n);
}

static void *hook(const char *sym, const char *req) {
    if (!sym) return NULL;
    /* function shims */
    if (!strcmp(sym, "__register_atfork"))   return (void *)shim_atfork;
    if (!strcmp(sym, "__memchr_chk"))        return (void *)shim_memchr_chk;
    /* bionic data symbols */
    if (!strcmp(sym, "stdout"))  return (void *)stdout;
    if (!strcmp(sym, "stderr"))  return (void *)stderr;
    if (!strcmp(sym, "stdin"))   return (void *)stdin;
    if (!strcmp(sym, "__sF"))    return (void *)g_sF;
    return NULL;
}

/* ---- helpers -------------------------------------------------------------- */
static void *hybrid_load(const char *name) {
    void *h = embedded_dlopen(name, RTLD_NOW | RTLD_GLOBAL);
    if (!h) fprintf(stderr, "embedded_dlopen(%s): %s\n", name, embedded_dlerror());
    else printf("[+] loaded %s\n", name);
    return h;
}

static void *resolve_sym(const char *sym) {
    void *fn = embedded_dlsym(sym);
    if (fn) printf("  [sym] %-72s OK  %p\n", sym, fn);
    else    printf("  [sym] %-72s MISSING\n", sym);
    return fn;
}

int main(void) {
    /* Disable all buffering so output survives a crash. */
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    /* Catch SIGSEGV and print the fault address before re-raising. */
    struct sigaction sa = {0};
    sa.sa_flags = SA_SIGINFO;
    sa.sa_sigaction = sigsegv_handler;
    sigaction(SIGSEGV, &sa, NULL);

    printf("=== stage10 AMSKit probe (hybris) ===\n\n");

    /* Init glibc __sF shim */
    g_sF[0] = stdin; g_sF[1] = stdout; g_sF[2] = stderr;

    /* Init hybris */
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

    /* Load transitive dependencies before libAMSKit (same order as probe.c stage1) */
    hybrid_load("libz.so");
    hybrid_load("libm.so");
    hybrid_load("libc++_shared.so");
    void *hams = hybrid_load("libAMSKit.so");
    if (!hams) return 1;
    printf("\n");

    JNIEnv *env = fake_jni_env();
    jclass  cls = (jclass)(uintptr_t)42;

    /* ------------------------------------------------------------------ *
     * Test 1: IInterruptHandlerAdaptor_allocate(env, cls)                 *
     * ------------------------------------------------------------------  */
    const char *sym1 = "Java_com_apple_mediaservices_amskit_authentication_IInterruptHandlerAdaptor_allocate";
    typedef void (*fn_allocate_t)(JNIEnv *, jclass);
    fn_allocate_t alloc_handler = (fn_allocate_t)resolve_sym(sym1);

    if (alloc_handler) {
        printf("\n[test 1] IInterruptHandlerAdaptor_allocate(env, cls)...\n");
        alloc_handler(env, cls);
        printf("  → returned (no crash)\n");
    }

    /* ------------------------------------------------------------------ *
     * Test 2: BundleInfoWrapper_make (5 string args)                      *
     * ------------------------------------------------------------------  */
    const char *sym3 =
        "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
        "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
        "Ljava_lang_String_2Ljava_lang_String_2";
    typedef void (*fn_binfo_t)(JNIEnv *, jclass, jobject, jobject, jobject, jobject, jobject);
    fn_binfo_t make_binfo = (fn_binfo_t)resolve_sym(sym3);

    if (make_binfo) {
        printf("\n[test 2] BundleInfoWrapper_make...\n");
        fake_obj_t *s1 = fake_byteptr("com.apple.android.music");
        fake_obj_t *s2 = fake_byteptr("1586");
        fake_obj_t *s3 = fake_byteptr("6.5.2");
        fake_obj_t *s4 = fake_byteptr("23B74");
        fake_obj_t *s5 = fake_byteptr("Android 14");
        make_binfo(env, cls, s1, s2, s3, s4, s5);
        printf("  → returned (no crash)\n");
        free(s1); free(s2); free(s3); free(s4); free(s5);
    }

    /* ------------------------------------------------------------------ *
     * Test 3: SessionBuilder_allocate                                      *
     *                                                                      *
     * Session_allocate is a COPY constructor (needs a source session in    *
     * rdx).  SessionBuilder_allocate is the no-arg factory, same pattern  *
     * as IInterruptHandlerAdaptor_allocate.                                *
     * ------------------------------------------------------------------  */
    const char *sym2 = "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_allocate";
    fn_allocate_t alloc_builder = (fn_allocate_t)resolve_sym(sym2);
    if (alloc_builder) {
        printf("\n[test 3] SessionBuilder_allocate(env, cls)...\n");
        alloc_builder(env, cls);
        printf("  → returned (no crash)\n");
    }

    /* ------------------------------------------------------------------ *
     * Test 4: SessionBuilder_make (BytePointer variant with 9+binfo+2+Z+B)*
     * Passes real BytePointer args via fake JNI so the C++ constructor    *
     * can read the string fields.                                          *
     * ------------------------------------------------------------------  */
    const char *sym4 =
        "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_make__"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2ZB";
    typedef void (*fn_sbmake_t)(JNIEnv *, jclass,
        jobject, jobject, jobject, jobject, jobject,
        jobject, jobject, jobject, jobject,  /* 9 BytePointers */
        jobject,                             /* BundleInfoWrapper */
        jobject, jobject,                    /* 2 more BytePointers */
        jboolean, jbyte);
    fn_sbmake_t sb_make = (fn_sbmake_t)resolve_sym(sym4);
    if (sb_make) {
        printf("\n[test 4] SessionBuilder_make(env, sb_thiz, ...string args...)...\n");
        /* SessionBuilder_make IS an instance method: second arg must be a fake_obj_t,
         * not the integer jclass, so GetLongField(env, thiz, fid) returns 0 cleanly. */
        fake_obj_t *sb_thiz = fake_alloc_obj(0);  /* instance thiz — address=0 → not yet allocated */
        /* Use the same fake bundle info we'd pass via BundleInfoWrapper_make */
        fake_obj_t *binfo   = fake_alloc_obj(0);  /* placeholder BundleInfoWrapper */
        fake_obj_t *sp1 = fake_byteptr("com.apple.android.music");  /* bundleID */
        fake_obj_t *sp2 = fake_byteptr("6.5.2");                    /* version */
        fake_obj_t *sp3 = fake_byteptr("");                         /* build */
        fake_obj_t *sp4 = fake_byteptr("");                         /* platform */
        fake_obj_t *sp5 = fake_byteptr("");                         /* os */
        fake_obj_t *sp6 = fake_byteptr("");                         /* device */
        fake_obj_t *sp7 = fake_byteptr("");                         /* model */
        fake_obj_t *sp8 = fake_byteptr("");                         /* locale */
        fake_obj_t *sp9 = fake_byteptr("");                         /* country */
        fake_obj_t *sp10 = fake_byteptr("");                        /* extra1 */
        fake_obj_t *sp11 = fake_byteptr("");                        /* extra2 */
        sb_make(env, sb_thiz,
                sp1, sp2, sp3, sp4, sp5, sp6, sp7, sp8, sp9,
                binfo,
                sp10, sp11,
                JNI_FALSE, (jbyte)0);
        printf("  → returned (no crash)\n");
        free(sb_thiz); free(binfo);
        free(sp1); free(sp2); free(sp3); free(sp4); free(sp5);
        free(sp6); free(sp7); free(sp8); free(sp9); free(sp10); free(sp11);
    }

    printf("\n=== probe done ===\n");
    return 0;
}
