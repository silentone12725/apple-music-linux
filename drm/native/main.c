/*
 * main.c — the FairPlay session of the vendored Apple Music wrapper (library mode).
 *
 * It runs inside libdrm_client.so, on top of Apple's Android libraries loaded through libhybris: it builds the
 * request context, signs in (dialogHandler / credentialHandler answer Apple's prompts through the host's callback),
 * fetches the storefront, developer token and music token, holds the playback lease, and derives the FairPlay key
 * contexts (getKdContext) that drm_lib.c hands to the Go engine. The wrapper's standalone TCP services (decrypt, m3u8,
 * account, key and MV ports) and its command-line entry point were removed: nothing in Adam used them.
 */
#include <errno.h>
#include <stdint.h>
#include <setjmp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <pthread.h>
#include <stdarg.h>

#ifdef _WIN32
static inline int hybris_windows_setenv(const char *name, const char *value,
                                        int overwrite)
{
    if (!overwrite && getenv(name) != NULL) return 0;
    return _putenv_s(name, value != NULL ? value : "");
}
#define setenv hybris_windows_setenv
#endif
#include <sys/stat.h>

#include "import.h"
#include "args.h"
#include "cJSON.h"
#include "music_token_request.h"
#include "subscription_status.h"

struct shared_ptr apInf;
uint8_t leaseMgr[16];
struct shared_ptr reqCtx;
struct adam_args args_info;
char *amUsername, *amPassword;
/* Length of the bare password in amPassword. Apple asks for the 2FA code once
 * per attempt and the code is appended to the password, so it is cut back to
 * this length first; otherwise a second prompt sends password+code1+code2. */
size_t amPasswordLen;
size_t amPasswordCap; /* capacity of the buffer amPassword points into */
/* The reason the last sign-in failed (Apple's own wording when it gave one), for the host to show. */
char g_last_auth_error[256];
/* Set when the host gave no verification code (the user cancelled or the wait ran out). */
static int g_auth_cancelled;
/* Title and text of the last dialog Apple raised during the sign-in ("Forgot Your Password?: ..."). */
static char g_last_dialog[384];
static pthread_mutex_t g_last_dialog_lock = PTHREAD_MUTEX_INITIALIZER; /* the dialog thread writes it, the login thread reads it */
struct shared_ptr g_GUID;
int offlineFlag;
char *device_infos[9];

char *g_storefront_id = NULL;
char *g_dev_token = NULL;
char *g_music_token = NULL;

/* Host callbacks, set by drm_lib_init(). */
#include "drm_lib.h"
drm_auth_cb_t  g_drm_auth_cb  = NULL;
void          *g_drm_auth_ud  = NULL;
drm_state_cb_t g_drm_state_cb = NULL;
void          *g_drm_state_ud = NULL;

/* Write a single-word state token to base_dir/drm-state.
 * The Go engine reads this file via inotify to track wrapper lifecycle.
 * States: STARTING  LOGIN  WAITING_2FA  INITIALIZING_FAIRPLAY  RUNNING
 *         RECOVERY  FAILED  STOPPED
 * In library mode, also fires g_drm_state_cb if set.
 */
static void write_drm_state(const char *state) {
    if (g_drm_state_cb) g_drm_state_cb(state, g_drm_state_ud);
    if (!args_info.base_dir_arg) return;
    char path[512];
    snprintf(path, sizeof(path), "%s/drm-state", args_info.base_dir_arg);
    FILE *fp = fopen(path, "w");
    if (!fp) return;
    fprintf(fp, "%s\n", state);
    fclose(fp);
}

/* Protects preshareCtx against concurrent access from the main decrypt
 * thread (handle/getKdContext) and the recovery worker (refresh_decrypt_ctx).
 * Using PTHREAD_MUTEX_INITIALIZER avoids the need for an explicit init call. */
static pthread_mutex_t g_ctx_mutex = PTHREAD_MUTEX_INITIALIZER;

/* base_dir + name in the caller's buffer, for files the wrapper touches itself. */
/* base_dir + name in a new allocation that lives as long as the request context (see below). */
static char *base_dir_join(const char *name) {
    const char *base = args_info.base_dir_arg ? args_info.base_dir_arg : "";
    size_t n = strlen(base) + strlen(name) + 1;
    char *r = malloc(n);
    if (r) snprintf(r, n, "%s%s", base, name);
    return r ? r : "";
}

static const char *base_path(char *buf, size_t n, const char *name) {
    snprintf(buf, n, "%s%s", args_info.base_dir_arg ? args_info.base_dir_arg : "", name);
    return buf;
}

/* Strings handed to Apple's libraries through new_std_string() are not copied: the std::string points at the buffer, so a
 * buffer the library may keep (the request context's paths, the HTTP body) must stay allocated. Those few one-off
 * allocations are made once per initialisation and deliberately never freed. */

/* The statically-linked SQLite inside libmediaplatform uses the bionic (unix)
 * VFS, whose unixFullPathname() treats any path not starting with '/' as
 * relative and prepends getcwd(). A Windows path like "C:\Users\..." is thus
 * mangled into "C:\adam-build/C:\Users\...", and the DB open fails ("Database
 * connection lost or invalid."). Hand libmediaplatform a POSIX-absolute path
 * ("/C:/Users/...") so the VFS takes its absolute branch — no getcwd, no lstat
 * symlink loop. The hook table (windows_hook_table.c) strips the leading '/'
 * back off before the real Win32 open(). Backslashes become forward slashes.
 * A path that is already POSIX-absolute is returned unchanged. */
char *drm_posix_path(const char *win) {
    if (!win) return NULL;
    size_t n = strlen(win);
    char *r = malloc(n + 2);
    if (!r) return NULL;
    size_t j = 0;
    if (win[0] != '/') r[j++] = '/';   /* prepend '/' for "C:\..." style */
    for (size_t i = 0; i < n; i++) r[j++] = (win[i] == '\\') ? '/' : win[i];
    r[j] = '\0';
    return r;
}

