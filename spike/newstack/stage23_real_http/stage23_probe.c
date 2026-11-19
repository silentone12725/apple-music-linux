/*
 * stage23_real_http — real curl-based HTTP provider for GrandSlam
 *
 * Problem in stage22: the stub HTTP provider forges responses but the forged
 * response has no Content-Type header, so AMSCore's plist decoder never runs
 * ("Body was not of AnyMap type").  ADAM_REAL_HTTP=1 crashes immediately because
 * the library's built-in provider calls Android network APIs that don't exist
 * on Linux.
 *
 * Fix: implement IAndroidHTTPProvider properly.
 *   - Slot 3 fires with the HTTPRequest.
 *   - We use IAndroidHTTPProvider::HTTPRequest accessors (urlString, method,
 *     headers, body) to extract the request fields cleanly.
 *   - We make a real libcurl call to Apple's servers.
 *   - We inject the real response (real Content-Type, real body) back via the
 *     existing buf_data inline-response path so perform() gets a valid AnyMap.
 *
 * Phone trace (Frida on com.apple.android.music.dbg 6.5.2) shows the full flow:
 *   1.  GET  gsd.apple.com/grandslam/GsService2/lookup/v2        → 200
 *   2.  POST ?/grandslam/ws/device/signout                        → 200
 *   3.  POST gsd.apple.com/grandslam/MidService/startMachineProvisioning → 200
 *   4.  POST gsd.apple.com/grandslam/MidService/finishMachineProvisioning → 200
 *   5.  POST ?/auth/federate                                       → 200
 *   6-9.POST ?/grandslam/GsService2  (SRP A B C D)                → 200
 *   10. GET  ?/auth                                                → 200
 *   11. PUT  ?/auth/verify/phone                                   → 200 (SMS sent)
 *   12. POST ?/auth/verify/phone/securitycode                      → 200 (OTP confirmed)
 *   13. POST ?/grandslam/GsService2/postdata                      → 200
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
#include <fcntl.h>
#include <curl/curl.h>
#include "../../../drm/embedded_loader.h"
#include "fake_jni.h"
#include "lookup_v2_body.h"   /* fallback lookup response (stage22 body) */

/* Credentials live here (persistent across sessions, never committed) */
#define CRED_DIR "../state"

#define LIB64 "../../../drm/rootfs-6.5.2/system/lib64"

/* ---- signal handling (unchanged from stage22) ----------------------------- */

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

/* Per-thread recovery: each thread registers its own sigjmp_buf */
static sigjmp_buf g_recover;         /* main thread */
static volatile int g_in_safe = 0;
static volatile void *g_fault_addr = NULL;
static pthread_t g_main_thread;

/* bg-thread recovery: a simple spinlock-free per-thread slot */
#define MAX_BG_THREADS 16
static struct {
    pthread_t tid;
    volatile int in_safe;
    sigjmp_buf jmp;
} g_bg_recover[MAX_BG_THREADS];
static pthread_mutex_t g_bg_lock = PTHREAD_MUTEX_INITIALIZER;

static struct { pthread_t tid; volatile int in_safe; sigjmp_buf *jmp; } *
find_bg_slot(int create) {
    static __thread int cached_idx = -1;
    if (cached_idx >= 0) return (void*)&g_bg_recover[cached_idx];
    pthread_mutex_lock(&g_bg_lock);
    pthread_t self = pthread_self();
    for (int i = 0; i < MAX_BG_THREADS; i++) {
        if (g_bg_recover[i].tid == self) {
            cached_idx = i; pthread_mutex_unlock(&g_bg_lock);
            return (void*)&g_bg_recover[i];
        }
    }
    if (create) {
        for (int i = 0; i < MAX_BG_THREADS; i++) {
            if (!g_bg_recover[i].tid) {
                g_bg_recover[i].tid = self;
                g_bg_recover[i].in_safe = 0;
                cached_idx = i; pthread_mutex_unlock(&g_bg_lock);
                return (void*)&g_bg_recover[i];
            }
        }
    }
    pthread_mutex_unlock(&g_bg_lock);
    return NULL;
}

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
        "[SIGSEGV] fault=%p rip=%p thread=%s\n", si->si_addr, (void*)rip,
        pthread_equal(pthread_self(), g_main_thread) ? "main" : "bg");
    if (n > 0) { int r = write(2, buf, n); (void)r; }
    /* Dump registers for diagnosis */
    if (pthread_equal(pthread_self(), g_main_thread)) {
        char rb[512];
        uintptr_t rsp  = (uintptr_t)uc->uc_mcontext.gregs[REG_RSP];
        uintptr_t rax  = (uintptr_t)uc->uc_mcontext.gregs[REG_RAX];
        uintptr_t rcx  = (uintptr_t)uc->uc_mcontext.gregs[REG_RCX];
        uintptr_t rdx  = (uintptr_t)uc->uc_mcontext.gregs[REG_RDX];
        uintptr_t rdi  = (uintptr_t)uc->uc_mcontext.gregs[REG_RDI];
        uintptr_t rsi  = (uintptr_t)uc->uc_mcontext.gregs[REG_RSI];
        int rn = snprintf(rb, sizeof(rb),
            "  rax=%016lx rcx=%016lx rdx=%016lx\n"
            "  rdi=%016lx rsi=%016lx rsp=%016lx\n",
            rax, rcx, rdx, rdi, rsi, rsp);
        if (rn > 0) { int r = write(2, rb, rn); (void)r; }
        /* Print top of stack (return addresses) */
        char sb[256]; int sn = 0;
        sn += snprintf(sb+sn, sizeof(sb)-sn, "  stack[0..3]:");
        for (int i = 0; i < 4 && rsp + i*8 + 7 < rsp + 0x100; i++) {
            uintptr_t v = *(uintptr_t *)(rsp + i*8);
            sn += snprintf(sb+sn, sizeof(sb)-sn, " %016lx", v);
        }
        sn += snprintf(sb+sn, sizeof(sb)-sn, "\n");
        if (sn > 0) { int r = write(2, sb, sn); (void)r; }
        void *frames[32]; int nf = backtrace(frames, 32); backtrace_symbols_fd(frames, nf, 2);
    }
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        g_in_safe = 0; siglongjmp(g_recover, 1);
    }
    /* bg-thread recovery: if we have a registered recovery point, use it */
    if (!pthread_equal(pthread_self(), g_main_thread)) {
        void *slot_raw = find_bg_slot(0);
        if (slot_raw) {
            typeof(g_bg_recover[0]) *slot = slot_raw;
            if (slot->in_safe) {
                slot->in_safe = 0;
                siglongjmp(slot->jmp, 1);
            }
        }
        /* No recovery point — just exit thread rather than killing process */
        pthread_exit(NULL);
    }
    signal(SIGSEGV, SIG_DFL); raise(SIGSEGV);
}

static void sigabrt_handler(int sig, siginfo_t *si, void *ctx) {
    (void)sig; (void)si;
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        ucontext_t *uc = (ucontext_t *)ctx;
        uintptr_t rip = (uintptr_t)uc->uc_mcontext.gregs[REG_RIP];
        char b[128]; int bn = snprintf(b, sizeof(b), "[SIGABRT] rip=%p\n", (void*)rip);
        if (bn > 0) { int r = write(2, b, bn); (void)r; }
        void *frames[32]; int nf = backtrace(frames, 32); backtrace_symbols_fd(frames, nf, 2);
        g_in_safe = 0; siglongjmp(g_recover, 2);
    }
    if (!pthread_equal(pthread_self(), g_main_thread)) {
        static const char m[] = "[SIGABRT bg-thread suppressed]\n";
        int r = write(2, m, sizeof(m)-1); (void)r;
        pthread_exit(NULL);
    }
    signal(SIGABRT, SIG_DFL); raise(SIGABRT);
}

