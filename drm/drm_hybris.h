/*
 * drm_hybris.h — Hybris-based Android library loader for FairPlay decryption.
 *
 * Loads libCoreFP.so (direct approach) or libandroidappmusic.so (proven path)
 * from the vseg rootfs via libhybris-core.so on Linux x86_64.
 *
 * Two decryption backends are tried in order:
 *   1. libCoreFP.so direct — calls the 7 obfuscated exports directly.
 *      Experimental: requires CKC-based context construction.
 *   2. libandroidappmusic.so — calls NfcRKVnxuKZy04KWbdFu71Ou.
 *      Proven: same path used by vseg's libdrm-native.so.
 */

#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Initialize the hybris decryption backend.
 *
 * Loads libhybris-core.so from hybris_core_path (Linux .so), sets the
 * HYBRIS_* environment variables, then uses android_dlopen to load the
 * Android libraries from lib64_dir.
 *
 * hybris_linker_dir  — path to the directory containing the hybris linker
 *                      (the "hybris-linker" directory next to libhybris-core.so)
 * lib64_dir          — path to rootfs/system/lib64 containing the Android .so files
 * hybris_core_path   — path to libhybris-core.so itself
 *
 * Returns 0 on success, -1 on failure.
 */
int hybris_backend_init(
    const char *hybris_linker_dir,
    const char *lib64_dir,
    const char *hybris_core_path
);

/*
 * Decrypt a CBCS-encrypted FairPlay sample using the Android backend.
 *
 * ctx      — opaque key-delivery context obtained from hybris_backend_open_kd_ctx()
 * selector — sample selector (passed to NfcRKVnxuKZy04KWbdFu71Ou as arg1)
 * data     — sample data, decrypted in-place (only whole 16-byte blocks decrypted)
 * len      — length of data in bytes; only floor(len/16)*16 bytes are touched
 *
 * Returns 0 on success, the library's error code on failure.
 */
int hybris_backend_decrypt(void *ctx, uint32_t selector, uint8_t *data, uint32_t len);

/*
 * Open a key-delivery context from CKC bytes.
 *
 * ckc_data — CKC bytes returned by Apple's license server
 * ckc_len  — length of ckc_data
 * selector — selector value observed from SVPastisDecryptor (usually track type)
 *
 * Returns an opaque context pointer, or NULL on failure.
 * The context is owned by the caller; free with hybris_backend_close_kd_ctx().
 */
void *hybris_backend_open_kd_ctx(
    const uint8_t *ckc_data,
    uint32_t ckc_len,
    uint32_t selector
);

/*
 * Release a key-delivery context opened via hybris_backend_open_kd_ctx().
 * Do NOT call this on a pointer returned by hybris_open_kd_ctx_from_uri() —
 * that pointer is owned by libandroidappmusic.so.
 */
void hybris_backend_close_kd_ctx(void *ctx);

/*
 * Open a key-delivery context for (adamID, skd:// URI) the way the Android
 * wrapper does: SVFootHillSessionCtrl::getPersistentKey() (FPS key exchange)
 * then decryptContext().  adam "0" is the shared prefetch key and is cached.
 *
 * Returns the opaque decrypt handle (*SVFootHillPContext::kdContext()) to pass
 * to hybris_backend_decrypt(), or NULL on failure.  It is owned by
 * libandroidappmusic.so and must NOT be passed to hybris_backend_close_kd_ctx().
 */
void *hybris_open_kd_ctx_from_uri(const char *adam, const char *uri);

/*
 * Initialize the FairPlay credential context.
 *
 * Must be called once after hybris_backend_init() has loaded the Android
 * libraries. Sets up RequestContextConfig + RequestContext + RequestContextManager
 * + SVPlaybackLeaseManager so that SVFootHillSessionCtrl::_decryptContextWithCkcKey
 * can reach Apple's key server.
 *
 * base_dir — the parent directory of the mpl_db/ credential directory
 *            (from drm/files/ in the vseg rootfs; also used as the FairPlay
 *            directory path passed to libandroidappmusic.so).
 *            Pass NULL to derive from the lib64_dir used in hybris_backend_init().
 *
 * Returns 0 on success, -1 on failure. Safe to call multiple times.
 */
int hybris_fairplay_init(const char *base_dir, const char *device_info,
                         const char *lib64_dir);

/* 1 while the lease recovery state machine is not in its Running state. */
int hybris_lease_recovery_active(void);

/* Incremented on every lease refresh; cached key contexts older than this are stale. */
unsigned hybris_decrypt_epoch(void);

/*
 * Probe all libCoreFP.so exports and log what they return for NULL/zero inputs.
 * Useful for reverse-engineering the function signatures.
 * Only logs — does not crash (SIGSEGV on NULL pointer caught internally).
 */
void hybris_corefp_probe(void);

/**
 * Progressive music-video URL and download key for adam, from Apple's StoreKit auth
 * through the Android libraries. The key is empty/NULL for itun-encrypted files, which
 * are decrypted client-side. Also creates the itun decryptor for adam (one at a time).
 * out_url / out_dk are malloc'd; the caller frees them. Returns 0 on success.
 */
int hybris_get_progressive(unsigned long adam, char **out_url, char **out_dk,
                           int *out_has_itun);

/**
 * Decrypt one itun-encrypted sample in place with Apple's SVPastisDecryptor.
 * hybris_get_progressive() must have been called for the same adam. out_size is the
 * decrypted length. Returns 0 on success.
 */
int hybris_decrypt_itun(unsigned long adam, uint8_t *sample, uint32_t in_size,
                        uint32_t *out_size);

/*
 * Shut down the hybris backend and unload libraries.
 */
void hybris_backend_shutdown(void);

#ifdef __cplusplus
}
#endif
