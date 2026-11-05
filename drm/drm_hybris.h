/*
 * drm_hybris.h — FairPlay through Apple's Android libraries, loaded with libhybris.
 */

#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Load libandroidappmusic.so and its dependencies from lib64_dir through the
 * embedded libhybris-core.so.
 *
 * hybris_linker_dir — directory containing the hybris linker
 * lib64_dir         — rootfs/system/lib64 with the Android .so files
 * hybris_core_path  — path to libhybris-core.so
 *
 * Returns 0 on success, -1 on failure.
 */
int hybris_backend_init(
    const char *hybris_linker_dir,
    const char *lib64_dir,
    const char *hybris_core_path);

/*
 * Start the FairPlay session (request context, login, playback lease and its
 * recovery state machine). Call once after hybris_backend_init().
 *
 * base_dir — directory holding mpl_db/ and the session files; also used as
 *            the FairPlay directory path.
 *
 * auth_cb is called with type "2fa" when Apple asks for a verification code;
 * it must block until the user has entered it (out_buf gets the 6 digits).
 *
 * Returns 0 on success, -1 on failure. Safe to call multiple times.
 */
int hybris_fairplay_init(const char *base_dir, const char *device_info,
                         const char *lib64_dir,
                         const char *username, const char *password,
                         void (*auth_cb)(const char *type, char *out_buf, int out_size, void *ud),
                         void *auth_ud);

/* Why the last sign-in failed, in words fit for the sign-in form ("" when unknown). Valid until the next sign-in. */
const char *hybris_last_error(void);

/* Returned by hybris_backend_decrypt when a lease refresh freed the context. */
#define HYBRIS_ERR_STALE_CONTEXT (-2)

/*
 * Open the key context for (adamID, skd:// URI) the way the wrapper's handle()
 * does: SVFootHillSessionCtrl::getPersistentKey() then decryptContext().
 * adam "0" is the shared prefetch key and is cached.
 *
 * Returns the handle to pass to hybris_backend_decrypt(), or NULL on failure,
 * and stores the context epoch in *epoch (may be NULL). The handle is owned by
 * libandroidappmusic.so; never free it.
 */
void *hybris_open_kd_ctx_from_uri(const char *adam, const char *uri, unsigned *epoch);

/*
 * Decrypt one sample in place with NfcRKVnxuKZy04KWbdFu71Ou. Only whole
 * 16-byte blocks are touched. epoch is the value hybris_open_kd_ctx_from_uri
 * returned with ctx. Returns 0 on success, HYBRIS_ERR_STALE_CONTEXT if a lease
 * refresh has since freed the context, -1 on other failures.
 */
int hybris_backend_decrypt(void *ctx, unsigned epoch, uint8_t *data, uint32_t len);

#ifdef __cplusplus
}
#endif
