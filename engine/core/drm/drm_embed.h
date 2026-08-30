/* drm_embed.h — CGO interface for launching the Apple Music Android binary
 * inside an unprivileged container without a separate wrapper-rootless binary.
 *
 * Called by EmbeddedBackend.Start() via CGO. drm_embed_start() forks once,
 * does all container setup in the child (user namespace, bind mounts, chroot),
 * and exec's the Android binary. Returns the child PID to Go so it can be
 * monitored with syscall.Wait4. Does NOT block.
 */
#ifndef DRM_EMBED_H
#define DRM_EMBED_H

#include <sys/types.h>

typedef struct {
    const char *wrapper_dir;   /* host path containing rootfs/             */
    const char *base_dir;      /* --base-dir inside chroot (optional)      */
    const char *host;          /* bind host, e.g. "127.0.0.1"             */
    const char *decrypt_port;  /* --decrypt-port, e.g. "10020"            */
    const char *m3u8_port;     /* --m3u8-port,    e.g. "20020"            */
    const char *account_port;  /* --account-port, e.g. "30020"            */
    const char *device_info;   /* 9-field device identifier string         */
    const char *login;         /* "email:password" or NULL for session reuse */
    int         code_from_file;  /* non-zero → pass --code-from-file       */
    int         suppress_output; /* non-zero → redirect stdout/stderr to /dev/null */
} DRMEmbedConfig;

/* drm_embed_start: fork a container child and return its PID.
 *
 * The child process:
 *   1. chdir(wrapper_dir)
 *   2. unshare(CLONE_NEWUSER | CLONE_NEWNS) — unprivileged user+mount namespace
 *   3. map uid/gid 0 → current uid/gid
 *   4. bind-mount /dev/urandom into rootfs/dev/urandom
 *   5. chmod system/bin/linker64, system/bin/main
 *   6. chdir("rootfs") + chroot(".") + chdir("/")
 *   7. mount proc → /proc
 *   8. mkdir base_dir + base_dir/mpl_db
 *   9. execve /system/bin/main [argv built from config]
 *
 * Returns the child PID (> 0) on success, -1 on fork failure.
 * The child is a direct child of the calling process; use Wait4(pid) to reap.
 *
 * SAFETY: safe to call from a CGO goroutine. The child runs pure C after
 * fork() — it never re-enters the Go runtime. The parent returns immediately
 * and does no namespace/chroot operations.
 */
pid_t drm_embed_start(const DRMEmbedConfig *cfg);

#endif /* DRM_EMBED_H */
