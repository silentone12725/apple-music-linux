/* Stage 4: reuse the existing provisioned identity (adi.pb + device-id) with the
 * 6.5.2 ADI stack.  If libCoreADI recognises the provisioned state we can call
 * ADIOTPRequest to produce real X-Apple-I-MD / X-Apple-I-MD-M anisette headers
 * and then fetch the GrandSlam bag with those headers.
 *
 * Usage:
 *   ./stage4 <adi-dir> [dsid]
 * Where <adi-dir> must already contain adi.pb and device-id:
 *   mkdir /tmp/stage4-adi
 *   cp ../../drm/files/adi.pb /tmp/stage4-adi/
 *   cp ../../drm/files/device-id /tmp/stage4-adi/
 *   ./stage4 /tmp/stage4-adi 21997672533
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#include "../../drm/embedded_loader.h"

/* ---- shims needed by the Android libs ---- */
static int shim_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d)
{ (void)a; (void)b; (void)c; (void)d; return 0; }
static void *shim_memchr_chk(const void *s, int c, size_t n, size_t bs)
{ (void)bs; return (void *)memchr(s, c, n); }
static void *hook(const char *sym, const char *req) {
    (void)req;
    if (!sym) return NULL;
    if (!strcmp(sym, "__register_atfork")) return (void *)shim_atfork;
    if (!strcmp(sym, "__memchr_chk"))      return (void *)shim_memchr_chk;
    return NULL;
}

/* ---- ADI C API ---- */
typedef int (*fn_path)(const char *);
typedef int (*fn_buf)(const uint8_t *, int);
typedef int (*fn_prov_check)(int64_t);
/* ADIOTPRequest(dsid, &otp, &otpLen, &machineId, &machineIdLen) -> int */
typedef int (*fn_otp)(int64_t, uint8_t **, int *, uint8_t **, int *);
/* ADIProvisioningStart(dsid, spim, spimLen, &cpim, &cpimLen, &session) -> int */
typedef int (*fn_prov_start)(int64_t, const uint8_t *, int, uint8_t **, int *, uint64_t *);
/* ADIProvisioningEnd(session, ptm, ptmLen, tk, tkLen) -> int */
typedef int (*fn_prov_end)(uint64_t, const uint8_t *, int, const uint8_t *, int);

#define SYM(var, name) do { \
    *(void **)&var = embedded_dlsym(name); \
    printf("  %-30s %s\n", name, (void *)var ? "ok" : "MISSING"); \
} while (0)

/* base64 encode (no line breaks) */
static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void b64enc(const uint8_t *in, int len, char *out) {
    int i = 0, o = 0;
    for (; i + 2 < len; i += 3) {
        out[o++] = b64[(in[i]>>2)&63];
        out[o++] = b64[((in[i]&3)<<4)|((in[i+1]>>4)&15)];
        out[o++] = b64[((in[i+1]&15)<<2)|((in[i+2]>>6)&3)];
        out[o++] = b64[in[i+2]&63];
    }
    if (i < len) {
        out[o++] = b64[(in[i]>>2)&63];
        if (i+1 < len) {
            out[o++] = b64[((in[i]&3)<<4)|((in[i+1]>>4)&15)];
            out[o++] = b64[((in[i+1]&15)<<2)];
        } else {
            out[o++] = b64[(in[i]&3)<<4];
            out[o++] = '=';
        }
        out[o++] = '=';
    }
    out[o] = '\0';
}

