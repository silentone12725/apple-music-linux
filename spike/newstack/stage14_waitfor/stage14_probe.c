/*
 * stage14_probe.c — drive CredentialsAuthenticateTask execution
 *
 * Builds on stage13: perform() now returns without crash.
 *
 * Goals:
 *   1. Same setup as stage13 (session + anisette + credential builder + perform)
 *   2. After perform(), call TaskCounter_waitForAll() to let background tasks run
 *   3. Observe which IHTTPProvider vtable slots are called (tracing vtable)
 *   4. The trace reveals the HTTP method signatures needed for stage15 (real curl)
 *
 * Key insight: perform() creates the task on background threads.
 * TaskCounter_waitForAll() blocks until all queued tasks complete.
 *
 * Build: make  (from spike/newstack/stage14_waitfor/)
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
#include <pthread.h>
#include "../../../drm/embedded_loader.h"
#include "fake_jni.h"

/* ---- Recoverable SIGSEGV ------------------------------------------------- *
 * Thread-aware: only longjmp from the main thread. Background threads that    *
 * crash on our stub vtables just log and re-raise so they die cleanly.        */
static jmp_buf  g_recover;
static volatile int g_in_safe = 0;
static volatile void *g_fault_addr = NULL;
static pthread_t g_main_thread;

static void sigsegv_handler(int sig, siginfo_t *si, void *ctx) {
    (void)sig;
    g_fault_addr = si->si_addr;
    ucontext_t *uc = (ucontext_t *)ctx;
    uintptr_t rip = (uintptr_t)uc->uc_mcontext.gregs[REG_RIP];
    uintptr_t rax = (uintptr_t)uc->uc_mcontext.gregs[REG_RAX];
    uintptr_t rdi = (uintptr_t)uc->uc_mcontext.gregs[REG_RDI];
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
        "[SIGSEGV] fault=%p rip=%p rax=%p rdi=%p thread=%s\n",
        si->si_addr, (void*)rip, (void*)rax, (void*)rdi,
        pthread_equal(pthread_self(), g_main_thread) ? "main" : "bg");
    if (n > 0) { int r = write(2, buf, (size_t)n); (void)r; }
    /* Only longjmp from the main thread — background threads re-raise. */
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        g_in_safe = 0; siglongjmp(g_recover, 1);
    }
    signal(SIGSEGV, SIG_DFL); raise(SIGSEGV);
}

#define SAFE_CALL(label, expr) do {                              \
    g_in_safe = 1; g_fault_addr = NULL;                         \
    if (sigsetjmp(g_recover, 1) == 0) {                         \
        (expr);                                                  \
        g_in_safe = 0;                                           \
        printf("  %-40s → ok\n", (label));                       \
    } else {                                                     \
        printf("  %-40s → SIGSEGV at %p\n", (label), (void*)g_fault_addr); \
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

/* ---- Tracing vtable ------------------------------------------------------- *
 * All 32 slots print their index + args (rdi=this, rsi=arg1, rdx=arg2).       *
 * Returns 0.  Compiler needs a function that takes (void*,void*,void*) but    *
 * we use a generic form; the actual call ABI passes this in rdi.              */
static void *g_trace_this;  /* set before each traced call */
static int   g_trace_slot;

/* Tracing vtable: logs slot#, self pointer, and first two args.
 * When background tasks call IHTTPProvider, we'll see which slots.
 * The return value matters — returning NULL causes most methods to fail.
 * We return NULL here but log the calls so we know what to implement. */
#define TRACE_SLOT(N) \
    static void *trace_vt##N(void *self, void *a, void *b, void *c, void *d) { \
        fprintf(stderr, "  [VT slot=%2d] self=%p a=%p b=%p c=%p\n", N, self, a, b, c); \
        return NULL; \
    }

TRACE_SLOT(0)  TRACE_SLOT(1)  TRACE_SLOT(2)  TRACE_SLOT(3)
TRACE_SLOT(4)  TRACE_SLOT(5)  TRACE_SLOT(6)  TRACE_SLOT(7)
TRACE_SLOT(8)  TRACE_SLOT(9)  TRACE_SLOT(10) TRACE_SLOT(11)
TRACE_SLOT(12) TRACE_SLOT(13) TRACE_SLOT(14) TRACE_SLOT(15)
TRACE_SLOT(16) TRACE_SLOT(17) TRACE_SLOT(18) TRACE_SLOT(19)
TRACE_SLOT(20) TRACE_SLOT(21) TRACE_SLOT(22) TRACE_SLOT(23)