void *realloc(void *old_ptr, size_t new_size) {
    extern void *__libc_realloc(void *, size_t);
    if (!old_ptr) return malloc(new_size);
    uintptr_t p = (uintptr_t)old_ptr;
    if (p < 0x10000 || (p & 0xf) != 0) {
        char msg[128]; int n = snprintf(msg, sizeof(msg),
            "[realloc-bad] ptr=%p size=%zu — fresh malloc\n", old_ptr, new_size);
        if (n > 0) { int w = write(2, msg, (size_t)n); (void)w; }
        return malloc(new_size);
    }
    return __libc_realloc(old_ptr, new_size);
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

/* ---- misc shims (unchanged) ---------------------------------------------- */

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

/* ---- credential loader ---------------------------------------------------- */

static char *read_cred(const char *name) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", CRED_DIR, name);
    FILE *f = fopen(path, "rb");
    if (!f) { fprintf(stderr, "[cred] MISSING %s\n", name); return NULL; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    if (sz < 0) { fclose(f); return NULL; }
    char *buf = (char *)malloc((size_t)sz + 1);
    size_t got = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[got] = 0;
    while (got && (buf[got-1] == '\n' || buf[got-1] == '\r')) buf[--got] = 0;
    fprintf(stderr, "[cred] loaded %s (%zu bytes)\n", name, got);
    return buf;
}

/* ---- dump helpers --------------------------------------------------------- */

static void dump_hex(const char *label, const void *ptr, int nbytes) {
    if (!ptr || (uintptr_t)ptr < 0x10000) return;
    fprintf(stderr, "    %s @ %p (%d bytes):\n", label, ptr, nbytes);
    const uint8_t *p = (const uint8_t *)ptr;
    for (int i = 0; i < nbytes; i += 16) {
        fprintf(stderr, "      +%04x:", i);
        for (int j = 0; j < 16 && (i+j) < nbytes; j++)
            fprintf(stderr, " %02x", p[i+j]);
        fprintf(stderr, "\n");
    }
}

static void safe_dump_strings(const char *label, const void *p, int n) {
    if (!p || (uintptr_t)p < 0x10000) return;
    sigjmp_buf saved; memcpy(saved, g_recover, sizeof(sigjmp_buf));
    int saved_in_safe = g_in_safe;
    g_in_safe = 1; g_fault_addr = NULL;
    if (sigsetjmp(g_recover, 1) == 0) {
        const uint8_t *bp = (const uint8_t *)p;
        char strbuf[256]; int in_str=0, slen=0, sstart=0;
        for (int i = 0; i < n; i++) {
            if (bp[i] >= 0x20 && bp[i] < 0x7f) {
                if (!in_str) { in_str=1; sstart=i; slen=0; }
                if (slen < (int)sizeof(strbuf)-1) strbuf[slen++] = (char)bp[i];
            } else {
                if (in_str && slen >= 6) {
                    strbuf[slen] = 0;
                    fprintf(stderr, "  %s +%04x: \"%s\"\n", label, sstart, strbuf);
                }
                in_str=0; slen=0;
            }
        }
        g_in_safe = 0;
    }
    memcpy(g_recover, saved, sizeof(sigjmp_buf));
    g_in_safe = saved_in_safe;
}

uintptr_t g_lib_base_for_diag = 0;

/* ---- IAndroidHTTPProvider accessor pointers (resolved at startup) --------- */

typedef jobject (*fn_req_urlstring_t)(JNIEnv*, jobject);
typedef jobject (*fn_req_method_t)(JNIEnv*, jobject);
typedef jobject (*fn_req_body_t)(JNIEnv*, jobject);
typedef jobject (*fn_req_headers_t)(JNIEnv*, jobject);
typedef jlong   (*fn_req_timeout_t)(JNIEnv*, jobject);
typedef void    (*fn_cb_complete_t)(JNIEnv*, jobject, jobject);
typedef void    (*fn_cb_except_t)(JNIEnv*, jobject, jint, jobject);
typedef jobject (*fn_resp_make_t)(JNIEnv*, jclass, jobject, jint, jobject, jobject, jobject);

static fn_req_urlstring_t g_req_urlstring;
static fn_req_method_t    g_req_method;
static fn_req_body_t      g_req_body;
static fn_req_headers_t   g_req_headers;
static fn_req_timeout_t   g_req_timeout;
static fn_cb_complete_t   g_cb_complete;
static fn_cb_except_t     g_cb_except;
static fn_resp_make_t     g_resp_make;

static void resolve_android_http_syms(void) {
    g_req_urlstring = (fn_req_urlstring_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_00024HTTPRequest_urlString");
    g_req_method    = (fn_req_method_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_00024HTTPRequest_method");
    g_req_body      = (fn_req_body_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_00024HTTPRequest_body");
    g_req_headers   = (fn_req_headers_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_00024HTTPRequest_headers");
    g_req_timeout   = (fn_req_timeout_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_00024HTTPRequest_msTimeout");
    g_cb_complete   = (fn_cb_complete_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_00024Callback_complete");
    g_cb_except     = (fn_cb_except_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_00024Callback_completeExceptionally");
    g_resp_make     = (fn_resp_make_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_HTTPResponse_make");

    fprintf(stderr, "[syms] urlString=%p method=%p body=%p headers=%p timeout=%p\n",
            (void*)g_req_urlstring, (void*)g_req_method, (void*)g_req_body,
            (void*)g_req_headers, (void*)g_req_timeout);
    fprintf(stderr, "[syms] complete=%p except=%p resp_make=%p\n",
            (void*)g_cb_complete, (void*)g_cb_except, (void*)g_resp_make);
}

/* ---- Safe request field extraction ----------------------------------------
 *
 * The request arg to slot 3 may be an IAndroidHTTPProvider::HTTPRequest C++
 * object, in which case the JNI accessors work cleanly.  Wrap it in a fake_obj_t
 * and try.  If that crashes (SIGSEGV), fall back to scanning the raw bytes for
 * https:// / GET / POST strings.
 */

static char *try_accessor_string(fake_obj_t *wrapper, fn_req_urlstring_t fn,
                                  const char *name) {
    if (!fn || !wrapper) return NULL;
    char *result = NULL;
    sigjmp_buf saved; memcpy(saved, g_recover, sizeof(sigjmp_buf));
    int saved_in = g_in_safe;
    g_in_safe = 1; g_fault_addr = NULL;
    if (sigsetjmp(g_recover, 1) == 0) {
        fake_obj_t *bp = (fake_obj_t*)fn(fake_jni_env(), (jobject)wrapper);
        if (bp && bp->address > 0x10000) {
            const char *s = (const char*)(uintptr_t)bp->address;
            /* Sanity: should be printable */
            int ok = 1;
            for (int i = 0; i < 4096 && s[i]; i++) {
                if ((uint8_t)s[i] < 0x09) { ok = 0; break; }
            }
            if (ok) result = strdup(s);
        }
        g_in_safe = 0;
    } else {
        fprintf(stderr, "  [accessor] %s SIGSEGV at %p\n", name, (void*)g_fault_addr);
    }
    memcpy(g_recover, saved, sizeof(sigjmp_buf));
    g_in_safe = saved_in;
    return result;
}

static char *scan_for_url(void *req) {
    if (!req || (uintptr_t)req < 0x10000) return NULL;
    const uint8_t *p = (const uint8_t *)req;
    for (int i = 0; i < 0x400 - 8; i++) {
        if (p[i]=='h'&&p[i+1]=='t'&&p[i+2]=='t'&&p[i+3]=='p') {
            int start = i;
            if ((p[i+4]=='s'&&p[i+5]==':'&&p[i+6]=='/'&&p[i+7]=='/') ||
                (p[i+4]==':'&&p[i+5]=='/'&&p[i+6]=='/')) {
                int j = start;
                while (j < start + 2048 && p[j] > 0x20 && p[j] < 0x7f && p[j] != ' ') j++;
                if (j - start > 10) {
                    char *url = malloc(j - start + 1);
                    if (url) { memcpy(url, p+start, j-start); url[j-start]=0; return url; }
                }
            }
        }
    }
    uintptr_t *w = (uintptr_t *)req;
    for (int i = 0; i < 0x400/8; i++) {
        uintptr_t v = w[i];
        if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
        const char *s = (const char *)v;
        if (strncmp(s, "https://", 8)==0 || strncmp(s, "http://", 7)==0) {
            int j = 0;
            while (j < 2048 && s[j] > 0x20 && s[j] < 0x7f) j++;
            if (j > 10) {
                char *url = malloc(j + 1);
                if (url) { memcpy(url, s, j); url[j]=0; return url; }
            }
        }
    }
    return NULL;
}

static char *scan_for_method(void *req) {
    if (!req || (uintptr_t)req < 0x10000) return NULL;
    const char *p = (const char *)req;
    static const char *methods[] = {"GET","POST","PUT","DELETE","HEAD","PATCH",NULL};
    for (int i = 0; i < 0x300; i++) {
        for (int m = 0; methods[m]; m++) {
            size_t ml = strlen(methods[m]);
            if (strncmp(p+i, methods[m], ml)==0) {
                char next = p[i+ml];
                if (next == 0 || (uint8_t)next < 0x20) return strdup(methods[m]);
            }
        }
    }
    return NULL;
}

/* Extract POST body from req: look for binary plist (bplist) or XML plist,
 * or for a DataBuffer-like (ptr + size) pair.  Returns malloc'd copy. */
static void scan_for_body(void *req, uint8_t **body_out, size_t *len_out) {
    *body_out = NULL; *len_out = 0;
    if (!req || (uintptr_t)req < 0x10000) return;
    uintptr_t *w = (uintptr_t *)req;
    for (int i = 0; i < 0x500/8 - 1; i++) {
        uintptr_t v = w[i];
        if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
        const uint8_t *p = (const uint8_t *)v;
        if (memcmp(p, "bplist", 6) == 0 || memcmp(p, "<?xml", 5) == 0) {
            uintptr_t sz = w[i+1];
            if (sz > 4 && sz < 2*1024*1024) {
                *body_out = malloc(sz);
                if (*body_out) { memcpy(*body_out, p, sz); *len_out = sz; }
                return;
            }
        }
    }
}

/* ---- Real curl HTTP provider --------------------------------------------- */

struct real_resp {
    long    status;
    char    content_type[256];
    uint8_t *body;
    size_t  body_len;
};

static size_t curl_write_body(void *ptr, size_t sz, size_t n, void *ud) {
    struct real_resp *r = (struct real_resp *)ud;
    size_t total = sz * n;
    r->body = realloc(r->body, r->body_len + total + 1);
    if (!r->body) return 0;
    memcpy(r->body + r->body_len, ptr, total);
    r->body_len += total;
    r->body[r->body_len] = 0;
    return total;
}

static size_t curl_write_header(char *buf, size_t sz, size_t nitems, void *ud) {
    struct real_resp *r = (struct real_resp *)ud;
    size_t len = sz * nitems;
    if (len > 13 && strncasecmp(buf, "Content-Type:", 13) == 0) {
        const char *v = buf + 13;
        while (*v == ' ') v++;
        size_t vlen = len - (size_t)(v - buf);
        while (vlen > 0 && (v[vlen-1]=='\r'||v[vlen-1]=='\n'||v[vlen-1]==' ')) vlen--;
        if (vlen < sizeof(r->content_type)-1) {
            memcpy(r->content_type, v, vlen);
            r->content_type[vlen] = 0;
        }
    }
    return len;
}

/* Known GrandSlam User-Agent, copied from GRANDSLAM_FORMAT_FINDING.md */
#define GS_UA "<linux> <android;x86_64;android/x86_64 build/6.5.2 maker/linux model/en_US FW/x64> <com.apple.AuthKitAndroid/1.0 (/)>"

/*
 * Extract headers from req for forwarding to curl.
 * Returns a curl_slist with the headers found (including anisette values if set
 * via withAdditionalHTTPHeader).  Caller must curl_slist_free_all.
 *
 * Strategy: scan the request object's pointer slots for strings starting with
 * "X-Apple-I-" or "X-Mme-" or "Authorization:" and pair them with the next
 * pointer slot as the value.
 */
static struct curl_slist *extract_headers(void *req) {
    struct curl_slist *list = NULL;
    if (!req || (uintptr_t)req < 0x10000) return list;

    sigjmp_buf saved; memcpy(saved, g_recover, sizeof(sigjmp_buf));
    int saved_in = g_in_safe;
    g_in_safe = 1; g_fault_addr = NULL;
    if (sigsetjmp(g_recover, 1) == 0) {
        uintptr_t *w = (uintptr_t *)req;
        for (int i = 0; i < 0x600/8 - 1; i++) {
            uintptr_t v = w[i];
            if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
            const char *k = (const char *)v;
            if (!k[0] || (uint8_t)k[0] < 0x20) continue;
            /* Is this a recognized header name? */
            int is_hdr = (strncmp(k, "X-Apple-I-", 10) == 0 ||
                          strncmp(k, "X-Mme-",     6)  == 0 ||
                          strncmp(k, "Authorization:", 14) == 0);
            if (!is_hdr) continue;
            /* Next pointer slot is the value */
            uintptr_t vv = w[i+1];
            if (vv < 0x100000UL || vv > 0x00007fffffffffffUL) continue;
            const char *val = (const char *)vv;
            if (!val[0] || (uint8_t)val[0] < 0x20) continue;
            /* Sanity: both key and value should be < 1024 bytes */
            int klen = strnlen(k, 1024), vlen = strnlen(val, 2048);
            if (klen < 2 || klen > 128 || vlen < 1 || vlen > 2048) continue;
            char hdr[2200];
            snprintf(hdr, sizeof(hdr), "%s: %s", k, val);
            list = curl_slist_append(list, hdr);
            fprintf(stderr, "[extract_headers] found: %s\n", k);
        }
        g_in_safe = 0;
    }
    memcpy(g_recover, saved, sizeof(sigjmp_buf));
    g_in_safe = saved_in;
    return list;
}

static int make_curl_call(const char *url, const char *method,
                           struct curl_slist *req_hdrs,
                           const uint8_t *body, size_t body_len,
                           struct real_resp *out) {
    memset(out, 0, sizeof(*out));
    CURL *curl = curl_easy_init();
    if (!curl) return -1;

    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write_body);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, out);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, curl_write_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, out);
    /* Spike only: disable SSL verification so the probe works without a full CA bundle */
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 30L);

    struct curl_slist *hdrs = NULL;
    char ua_hdr[600]; snprintf(ua_hdr, sizeof(ua_hdr), "User-Agent: %s", GS_UA);
    char ci_hdr[600]; snprintf(ci_hdr, sizeof(ci_hdr), "X-MMe-Client-Info: %s", GS_UA);
    hdrs = curl_slist_append(hdrs, ua_hdr);
    hdrs = curl_slist_append(hdrs, ci_hdr);
    hdrs = curl_slist_append(hdrs, "Accept: application/x-www-form-urlencoded");

    /* forward any extracted request headers (anisette etc.) */
    struct curl_slist *rh = req_hdrs;
    while (rh) { hdrs = curl_slist_append(hdrs, rh->data); rh = rh->next; }

    int is_post = method && (strcasecmp(method, "POST") == 0 || strcasecmp(method, "PUT") == 0);
    if (is_post) {
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        if (body && body_len > 0) {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, (const char *)body);
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body_len);
            if (body_len >= 6 && memcmp(body, "bplist", 6) == 0)
                hdrs = curl_slist_append(hdrs, "Content-Type: application/x-apple-binary-plist");
            else if (body_len >= 5 && memcmp(body, "<?xml", 5) == 0)
                hdrs = curl_slist_append(hdrs, "Content-Type: text/x-xml-plist");
        } else {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, 0L);
        }
    }

    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, hdrs);

    CURLcode rc = curl_easy_perform(curl);
    int ret = 0;
    if (rc == CURLE_OK) {
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &out->status);
        fprintf(stderr, "[curl] %s %s → %ld (%zu bytes, type='%s')\n",
                method ? method : "GET", url, out->status,
                out->body_len, out->content_type);
    } else {
        fprintf(stderr, "[curl] ERROR %s %s: %s\n",
                method ? method : "GET", url, curl_easy_strerror(rc));
        ret = -1;
    }

    curl_slist_free_all(hdrs);
    curl_easy_cleanup(curl);
    return ret;
}

