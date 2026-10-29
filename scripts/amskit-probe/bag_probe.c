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

/* The "Java side": log what native code asks of it; implement IAndroidHTTPProvider.submitRequest over libcurl. */
#include <ctype.h>
#include <curl/curl.h>
static void *g_lib; static void *g_env;
static void *SYM(const char *n);
#define JNIFN(name) "Java_com_apple_mediaservices_amskit_bindings_" name
struct cbuf { unsigned char *p; size_t n, cap; };
static size_t on_body(char *d, size_t sz, size_t nm, void *u) { struct cbuf *b = u; size_t n = sz * nm; if (b->n + n > b->cap) { b->cap = (b->n + n) * 2; b->p = realloc(b->p, b->cap); } memcpy(b->p + b->n, d, n); b->n += n; return n; }
static size_t on_header(char *d, size_t sz, size_t nm, void *u) { fj_obj *list = u; size_t n = sz * nm; char *c = memchr(d, ':', n); if (!c) return n;
    char *k = strndup(d, c - d), *v = strndup(c + 1, n - (c + 1 - d)); size_t vl = strlen(v); while (vl && (v[vl - 1] == '\r' || v[vl - 1] == '\n')) v[--vl] = 0; char *vv = v; while (*vv == ' ') vv++;
    fake_jni_list_add(list, fake_jni_new_pair(fake_jni_new_string(k), fake_jni_new_string(vv))); free(k); free(v); return n; }
static volatile int g_requests, g_completed;

/* Like the Kotlin provider: read everything off the request while submitRequest runs, then finish on another thread. */
#include <pthread.h>
struct job { fj_obj *cb; char *url; char verb[16]; struct curl_slist *hl; unsigned char *body; size_t body_n; int ms; int id; };

static void *run_job(void *arg)
{
    struct job *j = arg; usleep(150000);                       /* let the adapter finish its own bookkeeping after submitRequest returns */
    CURL *c = curl_easy_init(); struct cbuf rb = {0}; fj_obj *rh = fake_jni_new_list();
    curl_easy_setopt(c, CURLOPT_URL, j->url); curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 1L);
    if (j->ms > 0) curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, (long)j->ms); else curl_easy_setopt(c, CURLOPT_TIMEOUT, 30L);
    if (!strcmp(j->verb, "HEAD")) curl_easy_setopt(c, CURLOPT_NOBODY, 1L);
    else if (!strcmp(j->verb, "POST")) curl_easy_setopt(c, CURLOPT_POST, 1L);
    else if (strcmp(j->verb, "GET")) curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, j->verb);
    if (j->body_n) { curl_easy_setopt(c, CURLOPT_POSTFIELDS, j->body); curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)j->body_n); }
    if (j->hl) curl_easy_setopt(c, CURLOPT_HTTPHEADER, j->hl);
    curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, on_body); curl_easy_setopt(c, CURLOPT_WRITEDATA, &rb);
    curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, on_header); curl_easy_setopt(c, CURLOPT_HEADERDATA, rh);
    CURLcode rc = curl_easy_perform(c); long status = 0; curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
    printf("[http] request #%d done: curl rc=%d (%s) HTTP %ld, %zu body bytes, %lld response headers\n", j->id, rc, curl_easy_strerror(rc), status, rb.n, (long long)rh->count);
    curl_easy_cleanup(c);
    if (rc == CURLE_OK) {
        static const char *RC = "com/apple/mediaservices/amskit/network/IAndroidNetworkProvider$Response";
        fj_obj *resp = fake_jni_new_object(RC);
        fake_jni_set_field(resp, RC, "status", "I", status);
        fake_jni_set_field(resp, RC, "headers", "Ljava/lang/Iterable;", (int64_t)(intptr_t)rh);
        fake_jni_set_field(resp, RC, "body", "[B", (int64_t)(intptr_t)fake_jni_new_byte_array(rb.p, rb.n));
        static const char *HM = "com/apple/mediaservices/amskit/network/HTTPMetrics";      /* HTTPMetrics.<init> always builds its Internal object */
        fj_obj *metrics = fake_jni_new_object(HM);
        fake_jni_set_field(metrics, HM, "internal", "Lcom/apple/mediaservices/amskit/network/HTTPMetrics$Internal;", (int64_t)(intptr_t)fake_jni_new_object("com/apple/mediaservices/amskit/network/HTTPMetrics$Internal"));
        fake_jni_set_field(resp, RC, "metrics", "Lcom/apple/mediaservices/amskit/network/HTTPMetrics;", (int64_t)(intptr_t)metrics);
        ((void (*)(void *, fj_obj *, fj_obj *))SYM(JNIFN("IAndroidHTTPProvider_00024Callback_complete")))(g_env, j->cb, resp);
    } else {
        ((void (*)(void *, fj_obj *, fj_obj *))SYM(JNIFN("IAndroidHTTPProvider_00024Callback_completeExceptionally")))(g_env, j->cb, fake_jni_new_object("java/io/IOException"));
    }
    printf("[http] callback delivered; pending exception: %s\n", fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");
    free(rb.p); curl_slist_free_all(j->hl); free(j->url); free(j->body); free(j); g_completed++;
    return NULL;
}

