/*
 * stage7_prov_test.c — Test ADIProvisioningStart with NULL spim on OLD stack
 * and 6.5.2 stack to see if it generates an initial client challenge.
 *
 * Usage: ./stage7_prov_test [dir] [dsid]
 * dir = provisioning dir (fresh empty dir OK)
 * dsid = account DSID (0 = fresh/no account)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
#include "../../drm/embedded_loader.h"

typedef int (*fn_path)(const char *);
typedef int (*fn_buf)(const uint8_t *, int);
typedef int (*fn_check)(int64_t);
typedef int (*fn_prov_start)(int64_t, const uint8_t *, int, uint8_t **, int *, uint64_t *);
typedef int (*fn_prov_end)(uint64_t, const uint8_t *, int, const uint8_t *, int);
typedef int (*fn_otp)(int64_t, uint8_t **, int *, uint8_t **, int *);

static int shim_atfork(void(*a)(void),void(*b)(void),void(*c)(void),void*d){(void)a;(void)b;(void)c;(void)d;return 0;}
static void *shim_memchr_chk(const void *s,int c,size_t n,size_t bs){(void)bs;return(void*)memchr(s,c,n);}
static void *hook(const char *sym,const char *req){
    (void)req;
    if(!sym) return NULL;
    if(!strcmp(sym,"__register_atfork")) return (void*)shim_atfork;
    if(!strcmp(sym,"__memchr_chk"))      return (void*)shim_memchr_chk;
    return NULL;
}

static void hexdump(const uint8_t *d, int len, const char *label) {
    printf("%s (%d bytes):\n", label, len);
    for (int i = 0; i < len && i < 128; i++) {
        if (i && i%16==0) printf("\n");
        printf("%02x ", d[i]);
    }
    printf("\n");
}

static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64enc(const uint8_t *in, int len, char *out) {
    int i=0,o=0;
    for(;i+2<len;i+=3){out[o++]=b64[(in[i]>>2)&63];out[o++]=b64[((in[i]&3)<<4)|((in[i+1]>>4)&15)];out[o++]=b64[((in[i+1]&15)<<2)|((in[i+2]>>6)&3)];out[o++]=b64[in[i+2]&63];}
    if(i<len){out[o++]=b64[(in[i]>>2)&63];if(i+1<len){out[o++]=b64[((in[i]&3)<<4)|((in[i+1]>>4)&15)];out[o++]=b64[((in[i+1]&15)<<2)];}else{out[o++]=b64[(in[i]&3)<<4];out[o++]='=';}out[o++]='=';}
    out[o]='\0';
}

int main(int argc, char **argv)
{
    const char *dir  = argc > 1 ? argv[1] : "/tmp/stage7-fresh";
    int64_t    dsid  = argc > 2 ? atoll(argv[2]) : 0LL;
    int        use65 = argc > 3 && !strcmp(argv[3], "6.5.2");

    /* Ensure dir and mpl_db exist */
    mkdir(dir, 0755);
    char mpl[512]; snprintf(mpl, sizeof mpl, "%s/mpl_db", dir);
    mkdir(mpl, 0755);

    printf("[stage7] dir=%s  dsid=%lld  stack=%s\n", dir, (long long)dsid, use65 ? "6.5.2 libstoreapi" : "old libstoreservicescore");

    const char *lib64_old = "../../drm/rootfs/system/lib64";
    const char *lib64_652 = "../../drm/rootfs-6.5.2/system/lib64";
    const char *lib64 = use65 ? lib64_652 : lib64_old;

    setenv("HYBRIS_LINKER_DIR",     "../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", lib64, 1);
    setenv("HYBRIS_ANDROID_LIB64",   lib64, 1);
    setenv("ANDROID_ROOT", "/tmp/s7-root", 0);
    setenv("ANDROID_DATA", "/tmp/s7-data", 0);

    if (embedded_loader_init() != 0) {
        fprintf(stderr, "embedded_loader_init: %s\n", embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    printf("Loading libraries...\n");
    const char *libs_old[] = { "libCoreFP.so", "libCoreADI.so", "libstoreservicescore.so", NULL };
    const char *libs_652[] = { "libCoreFP.so", "libCoreADI.so", "libCoreLSKD.so",
                                "libFPDIFor3P.so", "libstoreapi.so", NULL };
    const char **libs = use65 ? libs_652 : libs_old;
    for (int i = 0; libs[i]; i++) {
        if (!embedded_dlopen(libs[i], RTLD_NOW | RTLD_GLOBAL)) {
            fprintf(stderr, "  %s: %s\n", libs[i], embedded_dlerror()); return 1;
        }
        printf("  %s ok\n", libs[i]);
    }

    fn_path   adi_setpath = NULL, adi_load = NULL;
    fn_buf    adi_setid   = NULL;
    fn_check  adi_isprov  = NULL;
    fn_prov_start adi_start = NULL;
    fn_prov_end   adi_end   = NULL;
    fn_otp        adi_otp   = NULL;

    *(void**)&adi_setpath = embedded_dlsym("nf92ngaK92");
    *(void**)&adi_load    = embedded_dlsym("kq56gsgHG6");
    *(void**)&adi_setid   = embedded_dlsym("Sph98paBcz");
    *(void**)&adi_isprov  = embedded_dlsym("aslgmuibau");
    *(void**)&adi_start   = embedded_dlsym("rsegvyrt87");
    *(void**)&adi_end     = embedded_dlsym("uv5t6nhkui");
    *(void**)&adi_otp     = embedded_dlsym("qi864985u0");

    if (!adi_setpath || !adi_load || !adi_start || !adi_end) {
        fprintf(stderr, "Missing required ADI symbols\n"); return 1;
    }
    printf("Symbols resolved: setpath=%p load=%p isprov=%p start=%p end=%p otp=%p\n",
           (void*)adi_setpath, (void*)adi_load, (void*)adi_isprov,
           (void*)adi_start, (void*)adi_end, (void*)adi_otp);

    /* Init ADI */
    int rc;
    rc = adi_setpath(dir);  printf("ADISetProvisioningPath(%s) -> %d\n", dir, rc);
    rc = adi_load(dir);     printf("ADILoadLibraryWithPath(%s) -> %d\n", dir, rc);
    rc = adi_setpath(dir);  printf("ADISetProvisioningPath     -> %d (second call)\n", rc);

    /* Generate fresh Android ID for the fresh stack */
    uint8_t aid[8];
    char did_path[512]; snprintf(did_path, sizeof did_path, "%s/device-id", dir);
    char hex_id[20] = {};
    FILE *f = fopen(did_path, "rb");
    if (f) {
        fread(hex_id, 1, 16, f); fclose(f);
        printf("Android ID (existing): %.16s\n", hex_id);
    } else {
        FILE *ur = fopen("/dev/urandom", "rb");
        if (ur) { fread(aid, 1, 8, ur); fclose(ur); }
        snprintf(hex_id, 17, "%02x%02x%02x%02x%02x%02x%02x%02x",
                 aid[0],aid[1],aid[2],aid[3],aid[4],aid[5],aid[6],aid[7]);
        f = fopen(did_path, "wb");
        if (f) { fprintf(f, "%s\n", hex_id); fclose(f); }
        printf("Android ID (fresh): %.16s\n", hex_id);
    }
    /* Decode hex to binary */
    uint8_t bin_id[8];
    for (int i = 0; i < 8; i++) {
        int hi = hex_id[2*i]; int lo = hex_id[2*i+1];
        hi = (hi>='a')?(hi-'a'+10):(hi>='A')?(hi-'A'+10):(hi-'0');
        lo = (lo>='a')?(lo-'a'+10):(lo>='A')?(lo-'A'+10):(lo-'0');
        bin_id[i] = (uint8_t)((hi<<4)|lo);
    }
    if (adi_setid) {
        /* try both formats — 16 ASCII hex bytes first (as stage4 did), then 8 binary */
        rc = adi_setid((uint8_t*)hex_id, 16);
        printf("ADISetAndroidID(16-byte ASCII hex) -> %d\n", rc);
        if (rc != 0) {
            rc = adi_setid(bin_id, 8);
            printf("ADISetAndroidID(8-byte binary)     -> %d\n", rc);
        }
    }

    /* Check provisioning status */
    if (adi_isprov) {
        rc = adi_isprov(dsid);
        printf("ADIIsMachineProvisioned(%lld) -> %d  (%s)\n",
               (long long)dsid, rc,
               rc==0 ? "PROVISIONED" : rc==-45061 ? "not provisioned" : "other error");
    }

    /* THE KEY TEST: call ADIProvisioningStart with NULL spim */
    printf("\n--- ADIProvisioningStart(dsid=%lld, NULL, 0) ---\n", (long long)dsid);
    uint8_t *cpim = NULL;
    int cpim_len  = 0;
    uint64_t session = 0;

    rc = adi_start(dsid, NULL, 0, &cpim, &cpim_len, &session);
    printf("rc=%d  cpim=%p  cpim_len=%d  session=%llu\n",
           rc, (void*)cpim, cpim_len, (unsigned long long)session);

    if (rc == 0 && cpim && cpim_len > 0) {
        hexdump(cpim, cpim_len, "CPIM (initial client challenge)");
        char cpim_b64[4096];
        b64enc(cpim, cpim_len, cpim_b64);
        printf("cpim_b64 = %s\n\n", cpim_b64);

        /* Save cpim for the network call */
        char cpim_path[512]; snprintf(cpim_path, sizeof cpim_path, "%s/cpim_initial.bin", dir);
        FILE *cf = fopen(cpim_path, "wb");
        if (cf) { fwrite(cpim, 1, cpim_len, cf); fclose(cf); printf("Saved to %s\n", cpim_path); }

        /* Show curl command to POST cpim to amd-sync-machine */
        printf("\ncurl command to get SPIM:\n");
        printf("curl -s -X POST \\\n");
        printf("  'https://auth.itunes.apple.com/auth/v1/otp/1.5/sync' \\\n");
        printf("  -H 'Content-Type: application/x-www-form-urlencoded' \\\n");
        printf("  --data-binary @%s \\\n", cpim_path);
        printf("  -o %s/spim.bin -w '%%{http_code}'\n\n", dir);
        printf("Then run: ./stage7_prov_test %s %lld %s continue\n",
               dir, (long long)dsid, use65 ? "6.5.2" : "old");
    } else {
        printf("ADIProvisioningStart returned error — cannot generate initial challenge\n");
        printf("Error code: 0x%x (%d)\n", rc, rc);
    }

    /* If a spim.bin exists, do stage2: ADIProvisioningStart(dsid, spim, spimLen) */
    char spim_path[512]; snprintf(spim_path, sizeof spim_path, "%s/spim.bin", dir);
    if (access(spim_path, R_OK) == 0 && rc == 0 && argc > 3 && !strcmp(argv[3], "continue")) {
        printf("\n--- Stage 2: ADIProvisioningStart with SPIM ---\n");
        FILE *sf = fopen(spim_path, "rb");
        fseek(sf, 0, SEEK_END); long spim_len = ftell(sf); fseek(sf, 0, SEEK_SET);
        uint8_t *spim = malloc(spim_len);
        fread(spim, 1, spim_len, sf); fclose(sf);
        printf("SPIM: %ld bytes\n", spim_len);

        uint8_t *cpim2 = NULL; int cpim2_len = 0; uint64_t session2 = 0;
        rc = adi_start(dsid, spim, (int)spim_len, &cpim2, &cpim2_len, &session2);
        printf("ADIProvisioningStart(spim) -> rc=%d  cpim2=%p  len=%d  session2=%llu\n",
               rc, (void*)cpim2, cpim2_len, (unsigned long long)session2);

        if (rc == 0 && cpim2 && cpim2_len > 0) {
            hexdump(cpim2, cpim2_len, "CPIM2");
            char cpim2_path[512]; snprintf(cpim2_path, sizeof cpim2_path, "%s/cpim2.bin", dir);
            FILE *cf = fopen(cpim2_path, "wb");
            if (cf) { fwrite(cpim2, 1, cpim2_len, cf); fclose(cf); }
            printf("Saved cpim2 to %s\n", cpim2_path);
            printf("Session2: %llu — save for ADIProvisioningEnd\n", (unsigned long long)session2);

            FILE *sess = fopen("/tmp/stage7-session.txt", "w");
            if (sess) { fprintf(sess, "%llu\n", (unsigned long long)session2); fclose(sess); }
            printf("\ncurl command for FINISH:\n");
            printf("curl -s -X POST 'https://auth.itunes.apple.com/auth/v1/otp/1.5/finish' \\\n");
            printf("  -H 'Content-Type: application/x-www-form-urlencoded' \\\n");
            printf("  --data-binary @%s -o %s/ptm_tk.bin -w '%%{http_code}'\n\n", cpim2_path, dir);
        }
        free(spim);
    }

    return 0;
}
