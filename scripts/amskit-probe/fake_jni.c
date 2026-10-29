/* fake_jni.c - see fake_jni.h. Generated stub block at the end of the file fills every slot that has no real handler. */
#define _GNU_SOURCE
#include "fake_jni.h"
#include <wchar.h>

int fake_jni_trace;
static fj_obj *g_pending; static char g_pending_msg[512];
static void *g_table[235];
static void *g_env_ptr = g_table;
static void *g_vm_table[8];
static void *g_vm_ptr = g_vm_table;

#define TR(...) do { if (fake_jni_trace) { fprintf(stderr, "[jni] " __VA_ARGS__); fputc('\n', stderr); } } while (0)

/* ---- interned classes / ids ---- */
static fj_obj *g_classes[1024]; static int g_nclasses;
static fj_obj *g_ids[4096]; static int g_nids;

static fj_obj *intern_class(const char *name)
{
    for (int i = 0; i < g_nclasses; i++) if (!strcmp(g_classes[i]->name, name)) return g_classes[i];
    fj_obj *c = calloc(1, sizeof *c); c->kind = 2; c->name = strdup(name);
    if (g_nclasses < 1024) g_classes[g_nclasses++] = c;
    return c;
}
static fj_obj *intern_id(int kind, fj_obj *cls, const char *name, const char *sig)
{
    for (int i = 0; i < g_nids; i++) { fj_obj *x = g_ids[i]; if (x->kind == kind && x->cls == cls && !strcmp(x->name, name) && !strcmp(x->sig, sig)) return x; }
    fj_obj *x = calloc(1, sizeof *x); x->kind = kind; x->cls = cls; x->name = strdup(name); x->sig = strdup(sig);
    if (g_nids < 4096) g_ids[g_nids++] = x;
    return x;
}
fj_obj *fake_jni_new_object(const char *cn) { fj_obj *o = calloc(1, sizeof *o); o->kind = 1; o->cls = intern_class(cn); return o; }
fj_obj *fake_jni_new_string(const char *s) { fj_obj *o = calloc(1, sizeof *o); o->kind = 3; o->str = strdup(s ? s : ""); o->len = strlen(o->str); o->cls = intern_class("java/lang/String"); return o; }
fj_obj *fake_jni_new_byte_array(const void *p, size_t n);
const char *fake_jni_pending_exception(void) { return g_pending ? g_pending_msg : NULL; }

/* ---- version, classes ---- */
static int32_t j_GetVersion(void *e) { (void)e; return 0x00010008; }
static fj_obj *j_FindClass(void *e, const char *n) { (void)e; TR("FindClass %s", n); return intern_class(n); }
static fj_obj *j_GetSuperclass(void *e, fj_obj *c) { (void)e; (void)c; return intern_class("java/lang/Object"); }
static uint8_t j_IsAssignableFrom(void *e, fj_obj *a, fj_obj *b) { (void)e; (void)a; (void)b; return 1; }

/* ---- exceptions ---- */
static int32_t j_Throw(void *e, fj_obj *x) { (void)e; g_pending = x; snprintf(g_pending_msg, sizeof g_pending_msg, "(thrown object)"); TR("Throw"); return 0; }
static int32_t j_ThrowNew(void *e, fj_obj *c, const char *m) { (void)e; g_pending = fake_jni_new_object(c ? c->name : "java/lang/Throwable"); snprintf(g_pending_msg, sizeof g_pending_msg, "%s: %s", c ? c->name : "?", m ? m : ""); TR("ThrowNew %s", g_pending_msg); return 0; }
static fj_obj *j_ExceptionOccurred(void *e) { (void)e; return g_pending; }
static void j_ExceptionDescribe(void *e) { (void)e; if (g_pending) fprintf(stderr, "[jni] pending exception: %s\n", g_pending_msg); }
static void j_ExceptionClear(void *e) { (void)e; g_pending = NULL; }
static void j_FatalError(void *e, const char *m) { (void)e; fprintf(stderr, "[jni] FatalError: %s\n", m); abort(); }
static uint8_t j_ExceptionCheck(void *e) { (void)e; return g_pending != NULL; }

/* ---- references ---- */
static int32_t j_PushLocalFrame(void *e, int32_t n) { (void)e; (void)n; return 0; }
static fj_obj *j_PopLocalFrame(void *e, fj_obj *r) { (void)e; return r; }
static fj_obj *j_NewRef(void *e, fj_obj *o) { (void)e; return o; }
static void j_DelRef(void *e, fj_obj *o) { (void)e; (void)o; }
static uint8_t j_IsSameObject(void *e, fj_obj *a, fj_obj *b) { (void)e; return a == b; }
static int32_t j_EnsureLocalCapacity(void *e, int32_t n) { (void)e; (void)n; return 0; }
static fj_obj *j_AllocObject(void *e, fj_obj *c) { (void)e; fj_obj *o = calloc(1, sizeof *o); o->kind = 1; o->cls = c; return o; }
static fj_obj *j_GetObjectClass(void *e, fj_obj *o) { (void)e; return o ? o->cls : NULL; }
static uint8_t j_IsInstanceOf(void *e, fj_obj *o, fj_obj *c) { (void)e; (void)o; (void)c; return 1; }
static fj_obj *j_GetMethodID(void *e, fj_obj *c, const char *n, const char *s) { (void)e; TR("GetMethodID %s.%s %s", c ? c->name : "?", n, s); return intern_id(4, c, n, s); }
static fj_obj *j_GetFieldID(void *e, fj_obj *c, const char *n, const char *s) { (void)e; TR("GetFieldID %s.%s %s", c ? c->name : "?", n, s); return intern_id(5, c, n, s); }