static void handle_submit_request(fj_obj *req, fj_obj *cb)
{
    typedef fj_obj *(*getter_t)(void *, fj_obj *);
    getter_t url_f = SYM(JNIFN("IAndroidHTTPProvider_00024HTTPRequest_urlString")), meth_f = SYM(JNIFN("IAndroidHTTPProvider_00024HTTPRequest_method")),
             hdr_f = SYM(JNIFN("IAndroidHTTPProvider_00024HTTPRequest_headers")), body_f = SYM(JNIFN("IAndroidHTTPProvider_00024HTTPRequest_body"));
    int32_t (*to_f)(void *, fj_obj *) = SYM(JNIFN("IAndroidHTTPProvider_00024HTTPRequest_msTimeout"));
    fj_obj *url = url_f(g_env, req), *meth = meth_f(g_env, req), *hdrs = hdr_f(g_env, req), *body = body_f(g_env, req);
    struct job *j = calloc(1, sizeof *j); j->cb = cb; j->url = strdup(url ? url->str : ""); j->ms = to_f(g_env, req); j->id = ++g_requests;
    strcpy(j->verb, "GET"); if (meth && meth->str) { size_t i = 0; for (; meth->str[i] && i < 15; i++) j->verb[i] = (char)toupper((unsigned char)meth->str[i]); j->verb[i] = 0; }
    if (body && body->count) { j->body_n = (size_t)body->count; j->body = malloc(j->body_n); memcpy(j->body, body->data, j->body_n); }
    if (hdrs) for (int64_t i = 0; i < hdrs->count; i++) { fj_obj *pr = ((fj_obj **)hdrs->data)[i]; fj_obj **kv = pr ? (fj_obj **)pr->data : NULL;
        if (kv && pr->count >= 2 && kv[0] && kv[1]) { char line[2048]; snprintf(line, sizeof line, "%s: %s", kv[0]->str, kv[1]->str); j->hl = curl_slist_append(j->hl, line); } }
    char shown[200]; snprintf(shown, sizeof shown, "%.190s", j->url); char *q = strchr(shown, '?'); if (q) *q = 0;
    printf("[http] request #%d: %s %s  headers=%lld body=%zu bytes timeout=%d ms  (finishing on a worker thread)\n", j->id, j->verb, shown, hdrs ? (long long)hdrs->count : 0LL, j->body_n, j->ms);
    pthread_t t; pthread_create(&t, NULL, run_job, j); pthread_detach(t);
}

fj_value fake_jni_java_call(fj_obj *obj, fj_obj *method, const fj_value *args, int nargs)
{
    fj_value r; r.j = 0; (void)obj; (void)args; (void)nargs;
    if (!strcmp(method->name, "putMemberOffset")) return r;          /* JavaCPP's Java-side offset registry: nothing to do */
    if (!strcmp(method->name, "submitRequest") && nargs >= 2) { handle_submit_request((fj_obj *)args[0].l, (fj_obj *)args[1].l); return r; }
    fprintf(stderr, "[java] %s.%s%s called by native code\n", method->cls ? method->cls->name : "?", method->name, method->sig);
    return r;
}

static void *SYM(const char *n) { void *p = android_dlsym(g_lib, n); if (!p) { fprintf(stderr, "[probe] missing symbol %s\n", n); exit(2); } return p; }
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
    void *env = fake_jni_env(); g_env = env;
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
    /* 5. a bag service on that session, then ask for the frozen bag: AMSKit has to fetch it over HTTP */
    fj_obj *session = ((fj_obj *(*)(void *, fj_obj *, fj_obj *))SYM(JNIFN("ExpectedSession_takeValue")))(env, find(env, "com/apple/mediaservices/amskit/bindings/ExpectedSession"), expected);   /* static native */
    printf("[5] ExpectedSession.takeValue -> Session %p address %#llx\n", (void *)session, session ? (unsigned long long)session->address : 0ULL);
    fj_obj *bag = fake_jni_new_object("com/apple/mediaservices/amskit/bindings/BagService");
    ((void (*)(void *, fj_obj *, fj_obj *, fj_obj *, fj_obj *, fj_obj *))SYM(JNIFN("BagService_allocate__Lcom_apple_mediaservices_amskit_bindings_Session_2Ljava_lang_String_2Ljava_lang_String_2Lcom_apple_mediaservices_amskit_bindings_BundleInfoWrapper_2")))(
        env, bag, session, fake_jni_new_string("Music"), fake_jni_new_string("1"), bundle);
    printf("[5] BagService.allocate -> address %#llx   pending: %s\n", (unsigned long long)bag->address, fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");
    uint8_t (*loaded)(void *, fj_obj *) = (uint8_t (*)(void *, fj_obj *))SYM(JNIFN("BagService_getIsLoaded"));
    printf("[5] BagService.isLoaded before: %d\n", loaded(env, bag));
    fj_obj *task = ((fj_obj *(*)(void *, fj_obj *))SYM(JNIFN("BagService_getFrozenBag")))(env, bag);
    printf("[5] BagService.getFrozenBag -> task %p address %#llx   pending: %s\n", (void *)task, task ? (unsigned long long)task->address : 0ULL, fake_jni_pending_exception() ? fake_jni_pending_exception() : "none");
    for (int i = 0; i < 120 && !loaded(env, bag); i++) usleep(250000);    /* until the bag reports loaded (30 s cap) */
    for (int i = 0; i < 20 && g_completed < g_requests; i++) usleep(250000);   /* let in-flight requests finish */
    printf("[5] HTTP requests seen: %d, completed: %d   BagService.isLoaded after: %d\n", g_requests, g_completed, loaded(env, bag));
    printf("done\n");
    return 0;
}
