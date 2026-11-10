/*
 * drm_hybris.c — loads Apple's Android FairPlay libraries through libhybris.
 *
 * libandroidappmusic.so (and its dependencies, libCoreFP.so first) are loaded
 * from rootfs/system/lib64. The vendored wrapper in native/ then runs the
 * FairPlay session (login, lease, recovery); keys come from its getKdContext()
 * and samples are decrypted with NfcRKVnxuKZy04KWbdFu71Ou:
 *   int fn(void *ctx, uint32_t selector, void *cipher_in, void *plain_out, uint32_t len)
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdarg.h>
#include <pthread.h>
#ifndef _WIN32
#include <sys/mman.h>
#include <unistd.h>
#endif

extern void hybris_bind_lib_handles(void *ssc, void *apm, void *core);

/* Windows loads these libraries RTLD_GLOBAL so the later symbol lookups through the
 * wrapper see them; the Linux flags are unchanged. */
#ifdef _WIN32
#define HYBRIS_WIN_RTLD_GLOBAL RTLD_GLOBAL
#else
#define HYBRIS_WIN_RTLD_GLOBAL 0
#endif

#ifdef _WIN32
/* The Windows loader path does not use POSIX dlopen/dlsym.  Keep only the
 * flag values needed by the Android linker API. */
#include <windows.h>
#include <stdint.h>
#ifndef RTLD_NOW
#define RTLD_NOW 2
#endif
#ifndef RTLD_GLOBAL
#define RTLD_GLOBAL 0x100
#endif
static int hybris_setenv(const char *name, const char *value, int overwrite)
{
    if (!overwrite && getenv(name) != NULL) return 0;
    return _putenv_s(name, value != NULL ? value : "");
}
#define setenv hybris_setenv

/* bionic's DT_INIT_ARRAY constructors begin with "mov rax, fs:[0]" to read
 * the Android TLS base.  On Windows x86_64 the fs segment base is 0 in user
 * mode, so that read faults at address 0 before any bionic state is set up.
 *
 * Fix: allocate a minimal TLS block and set the fs base to it via WRFSBASE
 * (available in user mode on Windows 10 1511+ with FSGSBASE enabled in CR4).
 *
 * Slot layout (bionic/libc/private/bionic_tls.h, x86_64):
 *   [0] self-ptr  — fs:[0] must equal &tls[0] (glibc-style self-referential)
 *   [1] pthread*  — __get_thread() reads slot 1; code may dereference it
 *   [5] canary    — 0 is safe during init; ABI doesn't verify it in ctors
 */
static __attribute__((aligned(64))) uint64_t g_bionic_tls_slots[32];
static __attribute__((aligned(16))) uint64_t g_bionic_pthread_stub[64];
static uint64_t g_host_fs_base;
static int g_host_fs_saved;

void hybris_guest_fs_enter(void)
{
    __asm__ volatile("wrfsbase %0" ::"r"((uint64_t)(uintptr_t)g_bionic_tls_slots) : "memory");
}

void hybris_guest_fs_leave(void)
{
    __asm__ volatile("wrfsbase %0" ::"r"(g_host_fs_base) : "memory");
}

static void setup_bionic_fs_base_win(void)
{
    memset(g_bionic_tls_slots, 0, sizeof(g_bionic_tls_slots));
    memset(g_bionic_pthread_stub, 0, sizeof(g_bionic_pthread_stub));
    g_bionic_tls_slots[0] = (uint64_t)(uintptr_t)g_bionic_tls_slots;    /* self */
    g_bionic_tls_slots[1] = (uint64_t)(uintptr_t)g_bionic_pthread_stub; /* tid  */
    __asm__ volatile("wrfsbase %0" ::"r"((uint64_t)(uintptr_t)g_bionic_tls_slots) : "memory");
}

/* Windows commits a thread's stack one page at a time, through a guard page that must be
 * touched in order; code built for Windows calls __chkstk before any frame over a page.
 * Android code does not: FairPlay opens frames of 100 KB and more and writes to the far
 * end first, which lands in reserved, uncommitted memory and faults with no stack left
 * for any handler. Touch every page once so the whole stack is committed before guest
 * code runs on this thread. The lowest pages stay untouched as the overflow guard. */
