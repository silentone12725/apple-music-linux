#include <assert.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../native/music_token_request.h"

int main(void)
{
    char assertion[4097];
    memset(assertion, 'x', sizeof(assertion) - 1);
    assertion[sizeof(assertion) - 1] = '\0';
    assertion[1500] = '"';
    assertion[1501] = '\\';
    assertion[1502] = '\n';
    const char *guid = "device\"with\\escaped\ncharacters";
    char *body = drm_music_token_request(guid, assertion, 1791292345678LL);
    assert(body && strlen(body) > 4096);
    cJSON *parsed = cJSON_Parse(body);
    assert(parsed && cJSON_IsObject(parsed));
    assert(strcmp(cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(parsed, "guid")), guid) == 0);
    assert(strcmp(cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(parsed, "assertion")), assertion) == 0);
    cJSON *date = cJSON_GetObjectItemCaseSensitive(parsed, "tcc-acceptance-date");
    assert(cJSON_IsString(date));
    assert(strcmp(cJSON_GetStringValue(date), "1791292345678") == 0);
    cJSON_Delete(parsed); cJSON_free(body);
    body = drm_music_token_request("guid", "assertion", LLONG_MAX);
    parsed = cJSON_Parse(body);
    assert(parsed);
    assert(strcmp(cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(parsed, "tcc-acceptance-date")), "9223372036854775807") == 0);
    cJSON_Delete(parsed); cJSON_free(body);
    assert(!drm_music_token_request(NULL, "assertion", 0));
    assert(!drm_music_token_request("guid", NULL, 0));
    puts("native music token request tests passed");
}