/* ---- buf_data inline response injection ----------------------------------- */

static void put_sso_str(uint8_t *dst, const char *s) {
    size_t n = strlen(s); if (n > 22) n = 22;
    memset(dst, 0, 24); memcpy(dst, s, n);
    dst[23] = (uint8_t)(n << 1);
}

/* AMSCore::Any(string) layout (from move constructor at 0x5e1190):
 *   [0x00..0x17] = std::string data (24 bytes, copied from the string object)
 *   [0x18]       = type_id (uint32): 5 = string
 *   [0x1c..0x1f] = padding → sizeof(AMSCore::Any) = 32
 *
 * unordered_map<AMSCore::Any, AMSCore::Any> hash node layout (libstdc++ / libc++):
 *   +0x00  __next   (8 bytes)
 *   +0x08  __hash   (8 bytes)
 *   +0x10  key   (AMSCore::Any, 32 bytes)  → type_id at +0x28
 *   +0x30  value (AMSCore::Any, 32 bytes)  → type_id at +0x48
 *   total = 80 bytes
 */
static void build_header_map(uint8_t *hmap, const char *key, const char *val) {
    uint8_t *node = (uint8_t *)malloc(96);   /* 80 needed; 96 for safety */
    uintptr_t *buckets = (uintptr_t *)malloc(sizeof(uintptr_t));
    if (!node || !buckets) return;
    memset(node, 0, 96);

    /* key: AMSCore::Any string */
    put_sso_str(node + 0x10, key);           /* string data at key+0x00..+0x17 */
    *(uint32_t *)(node + 0x28) = 5;          /* key.type_id = 5 (STRING) */

    /* value: AMSCore::Any string */
    put_sso_str(node + 0x30, val);           /* string data at val+0x00..+0x17 */
    *(uint32_t *)(node + 0x48) = 5;          /* val.type_id = 5 (STRING) */

    buckets[0] = (uintptr_t)(hmap + 0x10);
    *(uintptr_t *)(hmap + 0x00) = (uintptr_t)buckets;
    *(size_t    *)(hmap + 0x08) = 1;
    *(uintptr_t *)(hmap + 0x10) = (uintptr_t)node;
    *(size_t    *)(hmap + 0x18) = 1;
    *(float     *)(hmap + 0x20) = 1.0f;
}

