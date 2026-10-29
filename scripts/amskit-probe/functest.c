#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <math.h>
#include <unistd.h>
#include <sys/wait.h>
extern void *android_dlopen(const char *, int);
extern void *android_dlsym(void *, const char *);
extern char *android_dlerror(void);
typedef void *(*hook_cb)(const char *, const char *);
extern void hybris_set_hook_callback(hook_cb);
static void *g_in, *g_out, *g_err;
static int p_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) { (void)a;(void)b;(void)c;(void)d; return 0; }
static void *p_memchr_chk(const void *s, int c, size_t n, size_t b) { (void)b; return (void *)memchr(s, c, n); }
static int p_logw(int p, const char *t, const char *m) { (void)p;(void)t;(void)m; return 0; }
static int p_logv(int p, const char *t, const char *f, va_list ap) { (void)p;(void)t;(void)f;(void)ap; return 0; }
static void *hook(const char *s, const char *r)
{
    (void)r;
    if (!strcmp(s, "stdin")) return &g_in; if (!strcmp(s, "stdout")) return &g_out; if (!strcmp(s, "stderr")) return &g_err;
    if (!strcmp(s, "__register_atfork")) return (void *)p_atfork;
    if (!strcmp(s, "__memchr_chk")) return (void *)p_memchr_chk;
    if (!strcmp(s, "__android_log_write")) return (void *)p_logw;
    if (!strcmp(s, "__android_log_vprint")) return (void *)p_logv;
    return NULL;
}
static void *L(const char *lib) { void *h = android_dlopen(lib, 2); if (!h) { printf("  cannot load %s: %s\n", lib, android_dlerror()); exit(3); } return h; }
#define F(h, name, type) ((type)android_dlsym((h), (name)))
#define CHECK(c, what) do { if (!(c)) { printf("  FAIL: %s\n", what); return 1; } } while (0)