static void __attribute__((sysv_abi)) dialogHandler(int64_t j, struct shared_ptr *protoDialogPtr,
                          struct shared_ptr *respHandler) {
    const char *const title = std_string_data(
        _ZNK17storeservicescore14ProtocolDialog5titleEv(protoDialogPtr->obj));
    const char *const dialog_text = std_string_data(_ZNK17storeservicescore14ProtocolDialog7messageEv(
        protoDialogPtr->obj));
    DRM_DEBUG("[.] dialogHandler: {title: %s, message: %s}\n", title, dialog_text);
    if (title && *title && strcmp(title, "Sign In") != 0) {
        /* Keep what Apple said: the host shows it, and tells a locked account from a wrong password by it. */
        pthread_mutex_lock(&g_last_dialog_lock);
        if (dialog_text && *dialog_text)
            snprintf(g_last_dialog, sizeof(g_last_dialog), "%s: %s", title, dialog_text);
        else
            snprintf(g_last_dialog, sizeof(g_last_dialog), "%s", title);
        pthread_mutex_unlock(&g_last_dialog_lock);
    }

    /* The library keeps this response (and its control block) after the handler returns and processes it on another
     * thread, so it must not live on this stack frame. Never freed: the library holds shared references. */
    unsigned char *const ptr = calloc(1, 72);
    *(void **)(ptr) =
        &_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore22ProtocolDialogResponseENS_9allocatorIS2_EEEE +
        2;
    struct shared_ptr diagResp = {.obj = ptr + 24, .ctrl_blk = ptr};
    _ZN17storeservicescore22ProtocolDialogResponseC1Ev(diagResp.obj);

    struct std_vector *butVec =
        _ZNK17storeservicescore14ProtocolDialog7buttonsEv(protoDialogPtr->obj);
    int btn_count = (int)((struct shared_ptr *)butVec->end - (struct shared_ptr *)butVec->begin);
    fprintf(stderr, "[.] dialogHandler: title='%s' buttons=%d\n", title ? title : "", btn_count);
    int chosen_idx = 0; /* default: first (dismiss/cancel) */

    if (title && strcmp("Sign In", title) == 0) {
        /* Apple's "Use Existing Apple ID" button. A response with no selected button makes the library dereference NULL, so
         * if the label ever differs (another wording or locale) take the first button instead of leaving none. */
        struct shared_ptr *pick = NULL;
        for (struct shared_ptr *b = butVec->begin; b != butVec->end; ++b) {
            const char *bt = std_string_data(_ZNK17storeservicescore14ProtocolButton5titleEv(b->obj));
            if (bt && strcmp("Use Existing Apple ID", bt) == 0) {
                pick = b;
                break;
            }
        }
        if (!pick && btn_count >= 1) {
            fprintf(stderr, "[!] dialogHandler: no 'Use Existing Apple ID' button among %d, using the first\n", btn_count);
            pick = (struct shared_ptr *)butVec->begin;
        }
        if (pick)
            _ZN17storeservicescore22ProtocolDialogResponse17setSelectedButtonERKNSt6__ndk110shared_ptrINS_14ProtocolButtonEEE(
                diagResp.obj, pick);
    } else if (amUsername && g_drm_auth_cb && btn_count >= 1) {
        /* During sign-in, surface any dialog with at least one button to the user
         * (e.g. the "Text code / Get a call / Can't use ..." phone-OTP sub-menu
         * that Apple raises after "Can't get to your devices?", which may have
         * just one option when the account has no call option). */
        char type_buf[512];
        size_t pos = (size_t)snprintf(type_buf, sizeof(type_buf), "dialog_choice:");
        /* snprintf returns the length it would have written, so a long title or button list must not advance pos past the
         * buffer: the next call would get a huge size and write out of bounds. */
        if (title && *title && pos < sizeof(type_buf))
            pos += (size_t)snprintf(type_buf + pos, sizeof(type_buf) - pos, "%s", title);
        for (struct shared_ptr *b = butVec->begin; b != butVec->end && pos < sizeof(type_buf); ++b) {
            const char *btn_title = std_string_data(
                _ZNK17storeservicescore14ProtocolButton5titleEv(b->obj));
            if (btn_title)
                pos += (size_t)snprintf(type_buf + pos, sizeof(type_buf) - pos, "\n%s", btn_title);
        }

        char choice[8] = {0};
        write_drm_state("WAITING_DIALOG");
        g_drm_auth_cb(type_buf, choice, sizeof(choice), g_drm_auth_ud);

        /* Reply is a decimal button index ("0", "1", "2"). An empty reply means nobody answered (cancelled,
         * timed out, shut down): dismiss with a Cancel-like button rather than the first one, which can be
         * "Text code" and would send an SMS nobody asked for. */
        if (choice[0] >= '0' && choice[0] <= '9') {
            int idx = choice[0] - '0';
            chosen_idx = (idx < btn_count) ? idx : 0;
        } else {
            chosen_idx = btn_count - 1; /* no Cancel-like title: the last button is the dismissal in Apple's menus */
            int i = 0;
            for (struct shared_ptr *b = butVec->begin; b != butVec->end; ++b, ++i) {
                const char *bt = std_string_data(_ZNK17storeservicescore14ProtocolButton5titleEv(b->obj));
                if (bt && (strcasecmp(bt, "Cancel") == 0 || strcasecmp(bt, "Not Now") == 0 ||
                           strcasecmp(bt, "Close") == 0 || strcasecmp(bt, "Dismiss") == 0)) {
                    chosen_idx = i;
                    break;
                }
            }
            fprintf(stderr, "[.] dialogHandler: no answer, dismissing with button %d\n", chosen_idx);
        }

        struct shared_ptr *picked = (struct shared_ptr *)butVec->begin + chosen_idx;
        DRM_DEBUG("[.] dialogHandler: user picked button %d '%s'\n",
            chosen_idx,
            std_string_data(_ZNK17storeservicescore14ProtocolButton5titleEv(picked->obj)));
        _ZN17storeservicescore22ProtocolDialogResponse17setSelectedButtonERKNSt6__ndk110shared_ptrINS_14ProtocolButtonEEE(
            diagResp.obj, picked);
    } else {
        // Auto-dismiss: select the first button ("Not Now" for concurrent-stream dialogs, etc.).
        // Without a selected button handleProtocolDialogResponse dereferences NULL → SIGSEGV.
        struct shared_ptr *first_btn = butVec->begin;
        if (first_btn != (struct shared_ptr *)butVec->end) {
            DRM_DEBUG("[.] dialogHandler: auto-dismissing '%s'\n",
                    std_string_data(
                        _ZNK17storeservicescore14ProtocolButton5titleEv(
                            first_btn->obj)));
            _ZN17storeservicescore22ProtocolDialogResponse17setSelectedButtonERKNSt6__ndk110shared_ptrINS_14ProtocolButtonEEE(
                diagResp.obj, first_btn);
        }
    }
    if (btn_count < 1) {
        /* Nothing to select, and answering with no button would crash the library. */
        fprintf(stderr, "[!] dialogHandler: dialog '%s' has no buttons, not answering\n", title ? title : "");
        return;
    }
    _ZN20androidstoreservices28AndroidPresentationInterface28handleProtocolDialogResponseERKlRKNSt6__ndk110shared_ptrIN17storeservicescore22ProtocolDialogResponseEEE(
        apInf.obj, &j, &diagResp);
}

