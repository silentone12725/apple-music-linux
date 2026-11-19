/*
 * stage19_probe.c — identify error 3169 by calling category->name() and message()
 *
 * Also dumps 2048 bytes of log context to see full request headers.
 *
 * Key addition: after perform() returns with error, call the error_category
 * virtual functions name() and message(val) to get human-readable strings.
 *
 * error_category vtable layout (std::error_category, libc++):
 *   slot 0: virtual ~error_category()
 *   slot 1: virtual ~error_category() (deleting)
 *   slot 2: virtual const char* name() const noexcept
 *   slot 3: virtual error_condition default_error_condition(int) const noexcept
 *   slot 4: virtual bool equivalent(int, const error_condition&) const noexcept
 *   slot 5: virtual bool equivalent(const error_code&, int) const noexcept
 *   slot 6: virtual std::string message(int) const
 *
 * For AMSCore custom categories, slot 2 (name) is safe to call.
 * slot 6 (message) returns std::string — risky but we can try.
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
#include <execinfo.h>
#include <sys/mman.h>
#include "../../../drm/embedded_loader.h"
#include "fake_jni.h"

static void disable_io_vtable_check(void) {
    Dl_info info = {0};
    if (!dladdr((void*)fwrite, &info) || !info.dli_fbase) return;
    uint8_t *fn = (uint8_t*)((uintptr_t)info.dli_fbase + 0xa09f0);
    uintptr_t page = (uintptr_t)fn & ~(uintptr_t)(4095);
    if (mprotect((void*)page, 8192, PROT_READ|PROT_WRITE|PROT_EXEC) != 0) return;
    fn[0] = 0xC3;
    mprotect((void*)page, 8192, PROT_READ|PROT_EXEC);
    fprintf(stderr, "[patch] _IO_vtable_check disabled\n");
}

static sigjmp_buf g_recover;
static volatile int g_in_safe = 0;
static volatile void *g_fault_addr = NULL;
static pthread_t g_main_thread;

void abort(void) {
    static const char msg[] = "[abort() suppressed]\n";
    int r = write(2, msg, sizeof(msg)-1); (void)r;
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        g_in_safe = 0; siglongjmp(g_recover, 1);
    }
    pthread_exit(NULL);
}

static void sigsegv_handler(int sig, siginfo_t *si, void *ctx) {
    (void)sig;
    g_fault_addr = si->si_addr;
    ucontext_t *uc = (ucontext_t *)ctx;
    uintptr_t rip = (uintptr_t)uc->uc_mcontext.gregs[REG_RIP];
    char buf[256];
    int n = snprintf(buf, sizeof(buf),
        "[SIGSEGV] fault=%p rip=%p thread=%s\n",
        si->si_addr, (void*)rip,
        pthread_equal(pthread_self(), g_main_thread) ? "main" : "bg");
    if (n > 0) { int r = write(2, buf, n); (void)r; }
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        g_in_safe = 0; siglongjmp(g_recover, 1);
    }
    if (!pthread_equal(pthread_self(), g_main_thread)) {
        void *frames[16];
        int nf = backtrace(frames, 16);
        backtrace_symbols_fd(frames, nf, 2);
        pthread_exit(NULL);
    }
    signal(SIGSEGV, SIG_DFL); raise(SIGSEGV);
}

static void sigabrt_handler(int sig, siginfo_t *si, void *ctx) {
    (void)sig; (void)si; (void)ctx;
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        g_in_safe = 0; siglongjmp(g_recover, 2);
    }
    if (!pthread_equal(pthread_self(), g_main_thread)) {
        static const char m[] = "[SIGABRT bg-thread suppressed]\n";
        int r = write(2, m, sizeof(m)-1); (void)r;
        pthread_exit(NULL);
    }
    signal(SIGABRT, SIG_DFL); raise(SIGABRT);
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

#define SAFE_EVAL(result, type, label, expr) do {               \
    g_in_safe = 1; g_fault_addr = NULL;                         \
    if (sigsetjmp(g_recover, 1) == 0) {                         \
        result = (type)(expr);                                   \
        g_in_safe = 0;                                           \
    } else {                                                     \
        fprintf(stderr, "  SIGSEGV calling %s\n", label);       \
    }                                                            \
} while(0)

#define LIB64 "../../../drm/rootfs-6.5.2/system/lib64"

static FILE *g_sF[3];
static int shim_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d)
                      { (void)a;(void)b;(void)c;(void)d; return 0; }
static void *shim_memchr_chk(const void *s, int c, size_t n, size_t bs)
                             { (void)bs; return (void *)memchr(s, c, n); }
static int shim_pthread_create(pthread_t *tid, const void *attr, void *(*fn)(void*), void *arg) {
    static const char msg[] = "[bg-thread] pthread_create called\n";
    int r = write(2, msg, sizeof(msg)-1); (void)r;
    return pthread_create(tid, (const pthread_attr_t*)attr, fn, arg);
}
static int    shim_fflush(void *f)                              { (void)f; return 0; }
static int    shim_fputc(int c, void *f)                        { (void)f; return c; }
static int    shim_fputs(const char *s, void *f)                { (void)s;(void)f; return 1; }
static size_t shim_fwrite(const void *p, size_t sz, size_t n, void *f)
                         { (void)p;(void)sz;(void)f; return n; }
static int    shim_fprintf(void *f, const char *fmt, ...)       { (void)f;(void)fmt; return 0; }
static int    shim_vfprintf(void *f, const char *fmt, va_list a){ (void)f;(void)fmt;(void)a; return 0; }

static void *hook(const char *sym, const char *req) {
    if (!sym) return NULL; (void)req;
    if (!strcmp(sym, "__register_atfork"))   return (void *)shim_atfork;
    if (!strcmp(sym, "__memchr_chk"))        return (void *)shim_memchr_chk;
    if (!strcmp(sym, "stdout"))  return (void *)stdout;
    if (!strcmp(sym, "stderr"))  return (void *)stderr;
    if (!strcmp(sym, "stdin"))   return (void *)stdin;
    if (!strcmp(sym, "__sF"))    return (void *)g_sF;
    if (!strcmp(sym, "pthread_create"))   return (void *)shim_pthread_create;
    if (!strcmp(sym, "fflush"))           return (void *)shim_fflush;
    if (!strcmp(sym, "fflush_unlocked"))  return (void *)shim_fflush;
    if (!strcmp(sym, "fputc"))            return (void *)shim_fputc;
    if (!strcmp(sym, "fputc_unlocked"))   return (void *)shim_fputc;
    if (!strcmp(sym, "fputs"))            return (void *)shim_fputs;
    if (!strcmp(sym, "fputs_unlocked"))   return (void *)shim_fputs;
    if (!strcmp(sym, "fwrite"))           return (void *)shim_fwrite;
    if (!strcmp(sym, "fwrite_unlocked"))  return (void *)shim_fwrite;
    if (!strcmp(sym, "fprintf"))          return (void *)shim_fprintf;
    if (!strcmp(sym, "vfprintf"))         return (void *)shim_vfprintf;
    return NULL;
}

/* ---- HTTP fake response ---------------------------------------------------- */

