/*
 * guard.cpp — C++ exception barrier for calls into the Android FairPlay
 * libraries.  SVError (and friends) propagate as C++ exceptions through our C
 * frames; without a catch they reach the Go runtime and abort the process.
 */
#include <cstdint>
#include <cstdio>
#include <exception>

extern "C" {
#include "drm_lib.h"
void drm_lib_abort_init(void);
}

extern "C" void *aml_open_kd_ctx_guarded(const char *adam, const char *uri)
{
    try {
        return drm_lib_open_kd_ctx(adam, uri);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] key context exception: %s\n", e.what());
    } catch (...) {
        fprintf(stderr, "[guard] key context: unknown C++ exception\n");
    }
    return nullptr;
}

extern "C" int aml_lib_init_guarded(const drm_lib_config_t *cfg)
{
    try {
        return drm_lib_init(cfg);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] drm_lib_init exception: %s\n", e.what());
    } catch (...) {
        fprintf(stderr, "[guard] drm_lib_init: unknown C++ exception\n");
    }
    drm_lib_abort_init();
    return -1;
}

extern "C" int aml_get_mv_guarded(unsigned long adam, char **out_url, char **out_dk,
                                  int *out_has_itun)
{
    try {
        return drm_lib_get_mv(adam, out_url, out_dk, out_has_itun);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] get_mv exception: %s\n", e.what());
    } catch (...) {
        fprintf(stderr, "[guard] get_mv: unknown C++ exception\n");
    }
    return -1;
}

extern "C" int aml_decrypt_itun_guarded(unsigned long adam, uint8_t *sample, uint32_t in_size,
                                        uint32_t *out_size)
{
    try {
        return drm_lib_decrypt_itun(adam, sample, in_size, out_size);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] itun decrypt exception: %s\n", e.what());
    } catch (...) {
        fprintf(stderr, "[guard] itun decrypt: unknown C++ exception\n");
    }
    return -1;
}