/* ---- method calls ---- */
static int sig_types(const char *sig, char *t)
{
    int n = 0; const char *p = sig && *sig == '(' ? sig + 1 : "";
    while (*p && *p != ')' && n < 31) {
        if (*p == 'L') { while (*p && *p != ';') p++; t[n++] = 'L'; if (*p) p++; }
        else if (*p == '[') { while (*p == '[') p++; if (*p == 'L') while (*p && *p != ';') p++; if (*p) p++; t[n++] = 'L'; }
        else t[n++] = *p++;
    }
    return n;
}
static int decode_va(const char *sig, va_list ap, fj_value *out)
{
    char t[32]; int n = sig_types(sig, t);
    for (int i = 0; i < n; i++) {
        out[i].j = 0;
        switch (t[i]) { case 'Z': case 'B': case 'C': case 'S': case 'I': out[i].i = va_arg(ap, int); break;
                        case 'J': out[i].j = va_arg(ap, int64_t); break;
                        case 'F': case 'D': out[i].d = va_arg(ap, double); break;
                        default: out[i].l = va_arg(ap, void *); }
    }
    return n;
}
static fj_value dispatch(fj_obj *obj, fj_obj *mid, const fj_value *args, int n)
{
    fj_value r; r.j = 0;
    if (!mid) return r;
    if (fake_jni_trace) {
        fprintf(stderr, "[jni] call %s.%s%s on %p:", mid->cls ? mid->cls->name : "?", mid->name, mid->sig, (void *)obj);
        for (int i = 0; i < n; i++) fprintf(stderr, " %#llx", (unsigned long long)args[i].j);
        fputc('\n', stderr);
    }
    if (obj && obj->kind == 3 && !strcmp(mid->name, "getBytes")) {                  /* String.getBytes() -> byte[] */
        fj_obj *a = fake_jni_new_byte_array(obj->str, obj->len); r.l = a; return r;
    }
    if (obj && obj->kind == 3 && !strcmp(mid->name, "length")) { r.i = (int32_t)obj->len; return r; }
    if (obj && obj->kind == 1 && obj->cls) {            /* java.util.ArrayList / Iterator / kotlin.Pair, as far as AMSKit uses them */
        const char *mn = mid->name; fj_obj **it = (fj_obj **)obj->data;
        if (!strcmp(mn, "add") && n == 1) { fake_jni_list_add(obj, (fj_obj *)args[0].l); r.i = 1; return r; }
        if (!strcmp(mn, "size") && n == 0) { r.i = (int32_t)obj->count; return r; }
        if (!strcmp(mn, "isEmpty") && n == 0) { r.i = obj->count == 0; return r; }
        if (!strcmp(mn, "get") && n == 1 && !strcmp(mid->sig, "(I)Ljava/lang/Object;")) { r.l = (args[0].i >= 0 && args[0].i < obj->count) ? it[args[0].i] : NULL; return r; }
        if (!strcmp(mn, "iterator") && n == 0) { fj_obj *i2 = fake_jni_new_object("java/util/Iterator"); i2->data = obj; i2->count = 0; i2->elem = -1; r.l = i2; return r; }
        if (obj->elem == -1 && !strcmp(mn, "hasNext")) { fj_obj *src = (fj_obj *)obj->data; r.i = obj->count < src->count; return r; }
        if (obj->elem == -1 && !strcmp(mn, "next")) { fj_obj *src = (fj_obj *)obj->data; r.l = ((fj_obj **)src->data)[obj->count++]; return r; }
        if ((!strcmp(mn, "getFirst") || !strcmp(mn, "component1")) && n == 0) { r.l = obj->count > 0 ? it[0] : NULL; return r; }
        if ((!strcmp(mn, "getSecond") || !strcmp(mn, "component2")) && n == 0) { r.l = obj->count > 1 ? it[1] : NULL; return r; }
    }
    if (!strcmp(mid->name, "init") && n >= 1 && !strcmp(mid->sig, "(JJJJ)V")) {   /* JavaCPP Pointer.init(address, capacity, owner, deallocator) */
        if (obj) obj->address = args[0].j;
        return r;
    }
    return fake_jni_java_call(obj, mid, args, n);
}
static fj_value call_v(fj_obj *o, fj_obj *m, va_list ap) { fj_value a[32]; int n = m ? decode_va(m->sig, ap, a) : 0; return dispatch(o, m, a, n); }
static fj_value call_a(fj_obj *o, fj_obj *m, const fj_value *a) { char t[32]; int n = m ? sig_types(m->sig, t) : 0; return dispatch(o, m, a, n); }

#define CALLFAM(NAME, RT, RET) \
 static RT ci_##NAME(void *e, fj_obj *o, fj_obj *m, ...) { (void)e; va_list ap; va_start(ap, m); fj_value r = call_v(o, m, ap); va_end(ap); RET; } \
 static RT ciV_##NAME(void *e, fj_obj *o, fj_obj *m, va_list ap) { (void)e; fj_value r = call_v(o, m, ap); RET; } \
 static RT ciA_##NAME(void *e, fj_obj *o, fj_obj *m, const fj_value *a) { (void)e; fj_value r = call_a(o, m, a); RET; } \
 static RT cn_##NAME(void *e, fj_obj *o, fj_obj *c, fj_obj *m, ...) { (void)e; (void)c; va_list ap; va_start(ap, m); fj_value r = call_v(o, m, ap); va_end(ap); RET; } \
 static RT cnV_##NAME(void *e, fj_obj *o, fj_obj *c, fj_obj *m, va_list ap) { (void)e; (void)c; fj_value r = call_v(o, m, ap); RET; } \
 static RT cnA_##NAME(void *e, fj_obj *o, fj_obj *c, fj_obj *m, const fj_value *a) { (void)e; (void)c; fj_value r = call_a(o, m, a); RET; } \
 static RT cs_##NAME(void *e, fj_obj *c, fj_obj *m, ...) { (void)e; (void)c; va_list ap; va_start(ap, m); fj_value r = call_v(NULL, m, ap); va_end(ap); RET; } \
 static RT csV_##NAME(void *e, fj_obj *c, fj_obj *m, va_list ap) { (void)e; (void)c; fj_value r = call_v(NULL, m, ap); RET; } \
 static RT csA_##NAME(void *e, fj_obj *c, fj_obj *m, const fj_value *a) { (void)e; (void)c; fj_value r = call_a(NULL, m, a); RET; }
