/*
 * stage22_probe.c -- deliver a fake GrandSlam lookup HTTP response inline
 *
 * Root-cause analysis (stage21):
 *   slot3 on the HTTP provider vtable is an ASYNC "submit request" call.
 *   The library does NOT read a response from slot3's return value.
 *   After slot3 returns, handleProcessLifecycleEvent (0x688b3c..0x688ba2):
 *
 *     1. Calls 34001e(HARStreamWriter+0x638, self=HARStreamWriter+0x648)
 *        — moves the ByteBuffer from self into HARStreamWriter+0x638
 *        — new_data_ptr = *(HARStreamWriter+0x638) = same buf_data address
 *
 *     2. 0x688b56: reads *(new_data_ptr + 0x2f8)
 *        — if NON-NULL → 0x688b7f INLINE response path (our target!)
 *        — if null     → 0x688b73: register rbx at buf_data+0x2f8, return
 *
 *   Inline response path (0x688b7f..0x688ba2):
 *     3429a0(r15=HARStreamWriter+0x340, rsi=new_data_ptr)
 *       — 0x3429be: checks *(new_data_ptr + 0x2f0):  0 → error,  1 → success
 *       — success: 3424d0(r15, new_data_ptr+8) reads *(new_data_ptr+0x2e8)
 *                  then 342524(r15, byte) stores it to *(r15+0x2e0)
 *       — if byte(0x2e8) != 0 → 3425c8(r15, new_data_ptr+8):
 *           new_data_ptr+0xd0 : uint16_t HTTP status code (200)
 *           new_data_ptr+0xd8 : HTTP headers struct (can be zeroed)
 *           new_data_ptr+0x100: libc++ std::string word 0 (data ptr)
 *           new_data_ptr+0x108: libc++ std::string word 1 (size)
 *           new_data_ptr+0x110: libc++ std::string word 2 (cap | 1 = long)
 *
 *     34248e(HARStreamWriter+0x18, r15=HARStreamWriter+0x340)
 *       — sets done flag *(HARStreamWriter+0x300) = 1
 *       — perform() sees flag, advances state machine
 *
 * Fix: from within trace_vt3 (slot3), set all required fields in buf_data
 * before returning.  34001e preserves buf_data address.  0x688b56 sees
 * non-null at buf_data+0x2f8 → takes inline response path → done flag set.
 *
 * libc++ std::string layout (Android NDK r22+, little-endian x86_64):
 *   long mode (word 2 bit 0 = 1):
 *     word 0  buf_data+0x100 : data pointer
 *     word 1  buf_data+0x108 : string length
 *     word 2  buf_data+0x110 : capacity | 1  (long flag)
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
    uintptr_t rdi = (uintptr_t)uc->uc_mcontext.gregs[REG_RDI];
    uintptr_t rsi = (uintptr_t)uc->uc_mcontext.gregs[REG_RSI];
    uintptr_t rdx = (uintptr_t)uc->uc_mcontext.gregs[REG_RDX];
    uintptr_t r14 = (uintptr_t)uc->uc_mcontext.gregs[REG_R14];
    uintptr_t r15 = (uintptr_t)uc->uc_mcontext.gregs[REG_R15];
    uintptr_t rbx = (uintptr_t)uc->uc_mcontext.gregs[REG_RBX];
    uintptr_t rsp = (uintptr_t)uc->uc_mcontext.gregs[REG_RSP];
    char buf[512];
    int n = snprintf(buf, sizeof(buf),
        "[SIGSEGV] fault=%p rip=%p thread=%s\n"
        "  rdi=%016lx rsi=%016lx rdx=%016lx\n"
        "  rbx=%016lx r14=%016lx r15=%016lx\n"
        "  rsp=%016lx\n",
        si->si_addr, (void*)rip,
        pthread_equal(pthread_self(), g_main_thread) ? "main" : "bg",
        (unsigned long)rdi, (unsigned long)rsi, (unsigned long)rdx,
        (unsigned long)rbx, (unsigned long)r14, (unsigned long)r15,
        (unsigned long)rsp);
    if (n > 0) { int r = write(2, buf, n); (void)r; }
    /* Dump stack words to find call chain return addresses */
    {
        uintptr_t *sp = (uintptr_t *)rsp;
        for (int chunk = 0; chunk < 6; chunk++) {
            char sbuf[700]; int sn = 0;
            int start = chunk * 16;
            sn += snprintf(sbuf+sn, sizeof(sbuf)-sn, "  stack[+%02x..+%02x]:", start*8, (start+16)*8-1);
            for (int i = start; i < start+16 && sn < (int)sizeof(sbuf)-30; i++) {
                if (i % 4 == 0) sn += snprintf(sbuf+sn, sizeof(sbuf)-sn, "\n   +%03x:", i*8);
                sn += snprintf(sbuf+sn, sizeof(sbuf)-sn, " %016lx", (unsigned long)sp[i]);
            }
            sbuf[sn++] = '\n'; sbuf[sn] = 0;
            int r = write(2, sbuf, sn); (void)r;
        }
    }
    /* Print backtrace before recovery or exit so we can see the call chain */
    {
        void *frames[32];
        int nf = backtrace(frames, 32);
        backtrace_symbols_fd(frames, nf, 2);
    }
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        g_in_safe = 0; siglongjmp(g_recover, 1);
    }
    if (!pthread_equal(pthread_self(), g_main_thread)) {
        pthread_exit(NULL);
    }
    signal(SIGSEGV, SIG_DFL); raise(SIGSEGV);
}

extern uintptr_t g_lib_base_for_diag;