static void inject_real_response(void **slot3_self, long status,
                                  const char *content_type,
                                  const uint8_t *body, size_t body_len) {
    if (!slot3_self) {
        static const char m[] = "[inject] slot3_self NULL\n";
        int r = write(2, m, sizeof(m)-1); (void)r; return;
    }
    uint8_t *buf_data = (uint8_t *)slot3_self[0];
    if (!buf_data || (uintptr_t)buf_data < 0x10000) {
        static const char m[] = "[inject] buf_data invalid\n";
        int r = write(2, m, sizeof(m)-1); (void)r; return;
    }
    fprintf(stderr, "[inject] buf_data=%p status=%ld ct='%s' body=%zu\n",
            (void*)buf_data, status, content_type ? content_type : "", body_len);

    /* HTTP status code at +0xd0 */
    *(uint16_t *)(buf_data + 0xd0) = (uint16_t)(status > 0 ? status : 200);

    /* NOTE (2026-11-19): buf_data is the REQUEST buffer (self[0]); the response
     * object perform() destructs lives at self-0x238 and is a well-formed C++
     * object with its OWN headers map — writing the response into buf_data cannot
     * work.  Two dead ends, both re-confirmed with a correct build:
     *   - zero only the count at +0xf0  → destructor at ELF 0x342dbd walks the
     *     non-canonical garbage first-node at +0xe8 (#GP, reported fault=(nil));
     *     RECOVERABLE via our siglongjmp, perform() finishes with a null result.
     *   - zero the whole map header +0xd8..+0xff → "double free or corruption":
     *     +0xd8/+0xe8 share heap nodes with the response copy; FATAL abort.
     * The correct fix is to deliver via the library's own API (HTTPResponse::make
     * at ELF 0x502e3f + the IAndroidHTTPProvider::Callback completion) so the
     * library builds every C++ object with correct ownership.  Until that is
     * wired, keep the RECOVERABLE path (zero +0xf0 only) so the process survives. */
    *(size_t *)(buf_data + 0xf0) = 0;

    /* Body: libc++ long string at buf_data+0x100.
     * Layout (Android/NDK libc++): data*, size, cap|1 (LSB=1 = long mode).
     * Confirmed by stage22 via inline-copy ctor at lib+0x3425c8.
     * Directly overwrite all three fields (no zeroing of surrounding area needed). */
    if (body && body_len > 0) {
        uint8_t *body_copy = (uint8_t *)malloc(body_len + 2);
        if (body_copy) {
            memcpy(body_copy, body, body_len);
            body_copy[body_len] = 0;
            *(uintptr_t *)(buf_data + 0x100) = (uintptr_t)body_copy; /* __data_ */
            *(size_t    *)(buf_data + 0x108) = body_len;              /* __size_ */
            *(size_t    *)(buf_data + 0x110) = (body_len + 2) | 1;   /* __cap_ | long flag */
            fprintf(stderr, "[inject] body@%p len=%zu\n", (void*)body_copy, body_len);
        }
    }

    /* Content-Type header map: skip for now — the XML plist starts with <?xml
     * so the library may auto-detect it. */
    (void)content_type;

    /* Control flags */
    buf_data[0x2e8] = 1;
    buf_data[0x2f0] = 1;
    *(uintptr_t *)(buf_data + 0x2f8) = 1;
}

/* Deliver the curl'd response through the library's own API (the correct path).
 *
 *   HTTPResponse::make(env, cls, arg3, status, body, headers, arg7)  [ELF 0x502e3f]
 * reads FID_ADDRESS + FID_POSITION from each of arg3/body/headers and builds three
 * C++ vectors (element sizes 0xc8/0x28/0x18), then returns a new HTTPResponse jobject.
 * Our fake JNIEnv returns 0 for FID_POSITION, so passing any valid address yields
 * ZERO-LENGTH vectors — i.e. a status-only response.  This first pass proves the
 * delivery plumbing (make succeeds, Callback.complete reaches perform()) before we
 * tackle feeding the real 4550-byte body (which needs a sized/positioned Pointer).
 *
 *   IAndroidHTTPProvider::Callback.complete(env, cbJobj, respJobj)  [ELF 0x4f2dbc]
 * unwraps cbJobj via GetLongField → native callback slot, then delivers respJobj.
 * callback_native is real_vt3's req_b arg (= self+0x20 = rbx+0x668 at the call site). */
static void deliver_via_callback(void *callback_native, long status,
                                 const uint8_t *body, size_t body_len) {
    (void)body; (void)body_len;
    if (!g_resp_make || !g_cb_complete) {
        fprintf(stderr, "[deliver] resp_make=%p complete=%p — unresolved\n",
                (void*)g_resp_make, (void*)g_cb_complete);
        return;
    }
    if (!callback_native || (uintptr_t)callback_native < 0x10000) {
        fprintf(stderr, "[deliver] bad callback %p\n", callback_native);
        return;
    }
    JNIEnv *env = fake_jni_env();

    /* Pointers whose .address is a valid buffer; FID_POSITION → 0 ⇒ empty vectors. */
    static uint8_t zbuf[512];
    memset(zbuf, 0, sizeof(zbuf));
    fake_obj_t cls   = { .class_id = 0, .address = (jlong)(uintptr_t)zbuf };
    fake_obj_t a3    = { .class_id = 0, .address = (jlong)(uintptr_t)zbuf };
    fake_obj_t bodyp = { .class_id = 0, .address = (jlong)(uintptr_t)zbuf };
    fake_obj_t hdrp  = { .class_id = 0, .address = (jlong)(uintptr_t)zbuf };
    fake_obj_t a7    = { .class_id = 0, .address = (jlong)(uintptr_t)zbuf };

    void *resp = NULL;
    SAFE_EVAL(resp, void *, "resp_make",
        g_resp_make(env, (jclass)&cls, (jobject)&a3, (jint)status,
                    (jobject)&bodyp, (jobject)&hdrp, (jobject)&a7));
    fprintf(stderr, "[deliver] resp_make(status=%ld) -> %p\n", status, resp);
    if (!resp) return;

    fake_obj_t cbobj = { .class_id = 0, .address = (jlong)(uintptr_t)callback_native };
    SAFE_CALL("cb_complete", g_cb_complete(env, (jobject)&cbobj, (jobject)resp));
    fprintf(stderr, "[deliver] complete() returned\n");
}

/* ---- Real HTTP vtable ----------------------------------------------------- */

static volatile int g_http_slot_calls[32];
static int s_http_call_count = 0;

/* Scan a larger region (up to 2 KiB) of p for URL and method strings.
 * Uses SAFE_CALL guards internally. */
static char *safe_scan_url_region(void *p, size_t nbytes) {
    if (!p || (uintptr_t)p < 0x10000) return NULL;
    char *result = NULL;
    sigjmp_buf saved; memcpy(saved, g_recover, sizeof(sigjmp_buf));
    int saved_in = g_in_safe;
    g_in_safe = 1; g_fault_addr = NULL;
    if (sigsetjmp(g_recover, 1) == 0) {
        const char *bp = (const char *)p;
        /* Direct byte scan for "http" */
        for (size_t i = 0; i < nbytes && i < 4096; i++) {
            if (bp[i]=='h'&&bp[i+1]=='t'&&bp[i+2]=='t'&&bp[i+3]=='p') {
                int ok = (bp[i+4]==':'||bp[i+4]=='s');
                if (!ok) continue;
                int j = (int)i;
                while (j < (int)i + 2048 && (uint8_t)bp[j] > 0x20 && (uint8_t)bp[j] < 0x7f) j++;
                if (j - (int)i > 10) {
                    result = malloc(j - (int)i + 1);
                    if (result) {
                        memcpy(result, bp + i, j - (int)i);
                        result[j - (int)i] = 0;
                    }
                    break;
                }
            }
        }
        /* Pointer-slot scan */
        if (!result) {
            uintptr_t *w = (uintptr_t *)p;
            for (size_t i = 0; i < nbytes / 8 && i < 256; i++) {
                uintptr_t v = w[i];
                if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
                const char *s = (const char *)v;
                if (strncmp(s, "https://", 8)==0 || strncmp(s, "http://", 7)==0) {
                    int j = 0;
                    while (j < 2048 && (uint8_t)s[j] > 0x20 && (uint8_t)s[j] < 0x7f) j++;
                    if (j > 10) {
                        result = malloc(j + 1);
                        if (result) { memcpy(result, s, j); result[j] = 0; }
                        break;
                    }
                }
            }
        }
        g_in_safe = 0;
    }
    memcpy(g_recover, saved, sizeof(sigjmp_buf));
    g_in_safe = saved_in;
    return result;
}

static char *safe_scan_method_region(void *p, size_t nbytes) {
    if (!p || (uintptr_t)p < 0x10000) return NULL;
    char *result = NULL;
    sigjmp_buf saved; memcpy(saved, g_recover, sizeof(sigjmp_buf));
    int saved_in = g_in_safe;
    g_in_safe = 1; g_fault_addr = NULL;
    if (sigsetjmp(g_recover, 1) == 0) {
        const char *bp = (const char *)p;
        static const char *methods[] = {"GET","POST","PUT","DELETE","HEAD","PATCH",NULL};
        for (size_t i = 0; i < nbytes && i < 4096 && !result; i++) {
            for (int m = 0; methods[m]; m++) {
                size_t ml = strlen(methods[m]);
                if (i + ml >= nbytes) continue;
                if (strncmp(bp + i, methods[m], ml) == 0) {
                    char next = bp[i + ml];
                    if (next == 0 || (uint8_t)next < 0x20) {
                        result = strdup(methods[m]); break;
                    }
                }
            }
        }
        /* Pointer scan */
        if (!result) {
            uintptr_t *w = (uintptr_t *)p;
            for (size_t i = 0; i < nbytes / 8 && i < 256 && !result; i++) {
                uintptr_t v = w[i];
                if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
                const char *s = (const char *)v;
                for (int m = 0; methods[m]; m++) {
                    size_t ml = strlen(methods[m]);
                    if (strncmp(s, methods[m], ml)==0) {
                        char next = s[ml];
                        if (next==0||(uint8_t)next<0x20) { result=strdup(methods[m]); break; }
                    }
                }
            }
        }
        g_in_safe = 0;
    }
    memcpy(g_recover, saved, sizeof(sigjmp_buf));
    g_in_safe = saved_in;
    return result;
}