CALLFAM(Object, fj_obj *, return (fj_obj *)r.l)
CALLFAM(Boolean, uint8_t, return (uint8_t)r.i)
CALLFAM(Byte, int8_t, return (int8_t)r.i)
CALLFAM(Char, uint16_t, return (uint16_t)r.i)
CALLFAM(Short, int16_t, return (int16_t)r.i)
CALLFAM(Int, int32_t, return r.i)
CALLFAM(Long, int64_t, return r.j)
CALLFAM(Float, float, return r.f)
CALLFAM(Double, double, return r.d)
CALLFAM(Void, void, (void)r)

/* NewObject: the object gets the class; a constructor that takes a Pointer copies its address (JavaCPP copy-constructors) */
void fake_jni_list_add(fj_obj *l, fj_obj *x)
{
    if (l->count >= (int64_t)l->len) { l->len = l->len ? l->len * 2 : 8; l->data = realloc(l->data, l->len * sizeof(fj_obj *)); }
    ((fj_obj **)l->data)[l->count++] = x;
}
fj_obj *fake_jni_new_list(void) { return fake_jni_new_object("java/util/ArrayList"); }
fj_obj *fake_jni_new_pair(fj_obj *a, fj_obj *b) { fj_obj *p = fake_jni_new_object("kotlin/Pair"); fake_jni_list_add(p, a); fake_jni_list_add(p, b); return p; }

static fj_obj *new_obj(fj_obj *c, fj_obj *m, const fj_value *a, int n)
{
    fj_obj *o = calloc(1, sizeof *o); o->kind = 1; o->cls = c;
    if (fake_jni_trace) fprintf(stderr, "[jni] NewObject %s %s%s\n", c ? c->name : "?", m ? m->name : "?", m ? m->sig : "");
    if (n >= 1 && m && m->sig && !strncmp(m->sig, "(Lorg/bytedeco/javacpp/Pointer;", 31) && a[0].l) o->address = ((fj_obj *)a[0].l)->address;
    if (c && c->name && strstr(c->name, "Pair") && n >= 2) { fake_jni_list_add(o, (fj_obj *)a[0].l); fake_jni_list_add(o, (fj_obj *)a[1].l); }
    return o;
}
static fj_obj *j_NewObject(void *e, fj_obj *c, fj_obj *m, ...) { (void)e; va_list ap; va_start(ap, m); fj_value a[32]; int n = m ? decode_va(m->sig, ap, a) : 0; va_end(ap); return new_obj(c, m, a, n); }
static fj_obj *j_NewObjectV(void *e, fj_obj *c, fj_obj *m, va_list ap) { (void)e; fj_value a[32]; int n = m ? decode_va(m->sig, ap, a) : 0; return new_obj(c, m, a, n); }
static fj_obj *j_NewObjectA(void *e, fj_obj *c, fj_obj *m, const fj_value *a) { (void)e; char t[32]; int n = m ? sig_types(m->sig, t) : 0; return new_obj(c, m, a, n); }

/* ---- fields (instance and static share one store, keyed by id) ---- */
static int64_t *fld(fj_obj *o, const fj_obj *fid)
{
    for (int i = 0; i < o->nf; i++) if (o->f[i].fid == fid) return &o->f[i].val;
    if (o->nf < 24) { o->f[o->nf].fid = fid; o->f[o->nf].val = 0; return &o->f[o->nf++].val; }
    static int64_t scratch; return &scratch;
}
static int64_t getf(fj_obj *o, fj_obj *fid) { if (!o) return 0; if (!strcmp(fid->name, "address")) return o->address; return *fld(o, fid); }
static void setf(fj_obj *o, fj_obj *fid, int64_t v) { if (!o) return; if (!strcmp(fid->name, "address")) { o->address = v; return; } *fld(o, fid) = v; }
#define FIELDFAM(NAME, T) \
 static T gf_##NAME(void *e, fj_obj *o, fj_obj *f) { (void)e; int64_t v = getf(o, f); T r; memcpy(&r, &v, sizeof r); return r; } \
 static void sf_##NAME(void *e, fj_obj *o, fj_obj *f, T v) { (void)e; int64_t x = 0; memcpy(&x, &v, sizeof v); setf(o, f, x); } \
 static T gs_##NAME(void *e, fj_obj *c, fj_obj *f) { (void)e; int64_t v = getf(c, f); T r; memcpy(&r, &v, sizeof r); return r; } \
 static void ss_##NAME(void *e, fj_obj *c, fj_obj *f, T v) { (void)e; int64_t x = 0; memcpy(&x, &v, sizeof v); setf(c, f, x); }