static void __attribute__((sysv_abi)) credentialHandler(struct shared_ptr *credReqHandler,
                              struct shared_ptr *credRespHandler) {
    const uint8_t need2FA =
        _ZNK17storeservicescore18CredentialsRequest28requiresHSA2VerificationCodeEv(
            credReqHandler->obj);
    fprintf(
        stderr, "[.] credentialHandler: {title: %s, message: %s, 2FA: %s}\n",
        std_string_data(_ZNK17storeservicescore18CredentialsRequest5titleEv(
            credReqHandler->obj)),
        std_string_data(_ZNK17storeservicescore18CredentialsRequest7messageEv(
            credReqHandler->obj)),
        need2FA ? "true" : "false");

    int cancelled = 0;
    if (!amUsername || !amPassword) {
        /* Nobody is signing in (the credentials are dropped once a sign-in ends): Apple wants the
         * account again mid-session, e.g. an expired token. Answering would resubmit an old password
         * or ask for a code nobody expects; cancel and let the host show its own sign-in. */
        fprintf(stderr, "[.] credentialHandler: no sign-in in progress, cancelling the request\n");
        cancelled = 1;
    }
    if (!cancelled && amPasswordLen && strlen(amPassword) > amPasswordLen)
        amPassword[amPasswordLen] = '\0';

    int responseType = cancelled ? 0 : 2;
    if (need2FA && !cancelled) {
        write_drm_state("WAITING_2FA");
        if (g_drm_auth_cb) {
            /* library mode: ask the Go engine for the 2FA code (or a special action) */
            char code[32] = {0};
            g_drm_auth_cb("2fa", code, sizeof(code), g_drm_auth_ud);
            if (code[0] == '\0') {
                /* No code: answering with the bare password would only count as another wrong attempt
                 * at Apple, and repeated ones lock the account. Cancel instead. */
                cancelled = 1;
                g_auth_cancelled = 1;
            } else if (strncmp(code, "__resend__", 10) == 0) {
                /* User wants Apple to re-send the notification to trusted devices.
                 * Response type 1 tells AuthenticateFlow to resend without submitting a code.
                 * amPassword stays as-is (no code appended). */
                responseType = 1;
            } else if (strncmp(code, "__cant_devices__", 16) == 0) {
                /* User can't access trusted devices: response type 3 tells AuthenticateFlow to
                 * show the phone-OTP sub-menu (text/call), which arrives as a ProtocolDialog
                 * through dialogHandler. amPassword stays as-is. */
                responseType = 3;
            } else {
                /* The password and the code share one buffer; the host caps the password, this is the second guard. */
                size_t have = strlen(amPassword);
                if (have + 6 < amPasswordCap) {
                    size_t cl = strnlen(code, 6);
                    memcpy(amPassword + have, code, cl);
                    amPassword[have + cl] = '\0';
                } else {
                    /* No room for the code: sending the bare password would count as another wrong attempt. */
                    cancelled = 1;
                    g_auth_cancelled = 1;
                }
            }
        } else {
            /* No host to ask: answering with the bare password would count as another wrong attempt. */
            cancelled = 1;
            g_auth_cancelled = 1;
        }
    }

    uint8_t *const ptr = malloc(80);
    memset(ptr + 8, 0, 16);
    *(void **)(ptr) =
        &_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore19CredentialsResponseENS_9allocatorIS2_EEEE +
        2;
    struct shared_ptr credResp = {.obj = ptr + 24, .ctrl_blk = ptr};
    _ZN17storeservicescore19CredentialsResponseC1Ev(credResp.obj);

    DRM_DEBUG("[.] credential payload lengths: username=%zu password=%zu\n", amUsername ? strlen(amUsername) : 0, amPassword ? strlen(amPassword) : 0);
    union std_string username = new_std_string(cancelled ? "" : amUsername);
    _ZN17storeservicescore19CredentialsResponse11setUserNameERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        credResp.obj, &username);

    union std_string password = new_std_string(cancelled ? "" : amPassword);
    _ZN17storeservicescore19CredentialsResponse11setPasswordERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        credResp.obj, &password);

    if (cancelled) responseType = 0;
    _ZN17storeservicescore19CredentialsResponse15setResponseTypeENS0_12ResponseTypeE(
        credResp.obj, responseType);
    /* Response types (AuthenticateFlow::_buttonActionForResponseType):
     *   0 = Cancel (first button) — ends the flow as cancelled
     *   1 = Resend notification to trusted devices
     *   2 = OK / submit code (second button, confirmed)
     *   3 = Can't get to your devices — triggers ProtocolDialog sub-menu via dialogHandler
     * 1 was previously documented as "no answer" but maps to the resend action. */

    _ZN20androidstoreservices28AndroidPresentationInterface25handleCredentialsResponseERKNSt6__ndk110shared_ptrIN17storeservicescore19CredentialsResponseEEE(
        apInf.obj, &credResp);
}

