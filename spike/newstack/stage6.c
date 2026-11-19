/*
 * stage6.c — C++ RequestContext API path, using the same "ancestor" init as
 * the wrapper (setFairPlayDirectoryPath = base_dir, the PARENT of mpl_db).
 *
 * The raw C ADI API (nf92ngaK92) is dead: the existing adi.pb was written by
 * RequestContext::init() internally. Only the C++ path can read it back.
 *
 * Usage:
 *   ./stage6 [base_dir]
 *   base_dir must contain adi.pb and mpl_db/ (default: ../../drm/files)
 *
 * On success prints anisette headers from a live URLRequest to Apple.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <dlfcn.h>
#include <unistd.h>
#include <pthread.h>
#include <sys/stat.h>
#include <errno.h>
#include "../../drm/embedded_loader.h"

/* ---- std::string / shared_ptr layouts (Bionic NDK ABI) ---- */
struct shared_ptr { void *obj; void *ctrl_blk; };

union std_string {
    struct { uint8_t mark; char str[0]; };
    struct { size_t cap; size_t size; const char *data; };
};

static inline union std_string ss(const char *s) {
    union std_string r = { .cap = 1, .size = strlen(s), .data = s };
    return r;
}

/* ---- vtable arrays (8 slots, patched from Android memory) ---- */
static void *vtv_reqctxcfg[8];
static void *vtv_httpmsg[8];

/* ---- resolved function pointers ---- */
typedef void (*fn_vv)(void*);
typedef void (*fn_vs)(void*, union std_string*);

static fn_vv    _foothill_config;
static fn_vv    _device_guid_instance;
typedef void (*fn_dg_configure)(void*, void*, union std_string*, union std_string*, unsigned int*, uint8_t*);
static fn_dg_configure _device_guid_configure;

static void (*_reqctx_make_shared)(struct shared_ptr*, union std_string*);
static void (*_reqctxcfg_ctor)(void*);
static fn_vs    _set_base_dir;
static fn_vs    _set_client_id;
static fn_vs    _set_version_id;
static fn_vs    _set_platform_id;
static fn_vs    _set_product_ver;
static fn_vs    _set_device_model;
static fn_vs    _set_build_ver;
static fn_vs    _set_locale_id;
static fn_vs    _set_lang_id;
static void (*_reqctx_mgr_configure)(struct shared_ptr*);
static void (*_reqctx_init)(void*, void*, struct shared_ptr*);
static fn_vs    _set_fairplay_dir;    /* RequestContext::setFairPlayDirectoryPath */

/* presentation interface */
static void (*_apinf_make_shared)(struct shared_ptr*);
static void (*_apinf_set_dialog)(void*, void*);
static void (*_apinf_set_credentials)(void*, void*);
static void (*_reqctx_set_presentation)(void*, struct shared_ptr*);

/* URLRequest */
static void (*_httpmsg_ctor)(void*, union std_string*, union std_string*);
static void (*_httpmsg_set_header)(void*, union std_string*, union std_string*);
static void (*_urlreq_ctor)(void*, struct shared_ptr*, struct shared_ptr*);
static void (*_urlreq_set_param)(void*, union std_string*, union std_string*);
static void (*_urlreq_run)(void*);
static struct shared_ptr *(*_urlreq_error)(void*);
static struct shared_ptr *(*_urlreq_response)(void*);
static struct shared_ptr *(*_urlresp_underlying)(void*);
static int   (*_store_error_code)(void*);
static const char *(*_store_error_what)(void*);
static char *(*_data_bytes)(void*);
static size_t(*_data_length)(void*);

/* vtable symbols (extern pointers; patched below) */
static void *vtv_reqctxcfg_sym;
static void *vtv_httpmsg_sym;

/* ---- shims declared at file scope ---- */
static int shim_atfork(void(*a)(void),void(*b)(void),void(*c)(void),void*d)
{ (void)a;(void)b;(void)c;(void)d; return 0; }
static void *shim_memchr_chk(const void*s,int c,size_t n,size_t bs)
{ (void)bs; return (void*)memchr(s,c,n); }

/* ---- curl interception ---- */
/* libstoreservicescore calls curl_easy_setopt(handle, CURLOPT_HTTPHEADER, slist).
 * We intercept it to print X-Apple-I-MD* anisette headers. */
#define CURLOPT_HTTPHEADER 10023
struct curl_slist { char *data; struct curl_slist *next; };