void hybris_commit_thread_stack(void)
{
    static __thread int done;
    if (done) return;
    done = 1;
    ULONG_PTR lo = 0, hi = 0;
    GetCurrentThreadStackLimits(&lo, &hi);
    volatile char *p = (volatile char *)((uintptr_t)__builtin_frame_address(0) & ~(uintptr_t)0xfff);
    volatile char *stop = (volatile char *)lo + 4 * 0x1000;
    while (p - 0x1000 > stop) {
        p -= 0x1000;
        (void)*p;
    }
}
#else
#include <dlfcn.h>
void hybris_commit_thread_stack(void) {}
#endif

#include "drm_hybris.h"
#include "embedded_loader.h"
#include "native/drm_lib.h"

/* ── Types for hybris functions ─────────────────────────────────────────────*/

typedef void *(*android_dlopen_fn)(const char *filename, int flags);
typedef void *(*android_dlsym_fn)(void *handle, const char *symbol);
typedef int (*android_dlclose_fn)(void *handle);

/* ── NfcRKVnxuKZy04KWbdFu71Ou signature ─────────────────────────────────────*/

typedef int (*nfc_decrypt_fn)(void *ctx, uint32_t selector, void *cipher_in, void *plain_out, uint32_t len);

/* ── Forward declarations ────────────────────────────────────────────────────*/

int hybris_fairplay_init(const char *base_dir, const char *device_info, const char *lib64_dir,
                         const char *username, const char *password,
                         drm_auth_cb_t auth_cb, void *auth_ud);

/* ── Global module state ─────────────────────────────────────────────────────*/

static struct {
    pthread_mutex_t lock;
    int initialized;

    /* hybris host library (Linux) */
    void *hybris_core;
    android_dlopen_fn android_dlopen;
    android_dlsym_fn android_dlsym;
    android_dlclose_fn android_dlclose;

    /* libCoreFP.so (Android, loaded via hybris) */
    void *corefp_handle;

    /* libandroidappmusic.so (Android, loaded via hybris) — proven path */
    void *appmusic_handle;
    nfc_decrypt_fn nfc_decrypt; /* NfcRKVnxuKZy04KWbdFu71Ou */

    /* libstoreservicescore.so handle (dependency of appmusic, kept for dlsym) */
    void *ssc_handle;

    int appmusic_available; /* libandroidappmusic.so loaded */
    int fairplay_inited;    /* hybris_fairplay_init() succeeded */
} g_hybris = {
    .lock = PTHREAD_MUTEX_INITIALIZER,
    .initialized = 0,
};

/* ── Init ────────────────────────────────────────────────────────────────────*/

#ifndef _WIN32
/* ── curl write-callback patcher ─────────────────────────────────────────────
 * hybris_libc_shim_hook returns these shims for every curl symbol that
 * libmediaplatform.so imports, routing all calls to the system libcurl that
 * libdrm_client.so links against.  Since every curl call uses the same library,
 * handles created by curl_easy_init and options set via curl_easy_setopt are
 * fully compatible.
 *
 * The curl_easy_setopt shim intercepts CURLOPT_WRITEFUNCTION/WRITEDATA and
 * patches "is-phone-number-supported</key><false/>" → "<true/> " in the
 * GrandSlam lookup response body, enabling the library's phone OTP flow when
 * the user clicks "Can't get to your devices?".
 * ─────────────────────────────────────────────────────────────────────────── */

/* system libcurl functions this library links against */
extern void *curl_easy_init(void);
extern int curl_easy_setopt(void *curl, int option, ...);
extern int curl_easy_perform(void *curl);
extern void curl_easy_cleanup(void *curl);
extern void curl_easy_reset(void *curl);
extern int curl_easy_getinfo(void *curl, int info, ...);
extern const char *curl_easy_strerror(int code);
extern int curl_global_init(long flags);
extern void *curl_share_init(void);
extern int curl_share_setopt(void *share, int option, ...);
extern void *curl_slist_append(void *list, const char *str);
extern void curl_slist_free_all(void *list);

#define CURLOPT_WRITEFUNCTION_VAL 20011
#define CURLOPT_WRITEDATA_VAL     10001

typedef size_t (*curl_wfn_t)(char *, size_t, size_t, void *);
typedef int (*curl_setopt_fn_t)(void *, int, ...);

