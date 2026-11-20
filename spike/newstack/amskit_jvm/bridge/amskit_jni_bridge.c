/*
 * libamskit_jni_bridge.so — glibc wrapper that loads libAMSKit.so through hybris
 * and forwards JNI_OnLoad to the OpenJDK JVM.
 *
 * Build: cc -shared -fPIC -o libamskit_jni_bridge.so amskit_jni_bridge.c \
 *          -I<drm_dir> -L<drm_dir> -ldrm_client -Wl,-rpath,'$ORIGIN' \
 *          -I/usr/lib/jvm/java-27-openjdk/include \
 *          -I/usr/lib/jvm/java-27-openjdk/include/linux
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dlfcn.h>
#include <jni.h>

#include "embedded_loader.h"

typedef jint (*JNI_OnLoad_fn)(JavaVM *vm, void *reserved);
typedef void (*JNI_OnUnload_fn)(JavaVM *vm, void *reserved);

static void     *g_amskit_handle = NULL;
static JNI_OnLoad_fn g_amskit_JNI_OnLoad = NULL;
static JNI_OnUnload_fn g_amskit_JNI_OnUnload = NULL;

/*
 * Load libAMSKit.so through hybris with the rootfs-6.5.2 lib64 as the
 * Android library search path.
 */
static int shim_atfork(void *a, void *b, void *c, void *d) { (void)a;(void)b;(void)c;(void)d; return 0; }
static void *shim_memchr_chk(const void *s, int c, size_t n, size_t bs) { (void)bs; return memchr(s, c, n); }

static void *bridge_hook(const char *symbol, const char *requester) {
    (void)requester;
    if (!symbol) return NULL;
    if (!strcmp(symbol, "stdout")) return (void *)&stdout;
    if (!strcmp(symbol, "stderr")) return (void *)&stderr;
    if (!strcmp(symbol, "__register_atfork")) return (void *)shim_atfork;
    if (!strcmp(symbol, "__memchr_chk")) return (void *)shim_memchr_chk;
    if (!strcmp(symbol, "stdin"))  return (void *)&stdin;
    return NULL;
}

static int load_amskit(void) {
    if (g_amskit_handle) return 0;

    /* Locate the bridge .so itself to find sibling paths */
    const char *rootfs_lib64 = getenv("ADAM_AMSKIT_LIB64");
    if (!rootfs_lib64) {
        /* Default: rootfs-6.5.2 relative to this .so's directory, or override */
        /* Caller must set ADAM_AMSKIT_LIB64 or HYBRIS_LD_LIBRARY_PATH */
        fprintf(stderr, "amskit_bridge: ADAM_AMSKIT_LIB64 not set, trying HYBRIS_LD_LIBRARY_PATH\n");
    } else {
        setenv("HYBRIS_LD_LIBRARY_PATH", rootfs_lib64, 0); /* don't override if set */
        setenv("HYBRIS_ANDROID_LIB64",   rootfs_lib64, 0);
        char root[4096];
        snprintf(root, sizeof(root), "%s/../..", rootfs_lib64);
        setenv("ANDROID_ROOT", root, 0);
    }

    if (embedded_loader_init() != 0) {
        fprintf(stderr, "amskit_bridge: embedded_loader_init failed\n");
        return -1;
    }

    embedded_set_hook_callback(bridge_hook);
    /* Use the same android_dlopen exposed by embedded_loader */
    g_amskit_handle = embedded_dlopen("libAMSKit.so", 2 /* RTLD_NOW */);
    if (!g_amskit_handle) {
        fprintf(stderr, "amskit_bridge: embedded_dlopen(libAMSKit.so) failed\n");
        return -1;
    }

    g_amskit_JNI_OnLoad   = (JNI_OnLoad_fn)  embedded_dlsym_in(g_amskit_handle, "JNI_OnLoad");
    g_amskit_JNI_OnUnload = (JNI_OnUnload_fn) embedded_dlsym_in(g_amskit_handle, "JNI_OnUnload");

    if (!g_amskit_JNI_OnLoad) {
        fprintf(stderr, "amskit_bridge: JNI_OnLoad not found in libAMSKit.so\n");
        return -1;
    }

    fprintf(stderr, "amskit_bridge: libAMSKit.so loaded, JNI_OnLoad @ %p\n", (void*)g_amskit_JNI_OnLoad);
    return 0;
}

/*
 * JNI_OnLoad — the JVM calls this when System.load("libamskit_jni_bridge.so").
 * We forward to AMSKit's JNI_OnLoad which registers all 3827 Java_* methods.
 */
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    if (load_amskit() != 0) {
        fprintf(stderr, "amskit_bridge: load_amskit failed in JNI_OnLoad\n");
        return JNI_ERR;
    }
    jint ret = g_amskit_JNI_OnLoad(vm, reserved);
    fprintf(stderr, "amskit_bridge: AMSKit JNI_OnLoad returned %d\n", (int)ret);
    return ret;
}

JNIEXPORT void JNICALL JNI_OnUnload(JavaVM *vm, void *reserved) {
    if (g_amskit_JNI_OnUnload)
        g_amskit_JNI_OnUnload(vm, reserved);
}

JNIEXPORT jlong JNICALL Java_adam_Native_find(JNIEnv *env, jclass c, jstring sym) {
    (void)c;
    if (!g_amskit_handle) return 0;
    const char *s = (*env)->GetStringUTFChars(env, sym, NULL);
    void *p = embedded_dlsym_in(g_amskit_handle, s);
    (*env)->ReleaseStringUTFChars(env, sym, s);
    return (jlong)(intptr_t)p;
}

JNIEXPORT jint JNICALL Java_adam_Native_reg(JNIEnv *env, jclass c, jclass target, jstring name, jstring sig, jlong fn) {
    (void)c;
    const char *n = (*env)->GetStringUTFChars(env, name, NULL);
    const char *g = (*env)->GetStringUTFChars(env, sig, NULL);
    JNINativeMethod m = { (char *)n, (char *)g, (void *)(intptr_t)fn };
    jint r = (*env)->RegisterNatives(env, target, &m, 1);
    (*env)->ReleaseStringUTFChars(env, name, n);
    (*env)->ReleaseStringUTFChars(env, sig, g);
    return r;
}