static int t_zlib(void)
{
    void *h = L("libz.so");
    const char *(*ver)(void) = F(h, "zlibVersion", const char *(*)(void));
    unsigned long (*crc)(unsigned long, const unsigned char *, unsigned) = F(h, "crc32", unsigned long (*)(unsigned long, const unsigned char *, unsigned));
    unsigned long (*bound)(unsigned long) = F(h, "compressBound", unsigned long (*)(unsigned long));
    int (*comp)(unsigned char *, unsigned long *, const unsigned char *, unsigned long) = F(h, "compress", int (*)(unsigned char *, unsigned long *, const unsigned char *, unsigned long));
    int (*uncomp)(unsigned char *, unsigned long *, const unsigned char *, unsigned long) = F(h, "uncompress", int (*)(unsigned char *, unsigned long *, const unsigned char *, unsigned long));
    printf("  zlibVersion=%s\n", ver());
    CHECK(crc(0, (const unsigned char *)"123456789", 9) == 0xCBF43926UL, "crc32(\"123456789\") == 0xCBF43926");
    const char *msg = "Apple Music 6.5.2 zlib round trip. "; unsigned long n = strlen(msg), cl = bound(n);
    unsigned char *c = malloc(cl), *u = malloc(n + 1); unsigned long ul = n;
    CHECK(comp(c, &cl, (const unsigned char *)msg, n) == 0, "compress");
    CHECK(uncomp(u, &ul, c, cl) == 0 && ul == n && !memcmp(u, msg, n), "uncompress restores the input");
    return 0;
}
static int t_xml2(void)
{
    void *h = L("libxml2.so");
    void *(*parse)(const char *, int) = F(h, "xmlParseMemory", void *(*)(const char *, int));
    void *(*root)(void *) = F(h, "xmlDocGetRootElement", void *(*)(void *));
    void (*freedoc)(void *) = F(h, "xmlFreeDoc", void (*)(void *));
    const char *xml = "<auth><dialog id=\"code\"/></auth>";
    void *doc = parse(xml, (int)strlen(xml)); CHECK(doc, "xmlParseMemory returned a document");
    unsigned char *node = root(doc); CHECK(node, "root element");
    const char *name = *(const char **)(node + 16); printf("  root element = <%s>\n", name);
    CHECK(!strcmp(name, "auth"), "root element name is auth"); freedoc(doc); return 0;
}
static int t_cf(void)
{
    void *h = L("libCoreFoundation.so");
    void *(*mk)(void *, const char *, unsigned) = F(h, "CFStringCreateWithCString", void *(*)(void *, const char *, unsigned));
    long (*len)(void *) = F(h, "CFStringGetLength", long (*)(void *));
    int (*get)(void *, char *, long, unsigned) = F(h, "CFStringGetCString", int (*)(void *, char *, long, unsigned));
    void (*rel)(void *) = F(h, "CFRelease", void (*)(void *));
    void *s = mk(NULL, "verification code", 0x08000100); CHECK(s, "CFStringCreateWithCString");
    char buf[64] = {0}; printf("  CFString length=%ld\n", len(s));
    CHECK(len(s) == 17, "CFStringGetLength == 17"); CHECK(get(s, buf, sizeof buf, 0x08000100) && !strcmp(buf, "verification code"), "CFStringGetCString round trip");
    rel(s); return 0;
}
static int t_dispatch(void)
{
    void *h = L("libdispatch.so");
    void *(*mk)(long) = F(h, "dispatch_semaphore_create", void *(*)(long));
    long (*sig)(void *) = F(h, "dispatch_semaphore_signal", long (*)(void *));
    long (*wait)(void *, unsigned long long) = F(h, "dispatch_semaphore_wait", long (*)(void *, unsigned long long));
    void *s = mk(0); CHECK(s, "dispatch_semaphore_create");
    CHECK(wait(s, 0) != 0, "wait on an empty semaphore times out"); sig(s); CHECK(wait(s, 0) == 0, "wait after signal succeeds"); return 0;
}
static int t_icu(void)
{
    void *h = L("libicuuc_sv_apple.so");
    int (*slen)(const unsigned short *) = F(h, "u_strlen", int (*)(const unsigned short *));
    int (*isal)(int) = F(h, "u_isalpha", int (*)(int));
    int (*up)(int) = F(h, "u_toupper", int (*)(int));
    const unsigned short s[] = { 'c', 'o', 'd', 'e', 0 };
    CHECK(slen(s) == 4, "u_strlen"); CHECK(isal('a') && !isal('3'), "u_isalpha"); CHECK(up('a') == 'A', "u_toupper"); return 0;
}
static int t_libm(void)
{
    void *h = L("libm.so");
    double (*sq)(double) = F(h, "sqrt", double (*)(double)); double (*pw)(double, double) = F(h, "pow", double (*)(double, double));
    CHECK(sq(144.0) == 12.0, "sqrt(144)"); CHECK(pw(2.0, 10.0) == 1024.0, "pow(2,10)"); return 0;
}
static int t_amskit(void)
{
    void *h = L("libAMSKit.so");
    typedef void (*ctor_t)(void *, const char *, size_t, int, void *); typedef const unsigned char *(*get_t)(const void *);
    ctor_t ctor = F(h, "_ZN7AMSCore12DialogActionC1ENSt6__ndk117basic_string_viewIcNS1_11char_traitsIcEEEENS0_5StyleENS1_12basic_stringIcS4_NS1_9allocatorIcEEEE", ctor_t);
    get_t gt = F(h, "_ZNK7AMSCore12DialogAction8getTitleEv", get_t);
    unsigned char *o = calloc(1, 4096), id[24] = {0}; id[0] = 4 << 1; memcpy(id + 1, "code", 4);
    ctor(o, "Resend", 6, 0, id); const unsigned char *r = gt(o);
    size_t n = (r[0] & 1) ? *(const size_t *)(r + 8) : (size_t)(r[0] >> 1); const char *t = (r[0] & 1) ? *(const char *const *)(r + 16) : (const char *)(r + 1);
    printf("  DialogAction title=\"%.*s\"\n", (int)n, t); CHECK(n == 6 && !memcmp(t, "Resend", 6), "DialogAction title round trip"); return 0;
}
static int t_cxx(void)
{
    void *h = L("libc++_shared.so");
    void *(*newp)(size_t) = F(h, "_Znwm", void *(*)(size_t)); void (*del)(void *) = F(h, "_ZdlPv", void (*)(void *));
    char *p = newp(64); CHECK(p, "operator new"); strcpy(p, "ok"); CHECK(!strcmp(p, "ok"), "write/read"); del(p); return 0;
}
struct T { const char *name; int (*fn)(void); } tests[] = {
    { "libz: version, crc32, compress/uncompress", t_zlib }, { "libxml2: parse a document, read the root", t_xml2 },
    { "libCoreFoundation: CFString create/length/get", t_cf }, { "libdispatch: semaphore signal/wait", t_dispatch },
    { "libicuuc: u_strlen/u_isalpha/u_toupper", t_icu }, { "libm: sqrt, pow", t_libm },
    { "libc++_shared: operator new/delete", t_cxx }, { "libAMSKit: DialogAction round trip", t_amskit }, { NULL, NULL } };

int main(void)
{
    const char *res = "/home/daksh/Git Projects/apple-music-linux/electron/dist/resources";
    const char *dir = "/home/daksh/Git Projects/apple-music-linux/drm/rootfs-6.5.2/system/lib64";
    char p[512]; snprintf(p, sizeof p, "%s/hybris-linker", res);
    setenv("HYBRIS_LINKER_DIR", p, 1); setenv("HYBRIS_LD_LIBRARY_PATH", dir, 1); setenv("HYBRIS_ANDROID_LIB64", dir, 1);
    setenv("ANDROID_ROOT", "/tmp/amskit-probe", 0); setenv("ANDROID_DATA", "/tmp/amskit-probe/data", 0);
    setvbuf(stdout, NULL, _IONBF, 0);
    g_in = stdin; g_out = stdout; g_err = stderr; hybris_set_hook_callback(hook);
    int pass = 0, fail = 0;
    for (int i = 0; tests[i].name; i++) {
        printf("[%d] %s\n", i + 1, tests[i].name);
        pid_t c = fork();
        if (c == 0) { alarm(60); _exit(tests[i].fn()); }
        int st = 0; waitpid(c, &st, 0);
        if (WIFEXITED(st) && WEXITSTATUS(st) == 0) { printf("    PASS\n"); pass++; }
        else { if (WIFSIGNALED(st)) printf("    FAIL (signal %d)\n", WTERMSIG(st)); else printf("    FAIL (exit %d)\n", WEXITSTATUS(st)); fail++; }
    }
    printf("\nfunctional: %d passed, %d failed\n", pass, fail);
    return fail ? 1 : 0;
}
