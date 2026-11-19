/*
 * stage9_prov_native.c — Linux-native ADI provisioning via libstoreapi.so
 *
 * Usage:
 *   stage9_prov_native start  <prov_dir> <android_id_hex> <spim_b64>
 *                 → prints CPIM_B64 and SESSION_ID
 *   stage9_prov_native finish <prov_dir> <android_id_hex> <session_id> <ptm_b64> <tk_b64>
 *                 → runs ADIProvisioningEnd, writes adi.pb into prov_dir
 *   stage9_prov_native otp    <prov_dir> <android_id_hex>
 *                 → prints X-Apple-I-MD and X-Apple-I-MD-M (after provisioning)
 *
 * This implements the crypto side; HTTP round-trips are handled by the wrapper script.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <unistd.h>
#include "../../drm/embedded_loader.h"

typedef int (*fn_path)(const char *);
typedef int (*fn_id)(const uint8_t *, int);
typedef int (*fn_check)(int64_t);
typedef int (*fn_prov_start)(int64_t, const uint8_t *, int, uint8_t **, int *, uint32_t *);
typedef int (*fn_prov_end)(uint32_t, const uint8_t *, int, const uint8_t *, int);
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

/* Base64 tables */
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

static int b64dec(const char *in, uint8_t *out, int *outlen) {
    static const int8_t tbl[256] = {
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
        -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
        -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
        -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1
    };
    int inlen = strlen(in);
    *outlen = 0;
    int o = 0;
    for (int i = 0; i < inlen; ) {
        int a = (uint8_t)in[i] < 256 ? tbl[(uint8_t)in[i]] : -1; i++;
        if (a < 0) continue;
        while (i < inlen && (tbl[(uint8_t)in[i]] < 0) && in[i] != '=') i++;
        if (i >= inlen) break;
        int b = tbl[(uint8_t)in[i]]; i++;
        while (i < inlen && (tbl[(uint8_t)in[i]] < 0) && in[i] != '=') i++;
        int c = (i < inlen && in[i] != '=') ? tbl[(uint8_t)in[i++]] : -1;
        while (i < inlen && (tbl[(uint8_t)in[i]] < 0) && in[i] != '=') i++;
        int d2 = (i < inlen && in[i] != '=') ? tbl[(uint8_t)in[i++]] : -1;
        out[o++] = (a << 2) | ((b >> 4) & 3);
        if (c >= 0) out[o++] = ((b & 15) << 4) | ((c >> 2) & 15);
        if (d2 >= 0) out[o++] = ((c & 3) << 6) | (d2 & 63);
    }
    *outlen = o;
    return 0;
}

