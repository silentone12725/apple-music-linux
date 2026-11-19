/*
 * stage8_otp_native.c — Generate anisette OTP headers natively on Linux
 *
 * Uses 6.5.2 libstoreapi.so + adi.pb from drm/files/ + Android ID
 * to call ADIOTPRequest(dsid=-2) and print X-Apple-I-MD / X-Apple-I-MD-M.
 *
 * Proves we can generate fresh OTP without the emulator.
 *
 * Usage: ./stage8_otp_native [prov_dir] [android_id_hex]
 *   prov_dir     = path containing adi.pb (default: ../../drm/files)
 *   android_id_hex = 16-char hex Android ID (default: read from prov_dir/ANDROID_ID)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <unistd.h>
#include <sys/stat.h>
#include "../../drm/embedded_loader.h"

typedef int (*fn_path)(const char *);
typedef int (*fn_id)(const uint8_t *, int);
typedef int (*fn_check)(int64_t);
typedef int (*fn_otp)(int64_t, uint8_t **, int *, uint8_t **, int *);

static int shim_atfork(void(*a)(void),void(*b)(void),void(*c)(void),void*d){(void)a;(void)b;(void)c;(void)d;return 0;}
static void *shim_memchr_chk(const void *s,int c,size_t n,size_t bs){(void)bs;return(void*)memchr(s,c,n);}
static void *hook(const char *sym, const char *req){
    (void)req;
    if(!sym) return NULL;
    if(!strcmp(sym,"__register_atfork")) return (void*)shim_atfork;
    if(!strcmp(sym,"__memchr_chk"))      return (void*)shim_memchr_chk;
    return NULL;
}

static const char b64chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64enc(const uint8_t *in, int len, char *out) {
    int i=0, o=0;
    for(; i+2<len; i+=3) {
        out[o++]=b64chars[(in[i]>>2)&63];
        out[o++]=b64chars[((in[i]&3)<<4)|((in[i+1]>>4)&15)];
        out[o++]=b64chars[((in[i+1]&15)<<2)|((in[i+2]>>6)&3)];
        out[o++]=b64chars[in[i+2]&63];
    }
    if(i<len){
        out[o++]=b64chars[(in[i]>>2)&63];
        if(i+1<len){out[o++]=b64chars[((in[i]&3)<<4)|((in[i+1]>>4)&15)];out[o++]=b64chars[((in[i+1]&15)<<2)];}
        else{out[o++]=b64chars[(in[i]&3)<<4];out[o++]='=';}
        out[o++]='=';
    }
    out[o]='\0';
}

static void hexdump(const uint8_t *d, int len) {
    for (int i = 0; i < len && i < 32; i++) printf("%02x", d[i]);
    if (len > 32) printf("...(%d total)", len);
    printf("\n");
}

int main(int argc, char **argv)
{
    const char *prov_dir  = argc > 1 ? argv[1] : "../../drm/files";
    const char *android_id = argc > 2 ? argv[2] : NULL;

    /* Read Android ID from file if not provided */
    char id_buf[32] = {};
    if (!android_id) {
        char id_path[512];
        snprintf(id_path, sizeof id_path, "%s/ANDROID_ID", prov_dir);
        FILE *f = fopen(id_path, "r");
        if (f) { fread(id_buf, 1, 16, f); fclose(f); android_id = id_buf; }
        else { fprintf(stderr, "ANDROID_ID not found at %s\n", id_path); return 1; }
    }

    printf("[stage8] prov_dir=%s  android_id=%.16s\n", prov_dir, android_id);

    const char *lib64 = "../../drm/rootfs-6.5.2/system/lib64";
    setenv("HYBRIS_LINKER_DIR",      "../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", lib64, 1);
    setenv("HYBRIS_ANDROID_LIB64",   lib64, 1);
    setenv("ANDROID_ROOT", "/tmp/s8-root", 0);
    setenv("ANDROID_DATA", "/tmp/s8-data", 0);

    if (embedded_loader_init() != 0) {
        fprintf(stderr, "embedded_loader_init: %s\n", embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    printf("Loading 6.5.2 libraries...\n");
    const char *libs[] = { "libCoreFP.so", "libCoreADI.so", "libCoreLSKD.so",
                            "libFPDIFor3P.so", "libstoreapi.so", NULL };
    for (int i = 0; libs[i]; i++) {
        if (!embedded_dlopen(libs[i], RTLD_NOW | RTLD_GLOBAL)) {
            fprintf(stderr, "  %s: %s\n", libs[i], embedded_dlerror()); return 1;
        }
        printf("  %s ok\n", libs[i]);
    }

    fn_path   adi_setpath = NULL, adi_load = NULL;
    fn_id     adi_setid   = NULL;
    fn_check  adi_isprov  = NULL;
    fn_otp    adi_otp     = NULL;

    *(void**)&adi_setpath = embedded_dlsym("nf92ngaK92");
    *(void**)&adi_load    = embedded_dlsym("kq56gsgHG6");
    *(void**)&adi_setid   = embedded_dlsym("Sph98paBcz");
    *(void**)&adi_isprov  = embedded_dlsym("aslgmuibau");
    *(void**)&adi_otp     = embedded_dlsym("qi864985u0");

    if (!adi_setpath || !adi_load || !adi_otp) {
        fprintf(stderr, "Missing required ADI symbols\n"); return 1;
    }

    int rc;
    rc = adi_setpath(prov_dir); printf("ADISetProvisioningPath -> %d\n", rc);
    rc = adi_load(prov_dir);    printf("ADILoadLibraryWithPath -> %d\n", rc);
    rc = adi_setpath(prov_dir); printf("ADISetProvisioningPath (2nd) -> %d\n", rc);

    /* Set Android ID — 16 ASCII hex chars */
    if (adi_setid) {
        rc = adi_setid((const uint8_t *)android_id, 16);
        printf("ADISetAndroidID(%.16s) -> %d\n", android_id, rc);
    }

    /* Check provisioning status for dsid=-2 */
    if (adi_isprov) {
        rc = adi_isprov((int64_t)-2LL);
        printf("ADIIsMachineProvisioned(-2) -> %d  (%s)\n", rc,
               rc==0 ? "PROVISIONED" : rc==-45061 ? "not provisioned" : "other error");
        if (rc != 0) {
            fprintf(stderr, "ERROR: adi.pb not provisioned for dsid=-2 (rc=%d)\n", rc);
            fprintf(stderr, "Ensure adi.pb in %s was captured from a provisioned emulator\n", prov_dir);
            return 1;
        }
    }

    /* Call ADIOTPRequest(dsid=-2) */
    uint8_t *otp = NULL, *mid = NULL;
    int otp_len = 0, mid_len = 0;

    printf("\n--- ADIOTPRequest(dsid=-2) ---\n");
    rc = adi_otp((int64_t)-2LL, &otp, &otp_len, &mid, &mid_len);
    printf("rc=%d\n", rc);

    if (rc == 0 && otp && mid) {
        printf("otp_len=%d  mid_len=%d\n", otp_len, mid_len);
        printf("otp raw: "); hexdump(otp, otp_len);
        printf("mid raw: "); hexdump(mid, mid_len);

        char otp_b64[1024] = {}, mid_b64[256] = {};
        b64enc(otp, otp_len, otp_b64);
        b64enc(mid, mid_len, mid_b64);

        printf("\n=== Anisette headers ===\n");
        printf("X-Apple-I-MD:   %s\n", otp_b64);
        printf("X-Apple-I-MD-M: %s\n", mid_b64);

        /* Save to files for use by adam */
        char otp_path[512], mid_path[512];
        snprintf(otp_path, sizeof otp_path, "%s/otp_md.b64",  prov_dir);
        snprintf(mid_path, sizeof mid_path, "%s/otp_mdm.b64", prov_dir);
        FILE *f;
        f = fopen(otp_path, "w");  if(f){fprintf(f,"%s\n",otp_b64);  fclose(f);}
        f = fopen(mid_path, "w");  if(f){fprintf(f,"%s\n",mid_b64);  fclose(f);}
        printf("\nSaved to %s and %s\n", otp_path, mid_path);
    } else {
        printf("ADIOTPRequest FAILED (rc=%d)\n", rc);
        return 1;
    }

    return 0;
}