void drm_init_internal(void) {
    // srand(time(0));

    // raise(SIGSTOP);
    DRM_DEBUG("[+] starting...\n");
    setenv("ANDROID_DNS_MODE", "local", 1);

    static const char *resolvers[2] = {"1.1.1.1", "8.8.8.8"};
    _resolv_set_nameservers_for_net(0, resolvers, 2, ".");

    // static char android_id[16];
    // for (int i = 0; i < 16; ++i) {
    //     android_id[i] = "0123456789abcdef"[rand() % 16];
    // }
    union std_string conf1 = new_std_string(device_infos[8]);
    union std_string conf2 = new_std_string("");
    DRM_DEBUG("[trace] before FootHillConfig\n");
    _ZN14FootHillConfig6configERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE(
        &conf1);
    DRM_DEBUG("[trace] after FootHillConfig\n");

    // union std_string root = new_std_string("/");
    // union std_string natLib = new_std_string("/system/lib64/");
    // void *foothill = malloc(120);
    // _ZN8FootHillC2ERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEES8_(
    //     foothill, &root, &natLib);
    // _ZN8FootHill24defaultContextIdentifierEv(foothill);

    DRM_DEBUG("[trace] before DeviceGUID::instance\n");
    _ZN17storeservicescore10DeviceGUID8instanceEv(&g_GUID);
    DRM_DEBUG("[trace] after DeviceGUID::instance obj=%p\n", g_GUID.obj);

    static uint8_t ret[88];
    static unsigned int conf3 = 29;
    static uint8_t conf4 = 1;
    DRM_DEBUG("[trace] before DeviceGUID::configure\n");
    _ZN17storeservicescore10DeviceGUID9configureERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_RKjRKb(
        &ret, g_GUID.obj, &conf1, &conf2, &conf3, &conf4);
    DRM_DEBUG("[trace] after DeviceGUID::configure\n");
}

void install_request_context_callbacks(void *cfg);

struct shared_ptr drm_init_ctx(void) {
    DRM_DEBUG("[+] initializing ctx...\n");
    union std_string strBuf =
        new_std_string(drm_posix_path(base_dir_join("/mpl_db")));

    struct shared_ptr reqCtx;
    DRM_DEBUG("[cp1] make_shared RequestContext\n");
    _ZNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEE11make_sharedIJRNS_12basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEEEEES3_DpOT_(
        &reqCtx, &strBuf);

    DRM_DEBUG("[cp2] setup vtable ptr arr=%p arr+2=%p\n",
        &_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore20RequestContextConfigENS_9allocatorIS2_EEEE,
        &_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore20RequestContextConfigENS_9allocatorIS2_EEEE + 2); fflush(stderr);
    static uint8_t ptr[480];
    *(void **)(ptr) =
        &_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore20RequestContextConfigENS_9allocatorIS2_EEEE +
        2;
    struct shared_ptr reqCtxCfg = {.obj = ptr + 32, .ctrl_blk = ptr};
    DRM_DEBUG("[cp3] reqCtxCfg ctrl_blk=%p obj=%p vptr=%p\n", reqCtxCfg.ctrl_blk, reqCtxCfg.obj, *(void**)ptr);