static void real_vt3(void *self, void *req_a, void *req_b, void *c, void *d) {
    (void)d;
    s_http_call_count++;
    g_http_slot_calls[3]++;

    /* Get buf_data from self[0] — the HARStreamWriter request buffer */
    uint8_t *buf_data = NULL;
    if (self && (uintptr_t)self > 0x10000) buf_data = (uint8_t *)((void**)self)[0];

    fprintf(stderr, "[real_vt3] call#%d self=%p req_a=%p req_b=%p c=%p buf_data=%p\n",
            s_http_call_count, self, req_a, req_b, c, (void*)buf_data);
    {
        extern uintptr_t g_lib_base_for_diag;
        void *ret = __builtin_return_address(0);
        fprintf(stderr, "[real_vt3] caller=%p (elf+0x%lx)\n", ret,
                g_lib_base_for_diag ? (uintptr_t)ret - g_lib_base_for_diag : 0);
    }

    /* Dump buf_data to understand layout before inject */
    if (buf_data && (uintptr_t)buf_data > 0x10000) {
        dump_hex("[buf_data] header", buf_data, 0x300);
        safe_dump_strings("[buf_data] strings", buf_data, 0x300);
    }

    /* DIAG: identify the C++ class of self/req_a/req_b by their vtable pointer's
     * ELF offset, so we know which arg is the Callback to deliver the response to. */
    {
        extern uintptr_t g_lib_base_for_diag;
        uintptr_t b = g_lib_base_for_diag;
        void *vts  = (self  && (uintptr_t)self  > 0x10000) ? ((void**)self)[0]  : NULL;
        void *vta  = (req_a && (uintptr_t)req_a > 0x10000) ? ((void**)req_a)[0] : NULL;
        void *vtb  = (req_b && (uintptr_t)req_b > 0x10000) ? ((void**)req_b)[0] : NULL;
        fprintf(stderr, "[vtid] self.vt=%p(elf+0x%lx) req_a.vt=%p(elf+0x%lx) req_b.vt=%p(elf+0x%lx)\n",
                vts, vts && b ? (uintptr_t)vts-b : 0,
                vta, vta && b ? (uintptr_t)vta-b : 0,
                vtb, vtb && b ? (uintptr_t)vtb-b : 0);
    }

    /* URL and method: scan buf_data first (the library puts request data there),
     * then req_a, then req_b.  Skip crashing JNI accessors for now. */
    char *url = NULL, *method = NULL;
    if (!url && buf_data) url = safe_scan_url_region(buf_data, 0x600);
    if (!url) url = safe_scan_url_region(req_a, 0x400);
    if (!url) url = safe_scan_url_region(req_b, 0x400);
    if (!method && buf_data) method = safe_scan_method_region(buf_data, 0x600);
    if (!method) method = safe_scan_method_region(req_a, 0x400);
    if (!method) method = safe_scan_method_region(req_b, 0x400);

    /* POST body */
    uint8_t *body = NULL; size_t body_len = 0;
    if (method && (strcasecmp(method, "POST")==0 || strcasecmp(method, "PUT")==0)) {
        if (g_req_body && req_a) {
            fake_obj_t wrapper_a = { .class_id=0, .address=(jlong)(uintptr_t)req_a };
            sigjmp_buf saved; memcpy(saved, g_recover, sizeof(sigjmp_buf));
            int saved_in = g_in_safe;
            g_in_safe = 1; g_fault_addr = NULL;
            if (sigsetjmp(g_recover, 1) == 0) {
                fake_obj_t *bp = (fake_obj_t*)g_req_body(fake_jni_env(), (jobject)&wrapper_a);
                if (bp && bp->address > 0x10000) {
                    /* BytePointer: address = data ptr, next field = capacity */
                    const uint8_t *bptr = (const uint8_t*)(uintptr_t)bp->address;
                    /* Use POSITION and LIMIT from the wrapper to get size, or scan */
                    uintptr_t *words = (uintptr_t *)bp;
                    size_t sz = 0;
                    for (int k = 1; k < 8; k++) {
                        if (words[k] > 4 && words[k] < 2*1024*1024) {
                            sz = words[k]; break;
                        }
                    }
                    if (sz > 0 && sz < 2*1024*1024) {
                        body = malloc(sz);
                        if (body) { memcpy(body, bptr, sz); body_len = sz; }
                    }
                }
                g_in_safe = 0;
            }
            memcpy(g_recover, saved, sizeof(sigjmp_buf));
            g_in_safe = saved_in;
        }
        if (!body) scan_for_body(req_a, &body, &body_len);
        if (!body) scan_for_body(req_b, &body, &body_len);
    }

    /* Extract request headers (anisette, device-id etc.) */
    struct curl_slist *req_hdrs = extract_headers(req_a);

    fprintf(stderr, "[real_vt3] method='%s' url='%s' body=%zu headers=%s\n",
            method ? method : "?", url ? url : "?", body_len,
            req_hdrs ? "(some)" : "none");

    if (!url) {
        fprintf(stderr, "[real_vt3] no URL — using lookup fallback for call#1\n");
        /* Use the stage22 known-good lookup response as a last resort */
        if (s_http_call_count == 1) {
            inject_real_response((void **)self, 200, "text/x-xml-plist",
                                  lookup_v2_plist, lookup_v2_plist_len);
        }
        goto done;
    }

    /* Make the real curl call */
    struct real_resp resp;
    memset(&resp, 0, sizeof(resp));
    int rc = make_curl_call(url, method, req_hdrs, body, body_len, &resp);
    if (rc != 0) {
        fprintf(stderr, "[real_vt3] curl failed — using lookup fallback for call#1\n");
        if (s_http_call_count == 1) {
            inject_real_response((void **)self, 200, "text/x-xml-plist",
                                  lookup_v2_plist, lookup_v2_plist_len);
        } else {
            /* For subsequent calls, inject a minimal plist error so perform() terminates */
            static const char empty_plist[] =
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" "
                "\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n"
                "<plist version=\"1.0\"><dict></dict></plist>";
            inject_real_response((void **)self, 200, "text/x-xml-plist",
                                  (const uint8_t *)empty_plist, strlen(empty_plist));
        }
    } else {
        /* NEW PATH: deliver through the library's HTTPResponse::make + Callback.
         * Native complete() reads the callable at callback_slot+0x20; req_b is
         * self+0x20, so the Callback OBJECT is `self` and self+0x20 is its callable. */
        deliver_via_callback(self, resp.status, resp.body, resp.body_len);
    }
    free(resp.body);

done:
    if (req_hdrs) curl_slist_free_all(req_hdrs);
    free(url); free(method); free(body);
}

/* Generic logging slot for all non-3 slots */
#define HTTP_SLOT(N) \
    static void *http_vt##N(void *self, void *a, void *b, void *c, void *d) { \
        (void)d; g_http_slot_calls[N]++; \
        char _tb[160]; int _tn = snprintf(_tb, sizeof(_tb), \
            "  [HTTP VT slot=%2d] call#%d self=%p\n", N, g_http_slot_calls[N], self); \
        if (_tn > 0) { int _r = write(2, _tb, (size_t)_tn); (void)_r; } \
        (void)a;(void)b;(void)c; return NULL; \
    }

HTTP_SLOT(0)  HTTP_SLOT(1)  HTTP_SLOT(2)
/* slot 3 is real_vt3 */
HTTP_SLOT(4)  HTTP_SLOT(5)  HTTP_SLOT(6)  HTTP_SLOT(7)
HTTP_SLOT(8)  HTTP_SLOT(9)  HTTP_SLOT(10) HTTP_SLOT(11)
HTTP_SLOT(12) HTTP_SLOT(13) HTTP_SLOT(14) HTTP_SLOT(15)
HTTP_SLOT(16) HTTP_SLOT(17) HTTP_SLOT(18) HTTP_SLOT(19)
HTTP_SLOT(20) HTTP_SLOT(21) HTTP_SLOT(22) HTTP_SLOT(23)
HTTP_SLOT(24) HTTP_SLOT(25) HTTP_SLOT(26) HTTP_SLOT(27)
HTTP_SLOT(28) HTTP_SLOT(29) HTTP_SLOT(30) HTTP_SLOT(31)

static uintptr_t g_real_http_vtable[32] = {
    (uintptr_t)http_vt0,  (uintptr_t)http_vt1,  (uintptr_t)http_vt2,
    (uintptr_t)real_vt3,  /* slot 3 = real curl call */
    (uintptr_t)http_vt4,  (uintptr_t)http_vt5,  (uintptr_t)http_vt6,
    (uintptr_t)http_vt7,  (uintptr_t)http_vt8,  (uintptr_t)http_vt9,
    (uintptr_t)http_vt10, (uintptr_t)http_vt11, (uintptr_t)http_vt12,
    (uintptr_t)http_vt13, (uintptr_t)http_vt14, (uintptr_t)http_vt15,
    (uintptr_t)http_vt16, (uintptr_t)http_vt17, (uintptr_t)http_vt18,
    (uintptr_t)http_vt19, (uintptr_t)http_vt20, (uintptr_t)http_vt21,
    (uintptr_t)http_vt22, (uintptr_t)http_vt23, (uintptr_t)http_vt24,
    (uintptr_t)http_vt25, (uintptr_t)http_vt26, (uintptr_t)http_vt27,
    (uintptr_t)http_vt28, (uintptr_t)http_vt29, (uintptr_t)http_vt30,
    (uintptr_t)http_vt31,
};

