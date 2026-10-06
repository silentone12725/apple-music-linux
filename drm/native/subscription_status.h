#pragma once
#include <stdint.h>
#include <string.h>

/* Native subscription records occupy 16 bytes. The existing ABI reads the
 * state at offset 8 of the second record. Empty/partial status is common in
 * an unauthenticated context and must never dereference address 0x18. */
static inline int drm_subscription_offline_available(const void *begin, const void *end)
{
    uintptr_t first = (uintptr_t)begin, last = (uintptr_t)end;
    if (!first || !last || last < first || last - first < 32) return 0;
    int state;
    memcpy(&state, (const unsigned char *)begin + 24, sizeof(state));
    return state == 2 || state == 3;
}