    DRM_DEBUG("[cp4] RequestContextConfigC2\n");
    _ZN17storeservicescore20RequestContextConfigC2Ev(reqCtxCfg.obj);
    DRM_DEBUG("[cp5] setBaseDirectoryPath\n");
    _ZN17storeservicescore20RequestContextConfig20setBaseDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp6] setClientIdentifier\n");
    strBuf = new_std_string(device_infos[0]);
    _ZN17storeservicescore20RequestContextConfig19setClientIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp7] setVersionIdentifier\n");
    strBuf = new_std_string(device_infos[1]);
    _ZN17storeservicescore20RequestContextConfig20setVersionIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp8] setPlatformIdentifier\n");
    strBuf = new_std_string(device_infos[2]);
    _ZN17storeservicescore20RequestContextConfig21setPlatformIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp9] setProductVersion\n");
    strBuf = new_std_string(device_infos[3]);
    _ZN17storeservicescore20RequestContextConfig17setProductVersionERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp10] setDeviceModel\n");
    strBuf = new_std_string(device_infos[4]);
    _ZN17storeservicescore20RequestContextConfig14setDeviceModelERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp11] setBuildVersion\n");
    strBuf = new_std_string(device_infos[5]);
    _ZN17storeservicescore20RequestContextConfig15setBuildVersionERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp12] setLocaleIdentifier\n");
    strBuf = new_std_string(device_infos[6]);
    _ZN17storeservicescore20RequestContextConfig19setLocaleIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);
    DRM_DEBUG("[cp13] setLanguageIdentifier\n");
    strBuf = new_std_string(device_infos[7]);
    _ZN17storeservicescore20RequestContextConfig21setLanguageIdentifierERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtxCfg.obj, &strBuf);

    /* Builds that expect host callbacks (4.9.x/5.x) get them here; a no-op when the libs export no such setters. */
    install_request_context_callbacks(reqCtxCfg.obj);

    DRM_DEBUG("[cp14] RequestContextManager::configure\n");
    _ZN21RequestContextManager9configureERKNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEEE(
        &reqCtx);
    DRM_DEBUG("[cp15] RequestContext::init\n");
    static uint8_t buf[88];
    _ZN17storeservicescore14RequestContext4initERKNSt6__ndk110shared_ptrINS_20RequestContextConfigEEE(
        &buf, reqCtx.obj, &reqCtxCfg);
    DRM_DEBUG("[cp16] setFairPlayDirectoryPath\n");
    strBuf = new_std_string(drm_posix_path(args_info.base_dir_arg));
    _ZN17storeservicescore14RequestContext24setFairPlayDirectoryPathERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(
        reqCtx.obj, &strBuf);

    DRM_DEBUG("[cp17] make_shared AndroidPresentationInterface\n");
    _ZNSt6__ndk110shared_ptrIN20androidstoreservices28AndroidPresentationInterfaceEE11make_sharedIJEEES3_DpOT_(
        &apInf);

    DRM_DEBUG("[cp18] setDialogHandler\n");
    _ZN20androidstoreservices28AndroidPresentationInterface16setDialogHandlerEPFvlNSt6__ndk110shared_ptrIN17storeservicescore14ProtocolDialogEEENS2_INS_36AndroidProtocolDialogResponseHandlerEEEE(
        apInf.obj, &dialogHandler);

    DRM_DEBUG("[cp19] setCredentialsHandler\n");
    _ZN20androidstoreservices28AndroidPresentationInterface21setCredentialsHandlerEPFvNSt6__ndk110shared_ptrIN17storeservicescore18CredentialsRequestEEENS2_INS_33AndroidCredentialsResponseHandlerEEEE(
        apInf.obj, &credentialHandler);

    DRM_DEBUG("[cp20] setPresentationInterface\n");
    _ZN17storeservicescore14RequestContext24setPresentationInterfaceERKNSt6__ndk110shared_ptrINS_21PresentationInterfaceEEE(
        reqCtx.obj, &apInf);

    DRM_DEBUG("[cp21] init_ctx done\n");
    return reqCtx;
}

extern uint8_t endLeaseCallback[32];
extern uint8_t pbErrCallback[32];
extern void hybris_init_callbacks(void);
extern void  start_recovery_thread(void);
extern int   is_recovery_active(void);
/* Returns current RecoveryState as int: 0=Running 1=Scheduled 2=Refreshing 3=Failed */
extern int   get_recovery_state(void);

uint8_t login(struct shared_ptr reqCtx) {
    DRM_DEBUG("[+] logging in...\n");
    g_last_auth_error[0] = '\0';
    g_auth_cancelled = 0;
    pthread_mutex_lock(&g_last_dialog_lock);
    g_last_dialog[0] = '\0';
    pthread_mutex_unlock(&g_last_dialog_lock);
    struct shared_ptr flow;
    _ZNSt6__ndk110shared_ptrIN17storeservicescore16AuthenticateFlowEE11make_sharedIJRNS0_INS1_14RequestContextEEEEEES3_DpOT_(
        &flow, &reqCtx);
    _ZN17storeservicescore16AuthenticateFlow3runEv(flow.obj);
    struct shared_ptr *resp =
        _ZNK17storeservicescore16AuthenticateFlow8responseEv(flow.obj);
    if (resp == NULL || resp->obj == NULL) {
        snprintf(g_last_auth_error, sizeof(g_last_auth_error), "Apple did not answer the sign-in request");
        return 0;
    }
    const int respType =
        _ZNK17storeservicescore20AuthenticateResponse12responseTypeEv(
            resp->obj);
    if (respType != 6) {
        const char *customer_msg = std_string_data(
            _ZNK17storeservicescore20AuthenticateResponse15customerMessageEv(resp->obj));
        if (customer_msg && *customer_msg) {
            fprintf(stderr, "[!] server message: %s\n", customer_msg);
            snprintf(g_last_auth_error, sizeof(g_last_auth_error), "%s", customer_msg);
        }
        pthread_mutex_lock(&g_last_dialog_lock);
        if (g_last_dialog[0])
            snprintf(g_last_auth_error, sizeof(g_last_auth_error), "%s", g_last_dialog);
        pthread_mutex_unlock(&g_last_dialog_lock);

        struct shared_ptr *err = _ZNK17storeservicescore20AuthenticateResponse5errorEv(resp->obj);
        if (err != NULL && err->obj != NULL) {
            int code = store_error_code(err->obj);
            const char *what = _ZNK17storeservicescore19StoreErrorCondition4whatEv(err->obj);
#ifdef _WIN32
            /* StoreErrorCondition keeps the platform error code 80 bytes in. */
            int64_t external_code = *(int64_t *)((char *)err->obj + 80);
            fprintf(stderr, "[!] auth error: code=%d, external=%lld, message=%s\n", code, (long long)external_code, what ? what : "none");
#else
            fprintf(stderr, "[!] auth error: code=%d, message=%s\n", code, what ? what : "none");
#endif
            if (!g_last_auth_error[0])
                snprintf(g_last_auth_error, sizeof(g_last_auth_error), "Apple rejected the sign-in");
        } else {

            fprintf(stderr, "[!] auth failed: response type %d\n", respType);
            if (!g_last_auth_error[0])
                snprintf(g_last_auth_error, sizeof(g_last_auth_error), "Apple rejected the sign-in");
        }
    }
    if (g_auth_cancelled && respType != 6)
        snprintf(g_last_auth_error, sizeof(g_last_auth_error), "Sign-in cancelled");
    if (respType == 6) {
        /* Only a successful sign-in replaces the old tokens: a wrong password must not sign the
         * existing session out. */
        char p[1100];
        remove(base_path(p, sizeof(p), "/STOREFRONT_ID"));
        remove(base_path(p, sizeof(p), "/MUSIC_TOKEN"));
    }
    return respType == 6;
    // struct shared_ptr subStatMgr;
    // _ZN20androidstoreservices30SVSubscriptionStatusMgrFactory6createEv(&subStatMgr);
    // struct shared_ptr data;
    // int method = 2;
    // _ZN20androidstoreservices27SVSubscriptionStatusMgrImpl33checkSubscriptionStatusFromSourceERKNSt6__ndk110shared_ptrIN17storeservicescore14RequestContextEEERKNS_23SVSubscriptionStatusMgr26SVSubscriptionStatusSourceE(&data,
    // subStatMgr.obj, &reqCtx, &method);
    // return 1;
}

