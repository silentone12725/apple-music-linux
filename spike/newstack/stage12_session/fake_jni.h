/*
 * fake_jni.h — stage11: same as stage10 but with CallVoidMethodA fixed to
 * actually store args[0].j in obj->address (the setAddress path for flag==0).
 *
 * Key change vs stage10:
 *   fake_CallVoidMethodA now stores args[0].j in obj->address.
 *   This lets IInterruptHandlerAdaptor_allocate, INativeAnisetteProvider_allocate,
 *   etc. return real C++ object pointers through fake_obj_t->address.
 *
 * Callers must pass a real fake_obj_t* as the second arg (thiz/cls slot) instead
 * of a small integer — the guard (uintptr_t)obj < 0x1000 catches small ints.
 */
#pragma once
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>

/* ---- Types ---------------------------------------------------------------- */
typedef void   *jobject;
typedef void   *jclass;
typedef void   *jmethodID;
typedef int64_t jfieldID;
typedef int64_t jlong;
typedef int32_t jint;
typedef uint8_t jboolean;
typedef uint8_t jbyte;
typedef uint16_t jchar;
typedef void   *jstring;
typedef void   *jarray;
typedef void   *jthrowable;
typedef void   *jweak;
typedef union { jboolean z; jbyte b; jchar c; jint i; jlong j; float f; double d; jobject l; } jvalue;
typedef size_t  jsize;
#define JNI_FALSE 0
#define JNI_TRUE  1
#define JNI_OK    0
#define JNIEXPORT
#define JNICALL

/* ---- fake_obj ------------------------------------------------------------- */
typedef struct { jlong class_id; jlong address; } fake_obj_t;

static inline fake_obj_t *fake_alloc_obj(jlong class_id) {
    fake_obj_t *o = calloc(1, sizeof(fake_obj_t));
    if (o) o->class_id = class_id;
    return o;
}
static inline jlong  fake_get_address(fake_obj_t *o) { return o ? o->address : 0; }
static inline void   fake_set_address(fake_obj_t *o, jlong addr) { if (o) o->address = addr; }

/* Make a BytePointer-compatible fake jobject wrapping a C string. */
static inline fake_obj_t *fake_byteptr(const char *s) {
    fake_obj_t *o = fake_alloc_obj(0);
    if (o) o->address = (jlong)(uintptr_t)s;
    return o;
}

/* ---- JNI function table --------------------------------------------------- */
#define JNITAB_SIZE 232

static jint JNICALL fake_GetVersion(void *env) { return 0x00010006; }
static jclass JNICALL fake_FindClass(void *env, const char *name) {
    static jlong id; return (jclass)(uintptr_t)(++id);
}
static jobject JNICALL fake_AllocObject(void *env, jclass cls) {
    return fake_alloc_obj((jlong)(uintptr_t)cls);
}
/*
 * javacpp Pointer field IDs — the library caches these in globals at load time.
 * All fields except "address" return 0 (single-object wrapper: position=0,
 * limit=0, capacity=0). Without distinct IDs the capacity*0x130 multiply in
 * the provider setters would overflow using the C++ ptr instead of 0.
 */
#define FID_ADDRESS   ((jfieldID)0x41)
#define FID_POSITION  ((jfieldID)0x50)
#define FID_LIMIT     ((jfieldID)0x4c)
#define FID_CAPACITY  ((jfieldID)0x43)
#define FID_OTHER     ((jfieldID)0x01)

