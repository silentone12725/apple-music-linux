#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <signal.h>
#include <ucontext.h>
#include <unistd.h>

extern void *android_dlopen(const char *, int);
extern void *android_dlsym(void *, const char *);
extern char *android_dlerror(void);
typedef void *(*hook_cb)(const char *sym, const char *requester);
extern void hybris_set_hook_callback(hook_cb);

static void *g_stdin_v, *g_stdout_v, *g_stderr_v;
static int p_register_atfork(void (*a)(void), void (*b)(void), void (*c)(void), void *d) { (void)a; (void)b; (void)c; (void)d; return 0; }
static void *p_memchr_chk(const void *s, int c, size_t n, size_t bos) { (void)bos; return (void *)memchr(s, c, n); }
static int p_log_write(int prio, const char *tag, const char *msg) { fprintf(stderr, "[alog %d] %s: %s\n", prio, tag ? tag : "", msg ? msg : ""); return 0; }
static int p_log_vprint(int prio, const char *tag, const char *fmt, va_list ap) { char b[1024]; vsnprintf(b, sizeof b, fmt, ap); return p_log_write(prio, tag, b); }
static int p_log_print(int prio, const char *tag, const char *fmt, ...) { va_list ap; va_start(ap, fmt); int r = p_log_vprint(prio, tag, fmt, ap); va_end(ap); return r; }
static void *hook(const char *sym, const char *req)
{
    (void)req;
    if (!strcmp(sym, "stdin")) return &g_stdin_v;
    if (!strcmp(sym, "stdout")) return &g_stdout_v;
    if (!strcmp(sym, "stderr")) return &g_stderr_v;
    if (!strcmp(sym, "__register_atfork")) return (void *)p_register_atfork;
    if (!strcmp(sym, "__memchr_chk")) return (void *)p_memchr_chk;
    if (!strcmp(sym, "__android_log_write")) return (void *)p_log_write;
    if (!strcmp(sym, "__android_log_vprint")) return (void *)p_log_vprint;
    if (!strcmp(sym, "__android_log_print")) return (void *)p_log_print;
    return NULL;
}