static const char s_fake_gs_lookup_body[] =
    "{\"il\":{"
    "\"gsService\":{\"u\":\"https://gsa.apple.com/grandslam/GsService2\"},"
    "\"idms\":{\"u\":\"https://idmsa.apple.com\"},"
    "\"appleAuth\":{\"u\":\"https://idmsa.apple.com/appleauth\"},"
    "\"bag\":{\"u\":\"https://bag.itunes.apple.com/bag.xml?ix=5\"}"
    "},"
    "\"cd\":14}";

static int s_http_call_count = 0;

/* Dump N bytes in hex */
static void dump_hex(const char *label, const void *ptr, int nbytes) {
    if (!ptr || (uintptr_t)ptr < 0x10000) return;
    char buf[300];
    int n = snprintf(buf, sizeof(buf), "    %s @ %p (%d bytes):\n", label, ptr, nbytes);
    if (n > 0) { int r = write(2, buf, n); (void)r; }
    const uint8_t *p = (const uint8_t *)ptr;
    for (int i = 0; i < nbytes; i += 16) {
        n = snprintf(buf, sizeof(buf), "      +%04x:", i);
        if (n > 0) { int r = write(2, buf, n); (void)r; }
        for (int j = 0; j < 16 && (i+j) < nbytes; j++) {
            n = snprintf(buf, sizeof(buf), " %02x", p[i+j]);
            if (n > 0) { int r = write(2, buf, n); (void)r; }
        }
        int r2 = write(2, "\n", 1); (void)r2;
    }
}

