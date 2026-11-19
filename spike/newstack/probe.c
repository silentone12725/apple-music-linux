/* Stage 1 of the 6.5.2 spike: can the new libraries be loaded through the existing libhybris loader, and
 * which entry points do they expose? No network. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include "../../drm/embedded_loader.h"

static int shim_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) { (void)a; (void)b; (void)c; (void)d; return 0; }
static void *shim_memchr_chk(const void *s, int c, size_t n, size_t bs) { (void)bs; return memchr(s, c, n); }
static void *hook(const char *sym, const char *req)
{
    if (!sym) return NULL;
    if (!strcmp(sym, "__register_atfork")) return (void *)shim_atfork;
    if (!strcmp(sym, "__memchr_chk")) return (void *)shim_memchr_chk;

    return NULL;
}

int main(int argc, char **argv)
{
    const char *lib64 = argc > 1 ? argv[1] : "../../drm/rootfs-6.5.2/system/lib64";
    setenv("HYBRIS_LINKER_DIR", "../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", lib64, 1);
    setenv("HYBRIS_ANDROID_LIB64", lib64, 1);
    setenv("ANDROID_ROOT", "/tmp/newstack-root", 0);
    setenv("ANDROID_DATA", "/tmp/newstack-data", 0);
    if (embedded_loader_init() != 0) { fprintf(stderr, "init failed: %s\n", embedded_dlerror()); return 1; }
    embedded_set_hook_callback(hook);
    const char *libs[] = { "libCoreFP.so", "libCoreADI.so", "libCoreLSKD.so", "libFPDIFor3P.so", "libstoreapi.so", "libAMSKit.so", "libandroidappmusic.so", NULL };
    for (int i = 0; libs[i]; i++) {
        void *h = embedded_dlopen(libs[i], RTLD_NOW | RTLD_GLOBAL);
        printf("%-22s %s\n", libs[i], h ? "loaded" : embedded_dlerror());
        fflush(stdout);
    }
    const char *syms[] = {
        "Java_com_apple_android_music_foothill_javanative_FootHillPublic_00024Companion_FairPlayInitContext",
        "Java_com_apple_android_music_foothill_javanative_FootHillPublic_00024Companion_FairPlayLoadLibraryWithPath",
        "Java_com_apple_android_music_foothill_javanative_FootHillPublic_00024Companion_FairPlayGetGUID",
        "Java_com_apple_android_music_foothill_javanative_FootHillPublic_00024Companion_FairPlayGenerateSubscriptionLeaseRequest",
        "Java_com_apple_android_music_foothill_javanative_ADIInterface_00024Companion_ADIProvisioningStart",
        "JNI_OnLoad", NULL };
    for (int i = 0; syms[i]; i++) printf("%-110s %p\n", syms[i], embedded_dlsym(syms[i]));
    return 0;
}