void *FHinstance = NULL;   /* SVFootHillSessionCtrl 单例 (会话持有者) */
void *preshareCtx = NULL;  /* prefetch 上下文缓存 (adam=="0" 时复用) */

/*
 * 派生某 (adam, uri) 的 kdContext (解密上下文)。
 *
 * 流程:
 *   getPersistentKey() 从 Apple 获取持久密钥 (SVFootHillPKey, 首个字段 ckc=contentKey,
 *   离线场景由服务端账户派生) → decryptContext(persistK) 得到 SVFootHillPContext →
 *   .kdContext() 返回实际 kdContext 指针。
 *
 * 注意:
 *   - 返回的是 void** (指向 kdContext 指针), 调用方需解引用 (如 NfcR(*kdContext,...))。
 *   - adam=="0" 走 prefetch 缓存路径。
 *   - 每次调用都会重新 getPersistentKey (contentKey 每次会话会变),
 *     但 decryptContext 派生的 kdContext 是 per-track 稳定的。
 */
void *getKdContext(const char *const adam,
                                 const char *const uri) {
    uint8_t isPreshare = (strcmp("0", adam) == 0);

    /* Fast-path: return cached preshare context if available.
     * Lock only long enough to read the pointer — the long FairPlay
     * network operations below must NOT be performed under this lock,
     * or the recovery worker would block all decryption during reacquisition. */
    if (isPreshare) {
        pthread_mutex_lock(&g_ctx_mutex);
        void *cached = preshareCtx;
        pthread_mutex_unlock(&g_ctx_mutex);
        if (cached != NULL)
            return cached;
    }

#ifdef _WIN32
    /* The Android key-session path assumes a device token exists. If token
     * acquisition failed, it can throw from the guest library while trying
     * to negotiate a key. Fail the request cleanly and let auth recover. */
    if (g_dev_token == NULL || g_dev_token[0] == '\0') {
        fprintf(stderr, "[drm] key context unavailable: device token is missing\n");
        return NULL;
    }
#endif
    DRM_DEBUG("[.] adamId: %s, uri: %s\n", adam, uri);

    union std_string defaultId = new_std_string(adam);
    union std_string keyUri = new_std_string(uri);
    union std_string keyFormat =
        new_std_string("com.apple.streamingkeydelivery");
    union std_string keyFormatVer = new_std_string("1");
    union std_string serverUri = new_std_string(
        "https://play.itunes.apple.com/WebObjects/MZPlay.woa/music/fps");
    union std_string protocolType = new_std_string("simplified");
    union std_string fpsCert = new_std_string(fairplayCert);

    struct shared_ptr persistK = {.obj = NULL};
    _ZN21SVFootHillSessionCtrl16getPersistentKeyERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEES8_S8_S8_S8_S8_S8_S8_(
        &persistK, FHinstance, &defaultId, &defaultId, &keyUri, &keyFormat,
        &keyFormatVer, &serverUri, &protocolType, &fpsCert);

    if (persistK.obj == NULL)
        return NULL;

    struct shared_ptr SVFootHillPContext;
    _ZN21SVFootHillSessionCtrl14decryptContextERKNSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEERKN11SVDecryptor15SVDecryptorTypeERKb(
        &SVFootHillPContext, FHinstance, persistK.obj);

    if (SVFootHillPContext.obj == NULL)
        return NULL;

    void *kdContext =
        *_ZNK18SVFootHillPContext9kdContextEv(SVFootHillPContext.obj);

    /* Store result under lock so the recovery worker sees a consistent value
     * if it concurrently resets preshareCtx to NULL. */
    if (kdContext != NULL && isPreshare) {
        pthread_mutex_lock(&g_ctx_mutex);
        preshareCtx = kdContext;
        pthread_mutex_unlock(&g_ctx_mutex);
    }

    return kdContext;
}

/* Bumped on every recovery refresh so callers can drop cached key contexts. */
volatile unsigned g_decrypt_epoch = 0;

/* Serialises every call into Apple's FairPlay code (key opens, sample decrypts, this reset). Holding it
 * here also means no decrypt can run on a context resetAllContexts() is freeing. */
pthread_mutex_t g_fp_call_mutex = PTHREAD_MUTEX_INITIALIZER;