static long g_hits[240]; static long g_tok = 0x1000;
static long hit(int n, int tokret) { g_hits[n]++; return tokret ? (g_tok += 8) : 0; }
static long s0(void) { return hit(0, 0); }
static long s1(void) { return hit(1, 0); }
static long s2(void) { return hit(2, 0); }
static long s3(void) { return hit(3, 0); }
static long s4(void) { return hit(4, 0); }
static long s5(void) { return hit(5, 0); }
static long s6(void) { return hit(6, 1); }
static long s7(void) { return hit(7, 0); }
static long s8(void) { return hit(8, 0); }
static long s9(void) { return hit(9, 0); }
static long s10(void) { return hit(10, 1); }
static long s11(void) { return hit(11, 0); }
static long s12(void) { return hit(12, 0); }
static long s13(void) { return hit(13, 0); }
static long s14(void) { return hit(14, 0); }
static long s15(void) { return hit(15, 0); }
static long s16(void) { return hit(16, 0); }
static long s17(void) { return hit(17, 0); }
static long s18(void) { return hit(18, 0); }
static long s19(void) { return hit(19, 0); }
static long s20(void) { return hit(20, 0); }
static long s21(void) { return hit(21, 1); }
static long s22(void) { return hit(22, 0); }
static long s23(void) { return hit(23, 0); }
static long s24(void) { return hit(24, 0); }
static long s25(void) { return hit(25, 1); }
static long s26(void) { return hit(26, 0); }
static long s27(void) { return hit(27, 0); }
static long s28(void) { return hit(28, 1); }
static long s29(void) { return hit(29, 1); }
static long s30(void) { return hit(30, 1); }
static long s31(void) { return hit(31, 1); }
static long s32(void) { return hit(32, 0); }
static long s33(void) { return hit(33, 1); }
static long s34(void) { return hit(34, 1); }
static long s35(void) { return hit(35, 0); }
static long s36(void) { return hit(36, 1); }
static long s37(void) { return hit(37, 0); }
static long s38(void) { return hit(38, 0); }
static long s39(void) { return hit(39, 0); }
static long s40(void) { return hit(40, 0); }
static long s41(void) { return hit(41, 0); }
static long s42(void) { return hit(42, 0); }
static long s43(void) { return hit(43, 0); }
static long s44(void) { return hit(44, 0); }
static long s45(void) { return hit(45, 0); }
static long s46(void) { return hit(46, 0); }
static long s47(void) { return hit(47, 0); }
static long s48(void) { return hit(48, 0); }
static long s49(void) { return hit(49, 0); }
static long s50(void) { return hit(50, 0); }
static long s51(void) { return hit(51, 0); }
static long s52(void) { return hit(52, 0); }
static long s53(void) { return hit(53, 0); }
static long s54(void) { return hit(54, 0); }
static long s55(void) { return hit(55, 0); }
static long s56(void) { return hit(56, 0); }
static long s57(void) { return hit(57, 0); }
static long s58(void) { return hit(58, 0); }
static long s59(void) { return hit(59, 0); }
static long s60(void) { return hit(60, 0); }
static long s61(void) { return hit(61, 0); }
static long s62(void) { return hit(62, 0); }
static long s63(void) { return hit(63, 0); }
static long s64(void) { return hit(64, 0); }
static long s65(void) { return hit(65, 0); }
static long s66(void) { return hit(66, 0); }
static long s67(void) { return hit(67, 0); }
static long s68(void) { return hit(68, 0); }
static long s69(void) { return hit(69, 0); }
static long s70(void) { return hit(70, 0); }
static long s71(void) { return hit(71, 0); }
static long s72(void) { return hit(72, 0); }
static long s73(void) { return hit(73, 0); }
static long s74(void) { return hit(74, 0); }
static long s75(void) { return hit(75, 0); }
static long s76(void) { return hit(76, 0); }
static long s77(void) { return hit(77, 0); }
static long s78(void) { return hit(78, 0); }
static long s79(void) { return hit(79, 0); }
static long s80(void) { return hit(80, 0); }
static long s81(void) { return hit(81, 0); }
static long s82(void) { return hit(82, 0); }
static long s83(void) { return hit(83, 0); }
static long s84(void) { return hit(84, 0); }
static long s85(void) { return hit(85, 0); }
static long s86(void) { return hit(86, 0); }
static long s87(void) { return hit(87, 0); }
static long s88(void) { return hit(88, 0); }
static long s89(void) { return hit(89, 0); }
static long s90(void) { return hit(90, 0); }
static long s91(void) { return hit(91, 0); }
static long s92(void) { return hit(92, 0); }
static long s93(void) { return hit(93, 0); }
static long s94(void) { return hit(94, 1); }
static long s95(void) { return hit(95, 1); }
static long s96(void) { return hit(96, 0); }
static long s97(void) { return hit(97, 0); }
static long s98(void) { return hit(98, 0); }
static long s99(void) { return hit(99, 0); }
static long s100(void) { return hit(100, 0); }
static long s101(void) { return hit(101, 0); }
static long s102(void) { return hit(102, 0); }
static long s103(void) { return hit(103, 0); }
static long s104(void) { return hit(104, 0); }
static long s105(void) { return hit(105, 0); }
static long s106(void) { return hit(106, 0); }
static long s107(void) { return hit(107, 0); }
static long s108(void) { return hit(108, 0); }
static long s109(void) { return hit(109, 0); }
static long s110(void) { return hit(110, 0); }
static long s111(void) { return hit(111, 0); }
static long s112(void) { return hit(112, 0); }
static long s113(void) { return hit(113, 1); }
static long s114(void) { return hit(114, 0); }
static long s115(void) { return hit(115, 0); }
static long s116(void) { return hit(116, 0); }
static long s117(void) { return hit(117, 0); }
static long s118(void) { return hit(118, 0); }
static long s119(void) { return hit(119, 0); }
static long s120(void) { return hit(120, 0); }
static long s121(void) { return hit(121, 0); }
static long s122(void) { return hit(122, 0); }
static long s123(void) { return hit(123, 0); }
static long s124(void) { return hit(124, 0); }
static long s125(void) { return hit(125, 0); }
static long s126(void) { return hit(126, 0); }
static long s127(void) { return hit(127, 0); }
static long s128(void) { return hit(128, 0); }
static long s129(void) { return hit(129, 0); }
static long s130(void) { return hit(130, 0); }
static long s131(void) { return hit(131, 0); }
static long s132(void) { return hit(132, 0); }
static long s133(void) { return hit(133, 0); }
static long s134(void) { return hit(134, 0); }
static long s135(void) { return hit(135, 0); }
static long s136(void) { return hit(136, 0); }
static long s137(void) { return hit(137, 0); }
static long s138(void) { return hit(138, 0); }
static long s139(void) { return hit(139, 0); }
static long s140(void) { return hit(140, 0); }
static long s141(void) { return hit(141, 0); }
static long s142(void) { return hit(142, 0); }
static long s143(void) { return hit(143, 0); }
static long s144(void) { return hit(144, 1); }
static long s145(void) { return hit(145, 0); }
static long s146(void) { return hit(146, 0); }
static long s147(void) { return hit(147, 0); }
static long s148(void) { return hit(148, 0); }
static long s149(void) { return hit(149, 0); }
static long s150(void) { return hit(150, 0); }
static long s151(void) { return hit(151, 0); }
static long s152(void) { return hit(152, 0); }
static long s153(void) { return hit(153, 0); }
static long s154(void) { return hit(154, 0); }
static long s155(void) { return hit(155, 0); }
static long s156(void) { return hit(156, 0); }
static long s157(void) { return hit(157, 0); }
static long s158(void) { return hit(158, 0); }
static long s159(void) { return hit(159, 0); }
static long s160(void) { return hit(160, 0); }
static long s161(void) { return hit(161, 0); }
static long s162(void) { return hit(162, 0); }
static long s163(void) { return hit(163, 0); }
static long s164(void) { return hit(164, 1); }
static long s165(void) { return hit(165, 0); }
static long s166(void) { return hit(166, 0); }
static long s167(void) { return hit(167, 1); }
static long s168(void) { return hit(168, 0); }
static long s169(void) { return hit(169, 0); }
static long s170(void) { return hit(170, 0); }
static long s171(void) { return hit(171, 0); }
static long s172(void) { return hit(172, 1); }
static long s173(void) { return hit(173, 1); }
static long s174(void) { return hit(174, 0); }
static long s175(void) { return hit(175, 0); }
static long s176(void) { return hit(176, 0); }
static long s177(void) { return hit(177, 0); }
static long s178(void) { return hit(178, 0); }
static long s179(void) { return hit(179, 0); }
static long s180(void) { return hit(180, 0); }
static long s181(void) { return hit(181, 0); }
static long s182(void) { return hit(182, 0); }
static long s183(void) { return hit(183, 0); }
static long s184(void) { return hit(184, 0); }
static long s185(void) { return hit(185, 0); }
static long s186(void) { return hit(186, 0); }
static long s187(void) { return hit(187, 0); }
static long s188(void) { return hit(188, 0); }
static long s189(void) { return hit(189, 0); }
static long s190(void) { return hit(190, 0); }
static long s191(void) { return hit(191, 0); }
static long s192(void) { return hit(192, 0); }
static long s193(void) { return hit(193, 0); }
static long s194(void) { return hit(194, 0); }
static long s195(void) { return hit(195, 0); }
static long s196(void) { return hit(196, 0); }
static long s197(void) { return hit(197, 0); }
static long s198(void) { return hit(198, 0); }
static long s199(void) { return hit(199, 0); }
static long s200(void) { return hit(200, 0); }
static long s201(void) { return hit(201, 0); }
static long s202(void) { return hit(202, 0); }
static long s203(void) { return hit(203, 0); }
static long s204(void) { return hit(204, 0); }
static long s205(void) { return hit(205, 0); }
static long s206(void) { return hit(206, 0); }
static long s207(void) { return hit(207, 0); }
static long s208(void) { return hit(208, 0); }
static long s209(void) { return hit(209, 0); }
static long s210(void) { return hit(210, 0); }
static long s211(void) { return hit(211, 0); }
static long s212(void) { return hit(212, 0); }
static long s213(void) { return hit(213, 0); }
static long s214(void) { return hit(214, 0); }
static long s215(void) { return hit(215, 0); }
static long s216(void) { return hit(216, 0); }
static long s217(void) { return hit(217, 0); }
static long s218(void) { return hit(218, 0); }
static long s219(void) { return hit(219, 0); }
static long s220(void) { return hit(220, 0); }
static long s221(void) { return hit(221, 0); }
static long s222(void) { return hit(222, 0); }
static long s223(void) { return hit(223, 0); }
static long s224(void) { return hit(224, 0); }
static long s225(void) { return hit(225, 0); }
static long s226(void) { return hit(226, 0); }
static long s227(void) { return hit(227, 0); }
static long s228(void) { return hit(228, 0); }
static long s229(void) { return hit(229, 1); }
static long s230(void) { return hit(230, 0); }
static long s231(void) { return hit(231, 0); }
static long s232(void) { return hit(232, 0); }
static long s233(void) { return hit(233, 0); }
static long s234(void) { return hit(234, 0); }
static void *g_table[235] = { (void *)s0, (void *)s1, (void *)s2, (void *)s3, (void *)s4, (void *)s5, (void *)s6, (void *)s7, (void *)s8, (void *)s9, (void *)s10, (void *)s11, (void *)s12, (void *)s13, (void *)s14, (void *)s15, (void *)s16, (void *)s17, (void *)s18, (void *)s19, (void *)s20, (void *)s21, (void *)s22, (void *)s23, (void *)s24, (void *)s25, (void *)s26, (void *)s27, (void *)s28, (void *)s29, (void *)s30, (void *)s31, (void *)s32, (void *)s33, (void *)s34, (void *)s35, (void *)s36, (void *)s37, (void *)s38, (void *)s39, (void *)s40, (void *)s41, (void *)s42, (void *)s43, (void *)s44, (void *)s45, (void *)s46, (void *)s47, (void *)s48, (void *)s49, (void *)s50, (void *)s51, (void *)s52, (void *)s53, (void *)s54, (void *)s55, (void *)s56, (void *)s57, (void *)s58, (void *)s59, (void *)s60, (void *)s61, (void *)s62, (void *)s63, (void *)s64, (void *)s65, (void *)s66, (void *)s67, (void *)s68, (void *)s69, (void *)s70, (void *)s71, (void *)s72, (void *)s73, (void *)s74, (void *)s75, (void *)s76, (void *)s77, (void *)s78, (void *)s79, (void *)s80, (void *)s81, (void *)s82, (void *)s83, (void *)s84, (void *)s85, (void *)s86, (void *)s87, (void *)s88, (void *)s89, (void *)s90, (void *)s91, (void *)s92, (void *)s93, (void *)s94, (void *)s95, (void *)s96, (void *)s97, (void *)s98, (void *)s99, (void *)s100, (void *)s101, (void *)s102, (void *)s103, (void *)s104, (void *)s105, (void *)s106, (void *)s107, (void *)s108, (void *)s109, (void *)s110, (void *)s111, (void *)s112, (void *)s113, (void *)s114, (void *)s115, (void *)s116, (void *)s117, (void *)s118, (void *)s119, (void *)s120, (void *)s121, (void *)s122, (void *)s123, (void *)s124, (void *)s125, (void *)s126, (void *)s127, (void *)s128, (void *)s129, (void *)s130, (void *)s131, (void *)s132, (void *)s133, (void *)s134, (void *)s135, (void *)s136, (void *)s137, (void *)s138, (void *)s139, (void *)s140, (void *)s141, (void *)s142, (void *)s143, (void *)s144, (void *)s145, (void *)s146, (void *)s147, (void *)s148, (void *)s149, (void *)s150, (void *)s151, (void *)s152, (void *)s153, (void *)s154, (void *)s155, (void *)s156, (void *)s157, (void *)s158, (void *)s159, (void *)s160, (void *)s161, (void *)s162, (void *)s163, (void *)s164, (void *)s165, (void *)s166, (void *)s167, (void *)s168, (void *)s169, (void *)s170, (void *)s171, (void *)s172, (void *)s173, (void *)s174, (void *)s175, (void *)s176, (void *)s177, (void *)s178, (void *)s179, (void *)s180, (void *)s181, (void *)s182, (void *)s183, (void *)s184, (void *)s185, (void *)s186, (void *)s187, (void *)s188, (void *)s189, (void *)s190, (void *)s191, (void *)s192, (void *)s193, (void *)s194, (void *)s195, (void *)s196, (void *)s197, (void *)s198, (void *)s199, (void *)s200, (void *)s201, (void *)s202, (void *)s203, (void *)s204, (void *)s205, (void *)s206, (void *)s207, (void *)s208, (void *)s209, (void *)s210, (void *)s211, (void *)s212, (void *)s213, (void *)s214, (void *)s215, (void *)s216, (void *)s217, (void *)s218, (void *)s219, (void *)s220, (void *)s221, (void *)s222, (void *)s223, (void *)s224, (void *)s225, (void *)s226, (void *)s227, (void *)s228, (void *)s229, (void *)s230, (void *)s231, (void *)s232, (void *)s233, (void *)s234 };
static const char *slotname(int n) { switch (n) { case 4: return "GetVersion"; case 6: return "FindClass"; case 10: return "GetSuperclass"; case 13: return "Throw"; case 14: return "ThrowNew"; case 15: return "ExceptionOccurred"; case 16: return "ExceptionDescribe"; case 17: return "ExceptionClear"; case 21: return "NewGlobalRef"; case 22: return "DeleteGlobalRef"; case 23: return "DeleteLocalRef"; case 24: return "IsSameObject"; case 25: return "NewLocalRef"; case 26: return "EnsureLocalCapacity"; case 28: return "NewObject"; case 29: return "NewObjectV"; case 30: return "NewObjectA"; case 31: return "GetObjectClass"; case 33: return "GetMethodID"; case 34: return "CallObjectMethod"; case 37: return "CallBooleanMethod"; case 61: return "CallVoidMethod"; case 94: return "GetFieldID"; case 95: return "GetObjectField"; case 100: return "GetLongField"; case 107: return "SetObjectField"; case 112: return "SetLongField"; case 113: return "GetStaticMethodID"; case 144: return "GetStaticFieldID"; case 167: return "NewStringUTF"; case 164: return "NewString"; case 169: return "GetStringUTFChars"; case 170: return "ReleaseStringUTFChars"; case 171: return "GetArrayLength"; case 172: return "NewObjectArray"; case 173: return "GetObjectArrayElement"; case 215: return "GetPrimitiveArrayCritical"; case 228: return "ExceptionCheck"; case 229: return "NewDirectByteBuffer"; case 230: return "GetDirectBufferAddress"; case 219: return "RegisterNatives"; case 216: return "ReleasePrimitiveArrayCritical"; case 217: return "GetStringCritical"; case 218: return "ReleaseStringCritical"; case 220: return "UnregisterNatives"; case 221: return "MonitorEnter"; case 222: return "MonitorExit"; case 223: return "GetJavaVM"; default: return "?"; } }
static void *g_adapter;
static long fn93(void *env, void *obj, void *cls, void *mid, void *args)
{
    (void)env; (void)cls; (void)mid; g_hits[93]++;
    long addr = args ? *(long *)args : 0;
    printf("[jni] slot93 CallNonvirtualVoidMethodA obj=%p args[0]=%#lx\n", obj, addr);
    if (!g_adapter) g_adapter = (void *)addr;
    return 0;
}
static void *g_envp = g_table;                 /* JNIEnv  = pointer to pointer to the function table */
static void *g_vmtab[8];
static long vm_getenv(void *vm, void **out, int ver) { (void)vm; (void)ver; *out = &g_envp; return 0; }
static long vm_ok(void) { return 0; }
static void *g_vmp = g_vmtab;                  /* JavaVM  = pointer to pointer to the invoke table */
static void report(void)
{
    printf("[probe] JNI slots touched:\n");
    for (int i = 0; i < 235; i++) if (g_hits[i]) printf("    slot %3d %-24s x%ld\n", i, slotname(i), g_hits[i]);
}
static void crash(int sig, siginfo_t *si, void *ctx)
{
    ucontext_t *uc = ctx; unsigned long rip = uc->uc_mcontext.gregs[REG_RIP];
    fprintf(stderr, "\n[probe] CRASH sig=%d addr=%p rip=%#lx\n", sig, si->si_addr, rip);
    FILE *m = fopen("/proc/self/maps", "r"); char line[512];
    while (m && fgets(line, sizeof line, m)) { unsigned long a, b; if (sscanf(line, "%lx-%lx", &a, &b) == 2 && rip >= a && rip < b) { fprintf(stderr, "[probe] rip in: %s", line); break; } }
    _exit(139);
}