/* Dump /proc/self/maps to stderr so we can resolve unregistered-library frames. */
static void dump_maps(void) {
    static const char hdr[] = "\n--- /proc/self/maps (hybris libs) ---\n";
    int r = write(2, hdr, sizeof(hdr)-1); (void)r;
    int fd = open("/proc/self/maps", O_RDONLY);
    if (fd < 0) return;
    char buf[256];
    ssize_t n;
    while ((n = read(fd, buf, sizeof(buf))) > 0) {
        ssize_t w = write(2, buf, (size_t)n); (void)w;
    }
    close(fd);
    static const char ftr[] = "--- end maps ---\n";
    r = write(2, ftr, sizeof(ftr)-1); (void)r;
}

/*
 * realloc() interceptor: catches the "realloc(): invalid pointer" abort that fires
 * when libc++_shared.so tries to grow a std::string whose __data_ is not a valid
 * glibc heap pointer (small offset, stack pointer, or Bionic-internal address).
 *
 * On an obviously bad pointer (< 0x10000 or not 16-byte aligned as glibc requires
 * for chunk headers), we:
 *   1. Print a one-line diagnostic + full backtrace.
 *   2. Return a fresh malloc(new_size) so the caller can continue.
 * Data in the old "string" is lost, but the caller (string::reallocate) will
 * copy the old chars before destroying them — except the old ptr is invalid,
 * so we cannot safely memcpy from it.  Returning an empty buffer is safer than
 * crashing: the string will be garbage but the task can progress.
 */
void *realloc(void *old_ptr, size_t new_size) {
    extern void *__libc_realloc(void *, size_t);
    if (!old_ptr) return malloc(new_size);
    uintptr_t p = (uintptr_t)old_ptr;
    /* glibc minimum valid chunk: > 0x10000, 16-byte aligned, and must have valid
     * chunk header two words before it. We use a simple range check only. */
    if (p < 0x10000 || (p & 0xf) != 0) {
        char msg[192];
        int n = snprintf(msg, sizeof(msg),
            "[realloc-bad] ptr=%p size=%zu lib_base=0x%lx — returning fresh malloc\n",
            old_ptr, new_size, (unsigned long)g_lib_base_for_diag);
        if (n > 0) { int w = write(2, msg, (size_t)n); (void)w; }
        void *bt[32]; int nbt = backtrace(bt, 32); backtrace_symbols_fd(bt, nbt, 2);
        dump_maps();
        return malloc(new_size);
    }
    return __libc_realloc(old_ptr, new_size);
}

