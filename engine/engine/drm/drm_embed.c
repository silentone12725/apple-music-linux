#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "drm_embed.h"

/* Error codes written to errpipe on child failure.
 * Parent reads these; EOF (n==0) means execve() succeeded. */
#define ERR_CHDIR_WRAPPER   1
#define ERR_UNSHARE         2
#define ERR_UID_MAP         3
#define ERR_SETGROUPS       4
#define ERR_GID_MAP         5
#define ERR_CHDIR_ROOTFS    6
#define ERR_CHROOT          7
#define ERR_CHDIR_ROOT      8
#define ERR_MOUNT_PROC      9
#define ERR_EXECVE         10
#define ERR_UNSHARE_PID    11
#define ERR_INNER_FORK     12

static void fail_pipe(int errpipe, int code) {
    write(errpipe, &code, sizeof(code));
    /* _exit closes errpipe, no flush needed */
    _exit(1);
}

/* write_file: write a single line to a /proc file (uid_map, gid_map, setgroups). */
static int write_file(const char *path, const char *line) {
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    ssize_t len = (ssize_t)strlen(line);
    ssize_t ret = write(fd, line, (size_t)len);
    close(fd);
    return (ret == len) ? 0 : -1;
}

/* setup_user_namespace: create CLONE_NEWUSER|CLONE_NEWNS and map uid/gid 0
 * to the calling process's real uid/gid so chroot/mount work without root. */
static int setup_user_namespace(int errpipe) {
    uid_t uid = getuid();
    gid_t gid = getgid();
    char buf[128];

    if (unshare(CLONE_NEWUSER | CLONE_NEWNS) == -1) {
        perror("drm_embed: unshare(NEWUSER|NEWNS)");
        fail_pipe(errpipe, ERR_UNSHARE);
    }

    snprintf(buf, sizeof(buf), "0 %u 1\n", uid);
    if (write_file("/proc/self/uid_map", buf) == -1) {
        perror("drm_embed: uid_map");
        fail_pipe(errpipe, ERR_UID_MAP);
    }
    /* deny setgroups before writing gid_map (required on Linux 3.19+) */
    if (write_file("/proc/self/setgroups", "deny\n") == -1) {
        perror("drm_embed: setgroups");
        fail_pipe(errpipe, ERR_SETGROUPS);
    }
    snprintf(buf, sizeof(buf), "0 %u 1\n", gid);
    if (write_file("/proc/self/gid_map", buf) == -1) {
        perror("drm_embed: gid_map");
        fail_pipe(errpipe, ERR_GID_MAP);
    }
    return 0;
}

/* build_argv: construct the argv for /system/bin/main from cfg.
 * argv must have room for at least 24 pointers. Returns argc. */
static int build_argv(const DRMEmbedConfig *cfg, char **argv) {
    int i = 0;
    argv[i++] = (char *)"main";
    if (cfg->code_from_file) argv[i++] = (char *)"--code-from-file";
    if (cfg->base_dir    && cfg->base_dir[0])    { argv[i++] = (char *)"--base-dir";     argv[i++] = (char *)cfg->base_dir; }
    if (cfg->host        && cfg->host[0])        { argv[i++] = (char *)"--host";          argv[i++] = (char *)cfg->host; }
    if (cfg->decrypt_port&& cfg->decrypt_port[0]){ argv[i++] = (char *)"--decrypt-port"; argv[i++] = (char *)cfg->decrypt_port; }
    if (cfg->m3u8_port   && cfg->m3u8_port[0])  { argv[i++] = (char *)"--m3u8-port";    argv[i++] = (char *)cfg->m3u8_port; }
    if (cfg->account_port&& cfg->account_port[0]){ argv[i++] = (char *)"--account-port"; argv[i++] = (char *)cfg->account_port; }
    if (cfg->device_info && cfg->device_info[0]) { argv[i++] = (char *)"--device-info";  argv[i++] = (char *)cfg->device_info; }
    if (cfg->login       && cfg->login[0])       { argv[i++] = (char *)"--login";         argv[i++] = (char *)cfg->login; }
    argv[i] = NULL;
    return i;
}

/* child_main: runs in the child after fork(). Never returns — either exec's
 * the Android binary or calls _exit().
 *
 * errpipe is the write end of the error pipe. It is O_CLOEXEC so it closes
 * automatically when execve() succeeds; on any earlier failure we write an
 * error code and call _exit(), which closes it unconditionally.
 *
 * All operations are pure C — the Go runtime is never re-entered. */
