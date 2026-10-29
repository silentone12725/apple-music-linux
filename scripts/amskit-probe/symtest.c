#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
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
int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    const char *lib = argv[1];
    const char *res = "/home/daksh/Git Projects/apple-music-linux/electron/dist/resources";
    const char *dir = "/home/daksh/Git Projects/apple-music-linux/drm/rootfs-6.5.2/system/lib64";
    char p[512]; snprintf(p, sizeof p, "%s/hybris-linker", res);
    setenv("HYBRIS_LINKER_DIR", p, 1); setenv("HYBRIS_LD_LIBRARY_PATH", dir, 1); setenv("HYBRIS_ANDROID_LIB64", dir, 1);
    setenv("ANDROID_ROOT", "/tmp/amskit-probe", 0); setenv("ANDROID_DATA", "/tmp/amskit-probe/data", 0);
    g_in = stdin; g_out = stdout; g_err = stderr; hybris_set_hook_callback(hook);
    void *h = android_dlopen(lib, 2);
    if (!h) { printf("%s LOAD_FAIL %s\n", lib, android_dlerror()); return 1; }
    /* mapped ranges of this library */
    unsigned long lo[64], hi[64]; int nr = 0; char line[1024];
    FILE *m = fopen("/proc/self/maps", "r");
    while (m && fgets(line, sizeof line, m) && nr < 64) { if (strstr(line, lib) && strstr(line, "/rootfs-6.5.2/")) { unsigned long a, b; if (sscanf(line, "%lx-%lx", &a, &b) == 2) { lo[nr] = a; hi[nr] = b; nr++; } } }
    if (m) fclose(m);
    char path[600]; snprintf(path, sizeof path, "/tmp/amskit-probe/syms/%s.txt", lib);
    FILE *f = fopen(path, "r"); if (!f) { printf("%s NO_SYMLIST\n", lib); return 1; }
    long total = 0, ok = 0, null = 0, outside = 0; char name[4096]; int shown = 0;
    while (fgets(name, sizeof name, f)) {
        name[strcspn(name, "\n")] = 0; if (!name[0]) continue; total++;
        void *a = android_dlsym(h, name);
        if (!a) { null++; if (shown++ < 3) printf("  NULL %s\n", name); continue; }
        int in = 0; for (int i = 0; i < nr; i++) if ((unsigned long)a >= lo[i] && (unsigned long)a < hi[i]) in = 1;
        if (in) ok++; else { outside++; if (shown++ < 3) printf("  OUTSIDE %s -> %p\n", name, a); }
    }
    printf("%-26s exports=%-6ld resolved_in_lib=%-6ld null=%-4ld outside=%-4ld ranges=%d\n", lib, total, ok, null, outside, nr);
    return 0;
}