int main(int argc, char **argv)
{
    const char *dir = argc > 1 ? argv[1] : "/tmp/stage4-adi";
    int64_t dsid    = argc > 2 ? atoll(argv[2]) : 21997672533LL;

    /* ---- sanity-check the provisioning dir ---- */
    char adi_path[512];
    snprintf(adi_path, sizeof adi_path, "%s/adi.pb", dir);
    if (access(adi_path, R_OK) != 0) {
        fprintf(stderr, "ERROR: %s not found — copy drm/files/adi.pb to %s first\n", adi_path, dir);
        return 1;
    }
    char did_path[512];
    snprintf(did_path, sizeof did_path, "%s/device-id", dir);
    if (access(did_path, R_OK) != 0) {
        fprintf(stderr, "ERROR: %s not found — copy drm/files/device-id to %s first\n", did_path, dir);
        return 1;
    }

    /* ---- read the existing Android ID ---- */
    uint8_t aid[16];
    {
        FILE *f = fopen(did_path, "rb");
        if (!f) { perror("open device-id"); return 1; }
        int n = fread(aid, 1, 16, f);
        fclose(f);
        if (n != 16) { fprintf(stderr, "device-id: expected 16 bytes, got %d\n", n); return 1; }
    }
    printf("Android ID (hex): %.16s\n", aid);
    printf("DSID: %lld\n", (long long)dsid);

    /* ---- load the 6.5.2 ADI stack ---- */
    const char *lib64 = "../../drm/rootfs-6.5.2/system/lib64";
    setenv("HYBRIS_LINKER_DIR",     "../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH", lib64, 1);
    setenv("HYBRIS_ANDROID_LIB64",   lib64, 1);
    setenv("ANDROID_ROOT", "/tmp/newstack-root", 0);
    setenv("ANDROID_DATA", "/tmp/newstack-data", 0);

    if (embedded_loader_init() != 0) {
        fprintf(stderr, "embedded_loader_init: %s\n", embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    printf("\nLoading libs:\n");
    const char *libs[] = { "libCoreFP.so", "libCoreADI.so", "libCoreLSKD.so",
                           "libFPDIFor3P.so", "libstoreapi.so", NULL };
    for (int i = 0; libs[i]; i++) {
        if (!embedded_dlopen(libs[i], RTLD_NOW | RTLD_GLOBAL)) {
            fprintf(stderr, "  %s: %s\n", libs[i], embedded_dlerror()); return 1;
        }
        printf("  %s ok\n", libs[i]);
    }

    printf("\nResolving ADI symbols:\n");
    fn_path       adi_setpath = NULL, adi_load = NULL;
    fn_buf        adi_setid = NULL;
    fn_prov_check adi_isprov = NULL;
    fn_otp        adi_otp = NULL;
    fn_prov_start adi_prov_start = NULL;
    fn_prov_end   adi_prov_end = NULL;

    SYM(adi_setpath,    "nf92ngaK92");   /* ADISetProvisioningPath */
    SYM(adi_load,       "kq56gsgHG6");   /* ADILoadLibraryWithPath */
    SYM(adi_setid,      "Sph98paBcz");   /* ADISetAndroidID */
    SYM(adi_isprov,     "aslgmuibau");   /* ADIIsMachineProvisioned */
    SYM(adi_otp,        "qi864985u0");   /* ADIOTPRequest */
    SYM(adi_prov_start, "rsegvyrt87");   /* ADIProvisioningStart */
    SYM(adi_prov_end,   "uv5t6nhkui");   /* ADIProvisioningEnd */

    if (!adi_setpath || !adi_load || !adi_setid || !adi_isprov || !adi_otp) {
        fputs("Missing required symbols.\n", stderr); return 1;
    }

    /* ---- init ADI with the existing provisioning data ---- */
    printf("\nInitialising ADI:\n");
    int rc;
    rc = adi_setpath(dir);   printf("  ADISetProvisioningPath(%s) -> %d\n", dir, rc);
    rc = adi_load(dir);      printf("  ADILoadLibraryWithPath(%s) -> %d\n", dir, rc);
    rc = adi_setpath(dir);   printf("  ADISetProvisioningPath     -> %d\n", rc);
    rc = adi_setid(aid, 16); printf("  ADISetAndroidID            -> %d\n", rc);

    /* check provisioning status */
    rc = adi_isprov(dsid);
    printf("  ADIIsMachineProvisioned(%lld) -> %d  (%s)\n",
           (long long)dsid, rc,
           rc == 0 ? "PROVISIONED" :
           rc == -45061 ? "not provisioned" :
           "unknown error");

    if (rc != 0) {
        printf("\nNot provisioned with DSID %lld, trying dsid=0:\n", (long long)dsid);
        rc = adi_isprov(0);
        printf("  ADIIsMachineProvisioned(0) -> %d  (%s)\n", rc,
               rc == 0 ? "PROVISIONED" : rc == -45061 ? "not provisioned" : "unknown error");
    }

    if (rc != 0) {
        fputs("\nADI not provisioned. The existing adi.pb is not compatible or the Android ID mismatch.\n"
              "Provisioning required (needs network + GrandSlam bag).\n", stdout);
        return 2;
    }

    /* ---- generate OTP ---- */
    printf("\nGenerating OTP (anisette headers):\n");
    uint8_t *otp = NULL, *mid = NULL;
    int otp_len = 0, mid_len = 0;
    rc = adi_otp(dsid, &otp, &otp_len, &mid, &mid_len);
    printf("  ADIOTPRequest -> %d  otp_len=%d mid_len=%d\n", rc, otp_len, mid_len);

    if (rc != 0 || !otp || otp_len <= 0) {
        fprintf(stderr, "OTP generation failed (rc=%d)\n", rc); return 1;
    }

    /* encode as base64 — Apple uses base64 without padding in X-Apple-I-MD */
    char otp_b64[1024], mid_b64[1024];
    b64enc(otp,  otp_len,  otp_b64);
    b64enc(mid,  mid_len,  mid_b64);

    printf("\n--- Anisette headers ---\n");
    printf("X-Apple-I-MD:   %s\n", otp_b64);
    printf("X-Apple-I-MD-M: %s\n", mid_b64);

    /* ---- GrandSlam bag lookup ---- */
    printf("\n--- GrandSlam bag lookup ---\n");
    printf("Run (copy-paste):\n");
    printf("curl -s -X POST \\\n"
           "  'https://gsd.apple.com/grandslam/GsService2/lookup/v2' \\\n"
           "  -H 'X-Apple-I-MD: %s' \\\n"
           "  -H 'X-Apple-I-MD-M: %s' \\\n"
           "  -H 'X-MMe-Client-Info: <Pixel 7><Android; 14;441323.1><com.apple.android.music>' \\\n"
           "  -H 'X-MMe-Device-Id: %.16s' \\\n"
           "  -H 'Content-Type: text/x-xml-plist' \\\n"
           "  -H 'User-Agent: com.apple.android.music/6.5.2' \\\n"
           "  --data-binary '' 2>&1 | head -60\n",
           otp_b64, mid_b64, (char *)aid);

    /* attempt it directly with curl if available */
    char cmd[4096];
    snprintf(cmd, sizeof cmd,
        "curl -s -f -X POST "
        "'https://gsd.apple.com/grandslam/GsService2/lookup/v2' "
        "-H 'X-Apple-I-MD: %s' "
        "-H 'X-Apple-I-MD-M: %s' "
        "-H 'X-MMe-Client-Info: <Pixel 7><Android; 14;441323.1><com.apple.android.music>' "
        "-H 'X-MMe-Device-Id: %.16s' "
        "-H 'Content-Type: text/x-xml-plist' "
        "-H 'User-Agent: com.apple.android.music/6.5.2' "
        "--data-binary '' "
        "-o /tmp/grandslam-bag.plist -w '%%{http_code}' 2>&1",
        otp_b64, mid_b64, (char *)aid);
    printf("\nTrying: ");
    int http = atoi(cmd);  /* dummy init */
    FILE *p = popen(cmd, "r");
    char http_buf[16] = "???";
    if (p) { fread(http_buf, 1, sizeof http_buf - 1, p); pclose(p); }
    printf("HTTP %s\n", http_buf);

    if (http_buf[0] == '2') {
        printf("SUCCESS — bag saved to /tmp/grandslam-bag.plist\n");
        system("plutil -convert json /tmp/grandslam-bag.plist -o /tmp/grandslam-bag.json 2>/dev/null"
               " || cat /tmp/grandslam-bag.plist | head -40");
        system("grep -i 'provision\\|mid\\|amskit' /tmp/grandslam-bag.plist | head -20");
    } else {
        printf("HTTP %s — bag not received. Checking gsa.apple.com...\n", http_buf);
        snprintf(cmd, sizeof cmd,
            "curl -s -X POST "
            "'https://gsa.apple.com/grandslam/GsService2/lookup' "
            "-H 'X-Apple-I-MD: %s' "
            "-H 'X-Apple-I-MD-M: %s' "
            "-H 'X-MMe-Client-Info: <Pixel 7><Android; 14;441323.1><com.apple.android.music>' "
            "-H 'X-MMe-Device-Id: %.16s' "
            "-H 'Content-Type: text/x-xml-plist' "
            "-H 'User-Agent: com.apple.android.music/6.5.2' "
            "--data-binary '' "
            "-w '%%{http_code}' -o /tmp/grandslam-bag2.plist 2>&1",
            otp_b64, mid_b64, (char *)aid);
        p = popen(cmd, "r");
        char h2[16] = "???";
        if (p) { fread(h2, 1, sizeof h2 - 1, p); pclose(p); }
        printf("gsa.apple.com -> HTTP %s\n", h2);
        if (h2[0] == '2')
            system("grep -i 'provision\\|mid\\|amskit' /tmp/grandslam-bag2.plist | head -20");
    }

    return 0;
}