static void child_main(const DRMEmbedConfig *cfg, int errpipe) {
    /* Become our own process-group leader BEFORE the inner fork() below, so
     * the grandchild (the "main" worker, execve'd further down) is born into
     * this new group too (process groups are inherited at fork time). This
     * lets Go's Stop() do an explicit group kill (-pid) instead of relying on
     * PR_SET_PDEATHSIG surviving the grandchild's execve — which the kernel
     * only guarantees for a non-setuid/setgid/fscap binary (see the note
     * further down). Repeated trials (2026-07-08) found the existing
     * PR_SET_PDEATHSIG call already reaps the worker reliably in this
     * environment even without this change, so this is defense-in-depth
     * against that assumption silently breaking (e.g. if a future rootfs
     * build marks /system/bin/main with file capabilities), not a fix for an
     * observed failure. setpgid(0,0) on ourself is always legal (no exec has
     * happened yet). */
    setpgid(0, 0);

    /* Navigate to wrapper_dir so rootfs/ is a relative sub-directory. */
    if (cfg->wrapper_dir && cfg->wrapper_dir[0]) {
        if (chdir(cfg->wrapper_dir) != 0) {
            perror("drm_embed child: chdir(wrapper_dir)");
            fail_pipe(errpipe, ERR_CHDIR_WRAPPER);
        }
    }

    /* Establish unprivileged user + mount namespace. */
    setup_user_namespace(errpipe);

    /* Bind-mount /dev/urandom into the rootfs so the Android binary can use it. */
    mkdir("rootfs/dev", 0755); /* ignore EEXIST */
    {
        int fd = open("rootfs/dev/urandom", O_CREAT | O_RDWR, 0666);
        if (fd >= 0) close(fd);
    }
    if (mount("/dev/urandom", "rootfs/dev/urandom", NULL, MS_BIND, NULL) != 0) {
        perror("drm_embed child: bind-mount /dev/urandom");
        /* non-fatal: Android binary may use getrandom() syscall instead */
    }

    /* The Android linker and binary must be executable inside the namespace. */
    chmod("rootfs/system/bin/linker64", 0755);
    chmod("rootfs/system/bin/main",     0755);

    /* Enter the rootfs. chroot requires uid 0, which we have inside the
     * user namespace we just created. */
    if (chdir("rootfs") != 0) {
        perror("drm_embed child: chdir(rootfs)");
        fail_pipe(errpipe, ERR_CHDIR_ROOTFS);
    }
    if (chroot(".") != 0) {
        perror("drm_embed child: chroot");
        fail_pipe(errpipe, ERR_CHROOT);
    }
    if (chdir("/") != 0) {
        perror("drm_embed child: chdir(/)");
        fail_pipe(errpipe, ERR_CHDIR_ROOT);
    }

    /* Create a new PID namespace.  Mirrors wrapper-rootless.c exactly:
     * mounting procfs inside a user namespace requires the mounting process
     * to be PID 1 in a new PID namespace.  unshare(CLONE_NEWPID) affects
     * the first child we fork — that child becomes PID 1 in the new namespace
     * and is allowed to mount proc. */
    if (unshare(CLONE_NEWPID) != 0) {
        perror("drm_embed child: unshare(NEWPID)");
        fail_pipe(errpipe, ERR_UNSHARE_PID);
    }

    /* Fork again — the grandchild is PID 1 in the new PID namespace. */
    pid_t inner = fork();
    if (inner < 0) {
        perror("drm_embed child: inner fork");
        fail_pipe(errpipe, ERR_INNER_FORK);
    }
    if (inner > 0) {
        /* Intermediate waiter: close errpipe so we don't hold it open.
         * The grandchild inherited errpipe[1]; when it exec's, O_CLOEXEC
         * closes it and the parent reads EOF.  This process just waits.
         * Mirrors wrapper-rootless.c wait(NULL) exactly. */
        close(errpipe);
        wait(NULL);
        _exit(0);
    }

    /* Grandchild (PID 1 in the new PID namespace): install parent-death
     * signal so we are SIGKILL'd if the waiter dies before we exec. This
     * covers the pre-exec window unconditionally; whether it also covers
     * post-exec depends on kernel semantics that are conditional on this
     * binary's privilege attributes (PR_SET_PDEATHSIG is cleared on execve of
     * a setuid/setgid binary or one with file capabilities — see prctl(2)).
     * Repeated controlled trials against /system/bin/main as currently built
     * (2026-07-08) found it IS reaped when only the waiter is killed, so this
     * prctl call already covers the common case. The setpgid(0,0) call at the
     * top of child_main() plus Go's group kill (-pid) in Stop() make that
     * guarantee explicit and independent of the binary's privilege
     * attributes, rather than relying on this prctl surviving exec. */
    prctl(PR_SET_PDEATHSIG, SIGKILL);

    /* Grandchild: PID 1 in the new PID namespace.
     * Mount /proc (now permitted because we are PID 1 in a PID namespace). */
    mkdir("/proc", 0755); /* ignore EEXIST */
    if (mount("proc", "/proc", "proc", 0, NULL) != 0) {
        perror("drm_embed child: mount proc");
        fail_pipe(errpipe, ERR_MOUNT_PROC);
    }

    /* Create base_dir and mpl_db if they don't exist. */
    const char *bd = (cfg->base_dir && cfg->base_dir[0])
        ? cfg->base_dir
        : "/data/data/com.apple.android.music/files";
    mkdir(bd, 0777); /* ignore EEXIST */
    {
        char db_dir[1024];
        snprintf(db_dir, sizeof(db_dir), "%s/mpl_db", bd);
        mkdir(db_dir, 0777);
    }

    /* Suppress wrapper output when requested — redirect stdout and stderr to
     * /dev/null before exec so the parent terminal stays clean. */
    if (cfg->suppress_output) {
        int null_fd = open("/dev/null", O_WRONLY);
        if (null_fd >= 0) {
            dup2(null_fd, STDOUT_FILENO);
            dup2(null_fd, STDERR_FILENO);
            close(null_fd);
        }
    }

    /* Build argv and exec the Android binary.
     * execve() closes errpipe (O_CLOEXEC) on success → parent reads EOF.
     * On failure, write error code and let _exit() clean up. */
    char *argv[24];
    build_argv(cfg, argv);

    extern char **environ;
    execve("/system/bin/main", argv, environ);
    perror("drm_embed child: execve /system/bin/main");
    fail_pipe(errpipe, ERR_EXECVE);
}