static void provide_fake_http_response(void **ctx) {
    s_http_call_count++;
    char buf[512];
    int n = snprintf(buf, sizeof(buf),
        "[stage19] slot3 call#%d: ctx=%p\n", s_http_call_count, (void*)ctx);
    if (n > 0) { int r = write(2, buf, n); (void)r; }

    /* Dump log context (ctx[1]) — 2048 bytes for full request headers JSON */
    if (ctx[1] && (uintptr_t)ctx[1] > 0x10000) {
        dump_hex("LogContext(ctx[1])", ctx[1], 2048);
        /* Find and print the full JSON */
        const uint8_t *lc = (const uint8_t *)ctx[1];
        for (int start = 0; start < 2048 - 4; start++) {
            /* Look for the second occurrence of '"headers":' which follows the full JSON */
            if (lc[start]=='"' && lc[start+1]=='h' && lc[start+2]=='e' && lc[start+3]=='a' &&
                lc[start+4]=='d' && lc[start+5]=='e' && lc[start+6]=='r' && lc[start+7]=='s' &&
                lc[start+8]=='"' && lc[start+9]==':') {
                /* find the opening brace before this */
                for (int back = start; back >= 0; back--) {
                    if (lc[back] == '{') {
                        n = snprintf(buf, sizeof(buf), "[stage19] full request JSON: %.800s\n",
                                     (const char*)(lc+back));
                        if (n > 0) { int r = write(2, buf, n); (void)r; }
                        break;
                    }
                }
                break;
            }
        }
    }

    /* Allocate HTTPResponse */
    uint8_t *resp = calloc(1, 0x300);
    if (!resp) return;
    *((uint16_t *)(resp + 0xc8)) = 200;

    /* DataBuffer = std::vector<uint8_t> = {begin*, end*, cap_end*} */
    size_t body_len = sizeof(s_fake_gs_lookup_body) - 1;
    uint8_t *body = malloc(body_len + 1);
    if (body) {
        memcpy(body, s_fake_gs_lookup_body, body_len + 1);
        *((void **)(resp + 0x0f8)) = body;
        *((void **)(resp + 0x100)) = body + body_len;
        *((void **)(resp + 0x108)) = body + body_len;
    }

    n = snprintf(buf, sizeof(buf),
        "[stage19] fake resp @ %p (200, %zu bytes, begin=%p end=%p)\n",
        (void*)resp, body_len, (void*)body, (void*)(body+body_len));
    if (n > 0) { int r = write(2, buf, n); (void)r; }

    ctx[0] = resp;
    ctx[1] = NULL;
}

#define TRACE_SLOT(N) \
    static void *trace_vt##N(void *self, void *a, void *b, void *c, void *d) { \
        char _tb[160]; \
        int _tn = snprintf(_tb, sizeof(_tb), \
            "  [VT slot=%2d] self=%p a=%p b=%p c=%p d=%p\n", N, self, a, b, c, d); \
        if (_tn > 0) { int _r = write(2, _tb, (size_t)_tn); (void)_r; } \
        if (N == 3 && self) provide_fake_http_response((void **)self); \
        return self; \
    }