static void sigabrt_handler(int sig, siginfo_t *si, void *ctx) {
    (void)sig; (void)si; (void)ctx;
    if (g_in_safe && pthread_equal(pthread_self(), g_main_thread)) {
        /* Dump a backtrace + RIP before recovering so we can locate the bad free(). */
        ucontext_t *uc = (ucontext_t *)ctx;
        uintptr_t rip = (uintptr_t)uc->uc_mcontext.gregs[REG_RIP];
        uintptr_t rdi = (uintptr_t)uc->uc_mcontext.gregs[REG_RDI];
        char b[200];
        int bn = snprintf(b, sizeof(b),
            "[SIGABRT] rip=%p rdi(freed?)=%016lx lib_base=0x%lx\n",
            (void*)rip, (unsigned long)rdi, (unsigned long)g_lib_base_for_diag);
        if (bn > 0) { int r = write(2, b, bn); (void)r; }
        void *frames[40];
        int nf = backtrace(frames, 40);
        backtrace_symbols_fd(frames, nf, 2);
        dump_maps();
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

/* ---- dump helpers ---------------------------------------------------- */

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

static void dump_strings(const char *label, const void *ptr, int nbytes) {
    if (!ptr || (uintptr_t)ptr < 0x10000) return;
    const uint8_t *p = (const uint8_t *)ptr;
    char strbuf[512];
    int in_str = 0, slen = 0, sstart = 0;
    for (int i = 0; i < nbytes; i++) {
        if (p[i] >= 0x20 && p[i] < 0x7f) {
            if (!in_str) { in_str = 1; sstart = i; slen = 0; }
            if (slen < (int)sizeof(strbuf)-1) strbuf[slen++] = (char)p[i];
        } else {
            if (in_str && slen >= 8) {
                strbuf[slen] = 0;
                char buf[600];
                int n = snprintf(buf, sizeof(buf), "  %s +%04x: \"%s\"\n", label, sstart, strbuf);
                if (n > 0) { int r = write(2, buf, n); (void)r; }
            }
            in_str = 0; slen = 0;
        }
    }
}

/* ---- Outgoing request dump (GrandSlam format capture) ----------------- */

/* dump_strings under a sigsetjmp guard so a bad pointer can't kill us. */
static void safe_dump_strings(const char *label, const void *p, int n) {
    if (!p || (uintptr_t)p < 0x10000) return;
    g_in_safe = 1; g_fault_addr = NULL;
    if (sigsetjmp(g_recover, 1) == 0) {
        dump_strings(label, p, n);
        g_in_safe = 0;
    } else {
        char b[128]; int bn = snprintf(b, sizeof(b),
            "  %s → fault at %p\n", label, (void*)g_fault_addr);
        if (bn > 0) { int r = write(2, b, bn); (void)r; }
    }
}

/*
 * dump_request — the AMSCore::HTTPRequest handed to IHTTPProvider::submitRequest
 * (vtable slot 3) is the exact outgoing request libAMSKit built, BEFORE TLS.
 * For GrandSlam this is the CredentialsAuthenticate POST (URL + headers + SRP body).
 * We don't rely on a known struct layout: dump inline bytes (SSO strings, method,
 * flags) and follow every heap-pointer-looking slot, string-dumping its target
 * (libc++ long-mode std::string data, DataBuffer bodies, header-map nodes).
 */
static void dump_request(const char *tag, void *req) {
    if (!req || (uintptr_t)req < 0x10000) return;
    /* This hook runs inside perform(), which the caller wrapped in its own
     * SAFE_CALL(g_recover). Our fault-guarded reads re-arm g_recover, so save
     * and restore the outer recovery state around everything we do. */
    sigjmp_buf saved_recover;
    memcpy(saved_recover, g_recover, sizeof(sigjmp_buf));
    int saved_in_safe = g_in_safe;

    char hb[160];
    int hn = snprintf(hb, sizeof(hb),
        "\n========== OUTGOING REQUEST (%s) obj=%p ==========\n", tag, req);
    if (hn > 0) { int r = write(2, hb, hn); (void)r; }

    /* 1) inline bytes of the object itself (SSO URL/method, small fields) */
    safe_dump_strings("req.inline", req, 0x280);

    /* 2) follow pointer-looking slots one level deep */
    uintptr_t *w = (uintptr_t *)req;
    for (int i = 0; i < 0x280 / 8; i++) {
        uintptr_t v = 0;
        SAFE_EVAL(v, uintptr_t, "req.slot", w[i]);
        if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
        char lb[48];
        snprintf(lb, sizeof(lb), "req.*+%03x", i * 8);
        safe_dump_strings(lb, (void *)v, 0x600);
    }
    static const char m[] = "========== END REQUEST ==========\n";
    int r = write(2, m, sizeof(m) - 1); (void)r;

    /* restore the outer SAFE_CALL recovery state */
    memcpy(g_recover, saved_recover, sizeof(sigjmp_buf));
    g_in_safe = saved_in_safe;
}

/* ---- Fake HTTP Response vtable ---------------------------------------- */

/*
 * The library calls resp->vtable[5] as a tail call from 0x58fa04.
 * rdi = resp (our fake response).
 * We need a valid vtable with no-op stubs at all slots so we can observe
 * which slots are actually called, and return meaningful values.
 *
 * vtable[5] is especially important — it's the first one called.
 * After that, the library likely calls more vtable slots to read:
 *   - status code (HTTP 200)
 *   - response body
 *   - content-type header
 */

static void *g_current_resp = NULL;  /* track current fake response for slot logging */
uintptr_t g_lib_base_for_diag = 0;

/*
 * Generic no-op stub: logs which vtable slot was called and returns NULL.
 * We use separate functions per slot so the log message is specific.
 */
#define RESP_SLOT(N) \
    static void *resp_vt##N(void *self, void *a, void *b, void *c) { \
        char _tb[160]; \
        int _tn = snprintf(_tb, sizeof(_tb), \
            "  [RESP VT slot=%2d] self=%p a=%p b=%p c=%p\n", N, self, a, b, c); \
        if (_tn > 0) { int _r = write(2, _tb, (size_t)_tn); (void)_r; } \
        return NULL; \
    }

RESP_SLOT(0)   RESP_SLOT(1)   RESP_SLOT(2)   RESP_SLOT(3)
RESP_SLOT(4)   RESP_SLOT(5)   RESP_SLOT(6)   RESP_SLOT(7)
RESP_SLOT(8)   RESP_SLOT(9)   RESP_SLOT(10)  RESP_SLOT(11)
RESP_SLOT(12)  RESP_SLOT(13)  RESP_SLOT(14)  RESP_SLOT(15)

/*
 * The vtable itself — 16 entries, one per slot.
 * vtable[5] is the first one called by 0x58fa04.
 */
static void *g_resp_vtable[16] = {
    resp_vt0,  resp_vt1,  resp_vt2,  resp_vt3,
    resp_vt4,  resp_vt5,  resp_vt6,  resp_vt7,
    resp_vt8,  resp_vt9,  resp_vt10, resp_vt11,
    resp_vt12, resp_vt13, resp_vt14, resp_vt15,
};

/* ---- HTTP fake response ---------------------------------------------------- */

/* Minimal JSON body: 17 chars, fits in libc++ SSO (≤22 chars = no heap ptr) */
static const char s_fake_gs_lookup_body[] = "{\"il\":{},\"cd\":14}";

/* Real GrandSlam GsService2/lookup/v2 plist (fetched live from gsd.apple.com),
 * embedded as lookup_v2_plist[] / lookup_v2_plist_len. Planted as the body of the
 * FIRST forged response so the task can discover service URLs and proceed to the
 * real authenticate POST. */
#include "lookup_v2_body.h"

/* Directory holding extracted-session credential sidecar files (kept out of the
 * repo; these are the user's own account tokens, read at runtime only). */
#define CRED_DIR "/tmp/claude-1000/-home-daksh-Git-Projects-apple-music-linux/" \
                 "00f6bb53-6fb1-4f8a-b2a1-89e4cf2412cf/scratchpad"

/* Read a sidecar credential file into a malloc'd NUL-terminated string, trailing
 * newline stripped. Returns NULL (and logs) if missing. Never prints the value. */
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

static int s_http_call_count = 0;

/* provider vtable slot call counts (defined here so inject_inline_response, which
 * precedes the TRACE_SLOT macros, can gate the lookup-body plant on call #1) */
static volatile int g_slot_calls[32];

/* Write a libc++ SHORT (SSO) std::string (<=22 chars) into the 24 bytes at dst.
 * New-layout short mode (matching the body's long layout data@+0/size@+8/cap@+16):
 * chars at bytes[0..], size*2 at byte[23] (bit0=0 => short). SSO strings hold NO
 * heap, so the response destructor frees nothing for them — far less corruption
 * risk than malloc-backed long strings (which caused heap aborts). */
static void put_long_str(uint8_t *dst, const char *s) {
    size_t n = strlen(s);
    if (n > 22) n = 22;
    memset(dst, 0, 24);
    memcpy(dst, s, n);
    dst[23] = (uint8_t)(n << 1);
}

/*
 * build_header_map — construct a libc++ unordered_map<string,string> with ONE
 * entry {"Content-Type": "text/x-xml-plist"} at hmap (buf_data+0xd8 = the response
 * header map). Using bucket_count=1 means libc++ find() constrains every hash to
 * bucket 0, so the stored node hash is never compared — only the key string — which
 * sidesteps matching libc++'s internal std::hash. getDecodedBody reads Content-Type
 * from this map to select the plist decoder, so the lookup body decodes to an AnyMap.
 * node + bucket array are malloc'd so the response destructor's frees are valid.
 * libc++ __hash_table layout (40 bytes):
 *   +0x00 bucket array ptr   +0x08 bucket count
 *   +0x10 __first_node_.__next_ (first node)   +0x18 size   +0x20 max_load_factor(f)
 * __hash_node (64 bytes): +0x00 next  +0x08 hash  +0x10 key(str24)  +0x28 value(str24)
 */
static void build_header_map(uint8_t *hmap, const char *key, const char *val) {
    uint8_t *node = (uint8_t *)malloc(64);
    uintptr_t *buckets = (uintptr_t *)malloc(sizeof(uintptr_t));
    if (!node || !buckets) return;
    memset(node, 0, 64);
    *(uintptr_t *)(node + 0x00) = 0;                 /* __next_ = null (only node) */
    *(uintptr_t *)(node + 0x08) = 0;                 /* __hash_ (irrelevant, bc=1)  */
    put_long_str(node + 0x10, key);                  /* key   = "Content-Type"      */
    put_long_str(node + 0x28, val);                  /* value = "text/x-xml-plist"  */
    buckets[0] = (uintptr_t)(hmap + 0x10);           /* bucket0 → __first_node_      */
    *(uintptr_t *)(hmap + 0x00) = (uintptr_t)buckets;/* __bucket_list_ ptr           */
    *(size_t    *)(hmap + 0x08) = 1;                 /* bucket count                 */
    *(uintptr_t *)(hmap + 0x10) = (uintptr_t)node;   /* __first_node_.__next_ = node */
    *(size_t    *)(hmap + 0x18) = 1;                 /* size                         */
    *(float     *)(hmap + 0x20) = 1.0f;              /* max_load_factor              */
}

/*
 * inject_inline_response — write a fake HTTP 200 response directly into buf_data
 * so the library's inline response path (0x688b56..0x688ba2) fires synchronously.
 *
 * self = slot3 arg1 (rdi = HARStreamWriter+0x648 as void**).
 *   self[0] = buf_data start ptr  (the ByteBuffer data pointer)
 *   self[1] = buf_data end ptr
 *
 * After slot3 returns, 34001e moves *self into HARStreamWriter+0x638 preserving
 * buf_data address. 0x688b56 reads *(buf_data + 0x2f8): non-null → inline path.
 *
 * Fields written (all inside buf_data):
 *   +0xd0  uint16_t  HTTP status code = 200
 *   +0x2e8 uint8_t   non-zero → 3425c8 (full response copy path)
 *   +0x2f0 uint8_t   non-zero → 3429a0 success branch
 *   +0x2f8 uintptr_t non-null → 0x688b56 inline trigger
 *   +0x100 uintptr_t libc++ std::string word 0: data ptr   (NDK r22+ layout)
 *   +0x108 uintptr_t libc++ std::string word 1: size
 *   +0x110 uintptr_t libc++ std::string word 2: capacity | 1 (long flag)
 *
 * If that crashes (wrong layout), try alternate NDK r14 layout:
 *   +0x100: cap | 1   +0x108: size   +0x110: data ptr
 */
static void inject_inline_response(void **slot3_self) {
    s_http_call_count++;
    char logbuf[512];
    int n;

    n = snprintf(logbuf, sizeof(logbuf),
        "[stage22] slot3 call#%d: self=%p\n",
        s_http_call_count, (void*)slot3_self);
    if (n > 0) { int r = write(2, logbuf, n); (void)r; }

    if (!slot3_self) {
        static const char m[] = "[stage22] slot3_self is NULL — cannot inject\n";
        int r = write(2, m, sizeof(m)-1); (void)r;
        return;
    }

    /* Dump self layout before writing so we can verify our understanding */
    dump_hex("slot3 self (rdi=HARStreamWriter+0x648)", slot3_self, 64);

    uint8_t *buf_data = (uint8_t *)slot3_self[0];
    n = snprintf(logbuf, sizeof(logbuf),
        "[stage22] buf_data = %p (self[0])\n", (void*)buf_data);
    if (n > 0) { int r = write(2, logbuf, n); (void)r; }

    if (!buf_data || (uintptr_t)buf_data < 0x10000) {
        static const char m[] = "[stage22] buf_data invalid — cannot inject\n";
        int r = write(2, m, sizeof(m)-1); (void)r;
        return;
    }

    /* Dump buf_data key regions before we write */
    dump_hex("buf_data[0xc8..0xe0]  (status+hdrs area)", buf_data + 0xc8, 0x18);
    dump_hex("buf_data[0xd8..0x120] (hdrs+body)",         buf_data + 0xd8, 0x48);
    dump_hex("buf_data[0x2d0..0x310](ctrl flags)",        buf_data + 0x2d0, 0x40);

    /* JSON body inline in SSO — no malloc needed */
    size_t json_len = strlen(s_fake_gs_lookup_body);

    /*
     * Zero the whole response-fields region buf_data+0xd8..+0x2e0 so every
     * libc++ container the library move-constructs / destroys from our fake
     * response starts in a valid EMPTY state:
     *   0xd8 : HTTP headers std::__hash_table (size 0 → move skips node deref)
     *   ...  : one or more std::vector<std::string> (begin=end=0 → empty,
     *          so the element-destructor loop at lib+0x33e3b4 runs 0 times)
     *   ...  : assorted std::string fields (all-zero = valid SSO empty strings)
     * The response URL object in this region is also zeroed; the URL::encode
     * crash it used to cause is handled separately by patch_should_redact()
     * (the redaction check that serialized the URL is now a no-op), so zeroing
     * the URL here is safe and makes all the containers safe at once.
     * The body SSO string at 0x100 is written AFTER this memset, below.
     */
    dump_hex("buf_data[0x70..0xd8] (pre-memset strings)", buf_data + 0x70, 0x68);
    /*
     * The response object destructor at lib+0x342d16 (this=buf_data) tears down
     * these member fields, all of which our forged buffer leaves as garbage /
     * self-referential (data ptrs pointing into buf_data → invalid free):
     *   +0x18  optional<string>  (freed via 3360fe if flag byte at +0x30 set)
     *   +0x40  optional<string>  (freed via 3360fe if flag byte at +0x58 set)
     *   +0x60  std::vector<std::string>  (element-dtor loop at lib+0x342e1a)
     *   +0x78  std::string
     *   +0x90  std::string
     *   +0xa8  optional<string>  (freed via 3360fe if flag byte at +0xc0 set)
     * Zeroing 0x18..0xc0 makes every string empty-SSO (cap bit0=0 → short → no
     * heap free) and every vector empty (begin=end=0 → 0 iterations, delete(0)).
     * Preserve the vtable/header at 0x00..0x18 and the lib ptr at 0xc0.
     */
    memset(buf_data + 0x18, 0, 0xc0 - 0x18);
    memset(buf_data + 0xd8, 0, 0x2e0 - 0xd8);

    /* HTTP status 200 at +0xd0 (the inline-copy ctor at lib+0x3425c8 takes src =
     * new_data_ptr+8, so its src-relative +0xc8 == buf_data +0xd0). */
    *(uint16_t *)(buf_data + 0xd0) = 200;

    /*
     * Write as a libc++ SHORT (SSO) string — no heap ownership / free risk.
     * Short mode: all 24 bytes stored inline; byte 23 = 2*size (bit0=0 = short).
     * Our JSON is 17 chars → byte 23 = 0x22.
     * We write the SSO bytes IN PLACE (without zeroing the surrounding area)
     * so we do NOT corrupt any URL or string objects stored in other buf_data fields.
     */
    {
        /*
         * Body std::string at buf_data+0x100 (libc++ long layout: +0x100 data ptr,
         * +0x108 size, +0x110 cap|1 LSB=long flag) — confirmed by the inline-copy
         * ctor at lib+0x3425c8 (src = new_data_ptr+8, so its src+0xf8 == +0x100).
         * On the FIRST request (the GrandSlam GsService2/lookup/v2 GET) plant the
         * REAL lookup plist as a long-mode string backed by an independent malloc'd
         * buffer, so the response destructor's free(__data_) is valid. The library
         * then copies this body into the HTTPResponse it builds.
         * Later requests keep an empty body — by then we've already dumped them.
         */
        (void)json_len;
        if (g_slot_calls[3] == 1 && !getenv("ADAM_NO_BODY")) {
            size_t blen = (size_t)lookup_v2_plist_len;
            uint8_t *heap = (uint8_t *)malloc(blen + 2);
            if (heap) {
                memcpy(heap, lookup_v2_plist, blen);
                heap[blen] = 0;
                *(uint8_t **)(buf_data + 0x100) = heap;          /* __data_ */
                *(size_t *)(buf_data + 0x108)   = blen;          /* __size_ */
                *(size_t *)(buf_data + 0x110)   = (blen + 2) | 1;/* __cap_ | long flag */
                char mb[96];
                int mn = snprintf(mb, sizeof(mb),
                    "[stage22] planted real lookup/v2 body: %zu bytes @ %p\n",
                    blen, (void *)heap);
                if (mn > 0) { int r = write(2, mb, mn); (void)r; }
            }
            /* Supply Content-Type so getDecodedBody picks the plist decoder and the
             * body decodes to an AnyMap (fixes "Body was not of AnyMap type").
             * ADAM_NO_HDRMAP=1 disables it (crash-isolation testing). */
            if (!getenv("ADAM_NO_HDRMAP")) {
                build_header_map(buf_data + 0xd8, "Content-Type", "text/x-xml-plist");
                static const char m[] = "[stage22] built Content-Type header map\n";
                int r = write(2, m, sizeof(m)-1); (void)r;
            }
        }
    }

    /* Status byte: non-zero → 3425c8 (full HTTP copy path including body) */
    buf_data[0x2e8] = 1;

    /* Success flag: non-zero → 3429a0 success branch */
    buf_data[0x2f0] = 1;

    /* Inline trigger: non-null → 0x688b56 takes inline path */
    *(uintptr_t *)(buf_data + 0x2f8) = (uintptr_t)1;

    n = snprintf(logbuf, sizeof(logbuf),
        "[stage22] injected: status=200 body=SSO len=%zu "
        "flags(0x2e8=%02x 0x2f0=%02x 0x2f8=%lx)\n",
        json_len,
        buf_data[0x2e8], buf_data[0x2f0],
        (unsigned long)*(uintptr_t *)(buf_data + 0x2f8));
    if (n > 0) { int r = write(2, logbuf, n); (void)r; }

    /* Dump key regions after write for verification */
    dump_hex("buf_data[0xc8..0xe0]  (status AFTER)",  buf_data + 0xc8, 0x18);
    dump_hex("buf_data[0xd8..0x120] (hdrs AFTER)",     buf_data + 0xd8, 0x48);
    dump_hex("buf_data[0x2e8..0x308](flags AFTER)",    buf_data + 0x2e8, 0x20);
}

/* ---- Provider vtable (HTTP) ------------------------------------------- */

#define TRACE_SLOT(N) \
    static void *trace_vt##N(void *self, void *a, void *b, void *c, void *d) { \
        g_slot_calls[N]++; \
        void *_ra = __builtin_return_address(0); \
        char _tb[240]; \
        int _tn = snprintf(_tb, sizeof(_tb), \
            "  [VT slot=%2d] call#%d self=%p a=%p b=%p c=%p retaddr=%p\n", \
            N, g_slot_calls[N], self, a, b, c, _ra); \
        if (_tn > 0) { int _r = write(2, _tb, (size_t)_tn); (void)_r; } \
        if (N == 3 && getenv("ADAM_DUMP_REQ")) { dump_request("a", a); dump_request("b", b); } \
        if (N == 3) inject_inline_response((void **)self); \
        return NULL; \
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

/* Separate, distinctly-labelled vtable for the anisette provider so we can see
 * exactly whether/which slot AMS invokes on it during the task (the HTTP provider
 * reuses g_trace_vtable, which made anisette calls indistinguishable). */
static volatile int g_ani_calls[32];
#define ANI_SLOT(N) \
    static void *ani_vt##N(void *self, void *a, void *b, void *c, void *d) { \
        (void)d; g_ani_calls[N]++; \
        char _tb[200]; int _tn = snprintf(_tb, sizeof(_tb), \
            "  [ANISETTE slot=%2d] call#%d self=%p a=%p b=%p c=%p\n", \
            N, g_ani_calls[N], self, a, b, c); \
        if (_tn > 0) { int _r = write(2, _tb, (size_t)_tn); (void)_r; } \
        return NULL; \
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
    (uintptr_t)ani_vt0,  (uintptr_t)ani_vt1,  (uintptr_t)ani_vt2,  (uintptr_t)ani_vt3,
    (uintptr_t)ani_vt4,  (uintptr_t)ani_vt5,  (uintptr_t)ani_vt6,  (uintptr_t)ani_vt7,
    (uintptr_t)ani_vt8,  (uintptr_t)ani_vt9,  (uintptr_t)ani_vt10, (uintptr_t)ani_vt11,
    (uintptr_t)ani_vt12, (uintptr_t)ani_vt13, (uintptr_t)ani_vt14, (uintptr_t)ani_vt15,
    (uintptr_t)ani_vt16, (uintptr_t)ani_vt17, (uintptr_t)ani_vt18, (uintptr_t)ani_vt19,
    (uintptr_t)ani_vt20, (uintptr_t)ani_vt21, (uintptr_t)ani_vt22, (uintptr_t)ani_vt23,
    (uintptr_t)ani_vt24, (uintptr_t)ani_vt25, (uintptr_t)ani_vt26, (uintptr_t)ani_vt27,
    (uintptr_t)ani_vt28, (uintptr_t)ani_vt29, (uintptr_t)ani_vt30, (uintptr_t)ani_vt31,
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

static stub_cxx_t s_http_cxx, s_mescal_cxx, s_account_cxx, s_fairplay_cxx, s_anisette_v3_cxx;

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

/*
 * Overwrite the first bytes of a library function with machine code.
 * Used to neuter logging/redaction helpers that would otherwise serialize a
 * half-built URL (uninitialized userinfo string) and segfault.
 */
static void patch_code(uintptr_t addr, const uint8_t *code, size_t len, const char *what) {
    uintptr_t page = addr & ~(uintptr_t)4095;
    size_t span = (addr + len) - page;
    if (mprotect((void *)page, span < 4096 ? 4096 : span + 4096,
                 PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
        fprintf(stderr, "[patch] mprotect failed for %s @ 0x%lx\n", what, addr);
        return;
    }
    memcpy((void *)addr, code, len);
    mprotect((void *)page, span < 4096 ? 4096 : span + 4096,
             PROT_READ | PROT_EXEC);
    fprintf(stderr, "[patch] %s @ 0x%lx (%zu bytes)\n", what, addr, len);
}

/*
 * HTTPResponse::shouldRedact() at lib+0x72abe0 serializes the response URL to
 * decide whether to redact it in logs. Our injected response has no real request
 * behind it, so the URL's userinfo std::string (field +0x40) is uninitialized
 * garbage → URL::encode dereferences a bad data ptr and crashes at lib+0x74834f.
 * Redaction is logging-only, off the functional path. Force it to return false
 * (don't redact) so the serialization never runs:  xor eax,eax ; ret
 */
static void patch_should_redact(uintptr_t lib_base) {
    static const uint8_t stub[] = { 0x31, 0xc0, 0xc3 };   /* xor eax,eax ; ret */
    patch_code(lib_base + 0x72abe0, stub, sizeof(stub), "HTTPResponse::shouldRedact->false");
}

/*
 * HAR body-object serializer crash at lib+0x60c1f0.
 *
 * After the lookup response body decodes to an AnyMap (Content-Type fix), the
 * HAR JSON serializer (lib+0x60be00) walks the decoded body back to JSON for
 * debug logging.  It enters lib+0x60a6dc which reads a string field via the
 * path:  *(decoded_obj + 0x10) + 0x28  — that field stores the "name" of a
 * nested object from the decoded plist.  For our forged response, this string
 * has data_ptr = -8 (0xfffffffffffffff8), crashing at lib+0x608be8:
 *   movdqu 0x0(%r13),%xmm0   ; r13 = -8
 *
 * Root cause: the plist body is decoded correctly, but the AnyMap's internal
 * Any-string representation for one of the nested dict values leaves the
 * std::string in an invalid state on our x86_64 glibc host (Bionic libc++
 * mismatch).  This is entirely in the HAR logging path — it has no effect on
 * the functional GrandSlam task execution.
 *
 * Fix: NOP out the 5-byte `call 0x60a6dc` at lib+0x60c1f0.  The null check
 * just before the call already handles the empty-body case; we extend that
 * skip to all cases so the broken serializer is never entered.
 */
static void patch_har_body_serializer(uintptr_t lib_base) {
    static const uint8_t nop5[5] = {0x90, 0x90, 0x90, 0x90, 0x90};
    patch_code(lib_base + 0x60c1f0, nop5, sizeof(nop5), "HAR body-obj serializer NOP");
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

    printf("=== stage22 inline_resp probe ===\n\n");
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
    /* ADAM_REAL_HTTP=1 → do NOT install our stub HTTP provider, so the library
     * falls back to its own default HTTP provider (IHTTPProvider::makeDefault).
     * If that default does real network under hybris, the task gets real
     * responses (with real headers) and the whole forging problem disappears. */
    int real_http = getenv("ADAM_REAL_HTTP") && atoi(getenv("ADAM_REAL_HTTP"));
    if (sb_obj&&sb_obj->address) {
        if (real_http) {
            fprintf(stderr, "[stage22] ADAM_REAL_HTTP=1 — skipping stub HTTP provider "
                            "(testing library default real provider)\n");
        } else if(set_http) {
            SAFE_CALL("setHTTPProvider",   set_http(env,sb_obj,http_prov));
        }
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
            cxx[0]=(uintptr_t)g_ani_vtable;
        }
    }
    typedef void (*fn_set_ap_t)(JNIEnv *, jobject, jobject);
    fn_set_ap_t set_ap=(fn_set_ap_t)resolve_sym(
        "Java_com_apple_mediaservices_amskit_bindings_Session_setAnisetteProvider");
    if (set_ap&&session_obj&&anisette_obj)
        SAFE_CALL("setAnisetteProvider", set_ap(env,session_obj,anisette_obj));

    /* [3b] Anisette V3: makeAnisetteV3Provider(Session, adaptor) installs a V3 provider
     * that calls adaptor->request() for OTP. ADAM_ANISETTE_V3=1 enables. First pass uses
     * the trace vtable so we can see WHICH slot AMS invokes on the adaptor (= request). */
    if (getenv("ADAM_ANISETTE_V3")) {
        typedef void (*fn_mkv3_t)(JNIEnv*, jclass, jobject, jobject);
        fn_mkv3_t mkv3=(fn_mkv3_t)resolve_sym(
            "Java_com_apple_mediaservices_amskit_bindings_AppleMediaServicesCore_makeAnisetteV3Provider");
        fake_obj_t *v3_adaptor=make_stub_provider(&s_anisette_v3_cxx);
        s_anisette_v3_cxx.vtable_ptr=(uintptr_t)g_ani_vtable;   /* trace to find request slot */
        if (mkv3&&session_obj&&v3_adaptor)
            SAFE_CALL("makeAnisetteV3Provider", mkv3(env,(jclass)42,session_obj,v3_adaptor));
    }

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
        char *real_user=read_cred("cred_username.txt");
        fake_obj_t *email_bp=fake_byteptr(real_user?real_user:"test@icloud.com");
        SAFE_CALL("CredBuilder_allocate",alloc_cred(env,cred_builder,idms_obj,bag_obj,email_bp));
        /* keep real_user alive — the builder stores the username std::string by
         * copy, but don't free the byteptr wrapper's backing until after alloc */
        free(email_bp);
    }
    typedef void (*fn_wc_t)(JNIEnv *, jobject, jobject);
    fn_wc_t with_cred=(fn_wc_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_withCredential");
    typedef jobject (*fn_build_t)(JNIEnv *, jobject);
    fn_build_t build_opts=(fn_build_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "CredentialsAuthenticateTaskOptionsBuilder_build");
    /* Construct a proper AccountCredential(token, type). The type byte comes from
     * the Android enum AccountCredential$Type: PasswordEquivalentToken=0,
     * RawPassword=1, CKToken=2. We use the extracted session token with
     * type=PasswordEquivalentToken by default. Both the token file and type are
     * overridable via env (ADAM_CRED_FILE / ADAM_CRED_TYPE) for quick A/B runs. */
    typedef void (*fn_acred_t)(JNIEnv *, jclass, jobject, jbyte);
    fn_acred_t alloc_acred=(fn_acred_t)embedded_dlsym(
        "Java_com_apple_mediaservices_amskit_bindings_"
        "AccountCredential_allocate__Lorg_bytedeco_javacpp_BytePointer_2B");
    fake_obj_t *cred_opts=NULL;
    if (cred_builder&&cred_builder->address&&with_cred&&build_opts) {
        const char *cred_file=getenv("ADAM_CRED_FILE"); if(!cred_file) cred_file="cred_idmsauth.txt";
        const char *type_env=getenv("ADAM_CRED_TYPE"); jbyte cred_type=(jbyte)(type_env?atoi(type_env):0);
        char *real_tok=read_cred(cred_file);
        fake_obj_t *tok_bp=fake_byteptr(real_tok?real_tok:"testtoken");
        fprintf(stderr,"[cred] using file=%s type=%d\n", cred_file, (int)cred_type);

        fake_obj_t *acred=NULL;
        if (alloc_acred) {
            acred=fake_alloc_obj(0);
            SAFE_CALL("AccountCredential_allocate",
                      alloc_acred(env,(jclass)acred,tok_bp,cred_type));
            dump_obj("AccountCredential",acred);
        } else {
            fprintf(stderr,"[cred] AccountCredential_allocate MISSING\n");
        }
        fake_obj_t *cred_arg=(acred&&acred->address)?acred:tok_bp;

        SAFE_CALL("withCredential",with_cred(env,cred_builder,cred_arg));

        /* Supply anisette headers directly via withAdditionalHTTPHeader(String,String)
         * (fake-JNI jstring == fake_obj whose address is the C string). This tests
         * whether the authenticate request can be built with pre-computed anisette
         * (X-Apple-I-MD / -M from the native ADI) WITHOUT implementing the V3 provider.
         * Each header read from a scratchpad file; absent files are skipped. */
        typedef void (*fn_wh_t)(JNIEnv *, jobject, jobject, jobject);
        fn_wh_t with_hdr=(fn_wh_t)embedded_dlsym(
            "Java_com_apple_mediaservices_amskit_bindings_"
            "CredentialsAuthenticateTaskOptionsBuilder_withAdditionalHTTPHeader");
        if (with_hdr) {
            struct { const char *name, *file; } hdrs[] = {
                {"X-Apple-I-MD",        "cred_otp_md.txt"},
                {"X-Apple-I-MD-M",      "cred_otp_mdm.txt"},
                {"X-Apple-I-MD-RINFO",  "cred_rinfo.txt"},
                {"X-Apple-I-Client-Time","cred_clienttime.txt"},
                {"X-Apple-I-TimeZone",  "cred_tz.txt"},
                {"X-Mme-Device-Id",     "cred_deviceid.txt"},
            };
            for (size_t hi = 0; hi < sizeof(hdrs)/sizeof(hdrs[0]); hi++) {
                char *v = read_cred(hdrs[hi].file);
                if (!v || !*v) continue;
                fake_obj_t *kb = fake_byteptr(hdrs[hi].name);
                fake_obj_t *vb = fake_byteptr(v);
                SAFE_CALL("withAdditionalHTTPHeader", with_hdr(env,cred_builder,kb,vb));
                fprintf(stderr,"[cred] added header %s\n", hdrs[hi].name);
            }
        }

        SAFE_CALL("build",cred_opts=(fake_obj_t*)build_opts(env,cred_builder));
        if (cred_opts&&cred_opts->address) {
            uint8_t *cxx=(uint8_t*)(uintptr_t)cred_opts->address;
            if (!cxx[0xa0]) cxx[0xa0]=1;
        }
        /* real_tok intentionally leaked: the credential may reference it */
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

            if (rptrs[1]&&(uintptr_t)rptrs[1]>0x10000) {
                uint8_t *ep=(uint8_t*)rptrs[1];
                uint32_t errval=*(uint32_t*)(ep+0x28);
                fprintf(stderr,"[error] value=0x%x (%u)\n", errval, errval);

                if (errval == 0) {
                    fprintf(stderr,"[SUCCESS] no error — perform() succeeded!\n");
                    /* Dump result struct to understand what was returned */
                    dump_hex("result struct", r, 192);
                    dump_strings("result strings", r, 512);
                } else {
                    void *heap_ptr = *(void **)(ep + 0x18);
                    if (heap_ptr && (uintptr_t)heap_ptr > 0x10000) {
                        fprintf(stderr,"[error] heap_ptr @ +0x18 = %p\n", heap_ptr);
                        dump_hex("error heap_ptr", heap_ptr, 128);
                        dump_strings("error heap_ptr strings", heap_ptr, 512);
                    }
                    dump_hex("error struct (result+0x8)", ep, 192);
                    /* follow every pointer slot in the error struct for domain /
                     * message strings (the Error carries code at +0x28, a second
                     * code at +0x58, and std::string domain/desc via pointers). */
                    for (int _k = 0; _k < 192; _k += 8) {
                        uintptr_t v = *(uintptr_t *)(ep + _k);
                        if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
                        char lbl[40]; snprintf(lbl, sizeof(lbl), "err.*+%02x", _k);
                        safe_dump_strings(lbl, (void *)v, 0x100);
                    }
                    /* and the detail object at +0x18 */
                    for (int _k = 0; _k < 128; _k += 8) {
                        uintptr_t v = *(uintptr_t *)((uint8_t*)heap_ptr + _k);
                        if (v < 0x100000UL || v > 0x00007fffffffffffUL) continue;
                        char lbl[40]; snprintf(lbl, sizeof(lbl), "errdet.*+%02x", _k);
                        safe_dump_strings(lbl, (void *)v, 0x100);
                    }
                }
            }
        }

        fprintf(stderr,"\n[stage21] http_call_count=%d\n", s_http_call_count);
        fprintf(stderr,"[stage21] TRACE vtable slot call counts:\n");
        for (int _i = 0; _i < 32; _i++) {
            if (g_slot_calls[_i])
                fprintf(stderr,"  slot[%2d] = %d calls\n", _i, g_slot_calls[_i]);
        }
        fprintf(stderr,"[stage21] ANISETTE provider slot call counts:\n");
        for (int _i = 0; _i < 32; _i++) {
            if (g_ani_calls[_i])
                fprintf(stderr,"  ani_slot[%2d] = %d calls\n", _i, g_ani_calls[_i]);
        }
        if (g_current_resp) {
            fprintf(stderr,"[stage21] final fake resp @ %p\n", g_current_resp);
        }
    }

    printf("\n[9] sleeping 3s...\n");
    sleep(3);
    printf("=== stage21 done ===\n");
    return 0;
}