/* ---- host implementation of AMSCore::IBundleInfo (14 vtable slots; 2,4,7,10 are pure virtual) ---- */
static void put_str(void *ret, const char *v)            /* libc++ (NDK) short std::string */
{ unsigned char *r = ret; memset(r, 0, 24); size_t n = strlen(v); r[0] = (unsigned char)(n << 1); memcpy(r + 1, v, n); }
static void bi_dtor(void *self) { (void)self; }
static void bi_dtor_del(void *self) { (void)self; }
static void bi_s2(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot2 called\n"); put_str(ret, "musicAndroid"); }
static void bi_s4(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot4 called\n"); put_str(ret, "Music"); }
static void bi_s7(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot7 called\n"); put_str(ret, "6.5.2"); }
static void bi_s10(void *ret, void *self) { (void)self; fprintf(stderr, "[bundle] slot10 called\n"); put_str(ret, "musicAndroid"); }
typedef struct { void *obj; void *ctrl; } sp_t;
#define SYM(n) android_dlsym(h, n)

int main(void)
{
    struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_sigaction = crash; sa.sa_flags = SA_SIGINFO; sigaction(SIGSEGV, &sa, NULL); sigaction(SIGABRT, &sa, NULL); sigaction(SIGILL, &sa, NULL);
    const char *res = "/home/daksh/Git Projects/apple-music-linux/electron/dist/resources";
    const char *lib = "/home/daksh/Git Projects/apple-music-linux/drm/rootfs-6.5.2/system/lib64";
    char p[512]; snprintf(p, sizeof p, "%s/hybris-linker", res);
    setenv("HYBRIS_LINKER_DIR", p, 1); setenv("HYBRIS_LD_LIBRARY_PATH", lib, 1); setenv("HYBRIS_ANDROID_LIB64", lib, 1);
    setenv("ANDROID_ROOT", "/tmp/amskit-probe", 0); setenv("ANDROID_DATA", "/tmp/amskit-probe/data", 0);
    setvbuf(stdout, NULL, _IONBF, 0);
    g_stdin_v = stdin; g_stdout_v = stdout; g_stderr_v = stderr;
    hybris_set_hook_callback(hook);

    void *h = android_dlopen("libAMSKit.so", 2);
    if (!h) { printf("[probe] load failed: %s\n", android_dlerror()); return 1; }
    printf("[probe] libAMSKit loaded\n");

    void (*bundle_default)(sp_t *) = (void (*)(sp_t *))SYM("_ZN7AMSCore11IBundleInfo11makeDefaultEv");
    void (*session_ctor)(void *, sp_t *) = (void (*)(void *, sp_t *))SYM("_ZN7AMSCore7SessionC1ENSt6__ndk110shared_ptrINS_11IBundleInfoEEE");
    void (*session_defaults)(void *ret, void *self) = (void (*)(void *, void *))SYM("_ZN7AMSCore7Session12makeDefaultsEv");
    printf("[probe] bundle_default=%p session_ctor=%p session_defaults=%p\n", (void *)bundle_default, (void *)session_ctor, (void *)session_defaults);

    g_vmtab[3] = (void *)vm_ok; g_vmtab[4] = (void *)vm_ok; g_vmtab[5] = (void *)vm_ok; g_vmtab[6] = (void *)vm_getenv; g_vmtab[7] = (void *)vm_ok;
    long (*onload)(void *vm, void *res) = (long (*)(void *, void *))SYM("JNI_OnLoad");
    printf("[probe] calling JNI_OnLoad(fakeVM)\n");
    long ver = onload ? onload(&g_vmp, NULL) : -1;
    printf("[probe] JNI_OnLoad returned %#lx\n", ver);
    report();
    g_table[93] = (void *)fn93;
    memset(g_hits, 0, sizeof g_hits);
    void (*alloc)(void *env, void *self) = (void (*)(void *, void *))SYM("Java_com_apple_mediaservices_amskit_bindings_IAndroidHTTPProvider_allocate");
    printf("[probe] calling IAndroidHTTPProvider.allocate(fakeEnv, token)\n");
    alloc(&g_envp, (void *)0x2000);
    printf("[probe] allocate returned\n"); report();
    if (g_adapter) {
        FILE *m = fopen("/proc/self/maps", "r"); char line[512]; unsigned long base = 0; int n = 0;
        while (m && fgets(line, sizeof line, m)) if (strstr(line, "libAMSKit.so")) { unsigned long a; sscanf(line, "%lx", &a); if (!base || a < base) base = a; n++; }
        void **vt = *(void ***)g_adapter;
        printf("[probe] adapter object %p, vptr %p, libAMSKit base %#lx\n", g_adapter, (void *)vt, base);
        for (int i = -2; i < 8; i++) printf("    vptr[%2d] = %p  (libAMSKit+%#lx)\n", i, vt[i], (unsigned long)vt[i] - base);
        printf("[probe] first 64 bytes of the object:"); for (int i = 0; i < 64; i++) printf("%s%02x", i % 8 ? " " : "  ", ((unsigned char *)g_adapter)[i]); printf("\n");
    }
    printf("[probe] done\n");
    return 0;
}