static void capture_headers(struct curl_slist *slist) {
    for (; slist; slist = slist->next) {
        if (!slist->data) continue;
        /* Print any Apple anisette or interesting headers */
        if (strncmp(slist->data, "X-Apple-I-MD", 12) == 0 ||
            strncmp(slist->data, "X-Apple-AMD",  11) == 0 ||
            strncmp(slist->data, "X-MMe-",        6) == 0) {
            printf("  [anisette hdr] %s\n", slist->data); fflush(stdout);
        }
    }
}

/* Hook intercepts curl_easy_setopt calls from Android libs. On x86_64 the
 * calling convention passes all args in registers, so a 3-arg non-variadic
 * function captures (curl, opt, arg) correctly when arg is pointer or long. */
static int (*real_curl_easy_setopt)(void*, int, ...) = NULL;

static int shim_curl_easy_setopt(void *curl, int opt, void *arg) {
    if (opt == CURLOPT_HTTPHEADER) {
        capture_headers((struct curl_slist *)arg);
    }
    if (!real_curl_easy_setopt)
        real_curl_easy_setopt = dlsym(RTLD_DEFAULT, "curl_easy_setopt");
    if (real_curl_easy_setopt)
        return real_curl_easy_setopt(curl, opt, arg);
    return 0;
}

/* The hook callback is called for every undefined symbol in Android libs. */
static void *hook(const char *sym, const char *req) {
    (void)req;
    if (!sym) return NULL;
    /* pthread shims */
    if (!strcmp(sym, "__register_atfork")) return (void*)shim_atfork;
    if (!strcmp(sym, "__memchr_chk"))      return (void*)shim_memchr_chk;
    return NULL;
}

#define LOAD(var, name) do { \
    *(void**)&(var) = embedded_dlsym(name); \
    if (!(var)) { fprintf(stderr, "MISSING sym: %s\n", name); return 1; } \
} while(0)

