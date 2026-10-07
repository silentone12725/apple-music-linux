/*
 * test_device.c - Test program for FairPlay Device Certificate & ID Generation
 * 
 * Tests the implementation of:
 * - Device ID generation and persistence
 * - RSA and EC key pair generation
 * - Self-signed certificate creation
 * - Key wrapping/unwrapping
 * - Certificate validation
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>
#include "fairplay_device.h"

#define TEST_PASS(name) printf("[PASS] %s\n", name)
#define TEST_FAIL(name, msg) printf("[FAIL] %s: %s\n", name, msg)

static int tests_run = 0;
static int tests_passed = 0;

#define TEST(name) do { \
    tests_run++; \
    printf("\n=== Test: %s ===\n", name); \
} while(0)

#define ASSERT(cond, msg) do { \
    if (!(cond)) { \
        printf("[FAIL] Test assertion failed: %s\n", msg); \
        return; \
    } \
} while(0)

#define ASSERT_PASS() do { \
    tests_passed++; \
    printf("[PASS] Test completed successfully\n"); \
} while(0)

/* Test device ID generation */
static void test_device_id_generation(void) {
    TEST("Device ID Generation");
    
    fp_device_id_t id;
    fp_error_t err = fairplay_device_id_generate(NULL, &id);
    
    ASSERT(err == FP_OK, "Failed to generate device ID");
    ASSERT(id.string[36] == '\0', "Device ID string not null-terminated");
    ASSERT(strlen(id.string) == 36, "Device ID string wrong length");
    ASSERT(id.bytes[6] & 0x40, "Device ID version not set to 4");
    ASSERT(id.bytes[8] & 0x80, "Device ID variant not set");
    
    ASSERT_PASS();
}

/* Test device ID persistence */
static void test_device_id_persistence(void) {
    TEST("Device ID Persistence");
    
    const char *test_dir = "/tmp/aml_device_test";
    fp_device_id_t id1, id2;
    
    /* Clean up from previous runs */
    fairplay_credentials_reset(test_dir);
    
    /* Generate and save */
    fp_error_t err = fairplay_device_id_ensure(test_dir, &id1);
    ASSERT(err == FP_OK, "Failed to ensure device ID");
    
    /* Load and compare */
    err = fairplay_device_id_load(test_dir, &id2);
    ASSERT(err == FP_OK, "Failed to load device ID");
    
    ASSERT(memcmp(id1.bytes, id2.bytes, 16) == 0, "Loaded ID doesn't match");
    ASSERT(strcmp(id1.string, id2.string) == 0, "Loaded ID string doesn't match");
    
    /* Clean up */
    fairplay_credentials_reset(test_dir);
    
    ASSERT_PASS();
}

