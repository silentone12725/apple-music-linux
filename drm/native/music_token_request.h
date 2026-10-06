#pragma once
#include <stdio.h>
#include "cJSON.h"

/* The assertion is a JWT and commonly exceeds 512 bytes. Serialize the entire
 * request and let cJSON escape string values rather than interpolating them. */
static inline char *drm_music_token_request(const char *guid, const char *assertion,
                                           long long acceptance_time_ms)
{
    if (!guid || !assertion) return NULL;
    char timestamp[32];
    int n = snprintf(timestamp, sizeof(timestamp), "%lld", acceptance_time_ms);
    if (n < 0 || (size_t)n >= sizeof(timestamp)) return NULL;
    cJSON *request = cJSON_CreateObject();
    if (!request) return NULL;
    if (!cJSON_AddStringToObject(request, "guid", guid) ||
        !cJSON_AddStringToObject(request, "assertion", assertion) ||
        !cJSON_AddStringToObject(request, "tcc-acceptance-date", timestamp)) {
        cJSON_Delete(request);
        return NULL;
    }
    char *body = cJSON_PrintUnformatted(request);
    cJSON_Delete(request);
    return body;
}