TRACE_SLOT(0)  TRACE_SLOT(1)  TRACE_SLOT(2)  TRACE_SLOT(3)
TRACE_SLOT(4)  TRACE_SLOT(5)  TRACE_SLOT(6)  TRACE_SLOT(7)
TRACE_SLOT(8)  TRACE_SLOT(9)  TRACE_SLOT(10) TRACE_SLOT(11)
TRACE_SLOT(12) TRACE_SLOT(13) TRACE_SLOT(14) TRACE_SLOT(15)
TRACE_SLOT(16) TRACE_SLOT(17) TRACE_SLOT(18) TRACE_SLOT(19)
TRACE_SLOT(20) TRACE_SLOT(21) TRACE_SLOT(22) TRACE_SLOT(23)
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

typedef struct { uintptr_t vtable_ptr; uintptr_t data[7]; } stub_cxx_t;
static void *stub_vfn(void *self, ...) { return self; }
static uintptr_t g_stub_vtable[32];
static void init_stub_vtable(void) {
    for (int i = 0; i < 32; i++) g_stub_vtable[i] = (uintptr_t)stub_vfn;
}
static fake_obj_t *make_stub_provider(stub_cxx_t *cxx) {
    cxx->vtable_ptr = (uintptr_t)g_stub_vtable;
    fake_obj_t *o = fake_alloc_obj(0);
    o->address = (jlong)(uintptr_t)cxx;
    return o;
}

static stub_cxx_t s_http_cxx, s_mescal_cxx, s_account_cxx, s_fairplay_cxx;

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

static jint fake_jvm_AttachCurrentThread(void *vm, JNIEnv **penv, void *args)
                                        { (void)vm;(void)args; if (penv) *penv=fake_jni_env(); return 0; }
static jint fake_jvm_GetEnv(void *vm, void **penv, jint ver)
                           { (void)vm;(void)ver; if (penv) *penv=fake_jni_env(); return 0; }