static fj_obj *gs_ObjectEnum(void *e, fj_obj *c, fj_obj *f)
{
    (void)e; int64_t v = getf(c, f); if (v) return (fj_obj *)(intptr_t)v;
    fj_obj *o = calloc(1, sizeof *o); o->kind = 1; o->cls = c; o->name = f->name; o->str = strdup(f->name); o->len = strlen(f->name);
    setf(c, f, (int64_t)(intptr_t)o); return o;
}
FIELDFAM(Object, fj_obj *) FIELDFAM(Boolean, uint8_t) FIELDFAM(Byte, int8_t) FIELDFAM(Char, uint16_t) FIELDFAM(Short, int16_t)
FIELDFAM(Int, int32_t) FIELDFAM(Long, int64_t) FIELDFAM(Float, float) FIELDFAM(Double, double)

/* ---- strings ---- */
static fj_obj *j_NewString(void *e, const uint16_t *u, int32_t n) { (void)e; char *b = malloc(n + 1); for (int i = 0; i < n; i++) b[i] = (char)u[i]; b[n] = 0; fj_obj *s = fake_jni_new_string(b); free(b); return s; }
static int32_t j_GetStringLength(void *e, fj_obj *s) { (void)e; return (int32_t)s->len; }
static const uint16_t *j_GetStringChars(void *e, fj_obj *s, uint8_t *c) { (void)e; if (c) *c = 1; uint16_t *u = calloc(s->len + 1, 2); for (size_t i = 0; i < s->len; i++) u[i] = (unsigned char)s->str[i]; return u; }
static void j_ReleaseStringChars(void *e, fj_obj *s, const uint16_t *u) { (void)e; (void)s; free((void *)u); }
static fj_obj *j_NewStringUTF(void *e, const char *s) { (void)e; return fake_jni_new_string(s); }
static int32_t j_GetStringUTFLength(void *e, fj_obj *s) { (void)e; return (int32_t)s->len; }
static const char *j_GetStringUTFChars(void *e, fj_obj *s, uint8_t *c) { (void)e; if (c) *c = 0; return s ? s->str : NULL; }
static void j_ReleaseStringUTFChars(void *e, fj_obj *s, const char *c) { (void)e; (void)s; (void)c; }

/* ---- arrays ---- */
static int32_t j_GetArrayLength(void *e, fj_obj *a) { (void)e; return (int32_t)a->count; }
static fj_obj *new_arr(int elem, int64_t n);
static fj_obj *new_arr(int elem, int64_t n) { fj_obj *a = calloc(1, sizeof *a); a->kind = 6; a->elem = elem; a->count = n; a->data = calloc(n ? n : 1, elem ? elem : 8); a->cls = intern_class("[array"); return a; }
static fj_obj *j_NewObjectArray(void *e, int32_t n, fj_obj *c, fj_obj *init) { (void)e; (void)c; fj_obj *a = new_arr(0, n); for (int i = 0; i < n; i++) ((fj_obj **)a->data)[i] = init; return a; }
static fj_obj *j_GetObjectArrayElement(void *e, fj_obj *a, int32_t i) { (void)e; return ((fj_obj **)a->data)[i]; }
static void j_SetObjectArrayElement(void *e, fj_obj *a, int32_t i, fj_obj *v) { (void)e; ((fj_obj **)a->data)[i] = v; }
static const int g_esize[8] = { 1, 1, 2, 2, 4, 8, 4, 8 };   /* Boolean Byte Char Short Int Long Float Double */
#define PRIMARR(K, IDX) \
 static fj_obj *na_##K(void *e, int32_t n) { (void)e; return new_arr(g_esize[IDX], n); } \
 static void *ga_##K(void *e, fj_obj *a, uint8_t *c) { (void)e; if (c) *c = 0; return a->data; } \
 static void ra_##K(void *e, fj_obj *a, void *p, int32_t m) { (void)e; (void)a; (void)p; (void)m; } \
 static void gr_##K(void *e, fj_obj *a, int32_t s, int32_t n, void *b) { (void)e; memcpy(b, (char *)a->data + (size_t)s * a->elem, (size_t)n * a->elem); } \
 static void sr_##K(void *e, fj_obj *a, int32_t s, int32_t n, const void *b) { (void)e; memcpy((char *)a->data + (size_t)s * a->elem, b, (size_t)n * a->elem); }
PRIMARR(0, 0) PRIMARR(1, 1) PRIMARR(2, 2) PRIMARR(3, 3) PRIMARR(4, 4) PRIMARR(5, 5) PRIMARR(6, 6) PRIMARR(7, 7)

/* ---- misc ---- */
static int32_t j_RegisterNatives(void *e, fj_obj *c, const void *m, int32_t n) { (void)e; (void)c; (void)m; TR("RegisterNatives x%d", n); return 0; }
static int32_t j_Zero(void *e) { (void)e; return 0; }
static int32_t j_GetJavaVM(void *e, void **vm) { (void)e; *vm = &g_vm_ptr; return 0; }
static void *j_GetCritical(void *e, fj_obj *a, uint8_t *c) { (void)e; if (c) *c = 0; return a->data; }
static void j_RelCritical(void *e, fj_obj *a, void *p, int32_t m) { (void)e; (void)a; (void)p; (void)m; }
static fj_obj *j_NewDirectByteBuffer(void *e, void *p, int64_t cap) { (void)e; fj_obj *o = fake_jni_new_object("java/nio/DirectByteBuffer"); o->address = (int64_t)(intptr_t)p; o->count = cap; return o; }
static void *j_GetDirectBufferAddress(void *e, fj_obj *b) { (void)e; return (void *)(intptr_t)b->address; }
static int64_t j_GetDirectBufferCapacity(void *e, fj_obj *b) { (void)e; return b->count; }
static int32_t j_GetObjectRefType(void *e, fj_obj *o) { (void)e; (void)o; return 1; }