static jfieldID JNICALL fake_GetFieldID(void *env, jclass cls, const char *name, const char *sig) {
    jfieldID result = FID_OTHER;
    if (name) {
        if (!strcmp(name, "address"))  result = FID_ADDRESS;
        else if (!strcmp(name, "position")) result = FID_POSITION;
        else if (!strcmp(name, "limit"))    result = FID_LIMIT;
        else if (!strcmp(name, "capacity")) result = FID_CAPACITY;
    }
    fprintf(stderr, "  [GFI] name=%s sig=%s → fid=0x%lx\n",
            name ? name : "(null)", sig ? sig : "(null)",
            (unsigned long)(uintptr_t)result);
    return result;
}
static int g_jni_trace = 0; /* set to 1 around calls to trace JNI */
static jlong JNICALL fake_GetLongField(void *env, jobject obj, jfieldID fid) {
    jlong result;
    if ((uintptr_t)obj < 0x1000) {
        result = 0;
    } else {
        fake_obj_t *o = (fake_obj_t *)obj;
        result = (fid == FID_ADDRESS) ? o->address : 0;
    }
    if (g_jni_trace)
        fprintf(stderr, "  [GLF] obj=%p fid=0x%lx → 0x%lx\n",
                obj, (unsigned long)(uintptr_t)fid, (unsigned long)result);
    return result;
}
static void JNICALL fake_SetLongField(void *env, jobject obj, jfieldID fid, jlong val) {
    if ((uintptr_t)obj < 0x1000) return;
    fake_obj_t *o = (fake_obj_t *)obj;
    if (fid == FID_ADDRESS && o) o->address = val;
}
static jboolean JNICALL fake_ExceptionCheck(void *env) { return JNI_FALSE; }
static jint JNICALL fake_ThrowNew(void *env, jclass cls, const char *msg) { return 0; }
static void JNICALL fake_DeleteLocalRef(void *env, jobject obj) {}
static void JNICALL fake_ExceptionClear(void *env) {}
static void JNICALL fake_ExceptionDescribe(void *env) {}

static jstring JNICALL fake_NewStringUTF(void *env, const char *cstr) {
    fake_obj_t *o = fake_alloc_obj(0);
    if (o) o->address = (jlong)(uintptr_t)cstr;
    return o;
}
static const char * JNICALL fake_GetStringUTFChars(void *env, jstring jstr, jboolean *isCopy) {
    fake_obj_t *o = (fake_obj_t *)jstr;
    if (isCopy) *isCopy = JNI_FALSE;
    return o ? (const char *)(uintptr_t)o->address : "";
}
static void JNICALL fake_ReleaseStringUTFChars(void *env, jstring jstr, const char *s) {}
static jint JNICALL fake_EnsureLocalCapacity(void *env, jint cap) { return 0; }
static jobject JNICALL fake_NewLocalRef(void *env, jobject obj) { return obj; }
static jobject JNICALL fake_NewGlobalRef(void *env, jobject obj) { return obj; }
static void JNICALL fake_DeleteGlobalRef(void *env, jobject obj) {}
static jint JNICALL fake_PushLocalFrame(void *env, jint cap) { return 0; }
static jobject JNICALL fake_PopLocalFrame(void *env, jobject result) { return result; }
static jmethodID JNICALL fake_GetMethodID(void *env, jclass cls, const char *name, const char *sig) {
    return (jmethodID)(uintptr_t)1;
}
static jobject JNICALL fake_CallObjectMethodV(void *env, jobject obj, jmethodID mid, va_list ap) {
    return fake_alloc_obj(0);
}
static jobject JNICALL fake_CallObjectMethod(void *env, jobject obj, jmethodID mid, ...) {
    return fake_alloc_obj(0);
}

/*
 * fake_CallVoidMethodA — stage11 key fix.
 *
 * setAddress (0x377754) is called by every allocate() function to store the
 * newly-constructed C++ object pointer back into the Java Pointer's address
 * field.  When the global flag at 0x90a759 is 0 (fake JNI case), it falls
 * through to: CallVoidMethodA(env, java_obj, mid, &jvalue{j: cpp_ptr}).
 *
 * We capture args[0].j and store it in fake_obj->address so the caller can
 * read the real C++ pointer via fake_obj->address.
 */
