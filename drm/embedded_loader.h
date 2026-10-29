/*
 * embedded_loader.h — loads libhybris-core.so for libdrm_client.so. Linux embeds it
 * (via an anonymous memfd); Windows loads the MinGW-built module with the native
 * Windows loader. In both cases it provides android_dlopen/android_dlsym. The
 * Android libraries are loaded from disk by the Android linker; see embedded_loader.c.
 *
 * On Linux, the Makefile turns libhybris-core.so into
 * embedded_blobs/libhybris-core.so.S with xxd and links it in; the symbols
 * libhybris_core_so_data / _size are defined there. The Windows target skips
 * that blob and compiles the LoadLibraryA path instead.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ── Loader API ─────────────────────────────────────────────────────────────*/

/*
 * embedded_loader_init() — load libhybris-core.so and resolve its
 * android_dlopen/android_dlsym entry points. On Linux the module is embedded;
 * on Windows it is loaded with LoadLibraryA from HYBRIS_CORE_PATH (or the
 * default module name).
 *
 * Must be called before any android_dlopen/dlsym calls.
 * Returns 0 on success, -1 on failure (check embedded_dlerror()).
 */
int embedded_loader_init(void);

/*
 * embedded_loader_init_path() — same initialization, with an optional
 * Windows module path. Linux ignores core_path and retains the embedded
 * module behavior. Passing NULL selects the platform default.
 */
int embedded_loader_init_path(const char *core_path);

/*
 * embedded_dlopen() — android_dlopen() through the loaded libhybris-core.so; Android library
 * names resolve against HYBRIS_LD_LIBRARY_PATH. Returns the handle, or NULL on failure.
 * flags: same as android_dlopen (RTLD_NOW | RTLD_GLOBAL etc.)
 */
void *embedded_dlopen(const char *name, int flags);

/*
 * embedded_set_hook_callback() — register a callback consulted first for every symbol a loaded Android library
 * imports; it returns the host function to bind, or NULL to fall through. Returns 0, or -1 when the loaded
 * libhybris-core.so has no such export (Windows binds its hooks internally).
 */
int embedded_set_hook_callback(void *(*cb)(const char *symbol, const char *requester));

/*
 * embedded_dlsym() — look up a symbol across all loaded Android libraries.
 * Equivalent to android_dlsym(NULL, symbol) — searches all loaded libs.
 */
void *embedded_dlsym(const char *symbol);

/*
 * embedded_dlsym_in() — look up a symbol in a specific handle.
 */
void *embedded_dlsym_in(void *handle, const char *symbol);

/* Forward a library search path update to libhybris-core when that export is
 * available.  The Windows build uses this to avoid an unresolved direct
 * reference to a symbol in the dynamically loaded core module. */
void embedded_update_ld_library_path(const char *path);

/* embedded_dlerror() — return last error string */
const char *embedded_dlerror(void);

/* embedded_loader_shutdown() — unload hybris and release its platform handle */
void embedded_loader_shutdown(void);

#ifdef __cplusplus
}
#endif