/* 32 slots to cover larger vtables */
TRACE_SLOT(24) TRACE_SLOT(25) TRACE_SLOT(26) TRACE_SLOT(27)
TRACE_SLOT(28) TRACE_SLOT(29) TRACE_SLOT(30) TRACE_SLOT(31)

static uintptr_t g_trace_vtable[32] = {
    (uintptr_t)trace_vt0,  (uintptr_t)trace_vt1,  (uintptr_t)trace_vt2,  (uintptr_t)trace_vt3,
    (uintptr_t)trace_vt4,  (uintptr_t)trace_vt5,  (uintptr_t)trace_vt6,  (uintptr_t)trace_vt7,
    (uintptr_t)trace_vt8,  (uintptr_t)trace_vt9,  (uintptr_t)trace_vt10, (uintptr_t)trace_vt11,
    (uintptr_t)trace_vt12, (uintptr_t)trace_vt13, (uintptr_t)trace_vt14, (uintptr_t)trace_vt15,
    (uintptr_t)trace_vt16, (uintptr_t)trace_vt17, (uintptr_t)trace_vt18, (uintptr_t)trace_vt19,
    (uintptr_t)trace_vt20, (uintptr_t)trace_vt21, (uintptr_t)trace_vt22, (uintptr_t)trace_vt23,
    (uintptr_t)trace_vt24, (uintptr_t)trace_vt25, (uintptr_t)trace_vt26, (uintptr_t)trace_vt27,
    (uintptr_t)trace_vt28, (uintptr_t)trace_vt29, (uintptr_t)trace_vt30, (uintptr_t)trace_vt31,
};

/* A minimal C++ object whose vtable we can override. */
typedef struct { uintptr_t vtable_ptr; uintptr_t data[7]; } stub_cxx_t;

static void *stub_vfn(void) { return NULL; }
#define STUB_VT_SIZE 32
static uintptr_t g_stub_vtable[STUB_VT_SIZE];

static void init_stub_vtable(void) {
    for (int i = 0; i < STUB_VT_SIZE; i++)
        g_stub_vtable[i] = (uintptr_t)stub_vfn;
}

static fake_obj_t *make_stub_provider(stub_cxx_t *cxx) {
    cxx->vtable_ptr = (uintptr_t)g_stub_vtable;
    fake_obj_t *o = fake_alloc_obj(0);
    o->address = (jlong)(uintptr_t)cxx;
    return o;
}

static stub_cxx_t s_http_cxx, s_mescal_cxx, s_account_cxx, s_fairplay_cxx;

/* ---- Helpers ------------------------------------------------------------- */
static void *hybrid_load(const char *name) {
    void *h = embedded_dlopen(name, RTLD_NOW | RTLD_GLOBAL);
    if (!h) fprintf(stderr, "embedded_dlopen(%s): %s\n", name, embedded_dlerror());
    else printf("[+] loaded %s\n", name);
    return h;
}

static void *resolve_sym(const char *sym) {
    void *fn = embedded_dlsym(sym);
    if (fn) printf("  [sym] %-60.60s OK  %p\n", sym, fn);
    else    printf("  [sym] %-60.60s MISSING\n", sym);
    return fn;
}

static void dump_obj(const char *label, fake_obj_t *o) {
    printf("  [obj] %s: class_id=0x%lx  address=0x%lx\n",
           label, o?(unsigned long)o->class_id:0, o?(unsigned long)o->address:0);
}

/* ---- Fake JavaVM ---------------------------------------------------------- *
 * perform() calls a helper (ELF 0x55c5b9) that reads a global JavaVM* from   *
 * 0x90b650, then calls jvm->AttachCurrentThread() to get a JNIEnv*.          *
 * JNI_OnLoad normally stores the VM there; since we skip it we patch the      *
 * global ourselves after loading the library.                                  */
