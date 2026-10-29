/*
 * fake_jni.h - a small JNI environment for driving libAMSKit's JavaCPP bindings without a JVM.
 *
 * Objects are plain structs; a jobject/jclass/jstring/jmethodID/jfieldID is a pointer to one. JavaCPP keeps the native
 * address of a Pointer subclass in the object's "address" field, set through Pointer.init(...); that is modelled here.
 * Calls from native code into "Java" (CallXMethod) go to fake_jni_java_call(), which the host program implements.
 */
#ifndef FAKE_JNI_H
#define FAKE_JNI_H
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef union { int32_t i; int64_t j; double d; float f; void *l; } fj_value;

typedef struct fj_obj fj_obj;
struct fj_field { const void *fid; int64_t val; };
struct fj_obj {
    int kind;                        /* 1 object, 2 class, 3 string, 4 method id, 5 field id, 6 array */
    const char *name;                /* class name / method name / field name */
    const char *sig;                 /* method or field signature */
    fj_obj *cls;                     /* class of an object / owner class of an id */
    int64_t address;                 /* JavaCPP Pointer.address */
    char *str; size_t len;           /* strings */
    void *data; int elem; int64_t count;   /* arrays: elem = element size (0 = objects) */
    struct fj_field f[24]; int nf;
};

/* Implemented by the host: a native-to-Java call. `args` holds decoded arguments in signature order. */
fj_value fake_jni_java_call(fj_obj *obj, fj_obj *method, const fj_value *args, int nargs);

extern int fake_jni_trace;
void *fake_jni_env(void);            /* JNIEnv* */
void *fake_jni_vm(void);             /* JavaVM* */
fj_obj *fake_jni_new_object(const char *class_name);
fj_obj *fake_jni_new_string(const char *s);
fj_obj *fake_jni_new_byte_array(const void *p, size_t n);
fj_obj *fake_jni_new_list(void);
void fake_jni_list_add(fj_obj *list, fj_obj *item);
fj_obj *fake_jni_new_pair(fj_obj *first, fj_obj *second);
void fake_jni_set_field(fj_obj *o, const char *cls, const char *name, const char *sig, int64_t v);
int64_t fake_jni_get_field(fj_obj *o, const char *cls, const char *name);
const char *fake_jni_pending_exception(void);

#endif