static void *s_fake_jvm_vtable[8];
static void *s_fake_jvm[2];
static void install_fake_jvm(uintptr_t lib_base) {
    s_fake_jvm_vtable[4] = (void *)fake_jvm_AttachCurrentThread;
    s_fake_jvm_vtable[6] = (void *)fake_jvm_GetEnv;
    s_fake_jvm[0] = s_fake_jvm_vtable;
    *(void **)(lib_base + 0x90b650UL) = s_fake_jvm;
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    disable_io_vtable_check();

    struct sigaction sa = {0};
    sa.sa_flags = SA_SIGINFO | SA_NODEFER;
    sa.sa_sigaction = sigsegv_handler;
    sigaction(SIGSEGV, &sa, NULL);
    sa.sa_sigaction = sigabrt_handler;
    sigaction(SIGABRT, &sa, NULL);
    g_main_thread = pthread_self();

    printf("=== stage19 errname probe ===\n\n");
    g_sF[0] = stdin; g_sF[1] = stdout; g_sF[2] = stderr;
    init_stub_vtable();

    setenv("HYBRIS_LINKER_DIR",      "../../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", LIB64, 1);
    setenv("HYBRIS_ANDROID_LIB64",   LIB64, 1);
    setenv("ANDROID_ROOT",  "/tmp/newstack-root", 0);
    setenv("ANDROID_DATA",  "/tmp/newstack-data", 0);
    mkdir("/tmp/newstack-data", 0700);

    if (embedded_loader_init() != 0) { fprintf(stderr, "hybris init failed\n"); return 1; }
    embedded_set_hook_callback(hook);

    hybrid_load("libz.so");
    hybrid_load("libm.so");
    hybrid_load("libc++_shared.so");
    void *hams = hybrid_load("libAMSKit.so");
    if (!hams) return 1;

    uintptr_t lib_base = 0;
    {
        const char *anchor_sym =
            "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
            "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
            "Ljava_lang_String_2Ljava_lang_String_2";
        uintptr_t anchor = (uintptr_t)embedded_dlsym(anchor_sym);
        if (!anchor) { fprintf(stderr, "FATAL: anchor not found\n"); return 1; }
        lib_base = anchor - 0x4f73b0UL;
        printf("[javacpp-patch] lib_base=0x%lx\n", lib_base);
        *(jfieldID *)(lib_base + 0x90b5a8) = FID_ADDRESS;
        *(jfieldID *)(lib_base + 0x90b5b0) = FID_POSITION;
        *(jfieldID *)(lib_base + 0x90b5b8) = FID_LIMIT;
        *(jfieldID *)(lib_base + 0x90b5c0) = FID_CAPACITY;
        *(jfieldID *)(lib_base + 0x90b5c8) = FID_OTHER;
        *(jfieldID *)(lib_base + 0x90b5d0) = FID_ADDRESS;
        install_fake_jvm(lib_base);
    }

    JNIEnv *env = fake_jni_env();
    printf("\n");

    /* [1] BundleInfoWrapper */
    const char *s_bimake =
        "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
        "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
        "Ljava_lang_String_2Ljava_lang_String_2";
    typedef jobject (*fn_binfo_t)(JNIEnv *, jclass, jobject, jobject, jobject, jobject, jobject);
    fn_binfo_t make_binfo = (fn_binfo_t)resolve_sym(s_bimake);
    fake_obj_t *binfo_obj = NULL;
    if (make_binfo) {
        fake_obj_t *bs1=fake_byteptr("com.apple.android.music"),*bs2=fake_byteptr("1586"),
                   *bs3=fake_byteptr("6.5.2"),*bs4=fake_byteptr("23B74"),*bs5=fake_byteptr("Android 14");
        binfo_obj = (fake_obj_t *)make_binfo(env,(jclass)42,bs1,bs2,bs3,bs4,bs5);
        dump_obj("BundleInfoWrapper", binfo_obj);
        free(bs1);free(bs2);free(bs3);free(bs4);free(bs5);
    }

    /* [2] Session */
    typedef void (*fn_sballoc_t)(JNIEnv *, jobject);
    fn_sballoc_t alloc_sb = (fn_sballoc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_allocate");
    fake_obj_t *sb_obj = NULL;
    if (alloc_sb) { sb_obj=fake_alloc_obj(0); alloc_sb(env,sb_obj); dump_obj("SessionBuilder",sb_obj); }

    fake_obj_t *http_prov=make_stub_provider(&s_http_cxx),
               *mescal_prov=make_stub_provider(&s_mescal_cxx),
               *account_prov=make_stub_provider(&s_account_cxx),
               *fp_prov=make_stub_provider(&s_fairplay_cxx);
    s_http_cxx.vtable_ptr=(uintptr_t)g_trace_vtable;

    typedef void (*fn_set_t)(JNIEnv *, jobject, jobject);
    fn_set_t set_http=(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setHTTPProvider");
    fn_set_t set_mescal=(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setMescalProvider");
    fn_set_t set_account=(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setAccountProvider");
    fn_set_t set_fp=(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setFairPlayCoreProvider");
    if (sb_obj&&sb_obj->address) {
        if(set_http)   SAFE_CALL("setHTTPProvider",   set_http(env,sb_obj,http_prov));
        if(set_mescal) SAFE_CALL("setMescalProvider", set_mescal(env,sb_obj,mescal_prov));
        if(set_account)SAFE_CALL("setAccountProvider",set_account(env,sb_obj,account_prov));
        if(set_fp)     SAFE_CALL("setFPProvider",     set_fp(env,sb_obj,fp_prov));
    }

    const char *s_sbmake =
        "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_make__"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2"
        "Lorg_bytedeco_javacpp_BytePointer_2Lorg_bytedeco_javacpp_BytePointer_2ZB";
    typedef jobject (*fn_sbmake_t)(JNIEnv *,jobject,jobject,jobject,jobject,jobject,jobject,
                                   jobject,jobject,jobject,jobject,jobject,jobject,jobject,
                                   jboolean,jbyte);
    fn_sbmake_t sb_make=(fn_sbmake_t)resolve_sym(s_sbmake);
    fake_obj_t *session_obj = NULL;
    if (sb_make&&sb_obj&&sb_obj->address&&binfo_obj) {
        fake_obj_t *sp1=fake_byteptr("com.apple.android.music"),*sp2=fake_byteptr("6.5.2"),
                   *sp3=fake_byteptr("1586"),*sp4=fake_byteptr("android"),*sp5=fake_byteptr("14.0"),
                   *sp6=fake_byteptr("x86_64"),*sp7=fake_byteptr("linux"),*sp8=fake_byteptr("en_US"),
                   *sp9=fake_byteptr("143441"),*sp10=fake_byteptr(""),*sp11=fake_byteptr("");
        session_obj=(fake_obj_t*)sb_make(env,sb_obj,sp1,sp2,sp3,sp4,sp5,sp6,sp7,sp8,sp9,
                                         binfo_obj,sp10,sp11,JNI_FALSE,(jbyte)0);
        dump_obj("Session",session_obj);
        free(sp1);free(sp2);free(sp3);free(sp4);free(sp5);
        free(sp6);free(sp7);free(sp8);free(sp9);free(sp10);free(sp11);
    }
    if (!session_obj||!session_obj->address) { printf("FATAL: no Session\n"); return 1; }

    /* [3] Anisette */
    typedef void (*fn_ap_alloc_t)(JNIEnv *, jclass);
    fn_ap_alloc_t alloc_ap=(fn_ap_alloc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_IAnisetteProvider_allocate");
    fake_obj_t *anisette_obj = NULL;
    if (alloc_ap) {
        anisette_obj=fake_alloc_obj(0); alloc_ap(env,anisette_obj);
        if (anisette_obj->address) {
            uintptr_t *cxx=(uintptr_t*)(uintptr_t)anisette_obj->address;
            cxx[0]=(uintptr_t)g_trace_vtable;
        }
    }
    typedef void (*fn_set_ap_t)(JNIEnv *, jobject, jobject);
    fn_set_ap_t set_ap=(fn_set_ap_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_Session_setAnisetteProvider");
    if (set_ap&&session_obj&&anisette_obj)
        SAFE_CALL("setAnisetteProvider", set_ap(env,session_obj,anisette_obj));

    /* [4] createIdMSBagService */
    const char *s_idms2 =
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_"
        "createIdMSBagService__Lcom_apple_mediaservices_amskit_bindings_Session_2";
    typedef jobject (*fn_idms2_t)(JNIEnv *, jclass, jobject);
    fn_idms2_t create_idms2=(fn_idms2_t)resolve_sym(s_idms2);
    fake_obj_t *idms_obj=NULL;
    if (create_idms2&&session_obj)
        SAFE_CALL("createIdMSBagService",
            idms_obj=(fake_obj_t*)create_idms2(env,(jclass)42,session_obj));
    dump_obj("IdMSBagService",idms_obj);

    /* [5] BagService */
    const char *s_bag =
        "Java_com_apple_mediaservices_amskit_bindings_BagService_allocate__"
        "Lcom_apple_mediaservices_amskit_bindings_Session_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lorg_bytedeco_javacpp_BytePointer_2"
        "Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2";
    typedef void (*fn_bag_t)(JNIEnv *, jclass, jobject, jobject, jobject, jobject);
    fn_bag_t alloc_bag=(fn_bag_t)resolve_sym(s_bag);
    fake_obj_t *bag_obj=NULL;
    if (alloc_bag&&session_obj&&binfo_obj) {
        bag_obj=fake_alloc_obj(0);
        fake_obj_t *url1=fake_byteptr("https://bag.itunes.apple.com/bag.xml?ix=5");
        fake_obj_t *url2=fake_byteptr("143441-29");
        SAFE_CALL("BagService_allocate",alloc_bag(env,bag_obj,session_obj,url1,url2,binfo_obj));
        dump_obj("BagService",bag_obj);
        free(url1);free(url2);
    }

    /* [6-7] CredentialsAuthenticateTaskOptions */
    const char *s_cred_alloc =
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_allocate__"
        "Lcom_apple_mediaservices_amskit_bindings_IdMSBagService_2"
        "Lcom_apple_mediaservices_amskit_bindings_BagService_2"
        "Lorg_bytedeco_javacpp_BytePointer_2";
    typedef void (*fn_cred_alloc_t)(JNIEnv *, jclass, jobject, jobject, jobject);
    fn_cred_alloc_t alloc_cred=(fn_cred_alloc_t)resolve_sym(s_cred_alloc);
    fake_obj_t *cred_builder=NULL;
    if (alloc_cred&&idms_obj&&bag_obj) {
        cred_builder=fake_alloc_obj(0);
        fake_obj_t *email_bp=fake_byteptr("test@icloud.com");
        SAFE_CALL("CredBuilder_allocate",alloc_cred(env,cred_builder,idms_obj,bag_obj,email_bp));
        free(email_bp);
    }
    typedef void (*fn_wc_t)(JNIEnv *, jobject, jobject);
    fn_wc_t with_cred=(fn_wc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_withCredential");
    typedef jobject (*fn_build_t)(JNIEnv *, jobject);
    fn_build_t build_opts=(fn_build_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_build");
    fake_obj_t *cred_opts=NULL;
    if (cred_builder&&cred_builder->address&&with_cred&&build_opts) {
        fake_obj_t *pass_bp=fake_byteptr("testpassword");
        SAFE_CALL("withCredential",with_cred(env,cred_builder,pass_bp));
        SAFE_CALL("build",cred_opts=(fake_obj_t*)build_opts(env,cred_builder));
        if (cred_opts&&cred_opts->address) {
            uint8_t *cxx=(uint8_t*)(uintptr_t)cred_opts->address;
            if (!cxx[0xa0]) cxx[0xa0]=1;
        }
        free(pass_bp);
    }

    /* [8] perform */
    printf("\n[8] perform(Session, CredentialsAuthenticateTaskOptions)\n");
    const char *s_perform =
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_perform__"
        "Lcom_apple_mediaservices_amskit_bindings_Session_2"
        "Lcom_apple_mediaservices_amskit_bindings_CredentialsAuthenticateTaskOptions_2";
    typedef jobject (*fn_perform_t)(JNIEnv *, jclass, jobject, jobject);
    fn_perform_t do_perform=(fn_perform_t)resolve_sym(s_perform);

    fake_obj_t *opts_to_use=(cred_opts&&cred_opts->address)?cred_opts:fake_alloc_obj(1);
    if (!opts_to_use->address) opts_to_use->address=1;

    if (do_perform&&session_obj) {
        fprintf(stderr,"--- perform() calls: ---\n");
        g_jni_trace=1;
        fake_obj_t *result_obj=fake_alloc_obj(0);
        SAFE_CALL("perform",result_obj=(fake_obj_t*)do_perform(env,(jclass)42,session_obj,opts_to_use));
        dump_obj("result",result_obj);
        fprintf(stderr,"--- perform() done ---\n");

        if (result_obj&&result_obj->address) {
            uint8_t *r=(uint8_t*)(uintptr_t)result_obj->address;
            void **rptrs=(void **)r;

            /* result+0x8 = inner error struct */
            if (rptrs[1]&&(uintptr_t)rptrs[1]>0x10000) {
                uint8_t *ep=(uint8_t*)rptrs[1];
                uint32_t errval=*(uint32_t*)(ep+0x28);
                void *errcat_obj=*(void **)(ep+0x00); /* category object */
                fprintf(stderr,"[error] value=0x%x (%u)  cat_obj=%p\n",
                        errval, errval, errcat_obj);

                if (errval) {
                    /* Call category->name() = vtable[2](cat_obj) */
                    if (errcat_obj && (uintptr_t)errcat_obj > 0x10000) {
                        uintptr_t *cat_vtable = *(uintptr_t **)errcat_obj;
                        fprintf(stderr,"[error] cat_vtable=%p\n",(void*)cat_vtable);
                        if (cat_vtable && (uintptr_t)cat_vtable > 0x10000) {
                            /* name() is at vtable[2] */
                            typedef const char *(*fn_name_t)(void *);
                            fn_name_t fn_name = (fn_name_t)(cat_vtable[2]);
                            const char *cat_name = NULL;
                            if (fn_name && (uintptr_t)fn_name > 0x10000) {
                                SAFE_EVAL(cat_name, const char *, "category.name()",
                                          fn_name(errcat_obj));
                                if (cat_name)
                                    fprintf(stderr,"[error] category name: '%s'\n", cat_name);
                            }

                            /* message(val) is at vtable[6] — returns std::string
                             * std::string in libc++ is 24 bytes; allocate on stack.
                             * Calling convention: first arg is hidden this ptr for std::string return. */
                            typedef void (*fn_msg_t)(void * /*ret*/, void * /*self*/, int);
                            fn_msg_t fn_msg = (fn_msg_t)(cat_vtable[6]);
                            if (fn_msg && (uintptr_t)fn_msg > 0x10000) {
                                /* Allocate 32 bytes for returned std::string */
                                uint8_t str_ret[32] = {0};
                                g_in_safe = 1; g_fault_addr = NULL;
                                if (sigsetjmp(g_recover, 1) == 0) {
                                    fn_msg(str_ret, errcat_obj, (int)errval);
                                    g_in_safe = 0;
                                    /* libc++ std::string: if short (<23 chars), bytes 0..22 = chars,
                                     * byte 23 = remaining capacity (or size field).
                                     * On little-endian, the last byte of the 24-byte string is
                                     * either the flags byte (0 = short, with size in bits [2:7]),
                                     * or the size stored differently.
                                     * Safest: just print bytes 0..22 as text. */
                                    char msgbuf[64] = {0};
                                    int msglen = 0;
                                    for (int i = 0; i < 23 && str_ret[i]; i++) {
                                        msgbuf[msglen++] = (str_ret[i]>=0x20&&str_ret[i]<0x7f)
                                                           ? (char)str_ret[i] : '?';
                                    }
                                    /* Also check if it's a heap-allocated string
                                     * (bit 0 of byte 23 set → long mode; bytes 0..7 = heap ptr) */
                                    void *heap_str = *(void **)str_ret;
                                    if (str_ret[23] & 1) {
                                        /* Long mode: bytes 8..15 = size, bytes 0..7 = data ptr */
                                        size_t slen = *(size_t *)(str_ret + 8);
                                        const char *sptr = *(const char **)str_ret;
                                        if (sptr&&(uintptr_t)sptr>0x1000&&slen<256) {
                                            fprintf(stderr,"[error] message(%u) = '%.*s' (long)\n",
                                                    errval,(int)slen,sptr);
                                        } else {
                                            dump_hex("[error] message str_ret", str_ret, 32);
                                        }
                                    } else {
                                        fprintf(stderr,"[error] message(%u) = '%s' (short)\n",
                                                errval, msgbuf);
                                        (void)heap_str;
                                    }
                                } else {
                                    fprintf(stderr,"[error] message() faulted at %p\n",
                                            (void*)g_fault_addr);
                                    g_in_safe = 0;
                                }
                            }
                        }
                    }
                }

                /* Dump the error struct */
                dump_hex("error struct (result+0x8)", ep, 128);
            }
        }
    }

    printf("\n[9] sleeping 3s...\n");
    sleep(3);
    printf("=== stage19 done ===\n");
    return 0;
}