static int load_symbols(void) {
    /* vtable symbols — patch into local arrays */
    void *p;
    p = embedded_dlsym("_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore20RequestContextConfigENS_9allocatorIS2_EEEE");
    if (!p) { fputs("MISSING vtable RequestContextConfig\n", stderr); return 1; }
    memcpy(vtv_reqctxcfg, p, 8 * sizeof(void*));

    p = embedded_dlsym("_ZTVNSt6__ndk120__shared_ptr_emplaceIN13mediaplatform11HTTPMessageENS_9allocatorIS2_EEEE");
    if (!p) { fputs("MISSING vtable HTTPMessage\n", stderr); return 1; }
    memcpy(vtv_httpmsg, p, 8 * sizeof(void*));

    /* drm_init_internal symbols */
    LOAD(_foothill_config,
        "_ZN14FootHillConfig6configERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE");
    LOAD(_device_guid_instance,
        "_ZN17storeservicescore10DeviceGUID8instanceEv");
    LOAD(_device_guid_configure,
        "_ZN17storeservicescore10DeviceGUID9configureERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_RKjRKb");

    /* RequestContext C++ init chain */
    LOAD(_reqctx_make_shared,
        "_ZNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEE11make_sharedIJRNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEEEEES3_DpOT_");
    LOAD(_reqctxcfg_ctor,
        "_ZN17storeservicescore20RequestContextConfigC2Ev");
    LOAD(_set_base_dir,
        "_ZN17storeservicescore20RequestContextConfig20setBaseDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_client_id,
        "_ZN17storeservicescore20RequestContextConfig19setClientIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_version_id,
        "_ZN17storeservicescore20RequestContextConfig20setVersionIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_platform_id,
        "_ZN17storeservicescore20RequestContextConfig21setPlatformIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_product_ver,
        "_ZN17storeservicescore20RequestContextConfig17setProductVersionERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_device_model,
        "_ZN17storeservicescore20RequestContextConfig14setDeviceModelERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_build_ver,
        "_ZN17storeservicescore20RequestContextConfig15setBuildVersionERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_locale_id,
        "_ZN17storeservicescore20RequestContextConfig19setLocaleIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_set_lang_id,
        "_ZN17storeservicescore20RequestContextConfig21setLanguageIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");
    LOAD(_reqctx_mgr_configure,
        "_ZN21RequestContextManager9configureERKNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEEE");
    LOAD(_reqctx_init,
        "_ZN17storeservicescore14RequestContext4initERKNSt6__ndk110shared_ptrINS_20RequestContextConfigEEE");
    LOAD(_set_fairplay_dir,
        "_ZN17storeservicescore14RequestContext24setFairPlayDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE");

    /* presentation interface */
    LOAD(_apinf_make_shared,
        "_ZNSt6__ndk110shared_ptrIN20androidstoreservices28AndroidPresentationInterfaceEE11make_sharedIJEEES3_DpOT_");
    LOAD(_apinf_set_dialog,
        "_ZN20androidstoreservices28AndroidPresentationInterface16setDialogHandlerEPFvlNSt6__ndk110shared_ptrIN17storeservicescore14ProtocolDialogEEENS2_INS_36AndroidProtocolDialogResponseHandlerEEEE");
    LOAD(_apinf_set_credentials,
        "_ZN20androidstoreservices28AndroidPresentationInterface21setCredentialsHandlerEPFvNSt6__ndk110shared_ptrIN17storeservicescore18CredentialsRequestEEENS2_INS_33AndroidCredentialsResponseHandlerEEEE");
    LOAD(_reqctx_set_presentation,
        "_ZN17storeservicescore14RequestContext24setPresentationInterfaceERKNSt6__ndk110shared_ptrINS_21PresentationInterfaceEEE");

    /* URLRequest */
    LOAD(_httpmsg_ctor,
        "_ZN13mediaplatform11HTTPMessageC2ENSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES7_");
    LOAD(_httpmsg_set_header,
        "_ZN13mediaplatform11HTTPMessage9setHeaderERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_");
    LOAD(_urlreq_ctor,
        "_ZN17storeservicescore10URLRequestC2ERKNSt6__ndk110shared_ptrIN13mediaplatform11HTTPMessageEEERKNS2_INS_14RequestContextEEE");
    LOAD(_urlreq_set_param,
        "_ZN17storeservicescore10URLRequest19setRequestParameterERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_");
    LOAD(_urlreq_run,
        "_ZN17storeservicescore10URLRequest3runEv");
    LOAD(_urlreq_error,
        "_ZNK17storeservicescore10URLRequest5errorEv");
    LOAD(_urlreq_response,
        "_ZNK17storeservicescore10URLRequest8responseEv");
    LOAD(_urlresp_underlying,
        "_ZNK17storeservicescore11URLResponse18underlyingResponseEv");
    LOAD(_store_error_code,
        "_ZNK17storeservicescore19StoreErrorCondition9errorCodeEv");
    LOAD(_store_error_what,
        "_ZNK17storeservicescore19StoreErrorCondition4whatEv");
    LOAD(_data_bytes, "_ZNK13mediaplatform4Data5bytesEv");
    LOAD(_data_length, "_ZNK13mediaplatform4Data6lengthEv");

    return 0;
}

/* ---- no-op presentation handlers ---- */
static void dialog_handler(long j, struct shared_ptr *d, struct shared_ptr *r) {
    (void)j; (void)d; (void)r;
    fprintf(stderr, "[stage6] dialog triggered — ignoring\n");
}
static void cred_handler(struct shared_ptr *req, struct shared_ptr *resp) {
    (void)req; (void)resp;
    fprintf(stderr, "[stage6] credential prompt — ignoring\n");
}