/* errcode_to_string: human-readable label for the error pipe codes above. */
static const char *errcode_to_string(int code) {
    switch (code) {
    case ERR_CHDIR_WRAPPER: return "chdir(wrapper_dir) failed";
    case ERR_UNSHARE:       return "unshare(NEWUSER|NEWNS) failed — unprivileged user namespaces may be disabled (sysctl kernel.unprivileged_userns_clone)";
    case ERR_UID_MAP:       return "write /proc/self/uid_map failed";
    case ERR_SETGROUPS:     return "write /proc/self/setgroups failed";
    case ERR_GID_MAP:       return "write /proc/self/gid_map failed";
    case ERR_CHDIR_ROOTFS:  return "chdir(rootfs) failed — rootfs/ missing inside wrapper_dir";
    case ERR_CHROOT:        return "chroot(rootfs) failed";
    case ERR_CHDIR_ROOT:    return "chdir(/) post-chroot failed";
    case ERR_MOUNT_PROC:    return "mount proc failed — unexpected in PID namespace (kernel version or seccomp?)";
    case ERR_EXECVE:        return "execve /system/bin/main failed — binary missing or not executable";
    case ERR_UNSHARE_PID:   return "unshare(NEWPID) failed — kernel may restrict nested PID namespaces";
    case ERR_INNER_FORK:    return "inner fork failed";
    default:                return "unknown setup error";
    }
}

/* drm_embed_start: fork a container child and return its PID.
 *
 * Uses an O_CLOEXEC error pipe to detect setup/execve failures synchronously:
 * - EOF on pipe (read returns 0): child exec'd successfully → return child PID.
 * - Data on pipe: child wrote an error code before failing → log + reap + return -1.
 *
 * The parent blocks only until the child exec's or fails; it does not wait
 * for the Android service to become ready. */
pid_t drm_embed_start(const DRMEmbedConfig *cfg) {
    int errpipe[2];
    if (pipe2(errpipe, O_CLOEXEC) == -1) {
        perror("drm_embed: pipe2");
        return -1;
    }

    pid_t child = fork();
    if (child < 0) {
        close(errpipe[0]);
        close(errpipe[1]);
        perror("drm_embed: fork");
        return -1;
    }
    if (child == 0) {
        /* Child: close read end; errpipe[1] is O_CLOEXEC and is used by
         * fail_pipe() or closes automatically on execve(). */
        close(errpipe[0]);
        child_main(cfg, errpipe[1]);
        /* child_main never returns */
        _exit(1);
    }

    /* Parent: close write end and read from the error pipe. */
    close(errpipe[1]);

    int err_code = 0;
    ssize_t n = read(errpipe[0], &err_code, sizeof(err_code));
    close(errpipe[0]);

    if (n > 0) {
        /* Child reported a setup failure before exec. */
        fprintf(stderr, "drm_embed: container setup failed: %s\n",
                errcode_to_string(err_code));
        waitpid(child, NULL, 0); /* reap immediately */
        return -1;
    }

    /* n == 0: EOF — execve() succeeded; pipe closed via O_CLOEXEC.
     * n  < 0: EINTR or similar — treat as success (child is running). */
    return child;
}