/* ---- Anisette vtable (trace only) ---------------------------------------- */

static volatile int g_ani_calls[32];
#define ANI_SLOT(N) \
    static void *ani_vt##N(void *self, void *a, void *b, void *c, void *d) { \
        (void)d; g_ani_calls[N]++; \
        char _tb[180]; int _tn = snprintf(_tb, sizeof(_tb), \
            "  [ANI slot=%2d] call#%d self=%p a=%p\n", N, g_ani_calls[N], self, a); \
        if (_tn > 0) { int _r = write(2, _tb, (size_t)_tn); (void)_r; } \
        (void)b;(void)c; return NULL; \
    }
ANI_SLOT(0)  ANI_SLOT(1)  ANI_SLOT(2)  ANI_SLOT(3)
ANI_SLOT(4)  ANI_SLOT(5)  ANI_SLOT(6)  ANI_SLOT(7)
ANI_SLOT(8)  ANI_SLOT(9)  ANI_SLOT(10) ANI_SLOT(11)
ANI_SLOT(12) ANI_SLOT(13) ANI_SLOT(14) ANI_SLOT(15)
ANI_SLOT(16) ANI_SLOT(17) ANI_SLOT(18) ANI_SLOT(19)
ANI_SLOT(20) ANI_SLOT(21) ANI_SLOT(22) ANI_SLOT(23)
ANI_SLOT(24) ANI_SLOT(25) ANI_SLOT(26) ANI_SLOT(27)
ANI_SLOT(28) ANI_SLOT(29) ANI_SLOT(30) ANI_SLOT(31)
static uintptr_t g_ani_vtable[32] = {
    (uintptr_t)ani_vt0, (uintptr_t)ani_vt1, (uintptr_t)ani_vt2, (uintptr_t)ani_vt3,
    (uintptr_t)ani_vt4, (uintptr_t)ani_vt5, (uintptr_t)ani_vt6, (uintptr_t)ani_vt7,
    (uintptr_t)ani_vt8, (uintptr_t)ani_vt9, (uintptr_t)ani_vt10, (uintptr_t)ani_vt11,
    (uintptr_t)ani_vt12, (uintptr_t)ani_vt13, (uintptr_t)ani_vt14, (uintptr_t)ani_vt15,
    (uintptr_t)ani_vt16, (uintptr_t)ani_vt17, (uintptr_t)ani_vt18, (uintptr_t)ani_vt19,
    (uintptr_t)ani_vt20, (uintptr_t)ani_vt21, (uintptr_t)ani_vt22, (uintptr_t)ani_vt23,
    (uintptr_t)ani_vt24, (uintptr_t)ani_vt25, (uintptr_t)ani_vt26, (uintptr_t)ani_vt27,
    (uintptr_t)ani_vt28, (uintptr_t)ani_vt29, (uintptr_t)ani_vt30, (uintptr_t)ani_vt31,
};

/* ---- Stub providers ------------------------------------------------------- */

typedef struct { uintptr_t vtable_ptr; uintptr_t data[7]; } stub_cxx_t;
static void *stub_vfn(void *self, ...) { return self; }
static uintptr_t g_stub_vtable[32];
static void init_stub_vtable(void) {
    for (int i = 0; i < 32; i++) g_stub_vtable[i] = (uintptr_t)stub_vfn;
}

typedef struct { jlong class_id; jlong address; } fake_obj2_t;
static fake_obj_t *make_stub_provider(stub_cxx_t *cxx) {
    cxx->vtable_ptr = (uintptr_t)g_stub_vtable;
    fake_obj_t *o = fake_alloc_obj(0);
    o->address = (jlong)(uintptr_t)cxx;
    return o;
}

static stub_cxx_t s_mescal_cxx, s_account_cxx, s_fairplay_cxx,
                  s_http_cxx, s_anisette_v3_cxx;

/* ---- JVM shim (unchanged) ------------------------------------------------- */

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

/* ---- Code patches (unchanged from stage22) -------------------------------- */

static void patch_code(uintptr_t addr, const uint8_t *code, size_t len, const char *what) {
    uintptr_t page = addr & ~(uintptr_t)4095;
    size_t span = (addr + len) - page;
    if (mprotect((void *)page, span < 4096 ? 4096 : span + 4096,
                 PROT_READ|PROT_WRITE|PROT_EXEC) != 0) {
        fprintf(stderr, "[patch] mprotect failed for %s\n", what); return;
    }
    memcpy((void *)addr, code, len);
    mprotect((void *)page, span < 4096 ? 4096 : span + 4096, PROT_READ|PROT_EXEC);
    fprintf(stderr, "[patch] %s @ 0x%lx (%zu bytes)\n", what, addr, len);
}
static void patch_should_redact(uintptr_t base) {
    static const uint8_t s[] = { 0x31, 0xc0, 0xc3 };
    patch_code(base + 0x72abe0, s, sizeof(s), "shouldRedact→false");
}
static void patch_har_body_serializer(uintptr_t base) {
    static const uint8_t n[] = {0x90,0x90,0x90,0x90,0x90};
    patch_code(base + 0x60c1f0, n, sizeof(n), "HAR body-serializer NOP");
}

/* AMSCore::Any type dispatch tables all lack an upper-bounds check; only
 * type_id == 0xffffffff (null) is guarded.  When the plist parser creates an
 * Any with an unknown type_id the dispatch goes out of bounds and crashes.
 *
 * We found three distinct patterns across 46 dispatch sites:
 *
 * (A) r15-index, used by the move constructor (ELF 0x5e20f3):
 *   original: b8 ff ff ff ff  49 39 c7  74 19
 *   patched:  41 83 ff NN  90  90 90 90  77 19
 *             cmp $NN,%r15d  nop  nop×3  ja skip
 *
 * (B) eax-index with je skip:  b9 ff ff ff ff  48 39 c8  74 XX
 *   patched:  83 f8 NN  90 90  90 90 90  77 XX
 *             cmp $NN,%eax  nop×2  nop×3  ja skip
 *
 * (C) eax-index with cmovz-to-neg1 null sentinel:
 *       b9 ff ff ff ff  48 39 c8  6a ff  ...  cmovz %r13,%rax
 *   Here cmovz triggers on ZF from cmp %rcx,%rax; for null it loads rax=-1
 *   so table[-1] (8 bytes before the array) is a no-op handler.
 *   We need garbage type_ids to also land on table[-1].
 *   Patch 10 bytes: cmp $NN,%eax; jb +3; xor %eax,%eax; nop; 6a ff
 *   – valid (< NN):  jb taken → land on original push $-1 (unchanged)
 *   – null/garbage:  fall-through → xor eax,eax (ZF=1) → push -1; pop r13
 *                    → cmovz fires → rax=-1 → table[-1] no-op
 *   NOTE: type_id == NN uses jbe semantics (above test uses jb not jbe to
 *   avoid the ZF=1 edge case at eax==NN); we keep NN one below the last
 *   valid index so the boundary type_id takes the safe path too.
 */

/* Pattern (B): je-skip, 10-byte patch at null_check_off */
static void patch_any_je_site(uintptr_t base, uint32_t nc_off,
                               uint8_t max_id, uint8_t je_offset) {
    uint8_t p[10];
    p[0]=0x83; p[1]=0xf8; p[2]=max_id;    /* cmp $max_id,%eax */
    p[3]=0x90; p[4]=0x90;                  /* nop nop (pad to 5) */
    p[5]=0x90; p[6]=0x90; p[7]=0x90;      /* nop×3 (replace 3-byte cmp) */
    p[8]=0x77; p[9]=je_offset;             /* ja skip */
    char lbl[64]; snprintf(lbl, sizeof(lbl), "Any je-dispatch@0x%x", nc_off);
    patch_code(base + nc_off, p, sizeof(p), lbl);
}

/* Pattern (C): cmovz-sentinel, 10-byte patch at null_check_off */
static void patch_any_cmov_site(uintptr_t base, uint32_t nc_off, uint8_t max_id) {
    /* cmp $max_id-1,%eax; jb +3 (skip xor for valid); xor %eax,%eax; nop; 6a ff */
    uint8_t p[10];
    p[0]=0x83; p[1]=0xf8; p[2]=(uint8_t)(max_id > 0 ? max_id-1 : 0); /* cmp */
    p[3]=0x72; p[4]=0x03;                  /* jb +3  (land on push $-1) */
    p[5]=0x31; p[6]=0xc0;                  /* xor %eax,%eax  → ZF=1 */
    p[7]=0x90;                             /* nop */
    p[8]=0x6a; p[9]=0xff;                  /* push $-1  (original, also jb target) */
    char lbl[64]; snprintf(lbl, sizeof(lbl), "Any cmov-dispatch@0x%x", nc_off);
    patch_code(base + nc_off, p, sizeof(p), lbl);
}