/* Refreshes the decrypt session: a new playback lease, every cached key context dropped, the prefetch context rebuilt. */
void refresh_decrypt_ctx(void) {
    uint8_t autom = 1;
    pthread_mutex_lock(&g_fp_call_mutex);
    __atomic_add_fetch(&g_decrypt_epoch, 1, __ATOMIC_SEQ_CST);

    /* Request a new playback lease from Apple. */
    _ZN22SVPlaybackLeaseManager12requestLeaseERKb(leaseMgr, &autom);

    /* Tear down all cached FairPlay key contexts so fresh keys are derived. */
    _ZN21SVFootHillSessionCtrl16resetAllContextsEv(FHinstance);

    /* Invalidate the preshare cache under lock before rebuilding it.
     * Any concurrent getKdContext() call will miss the cache and fall through
     * to a full key derivation — correct behaviour during recovery. */
    pthread_mutex_lock(&g_ctx_mutex);
    preshareCtx = NULL;
    pthread_mutex_unlock(&g_ctx_mutex);

    /* Rebuild the preshare context.  getKdContext() will write the new pointer
     * under g_ctx_mutex internally. */
    getKdContext("0", "skd://itunes.apple.com/P000000000/s1/e1");

    pthread_mutex_unlock(&g_fp_call_mutex);
    fprintf(stderr, "[!] refreshed context\n");
}

/* Called by the recovery worker to determine whether reacquisition produced
 * a usable decrypt context.  Reads preshareCtx under g_ctx_mutex. */
int is_preshare_ctx_ready(void) {
    pthread_mutex_lock(&g_ctx_mutex);
    int ready = (preshareCtx != NULL);
    pthread_mutex_unlock(&g_ctx_mutex);
    return ready;
}

char* get_account_storefront_id(struct shared_ptr reqCtx) {
    union std_string *region = malloc(sizeof(union std_string));
    struct shared_ptr urlbag = {.obj = 0x0, .ctrl_blk = 0x0};
    _ZNK17storeservicescore14RequestContext20storeFrontIdentifierERKNSt6__ndk110shared_ptrINS_6URLBagEEE(region, reqCtx.obj, &urlbag);
    const char *region_str = std_string_data(region);
    if (region_str) {
        char *result = strdup(region_str); 
        free(region);
        return result;
    } 
    return NULL;
}

void write_storefront_id(void) {
    char p[1100];
    FILE *fp = fopen(base_path(p, sizeof(p), "/STOREFRONT_ID"), "w");
    if (!fp) return;
    DRM_DEBUG("[+] StoreFront ID: %s\n", g_storefront_id);
    fprintf(fp, "%s", g_storefront_id);
    fclose(fp);
}

char *get_guid() {
    char *ret[2];
    _ZN17storeservicescore10DeviceGUID4guidEv(ret, g_GUID.obj);
    char *raw = _ZNK13mediaplatform4Data5bytesEv(ret[0]);
    size_t len = _ZNK13mediaplatform4Data6lengthEv(ret[0]);
    /* Data::bytes() is NOT null-terminated — copy to a null-terminated buffer */
    char *guid = malloc(len + 1);
    if (!guid) return NULL;
    memcpy(guid, raw, len);
    guid[len] = '\0';
    return guid;
}

long long getCurrentTimeMillis() {
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return tv.tv_sec * 1000LL + tv.tv_usec / 1000;
}

char *get_music_user_token(char *guid, char *authToken, struct shared_ptr reqCtx){
    uint8_t *ptr = (uint8_t *)calloc(1, 2048);
    if (!ptr) return NULL;
    *(void **)(ptr) =
        &_ZTVNSt6__ndk120__shared_ptr_emplaceIN13mediaplatform11HTTPMessageENS_9allocatorIS2_EEEE +
        2;
    struct shared_ptr httpMessage = {.obj = ptr + 32, .ctrl_blk = ptr};
    union std_string url = new_std_string("https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/createMusicToken");
    union std_string method = new_std_string("POST");
    _ZN13mediaplatform11HTTPMessageC2ENSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES7_(httpMessage.obj, &url, &method);
    union std_string contentTypeHeader = new_std_string("Content-Type");
    union std_string contentTypeValue = new_std_string("application/json; charset=UTF-8");
    _ZN13mediaplatform11HTTPMessage9setHeaderERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(httpMessage.obj, &contentTypeHeader, &contentTypeValue);
    union std_string expectHeader = new_std_string("Expect");
    union std_string expectValue = new_std_string("");
    _ZN13mediaplatform11HTTPMessage9setHeaderERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(httpMessage.obj, &expectHeader, &expectValue);
    union std_string bundleIdHeader = new_std_string("X-Apple-Requesting-Bundle-Id");
    union std_string bundleIdValue = new_std_string("com.apple.android.music");
    _ZN13mediaplatform11HTTPMessage9setHeaderERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(httpMessage.obj, &bundleIdHeader, &bundleIdValue);
    union std_string bundleVersionHeader = new_std_string("X-Apple-Requesting-Bundle-Version");
    union std_string bundleVersionValue = new_std_string("Music/4.9 Android/10 model/Samsung S9 build/7663313 (dt:66)");
    _ZN13mediaplatform11HTTPMessage9setHeaderERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(httpMessage.obj, &bundleVersionHeader, &bundleVersionValue);
    /* The assertion is a JWT that can exceed any fixed buffer; serialise it with cJSON (PR #1). */
    char *body = drm_music_token_request(guid, authToken, getCurrentTimeMillis());
    if (body == NULL) {
        return NULL;
    }

    _ZN13mediaplatform11HTTPMessage11setBodyDataEPcm(httpMessage.obj, body, strlen(body));
    /* NOTE: do NOT free body before run() — new hybris stores pointer, not copy */
    uint8_t *urlRequest = (uint8_t *)calloc(1, 2048);
    if (!urlRequest) { free(ptr); return NULL; }
    _ZN17storeservicescore10URLRequestC2ERKNSt6__ndk110shared_ptrIN13mediaplatform11HTTPMessageEEERKNS2_INS_14RequestContextEEE(urlRequest, &httpMessage, &reqCtx);
    _ZN17storeservicescore10URLRequest3runEv(urlRequest);
    struct shared_ptr *err = _ZNK17storeservicescore10URLRequest5errorEv(urlRequest);
    if (err->obj != NULL) {
        int code = store_error_code(err->obj);
        const char *what = _ZNK17storeservicescore19StoreErrorCondition4whatEv(err->obj);
        fprintf(stderr, "[!] createMusicToken error: code=%d, message=%s\n", code, what ? what : "none");
        return NULL;
    }
    struct shared_ptr *urlResp = _ZNK17storeservicescore10URLRequest8responseEv(urlRequest);
    struct shared_ptr *resp = _ZNK17storeservicescore11URLResponse18underlyingResponseEv(urlResp->obj);
    void *http_message_obj = resp->obj;
    void* data_ptr = *(void**)((char*)http_message_obj + 48);
    char *respBody = data_ptr ? _ZNK13mediaplatform4Data5bytesEv(data_ptr) : NULL;
    cJSON *json = cJSON_Parse(respBody);
    cJSON *token_obj = cJSON_GetObjectItemCaseSensitive(json, "music_token");
    char *token = cJSON_GetStringValue(token_obj);
    if (token == NULL) {
        const char *err_desc = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(json, "error_description"));
        const char *err_code = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(json, "error"));
        fprintf(stderr, "[!] createMusicToken failed: %s (%s)\n",
                err_desc ? err_desc : "unknown error",
                err_code ? err_code : "?");
        return NULL;
    }
    char *result = strdup(token);
    return result;
}