static void JNICALL fake_CallVoidMethodA(void *env, jobject obj, jmethodID mid, const jvalue *args) {
    if ((uintptr_t)obj >= 0x1000 && args) {
        fake_obj_t *o = (fake_obj_t*)obj;
        o->address = args[0].j;
    }
}
static void JNICALL fake_CallVoidMethod(void *env, jobject obj, jmethodID mid, ...) {}
static void JNICALL fake_CallVoidMethodV(void *env, jobject obj, jmethodID mid, va_list ap) {}
static jboolean JNICALL fake_CallBooleanMethodV(void *env, jobject obj, jmethodID mid, va_list ap) { return JNI_FALSE; }
static jint JNICALL fake_CallIntMethodV(void *env, jobject obj, jmethodID mid, va_list ap) { return 0; }
static jlong JNICALL fake_CallLongMethodV(void *env, jobject obj, jmethodID mid, va_list ap) { return 0; }
static jclass JNICALL fake_GetObjectClass(void *env, jobject obj) {
    static jlong id; return (jclass)(uintptr_t)(++id);
}
static jint JNICALL fake_RegisterNatives(void *env, jclass cls, const void *methods, jint n) { return 0; }
static jmethodID JNICALL fake_GetStaticMethodID(void *env, jclass cls, const char *name, const char *sig) {
    return (jmethodID)(uintptr_t)1;
}
static jobject JNICALL fake_GetStaticObjectField(void *env, jclass cls, jfieldID fid) { return NULL; }
static jfieldID JNICALL fake_GetStaticFieldID(void *env, jclass cls, const char *name, const char *sig) {
    return (jfieldID)1;
}
static void JNICALL fake_CallStaticVoidMethodV(void *env, jclass cls, jmethodID mid, va_list ap) {}
static void JNICALL fake_CallStaticVoidMethod(void *env, jclass cls, jmethodID mid, ...) {}
static jobject JNICALL fake_CallStaticObjectMethodV(void *env, jclass cls, jmethodID mid, va_list ap) {
    return fake_alloc_obj(0);
}
static jboolean JNICALL fake_IsInstanceOf(void *env, jobject obj, jclass cls) { return JNI_TRUE; }
static jboolean JNICALL fake_IsSameObject(void *env, jobject a, jobject b) { return a == b ? JNI_TRUE : JNI_FALSE; }
static jint JNICALL fake_GetIntField(void *env, jobject obj, jfieldID fid) { return 0; }
static void JNICALL fake_SetIntField(void *env, jobject obj, jfieldID fid, jint val) {}
static jboolean JNICALL fake_GetBooleanField(void *env, jobject obj, jfieldID fid) { return JNI_FALSE; }
static void JNICALL fake_SetBooleanField(void *env, jobject obj, jfieldID fid, jboolean val) {}
static jobject JNICALL fake_GetObjectField(void *env, jobject obj, jfieldID fid) { return obj; }
static void JNICALL fake_SetObjectField(void *env, jobject obj, jfieldID fid, jobject val) {}
static jint JNICALL fake_CallIntMethod(void *env, jobject obj, jmethodID mid, ...) { return 0; }
static jboolean JNICALL fake_CallBooleanMethod(void *env, jobject obj, jmethodID mid, ...) { return JNI_FALSE; }
static jlong JNICALL fake_CallLongMethod(void *env, jobject obj, jmethodID mid, ...) { return 0; }
static jint JNICALL fake_GetStringLength(void *env, jstring jstr) {
    fake_obj_t *o = (fake_obj_t*)jstr;
    return o && o->address ? (jint)strlen((const char*)(uintptr_t)o->address) : 0;
}
static const uint16_t * JNICALL fake_GetStringChars(void *env, jstring jstr, jboolean *isCopy) {
    if (isCopy) *isCopy = JNI_FALSE; return NULL;
}
static void JNICALL fake_ReleaseStringChars(void *env, jstring jstr, const uint16_t *chars) {}
static jint JNICALL fake_GetStringUTFLength(void *env, jstring jstr) { return fake_GetStringLength(env, jstr); }
static void JNICALL fake_GetStringRegion(void *env, jstring jstr, jsize start, jsize len, jchar *buf) {
    if (buf && len > 0) memset(buf, 0, (size_t)len * sizeof(jchar));
}
static void JNICALL fake_GetStringUTFRegion(void *env, jstring jstr, jsize start, jsize len, char *buf) {
    if (buf && len > 0) memset(buf, 0, (size_t)len);
}
static jobject JNICALL fake_NewObjectV(void *env, jclass cls, jmethodID mid, va_list ap) {
    return fake_alloc_obj((jlong)(uintptr_t)cls);
}
static jobject JNICALL fake_NewObject(void *env, jclass cls, jmethodID mid, ...) {
    return fake_alloc_obj((jlong)(uintptr_t)cls);
}
static jsize JNICALL fake_GetArrayLength(void *env, jarray arr) { return 0; }
static void JNICALL fake_GetByteArrayRegion(void *env, jarray arr, jsize start, jsize len, jbyte *buf) {
    if (buf && len > 0) memset(buf, 0, (size_t)len);
}
static jint JNICALL fake_GetJavaVM(void *env, void **vm) { if (vm) *vm = env; return 0; }
static jint JNICALL fake_UnregisterNatives(void *env, jclass cls) { return 0; }
static jint JNICALL fake_MonitorEnter(void *env, jobject obj) { return 0; }
static jint JNICALL fake_MonitorExit(void *env, jobject obj) { return 0; }