#define MAX_WPATCHERS 256
typedef struct {
    void *handle;
    curl_wfn_t orig_fn;
    void *orig_ud;
    int shimmed;
} watcher_t;
static watcher_t g_wp[MAX_WPATCHERS];
static unsigned g_wp_next = 0;
static pthread_mutex_t g_wp_lock = PTHREAD_MUTEX_INITIALIZER;

/* Caller holds g_wp_lock. Slots are recycled round-robin once the table is full,
 * so a long session of short-lived handles never exhausts it; a recycled slot is
 * always re-initialised before use. The slot address is handed to libcurl as
 * WRITEDATA, so it stays valid for the lifetime of the process. */
static watcher_t *wp_find(void *h, int create)
{
    for (int i = 0; i < MAX_WPATCHERS; i++)
        if (g_wp[i].handle == h) return &g_wp[i];
    if (!create) return NULL;
    watcher_t *w = &g_wp[g_wp_next++ % MAX_WPATCHERS];
    *w = (watcher_t){.handle = h};
    return w;
}

/* Patch "is-phone-number-supported</key><false/>" -> "<true/> " in-place.
 * Both value tags are 8 bytes; the trailing space keeps the buffer length equal. */
static void curl_patch_phone(char *data, size_t len)
{
    static const char KEY[] = "is-phone-number-supported</key>";
    static const char FROM[] = "<false/>";
    static const char TO[] = "<true/> ";
    const size_t kl = sizeof(KEY) - 1, fl = sizeof(FROM) - 1;
    if (len < kl + fl) return;
    for (char *p = data, *end = data + len - kl; p <= end; p++) {
        if (memcmp(p, KEY, kl)) continue;
        char *q = p + kl;
        while (q < data + len - fl &&
               (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r')) q++;
        if (q + fl <= data + len && !memcmp(q, FROM, fl)) {
            fprintf(stderr, "[phone-patch] is-phone-number-supported false->true\n");
            memcpy(q, TO, fl);
            return;
        }
    }
}

static size_t curl_write_shim(char *ptr, size_t size, size_t nmemb, void *ud)
{
    watcher_t *w = (watcher_t *)ud;
    uintptr_t off = (uintptr_t)w - (uintptr_t)g_wp;
    if ((uintptr_t)w < (uintptr_t)g_wp || off >= sizeof(g_wp) || off % sizeof(watcher_t))
        return 0; /* not one of ours: signal a write error rather than drop data */
    pthread_mutex_lock(&g_wp_lock);
    curl_wfn_t fn = w->orig_fn;
    void *fud = w->orig_ud;
    pthread_mutex_unlock(&g_wp_lock);
    curl_patch_phone(ptr, size * nmemb);
    if (!fn) return size * nmemb;
    return fn(ptr, size, nmemb, fud);
}

/*
 * Core setopt intercept shared by both shims. fwd is the curl_easy_setopt that
 * owns the handle. The third argument is read as a pointer; every curl option
 * is pointer- or long-sized on LP64, and it is forwarded unchanged.
 *
 * WRITEDATA is only withheld from libcurl once our shim owns the handle's write
 * callback; until then (default fwrite writer, or WRITEDATA set before
 * WRITEFUNCTION) it is forwarded and also remembered, so nothing is lost.
 */
static int curl_setopt_intercept(void *handle, int option, void *param,
                                 curl_setopt_fn_t fwd)
{
    if (option == CURLOPT_WRITEFUNCTION_VAL) {
        pthread_mutex_lock(&g_wp_lock);
        watcher_t *w = wp_find(handle, 1);
        if (!param) { /* back to libcurl's default writer: restore its WRITEDATA */
            void *ud = w->orig_ud;
            w->shimmed = 0;
            w->orig_fn = NULL;
            pthread_mutex_unlock(&g_wp_lock);
            fwd(handle, CURLOPT_WRITEDATA_VAL, ud);
            return fwd(handle, option, NULL);
        }
        w->orig_fn = (curl_wfn_t)param;
        w->shimmed = 1;
        pthread_mutex_unlock(&g_wp_lock);
        fwd(handle, CURLOPT_WRITEDATA_VAL, (void *)w);
        return fwd(handle, option, (void *)curl_write_shim);
    }
    if (option == CURLOPT_WRITEDATA_VAL) {
        pthread_mutex_lock(&g_wp_lock);
        watcher_t *w = wp_find(handle, 1);
        w->orig_ud = param;
        int shimmed = w->shimmed;
        pthread_mutex_unlock(&g_wp_lock);
        if (shimmed) return 0;
    }
    return fwd(handle, option, param);
}

/*
 * Bionic-namespace shim, returned by hybris_libc_shim_hook() for libs that
 * import curl via the bionic namespace. Those handles come from system
 * curl_easy_init (also via the hook), so forwarding to system curl is correct.
 */
static int adam_curl_easy_setopt_bionic(void *handle, int option, ...)
{
    va_list ap;
    va_start(ap, option);
    void *param = va_arg(ap, void *);
    va_end(ap);
    return curl_setopt_intercept(handle, option, param, curl_easy_setopt);
}

#if defined(__x86_64__)
/*
 * ELF-namespace hook. The Android libcurl's own curl_easy_setopt body gets a
 * 12-byte absolute JMP to adam_curl_easy_setopt_elf; the displaced prologue is
 * kept in an mmap'd trampoline so the shim can still call the original.
 * curl_easy_init/perform/cleanup are NOT redirected, so every handle stays on
 * Android libcurl for its whole life.
 */
static curl_setopt_fn_t g_orig_android_setopt = NULL;

static int adam_curl_easy_setopt_elf(void *handle, int option, ...)
{
    va_list ap;
    va_start(ap, option);
    void *param = va_arg(ap, void *);
    va_end(ap);
    return curl_setopt_intercept(handle, option, param, g_orig_android_setopt);
}

/* Length of the whole instructions at p covering at least `need` bytes, or 0 if
 * an instruction outside the known position-independent prologue set is met
 * (anything RIP-relative or unknown), in which case the hook is refused. */
static size_t prologue_len(const uint8_t *p, size_t need)
{
    size_t n = 0;
    while (n < need) {
        const uint8_t *q = p + n;
        if (q[0] == 0xF3 && q[1] == 0x0F && q[2] == 0x1E && q[3] == 0xFA) {
            n += 4;
            continue;
        } /* endbr64 */
        if (q[0] >= 0x50 && q[0] <= 0x57) {
            n += 1;
            continue;
        } /* push r64 */
        if (q[0] == 0x41 && q[1] >= 0x50 && q[1] <= 0x57) {
            n += 2;
            continue;
        } /* push r8-r15 */
        if ((q[0] & 0xFA) == 0x48 && (q[1] == 0x89 || q[1] == 0x8B) && (q[2] & 0xC0) == 0xC0) {
            n += 3;
            continue;
        } /* mov r,r */
        if (q[0] == 0x48 && q[1] == 0x83 && (q[2] & 0xF8) == 0xE8) {
            n += 4;
            continue;
        } /* sub r,imm8 */
        if (q[0] == 0x48 && q[1] == 0x81 && (q[2] & 0xF8) == 0xE8) {
            n += 7;
            continue;
        } /* sub r,imm32 */
        if (q[0] >= 0xB8 && q[0] <= 0xBF) {
            n += 5;
            continue;
        } /* mov r32,imm32 */
        return 0;
    }
    return n;
}

static int build_setopt_trampoline(void *orig_fn)
{
    size_t n = prologue_len((const uint8_t *)orig_fn, 12);
    if (!n || n > 24) return 0;
    uint8_t *tr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tr == MAP_FAILED) return 0;
    void *cont = (char *)orig_fn + n;
    uint8_t jmp[12] = {0x48, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xE0}; /* movabs rax,cont; jmp rax */
    memcpy(jmp + 2, &cont, 8);
    memcpy(tr, orig_fn, n);
    memcpy(tr + n, jmp, sizeof(jmp));
    if (mprotect(tr, 4096, PROT_READ | PROT_EXEC) != 0) {
        munmap(tr, 4096);
        return 0;
    }
    __builtin___clear_cache((char *)tr, (char *)tr + n + sizeof(jmp));
    g_orig_android_setopt = (curl_setopt_fn_t)(void *)tr;
    return 1;
}
#endif

/* __register_atfork: the guest's fork handlers never run here (no fork), so registering them is a no-op.
 * __memchr_chk: memchr with a destination-size check; the check is dropped. */
static int hybris_shim_register_atfork(void (*prepare)(void), void (*parent)(void), void (*child)(void), void *dso)
{
    (void)prepare;
    (void)parent;
    (void)child;
    (void)dso;
    return 0;
}

static void *hybris_shim_memchr_chk(const void *s, int c, size_t n, size_t buf_size)
{
    (void)buf_size;
    return memchr(s, c, n);
}

static void *hybris_libc_shim_hook(const char *symbol, const char *requester)
{
    (void)requester;
    if (!symbol) return NULL;
    if (strcmp(symbol, "__register_atfork") == 0) return (void *)hybris_shim_register_atfork;
    if (strcmp(symbol, "__memchr_chk") == 0) return (void *)hybris_shim_memchr_chk;
    /* Route bionic-namespace curl calls through system libcurl.
     * curl_easy_setopt is wrapped to patch is-phone-number-supported in the
     * GrandSlam lookup response; all other functions are forwarded verbatim.
     * ELF-namespace calls are handled separately by patch_android_curl(). */
    if (strcmp(symbol, "curl_easy_setopt") == 0) return (void *)adam_curl_easy_setopt_bionic;
    if (strcmp(symbol, "curl_easy_init") == 0) return (void *)curl_easy_init;
    if (strcmp(symbol, "curl_easy_perform") == 0) return (void *)curl_easy_perform;
    if (strcmp(symbol, "curl_easy_cleanup") == 0) return (void *)curl_easy_cleanup;
    if (strcmp(symbol, "curl_easy_reset") == 0) return (void *)curl_easy_reset;
    if (strcmp(symbol, "curl_easy_getinfo") == 0) return (void *)curl_easy_getinfo;
    if (strcmp(symbol, "curl_easy_strerror") == 0) return (void *)curl_easy_strerror;
    if (strcmp(symbol, "curl_global_init") == 0) return (void *)curl_global_init;
    if (strcmp(symbol, "curl_share_init") == 0) return (void *)curl_share_init;
    if (strcmp(symbol, "curl_share_setopt") == 0) return (void *)curl_share_setopt;
    if (strcmp(symbol, "curl_slist_append") == 0) return (void *)curl_slist_append;
    if (strcmp(symbol, "curl_slist_free_all") == 0) return (void *)curl_slist_free_all;
    return NULL;
}

#if defined(__x86_64__)
/* Overwrite the start of `from` with a 12-byte absolute JMP to `to`. Runs once
 * from hybris_backend_init under g_hybris.lock, before any FairPlay or curl
 * worker thread exists, so the non-atomic write cannot race a caller. */
static int patch_jmp64(void *from, void *to)
{
    if (!from || !to) return 0;
    uint8_t jmp[12] = {0x48, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xE0}; /* movabs rax,to; jmp rax */
    memcpy(jmp + 2, &to, 8);

    long pgsz = sysconf(_SC_PAGESIZE);
    uintptr_t base = (uintptr_t)from & ~(uintptr_t)(pgsz - 1);
    size_t span = (((uintptr_t)from + sizeof(jmp) - 1) & ~(uintptr_t)(pgsz - 1)) == base
                      ? (size_t)pgsz
                      : (size_t)(2 * pgsz);
    if (mprotect((void *)base, span, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) return 0;
    memcpy(from, jmp, sizeof(jmp));
    mprotect((void *)base, span, PROT_READ | PROT_EXEC);
    __builtin___clear_cache(from, (char *)from + sizeof(jmp));
    return 1;
}

/* Hook the Android libcurl's curl_easy_setopt (see the ELF-namespace comment
 * above). Refuses, and leaves libcurl untouched, if the prologue cannot be
 * safely relocated; phone OTP then falls back to the "can't reach devices"
 * SMS behaviour instead of risking a crash. */
static void patch_android_curl(void)
{
    void *fn = embedded_dlsym("curl_easy_setopt");
    if (!fn) {
        fprintf(stderr, "[phone-patch] curl_easy_setopt not found in Android libs, phone OTP patch skipped\n");
        return;
    }
    if (!build_setopt_trampoline(fn)) {
        fprintf(stderr, "[phone-patch] curl_easy_setopt prologue not relocatable, phone OTP patch skipped\n");
        return;
    }
    if (!patch_jmp64(fn, (void *)adam_curl_easy_setopt_elf)) {
        fprintf(stderr, "[phone-patch] mprotect failed, phone OTP patch skipped\n");
        g_orig_android_setopt = NULL;
        return;
    }
    fprintf(stderr, "[phone-patch] patched curl_easy_setopt -> ELF shim\n");
}
#else
static void patch_android_curl(void)
{
    fprintf(stderr, "[phone-patch] unsupported architecture, phone OTP patch skipped\n");
}
#endif
#endif

int hybris_backend_init(
    const char *hybris_linker_dir,
    const char *lib64_dir,
    const char *hybris_core_path)
{
    hybris_commit_thread_stack();
#ifdef _WIN32
    /* Windows' CRT fully buffers stderr when it is a file or pipe, so a crash in the
     * guest code would lose the log lines that show where it happened. */
    fflush(stderr);
    setvbuf(stderr, NULL, _IONBF, 0);
#endif

    /* libhybris-core.so dlopens its Android linker shim (q.so) from
     * $HYBRIS_LINKER_DIR (default /tmp/hybris-linker); it must be set before
     * the embedded core is loaded. */
    if (hybris_linker_dir && hybris_linker_dir[0])
        setenv("HYBRIS_LINKER_DIR", hybris_linker_dir, 1);
    /* Bionic system libs (libc/libm/libdl/libz/libcurl/...) are not embedded;
     * hybris resolves them from the Android lib64 dir, as in the vseg backend. */
    if (lib64_dir && lib64_dir[0]) {
        setenv("HYBRIS_LD_LIBRARY_PATH", lib64_dir, 1);
        setenv("HYBRIS_ANDROID_LIB64", lib64_dir, 1);
        /* Bionic logs "ANDROID_DATA/ANDROID_ROOT not set!" on every timezone
         * lookup when these are unset. Point them at the rootfs (<rootfs>/system
         * and <rootfs>/data, from <rootfs>/system/lib64); there is no tzdata in
         * either, so behaviour is unchanged. Existing values are kept. */
        char root[4096], data[4096];
        if (snprintf(root, sizeof(root), "%s/..", lib64_dir) < (int)sizeof(root))
            setenv("ANDROID_ROOT", root, 0);
        if (snprintf(data, sizeof(data), "%s/../../data", lib64_dir) < (int)sizeof(data))
            setenv("ANDROID_DATA", data, 0);
    }

    pthread_mutex_lock(&g_hybris.lock);
    if (g_hybris.initialized) {
        pthread_mutex_unlock(&g_hybris.lock);
        return 0;
    }

    /*
     * Install a dummy bionic fs base BEFORE any Android library loads.
     * bionic's DT_INIT_ARRAY constructors (and any library loaded by the
     * hybris core init) start with "mov rax, fs:[0]" to read the Android TLS
     * base.  On Windows x86_64 the fs segment base is 0 in user mode, so
     * that read faults at address 0.  Set it up once here so all subsequent
     * android_dlopen calls see a valid fs base.
     */
#ifdef _WIN32
    fprintf(stderr, "[drm] calling setup_bionic_fs_base_win\n");
    fflush(stderr);
    if (!g_host_fs_saved) {
        __asm__ volatile("rdfsbase %0" : "=r"(g_host_fs_base));
        g_host_fs_saved = 1;
    }
    setup_bionic_fs_base_win();
    fprintf(stderr, "[drm] fs base set, tls[0]=%p\n", (void *)(uintptr_t)g_bionic_tls_slots[0]);
    fflush(stderr);
#endif

    /*
     * Load libhybris-core.so and all Android .so dependencies. Linux loads the
     * embedded core from an anonymous memfd; Windows loads the supplied native
     * module and both paths hand Android libraries to android_dlopen().
     */
#ifdef _WIN32
    if (embedded_loader_init_path(hybris_core_path) != 0) {
#else
    (void)hybris_core_path;
    if (embedded_loader_init() != 0) {
#endif
        fprintf(stderr, "[hybris] embedded_loader_init failed: %s\n",
                embedded_dlerror());
        pthread_mutex_unlock(&g_hybris.lock);
        return -1;
    }

#ifndef _WIN32
    /* Newer Apple Music builds (4.9.x/5.x) import two libc symbols that bionic's libc.so here does not define. */
    embedded_set_hook_callback(hybris_libc_shim_hook);
#endif

    /*
     * Wire android_dlopen/dlsym to the embedded loader wrappers.
     * Signatures are identical to the raw hybris exports, so no casts needed.
     */
    g_hybris.android_dlopen = embedded_dlopen;
    g_hybris.android_dlsym = embedded_dlsym_in;
    g_hybris.android_dlclose = NULL; /* not exposed by embedded loader */

    /* libandroidappmusic.so depends on libCoreFP.so; load it first. */
    fprintf(stderr, "[drm] loading libCoreFP.so\n");
    fflush(stderr);
    g_hybris.corefp_handle = g_hybris.android_dlopen("libCoreFP.so", RTLD_NOW | HYBRIS_WIN_RTLD_GLOBAL);
    fprintf(stderr, "[drm] libCoreFP.so handle=%p\n", g_hybris.corefp_handle);
    fflush(stderr);
    if (!g_hybris.corefp_handle)
        fprintf(stderr, "[hybris] libCoreFP.so: load failed\n");

    /* ── Load libandroidappmusic.so (proven path) ── */
    /* Must also load libstoreservicescore.so first (dependency) */
    fprintf(stderr, "[drm] loading libstoreservicescore.so\n");
    fflush(stderr);
    g_hybris.ssc_handle = g_hybris.android_dlopen("libstoreservicescore.so", RTLD_NOW | RTLD_GLOBAL);
    fprintf(stderr, "[drm] libstoreservicescore.so handle=%p\n", g_hybris.ssc_handle);
    fflush(stderr);
    if (!g_hybris.ssc_handle)
        fprintf(stderr, "[hybris] libstoreservicescore.so: load failed (may still work)\n");

    fprintf(stderr, "[drm] loading libandroidappmusic.so\n");
    fflush(stderr);
    g_hybris.appmusic_handle = g_hybris.android_dlopen("libandroidappmusic.so", RTLD_NOW | HYBRIS_WIN_RTLD_GLOBAL);
    fprintf(stderr, "[drm] libandroidappmusic.so handle=%p\n", g_hybris.appmusic_handle);
    fflush(stderr);
    if (g_hybris.appmusic_handle) {
#ifdef _WIN32
        void *nfc_symbol = g_hybris.android_dlsym(
            g_hybris.appmusic_handle, "NfcRKVnxuKZy04KWbdFu71Ou");
        memcpy(&g_hybris.nfc_decrypt, &nfc_symbol,
               sizeof(g_hybris.nfc_decrypt));
#else
        g_hybris.nfc_decrypt = (nfc_decrypt_fn)
                                   g_hybris.android_dlsym(g_hybris.appmusic_handle,
                                                          "NfcRKVnxuKZy04KWbdFu71Ou");
#endif

        g_hybris.appmusic_available = (g_hybris.nfc_decrypt != NULL);
        DRM_DEBUG("[hybris] libandroidappmusic.so: NfcRK=%s\n",
                  g_hybris.nfc_decrypt != NULL ? "resolved" : "missing");
    } else {
        fprintf(stderr, "[hybris] libandroidappmusic.so: load failed\n");
    }

    if (!g_hybris.appmusic_available) {
        fprintf(stderr, "[hybris] no usable backend — giving up\n");
        pthread_mutex_unlock(&g_hybris.lock);
        return -1;
    }

#ifdef _WIN32
    /* Share the handles opened above with the native wrapper. Its symbol
     * forwarding layer must not open the same guest libraries a second time. */
    hybris_bind_lib_handles(g_hybris.ssc_handle, g_hybris.appmusic_handle,
                            g_hybris.corefp_handle);
#endif

#ifndef _WIN32
    /* Redirect all curl calls from the Android libs to the system libcurl that
     * libdrm_client.so links against.  Since every curl symbol (init, setopt,
     * perform, cleanup, …) goes through the same library, CURL handles are
     * fully compatible.  curl_easy_setopt is replaced by our shim which also
     * patches the GrandSlam lookup response to enable phone OTP. */
    patch_android_curl();
#endif

    g_hybris.initialized = 1;
    DRM_DEBUG("[hybris] initialized\n");
#ifdef _WIN32
    hybris_guest_fs_leave();
#endif
    pthread_mutex_unlock(&g_hybris.lock);
    return 0;
}

/* ── FairPlay session (wrapper library: lease, recovery, key contexts) ───────*/

/*
 * The FairPlay request context, authentication state, playback lease (with the
 * Android-style automatic refresh / recovery state machine) and key-context
 * derivation come from the vendored host-native wrapper in native/ (drm_lib_*).
 */
extern int aml_lib_init_guarded(const drm_lib_config_t *cfg);
extern int aml_lib_login_guarded(const char *username, const char *password);
extern void *aml_open_kd_ctx_guarded(const char *adam, const char *uri);

static void wrapper_state_cb(const char *state, void *ud)
{
    (void)ud;
    fprintf(stderr, "[hybris] wrapper state: %s\n", state);
}

int hybris_fairplay_init(const char *base_dir, const char *device_info,
                         const char *lib64_dir,
                         const char *username, const char *password,
                         drm_auth_cb_t auth_cb, void *auth_ud)
{
    if (!g_hybris.initialized || !g_hybris.appmusic_available) return -1;
    hybris_commit_thread_stack();
    if (g_hybris.fairplay_inited) {
        /* Already initialized — if new credentials are supplied, log in now. */
        if (username && password)
            return aml_lib_login_guarded(username, password);
        return 0;
    }

    drm_lib_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.base_dir = base_dir;
    cfg.lib64_dir = lib64_dir;
    cfg.device_info = device_info;
    cfg.username = username;
    cfg.password = password;
    cfg.state_cb = wrapper_state_cb;
    cfg.auth_cb = auth_cb; /* 2FA codes come from the app, not the terminal */
    cfg.auth_ud = auth_ud;

    int rc = aml_lib_init_guarded(&cfg);
    if (rc == 0) g_hybris.fairplay_inited = 1;
    return rc;
}

extern const char *drm_lib_last_error(void);
const char *hybris_last_error(void)
{
    return drm_lib_last_error();
}

/* ── URI-based context ───────────────────────────────────────────────────────*/

extern pthread_mutex_t g_fp_call_mutex;
extern volatile unsigned g_decrypt_epoch;

void *hybris_open_kd_ctx_from_uri(const char *adam, const char *uri, unsigned *epoch)
{
    if (!g_hybris.initialized || !g_hybris.fairplay_inited) {
        fprintf(stderr, "[hybris] open_kd_ctx_from_uri: FairPlay session not ready\n");
        return NULL;
    }
    if (!adam || !uri) return NULL;
    hybris_commit_thread_stack();
    if (drm_lib_is_recovery_active()) {
        fprintf(stderr, "[hybris] key context refused: lease recovery in progress\n");
        return NULL;
    }
    pthread_mutex_lock(&g_fp_call_mutex);
    if (epoch) *epoch = __atomic_load_n(&g_decrypt_epoch, __ATOMIC_SEQ_CST);
    void *ctx = aml_open_kd_ctx_guarded(adam, uri);
    pthread_mutex_unlock(&g_fp_call_mutex);
    if (!ctx)
        fprintf(stderr, "[hybris] key context failed for adam=%s uri=%s\n", adam, uri);
    else
        DRM_DEBUG("[hybris] key ctx adam=%s uri=%s: %p\n", adam, uri, ctx);
    return ctx;
}

/* ── Decryption ──────────────────────────────────────────────────────────────*/

int hybris_backend_decrypt(void *ctx, unsigned epoch, uint8_t *data, uint32_t len)
{
    if (!ctx || !data || !g_hybris.fairplay_inited) return -1;
    uint32_t whole = len & ~0xfU;
    if (whole == 0) return 0;
    hybris_commit_thread_stack();
    pthread_mutex_lock(&g_fp_call_mutex);
    int ret;
    if (epoch != __atomic_load_n(&g_decrypt_epoch, __ATOMIC_SEQ_CST))
        ret = HYBRIS_ERR_STALE_CONTEXT; /* freed by a lease refresh; reopen the key */
    else
        ret = drm_lib_decrypt(ctx, data, whole);
    pthread_mutex_unlock(&g_fp_call_mutex);
    return ret;
}
