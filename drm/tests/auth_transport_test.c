#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "../drm_client.h"

extern int drm_set_account_tokens(const char *, const char *, const char *);
static int saw_running;
static void state_cb(const char *state, void *userdata)
{
    (void)userdata;
    if (strcmp(state, "RUNNING") == 0) saw_running = 1;
}

int main(void)
{
    char dir[] = "/tmp/aml-auth-transport-XXXXXX";
    assert(mkdtemp(dir));
    struct drm_config config = {0};
    config.base_directory = dir;
    config.username = "test@example.invalid";
    config.password = "test-only-password";
    config.state_callback = state_cb;
    assert(drm_init(&config) == 0);
    assert(!saw_running);
    assert(drm_get_account() == NULL);
    char path[512];
    snprintf(path, sizeof(path), "%s/mpl_db/storefront_id", dir);
    assert(access(path, F_OK) != 0);
    assert(drm_set_account_tokens("143441", "test-dev-token", "test-music-token") == 0);
    char *account = drm_get_account();
    assert(account && strstr(account, "test-music-token"));
    assert(strstr(account, "143441"));
    assert(!strstr(account, "placeholder"));
    free(account);
    drm_shutdown();
    // A later login attempt must preserve the authenticated cache until Apple's
    // authentication succeeds, rather than replacing it with placeholders.
    assert(drm_init(&config) == 0);
    account = drm_get_account();
    assert(account && strstr(account, "test-music-token"));
    free(account);
    assert(!saw_running);
    drm_shutdown();
    const char *files[] = { "storefront_id", "dev_token", "music_token" };
    for (size_t i = 0; i < sizeof(files) / sizeof(files[0]); ++i) {
        snprintf(path, sizeof(path), "%s/mpl_db/%s", dir, files[i]);
        assert(unlink(path) == 0);
    }
    snprintf(path, sizeof(path), "%s/mpl_db", dir);
    assert(rmdir(path) == 0);
    snprintf(path, sizeof(path), "%s/cookies.txt", dir);
    unlink(path);
    assert(rmdir(dir) == 0);
    puts("native transport authentication boundary tests passed");
    return 0;
}