static void fake_unimpl_fn(int idx) {
    char buf[64];
    int n = snprintf(buf, sizeof(buf), "[fake_jni] unimpl slot %d\n", idx);
    if (n > 0) { int r = write(2, buf, (size_t)n); (void)r; }
}
#define MAKE_UNIMPL(N) static void *fake_unimpl_##N(void *a, void *b, void *c, void *d, void *e) \
    { (void)a;(void)b;(void)c;(void)d;(void)e; fake_unimpl_fn(N); return NULL; }
MAKE_UNIMPL(0)   MAKE_UNIMPL(1)   MAKE_UNIMPL(2)   MAKE_UNIMPL(3)
MAKE_UNIMPL(4)   MAKE_UNIMPL(5)   MAKE_UNIMPL(6)   MAKE_UNIMPL(7)
MAKE_UNIMPL(8)   MAKE_UNIMPL(9)   MAKE_UNIMPL(10)  MAKE_UNIMPL(11)
MAKE_UNIMPL(12)  MAKE_UNIMPL(13)  MAKE_UNIMPL(14)  MAKE_UNIMPL(15)
MAKE_UNIMPL(16)  MAKE_UNIMPL(17)  MAKE_UNIMPL(18)  MAKE_UNIMPL(19)
MAKE_UNIMPL(20)  MAKE_UNIMPL(21)  MAKE_UNIMPL(22)  MAKE_UNIMPL(23)
MAKE_UNIMPL(24)  MAKE_UNIMPL(25)  MAKE_UNIMPL(26)  MAKE_UNIMPL(27)
MAKE_UNIMPL(28)  MAKE_UNIMPL(29)  MAKE_UNIMPL(30)  MAKE_UNIMPL(31)
MAKE_UNIMPL(32)  MAKE_UNIMPL(33)  MAKE_UNIMPL(34)  MAKE_UNIMPL(35)
MAKE_UNIMPL(36)  MAKE_UNIMPL(37)  MAKE_UNIMPL(38)  MAKE_UNIMPL(39)
MAKE_UNIMPL(40)  MAKE_UNIMPL(41)  MAKE_UNIMPL(42)  MAKE_UNIMPL(43)
MAKE_UNIMPL(44)  MAKE_UNIMPL(45)  MAKE_UNIMPL(46)  MAKE_UNIMPL(47)
MAKE_UNIMPL(48)  MAKE_UNIMPL(49)  MAKE_UNIMPL(50)  MAKE_UNIMPL(51)
MAKE_UNIMPL(52)  MAKE_UNIMPL(53)  MAKE_UNIMPL(54)  MAKE_UNIMPL(55)
MAKE_UNIMPL(56)  MAKE_UNIMPL(57)  MAKE_UNIMPL(58)  MAKE_UNIMPL(59)
MAKE_UNIMPL(60)  MAKE_UNIMPL(61)  MAKE_UNIMPL(62)  MAKE_UNIMPL(63)
MAKE_UNIMPL(64)  MAKE_UNIMPL(65)  MAKE_UNIMPL(66)  MAKE_UNIMPL(67)
MAKE_UNIMPL(68)  MAKE_UNIMPL(69)  MAKE_UNIMPL(70)  MAKE_UNIMPL(71)
MAKE_UNIMPL(72)  MAKE_UNIMPL(73)  MAKE_UNIMPL(74)  MAKE_UNIMPL(75)
MAKE_UNIMPL(76)  MAKE_UNIMPL(77)  MAKE_UNIMPL(78)  MAKE_UNIMPL(79)
MAKE_UNIMPL(80)  MAKE_UNIMPL(81)  MAKE_UNIMPL(82)  MAKE_UNIMPL(83)
MAKE_UNIMPL(84)  MAKE_UNIMPL(85)  MAKE_UNIMPL(86)  MAKE_UNIMPL(87)
MAKE_UNIMPL(88)  MAKE_UNIMPL(89)  MAKE_UNIMPL(90)  MAKE_UNIMPL(91)
MAKE_UNIMPL(92)  MAKE_UNIMPL(93)  MAKE_UNIMPL(94)  MAKE_UNIMPL(95)
MAKE_UNIMPL(96)  MAKE_UNIMPL(97)  MAKE_UNIMPL(98)  MAKE_UNIMPL(99)
MAKE_UNIMPL(100) MAKE_UNIMPL(101) MAKE_UNIMPL(102) MAKE_UNIMPL(103)
MAKE_UNIMPL(104) MAKE_UNIMPL(105) MAKE_UNIMPL(106) MAKE_UNIMPL(107)
MAKE_UNIMPL(108) MAKE_UNIMPL(109) MAKE_UNIMPL(110) MAKE_UNIMPL(111)
MAKE_UNIMPL(112) MAKE_UNIMPL(113) MAKE_UNIMPL(114) MAKE_UNIMPL(115)
MAKE_UNIMPL(116) MAKE_UNIMPL(117) MAKE_UNIMPL(118) MAKE_UNIMPL(119)
MAKE_UNIMPL(120) MAKE_UNIMPL(121) MAKE_UNIMPL(122) MAKE_UNIMPL(123)
MAKE_UNIMPL(124) MAKE_UNIMPL(125) MAKE_UNIMPL(126) MAKE_UNIMPL(127)
MAKE_UNIMPL(128) MAKE_UNIMPL(129) MAKE_UNIMPL(130) MAKE_UNIMPL(131)
MAKE_UNIMPL(132) MAKE_UNIMPL(133) MAKE_UNIMPL(134) MAKE_UNIMPL(135)
MAKE_UNIMPL(136) MAKE_UNIMPL(137) MAKE_UNIMPL(138) MAKE_UNIMPL(139)
MAKE_UNIMPL(140) MAKE_UNIMPL(141) MAKE_UNIMPL(142) MAKE_UNIMPL(143)
MAKE_UNIMPL(144) MAKE_UNIMPL(145) MAKE_UNIMPL(146) MAKE_UNIMPL(147)
MAKE_UNIMPL(148) MAKE_UNIMPL(149) MAKE_UNIMPL(150) MAKE_UNIMPL(151)
MAKE_UNIMPL(152) MAKE_UNIMPL(153) MAKE_UNIMPL(154) MAKE_UNIMPL(155)
MAKE_UNIMPL(156) MAKE_UNIMPL(157) MAKE_UNIMPL(158) MAKE_UNIMPL(159)
MAKE_UNIMPL(160) MAKE_UNIMPL(161) MAKE_UNIMPL(162) MAKE_UNIMPL(163)
MAKE_UNIMPL(164) MAKE_UNIMPL(165) MAKE_UNIMPL(166) MAKE_UNIMPL(167)
MAKE_UNIMPL(168) MAKE_UNIMPL(169) MAKE_UNIMPL(170) MAKE_UNIMPL(171)
MAKE_UNIMPL(172) MAKE_UNIMPL(173) MAKE_UNIMPL(174) MAKE_UNIMPL(175)
MAKE_UNIMPL(176) MAKE_UNIMPL(177) MAKE_UNIMPL(178) MAKE_UNIMPL(179)
MAKE_UNIMPL(180) MAKE_UNIMPL(181) MAKE_UNIMPL(182) MAKE_UNIMPL(183)
MAKE_UNIMPL(184) MAKE_UNIMPL(185) MAKE_UNIMPL(186) MAKE_UNIMPL(187)
MAKE_UNIMPL(188) MAKE_UNIMPL(189) MAKE_UNIMPL(190) MAKE_UNIMPL(191)
MAKE_UNIMPL(192) MAKE_UNIMPL(193) MAKE_UNIMPL(194) MAKE_UNIMPL(195)
MAKE_UNIMPL(196) MAKE_UNIMPL(197) MAKE_UNIMPL(198) MAKE_UNIMPL(199)
MAKE_UNIMPL(200) MAKE_UNIMPL(201) MAKE_UNIMPL(202) MAKE_UNIMPL(203)
MAKE_UNIMPL(204) MAKE_UNIMPL(205) MAKE_UNIMPL(206) MAKE_UNIMPL(207)
MAKE_UNIMPL(208) MAKE_UNIMPL(209) MAKE_UNIMPL(210) MAKE_UNIMPL(211)
MAKE_UNIMPL(212) MAKE_UNIMPL(213) MAKE_UNIMPL(214) MAKE_UNIMPL(215)
MAKE_UNIMPL(216) MAKE_UNIMPL(217) MAKE_UNIMPL(218) MAKE_UNIMPL(219)
MAKE_UNIMPL(220) MAKE_UNIMPL(221) MAKE_UNIMPL(222) MAKE_UNIMPL(223)
MAKE_UNIMPL(224) MAKE_UNIMPL(225) MAKE_UNIMPL(226) MAKE_UNIMPL(227)
MAKE_UNIMPL(228) MAKE_UNIMPL(229) MAKE_UNIMPL(230) MAKE_UNIMPL(231)