int main(int argc, char **argv)
{
    const char *base_dir = argc > 1 ? argv[1] : "../../drm/files";
    printf("[stage6] base_dir = %s\n", base_dir); fflush(stdout);

    /* Ensure mpl_db exists (adi.pb absence is fine — triggers fresh provisioning) */
    char mpl_path[1024];
    snprintf(mpl_path, sizeof mpl_path, "%s/mpl_db", base_dir);
    if (access(mpl_path, F_OK) != 0) {
        if (mkdir(mpl_path, 0700) != 0) {
            fprintf(stderr, "ERROR: cannot create %s: %s\n", mpl_path, strerror(errno)); return 1;
        }
    }
    char adi_path[1024];
    snprintf(adi_path, sizeof adi_path, "%s/adi.pb", base_dir);
    int has_adi = (access(adi_path, R_OK) == 0);
    printf("[stage6] adi.pb: %s\n", has_adi ? "FOUND (re-use existing identity)" : "NOT FOUND (fresh provisioning)");

    /* ---- hybris init ---- */
    setenv("HYBRIS_LINKER_DIR",     "../../drm/hybris-linker", 1);
    setenv("HYBRIS_LD_LIBRARY_PATH","../../drm/rootfs/system/lib64", 1);
    setenv("HYBRIS_ANDROID_LIB64",  "../../drm/rootfs/system/lib64", 1);
    setenv("ANDROID_DNS_MODE", "local", 1);

    if (embedded_loader_init() != 0) {
        fprintf(stderr, "embedded_loader_init: %s\n", embedded_dlerror()); return 1;
    }
    embedded_set_hook_callback(hook);

    printf("[stage6] Loading Android libs...\n"); fflush(stdout);
    const char *libs[] = { "libCoreFP.so", "libCoreADI.so",
                           "libstoreservicescore.so", "libandroidappmusic.so", NULL };
    for (int i = 0; libs[i]; i++) {
        if (!embedded_dlopen(libs[i], RTLD_NOW | RTLD_GLOBAL)) {
            fprintf(stderr, "  %s: %s\n", libs[i], embedded_dlerror()); return 1;
        }
        printf("  loaded %s\n", libs[i]); fflush(stdout);
    }

    if (load_symbols() != 0) return 1;
    printf("[stage6] All symbols resolved.\n"); fflush(stdout);

    /* ---- drm_init_internal equivalent ---- */
    printf("[stage6] drm_init_internal...\n"); fflush(stdout);
    /* android_id: read from device-id file, or generate fresh random 8 bytes */
    char android_id[20] = {};
    {
        char did_path[1024];
        snprintf(did_path, sizeof did_path, "%s/device-id", base_dir);
        FILE *f = fopen(did_path, "rb");
        if (f) {
            fread(android_id, 1, 16, f); fclose(f);
            android_id[16] = 0;
        } else {
            /* fresh random device ID */
            uint8_t rnd[8];
            FILE *ur = fopen("/dev/urandom", "rb");
            if (ur) { fread(rnd, 1, 8, ur); fclose(ur); }
            snprintf(android_id, 17, "%02x%02x%02x%02x%02x%02x%02x%02x",
                     rnd[0],rnd[1],rnd[2],rnd[3],rnd[4],rnd[5],rnd[6],rnd[7]);
            /* persist it */
            f = fopen(did_path, "wb");
            if (f) { fprintf(f, "%s\n", android_id); fclose(f); }
            printf("  generated fresh android_id: %.16s\n", android_id);
        }
    }
    printf("  android_id: %.16s\n", android_id);

    static struct shared_ptr g_guid;
    union std_string s_aid   = ss(android_id);
    union std_string s_empty = ss("");
    static unsigned int conf3 = 29;
    static uint8_t conf4 = 1;
    static uint8_t guid_ret[88];

    _foothill_config(&s_aid);
    _device_guid_instance(&g_guid);
    _device_guid_configure(guid_ret, g_guid.obj, &s_aid, &s_empty, &conf3, &conf4);

    /* ---- drm_init_ctx equivalent ---- */
    printf("[stage6] drm_init_ctx (C++ RequestContext, ancestor path)...\n"); fflush(stdout);

    /* mpl_db path (setBaseDirectoryPath) */
    char mpl_db_path[1024];
    snprintf(mpl_db_path, sizeof mpl_db_path, "%s/mpl_db", base_dir);

    /* Construct RequestContext with mpl_db path */
    static struct shared_ptr reqCtx;
    union std_string s_mpl = ss(mpl_db_path);
    _reqctx_make_shared(&reqCtx, &s_mpl);
    printf("  reqCtx.obj = %p\n", reqCtx.obj); fflush(stdout);
    if (!reqCtx.obj) { fputs("  make_shared failed\n", stderr); return 1; }

    /* RequestContextConfig setup — vtable patch pattern from wrapper/hybris_stubs.c */
    static uint8_t cfg_blk[480];
    *(void **)(cfg_blk) = &vtv_reqctxcfg[2];
    struct shared_ptr reqCtxCfg = { .obj = cfg_blk + 32, .ctrl_blk = cfg_blk };

    _reqctxcfg_ctor(reqCtxCfg.obj);
    _set_base_dir(reqCtxCfg.obj, &s_mpl);               /* base = mpl_db */

    union std_string s_client  = ss("Music");
    union std_string s_ver     = ss("4.9");
    union std_string s_plat    = ss("Android");
    union std_string s_prodver = ss("10");
    union std_string s_model   = ss("Samsung S9");
    union std_string s_build   = ss("7663313");
    union std_string s_locale  = ss("en-US");
    union std_string s_lang    = ss("en-US");

    _set_client_id    (reqCtxCfg.obj, &s_client);
    _set_version_id   (reqCtxCfg.obj, &s_ver);
    _set_platform_id  (reqCtxCfg.obj, &s_plat);
    _set_product_ver  (reqCtxCfg.obj, &s_prodver);
    _set_device_model (reqCtxCfg.obj, &s_model);
    _set_build_ver    (reqCtxCfg.obj, &s_build);
    _set_locale_id    (reqCtxCfg.obj, &s_locale);
    _set_lang_id      (reqCtxCfg.obj, &s_lang);

    printf("  RequestContextManager::configure...\n"); fflush(stdout);
    _reqctx_mgr_configure(&reqCtx);

    printf("  RequestContext::init...\n"); fflush(stdout);
    static uint8_t init_ret[88];
    _reqctx_init(init_ret, reqCtx.obj, &reqCtxCfg);

    /* THE ANCESTOR KEY: setFairPlayDirectoryPath = base_dir (parent of mpl_db) */
    printf("  setFairPlayDirectoryPath(%s) [ancestor of mpl_db]...\n", base_dir); fflush(stdout);
    union std_string s_base = ss(base_dir);
    _set_fairplay_dir(reqCtx.obj, &s_base);

    /* Presentation interface (required to prevent crash on auth requests) */
    static struct shared_ptr apInf;
    _apinf_make_shared(&apInf);
    _apinf_set_dialog(apInf.obj, (void*)dialog_handler);
    _apinf_set_credentials(apInf.obj, (void*)cred_handler);
    _reqctx_set_presentation(reqCtx.obj, &apInf);

    printf("[stage6] RequestContext initialized. Making URLRequest...\n"); fflush(stdout);

    /* ---- URLRequest to sf-api-token-service ---- */
    static uint8_t msg_blk[2048];
    *(void **)(msg_blk) = &vtv_httpmsg[2];
    struct shared_ptr httpMsg = { .obj = msg_blk + 32, .ctrl_blk = msg_blk };

    /* POST to amd-sync-machine (provisioning START — from init.itunes.apple.com bag).
     * Returns "spim" blob needed for ADIProvisioningStart.
     * RequestContext automatically adds X-Apple-I-MD + X-MMe-* anisette headers.
     * Mode: "sync" = amd 1.5, "sync" on 1.0 = md protocol; use 1.5 (amd). */
    const char *req_url = argc > 2 ? argv[2]
        : "https://auth.itunes.apple.com/auth/v1/otp/1.5/sync";
    union std_string s_url    = ss(req_url);
    union std_string s_method = ss("POST");
    _httpmsg_ctor(httpMsg.obj, &s_url, &s_method);

    union std_string s_ct_key = ss("Content-Type");
    union std_string s_ct_val = ss("application/x-www-form-urlencoded");
    _httpmsg_set_header(httpMsg.obj, &s_ct_key, &s_ct_val);

    static uint8_t urlreq_buf[2048];
    _urlreq_ctor(urlreq_buf, &httpMsg, &reqCtx);

    printf("  URLRequest::run...\n"); fflush(stdout);
    _urlreq_run(urlreq_buf);

    struct shared_ptr *err = _urlreq_error(urlreq_buf);
    if (err && err->obj) {
        int code = _store_error_code(err->obj);
        const char *what = _store_error_what(err->obj);
        fprintf(stderr, "  URLRequest error: %d — %s\n", code, what ? what : "?");
    }

    struct shared_ptr *resp = _urlreq_response(urlreq_buf);
    if (resp && resp->obj) {
        struct shared_ptr *underlying = _urlresp_underlying(resp->obj);
        if (underlying && underlying->obj) {
            void *data_ptr = *(void**)((char*)underlying->obj + 48);
            if (data_ptr) {
                char *body = _data_bytes(data_ptr);
                size_t len  = _data_length(data_ptr);
                printf("\n--- Response body (%zu bytes) ---\n", len);
                if (body && len > 0) {
                    fwrite(body, 1, len < 4096 ? len : 4096, stdout);
                    printf("\n");
                    /* Save raw body for the next stage */
                    const char *out = argc > 3 ? argv[3] : "/tmp/stage6-spim.bin";
                    FILE *f = fopen(out, "wb");
                    if (f) {
                        fwrite(body, 1, len, f);
                        fclose(f);
                        printf("[stage6] Saved %zu bytes to %s\n", len, out);
                    } else {
                        fprintf(stderr, "[stage6] WARNING: could not save to %s\n", out);
                    }
                }
            }
        }
    }

    printf("\n[stage6] Done.\n");
    return 0;
}
