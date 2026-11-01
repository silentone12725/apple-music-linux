/*
 * guard.cpp — C++ exception barrier for calls into the Android FairPlay
 * libraries.  SVError (and friends) propagate as C++ exceptions thrown by
 * Bionic's libc++.  On x86-64, Bionic and host (glibc) C++ both implement
 * the Itanium ABI, but the two runtimes have separate exception personality
 * functions; a host catch(...) cannot intercept an Android-thrown exception.
 *
 * Fix: install a SIGABRT signal handler (not std::set_terminate — that only
 * covers the host C++ runtime, whereas Bionic's libc++ calls its own
 * std::terminate → abort() directly).  The SIGABRT signal is delivered to
 * whichever thread called abort(), which is always the thread whose Android
 * exception escaped.  Each guarded function arms a thread-local sigjmp_buf
 * before entering Android code; the handler siglongjmps back to that point.
 */
#include <csetjmp>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <csignal>
#include <exception>

extern "C" {
#include "drm_lib.h"
}

/* ── Thread-local recovery state ────────────────────────────────────────────*/

#ifndef _WIN32
static thread_local sigjmp_buf g_recovery_jmp;
static thread_local bool g_recovery_valid = false;

static void sigabrt_handler(int /*sig*/)
{
    if (g_recovery_valid) {
        g_recovery_valid = false;
        fprintf(stderr, "[guard] SIGABRT in Android library; recovering via siglongjmp\n");
        fflush(stderr);
        siglongjmp(g_recovery_jmp, 1);
    }
    /* No recovery point on this thread — restore default and re-raise. */
    fprintf(stderr, "[guard] SIGABRT with no recovery point — letting it crash\n");
    fflush(stderr);
    signal(SIGABRT, SIG_DFL);
    raise(SIGABRT);
}

__attribute__((constructor)) static void install_sigabrt_handler()
{
    struct sigaction sa{};
    sa.sa_handler = sigabrt_handler;
    sigemptyset(&sa.sa_mask);
    /* SA_NODEFER: allow SIGABRT inside the handler (for the re-raise path) */
    sa.sa_flags = SA_NODEFER;
    sigaction(SIGABRT, &sa, nullptr);
}

/* ── Guarded entry points ────────────────────────────────────────────────────*/

extern "C" void *aml_open_kd_ctx_guarded(const char *adam, const char *uri)
{
    /* Reinstall our SIGABRT handler on every entry.  The Go runtime
     * re-installs its own SIGABRT handler at various points (goroutine
     * scheduling, GC, etc.), so a one-time constructor install is not
     * sufficient — we must own the slot for the duration of this call. */
    struct sigaction sa{}, old_sa{};
    sa.sa_handler = sigabrt_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_NODEFER;
    sigaction(SIGABRT, &sa, &old_sa);

    void *result = nullptr;

    g_recovery_valid = true;
    if (sigsetjmp(g_recovery_jmp, 1) != 0) {
        /* Jumped back from SIGABRT handler after SVError */
        g_recovery_valid = false;
        sigaction(SIGABRT, &old_sa, nullptr);
        fprintf(stderr, "[guard] key context: SVError escaped (Invalid CKC or FPS failure)\n");
        fflush(stderr);
        return nullptr;
    }

    try {
        result = drm_lib_open_kd_ctx(adam, uri);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] key context exception: %s\n", e.what());
        fflush(stderr);
    } catch (...) {
        fprintf(stderr, "[guard] key context: unknown C++ exception\n");
        fflush(stderr);
    }

    g_recovery_valid = false;
    sigaction(SIGABRT, &old_sa, nullptr);
    return result;
}

extern "C" int aml_lib_login_guarded(const char *username, const char *password)
{
    int result = -1;

    g_recovery_valid = true;
    if (sigsetjmp(g_recovery_jmp, 1) != 0) {
        g_recovery_valid = false;
        fprintf(stderr, "[guard] drm_lib_login: exception escaped\n");
        fflush(stderr);
        return -1;
    }

    try {
        result = drm_lib_login(username, password);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] drm_lib_login exception: %s\n", e.what());
        fflush(stderr);
    } catch (...) {
        fprintf(stderr, "[guard] drm_lib_login: unknown C++ exception\n");
        fflush(stderr);
    }

    g_recovery_valid = false;
    return result;
}

extern "C" int aml_lib_init_guarded(const drm_lib_config_t *cfg)
{
    int result = -1;

    g_recovery_valid = true;
    if (sigsetjmp(g_recovery_jmp, 1) != 0) {
        g_recovery_valid = false;
        fprintf(stderr, "[guard] drm_lib_init: SVError escaped\n");
        fflush(stderr);
        drm_lib_abort_init();
        return -1;
    }

    try {
        result = drm_lib_init(cfg);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] drm_lib_init exception: %s\n", e.what());
        fflush(stderr);
        drm_lib_abort_init();
    } catch (...) {
        fprintf(stderr, "[guard] drm_lib_init: unknown C++ exception\n");
        fflush(stderr);
        drm_lib_abort_init();
    }

    g_recovery_valid = false;
    return result;
}
#else

/* MinGW has the C signal API but not POSIX sigaction/sigsetjmp.  Keep the
 * exception barrier available on Windows; abort recovery is intentionally not
 * emulated because longjmp from a Windows signal handler is not reliable
 * across the Android ELF guest stack. */
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

extern "C" int aml_lib_login_guarded(const char *username, const char *password)
{
    try {
        return drm_lib_login(username, password);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] drm_lib_login exception: %s\n", e.what());
    } catch (...) {
        fprintf(stderr, "[guard] drm_lib_login: unknown C++ exception\n");
    }
    return -1;
}

extern "C" int aml_lib_init_guarded(const drm_lib_config_t *cfg)
{
    try {
        return drm_lib_init(cfg);
    } catch (const std::exception &e) {
        fprintf(stderr, "[guard] drm_lib_init exception: %s\n", e.what());
        drm_lib_abort_init();
    } catch (...) {
        fprintf(stderr, "[guard] drm_lib_init: unknown C++ exception\n");
        drm_lib_abort_init();
    }
    return -1;
}
#endif
