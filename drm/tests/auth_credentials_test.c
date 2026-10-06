#include <assert.h>
#include <stdio.h>
#include "../native/auth_credentials.h"

int main(void)
{
    assert(drm_auth_valid_code("012345"));
    assert(!drm_auth_valid_code(""));
    assert(!drm_auth_valid_code("12345"));
    assert(!drm_auth_valid_code("1234567"));
    assert(!drm_auth_valid_code("123x56"));
    assert(!drm_auth_valid_code(NULL));

    const char *original = "my:unchanged password";
    char *first = drm_auth_password(original, "012345");
    char *retry = drm_auth_password(original, "654321");
    assert(first && retry);
    assert(strcmp(first, "my:unchanged password012345") == 0);
    assert(strcmp(retry, "my:unchanged password654321") == 0);
    assert(strcmp(original, "my:unchanged password") == 0);
    free(first); free(retry);
    assert(!drm_auth_password(original, ""));
    assert(!drm_auth_password(NULL, "123456"));

    char long_password[1025];
    memset(long_password, 'p', sizeof(long_password) - 1);
    long_password[sizeof(long_password) - 1] = '\0';
    char *long_response = drm_auth_password(long_password, "123456");
    assert(long_response && strlen(long_response) == 1030);
    assert(strcmp(long_response + 1024, "123456") == 0);
    free(long_response);
    char *without_code = drm_auth_password(long_password, NULL);
    assert(without_code && strcmp(without_code, long_password) == 0);
    free(without_code);
    puts("native authentication credential tests passed");
    return 0;
}
