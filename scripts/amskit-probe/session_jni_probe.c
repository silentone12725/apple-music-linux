/* Builds an AMSKit session the way the Android app does, through the JNI exports and fake_jni.c (no JVM). */
#define _GNU_SOURCE
#include "fake_jni.h"
#include <dlfcn.h>
#include <signal.h>
#include <stdarg.h>
#include <sys/stat.h>
#include <ucontext.h>
#include <unistd.h>

extern void *android_dlopen(const char *, int);
extern void *android_dlsym(void *, const char *);
extern char *android_dlerror(void);
typedef void *(*hook_cb)(const char *, const char *);
extern void hybris_set_hook_callback(hook_cb);

static void *g_in, *g_out, *g_err;
static int p_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) { (void)a; (void)b; (void)c; (void)d; return 0; }
static void *p_memchr_chk(const void *s, int c, size_t n, size_t b) { (void)b; return (void *)memchr(s, c, n); }
static int p_logw(int p, const char *t, const char *m) { fprintf(stderr, "[alog %d] %s: %s\n", p, t ? t : "", m ? m : ""); return 0; }
static int p_logv(int p, const char *t, const char *f, va_list ap) { char b[1024]; vsnprintf(b, sizeof b, f, ap); return p_logw(p, t, b); }
static int p_logp(int p, const char *t, const char *f, ...) { va_list ap; va_start(ap, f); int r = p_logv(p, t, f, ap); va_end(ap); return r; }
static void *hook(const char *s, const char *r)
{
    (void)r;
    if (!strcmp(s, "stdin")) return &g_in; if (!strcmp(s, "stdout")) return &g_out; if (!strcmp(s, "stderr")) return &g_err;
    if (!strcmp(s, "__register_atfork")) return (void *)p_atfork;
    if (!strcmp(s, "__memchr_chk")) return (void *)p_memchr_chk;
    if (!strcmp(s, "__android_log_write")) return (void *)p_logw;
    if (!strcmp(s, "__android_log_vprint")) return (void *)p_logv;
    if (!strcmp(s, "__android_log_print")) return (void *)p_logp;
    return NULL;
}
static void crash(int sig, siginfo_t *si, void *ctx)
{
    ucontext_t *uc = ctx; unsigned long rip = uc->uc_mcontext.gregs[REG_RIP];
    fprintf(stderr, "\n[probe] CRASH sig=%d addr=%p rip=%#lx\n", sig, si->si_addr, rip);
    FILE *m = fopen("/proc/self/maps", "r"); char line[512];
    while (m && fgets(line, sizeof line, m)) { unsigned long a, b; if (sscanf(line, "%lx-%lx", &a, &b) == 2 && rip >= a && rip < b) { fprintf(stderr, "[probe] rip in: %s", line); break; } }
    _exit(139);
}

/* The "Java side": log what native code asks of it. */
fj_value fake_jni_java_call(fj_obj *obj, fj_obj *method, const fj_value *args, int nargs)
{
    fj_value r; r.j = 0; (void)obj; (void)args; (void)nargs;
    if (!strcmp(method->name, "putMemberOffset")) return r;          /* JavaCPP's Java-side offset registry: nothing to do */
    fprintf(stderr, "[java] %s.%s%s called by native code\n", method->cls ? method->cls->name : "?", method->name, method->sig);
    return r;
}

static void *g_lib;
static void *SYM(const char *n) { void *p = android_dlsym(g_lib, n); if (!p) { fprintf(stderr, "[probe] missing symbol %s\n", n); exit(2); } return p; }
#define JNIFN(name) "Java_com_apple_mediaservices_amskit_bindings_" name
typedef fj_obj *(*J_FindClass)(void *, const char *);