static jint fake_jvm_AttachCurrentThread(void *vm, JNIEnv **penv, void *args) {
    (void)vm; (void)args;
    if (penv) *penv = fake_jni_env();
    return JNI_OK;
}
static jint fake_jvm_GetEnv(void *vm, void **penv, jint ver) {
    (void)vm; (void)ver;
    if (penv) *penv = fake_jni_env();
    return JNI_OK;
}
/* JavaVM vtable: slots [4]=0x20=AttachCurrentThread, [6]=0x30=GetEnv */
static void *s_fake_jvm_vtable[8];
static void *s_fake_jvm[2]; /* {vtable_ptr, unused} */

static void install_fake_jvm(uintptr_t lib_base) {
    s_fake_jvm_vtable[0] = NULL;
    s_fake_jvm_vtable[1] = NULL;
    s_fake_jvm_vtable[2] = NULL;
    s_fake_jvm_vtable[3] = NULL; /* DestroyJavaVM */
    s_fake_jvm_vtable[4] = (void *)fake_jvm_AttachCurrentThread;
    s_fake_jvm_vtable[5] = NULL; /* DetachCurrentThread */
    s_fake_jvm_vtable[6] = (void *)fake_jvm_GetEnv;
    s_fake_jvm_vtable[7] = NULL;
    s_fake_jvm[0] = s_fake_jvm_vtable;
    *(void **)(lib_base + 0x90b650UL) = s_fake_jvm;
    printf("[jvm] patched 0x90b650 = &fake_jvm (%p)\n", (void *)s_fake_jvm);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);

    struct sigaction sa = {0};
    sa.sa_flags = SA_SIGINFO | SA_NODEFER;
    sa.sa_sigaction = sigsegv_handler;
    sigaction(SIGSEGV, &sa, NULL);

    g_main_thread = pthread_self();
    printf("=== stage14 waitfor probe ===\n\n");

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

    /* Patch javacpp field-ID globals (see stage12 for explanation). */
    {
        const char *anchor_sym =
            "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
            "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
            "Ljava_lang_String_2Ljava_lang_String_2";
        uintptr_t anchor = (uintptr_t)embedded_dlsym(anchor_sym);
        if (!anchor) { fprintf(stderr, "FATAL: anchor symbol not found\n"); return 1; }
        uintptr_t lib_base = anchor - 0x4f73b0UL;
        printf("[javacpp-patch] lib_base=0x%lx\n", lib_base);
        *(jfieldID *)(lib_base + 0x90b5a8) = FID_ADDRESS;
        *(jfieldID *)(lib_base + 0x90b5b0) = FID_POSITION;
        *(jfieldID *)(lib_base + 0x90b5b8) = FID_LIMIT;
        *(jfieldID *)(lib_base + 0x90b5c0) = FID_CAPACITY;
        *(jfieldID *)(lib_base + 0x90b5c8) = FID_OTHER;
        *(jfieldID *)(lib_base + 0x90b5d0) = FID_ADDRESS;
        printf("[javacpp-patch] globals written OK\n");
        /* Also install fake JavaVM so perform()'s AttachCurrentThread works. */
        install_fake_jvm(lib_base);
    }
    printf("\n");

    JNIEnv *env = fake_jni_env();

    /* ------------------------------------------------------------------ *
     * 1. BundleInfoWrapper_make                                           *
     * ------------------------------------------------------------------ */
    printf("[1] BundleInfoWrapper_make\n");
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
     * 2. SessionBuilder_allocate + set* + make                           *
     * ------------------------------------------------------------------ */
    printf("[2] SessionBuilder → Session\n");
    typedef void (*fn_sballoc_t)(JNIEnv *, jobject);
    fn_sballoc_t alloc_sb = (fn_sballoc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_allocate");
    fake_obj_t *sb_obj = NULL;
    if (alloc_sb) {
        sb_obj = fake_alloc_obj(0);
        alloc_sb(env, sb_obj);
        dump_obj("SessionBuilder", sb_obj);
    }

    fake_obj_t *http_prov    = make_stub_provider(&s_http_cxx);
    fake_obj_t *mescal_prov  = make_stub_provider(&s_mescal_cxx);
    fake_obj_t *account_prov = make_stub_provider(&s_account_cxx);
    fake_obj_t *fp_prov      = make_stub_provider(&s_fairplay_cxx);

    /* Override HTTP and Mescal stubs with tracing vtables so we see calls. */
    s_http_cxx.vtable_ptr   = (uintptr_t)g_trace_vtable;
    s_mescal_cxx.vtable_ptr = (uintptr_t)g_trace_vtable;

    typedef void (*fn_set_t)(JNIEnv *, jobject, jobject);
    fn_set_t set_http    = (fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setHTTPProvider");
    fn_set_t set_mescal  = (fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setMescalProvider");
    fn_set_t set_account = (fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setAccountProvider");
    fn_set_t set_fp      = (fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setFairPlayCoreProvider");

    if (sb_obj && sb_obj->address) {
        if (set_http)    set_http(env, sb_obj, http_prov);
        if (set_mescal)  set_mescal(env, sb_obj, mescal_prov);
        if (set_account) set_account(env, sb_obj, account_prov);
        if (set_fp)      set_fp(env, sb_obj, fp_prov);
    }

    /* make() */
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
        jobject, jobject, jobject,
        jboolean, jbyte);
    fn_sbmake_t sb_make = (fn_sbmake_t)resolve_sym(s_sbmake);

    fake_obj_t *session_obj = NULL;
    if (sb_make && sb_obj && sb_obj->address && binfo_obj) {
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
        jobject ret = sb_make(env, sb_obj,
                sp1, sp2, sp3, sp4, sp5, sp6, sp7, sp8, sp9,
                binfo_obj, sp10, sp11,
                JNI_FALSE, (jbyte)0);
        session_obj = (fake_obj_t *)ret;
        dump_obj("Session", session_obj);
        free(sp1); free(sp2); free(sp3); free(sp4); free(sp5);
        free(sp6); free(sp7); free(sp8); free(sp9); free(sp10); free(sp11);
    }
    printf("\n");
    if (!session_obj || !session_obj->address) {
        printf("  FATAL: no Session\n"); return 1;
    }

    /* ------------------------------------------------------------------ *
     * 3. IAnisetteProvider_allocate + tracing vtable + setAnisetteProvider
     * ------------------------------------------------------------------ */
    printf("[3] IAnisetteProvider + setAnisetteProvider\n");
    typedef void (*fn_ap_alloc_t)(JNIEnv *, jclass);
    fn_ap_alloc_t alloc_ap = (fn_ap_alloc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_IAnisetteProvider_allocate");
    fake_obj_t *anisette_obj = NULL;
    if (alloc_ap) {
        anisette_obj = fake_alloc_obj(0);
        alloc_ap(env, anisette_obj);
        dump_obj("IAnisetteProvider", anisette_obj);
        /* Override vtable with tracing vtable. */
        if (anisette_obj->address) {
            uintptr_t *cxx = (uintptr_t*)(uintptr_t)anisette_obj->address;
            printf("  [cxx] original vtable = %p\n", (void*)cxx[0]);
            cxx[0] = (uintptr_t)g_trace_vtable;
            printf("  [cxx] vtable overridden → tracing\n");
        }
    }

    typedef void (*fn_set_ap_t)(JNIEnv *, jobject, jobject);
    fn_set_ap_t set_ap = (fn_set_ap_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_Session_setAnisetteProvider");
    if (set_ap && session_obj && anisette_obj)
        SAFE_CALL("setAnisetteProvider", set_ap(env, session_obj, anisette_obj));
    printf("\n");

    /* ------------------------------------------------------------------ *
     * 4. createEmptyIdMSBagService(Session)                               *
     * IdMSBagService_allocate takes (BytePointer url1, BytePointer url2). *
     * The factory method on AppleMediaServicesCore is the correct path.   *
     * ------------------------------------------------------------------ */
    printf("[4] createEmptyIdMSBagService(Session)\n");
    const char *s_idms_factory =
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_"
        "createEmptyIdMSBagService__Lcom_apple_mediaservices_amskit_bindings_Session_2";
    typedef jobject (*fn_idms_factory_t)(JNIEnv *, jclass, jobject);
    fn_idms_factory_t create_idms = (fn_idms_factory_t)resolve_sym(s_idms_factory);
    fake_obj_t *idms_obj = NULL;
    if (create_idms && session_obj) {
        fake_obj_t *out = fake_alloc_obj(0);
        SAFE_CALL("createEmptyIdMSBagService",
            idms_obj = (fake_obj_t *)create_idms(env, (jclass)(uintptr_t)42, session_obj));
        if (!idms_obj) idms_obj = out;
        dump_obj("IdMSBagService (empty)", idms_obj);
    }
    if (!idms_obj || !idms_obj->address) {
        /* Fallback: try createIdMSBagService (may fetch from Apple servers) */
        printf("  [fallback] createIdMSBagService(Session)\n");
        const char *s_idms2 =
            "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_"
            "createIdMSBagService__Lcom_apple_mediaservices_amskit_bindings_Session_2";
        typedef jobject (*fn_idms2_t)(JNIEnv *, jclass, jobject);
        fn_idms2_t create_idms2 = (fn_idms2_t)resolve_sym(s_idms2);
        if (create_idms2 && session_obj) {
            fake_obj_t *out2 = fake_alloc_obj(0);
            SAFE_CALL("createIdMSBagService",
                idms_obj = (fake_obj_t *)create_idms2(env, (jclass)(uintptr_t)42, session_obj));
            if (!idms_obj) idms_obj = out2;
            dump_obj("IdMSBagService", idms_obj);
        }
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * 5. BagService_allocate(Session, url, region, BundleInfoWrapper)    *
     * ------------------------------------------------------------------ */
    printf("[5] BagService_allocate\n");
    const char *s_bag =
        "Java_com_apple_mediaservices_amskit_bindings_BagService_allocate__"
        "Lcom_apple_mediaservices_amskit_bindings_Session_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2";
    typedef void (*fn_bag_t)(JNIEnv *, jclass,
        jobject, jobject, jobject, jobject);
    fn_bag_t alloc_bag = (fn_bag_t)resolve_sym(s_bag);
    fake_obj_t *bag_obj = NULL;
    if (alloc_bag && session_obj && binfo_obj) {
        bag_obj = fake_alloc_obj(0);
        fake_obj_t *url1 = fake_byteptr("https://bag.itunes.apple.com/bag.xml?ix=5");
        fake_obj_t *url2 = fake_byteptr("143441-29");
        fprintf(stderr, "--- BagService_allocate vtable calls: ---\n");
        SAFE_CALL("BagService_allocate",
            alloc_bag(env, bag_obj, session_obj, url1, url2, binfo_obj));
        dump_obj("BagService", bag_obj);
        free(url1); free(url2);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * 6. CredentialsAuthenticateTaskOptionsBuilder_allocate              *
     * ------------------------------------------------------------------ */
    printf("[6] CredentialsAuthenticateTaskOptionsBuilder_allocate\n");
    const char *s_cred_alloc =
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_allocate__"
        "Lcom_apple_mediaservices_amskit_bindings_IdMSBagService_2"
        "Lcom_apple_mediaservices_amskit_bindings_BagService_2"
        "Lorg_bytedeco_javacpp_BytePointer_2";
    typedef void (*fn_cred_alloc_t)(JNIEnv *, jclass, jobject, jobject, jobject);
    fn_cred_alloc_t alloc_cred = (fn_cred_alloc_t)resolve_sym(s_cred_alloc);
    fake_obj_t *cred_builder = NULL;
    if (alloc_cred && idms_obj && idms_obj->address && bag_obj && bag_obj->address) {
        cred_builder = fake_alloc_obj(0);
        fake_obj_t *email_bp = fake_byteptr("test@icloud.com");
        SAFE_CALL("CredentialsAuthenticateTaskOptionsBuilder_allocate",
            alloc_cred(env, cred_builder, idms_obj, bag_obj, email_bp));
        dump_obj("CredentialsAuthenticateTaskOptionsBuilder", cred_builder);
        free(email_bp);
    } else {
        printf("  SKIP: missing idms_obj=%p bag_obj=%p\n",
               (void*)idms_obj, (void*)bag_obj);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * 7. withCredential + build                                           *
     * ------------------------------------------------------------------ */
    printf("[7] withCredential + build\n");
    typedef void (*fn_wc_t)(JNIEnv *, jobject, jobject);
    fn_wc_t with_cred = (fn_wc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_withCredential");
    typedef jobject (*fn_build_t)(JNIEnv *, jobject);
    fn_build_t build_opts = (fn_build_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_build");

    fake_obj_t *cred_opts = NULL;
    if (cred_builder && cred_builder->address && with_cred && build_opts) {
        fake_obj_t *pass_bp = fake_byteptr("testpassword");
        SAFE_CALL("withCredential",
            with_cred(env, cred_builder, pass_bp));
        fake_obj_t *opts_ret = fake_alloc_obj(0);
        cred_opts = fake_alloc_obj(0);
        SAFE_CALL("build", cred_opts = (fake_obj_t *)build_opts(env, cred_builder));
        dump_obj("CredentialsAuthenticateTaskOptions", cred_opts);
        free(pass_bp);
    } else {
        printf("  SKIP: no builder\n");
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * 8. perform(Session, CredentialsAuthenticateTaskOptions)             *
     * ------------------------------------------------------------------ */
    /* Dump Session C++ struct first 64 bytes to understand layout */
    if (session_obj && session_obj->address) {
        uintptr_t *s = (uintptr_t*)(uintptr_t)session_obj->address;
        printf("[session C++ @ 0x%lx]:\n", (unsigned long)session_obj->address);
        for (int i = 0; i < 8; i++)
            printf("  [%+3d] 0x%016lx\n", i*8, (unsigned long)s[i]);
    }
    printf("\n");

    printf("[8] perform(Session, CredentialsAuthenticateTaskOptions)\n");
    const char *s_perform =
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_perform__"
        "Lcom_apple_mediaservices_amskit_bindings_Session_2"
        "Lcom_apple_mediaservices_amskit_bindings_CredentialsAuthenticateTaskOptions_2";
    typedef jobject (*fn_perform_t)(JNIEnv *, jclass, jobject, jobject);
    fn_perform_t do_perform = (fn_perform_t)resolve_sym(s_perform);

    /* Even if cred_opts construction failed (address=0), try perform() with a
     * stub opts object so we can see which provider vtable slots get called.
     * SAFE_CALL catches any SIGSEGV from missing implementations.             */
    fake_obj_t *opts_to_use = (cred_opts && cred_opts->address) ? cred_opts : fake_alloc_obj(1);
    if (!opts_to_use->address) opts_to_use->address = 0x1;  /* non-zero stub */
    if (do_perform && session_obj) {
        fprintf(stderr, "--- perform() vtable calls: ---\n");
        g_jni_trace = 1;   /* trace GetLongField calls inside perform() */
        fake_obj_t *result_obj = fake_alloc_obj(0);
        SAFE_CALL("perform(Session, CredentialsAuthenticateTaskOptions)",
            result_obj = (fake_obj_t *)do_perform(env, (jclass)(uintptr_t)42, session_obj, opts_to_use));
        dump_obj("perform result", result_obj);
    } else {
        printf("  SKIP: missing session=%p\n", (void*)session_obj);
    }
    printf("\n");

    /* ------------------------------------------------------------------ *
     * 9. Sleep to let background task threads run.                       *
     *    Background tasks call IHTTPProvider vtable methods; the trace   *
     *    vtable logs slot#/self/args so we know what to implement.       *
     *    Background thread SIGSEGVs are logged and re-raised cleanly.    *
     *                                                                    *
     *    NOTE: TaskCounter_waitForAll() deadlocks here because perform() *
     *    increments the counter but the stub HTTP provider returns NULL   *
     *    so the task never completes → counter never reaches 0.          *
     *    sleep(5) lets background threads run and log vtable calls.      *
     * ------------------------------------------------------------------ */
    printf("[9] sleeping 5 s to observe background task vtable calls...\n");
    fprintf(stderr, "--- background task vtable calls will appear below: ---\n");
    sleep(5);
    fprintf(stderr, "--- sleep done ---\n");
    printf("  sleep done\n");
    printf("\n");

    printf("=== stage14 done ===\n");
    return 0;
}
