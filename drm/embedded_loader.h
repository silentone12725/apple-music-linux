/*
 * embedded_loader.h — loads libhybris-core.so from an image embedded in libdrm_client.so
 * (via an anonymous memfd), which provides android_dlopen/android_dlsym. The Android libraries
 * are loaded from disk by the Android linker; see embedded_loader.c.
 *
 * The Makefile turns libhybris-core.so into embedded_blobs/libhybris-core.so.S with xxd and
 * links it in; the symbols libhybris_core_so_data / _size are defined there.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Loader API ─────────────────────────────────────────────────────────────*/

/*
 * embedded_loader_init() — load the embedded libhybris-core.so and resolve its
 * android_dlopen/android_dlsym entry points.
 *
 * Must be called before any android_dlopen/dlsym calls.
 * Returns 0 on success, -1 on failure (check embedded_dlerror()).
 */
int embedded_loader_init(void);

/*
 * embedded_dlopen() — android_dlopen() through the loaded libhybris-core.so; Android library
 * names resolve against HYBRIS_LD_LIBRARY_PATH. Returns the handle, or NULL on failure.
 * flags: same as android_dlopen (RTLD_NOW | RTLD_GLOBAL etc.)
 */
void *embedded_dlopen(const char *name, int flags);

/*
 * embedded_dlsym() — look up a symbol across all loaded Android libraries.
 * Equivalent to android_dlsym(NULL, symbol) — searches all loaded libs.
 */
void *embedded_dlsym(const char *symbol);

/*
 * embedded_dlsym_in() — look up a symbol in a specific handle.
 */
void *embedded_dlsym_in(void *handle, const char *symbol);

/* embedded_dlerror() — return last error string */
const char *embedded_dlerror(void);

/* embedded_loader_shutdown() — unload hybris and close its memfd */
void embedded_loader_shutdown(void);

#ifdef __cplusplus
}
#endif