static int init_libs(const char *prov_dir, const char *android_id,
                     fn_prov_start *pstart, fn_prov_end *pend, fn_otp *potp) {
    const char *lib64 = "../../drm/rootfs-6.5.2/system/lib64";
    setenv("HYBRIS_LINKER_DIR",      "../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", lib64, 1);
    setenv("HYBRIS_ANDROID_LIB64",   lib64, 1);

    if (embedded_loader_init() != 0) {
        fprintf(stderr, "embedded_loader_init: %s\n", embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    const char *libs[] = { "libCoreFP.so", "libCoreADI.so", "libCoreLSKD.so",
                            "libFPDIFor3P.so", "libstoreapi.so", NULL };
    for (int i = 0; libs[i]; i++) {
        if (!embedded_dlopen(libs[i], RTLD_NOW | RTLD_GLOBAL)) {
            fprintf(stderr, "  %s: %s\n", libs[i], embedded_dlerror()); return 1;
        }
    }

    fn_path adi_setpath = NULL, adi_load = NULL;
    fn_id   adi_setid   = NULL;
    *(void**)&adi_setpath = embedded_dlsym("nf92ngaK92");
    *(void**)&adi_load    = embedded_dlsym("kq56gsgHG6");
    *(void**)&adi_setid   = embedded_dlsym("Sph98paBcz");
    *(void**)pstart       = embedded_dlsym("rsegvyrt87");
    *(void**)pend         = embedded_dlsym("uv5t6nhkui");
    *(void**)potp         = embedded_dlsym("qi864985u0");

    if (!adi_setpath || !adi_load || !*pstart || !*pend || !*potp) {
        fprintf(stderr, "Missing ADI symbols\n"); return 1;
    }

    adi_setpath(prov_dir);

    /* ADILoadLibraryWithPath takes the LIBRARY dir, not the data dir */
    int rc_load = adi_load(lib64);
    fprintf(stderr, "[stage9] ADILoadLibraryWithPath(%s) -> %d\n", lib64, rc_load);

    if (adi_setid) {
        int rc = adi_setid((const uint8_t *)android_id, 16);
        fprintf(stderr, "[stage9] ADISetAndroidID(%.16s) -> %d\n", android_id, rc);
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "Usage:\n"
            "  %s start  <prov_dir> <android_id_hex16> <spim_b64>\n"
            "  %s finish <prov_dir> <android_id_hex16> <session_id> <ptm_b64> <tk_b64>\n"
            "  %s otp    <prov_dir> <android_id_hex16>\n", argv[0], argv[0], argv[0]);
        return 1;
    }

    const char *cmd       = argv[1];
    const char *prov_dir  = argv[2];
    const char *android_id = argv[3];

    fn_prov_start prov_start = NULL;
    fn_prov_end   prov_end   = NULL;
    fn_otp        adi_otp    = NULL;

    if (init_libs(prov_dir, android_id, &prov_start, &prov_end, &adi_otp) != 0) return 1;

    if (strcmp(cmd, "start") == 0) {
        if (argc < 5) { fprintf(stderr, "Need spim_b64\n"); return 1; }
        const char *spim_b64 = argv[4];

        uint8_t spim_buf[8192];
        int spim_len = 0;
        b64dec(spim_b64, spim_buf, &spim_len);
        fprintf(stderr, "[stage9] SPIM decoded: %d bytes\n", spim_len);

        uint8_t *cpim = NULL;
        int cpim_len = 0;
        uint32_t session = 0;

        int rc = prov_start((int64_t)-2LL, spim_buf, spim_len, &cpim, &cpim_len, &session);
        fprintf(stderr, "[stage9] ADIProvisioningStart -> rc=%d, cpim_len=%d, session=%u\n",
                rc, cpim_len, session);

        if (rc != 0) {
            fprintf(stderr, "[stage9] FAILED\n"); return 1;
        }

        char cpim_b64[16384] = {};
        b64enc(cpim, cpim_len, cpim_b64);

        printf("CPIM_B64=%s\n", cpim_b64);
        printf("SESSION_ID=%u\n", session);
        return 0;
    }
    else if (strcmp(cmd, "finish") == 0) {
        if (argc < 7) { fprintf(stderr, "Need session_id ptm_b64 tk_b64\n"); return 1; }
        uint32_t session = (uint32_t)strtoul(argv[4], NULL, 10);
        const char *ptm_b64 = argv[5];
        const char *tk_b64  = argv[6];

        uint8_t ptm_buf[16384], tk_buf[4096];
        int ptm_len = 0, tk_len = 0;
        b64dec(ptm_b64, ptm_buf, &ptm_len);
        b64dec(tk_b64,  tk_buf,  &tk_len);
        fprintf(stderr, "[stage9] PTM=%d bytes  TK=%d bytes  session=%u\n",
                ptm_len, tk_len, session);

        int rc = prov_end(session, ptm_buf, ptm_len, tk_buf, tk_len);
        fprintf(stderr, "[stage9] ADIProvisioningEnd -> rc=%d\n", rc);

        if (rc != 0) {
            fprintf(stderr, "[stage9] FAILED\n"); return 1;
        }

        printf("PROVISIONED=1\n");
        return 0;
    }
    else if (strcmp(cmd, "otp") == 0) {
        uint8_t *otp = NULL, *mid = NULL;
        int otp_len = 0, mid_len = 0;

        int rc = adi_otp((int64_t)-2LL, &otp, &otp_len, &mid, &mid_len);
        fprintf(stderr, "[stage9] ADIOTPRequest -> rc=%d\n", rc);

        if (rc != 0) {
            fprintf(stderr, "[stage9] OTP FAILED (rc=%d) — not provisioned?\n", rc); return 1;
        }

        char otp_b64[1024] = {}, mid_b64[256] = {};
        b64enc(otp, otp_len, otp_b64);
        b64enc(mid, mid_len, mid_b64);

        printf("OTP_B64=%s\n", otp_b64);
        printf("MDM_B64=%s\n", mid_b64);
        return 0;
    }
    else if (strcmp(cmd, "provision") == 0) {
        /*
         * Combined mode: start + finish in a single process so the session
         * handle (which is in-process memory, not just an ID) stays valid.
         *
         * Protocol on stdin/stdout (line-based):
         *   stdin:  SPIM_B64=<base64>
         *   stdout: CPIM_B64=<base64>
         *   stdin:  PTM_B64=<base64>
         *   stdin:  TK_B64=<base64>
         *   stdout: PROVISIONED=1   (or exits non-zero on failure)
         */
        char line[16384];

        /* Read SPIM */
        if (!fgets(line, sizeof line, stdin)) { fprintf(stderr, "[stage9] no SPIM\n"); return 1; }
        line[strcspn(line, "\r\n")] = '\0';
        const char *spim_b64 = line;
        if (strncmp(spim_b64, "SPIM_B64=", 9) == 0) spim_b64 += 9;

        uint8_t spim_buf[8192]; int spim_len = 0;
        b64dec(spim_b64, spim_buf, &spim_len);
        fprintf(stderr, "[stage9] SPIM decoded: %d bytes\n", spim_len);

        uint8_t *cpim = NULL; int cpim_len = 0; uint32_t session = 0;
        int rc = prov_start((int64_t)-2LL, spim_buf, spim_len, &cpim, &cpim_len, &session);
        fprintf(stderr, "[stage9] ADIProvisioningStart -> rc=%d, cpim_len=%d, session=%u\n",
                rc, cpim_len, session);
        if (rc != 0) { fprintf(stderr, "[stage9] FAILED\n"); return 1; }

        char cpim_b64[16384] = {};
        b64enc(cpim, cpim_len, cpim_b64);
        printf("CPIM_B64=%s\n", cpim_b64); fflush(stdout);

        /* Read PTM */
        if (!fgets(line, sizeof line, stdin)) { fprintf(stderr, "[stage9] no PTM\n"); return 1; }
        line[strcspn(line, "\r\n")] = '\0';
        const char *ptm_b64 = line;
        if (strncmp(ptm_b64, "PTM_B64=", 8) == 0) ptm_b64 += 8;

        /* Read TK */
        char tkline[1024];
        if (!fgets(tkline, sizeof tkline, stdin)) { fprintf(stderr, "[stage9] no TK\n"); return 1; }
        tkline[strcspn(tkline, "\r\n")] = '\0';
        const char *tk_b64 = tkline;
        if (strncmp(tk_b64, "TK_B64=", 7) == 0) tk_b64 += 7;

        uint8_t ptm_buf[16384], tk_buf[4096]; int ptm_len = 0, tk_len = 0;
        b64dec(ptm_b64, ptm_buf, &ptm_len);
        b64dec(tk_b64,  tk_buf,  &tk_len);
        fprintf(stderr, "[stage9] PTM=%d bytes  TK=%d bytes\n", ptm_len, tk_len);

        rc = prov_end(session, ptm_buf, ptm_len, tk_buf, tk_len);
        fprintf(stderr, "[stage9] ADIProvisioningEnd -> rc=%d\n", rc);
        if (rc != 0) { fprintf(stderr, "[stage9] FAILED\n"); return 1; }

        printf("PROVISIONED=1\n"); fflush(stdout);
        return 0;
    }
    else {
        fprintf(stderr, "Unknown command: %s\n", cmd); return 1;
    }
}
