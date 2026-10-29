/*
 * adam_curl_capture.c - opt-in request/response sequence capture for the Linux build.
 *
 * Preloaded into the engine (LD_PRELOAD), it registers a libhybris hook callback that routes libmediaplatform's
 * libcurl calls through thin wrappers. Nothing changes unless ADAM_CURL_BODY is set. It writes, to stderr and to
 * $ADAM_CURL_LOG (default /tmp/adam-curl-seq.log, mode 0600):
 *   - one line per request: URL without its query string, method, request header NAMES (never values),
 *   - perform result and HTTP status, with milliseconds since the first line,
 *   - the start of /auth/ response bodies, with token-like runs, long digit runs and e-mail addresses masked.
 * The guest still receives every byte unchanged.
 *
 * Build: scripts/curl-capture/build.sh
 */
#define _GNU_SOURCE
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>
#include <pthread.h>

#include <dlfcn.h>
typedef void *(*hybris_hook_cb)(const char *sym, const char *requester);
/* Resolved at run time from the engine's libhybris-core.so, so this library has no dependency on it and does nothing
 * in any other process (Electron's own processes load it too when LD_PRELOAD is inherited). */
static void (*hybris_set_hook_callback)(hybris_hook_cb cb);
static void *(*android_dlopen)(const char *name, int flags);
static void *(*android_dlsym)(void *handle, const char *sym);

typedef size_t (*write_cb_t)(char *, size_t, size_t, void *);
struct slot { void *h; int used; write_cb_t cb; void *ud; int capture; unsigned captured; char url[160]; };
struct slist { char *data; struct slist *next; };

static struct slot g_slots[128];
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static struct timespec g_t0;
static FILE *g_log;

static long long ms_since_start(void)
{
    struct timespec n; clock_gettime(CLOCK_MONOTONIC, &n);
    if (!g_t0.tv_sec && !g_t0.tv_nsec) g_t0 = n;
    return (long long)(n.tv_sec - g_t0.tv_sec) * 1000 + (n.tv_nsec - g_t0.tv_nsec) / 1000000;
}

static void seq(const char *fmt, ...)
{
    char line[2200]; va_list ap;
    pthread_mutex_lock(&g_mu);
    int n = snprintf(line, sizeof line, "[curl-seq] +%lldms ", ms_since_start());
    va_start(ap, fmt); vsnprintf(line + n, sizeof line - n, fmt, ap); va_end(ap);
    fprintf(stderr, "%s\n", line); fflush(stderr);
    if (g_log) { fprintf(g_log, "%s\n", line); fflush(g_log); }
    pthread_mutex_unlock(&g_mu);
}

static struct slot *slot_for(void *h)
{
    struct slot *r = NULL;
    pthread_mutex_lock(&g_mu);
    for (int i = 0; i < 128; i++) if (g_slots[i].used && g_slots[i].h == h) { r = &g_slots[i]; break; }
    if (!r) for (int i = 0; i < 128; i++) if (!g_slots[i].used) { memset(&g_slots[i], 0, sizeof g_slots[i]); g_slots[i].used = 1; g_slots[i].h = h; r = &g_slots[i]; break; }
    pthread_mutex_unlock(&g_mu);
    return r;
}

static int tokenchar(unsigned char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/' || c == '=' || c == '_' || c == '-' || c == '.';
}

static void redact_print(const char *url, const unsigned char *p, size_t n)
{
    char out[1800]; size_t o = 0;
    for (size_t i = 0; i < n && o + 40 < sizeof out; ) {
        unsigned char c = p[i];
        if (c == '\r' || c == '\n' || c == '\t') { out[o++] = ' '; i++; continue; }
        if (c < 0x20 || c > 0x7e) { out[o++] = '?'; i++; continue; }
        if (tokenchar(c)) {
            size_t j = i; int digits = 1, at = 0;
            while (j < n && (tokenchar(p[j]) || p[j] == '@')) { if (p[j] < '0' || p[j] > '9') digits = 0; if (p[j] == '@') at = 1; j++; }
            size_t len = j - i;
            if (at) { o += snprintf(out + o, sizeof out - o, "[email]"); i = j; continue; }
            if (len >= 20 || (digits && len >= 8)) { o += snprintf(out + o, sizeof out - o, "[REDACTED:%zu]", len); i = j; continue; }
            memcpy(out + o, p + i, len); o += len; i = j; continue;
        }
        out[o++] = (char)c; i++;
    }
    out[o] = 0;
    seq("[body] %s :: %s", url, out);
}

static size_t write_wrapper(char *ptr, size_t sz, size_t n, void *ctx)
{
    struct slot *sl = ctx;
    if (sl->capture && sl->captured < 1500 && ptr) {
        size_t len = sz * n; if (len > 1500 - sl->captured) len = 1500 - sl->captured;
        redact_print(sl->url, (const unsigned char *)ptr, len);
        sl->captured += (unsigned)len;
    }
    return sl->cb ? sl->cb(ptr, sz, n, sl->ud) : sz * n;
}