typedef struct JNINativeInterface_ {
    void *fn[JNITAB_SIZE];
} JNINativeInterface_;
typedef const JNINativeInterface_ *JNIEnv;

static JNINativeInterface_ g_jni_table;
static const JNINativeInterface_ *g_jni_env_ptr = &g_jni_table;

static void fake_jni_init(void) {
    static void *unimpl_table[JNITAB_SIZE] = {
        fake_unimpl_0,   fake_unimpl_1,   fake_unimpl_2,   fake_unimpl_3,
        fake_unimpl_4,   fake_unimpl_5,   fake_unimpl_6,   fake_unimpl_7,
        fake_unimpl_8,   fake_unimpl_9,   fake_unimpl_10,  fake_unimpl_11,
        fake_unimpl_12,  fake_unimpl_13,  fake_unimpl_14,  fake_unimpl_15,
        fake_unimpl_16,  fake_unimpl_17,  fake_unimpl_18,  fake_unimpl_19,
        fake_unimpl_20,  fake_unimpl_21,  fake_unimpl_22,  fake_unimpl_23,
        fake_unimpl_24,  fake_unimpl_25,  fake_unimpl_26,  fake_unimpl_27,
        fake_unimpl_28,  fake_unimpl_29,  fake_unimpl_30,  fake_unimpl_31,
        fake_unimpl_32,  fake_unimpl_33,  fake_unimpl_34,  fake_unimpl_35,
        fake_unimpl_36,  fake_unimpl_37,  fake_unimpl_38,  fake_unimpl_39,
        fake_unimpl_40,  fake_unimpl_41,  fake_unimpl_42,  fake_unimpl_43,
        fake_unimpl_44,  fake_unimpl_45,  fake_unimpl_46,  fake_unimpl_47,
        fake_unimpl_48,  fake_unimpl_49,  fake_unimpl_50,  fake_unimpl_51,
        fake_unimpl_52,  fake_unimpl_53,  fake_unimpl_54,  fake_unimpl_55,
        fake_unimpl_56,  fake_unimpl_57,  fake_unimpl_58,  fake_unimpl_59,
        fake_unimpl_60,  fake_unimpl_61,  fake_unimpl_62,  fake_unimpl_63,
        fake_unimpl_64,  fake_unimpl_65,  fake_unimpl_66,  fake_unimpl_67,
        fake_unimpl_68,  fake_unimpl_69,  fake_unimpl_70,  fake_unimpl_71,
        fake_unimpl_72,  fake_unimpl_73,  fake_unimpl_74,  fake_unimpl_75,
        fake_unimpl_76,  fake_unimpl_77,  fake_unimpl_78,  fake_unimpl_79,
        fake_unimpl_80,  fake_unimpl_81,  fake_unimpl_82,  fake_unimpl_83,
        fake_unimpl_84,  fake_unimpl_85,  fake_unimpl_86,  fake_unimpl_87,
        fake_unimpl_88,  fake_unimpl_89,  fake_unimpl_90,  fake_unimpl_91,
        fake_unimpl_92,  fake_unimpl_93,  fake_unimpl_94,  fake_unimpl_95,
        fake_unimpl_96,  fake_unimpl_97,  fake_unimpl_98,  fake_unimpl_99,
        fake_unimpl_100, fake_unimpl_101, fake_unimpl_102, fake_unimpl_103,
        fake_unimpl_104, fake_unimpl_105, fake_unimpl_106, fake_unimpl_107,
        fake_unimpl_108, fake_unimpl_109, fake_unimpl_110, fake_unimpl_111,
        fake_unimpl_112, fake_unimpl_113, fake_unimpl_114, fake_unimpl_115,
        fake_unimpl_116, fake_unimpl_117, fake_unimpl_118, fake_unimpl_119,
        fake_unimpl_120, fake_unimpl_121, fake_unimpl_122, fake_unimpl_123,
        fake_unimpl_124, fake_unimpl_125, fake_unimpl_126, fake_unimpl_127,
        fake_unimpl_128, fake_unimpl_129, fake_unimpl_130, fake_unimpl_131,
        fake_unimpl_132, fake_unimpl_133, fake_unimpl_134, fake_unimpl_135,
        fake_unimpl_136, fake_unimpl_137, fake_unimpl_138, fake_unimpl_139,
        fake_unimpl_140, fake_unimpl_141, fake_unimpl_142, fake_unimpl_143,
        fake_unimpl_144, fake_unimpl_145, fake_unimpl_146, fake_unimpl_147,
        fake_unimpl_148, fake_unimpl_149, fake_unimpl_150, fake_unimpl_151,
        fake_unimpl_152, fake_unimpl_153, fake_unimpl_154, fake_unimpl_155,
        fake_unimpl_156, fake_unimpl_157, fake_unimpl_158, fake_unimpl_159,
        fake_unimpl_160, fake_unimpl_161, fake_unimpl_162, fake_unimpl_163,
        fake_unimpl_164, fake_unimpl_165, fake_unimpl_166, fake_unimpl_167,
        fake_unimpl_168, fake_unimpl_169, fake_unimpl_170, fake_unimpl_171,
        fake_unimpl_172, fake_unimpl_173, fake_unimpl_174, fake_unimpl_175,
        fake_unimpl_176, fake_unimpl_177, fake_unimpl_178, fake_unimpl_179,
        fake_unimpl_180, fake_unimpl_181, fake_unimpl_182, fake_unimpl_183,
        fake_unimpl_184, fake_unimpl_185, fake_unimpl_186, fake_unimpl_187,
        fake_unimpl_188, fake_unimpl_189, fake_unimpl_190, fake_unimpl_191,
        fake_unimpl_192, fake_unimpl_193, fake_unimpl_194, fake_unimpl_195,
        fake_unimpl_196, fake_unimpl_197, fake_unimpl_198, fake_unimpl_199,
        fake_unimpl_200, fake_unimpl_201, fake_unimpl_202, fake_unimpl_203,
        fake_unimpl_204, fake_unimpl_205, fake_unimpl_206, fake_unimpl_207,
        fake_unimpl_208, fake_unimpl_209, fake_unimpl_210, fake_unimpl_211,
        fake_unimpl_212, fake_unimpl_213, fake_unimpl_214, fake_unimpl_215,
        fake_unimpl_216, fake_unimpl_217, fake_unimpl_218, fake_unimpl_219,
        fake_unimpl_220, fake_unimpl_221, fake_unimpl_222, fake_unimpl_223,
        fake_unimpl_224, fake_unimpl_225, fake_unimpl_226, fake_unimpl_227,
        fake_unimpl_228, fake_unimpl_229, fake_unimpl_230, fake_unimpl_231,
    };
    for (int i = 0; i < JNITAB_SIZE; i++) g_jni_table.fn[i] = unimpl_table[i];
#define SET(idx, f) g_jni_table.fn[idx] = (void*)(f)
    SET(4,   fake_GetVersion);
    SET(6,   fake_FindClass);
    SET(14,  fake_ThrowNew);
    SET(15,  fake_ExceptionCheck);
    SET(16,  fake_ExceptionDescribe);
    SET(17,  fake_ExceptionClear);
    SET(19,  fake_PushLocalFrame);
    SET(20,  fake_PopLocalFrame);
    SET(21,  fake_NewGlobalRef);
    SET(22,  fake_DeleteGlobalRef);
    SET(23,  fake_DeleteLocalRef);
    SET(24,  fake_IsSameObject);
    SET(25,  fake_NewLocalRef);
    SET(26,  fake_EnsureLocalCapacity);
    SET(27,  fake_AllocObject);
    SET(28,  fake_NewObject);
    SET(29,  fake_NewObjectV);
    SET(31,  fake_GetObjectClass);
    SET(32,  fake_IsInstanceOf);
    SET(33,  fake_GetMethodID);
    SET(34,  fake_CallObjectMethod);
    SET(35,  fake_CallObjectMethodV);
    SET(37,  fake_CallBooleanMethod);
    SET(38,  fake_CallBooleanMethodV);
    SET(49,  fake_CallIntMethod);
    SET(50,  fake_CallIntMethodV);
    SET(52,  fake_CallLongMethod);
    SET(53,  fake_CallLongMethodV);
    SET(61,  fake_CallVoidMethod);
    SET(62,  fake_CallVoidMethodV);
    SET(63,  fake_CallVoidMethodA);    /* KEY: now stores args[0].j in obj->address */
    SET(94,  fake_GetFieldID);
    SET(95,  fake_GetObjectField);
    SET(96,  fake_GetBooleanField);
    SET(100, fake_GetIntField);
    SET(101, fake_GetLongField);
    SET(104, fake_SetObjectField);
    SET(105, fake_SetBooleanField);
    SET(109, fake_SetIntField);
    SET(110, fake_SetLongField);
    SET(113, fake_GetStaticMethodID);
    SET(115, fake_CallStaticObjectMethodV);
    SET(141, fake_CallStaticVoidMethod);
    SET(142, fake_CallStaticVoidMethodV);
    SET(143, fake_CallStaticVoidMethod);
    SET(144, fake_GetStaticFieldID);
    SET(145, fake_GetStaticObjectField);
    SET(163, fake_NewStringUTF);
    SET(164, fake_GetStringLength);
    SET(165, fake_GetStringChars);
    SET(166, fake_ReleaseStringChars);
    SET(167, fake_NewStringUTF);
    SET(168, fake_GetStringUTFLength);
    SET(169, fake_GetStringUTFChars);
    SET(170, fake_ReleaseStringUTFChars);
    SET(171, fake_GetArrayLength);
    SET(200, fake_GetByteArrayRegion);
    SET(215, fake_RegisterNatives);
    SET(216, fake_UnregisterNatives);
    SET(217, fake_MonitorEnter);
    SET(218, fake_MonitorExit);
    SET(219, fake_GetJavaVM);
    SET(220, fake_GetStringRegion);
    SET(221, fake_GetStringUTFRegion);
    SET(228, fake_ExceptionCheck);
#undef SET
}

static inline JNIEnv *fake_jni_env(void) {
    fake_jni_init();
    return (JNIEnv *)&g_jni_env_ptr;
}
