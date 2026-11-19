/* Stage 2a: drive the 6.5.2 FairPlay C entry points directly (no JNIEnv), local calls only.
 * Obfuscated names come from the JNI wrappers in libstoreapi.so (see NOTES.md). */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>
#include "../../drm/embedded_loader.h"

static int shim_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) { (void)a; (void)b; (void)c; (void)d; return 0; }
static void *shim_memchr_chk(const void *s, int c, size_t n, size_t bs) { (void)bs; return (void *)memchr(s, c, n); }
static void *hook(const char *sym, const char *req) { (void)req; if (!sym) return NULL;
    if (!strcmp(sym, "__register_atfork")) return (void *)shim_atfork;
    if (!strcmp(sym, "__memchr_chk")) return (void *)shim_memchr_chk;
    return NULL; }

typedef int (*fn_path)(const char *);
typedef int (*fn_buf)(const uint8_t *, int);
typedef int (*fn_hw)(void *);
typedef int (*fn_init)(void *, void *, const char *, int *);
typedef int (*fn_sapinit)(void *, void *);
typedef int (*fn_prov)(int64_t);

#define SYM(var, name) do { *(void **)&var = embedded_dlsym(name); printf("%-14s %p\n", name, (void *)var); } while (0)

int main(int argc, char **argv)
{
    const char *lib64 = "../../drm/rootfs-6.5.2/system/lib64";
    const char *dir = argc > 1 ? argv[1] : "/tmp/newstack-data/fp";
    mkdir("/tmp/newstack-data", 0700); mkdir(dir, 0700);
    setenv("HYBRIS_LINKER_DIR", "../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", lib64, 1);
    setenv("HYBRIS_ANDROID_LIB64", lib64, 1);
    setenv("ANDROID_ROOT", "/tmp/newstack-root", 0);
    setenv("ANDROID_DATA", "/tmp/newstack-data", 0);
    if (embedded_loader_init() != 0) { fprintf(stderr, "init: %s\n", embedded_dlerror()); return 1; }
    embedded_set_hook_callback(hook);
    const char *libs[] = { "libCoreFP.so", "libCoreADI.so", "libCoreLSKD.so", "libFPDIFor3P.so", "libstoreapi.so", NULL };
    for (int i = 0; libs[i]; i++) if (!embedded_dlopen(libs[i], RTLD_NOW | RTLD_GLOBAL)) { fprintf(stderr, "%s: %s\n", libs[i], embedded_dlerror()); return 1; }

    fn_path adi_setpath, adi_load, fp_load; fn_buf adi_setid, fp_setid; fn_hw getguid; fn_init initctx; fn_sapinit sapinit; fn_prov adi_isprov;
    SYM(adi_setpath, "nf92ngaK92"); SYM(adi_load, "kq56gsgHG6"); SYM(adi_setid, "Sph98paBcz");
    SYM(fp_setid, "bsawCXd"); SYM(fp_load, "N8jdR29h"); SYM(getguid, "FKgu8fbnvGFG");
    SYM(initctx, "XtCqEf5X"); SYM(sapinit, "cp2g1b9ro"); SYM(adi_isprov, "aslgmuibau");
    if (!adi_setpath || !adi_load || !adi_setid || !fp_setid || !fp_load || !getguid || !initctx || !sapinit) { puts("missing symbol(s)"); return 1; }

    /* A fresh Android ID: this spike must not borrow the identity the working stack uses. */
    uint8_t aid[16]; const char *hex = "0123456789abcdef"; srand(getpid() ^ 0x5eed);
    FILE *f = fopen("/dev/urandom", "rb"); uint8_t r[16]; fread(r, 1, 16, f); fclose(f);
    for (int i = 0; i < 16; i++) aid[i] = (uint8_t)hex[r[i] & 15];
    printf("androidId=%.16s dir=%s\n", aid, dir);

    int rc;
    rc = adi_setpath(dir);            printf("ADISetProvisioningPath     -> %d\n", rc);
    rc = adi_load(dir);               printf("ADILoadLibraryWithPath     -> %d\n", rc);
    rc = adi_setpath(dir);            printf("ADISetProvisioningPath     -> %d\n", rc);
    rc = adi_setid(aid, 16);          printf("ADISetAndroidID            -> %d\n", rc);
    rc = fp_setid(aid, 16);           printf("FairPlaySetAndroidID       -> %d\n", rc);
    rc = fp_load(dir);                printf("FairPlayLoadLibraryWithPath -> %d\n", rc);
    if (adi_isprov) { rc = adi_isprov(-1); printf("ADIIsMachineProvisioned(-1) -> %d\n", rc); }

    uint8_t hw[256]; memset(hw, 0, sizeof hw);
    rc = getguid(hw);                 printf("FairPlayGetGUID            -> %d\n", rc);
    printf("hwinfo[0..48]: "); for (int i = 0; i < 48; i++) printf("%02x", hw[i]); puts("");
    void *sap[8] = {0};
    rc = sapinit(sap, hw);            printf("FairPlaySAPInit            -> %d\n", rc);
    int ctx = -1;
    rc = initctx(NULL, hw, dir, &ctx); printf("FairPlayInitContext        -> %d (ctx=%d)\n", rc, ctx);
    return 0;
}