char* get_dev_token(struct shared_ptr reqCtx) {
    uint8_t *ptr = (uint8_t *)calloc(1, 2048);
    if (!ptr) return NULL;
    *(void **)(ptr) =
        &_ZTVNSt6__ndk120__shared_ptr_emplaceIN13mediaplatform11HTTPMessageENS_9allocatorIS2_EEEE +
        2;
    struct shared_ptr httpMessage = {.obj = ptr + 32, .ctrl_blk = ptr};
    union std_string url = new_std_string("https://sf-api-token-service.itunes.apple.com/apiToken");
    union std_string method = new_std_string("GET");
    _ZN13mediaplatform11HTTPMessageC2ENSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES7_(httpMessage.obj, &url, &method);
    uint8_t *urlRequest = (uint8_t *)calloc(1, 2048);
    if (!urlRequest) { free(ptr); return NULL; }
    _ZN17storeservicescore10URLRequestC2ERKNSt6__ndk110shared_ptrIN13mediaplatform11HTTPMessageEEERKNS2_INS_14RequestContextEEE(urlRequest, &httpMessage, &reqCtx);
    union std_string clientIdName = new_std_string("clientId");
    union std_string clientIdValue = new_std_string("musicAndroid");
    _ZN17storeservicescore10URLRequest19setRequestParameterERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(urlRequest, &clientIdName, &clientIdValue);
    union std_string versionName = new_std_string("version");
    union std_string versionValue = new_std_string("1");
    _ZN17storeservicescore10URLRequest19setRequestParameterERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEES9_(urlRequest, &versionName, &versionValue);
    _ZN17storeservicescore10URLRequest3runEv(urlRequest);
    struct shared_ptr *err = _ZNK17storeservicescore10URLRequest5errorEv(urlRequest);
    if (err->obj != NULL) {
        int code = store_error_code(err->obj);
        const char *what = _ZNK17storeservicescore19StoreErrorCondition4whatEv(err->obj);
        fprintf(stderr, "[!] devToken error: code=%d, message=%s\n", code, what ? what : "none");
        return NULL;
    }
    struct shared_ptr *urlResp = _ZNK17storeservicescore10URLRequest8responseEv(urlRequest);
    struct shared_ptr *resp = _ZNK17storeservicescore11URLResponse18underlyingResponseEv(urlResp->obj);
    void *http_message_obj = resp->obj;
    void** data_ptr_location = (void**)((char*)http_message_obj + 48);
    void* data_ptr = *data_ptr_location;
    char *respBody = _ZNK13mediaplatform4Data5bytesEv(data_ptr);
    cJSON *json = cJSON_Parse(respBody);
    cJSON *token_obj = cJSON_GetObjectItemCaseSensitive(json, "token");
    char *token = cJSON_GetStringValue(token_obj);
    if (token == NULL) {
        fprintf(stderr, "[!] devToken error: token field missing in response\n");
        return NULL;
    }
    char *result = strdup(token);
    return result;
}

void write_music_token(void) {
    if (!g_music_token || !g_music_token[0]) return;
    char p[1100];
    FILE *fp = fopen(base_path(p, sizeof(p), "/MUSIC_TOKEN"), "w");
    if (!fp) { perror("[!] write_music_token: fopen"); return; }
    DRM_DEBUG("[+] Music-Token: %.14s...\n", g_music_token);
    fprintf(fp, "%s", g_music_token);
    fclose(fp);
}

int offline_available() {
    struct shared_ptr *fairplay = malloc(16);
    if (!fairplay) return 0;
    memset(fairplay, 0, 16);
    _ZN17storeservicescore14RequestContext8fairPlayEv(fairplay, reqCtx.obj);
    if (!fairplay->obj) {
        /* Account may lack a FairPlay subscription object — treat as offline-unavailable. */
        fprintf(stderr, "[drm] offline_available: FairPlay obj is null\n"); fflush(stderr);
        free(fairplay);
        return 0;
    }
    struct std_vector fairplay_status = _ZN17storeservicescore8FairPlay21getSubscriptionStatusEv(fairplay->obj);
    /* Empty or partial status is common before sign-in; never read past the vector (PR #1). */
    const int available = drm_subscription_offline_available(fairplay_status.begin, fairplay_status.end);
    free(fairplay);
    if (available) { // kFPSubscriptionCanPlayContent, kFPSubscriptionCanStreamAndPlayContent
        return 1;
    }
    return 0;
}