static void patch_any_dispatch_bounds(uintptr_t base) {
    /* Pattern (A): move constructor — uses r15 as index */
    static const uint8_t mv[] = {0x41,0x83,0xff,0x13, 0x90, 0x90,0x90,0x90, 0x77,0x19};
    patch_code(base + 0x5e20f3, mv, sizeof(mv), "Any move-ctor dispatch bounds-check");

    /* Pattern (B): je-skip sites (null_check_off, max_type_id, je_offset) */
    static const struct { uint32_t off; uint8_t max_id; uint8_t je_off; } je_sites[] = {
        {0x336bd0, 30, 0x11},  /* destructor */
        {0x3391dc, 30, 0x11},
        {0x34a5ee, 31, 0x11},
        {0x52efd2, 29, 0x11},
        {0x5bf3e4, 31, 0x11},
        {0x5e26df, 31, 0x25},  /* hash */
        {0x60a432, 30, 0x11},
        {0x613088, 31, 0x11},
        {0x69b0d0, 31, 0x11},
        {0x6dcf38, 31, 0x11},
        {0x762d04, 31, 0x11},
        {0x7b5e20, 31, 0x11},
    };
    for (size_t i = 0; i < sizeof(je_sites)/sizeof(je_sites[0]); i++)
        patch_any_je_site(base, je_sites[i].off, je_sites[i].max_id, je_sites[i].je_off);

    /* Pattern (C): cmovz-sentinel sites (null_check_off, max_type_id) */
    static const struct { uint32_t off; uint8_t max_id; } cmov_sites[] = {
        {0x357b42, 31}, {0x357bba, 31}, {0x357c2e, 31}, {0x357ca2, 31},
        {0x357d16, 31}, {0x357d8a, 31}, {0x357dfe, 31},
        {0x3530bd, 31}, {0x353149, 31}, {0x3531d6, 31}, {0x353263, 31},
        {0x3532f0, 31}, {0x35337d, 31}, {0x35340a, 31}, {0x353497, 31},
        {0x5f1a2a, 31}, {0x5f1ae4, 31}, {0x5f1b9e, 31}, {0x5f1c58, 31},
        {0x5f1d12, 31}, {0x5f1dcc, 31}, {0x5f1e86, 31}, {0x5f1f40, 31},
        {0x5f1ffa, 31}, {0x5f4a5c, 31}, {0x5f4ad4, 31}, {0x5f4b48, 31},
        {0x5f4bbc, 31}, {0x5f4c30, 31}, {0x5f4ca4, 31}, {0x5f4d18, 31},
        {0x5f4d8c, 31}, {0x5f4e00, 31},
    };
    for (size_t i = 0; i < sizeof(cmov_sites)/sizeof(cmov_sites[0]); i++)
        patch_any_cmov_site(base, cmov_sites[i].off, cmov_sites[i].max_id);
}

/* ---- Utility -------------------------------------------------------------- */