int main(void)
{
    struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_sigaction = crash; sa.sa_flags = SA_SIGINFO;
    sigaction(SIGSEGV, &sa, NULL); sigaction(SIGABRT, &sa, NULL); sigaction(SIGILL, &sa, NULL);
    const char *res = "/home/daksh/Git Projects/apple-music-linux/electron/dist/resources";
    const char *lib = "/home/daksh/Git Projects/apple-music-linux/drm/rootfs-6.5.2/system/lib64";
    char p[512]; snprintf(p, sizeof p, "%s/hybris-linker", res);
    setenv("HYBRIS_LINKER_DIR", p, 1); setenv("HYBRIS_LD_LIBRARY_PATH", lib, 1); setenv("HYBRIS_ANDROID_LIB64", lib, 1);
    setenv("ANDROID_ROOT", "/tmp/amskit-probe", 0); setenv("ANDROID_DATA", "/tmp/amskit-probe/data", 0);
    mkdir("/tmp/amskit-probe", 0700); mkdir("/tmp/amskit-probe/data", 0700);
    setvbuf(stdout, NULL, _IONBF, 0);
    g_in = stdin; g_out = stdout; g_err = stderr; hybris_set_hook_callback(hook);
    fake_jni_trace = getenv("JNI_TRACE") != NULL;

    g_lib = android_dlopen("libAMSKit.so", 2);
    if (!g_lib) { printf("[probe] load failed: %s\n", android_dlerror()); return 1; }
    void *env = fake_jni_env();
    J_FindClass find = (J_FindClass)(*(void ***)env)[6];

    long (*onload)(void *, void *) = (long (*)(void *, void *))SYM("JNI_OnLoad");
    long v = onload(fake_jni_vm(), NULL); printf("[1] JNI_OnLoad -> %#lx   pending exception: %s\n", v, fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");

    /* 2. BundleInfoWrapper.make(identifier, name, version, accountClientIdentifier, bundleIdForMetrics, bagProfileName, bagProfileVersion) */
    fj_obj *(*bundle_make)(void *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *) =
        SYM(JNIFN("BundleInfoWrapper_make__Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"));
    fj_obj *bw_cls = find(env, "com/apple/mediaservices/amskit/bindings/BundleInfoWrapper");
    fj_obj *bundle = bundle_make(env, bw_cls, fake_jni_new_string("musicAndroid"), fake_jni_new_string("Music"), fake_jni_new_string("6.5.2"),
                                 fake_jni_new_string("musicAndroid"), fake_jni_new_string("musicAndroid"), fake_jni_new_string("Music"), fake_jni_new_string("1"));
    printf("[2] BundleInfoWrapper.make -> object %p address %#llx   pending: %s\n", (void *)bundle, bundle ? (unsigned long long)bundle->address : 0ULL, fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");

    /* 3. SessionBuilder + our HTTP provider adapter */
    fj_obj *builder = fake_jni_new_object("com/apple/mediaservices/amskit/bindings/SessionBuilder");
    ((void (*)(void *, fj_obj *))SYM(JNIFN("SessionBuilder_allocate")))(env, builder);
    printf("[3] SessionBuilder.allocate -> address %#llx\n", (unsigned long long)builder->address);
    fj_obj *http = fake_jni_new_object("com/apple/mediaservices/amskit/bindings/IAndroidHTTPProvider");
    ((void (*)(void *, fj_obj *))SYM(JNIFN("IAndroidHTTPProvider_allocate")))(env, http);
    printf("[3] IAndroidHTTPProvider.allocate -> adapter address %#llx\n", (unsigned long long)http->address);
    ((void (*)(void *, fj_obj *))SYM(JNIFN("IAndroidHTTPProvider_init")))(env, http);          /* the Kotlin constructor runs allocate() then init() */
    printf("[3] IAndroidHTTPProvider.init done   pending: %s\n", fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");
    ((void (*)(void *, fj_obj *, fj_obj *))SYM(JNIFN("SessionBuilder_setHTTPProvider")))(env, builder, http);
    printf("[3] SessionBuilder.setHTTPProvider done   pending: %s\n", fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");

    /* 4. SessionBuilder.make(deviceId, buildVersion, hardwareType, platformName, machineName, platformVersion, manufacturer, model,
     *                        stableIdentifier, bundle, structuredDataDbPath, dataDbPath, metricsDisabled, buildType) */
    typedef fj_obj *(*make_t)(void *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, uint8_t, int8_t);
    make_t sb_make = (make_t)SYM(JNIFN("SessionBuilder_make__Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2Ljava_lang_String_2Ljava_lang_String_2ZB"));
    fj_obj *expected = sb_make(env, builder,
        fake_jni_new_string("0123456789abcdef"), fake_jni_new_string("7663313"), fake_jni_new_string("x86_64"), fake_jni_new_string("Android"),
        fake_jni_new_string("Samsung S9"), fake_jni_new_string("10"), fake_jni_new_string("samsung"), fake_jni_new_string("SM-G960F"),
        fake_jni_new_string("dc28071e981c439e"), bundle,
        fake_jni_new_string("/tmp/amskit-probe/data/structured_data.db"), fake_jni_new_string("/tmp/amskit-probe/data/data.db"), 1, 0);
    printf("[4] SessionBuilder.make -> ExpectedSession %p address %#llx   pending: %s\n", (void *)expected, expected ? (unsigned long long)expected->address : 0ULL, fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");
    if (expected) {
        uint8_t (*has)(void *, fj_obj *) = (uint8_t (*)(void *, fj_obj *))SYM(JNIFN("ExpectedSession_hasValue"));
        printf("[4] ExpectedSession.hasValue -> %d\n", has(env, expected));
    }
    printf("done\n");
    return 0;
}
