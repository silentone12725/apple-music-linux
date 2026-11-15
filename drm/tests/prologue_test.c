/* Tests for prologue.h on the real first bytes of the Android libcurl's curl_easy_setopt, and on synthetic functions that
 * exercise both sides of its conditional jump. Run through `make test`. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../prologue.h"

static int failures;
#define CHECK(cond, msg)                                                  \
    do {                                                                  \
        if (!(cond)) {                                                    \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, msg); \
            failures++;                                                   \
        }                                                                 \
    } while (0)

/* The first 16 bytes of curl_easy_setopt in drm/rootfs/system/lib64/libcurl.so: sub rsp,0xd8 ; test al,al ; je +0x31 ;
 * movaps [rsp+0x30],xmm0. The je lands 0x3c bytes into the function, outside these 16. */
static const uint8_t REAL[16] = {0x48, 0x81, 0xEC, 0xD8, 0x00, 0x00, 0x00, 0x84, 0xC0, 0x74, 0x31, 0x0F, 0x29, 0x44, 0x24, 0x30};

typedef int (*vfn)(int, ...);

/* A function with the real prologue. al == 0 jumps to the block at +0x3c, otherwise the spill path falls through to the block
 * at +0x10. Each block returns a marker after undoing the stack adjustment, as the real function's epilogue would. */
static uint8_t *make_fn(void)
{
    uint8_t *f = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (f == MAP_FAILED) return NULL;
    memset(f, 0xCC, 4096);
    memcpy(f, REAL, sizeof(REAL));
    static const uint8_t tail[] = {0xB8, 0x78, 0x56, 0x34, 0x12,             /* mov eax,0x12345678 */
                                   0x48, 0x81, 0xC4, 0xD8, 0x00, 0x00, 0x00, /* add rsp,0xd8 */
                                   0xC3};
    static const uint8_t jumped[] = {0xB8, 0xEF, 0xBE, 0xAD, 0xDE, /* mov eax,0xDEADBEEF */
                                     0x48, 0x81, 0xC4, 0xD8, 0x00, 0x00, 0x00, 0xC3};
    memcpy(f + 0x10, tail, sizeof(tail));
    memcpy(f + 0x3C, jumped, sizeof(jumped));
    return f;
}

static void test_real_bytes_decode(void)
{
    pro_ins ins[PRO_MAX_INS];
    size_t count = 0;
    size_t n = prologue_scan(REAL, 12, ins, &count);
    CHECK(n == 16, "the real prologue is four whole instructions covering 16 bytes");
    CHECK(count == 4, "four instructions");
    CHECK(ins[2].jcc == 0x74 && ins[2].dest == 0x3C, "the je targets +0x3c");
}

static void test_trampoline_matches_original(void)
{
    uint8_t *f = make_fn();
    CHECK(f != NULL, "mmap");
    if (!f) return;
    vfn orig = (vfn)(void *)f;
    CHECK(orig(0) == (int)0xDEADBEEF, "original: al == 0 takes the jump");
    CHECK(orig(0, 1.5) == 0x12345678, "original: al > 0 falls through the spills");

    vfn tr = (vfn)build_trampoline(f, 12);
    CHECK(tr != NULL, "trampoline built");
    if (!tr) return;
    /* Overwrite the start of the original as the hook does: the trampoline must not depend on those bytes. */
    memset(f, 0xCC, 12);
    CHECK(tr(0) == (int)0xDEADBEEF, "trampoline: al == 0 reaches the jump target in the original body");
    CHECK(tr(0, 1.5) == 0x12345678, "trampoline: al > 0 spills and continues after the copied bytes");
    CHECK(tr(0, 1.5, 2.5, 3.5) == 0x12345678, "trampoline: several vector arguments");
}

static void test_registers_survive(void)
{
    /* The absolute jumps must not clobber rax/al-dependent state on the fall-through path or rdi/rsi (the arguments). */
    uint8_t *f = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (f == MAP_FAILED) {
        CHECK(0, "mmap");
        return;
    }
    memset(f, 0xCC, 4096);
    memcpy(f, REAL, sizeof(REAL));
    /* fall-through block: mov eax,edi ; add eax,esi ; add rsp,0xd8 ; ret   (returns arg1 + arg2) */
    static const uint8_t body[] = {0x89, 0xF8, 0x01, 0xF0, 0x48, 0x81, 0xC4, 0xD8, 0x00, 0x00, 0x00, 0xC3};
    memcpy(f + 0x10, body, sizeof(body));
    memcpy(f + 0x3C, body, sizeof(body));
    vfn tr = (vfn)build_trampoline(f, 12);
    CHECK(tr != NULL, "trampoline built");
    if (!tr) return;
    CHECK(tr(40, 2) == 42, "arguments survive on the jump path");
    CHECK(tr(40, 2, 1.0) == 42, "arguments survive on the fall-through path");
}

static void test_refusals(void)
{
    pro_ins ins[PRO_MAX_INS];
    size_t count = 0;
    const uint8_t call[16] = {0xE8, 1, 2, 3, 4};
    CHECK(prologue_scan(call, 12, ins, &count) == 0, "call rel32 is refused");
    const uint8_t riprel[16] = {0x48, 0x8D, 0x05, 1, 2, 3, 4}; /* lea rax,[rip+x] */
    CHECK(prologue_scan(riprel, 12, ins, &count) == 0, "RIP-relative lea is refused");
    const uint8_t testmem[16] = {0x84, 0x05, 1, 2, 3, 4}; /* test [rip+x],al: memory operand */
    CHECK(prologue_scan(testmem, 12, ins, &count) == 0, "test with a memory operand is refused");

    /* a short jump into the copied bytes would need the copy laid out again, so it is refused */
    uint8_t *f = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    CHECK(f != MAP_FAILED, "mmap");
    if (f == MAP_FAILED) return;
    memset(f, 0xCC, 4096);
    const uint8_t inside[] = {0x48, 0x81, 0xEC, 0xD8, 0, 0, 0, 0x74, 0x02, 0x84, 0xC0, 0x84, 0xC0, 0x84, 0xC0}; /* je +2 -> inside */
    memcpy(f, inside, sizeof(inside));
    CHECK(build_trampoline(f, 12) == NULL, "a jump into the copy is refused");

    /* a backward jump leaves the copy: accepted and rewritten */
    memset(f, 0xCC, 4096);
    const uint8_t back[] = {0x48, 0x81, 0xEC, 0xD8, 0, 0, 0, 0x75, 0xF0, 0x84, 0xC0, 0x84, 0xC0};
    memcpy(f + 0x40, back, sizeof(back));
    void *tr = build_trampoline(f + 0x40, 12);
    CHECK(tr != NULL, "a backward jump out of the copy is accepted");

    /* every Jcc condition is inverted correctly: je <-> jne, jl <-> jge, ... */
    for (uint8_t cc = 0x70; cc <= 0x7F; cc++) {
        memset(f, 0xCC, 4096);
        const uint8_t code[] = {0x48, 0x81, 0xEC, 0xD8, 0, 0, 0, cc, 0x31, 0x84, 0xC0, 0x84, 0xC0};
        memcpy(f, code, sizeof(code));
        const uint8_t *t = build_trampoline(f, 12);
        CHECK(t && t[7] == (uint8_t)(cc ^ 1) && t[8] == PRO_JMP_LEN, "the condition is inverted over a 14-byte jump");
    }
}

int main(void)
{
    test_real_bytes_decode();
    test_trampoline_matches_original();
    test_registers_survive();
    test_refusals();
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("prologue tests passed\n");
    return 0;
}