static void *hybrid_load(const char *name) {
    void *h = embedded_dlopen(name, RTLD_NOW|RTLD_GLOBAL);
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

/* ===== main ================================================================ */

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    setvbuf(stderr, NULL, _IONBF, 0);
    disable_io_vtable_check();

    struct sigaction sa = {0};
    sa.sa_flags = SA_SIGINFO|SA_NODEFER;
    sa.sa_sigaction = sigsegv_handler; sigaction(SIGSEGV, &sa, NULL);
    sa.sa_sigaction = sigabrt_handler; sigaction(SIGABRT, &sa, NULL);
    g_main_thread = pthread_self();

    curl_global_init(CURL_GLOBAL_DEFAULT);

    printf("=== stage23 real_http probe ===\n\n");
    g_sF[0]=stdin; g_sF[1]=stdout; g_sF[2]=stderr;
    init_stub_vtable();

    setenv("HYBRIS_LINKER_DIR",      "../../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", LIB64, 1);
    setenv("HYBRIS_ANDROID_LIB64",   LIB64, 1);
    setenv("ANDROID_ROOT", "/tmp/newstack-root", 0);
    setenv("ANDROID_DATA", "/tmp/newstack-data", 0);
    mkdir("/tmp/newstack-data", 0700);

    if (embedded_loader_init() != 0) { fprintf(stderr, "hybris init failed\n"); return 1; }
    embedded_set_hook_callback(hook);

    hybrid_load("libz.so");
    hybrid_load("libm.so");
    hybrid_load("libc++_shared.so");
    void *hams = hybrid_load("libAMSKit.so");
    if (!hams) return 1;

    /* Resolve IAndroidHTTPProvider accessor symbols */
    resolve_android_http_syms();

    uintptr_t lib_base = 0;
    {
        const char *anchor_sym =
            "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
            "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
            "Ljava_lang_String_2Ljava_lang_String_2";
        uintptr_t anchor = (uintptr_t)embedded_dlsym(anchor_sym);
        if (!anchor) { fprintf(stderr, "FATAL: anchor not found\n"); return 1; }
        lib_base = anchor - 0x4f73b0UL;
        g_lib_base_for_diag = lib_base;
        printf("[javacpp-patch] lib_base=0x%lx\n", lib_base);
        *(jfieldID *)(lib_base + 0x90b5a8) = FID_ADDRESS;
        *(jfieldID *)(lib_base + 0x90b5b0) = FID_POSITION;
        *(jfieldID *)(lib_base + 0x90b5b8) = FID_LIMIT;
        *(jfieldID *)(lib_base + 0x90b5c0) = FID_CAPACITY;
        *(jfieldID *)(lib_base + 0x90b5c8) = FID_OTHER;
        *(jfieldID *)(lib_base + 0x90b5d0) = FID_ADDRESS;
        install_fake_jvm(lib_base);
        patch_should_redact(lib_base);
        patch_har_body_serializer(lib_base);
        patch_any_dispatch_bounds(lib_base);
    }

    JNIEnv *env = fake_jni_env();
    printf("\n");

    /* [1] BundleInfoWrapper */
    const char *s_bimake =
        "Java_com_apple_mediaservices_amskit_bindings_BundleInfoWrapper_make__"
        "Ljava_lang_String_2Ljava_lang_String_2Ljava_lang_String_2"
        "Ljava_lang_String_2Ljava_lang_String_2";
    typedef jobject (*fn_binfo_t)(JNIEnv*,jclass,jobject,jobject,jobject,jobject,jobject);
    fn_binfo_t make_binfo=(fn_binfo_t)resolve_sym(s_bimake);
    fake_obj_t *binfo_obj=NULL;
    if (make_binfo) {
        fake_obj_t *bs1=fake_byteptr("com.apple.android.music"),*bs2=fake_byteptr("1586"),
                   *bs3=fake_byteptr("6.5.2"),*bs4=fake_byteptr("23B74"),*bs5=fake_byteptr("Android 14");
        binfo_obj=(fake_obj_t*)make_binfo(env,(jclass)42,bs1,bs2,bs3,bs4,bs5);
        dump_obj("BundleInfoWrapper",binfo_obj);
        free(bs1);free(bs2);free(bs3);free(bs4);free(bs5);
    }

    /* [2] Session */
    typedef void (*fn_sballoc_t)(JNIEnv*,jobject);
    fn_sballoc_t alloc_sb=(fn_sballoc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_allocate");
    fake_obj_t *sb_obj=NULL;
    if (alloc_sb) { sb_obj=fake_alloc_obj(0); alloc_sb(env,sb_obj); dump_obj("SessionBuilder",sb_obj); }

    /* HTTP provider using REAL curl vtable */
    s_http_cxx.vtable_ptr = (uintptr_t)g_real_http_vtable;
    fake_obj_t *http_prov   = make_stub_provider(&s_http_cxx);
    fake_obj_t *mescal_prov = make_stub_provider(&s_mescal_cxx);
    fake_obj_t *account_prov= make_stub_provider(&s_account_cxx);
    fake_obj_t *fp_prov     = make_stub_provider(&s_fairplay_cxx);
    /* Override: our http_cxx must have the REAL vtable pointer, not stub's */
    s_http_cxx.vtable_ptr = (uintptr_t)g_real_http_vtable;

    typedef void (*fn_set_t)(JNIEnv*,jobject,jobject);
    fn_set_t set_http   =(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setHTTPProvider");
    fn_set_t set_mescal =(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setMescalProvider");
    fn_set_t set_account=(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setAccountProvider");
    fn_set_t set_fp     =(fn_set_t)embedded_dlsym("Java_com_apple_mediaservices_amskit_bindings_SessionBuilder_setFairPlayCoreProvider");
    if (sb_obj&&sb_obj->address) {
        if (set_http)    SAFE_CALL("setHTTPProvider",   set_http(env,sb_obj,http_prov));
        if (set_mescal)  SAFE_CALL("setMescalProvider", set_mescal(env,sb_obj,mescal_prov));
        if (set_account) SAFE_CALL("setAccountProvider",set_account(env,sb_obj,account_prov));
        if (set_fp)      SAFE_CALL("setFPProvider",     set_fp(env,sb_obj,fp_prov));
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
    typedef jobject (*fn_sbmake_t)(JNIEnv*,jobject,jobject,jobject,jobject,jobject,jobject,
                                   jobject,jobject,jobject,jobject,jobject,jobject,jobject,
                                   jboolean,jbyte);
    fn_sbmake_t sb_make=(fn_sbmake_t)resolve_sym(s_sbmake);
    fake_obj_t *session_obj=NULL;
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
    typedef void (*fn_ap_alloc_t)(JNIEnv*,jclass);
    fn_ap_alloc_t alloc_ap=(fn_ap_alloc_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_IAnisetteProvider_allocate");
    fake_obj_t *anisette_obj=NULL;
    if (alloc_ap) {
        anisette_obj=fake_alloc_obj(0); alloc_ap(env,anisette_obj);
        if (anisette_obj->address) {
            uintptr_t *cxx=(uintptr_t*)(uintptr_t)anisette_obj->address;
            cxx[0]=(uintptr_t)g_ani_vtable;
        }
    }
    typedef void (*fn_set_ap_t)(JNIEnv*,jobject,jobject);
    fn_set_ap_t set_ap=(fn_set_ap_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_Session_setAnisetteProvider");
    if (set_ap&&session_obj&&anisette_obj)
        SAFE_CALL("setAnisetteProvider", set_ap(env,session_obj,anisette_obj));

    /* [3b] AnisetteV3 */
    if (getenv("ADAM_ANISETTE_V3")) {
        typedef void (*fn_mkv3_t)(JNIEnv*,jclass,jobject,jobject);
        fn_mkv3_t mkv3=(fn_mkv3_t)resolve_sym(
            "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_makeAnisetteV3Provider");
        fake_obj_t *v3_adapt=make_stub_provider(&s_anisette_v3_cxx);
        s_anisette_v3_cxx.vtable_ptr=(uintptr_t)g_ani_vtable;
        if (mkv3&&session_obj&&v3_adapt)
            SAFE_CALL("makeAnisetteV3Provider",mkv3(env,(jclass)42,session_obj,v3_adapt));
    }

    /* [4] createIdMSBagService */
    const char *s_idms2 =
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_"
        "createIdMSBagService__Lcom_apple_mediaservices_amskit_bindings_Session_2";
    typedef jobject (*fn_idms2_t)(JNIEnv*,jclass,jobject);
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
    typedef void (*fn_bag_t)(JNIEnv*,jclass,jobject,jobject,jobject,jobject);
    fn_bag_t alloc_bag=(fn_bag_t)resolve_sym(s_bag);
    fake_obj_t *bag_obj=NULL;
    if (alloc_bag&&session_obj&&binfo_obj) {
        bag_obj=fake_alloc_obj(0);
        fake_obj_t *url1=fake_byteptr("https://bag.itunes.apple.com/bag.xml?ix=5");
        fake_obj_t *url2=fake_byteptr("143441-29,29");
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
    typedef void (*fn_cred_alloc_t)(JNIEnv*,jclass,jobject,jobject,jobject);
    fn_cred_alloc_t alloc_cred=(fn_cred_alloc_t)resolve_sym(s_cred_alloc);
    fake_obj_t *cred_builder=NULL;
    if (alloc_cred&&idms_obj&&bag_obj) {
        cred_builder=fake_alloc_obj(0);
        char *real_user=read_cred("cred_username.txt");
        fake_obj_t *email_bp=fake_byteptr(real_user?real_user:"test@icloud.com");
        SAFE_CALL("CredBuilder_allocate",alloc_cred(env,cred_builder,idms_obj,bag_obj,email_bp));
        free(email_bp);
    }
    typedef void (*fn_wc_t)(JNIEnv*,jobject,jobject);
    fn_wc_t with_cred=(fn_wc_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_withCredential");
    typedef jobject (*fn_build_t)(JNIEnv*,jobject);
    fn_build_t build_opts=(fn_build_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_build");
    typedef void (*fn_acred_t)(JNIEnv*,jclass,jobject,jbyte);
    fn_acred_t alloc_acred=(fn_acred_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "AccountCredential_allocate__Lorg_bytedeco_javacpp_BytePointer_2B");
    fake_obj_t *cred_opts=NULL;
    if (cred_builder&&cred_builder->address&&with_cred&&build_opts) {
        const char *cred_file=getenv("ADAM_CRED_FILE"); if (!cred_file) cred_file="cred_idmsauth.txt";
        const char *type_env=getenv("ADAM_CRED_TYPE");  jbyte cred_type=(jbyte)(type_env?atoi(type_env):0);
        char *real_tok=read_cred(cred_file);
        fake_obj_t *tok_bp=fake_byteptr(real_tok?real_tok:"testtoken");
        fprintf(stderr,"[cred] using file=%s type=%d\n",cred_file,(int)cred_type);

        fake_obj_t *acred=NULL;
        if (alloc_acred) {
            acred=fake_alloc_obj(0);
            SAFE_CALL("AccountCredential_allocate",alloc_acred(env,(jclass)acred,tok_bp,cred_type));
            dump_obj("AccountCredential",acred);
        }
        fake_obj_t *cred_arg=(acred&&acred->address)?acred:tok_bp;
        SAFE_CALL("withCredential",with_cred(env,cred_builder,cred_arg));

        /* Anisette + device headers from state/ credential files */
        typedef void (*fn_wh_t)(JNIEnv*,jobject,jobject,jobject);
        fn_wh_t with_hdr=(fn_wh_t)embedded_dlsym(
            "Java_com_apple_mediaservices_amskit_bindings_"
            "CredentialsAuthenticateTaskOptionsBuilder_withAdditionalHTTPHeader");
        if (with_hdr) {
            static const struct { const char *name, *file; } hdrs[] = {
                {"X-Apple-I-MD",        "cred_otp_md.txt"},
                {"X-Apple-I-MD-M",      "cred_otp_mdm.txt"},
                {"X-Apple-I-MD-RINFO",  "cred_rinfo.txt"},
                {"X-Apple-I-Client-Time","cred_clienttime.txt"},
                {"X-Apple-I-TimeZone",  "cred_tz.txt"},
                {"X-Mme-Device-Id",     "cred_deviceid.txt"},
                {NULL, NULL}
            };
            for (int hi = 0; hdrs[hi].name; hi++) {
                char *v=read_cred(hdrs[hi].file);
                if (!v||!*v) continue;
                fake_obj_t *kb=fake_byteptr(hdrs[hi].name);
                fake_obj_t *vb=fake_byteptr(v);
                SAFE_CALL("withAdditionalHTTPHeader",with_hdr(env,cred_builder,kb,vb));
                fprintf(stderr,"[cred] header %s set\n",hdrs[hi].name);
            }
        }

        SAFE_CALL("build",cred_opts=(fake_obj_t*)build_opts(env,cred_builder));
        if (cred_opts&&cred_opts->address) {
            uint8_t *cxx=(uint8_t*)(uintptr_t)cred_opts->address;
            if (!cxx[0xa0]) cxx[0xa0]=1;
        }
    }

    /* [8] perform */
    printf("\n[8] perform(Session, CredentialsAuthenticateTaskOptions)\n");
    const char *s_perform =
        "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_perform__"
        "Lcom_apple_mediaservices_amskit_bindings_Session_2"
        "Lcom_apple_mediaservices_amskit_bindings_CredentialsAuthenticateTaskOptions_2";
    typedef jobject (*fn_perform_t)(JNIEnv*,jclass,jobject,jobject);
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
            if (rptrs[1]&&(uintptr_t)rptrs[1]>0x10000) {
                uint8_t *ep=(uint8_t*)rptrs[1];
                uint32_t errval=*(uint32_t*)(ep+0x28);
                fprintf(stderr,"[error] value=0x%x (%u)\n",errval,errval);
                if (errval==0) {
                    fprintf(stderr,"[SUCCESS] perform() succeeded!\n");
                    dump_hex("result struct", r, 192);
                    safe_dump_strings("result strings", r, 512);
                } else {
                    dump_hex("error struct (result+0x8)", ep, 192);
                    uintptr_t *w=(uintptr_t*)ep;
                    for (int k=0;k<24;k++) {
                        uintptr_t v=w[k];
                        if (v<0x100000UL||v>0x00007fffffffffffUL) continue;
                        char lbl[32]; snprintf(lbl,sizeof(lbl),"err.*+%02x",k*8);
                        safe_dump_strings(lbl,(void*)v,0x100);
                    }
                }
            }
        }
        fprintf(stderr,"\n[stage23] http_call_count=%d\n",s_http_call_count);
        fprintf(stderr,"[stage23] REAL HTTP vtable slot call counts:\n");
        for (int i=0;i<32;i++) if (g_http_slot_calls[i])
            fprintf(stderr,"  slot[%2d] = %d\n",i,g_http_slot_calls[i]);
        fprintf(stderr,"[stage23] ANI slot call counts:\n");
        for (int i=0;i<32;i++) if (g_ani_calls[i])
            fprintf(stderr,"  ani_slot[%2d] = %d\n",i,g_ani_calls[i]);
    }

    printf("\n[9] sleeping 3s...\n");
    sleep(3);
    curl_global_cleanup();
    printf("=== stage23 done ===\n");
    return 0;
}