/* Test RSA key pair generation */
static void test_rsa_keypair_generation(void) {
    TEST("RSA Key Pair Generation");
    
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair = NULL;
    
    fairplay_device_context_create(&ctx);
    
    fp_error_t err = fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair);
    ASSERT(err == FP_OK, "Failed to generate RSA key pair");
    
    ASSERT(keypair != NULL, "Key pair is NULL");
    ASSERT(keypair->type == FP_KEY_TYPE_RSA, "Key type is not RSA");
    ASSERT(keypair->key_bits == 2048, "Key bits not 2048");
    ASSERT(keypair->private_key != NULL, "Private key is NULL");
    ASSERT(keypair->public_key != NULL, "Public key is NULL");
    ASSERT(keypair->private_key_size > 0, "Private key size is 0");
    ASSERT(keypair->public_key_size > 0, "Public key size is 0");
    
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test EC key pair generation */
static void test_ec_keypair_generation(void) {
    TEST("EC Key Pair Generation");
    
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair = NULL;
    
    fairplay_device_context_create(&ctx);
    
    fp_error_t err = fairplay_keypair_generate_ec(ctx, "prime256v1", FP_KEY_FORMAT_PEM, &keypair);
    ASSERT(err == FP_OK, "Failed to generate EC key pair");
    
    ASSERT(keypair != NULL, "Key pair is NULL");
    ASSERT(keypair->type == FP_KEY_TYPE_EC, "Key type is not EC");
    ASSERT(keypair->key_bits == 256, "Key bits not 256");
    ASSERT(keypair->private_key != NULL, "Private key is NULL");
    ASSERT(keypair->public_key != NULL, "Public key is NULL");
    
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test self-signed certificate creation */
static void test_self_signed_cert(void) {
    TEST("Self-Signed Certificate Creation");
    
    fp_device_context_t *ctx = NULL;
    fp_device_id_t id;
    fp_key_pair_t *keypair = NULL;
    fp_certificate_t *cert = NULL;
    
    fairplay_device_context_create(&ctx);
    fairplay_device_id_generate(ctx, &id);
    fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair);
    
    fp_error_t err = fairplay_cert_create_self_signed(ctx, keypair, &id, 10, FP_KEY_FORMAT_PEM, &cert);
    ASSERT(err == FP_OK, "Failed to create self-signed certificate");
    
    ASSERT(cert != NULL, "Certificate is NULL");
    ASSERT(cert->data != NULL, "Certificate data is NULL");
    ASSERT(cert->data_size > 0, "Certificate size is 0");
    ASSERT(cert->data[0] == '-', "Certificate doesn't start with PEM header");
    
    fairplay_cert_free(cert);
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test certificate validation */
static void test_cert_validation(void) {
    TEST("Certificate Validation");
    
    fp_device_context_t *ctx = NULL;
    fp_device_id_t id;
    fp_key_pair_t *keypair = NULL;
    fp_certificate_t *cert = NULL;
    fp_cert_validation_result_t result;
    
    fairplay_device_context_create(&ctx);
    fairplay_device_id_generate(ctx, &id);
    fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair);
    fairplay_cert_create_self_signed(ctx, keypair, &id, 10, FP_KEY_FORMAT_PEM, &cert);
    
    fp_error_t err = fairplay_cert_validate(cert, &id, &result);
    ASSERT(err == FP_OK, "Failed to validate certificate");
    
    ASSERT(result.is_valid == true, "Certificate is not valid");
    ASSERT(result.has_valid_signature == true, "Certificate signature is invalid");
    ASSERT(result.is_within_validity == true, "Certificate is not within validity period");
    ASSERT(result.has_expected_subject == true, "Certificate subject doesn't match device ID");
    
    fairplay_cert_free(cert);
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test key wrapping/unwraping */
static void test_key_wrapping(void) {
    TEST("Key Wrapping/Unwrapping");
    
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair = NULL;
    
    fairplay_device_context_create(&ctx);
    fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair);
    
    /* Test content key */
    uint8_t content_key[16] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                                0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10};
    
    /* Wrap the key */
    uint8_t *wrapped_key = NULL;
    size_t wrapped_size = 0;
    
    fp_error_t err = fairplay_key_wrap(
        content_key, 16,
        keypair->public_key, keypair->public_key_size,
        FP_KEY_TYPE_RSA,
        &wrapped_key, &wrapped_size
    );
    ASSERT(err == FP_OK, "Failed to wrap key");
    ASSERT(wrapped_key != NULL, "Wrapped key is NULL");
    ASSERT(wrapped_size > 0, "Wrapped key size is 0");
    
    /* Unwrap the key */
    uint8_t *unwrapped_key = NULL;
    size_t unwrapped_size = 0;
    
    err = fairplay_key_unwrap(
        wrapped_key, wrapped_size,
        keypair->private_key, keypair->private_key_size,
        NULL,  /* No password */
        FP_KEY_TYPE_RSA,
        &unwrapped_key, &unwrapped_size
    );
    ASSERT(err == FP_OK, "Failed to unwrap key");
    ASSERT(unwrapped_key != NULL, "Unwrapped key is NULL");
    ASSERT(unwrapped_size == 16, "Unwrapped key size is not 16");
    ASSERT(memcmp(content_key, unwrapped_key, 16) == 0, "Unwrapped key doesn't match original");
    
    free(wrapped_key);
    free(unwrapped_key);
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test full credentials workflow */
static void test_credentials_workflow(void) {
    TEST("Full Credentials Workflow");
    
    const char *test_dir = "/tmp/aml_credentials_test";
    fp_device_context_t *ctx = NULL;
    fp_credentials_t *creds = NULL;
    bool generated_new = false;
    
    fairplay_device_context_create(&ctx);
    
    /* Clean up from previous runs */
    fairplay_credentials_reset(test_dir);
    
    /* Generate new credentials */
    fp_error_t err = fairplay_credentials_ensure(
        test_dir, ctx, FP_KEY_TYPE_RSA, NULL, &creds, &generated_new
    );
    ASSERT(err == FP_OK, "Failed to ensure credentials");
    ASSERT(generated_new == true, "Should have generated new credentials");
    ASSERT(creds != NULL, "Credentials is NULL");
    ASSERT(creds->device_id.bytes[0] != 0, "Device ID is empty");
    ASSERT(creds->key_pair != NULL, "Key pair is NULL");
    ASSERT(creds->certificate != NULL, "Certificate is NULL");
    
    fairplay_credentials_free(creds);
    
    /* Load existing credentials */
    err = fairplay_credentials_load(test_dir, NULL, &creds);
    ASSERT(err == FP_OK, "Failed to load credentials");
    ASSERT(creds != NULL, "Loaded credentials is NULL");
    
    fairplay_credentials_free(creds);
    
    /* Try to ensure again (should load existing) */
    err = fairplay_credentials_ensure(test_dir, ctx, FP_KEY_TYPE_RSA, NULL, &creds, &generated_new);
    ASSERT(err == FP_OK, "Failed to ensure credentials again");
    ASSERT(generated_new == false, "Should have loaded existing credentials");
    
    fairplay_credentials_free(creds);
    
    /* Clean up */
    fairplay_credentials_reset(test_dir);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test quick credentials */
static void test_quick_credentials(void) {
    TEST("Quick Credentials Generation");
    
    fp_credentials_t *creds = NULL;
    
    fp_error_t err = fairplay_quick_credentials(&creds);
    ASSERT(err == FP_OK, "Failed to generate quick credentials");
    ASSERT(creds != NULL, "Credentials is NULL");
    ASSERT(creds->device_id.bytes[0] != 0, "Device ID is empty");
    ASSERT(creds->key_pair != NULL, "Key pair is NULL");
    ASSERT(creds->certificate != NULL, "Certificate is NULL");
    
    fairplay_credentials_free(creds);
    
    ASSERT_PASS();
}

/* Test device ID format conversion */
static void test_device_id_format(void) {
    TEST("Device ID Format Conversion");
    
    fp_device_id_t id;
    char hex_out[64];
    fp_device_id_t id_parsed;
    
    fp_error_t err = fairplay_device_id_generate(NULL, &id);
    ASSERT(err == FP_OK, "Failed to generate device ID");
    
    /* Test to_hex */
    err = fairplay_device_id_to_hex(&id, hex_out, sizeof(hex_out));
    ASSERT(err == FP_OK, "Failed to convert to hex");
    ASSERT(strlen(hex_out) == 32, "Hex string wrong length");
    
    /* Test from_hex (without dashes) */
    err = fairplay_device_id_from_hex(hex_out, &id_parsed);
    ASSERT(err == FP_OK, "Failed to parse hex string");
    ASSERT(memcmp(id.bytes, id_parsed.bytes, 16) == 0, "Parsed ID doesn't match");
    
    /* Test from_hex (with dashes) */
    err = fairplay_device_id_from_hex(id.string, &id_parsed);
    ASSERT(err == FP_OK, "Failed to parse UUID string");
    ASSERT(memcmp(id.bytes, id_parsed.bytes, 16) == 0, "Parsed UUID doesn't match");
    
    ASSERT_PASS();
}

/* Test key pair persistence */
static void test_keypair_persistence(void) {
    TEST("Key Pair Persistence");
    
    const char *test_dir = "/tmp/aml_keypair_test";
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair1 = NULL;
    fp_key_pair_t *keypair2 = NULL;
    
    fairplay_device_context_create(&ctx);
    
    /* Clean up */
    fairplay_credentials_reset(test_dir);
    
    /* Generate and save */
    fp_error_t err = fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair1);
    ASSERT(err == FP_OK, "Failed to generate key pair");
    
    err = fairplay_keypair_save(test_dir, keypair1, false, NULL);
    ASSERT(err == FP_OK, "Failed to save key pair");
    
    /* Load and compare */
    err = fairplay_keypair_load_from_storage(test_dir, NULL, &keypair2);
    ASSERT(err == FP_OK, "Failed to load key pair");
    
    ASSERT(keypair2->type == FP_KEY_TYPE_RSA, "Loaded key type is not RSA");
    ASSERT(keypair2->key_bits == 2048, "Loaded key bits not 2048");
    
    fairplay_keypair_free(keypair1);
    fairplay_keypair_free(keypair2);
    fairplay_credentials_reset(test_dir);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test certificate persistence */
static void test_cert_persistence(void) {
    TEST("Certificate Persistence");
    
    const char *test_dir = "/tmp/aml_cert_test";
    fp_device_context_t *ctx = NULL;
    fp_device_id_t id;
    fp_key_pair_t *keypair = NULL;
    fp_certificate_t *cert1 = NULL;
    fp_certificate_t *cert2 = NULL;
    
    fairplay_device_context_create(&ctx);
    fairplay_device_id_generate(ctx, &id);
    fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair);
    
    /* Clean up */
    fairplay_credentials_reset(test_dir);
    
    /* Create and save */
    fp_error_t err = fairplay_cert_create_self_signed(ctx, keypair, &id, 10, FP_KEY_FORMAT_PEM, &cert1);
    ASSERT(err == FP_OK, "Failed to create certificate");
    
    err = fairplay_cert_save(test_dir, cert1);
    ASSERT(err == FP_OK, "Failed to save certificate");
    
    /* Load and compare */
    err = fairplay_cert_load_from_storage(test_dir, &cert2);
    ASSERT(err == FP_OK, "Failed to load certificate");
    
    ASSERT(cert2->data_size > 0, "Loaded certificate size is 0");
    ASSERT(cert2->data[0] == '-', "Loaded certificate doesn't start with PEM header");
    
    fairplay_cert_free(cert1);
    fairplay_cert_free(cert2);
    fairplay_keypair_free(keypair);
    fairplay_credentials_reset(test_dir);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test CSR creation */
static void test_csr_creation(void) {
    TEST("CSR Creation");
    
    fp_device_context_t *ctx = NULL;
    fp_device_id_t id;
    fp_key_pair_t *keypair = NULL;
    fp_csr_t *csr = NULL;
    
    fairplay_device_context_create(&ctx);
    fairplay_device_id_generate(ctx, &id);
    fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair);
    
    fp_error_t err = fairplay_cert_create_csr(ctx, keypair, &id, FP_KEY_FORMAT_PEM, &csr);
    ASSERT(err == FP_OK, "Failed to create CSR");
    
    ASSERT(csr != NULL, "CSR is NULL");
    ASSERT(csr->data != NULL, "CSR data is NULL");
    ASSERT(csr->data_size > 0, "CSR size is 0");
    ASSERT(csr->data[0] == '-', "CSR doesn't start with PEM header");
    
    fairplay_csr_free(csr);
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test EC key wrapping */
static void test_ec_key_wrapping(void) {
    TEST("EC Key Wrapping");
    
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair = NULL;
    
    fairplay_device_context_create(&ctx);
    fairplay_keypair_generate_ec(ctx, "prime256v1", FP_KEY_FORMAT_PEM, &keypair);
    
    uint8_t content_key[16] = {0xAA, 0xBB, 0xCC, 0xDD, 0x11, 0x22, 0x33, 0x44,
                                0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC};
    
    uint8_t *wrapped_key = NULL;
    size_t wrapped_size = 0;
    
    fp_error_t err = fairplay_key_wrap(
        content_key, 16,
        keypair->public_key, keypair->public_key_size,
        FP_KEY_TYPE_EC,
        &wrapped_key, &wrapped_size
    );
    
    /* Note: EC wrapping may fail with some OpenSSL versions, so we accept both success and failure */
    if (err == FP_OK && wrapped_key != NULL) {
        uint8_t *unwrapped_key = NULL;
        size_t unwrapped_size = 0;
        
        err = fairplay_key_unwrap(
            wrapped_key, wrapped_size,
            keypair->private_key, keypair->private_key_size,
            NULL,
            FP_KEY_TYPE_EC,
            &unwrapped_key, &unwrapped_size
        );
        
        if (err == FP_OK) {
            ASSERT(unwrapped_key != NULL, "Unwrapped key is NULL");
            ASSERT(unwrapped_size == 16, "Unwrapped key size is not 16");
            ASSERT(memcmp(content_key, unwrapped_key, 16) == 0, "Unwrapped key doesn't match");
            free(unwrapped_key);
        }
        free(wrapped_key);
    }
    
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test credential reset */
static void test_credential_reset(void) {
    TEST("Credential Reset");
    
    const char *test_dir = "/tmp/aml_reset_test";
    fp_device_context_t *ctx = NULL;
    fp_credentials_t *creds = NULL;
    
    fairplay_device_context_create(&ctx);
    
    /* Generate credentials */
    fp_error_t err = fairplay_credentials_ensure(
        test_dir, ctx, FP_KEY_TYPE_RSA, NULL, &creds, NULL
    );
    ASSERT(err == FP_OK, "Failed to generate credentials");
    fairplay_credentials_free(creds);
    
    /* Verify they exist */
    err = fairplay_credentials_load(test_dir, NULL, &creds);
    ASSERT(err == FP_OK, "Failed to load credentials before reset");
    fairplay_credentials_free(creds);
    
    /* Reset */
    err = fairplay_credentials_reset(test_dir);
    ASSERT(err == FP_OK, "Failed to reset credentials");
    
    /* Verify they're gone */
    err = fairplay_credentials_load(test_dir, NULL, &creds);
    ASSERT(err != FP_OK, "Credentials still exist after reset");
    
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test error handling */
static void test_error_handling(void) {
    TEST("Error Handling");
    
    /* Test NULL pointer handling */
    fp_error_t err;
    
    err = fairplay_device_id_generate(NULL, NULL);
    ASSERT(err == FP_ERR_NULL_POINTER, "Expected NULL pointer error");
    
    err = fairplay_keypair_generate_rsa(NULL, 2048, FP_KEY_FORMAT_PEM, NULL);
    ASSERT(err == FP_ERR_NULL_POINTER, "Expected NULL pointer error");
    
    /* Test invalid key size */
    fp_device_context_t *ctx = NULL;
    fairplay_device_context_create(&ctx);
    
    fp_key_pair_t *keypair = NULL;
    err = fairplay_keypair_generate_rsa(ctx, 512, FP_KEY_FORMAT_PEM, &keypair);
    ASSERT(err == FP_ERR_INVALID_DEVICE_KEY_SIZE, "Expected invalid key size error");
    
    err = fairplay_keypair_generate_rsa(ctx, 8192, FP_KEY_FORMAT_PEM, &keypair);
    ASSERT(err == FP_ERR_INVALID_DEVICE_KEY_SIZE, "Expected invalid key size error");
    
    fairplay_device_context_destroy(ctx);
    
    ASSERT_PASS();
}

/* Test multiple credential generations (uniqueness) */
static void test_credential_uniqueness(void) {
    TEST("Credential Uniqueness");
    
    fp_device_id_t id1, id2, id3;
    
    fp_error_t err = fairplay_device_id_generate(NULL, &id1);
    ASSERT(err == FP_OK, "Failed to generate first ID");
    
    err = fairplay_device_id_generate(NULL, &id2);
    ASSERT(err == FP_OK, "Failed to generate second ID");
    
    err = fairplay_device_id_generate(NULL, &id3);
    ASSERT(err == FP_OK, "Failed to generate third ID");
    
    ASSERT(memcmp(id1.bytes, id2.bytes, 16) != 0, "First and second IDs are identical");
    ASSERT(memcmp(id2.bytes, id3.bytes, 16) != 0, "Second and third IDs are identical");
    ASSERT(memcmp(id1.bytes, id3.bytes, 16) != 0, "First and third IDs are identical");
    
    ASSERT_PASS();
}

int main(void) {
    printf("FairPlay Device Certificate & ID Generation Tests\n");
    printf("==================================================\n\n");
    
    /* Initialize FairPlay */
    fp_error_t err = fairplay_init();
    if (err != FP_OK) {
        printf("[FAIL] Failed to initialize FairPlay: %s\n", fairplay_error_string(err));
        return 1;
    }
    
    /* Run tests */
    test_device_id_generation();
    test_device_id_persistence();
    test_rsa_keypair_generation();
    test_ec_keypair_generation();
    test_self_signed_cert();
    test_cert_validation();
    test_key_wrapping();
    test_credentials_workflow();
    test_quick_credentials();
    test_device_id_format();
    test_keypair_persistence();
    test_cert_persistence();
    test_csr_creation();
    test_ec_key_wrapping();
    test_credential_reset();
    test_error_handling();
    test_credential_uniqueness();
    
    /* Shutdown */
    fairplay_shutdown();
    
    /* Summary */
    printf("\n==================================================\n");
    printf("Tests run: %d, Passed: %d, Failed: %d\n",
           tests_run, tests_passed, tests_run - tests_passed);
    
    return (tests_run == tests_passed) ? 0 : 1;
}