static void *real_fn(const char *name)
{
    static void *h;
    if (!h) h = android_dlopen("libcurl.so", 2);
    return h ? android_dlsym(h, name) : NULL;
}

static void header_names(void *h, void *list)
{
    char names[600]; size_t n = 0; int count = 0;
    for (struct slist *e = list; e && count < 40 && n < sizeof names - 80; e = e->next, count++) {
        if (!e->data || (unsigned long)e->data < 0x10000) break;
        size_t k = 0; while (e->data[k] && e->data[k] != ':' && k < 60) k++;
        n += snprintf(names + n, sizeof names - n, "%s%.*s", count ? "," : "", (int)k, e->data);
    }
    seq("h=%p request-header-names=[%s]", h, names);
}

typedef long (*f3_t)(void *, long, long);
typedef long (*f1_t)(void *);
typedef const char *(*fstr_t)(long);

static long w_setopt(void *h, long opt, long arg)
{
    static f3_t real;
    if (!real) real = (f3_t)real_fn("curl_easy_setopt");
    if (opt == 10002 && arg) {
        char u[160]; snprintf(u, sizeof u, "%.150s", (const char *)arg);
        char *q = strchr(u, '?'); if (q) *q = 0;                  /* never log query strings */
        seq("h=%p URL %s", h, u);
        struct slot *sl = slot_for(h);
        if (sl) { snprintf(sl->url, sizeof sl->url, "%s", u); sl->capture = strstr(u, "/auth/") != NULL; sl->captured = 0; }
    } else if (opt == 47) seq("h=%p POST=%ld", h, arg);
    else if (opt == 60 || opt == 30) seq("h=%p POSTFIELDSIZE=%ld", h, arg);
    else if (opt == 10036 && arg) seq("h=%p CUSTOMREQUEST %.20s", h, (const char *)arg);
    else if (opt == 10023 && arg) header_names(h, (void *)arg);
    else if (opt == 20011) {
        struct slot *sl = slot_for(h);
        if (sl) { sl->cb = (write_cb_t)arg; arg = (long)write_wrapper; if (real) real(h, 10001, (long)sl); }
    } else if (opt == 10001) {
        struct slot *sl = slot_for(h);
        if (sl) { sl->ud = (void *)arg; arg = (long)sl; }
    }
    return real ? real(h, opt, arg) : 48;
}

static long w_perform(void *h)
{
    static f1_t real; static fstr_t serr;
    if (!real) real = (f1_t)real_fn("curl_easy_perform");
    if (!serr) serr = (fstr_t)real_fn("curl_easy_strerror");
    seq("h=%p perform start", h);
    long r = real ? real(h) : 2;
    seq("h=%p perform done rc=%ld (%s)", h, r, serr ? serr(r) : "?");
    return r;
}

static long w_getinfo(void *h, long info, long arg)
{
    static f3_t real;
    if (!real) real = (f3_t)real_fn("curl_easy_getinfo");
    long r = real ? real(h, info, arg) : 2;
    if (info == 0x200002 && arg) seq("h=%p HTTP status %ld", h, *(long *)arg);
    return r;
}

static void *hook(const char *sym, const char *requester)
{
    if (!sym || !requester || sym[0] != 'c' || strncmp(sym, "curl_easy_", 10) != 0) return NULL;
    if (!strstr(requester, "libmediaplatform")) return NULL;
    if (!strcmp(sym, "curl_easy_setopt")) return (void *)w_setopt;
    if (!strcmp(sym, "curl_easy_perform")) return (void *)w_perform;
    if (!strcmp(sym, "curl_easy_getinfo")) return (void *)w_getinfo;
    return NULL;
}

__attribute__((constructor)) static void adam_curl_capture_init(void)
{
    if (!getenv("ADAM_CURL_BODY")) return;
    char exe[256]; ssize_t n = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (n <= 0) return;
    exe[n] = 0;
    const char *base = strrchr(exe, '/'); base = base ? base + 1 : exe;
    if (strcmp(base, "engine") != 0) return;                      /* only the engine process */
    hybris_set_hook_callback = dlsym(RTLD_DEFAULT, "hybris_set_hook_callback");
    android_dlopen = dlsym(RTLD_DEFAULT, "android_dlopen");
    android_dlsym = dlsym(RTLD_DEFAULT, "android_dlsym");
    if (!hybris_set_hook_callback || !android_dlopen || !android_dlsym) {
        fprintf(stderr, "[curl-seq] capture NOT active: libhybris-core symbols not found\n");
        return;
    }
    const char *path = getenv("ADAM_CURL_LOG");
    int fd = open(path ? path : "/tmp/adam-curl-seq.log", O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (fd >= 0) g_log = fdopen(fd, "a");
    hybris_set_hook_callback(hook);
    fprintf(stderr, "[curl-seq] capture active\n");
}
