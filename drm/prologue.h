/* x86-64 function-prologue decoder and trampoline builder for the Android libcurl hook in drm_hybris.c.
 *
 * The hook overwrites the first 12 bytes of curl_easy_setopt with an absolute jump, so the instructions it destroys have
 * to be copied somewhere callable first. That is only safe for instructions whose meaning does not depend on where they
 * sit. The decoder knows a fixed set of such instructions and returns 0 for anything else, in which case the hook is
 * refused and libcurl is left untouched (phone OTP then falls back to the "can't reach devices" behaviour).
 *
 * One position-dependent instruction is handled: a short conditional jump (Jcc rel8) whose target lies OUTSIDE the copied
 * bytes. It is re-emitted as an inverted short jump over a register-preserving absolute jump, so the target is still the
 * original function body. A jump into the copied bytes themselves would need the copy re-laid out, so it is refused.
 *
 * Extend the decoder, never copy a fixed length: guessing a length once let the hook land in the middle of an instruction. */
#ifndef ADAM_PROLOGUE_H
#define ADAM_PROLOGUE_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>

#define PRO_MAX_INS   16
#define PRO_MAX_BYTES 24
#define PRO_JMP_LEN   14 /* jmp [rip+0] ; .quad target: leaves every register alone */

typedef struct {
    uint8_t off;  /* offset of the instruction in the function */
    uint8_t len;  /* its length */
    uint8_t jcc;  /* 0x70..0x7F for a short conditional jump, else 0 */
    int16_t dest; /* jcc only: branch target as an offset from the start of the function */
} pro_ins;

/* Decodes whole instructions from p until at least `need` bytes are covered. Returns the number of bytes covered and fills
 * ins[0..*count), or returns 0 if an instruction outside the known set (anything RIP-relative or unknown) is met. */
static size_t prologue_scan(const uint8_t *p, size_t need, pro_ins *ins, size_t *count)
{
    size_t n = 0, c = 0;
    while (n < need) {
        const uint8_t *q = p + n;
        size_t len = 0;
        uint8_t jcc = 0;
        int16_t dest = 0;
        if (c == PRO_MAX_INS) return 0;
        if (q[0] == 0xF3 && q[1] == 0x0F && q[2] == 0x1E && q[3] == 0xFA) {
            len = 4; /* endbr64 */
        } else if (q[0] >= 0x50 && q[0] <= 0x57) {
            len = 1; /* push r64 */
        } else if (q[0] == 0x41 && q[1] >= 0x50 && q[1] <= 0x57) {
            len = 2; /* push r8-r15 */
        } else if ((q[0] & 0xFA) == 0x48 && (q[1] == 0x89 || q[1] == 0x8B) && (q[2] & 0xC0) == 0xC0) {
            len = 3; /* mov r,r */
        } else if (q[0] == 0x48 && q[1] == 0x83 && (q[2] & 0xF8) == 0xE8) {
            len = 4; /* sub r,imm8 */
        } else if (q[0] == 0x48 && q[1] == 0x81 && (q[2] & 0xF8) == 0xE8) {
            len = 7; /* sub r,imm32 */
        } else if (q[0] >= 0xB8 && q[0] <= 0xBF) {
            len = 5; /* mov r32,imm32 */
        } else if ((q[0] == 0x84 || q[0] == 0x85) && (q[1] & 0xC0) == 0xC0) {
            len = 2; /* test r8,r8 / test r32,r32 (register form: no memory operand) */
        } else if ((q[0] & 0xF0) == 0x40 && (q[1] == 0x84 || q[1] == 0x85) && (q[2] & 0xC0) == 0xC0) {
            len = 3; /* the same with a REX prefix */
        } else if (q[0] == 0x0F && q[1] == 0x29 && (q[2] & 0xC7) == 0x44 && q[3] == 0x24) {
            len = 5; /* movaps [rsp+disp8], xmm */
        } else if (q[0] == 0x0F && q[1] == 0x29 && (q[2] & 0xC7) == 0x84 && q[3] == 0x24) {
            len = 8; /* movaps [rsp+disp32], xmm */
        } else if (q[0] >= 0x70 && q[0] <= 0x7F) {
            len = 2; /* Jcc rel8: position dependent, rewritten when the trampoline is built */
            jcc = q[0];
            dest = (int16_t)((int)n + 2 + (int8_t)q[1]);
        } else {
            return 0;
        }
        ins[c].off = (uint8_t)n;
        ins[c].len = (uint8_t)len;
        ins[c].jcc = jcc;
        ins[c].dest = dest;
        c++;
        n += len;
    }
    *count = c;
    return n;
}

static void pro_emit_jmp(uint8_t *out, const void *target)
{
    static const uint8_t op[6] = {0xFF, 0x25, 0, 0, 0, 0}; /* jmp [rip+0] */
    memcpy(out, op, sizeof(op));
    memcpy(out + sizeof(op), &target, sizeof(target));
}

/* Builds a callable copy of the first `need` bytes of fn (whole instructions), followed by a jump to the rest of the
 * function. Returns the trampoline, or NULL if the prologue is not relocatable. The page is read-execute only. */
static void *build_trampoline(const void *fn, size_t need)
{
    const uint8_t *f = (const uint8_t *)fn;
    pro_ins ins[PRO_MAX_INS];
    size_t count = 0;
    size_t n = prologue_scan(f, need, ins, &count);
    if (!n || n > PRO_MAX_BYTES) return NULL;
    for (size_t i = 0; i < count; i++) {
        if (ins[i].jcc && ins[i].dest >= 0 && (size_t)ins[i].dest < n) return NULL; /* jumps into the copy */
    }
    uint8_t *tr = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tr == MAP_FAILED) return NULL;
    size_t pos = 0;
    for (size_t i = 0; i < count; i++) {
        if (ins[i].jcc) {
            /* Jcc target  ->  J!cc over ; jmp [rip+0] ; .quad target ; over: */
            tr[pos++] = (uint8_t)(ins[i].jcc ^ 1);
            tr[pos++] = PRO_JMP_LEN;
            pro_emit_jmp(tr + pos, f + ins[i].dest);
            pos += PRO_JMP_LEN;
        } else {
            memcpy(tr + pos, f + ins[i].off, ins[i].len);
            pos += ins[i].len;
        }
    }
    pro_emit_jmp(tr + pos, f + n);
    pos += PRO_JMP_LEN;
    if (mprotect(tr, 4096, PROT_READ | PROT_EXEC) != 0) {
        munmap(tr, 4096);
        return NULL;
    }
    __builtin___clear_cache((char *)tr, (char *)tr + pos);
    return tr;
}

#endif
