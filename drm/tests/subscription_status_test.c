#include <assert.h>
#include <stdio.h>
#include "../native/subscription_status.h"

int main(void)
{
    unsigned char records[32] = {0};
    assert(!drm_subscription_offline_available(NULL, NULL));
    assert(!drm_subscription_offline_available(NULL, records));
    assert(!drm_subscription_offline_available(records, NULL));
    assert(!drm_subscription_offline_available(records, records));
    assert(!drm_subscription_offline_available(records, records + 16));
    assert(!drm_subscription_offline_available(records, records + 24));
    assert(!drm_subscription_offline_available(records + 16, records));
    int state = 2;
    memcpy(records + 24, &state, sizeof(state));
    assert(!drm_subscription_offline_available(records, records + 31));
    assert(drm_subscription_offline_available(records, records + 32));
    state = 3; memcpy(records + 24, &state, sizeof(state));
    assert(drm_subscription_offline_available(records, records + 32));
    state = 1; memcpy(records + 24, &state, sizeof(state));
    assert(!drm_subscription_offline_available(records, records + 32));
    puts("native subscription status bounds tests passed");
}
