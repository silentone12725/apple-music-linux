/* Exercise the production handler and its borrowed Android string ABI. */
#include <assert.h>
#define login aml_test_native_login
#include "../native/main.c"
#undef login

void *_ZTVNSt6__ndk120__shared_ptr_emplaceIN17storeservicescore19CredentialsResponseENS_9allocatorIS2_EEEE;
static union std_string empty_text;
static const char *expected_password;
static const char *verification_code;
static const char *submitted_password;
static int replies;

union std_string *_ZNK17storeservicescore18CredentialsRequest5titleEv(void *request) {
    (void)request; return &empty_text;
}
union std_string *_ZNK17storeservicescore18CredentialsRequest7messageEv(void *request) {
    (void)request; return &empty_text;
}
uint8_t _ZNK17storeservicescore18CredentialsRequest28requiresHSA2VerificationCodeEv(void *request) {
    return *(uint8_t *)request;
}
void _ZN17storeservicescore19CredentialsResponseC1Ev(void *response) { (void)response; }
void _ZN17storeservicescore19CredentialsResponse11setUserNameERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(void *response, union std_string *name) {
    (void)response; assert(strcmp(std_string_data(name), "test@example.invalid") == 0);
}
void _ZN17storeservicescore19CredentialsResponse11setPasswordERKNSt6__ndk112basic_stringIcNS1_11char_traitsIcEENS1_9allocatorIcEEEE(void *response, union std_string *password) {
    (void)response;
    submitted_password = std_string_data(password);
    assert(strcmp(submitted_password, expected_password) == 0);
}
void _ZN17storeservicescore19CredentialsResponse15setResponseTypeENS0_12ResponseTypeE(void *response, int type) {
    (void)response; assert(type == 2);
}
void _ZN20androidstoreservices28AndroidPresentationInterface25handleCredentialsResponseERKNSt6__ndk110shared_ptrIN17storeservicescore19CredentialsResponseEEE(void *presentation, struct shared_ptr *response) {
    (void)presentation;
    assert(strcmp(submitted_password, expected_password) == 0);
    ++replies;
    free(response->ctrl_blk);
}
static void supply_code(const char *type, char *buffer, int capacity, void *data) {
    (void)data; assert(strcmp(type, "2fa") == 0);
    snprintf(buffer, capacity, "%s", verification_code);
}
int main(void) {
    empty_text = new_std_string("");
    amUsername = "test@example.invalid";
    char original[1025];
    memset(original, 'p', sizeof(original) - 1);
    original[sizeof(original) - 1] = '\0';
    amPassword = original;
    uint8_t requires_code = 0;
    struct shared_ptr request = {.obj = &requires_code};
    expected_password = original;
    credentialHandler(&request, NULL);
    requires_code = 1;
    g_drm_auth_cb = supply_code;
    const char *codes[] = {"123456", "654321"};
    for (size_t i = 0; i < 2; ++i) {
        char expected[1031];
        verification_code = codes[i];
        snprintf(expected, sizeof(expected), "%s%s", original, verification_code);
        expected_password = expected;
        credentialHandler(&request, NULL);
        assert(strlen(amPassword) == 1024);
        assert(strcmp(amPassword, original) == 0);
    }
    assert(replies == 3);
    puts("credential handler password lifetime and 2FA retries passed");
    return 0;
}