/* ---- JavaVM ---- */
static int32_t vm_ok(void) { return 0; }
static int32_t vm_attach(void *vm, void **penv, void *args) { (void)vm; (void)args; *penv = &g_env_ptr; return 0; }
static int32_t vm_getenv(void *vm, void **penv, int32_t ver) { (void)vm; (void)ver; *penv = &g_env_ptr; return 0; }

static long unimpl(int n) { static unsigned char seen[240]; if (!seen[n]) { seen[n] = 1; fprintf(stderr, "[jni] unimplemented JNI slot %d called\n", n); } return 0; }

static long stub0(void) { return unimpl(0); }
static long stub1(void) { return unimpl(1); }
static long stub2(void) { return unimpl(2); }
static long stub3(void) { return unimpl(3); }
static long stub4(void) { return unimpl(4); }
static long stub5(void) { return unimpl(5); }
static long stub6(void) { return unimpl(6); }
static long stub7(void) { return unimpl(7); }
static long stub8(void) { return unimpl(8); }
static long stub9(void) { return unimpl(9); }
static long stub10(void) { return unimpl(10); }
static long stub11(void) { return unimpl(11); }
static long stub12(void) { return unimpl(12); }
static long stub13(void) { return unimpl(13); }
static long stub14(void) { return unimpl(14); }
static long stub15(void) { return unimpl(15); }
static long stub16(void) { return unimpl(16); }
static long stub17(void) { return unimpl(17); }
static long stub18(void) { return unimpl(18); }
static long stub19(void) { return unimpl(19); }
static long stub20(void) { return unimpl(20); }
static long stub21(void) { return unimpl(21); }
static long stub22(void) { return unimpl(22); }
static long stub23(void) { return unimpl(23); }
static long stub24(void) { return unimpl(24); }
static long stub25(void) { return unimpl(25); }
static long stub26(void) { return unimpl(26); }
static long stub27(void) { return unimpl(27); }
static long stub28(void) { return unimpl(28); }
static long stub29(void) { return unimpl(29); }
static long stub30(void) { return unimpl(30); }
static long stub31(void) { return unimpl(31); }
static long stub32(void) { return unimpl(32); }
static long stub33(void) { return unimpl(33); }
static long stub34(void) { return unimpl(34); }
static long stub35(void) { return unimpl(35); }
static long stub36(void) { return unimpl(36); }
static long stub37(void) { return unimpl(37); }
static long stub38(void) { return unimpl(38); }
static long stub39(void) { return unimpl(39); }
static long stub40(void) { return unimpl(40); }
static long stub41(void) { return unimpl(41); }
static long stub42(void) { return unimpl(42); }
static long stub43(void) { return unimpl(43); }
static long stub44(void) { return unimpl(44); }
static long stub45(void) { return unimpl(45); }
static long stub46(void) { return unimpl(46); }
static long stub47(void) { return unimpl(47); }
static long stub48(void) { return unimpl(48); }
static long stub49(void) { return unimpl(49); }
static long stub50(void) { return unimpl(50); }
static long stub51(void) { return unimpl(51); }
static long stub52(void) { return unimpl(52); }
static long stub53(void) { return unimpl(53); }
static long stub54(void) { return unimpl(54); }
static long stub55(void) { return unimpl(55); }
static long stub56(void) { return unimpl(56); }
static long stub57(void) { return unimpl(57); }
static long stub58(void) { return unimpl(58); }
static long stub59(void) { return unimpl(59); }
static long stub60(void) { return unimpl(60); }
static long stub61(void) { return unimpl(61); }
static long stub62(void) { return unimpl(62); }
static long stub63(void) { return unimpl(63); }
static long stub64(void) { return unimpl(64); }
static long stub65(void) { return unimpl(65); }
static long stub66(void) { return unimpl(66); }
static long stub67(void) { return unimpl(67); }
static long stub68(void) { return unimpl(68); }
static long stub69(void) { return unimpl(69); }
static long stub70(void) { return unimpl(70); }
static long stub71(void) { return unimpl(71); }
static long stub72(void) { return unimpl(72); }
static long stub73(void) { return unimpl(73); }
static long stub74(void) { return unimpl(74); }
static long stub75(void) { return unimpl(75); }
static long stub76(void) { return unimpl(76); }
static long stub77(void) { return unimpl(77); }
static long stub78(void) { return unimpl(78); }
static long stub79(void) { return unimpl(79); }
static long stub80(void) { return unimpl(80); }
static long stub81(void) { return unimpl(81); }
static long stub82(void) { return unimpl(82); }
static long stub83(void) { return unimpl(83); }
static long stub84(void) { return unimpl(84); }
static long stub85(void) { return unimpl(85); }
static long stub86(void) { return unimpl(86); }
static long stub87(void) { return unimpl(87); }
static long stub88(void) { return unimpl(88); }
static long stub89(void) { return unimpl(89); }
static long stub90(void) { return unimpl(90); }
static long stub91(void) { return unimpl(91); }
static long stub92(void) { return unimpl(92); }
static long stub93(void) { return unimpl(93); }
static long stub94(void) { return unimpl(94); }
static long stub95(void) { return unimpl(95); }
static long stub96(void) { return unimpl(96); }
static long stub97(void) { return unimpl(97); }
static long stub98(void) { return unimpl(98); }
static long stub99(void) { return unimpl(99); }
static long stub100(void) { return unimpl(100); }
static long stub101(void) { return unimpl(101); }
static long stub102(void) { return unimpl(102); }
static long stub103(void) { return unimpl(103); }
static long stub104(void) { return unimpl(104); }
static long stub105(void) { return unimpl(105); }
static long stub106(void) { return unimpl(106); }
static long stub107(void) { return unimpl(107); }
static long stub108(void) { return unimpl(108); }
static long stub109(void) { return unimpl(109); }
static long stub110(void) { return unimpl(110); }
static long stub111(void) { return unimpl(111); }
static long stub112(void) { return unimpl(112); }
static long stub113(void) { return unimpl(113); }
static long stub114(void) { return unimpl(114); }
static long stub115(void) { return unimpl(115); }
static long stub116(void) { return unimpl(116); }
static long stub117(void) { return unimpl(117); }
static long stub118(void) { return unimpl(118); }
static long stub119(void) { return unimpl(119); }
static long stub120(void) { return unimpl(120); }
static long stub121(void) { return unimpl(121); }
static long stub122(void) { return unimpl(122); }
static long stub123(void) { return unimpl(123); }
static long stub124(void) { return unimpl(124); }
static long stub125(void) { return unimpl(125); }
static long stub126(void) { return unimpl(126); }
static long stub127(void) { return unimpl(127); }
static long stub128(void) { return unimpl(128); }
static long stub129(void) { return unimpl(129); }
static long stub130(void) { return unimpl(130); }
static long stub131(void) { return unimpl(131); }
static long stub132(void) { return unimpl(132); }
static long stub133(void) { return unimpl(133); }
static long stub134(void) { return unimpl(134); }
static long stub135(void) { return unimpl(135); }
static long stub136(void) { return unimpl(136); }
static long stub137(void) { return unimpl(137); }
static long stub138(void) { return unimpl(138); }
static long stub139(void) { return unimpl(139); }
static long stub140(void) { return unimpl(140); }
static long stub141(void) { return unimpl(141); }
static long stub142(void) { return unimpl(142); }
static long stub143(void) { return unimpl(143); }
static long stub144(void) { return unimpl(144); }
static long stub145(void) { return unimpl(145); }
static long stub146(void) { return unimpl(146); }
static long stub147(void) { return unimpl(147); }
static long stub148(void) { return unimpl(148); }
static long stub149(void) { return unimpl(149); }
static long stub150(void) { return unimpl(150); }
static long stub151(void) { return unimpl(151); }
static long stub152(void) { return unimpl(152); }
static long stub153(void) { return unimpl(153); }
static long stub154(void) { return unimpl(154); }
static long stub155(void) { return unimpl(155); }
static long stub156(void) { return unimpl(156); }
static long stub157(void) { return unimpl(157); }
static long stub158(void) { return unimpl(158); }
static long stub159(void) { return unimpl(159); }
static long stub160(void) { return unimpl(160); }
static long stub161(void) { return unimpl(161); }
static long stub162(void) { return unimpl(162); }
static long stub163(void) { return unimpl(163); }
static long stub164(void) { return unimpl(164); }
static long stub165(void) { return unimpl(165); }
static long stub166(void) { return unimpl(166); }
static long stub167(void) { return unimpl(167); }
static long stub168(void) { return unimpl(168); }
static long stub169(void) { return unimpl(169); }
static long stub170(void) { return unimpl(170); }
static long stub171(void) { return unimpl(171); }
static long stub172(void) { return unimpl(172); }
static long stub173(void) { return unimpl(173); }
static long stub174(void) { return unimpl(174); }
static long stub175(void) { return unimpl(175); }
static long stub176(void) { return unimpl(176); }
static long stub177(void) { return unimpl(177); }
static long stub178(void) { return unimpl(178); }
static long stub179(void) { return unimpl(179); }
static long stub180(void) { return unimpl(180); }
static long stub181(void) { return unimpl(181); }
static long stub182(void) { return unimpl(182); }
static long stub183(void) { return unimpl(183); }
static long stub184(void) { return unimpl(184); }
static long stub185(void) { return unimpl(185); }
static long stub186(void) { return unimpl(186); }
static long stub187(void) { return unimpl(187); }
static long stub188(void) { return unimpl(188); }
static long stub189(void) { return unimpl(189); }
static long stub190(void) { return unimpl(190); }
static long stub191(void) { return unimpl(191); }
static long stub192(void) { return unimpl(192); }
static long stub193(void) { return unimpl(193); }
static long stub194(void) { return unimpl(194); }
static long stub195(void) { return unimpl(195); }
static long stub196(void) { return unimpl(196); }
static long stub197(void) { return unimpl(197); }
static long stub198(void) { return unimpl(198); }
static long stub199(void) { return unimpl(199); }
static long stub200(void) { return unimpl(200); }
static long stub201(void) { return unimpl(201); }
static long stub202(void) { return unimpl(202); }
static long stub203(void) { return unimpl(203); }
static long stub204(void) { return unimpl(204); }
static long stub205(void) { return unimpl(205); }
static long stub206(void) { return unimpl(206); }
static long stub207(void) { return unimpl(207); }
static long stub208(void) { return unimpl(208); }
static long stub209(void) { return unimpl(209); }
static long stub210(void) { return unimpl(210); }
static long stub211(void) { return unimpl(211); }
static long stub212(void) { return unimpl(212); }
static long stub213(void) { return unimpl(213); }
static long stub214(void) { return unimpl(214); }
static long stub215(void) { return unimpl(215); }
static long stub216(void) { return unimpl(216); }
static long stub217(void) { return unimpl(217); }
static long stub218(void) { return unimpl(218); }
static long stub219(void) { return unimpl(219); }
static long stub220(void) { return unimpl(220); }
static long stub221(void) { return unimpl(221); }
static long stub222(void) { return unimpl(222); }
static long stub223(void) { return unimpl(223); }
static long stub224(void) { return unimpl(224); }
static long stub225(void) { return unimpl(225); }
static long stub226(void) { return unimpl(226); }
static long stub227(void) { return unimpl(227); }
static long stub228(void) { return unimpl(228); }
static long stub229(void) { return unimpl(229); }
static long stub230(void) { return unimpl(230); }
static long stub231(void) { return unimpl(231); }
static long stub232(void) { return unimpl(232); }
static long stub233(void) { return unimpl(233); }
static long stub234(void) { return unimpl(234); }
static void *g_stubs[235] = { (void *)stub0, (void *)stub1, (void *)stub2, (void *)stub3, (void *)stub4, (void *)stub5, (void *)stub6, (void *)stub7, (void *)stub8, (void *)stub9, (void *)stub10, (void *)stub11, (void *)stub12, (void *)stub13, (void *)stub14, (void *)stub15, (void *)stub16, (void *)stub17, (void *)stub18, (void *)stub19, (void *)stub20, (void *)stub21, (void *)stub22, (void *)stub23, (void *)stub24, (void *)stub25, (void *)stub26, (void *)stub27, (void *)stub28, (void *)stub29, (void *)stub30, (void *)stub31, (void *)stub32, (void *)stub33, (void *)stub34, (void *)stub35, (void *)stub36, (void *)stub37, (void *)stub38, (void *)stub39, (void *)stub40, (void *)stub41, (void *)stub42, (void *)stub43, (void *)stub44, (void *)stub45, (void *)stub46, (void *)stub47, (void *)stub48, (void *)stub49, (void *)stub50, (void *)stub51, (void *)stub52, (void *)stub53, (void *)stub54, (void *)stub55, (void *)stub56, (void *)stub57, (void *)stub58, (void *)stub59, (void *)stub60, (void *)stub61, (void *)stub62, (void *)stub63, (void *)stub64, (void *)stub65, (void *)stub66, (void *)stub67, (void *)stub68, (void *)stub69, (void *)stub70, (void *)stub71, (void *)stub72, (void *)stub73, (void *)stub74, (void *)stub75, (void *)stub76, (void *)stub77, (void *)stub78, (void *)stub79, (void *)stub80, (void *)stub81, (void *)stub82, (void *)stub83, (void *)stub84, (void *)stub85, (void *)stub86, (void *)stub87, (void *)stub88, (void *)stub89, (void *)stub90, (void *)stub91, (void *)stub92, (void *)stub93, (void *)stub94, (void *)stub95, (void *)stub96, (void *)stub97, (void *)stub98, (void *)stub99, (void *)stub100, (void *)stub101, (void *)stub102, (void *)stub103, (void *)stub104, (void *)stub105, (void *)stub106, (void *)stub107, (void *)stub108, (void *)stub109, (void *)stub110, (void *)stub111, (void *)stub112, (void *)stub113, (void *)stub114, (void *)stub115, (void *)stub116, (void *)stub117, (void *)stub118, (void *)stub119, (void *)stub120, (void *)stub121, (void *)stub122, (void *)stub123, (void *)stub124, (void *)stub125, (void *)stub126, (void *)stub127, (void *)stub128, (void *)stub129, (void *)stub130, (void *)stub131, (void *)stub132, (void *)stub133, (void *)stub134, (void *)stub135, (void *)stub136, (void *)stub137, (void *)stub138, (void *)stub139, (void *)stub140, (void *)stub141, (void *)stub142, (void *)stub143, (void *)stub144, (void *)stub145, (void *)stub146, (void *)stub147, (void *)stub148, (void *)stub149, (void *)stub150, (void *)stub151, (void *)stub152, (void *)stub153, (void *)stub154, (void *)stub155, (void *)stub156, (void *)stub157, (void *)stub158, (void *)stub159, (void *)stub160, (void *)stub161, (void *)stub162, (void *)stub163, (void *)stub164, (void *)stub165, (void *)stub166, (void *)stub167, (void *)stub168, (void *)stub169, (void *)stub170, (void *)stub171, (void *)stub172, (void *)stub173, (void *)stub174, (void *)stub175, (void *)stub176, (void *)stub177, (void *)stub178, (void *)stub179, (void *)stub180, (void *)stub181, (void *)stub182, (void *)stub183, (void *)stub184, (void *)stub185, (void *)stub186, (void *)stub187, (void *)stub188, (void *)stub189, (void *)stub190, (void *)stub191, (void *)stub192, (void *)stub193, (void *)stub194, (void *)stub195, (void *)stub196, (void *)stub197, (void *)stub198, (void *)stub199, (void *)stub200, (void *)stub201, (void *)stub202, (void *)stub203, (void *)stub204, (void *)stub205, (void *)stub206, (void *)stub207, (void *)stub208, (void *)stub209, (void *)stub210, (void *)stub211, (void *)stub212, (void *)stub213, (void *)stub214, (void *)stub215, (void *)stub216, (void *)stub217, (void *)stub218, (void *)stub219, (void *)stub220, (void *)stub221, (void *)stub222, (void *)stub223, (void *)stub224, (void *)stub225, (void *)stub226, (void *)stub227, (void *)stub228, (void *)stub229, (void *)stub230, (void *)stub231, (void *)stub232, (void *)stub233, (void *)stub234 };
static int g_inited;
static void init_table(void)
{
    if (g_inited) return; g_inited = 1;
    for (int i = 0; i < 235; i++) g_table[i] = g_stubs[i];
#define SET(i, f) g_table[i] = (void *)(f)
    SET(4, j_GetVersion); SET(6, j_FindClass); SET(10, j_GetSuperclass); SET(11, j_IsAssignableFrom);
    SET(13, j_Throw); SET(14, j_ThrowNew); SET(15, j_ExceptionOccurred); SET(16, j_ExceptionDescribe); SET(17, j_ExceptionClear); SET(18, j_FatalError);
    SET(19, j_PushLocalFrame); SET(20, j_PopLocalFrame); SET(21, j_NewRef); SET(22, j_DelRef); SET(23, j_DelRef); SET(24, j_IsSameObject);
    SET(25, j_NewRef); SET(26, j_EnsureLocalCapacity); SET(27, j_AllocObject); SET(28, j_NewObject); SET(29, j_NewObjectV); SET(30, j_NewObjectA);
    SET(31, j_GetObjectClass); SET(32, j_IsInstanceOf); SET(33, j_GetMethodID);
#define FAM(base, nm) SET(base, ci_##nm); SET(base + 1, ciV_##nm); SET(base + 2, ciA_##nm);
    FAM(34, Object) FAM(37, Boolean) FAM(40, Byte) FAM(43, Char) FAM(46, Short) FAM(49, Int) FAM(52, Long) FAM(55, Float) FAM(58, Double) FAM(61, Void)
#define FAMN(base, nm) SET(base, cn_##nm); SET(base + 1, cnV_##nm); SET(base + 2, cnA_##nm);
    FAMN(64, Object) FAMN(67, Boolean) FAMN(70, Byte) FAMN(73, Char) FAMN(76, Short) FAMN(79, Int) FAMN(82, Long) FAMN(85, Float) FAMN(88, Double) FAMN(91, Void)
    SET(94, j_GetFieldID);
    SET(95, gf_Object); SET(96, gf_Boolean); SET(97, gf_Byte); SET(98, gf_Char); SET(99, gf_Short); SET(100, gf_Int); SET(101, gf_Long); SET(102, gf_Float); SET(103, gf_Double);
    SET(104, sf_Object); SET(105, sf_Boolean); SET(106, sf_Byte); SET(107, sf_Char); SET(108, sf_Short); SET(109, sf_Int); SET(110, sf_Long); SET(111, sf_Float); SET(112, sf_Double);
    SET(113, j_GetMethodID);
#define FAMS(base, nm) SET(base, cs_##nm); SET(base + 1, csV_##nm); SET(base + 2, csA_##nm);
    FAMS(114, Object) FAMS(117, Boolean) FAMS(120, Byte) FAMS(123, Char) FAMS(126, Short) FAMS(129, Int) FAMS(132, Long) FAMS(135, Float) FAMS(138, Double) FAMS(141, Void)
    SET(144, j_GetFieldID);
    SET(145, gs_ObjectEnum); SET(146, gs_Boolean); SET(147, gs_Byte); SET(148, gs_Char); SET(149, gs_Short); SET(150, gs_Int); SET(151, gs_Long); SET(152, gs_Float); SET(153, gs_Double);
    SET(154, ss_Object); SET(155, ss_Boolean); SET(156, ss_Byte); SET(157, ss_Char); SET(158, ss_Short); SET(159, ss_Int); SET(160, ss_Long); SET(161, ss_Float); SET(162, ss_Double);
    SET(163, j_NewString); SET(164, j_GetStringLength); SET(165, j_GetStringChars); SET(166, j_ReleaseStringChars);
    SET(167, j_NewStringUTF); SET(168, j_GetStringUTFLength); SET(169, j_GetStringUTFChars); SET(170, j_ReleaseStringUTFChars);
    SET(171, j_GetArrayLength); SET(172, j_NewObjectArray); SET(173, j_GetObjectArrayElement); SET(174, j_SetObjectArrayElement);
#define PA(k) SET(175 + k, na_##k); SET(183 + k, ga_##k); SET(191 + k, ra_##k); SET(199 + k, gr_##k); SET(207 + k, sr_##k);
    PA(0) PA(1) PA(2) PA(3) PA(4) PA(5) PA(6) PA(7)
    SET(215, j_RegisterNatives); SET(216, j_Zero); SET(217, j_Zero); SET(218, j_Zero); SET(219, j_GetJavaVM);
    SET(222, j_GetCritical); SET(223, j_RelCritical); SET(224, j_GetStringChars); SET(225, j_ReleaseStringChars);
    SET(226, j_NewRef); SET(227, j_DelRef); SET(228, j_ExceptionCheck);
    SET(229, j_NewDirectByteBuffer); SET(230, j_GetDirectBufferAddress); SET(231, j_GetDirectBufferCapacity); SET(232, j_GetObjectRefType);
    g_vm_table[3] = (void *)vm_ok; g_vm_table[4] = (void *)vm_attach; g_vm_table[5] = (void *)vm_ok; g_vm_table[6] = (void *)vm_getenv; g_vm_table[7] = (void *)vm_attach;
}
void *fake_jni_env(void) { init_table(); return &g_env_ptr; }
void *fake_jni_vm(void) { init_table(); return &g_vm_ptr; }

fj_obj *fake_jni_new_byte_array(const void *p, size_t n)
{
    extern fj_obj *fake_jni__new_arr(int, int64_t);
    fj_obj *a = fake_jni__new_arr(1, (int64_t)n);
    if (p && n) memcpy(a->data, p, n);
    return a;
}
fj_obj *fake_jni__new_arr(int elem, int64_t n) { return new_arr(elem, n); }

/* Field access by name from the host (ids are interned per class/name/signature). */
static fj_obj *find_fid(const char *cls, const char *name, const char *sig)
{
    fj_obj *c = intern_class(cls);
    for (int i = 0; i < g_nids; i++) { fj_obj *x = g_ids[i]; if (x->kind == 5 && x->cls == c && !strcmp(x->name, name)) return x; }
    return intern_id(5, c, name, sig);
}
void fake_jni_set_field(fj_obj *o, const char *cls, const char *name, const char *sig, int64_t v) { setf(o, find_fid(cls, name, sig), v); }
int64_t fake_jni_get_field(fj_obj *o, const char *cls, const char *name) { return getf(o, find_fid(cls, name, "")); }
