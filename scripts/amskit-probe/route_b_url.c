#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <signal.h>
#include <ucontext.h>
#include <unistd.h>

extern void *android_dlopen(const char *, int);
extern void *android_dlsym(void *, const char *);
extern char *android_dlerror(void);
typedef void *(*hook_cb)(const char *sym, const char *requester);
extern void hybris_set_hook_callback(hook_cb);

static void *g_stdin_v, *g_stdout_v, *g_stderr_v;
static int p_register_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) { (void)a; (void)b; (void)c; (void)d; return 0; }
static void *p_memchr_chk(const void *s, int c, size_t n, size_t bos) { (void)bos; return (void *)memchr(s, c, n); }
static int p_log_write(int prio, const char *tag, const char *msg) { fprintf(stderr, "[alog %d] %s: %s\n", prio, tag ? tag : "", msg ? msg : ""); return 0; }
static int p_log_vprint(int prio, const char *tag, const char *fmt, va_list ap) { char b[1024]; vsnprintf(b, sizeof b, fmt, ap); return p_log_write(prio, tag, b); }
static int p_log_print(int prio, const char *tag, const char *fmt, ...) { va_list ap; va_start(ap, fmt); int r = p_log_vprint(prio, tag, fmt, ap); va_end(ap); return r; }
static void *hook(const char *sym, const char *req)
{
    (void)req;
    if (!strcmp(sym, "stdin")) return &g_stdin_v;
    if (!strcmp(sym, "stdout")) return &g_stdout_v;
    if (!strcmp(sym, "stderr")) return &g_stderr_v;
    if (!strcmp(sym, "__register_atfork")) return (void *)p_register_atfork;
    if (!strcmp(sym, "__memchr_chk")) return (void *)p_memchr_chk;
    if (!strcmp(sym, "__android_log_write")) return (void *)p_log_write;
    if (!strcmp(sym, "__android_log_vprint")) return (void *)p_log_vprint;
    if (!strcmp(sym, "__android_log_print")) return (void *)p_log_print;
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


/* ---- host implementation of AMSCore::IBundleInfo (14 vtable slots; 2,4,7,10 are pure virtual) ---- */
static void put_str(void *ret, const char *v)            /* libc++ (NDK) short std::string */
{ unsigned char *r = ret; memset(r, 0, 24); size_t n = strlen(v); r[0] = (unsigned char)(n << 1); memcpy(r + 1, v, n); }
static void bi_dtor(void *self) { (void)self; }
static void bi_dtor_del(void *self) { (void)self; }
static void bi_s2(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot2 called\n"); put_str(ret, "musicAndroid"); }
static void bi_s4(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot4 called\n"); put_str(ret, "Music"); }
static void bi_s7(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot7 called\n"); put_str(ret, "6.5.2"); }
static void bi_s10(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot10 called\n"); put_str(ret, "musicAndroid"); }
typedef struct { void *obj; void *ctrl; } sp_t;
#define SYM(n) android_dlsym(h, n)

int main(void)
{
    struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_sigaction = crash; sa.sa_flags = SA_SIGINFO; sigaction(SIGSEGV, &sa, NULL); sigaction(SIGABRT, &sa, NULL); sigaction(SIGILL, &sa, NULL);
    const char *res = "/home/daksh/Git Projects/apple-music-linux/electron/dist/resources";
    const char *lib = "/home/daksh/Git Projects/apple-music-linux/drm/rootfs-6.5.2/system/lib64";
    char p[512]; snprintf(p, sizeof p, "%s/hybris-linker", res);
    setenv("HYBRIS_LINKER_DIR", p, 1); setenv("HYBRIS_LD_LIBRARY_PATH", lib, 1); setenv("HYBRIS_ANDROID_LIB64", lib, 1);
    setenv("ANDROID_ROOT", "/tmp/amskit-probe", 0); setenv("ANDROID_DATA", "/tmp/amskit-probe/data", 0);
    setvbuf(stdout, NULL, _IONBF, 0);
    g_stdin_v = stdin; g_stdout_v = stdout; g_stderr_v = stderr;
    hybris_set_hook_callback(hook);

    void *h = android_dlopen("libAMSKit.so", 2);
    if (!h) { printf("[probe] load failed: %s\n", android_dlerror()); return 1; }
    printf("[probe] libAMSKit loaded\n");

    void (*bundle_default)(sp_t *) = (void (*)(sp_t *))SYM("_ZN7AMSCore11IBundleInfo11makeDefaultEv");
    void (*session_ctor)(void *, sp_t *) = (void (*)(void *, sp_t *))SYM("_ZN7AMSCore7SessionC1ENSt6__ndk110shared_ptrINS_11IBundleInfoEEE");
    void (*session_defaults)(void *ret, void *self) = (void (*)(void *, void *))SYM("_ZN7AMSCore7Session12makeDefaultsEv");
    printf("[probe] bundle_default=%p session_ctor=%p session_defaults=%p\n", (void *)bundle_default, (void *)session_ctor, (void *)session_defaults);

    typedef void (*parse_t)(void *ret, const void *str, long opts);
    typedef void (*lastpc_t)(void *ret, const void *url);
    parse_t parse = (parse_t)SYM("_ZN7AMSCore3URL5parseERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEENS0_12ParseOptionsE");
    if (!parse) { /* find the exact mangled name */ printf("[probe] URL::parse symbol not found by guessed name\n"); return 1; }
    lastpc_t lastpc = (lastpc_t)SYM("_ZNK7AMSCore3URL20getLastPathComponentEv");
    unsigned char s[24] = {0}; const char *u = "https://auth.itunes.apple.com/auth/v1/native"; size_t n = strlen(u);
    if (n < 23) { s[0] = (unsigned char)(n << 1); memcpy(s + 1, u, n); }
    else { char *h = malloc(n + 1); memcpy(h, u, n + 1); *(size_t *)s = 48 | 1; *(size_t *)(s + 8) = n; *(char **)(s + 16) = h; }   /* libc++ long string */
    unsigned char *ret = calloc(1, 1024);
    parse(ret, s, 0);
    printf("[probe] URL::parse returned; first 96 bytes:\n"); for (int i = 0; i < 96; i++) printf("%s%02x", i % 16 ? " " : "   ", ret[i]); printf("\n");
    unsigned char *out = calloc(1, 64);
    if (lastpc) { lastpc(out, ret); size_t len = (out[0] & 1) ? *(size_t *)(out + 8) : out[0] >> 1; const char *t = (out[0] & 1) ? *(char **)(out + 16) : (char *)(out + 1);
                  printf("[probe] getLastPathComponent = \"%.*s\" (len %zu)\n", (int)len, t, len); }
    printf("[probe] done\n");
    return 0;
}
