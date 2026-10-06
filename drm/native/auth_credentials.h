#pragma once

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Codes must be complete: truncating a malformed reply would hide cancellation
 * or UI validation bugs and submit an unintended authentication attempt. */
static inline int drm_auth_valid_code(const char *code)
{
    if (!code || strlen(code) != 6) return 0;
    for (int i = 0; i < 6; ++i)
        if (code[i] < '0' || code[i] > '9') return 0;
    return 1;
}

static inline char *drm_auth_password(const char *password, const char *code)
{
    if (!password || (code && !drm_auth_valid_code(code))) return NULL;
    size_t n = strlen(password);
    size_t suffix = code ? 6 : 0;
    if (n > SIZE_MAX - suffix - 1) return NULL;
    char *result = malloc(n + suffix + 1);
    if (!result) return NULL;
    memcpy(result, password, n);
    if (code) memcpy(result + n, code, suffix);
    result[n + suffix] = '\0';
    return result;
}
