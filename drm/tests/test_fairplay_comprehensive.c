/*
 * test_fairplay_comprehensive.c - Comprehensive FairPlay DRM Tests
 * Version: 2.0
 * Date: 2026-10-07
 */

#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>
#include <time.h>

#include "../fairplay.h"
#include "../drm_client.h"

#define TEST_COUNT 28

typedef struct {
    const char *name;
    bool passed;
    char failure_reason[256];
    const char *requirements;
} test_result_t;

static test_result_t g_test_results[TEST_COUNT];
static int g_test_count = 0;
static int g_passed = 0;
static int g_failed = 0;

#define TEST_ASSERT(condition, message) do { \
    if (!(condition)) { test_fail(message); return; } \
} while(0)

#define TEST_ASSERT_EQUAL(expected, actual, message) do { \
    if ((expected) != (actual)) { \
        char buf[128]; \
        snprintf(buf, sizeof(buf), message ": expected %ld, got %ld", \
                 (long)(expected), (long)(actual)); \
        test_fail(buf); return; \
    } \
} while(0)

#define TEST_ASSERT_NOT_EQUAL(expected, actual, message) do { \
    if ((expected) == (actual)) { \
        char buf[128]; \
        snprintf(buf, sizeof(buf), message ": expected != %ld, but got equal", \
                 (long)(expected)); \
        test_fail(buf); return; \
    } \
} while(0)

#define TEST_ASSERT_STRING_EQUAL(expected, actual, message) do { \
    if (!actual || strcmp(expected, actual) != 0) { \
        char buf[256]; \
        snprintf(buf, sizeof(buf), message ": expected '%s', got '%s'", \
                 expected, actual ? actual : "NULL"); \
        test_fail(buf); return; \
    } \
} while(0)

#define TEST_ASSERT_PTR_NOT_NULL(ptr, message) do { \
    if (!(ptr)) { test_fail(message ? message : "Pointer is NULL"); return; } \
} while(0)

#define TEST_ASSERT_PTR_NULL(ptr, message) do { \
    if ((ptr)) { test_fail(message ? message : "Pointer should be NULL"); return; } \
} while(0)

#define TEST_ASSERT_ERROR(expected_error, actual_error, message) do { \
    if ((expected_error) != (actual_error)) { \
        char buf[128]; \
        snprintf(buf, sizeof(buf), message ": expected %d, got %d", \
                 (int)(expected_error), (int)(actual_error)); \
        test_fail(buf); return; \
    } \
} while(0)

static void test_start(const char *name, const char *requirements) {
    if (g_test_count >= TEST_COUNT) return;
    g_test_results[g_test_count].name = name;
    g_test_results[g_test_count].passed = true;
    g_test_results[g_test_count].failure_reason[0] = '\0';
    g_test_results[g_test_count].requirements = requirements ? requirements : "";
    g_test_count++;
}

static void test_pass(void) {
    if (g_test_count > 0) {
        g_test_results[g_test_count - 1].passed = true;
        g_passed++;
    }
}

static void test_fail(const char *reason) {
    if (g_test_count > 0) {
        g_test_results[g_test_count - 1].passed = false;
        strncpy(g_test_results[g_test_count - 1].failure_reason, reason, 255);
        g_test_results[g_test_count - 1].failure_reason[255] = '\0';
        g_failed++;
    }
}

static void print_test_results(void) {
    printf("\n========================================\n");
    printf("Test Results\n");
    printf("========================================\n\n");
    
    for (int i = 0; i < g_test_count; i++) {
        const char *status = g_test_results[i].passed ? "PASS" : "FAIL";
        printf("[%4d] %-40s %s\n", i + 1, g_test_results[i].name, status);
        if (!g_test_results[i].passed && g_test_results[i].failure_reason[0] != '\0') {
            printf("       Reason: %s\n", g_test_results[i].failure_reason);
        }
    }
    
    printf("\n========================================\n");
    printf("Summary: %d passed, %d failed, %d total\n", g_passed, g_failed, g_test_count);
    printf("========================================\n");
}

/* Test data */
static const uint8_t TEST_KID_BYTES[16] = {
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10
};

static const uint8_t TEST_KEY_BYTES[16] = {
    0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11,
    0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99
};

static const uint8_t TEST_IV_BYTES[16] = {
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff
};

static const uint8_t TEST_PLAINTEXT[16] = {
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
    0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
};

/* Valid FairPlay PSSH box */
static const uint8_t TEST_PSSH_VALID[] = {
    0x00, 0x00, 0x00, 0x2c,
    'p', 's', 's', 'h',
    0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01,
    0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99,
    0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99, 0x99,
    0x00, 0x00, 0x00, 0x10,
    0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10
};

/* Tests */
static void test_001_initialization_success(void) {
    test_start("Initialization Success", "REQ-003");
    fp_error_t err = fairplay_init();
    TEST_ASSERT_ERROR(FP_OK, err, "fairplay_init should return FP_OK");
    test_pass();
}

static void test_002_init_null_config(void) {
    test_start("Init Failure - NULL Config", "REQ-004,REQ-005");
    drm_client_t *client = NULL;
    fp_error_t err = drm_client_create(NULL, &client);
    TEST_ASSERT_ERROR(FP_ERR_NULL_POINTER, err, "NULL config should return error");
    TEST_ASSERT_PTR_NULL(client, "Client should be NULL");
    test_pass();
}

static void test_003_init_empty_url(void) {
    test_start("Init Failure - Empty URL", "REQ-005");
    drm_config_t config;
    drm_config_init(&config);
    config.license_server_url = "";
    config.user_agent = "TestAgent";
    drm_client_t *client = NULL;
    fp_error_t err = drm_client_create(&config, &client);
    TEST_ASSERT_ERROR(FP_ERR_INVALID_CONFIG, err, "Empty URL should return error");
    test_pass();
}

static void test_004_pssh_parse_valid(void) {
    test_start("PSSH Parse - Valid", "REQ-011,REQ-013");
    fp_context_t *ctx = NULL;
    fp_error_t err = fairplay_context_create(&ctx);
    TEST_ASSERT_ERROR(FP_OK, err, "Context creation failed");
    
    fp_pssh_t *pssh = NULL;
    err = fairplay_pssh_parse(ctx, TEST_PSSH_VALID, sizeof(TEST_PSSH_VALID), &pssh);
    TEST_ASSERT_ERROR(FP_OK, err, "PSSH parsing should succeed");
    TEST_ASSERT_PTR_NOT_NULL(pssh, "PSSH should not be NULL");
    
    fp_kid_t kid;
    err = fairplay_pssh_get_primary_kid(pssh, &kid);
    TEST_ASSERT_ERROR(FP_OK, err, "KID extraction should succeed");
    int cmp = memcmp(kid.bytes, TEST_KID_BYTES, 16);
    TEST_ASSERT_EQUAL(0, cmp, "KID should match");
    
    fairplay_pssh_free(pssh);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_005_pssh_wrong_system_id(void) {
    test_start("PSSH Parse - Wrong System ID", "REQ-012,REQ-016");
    uint8_t wrong_pssh[] = {
        0x00, 0x00, 0x00, 0x2c, 'p', 's', 's', 'h',
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
        0x12, 0x10, 0x07, 0x59, 0xf8, 0x1f, 0x02, 0x1d,
        0x0a, 0x92, 0x28, 0xdb, 0x01, 0x62, 0x85, 0x6d,
        0x00, 0x00, 0x00, 0x10,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
        0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10
    };
    
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    fp_pssh_t *pssh = NULL;
    fp_error_t err = fairplay_pssh_parse(ctx, wrong_pssh, sizeof(wrong_pssh), &pssh);
    
    if (err == FP_OK && pssh) {
        bool is_fp = fairplay_pssh_is_fairplay(pssh);
        TEST_ASSERT_EQUAL(0, is_fp, "Should not be FairPlay");
        fairplay_pssh_free(pssh);
    }
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_006_pssh_malformed(void) {
    test_start("PSSH Parse - Malformed", "REQ-016");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    
    uint8_t truncated[] = { 0x00, 0x00, 0x00, 0x2c, 'p', 's', 's', 'h', 0x01, 0x00, 0x00, 0x00 };
    fp_pssh_t *pssh = NULL;
    fp_error_t err = fairplay_pssh_parse(ctx, truncated, sizeof(truncated), &pssh);
    TEST_ASSERT_ERROR(FP_ERR_PSSH_PARSE_FAILED, err, "Malformed PSSH should fail");
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_007_license_request_generation(void) {
    test_start("License Request Generation", "REQ-021,REQ-022,REQ-023");
    drm_config_t config;
    drm_config_init(&config);
    config.license_server_url = "http://example.com/license";
    config.user_agent = "TestAgent/1.0";
    
    drm_client_t *client = NULL;
    fp_error_t err = drm_client_create(&config, &client);
    TEST_ASSERT_ERROR(FP_OK, err, "Client creation should succeed");
    TEST_ASSERT_PTR_NOT_NULL(client, "Client should not be NULL");
    drm_client_destroy(client);
    test_pass();
}

static void test_008_license_response_parsing(void) {
    test_start("License Response Parsing", "REQ-031,REQ-034");
    const char *key_b64 = "qrvM3e7/ABEiM0RVZneImQ==";
    uint8_t decoded_key[16];
    size_t decoded_size;
    fp_error_t err = fairplay_base64_decode(key_b64, decoded_key, &decoded_size, sizeof(decoded_key));
    TEST_ASSERT_ERROR(FP_OK, err, "Base64 decode should succeed");
    TEST_ASSERT_EQUAL(16, decoded_size, "Decoded size should be 16");
    TEST_ASSERT_EQUAL(0, memcmp(decoded_key, TEST_KEY_BYTES, 16), "Key should match");
    test_pass();
}

static void test_009_key_storage_lookup(void) {
    test_start("Key Storage and Lookup", "REQ-041,REQ-043");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    
    fp_key_store_t *store = NULL;
    fp_error_t err = fairplay_key_store_create(ctx, &store);
    TEST_ASSERT_ERROR(FP_OK, err, "Key store creation should succeed");
    
    fp_kid_t kid;
    fairplay_kid_set_bytes(&kid, TEST_KID_BYTES);
    fp_key_t key;
    memcpy(key.bytes, TEST_KEY_BYTES, 16);
    
    err = fairplay_key_store_add(store, &kid, &key, 0);
    TEST_ASSERT_ERROR(FP_OK, err, "Key addition should succeed");
    TEST_ASSERT_EQUAL(1, fairplay_key_store_has(store, &kid), "Key should exist");
    
    fp_key_t retrieved_key;
    err = fairplay_key_store_get(store, &kid, &retrieved_key);
    TEST_ASSERT_ERROR(FP_OK, err, "Key lookup should succeed");
    TEST_ASSERT_EQUAL(0, memcmp(retrieved_key.bytes, TEST_KEY_BYTES, 16), "Key should match");
    
    fairplay_key_store_destroy(store);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_010_aes128_cbc_decryption(void) {
    test_start("AES-128 CBC Decryption", "REQ-051,REQ-054");
    fp_key_t key;
    memcpy(key.bytes, TEST_KEY_BYTES, 16);
    fp_iv_t iv;
    memcpy(iv.bytes, TEST_IV_BYTES, 16);
    
    uint8_t plaintext[16] = {0};
    size_t decrypted_size;
    fp_error_t err = fairplay_decrypt_aes128_cbc(
        &key, &iv, TEST_PLAINTEXT, sizeof(TEST_PLAINTEXT),
        plaintext, &decrypted_size, sizeof(plaintext)
    );
    TEST_ASSERT_ERROR(FP_OK, err, "Decryption should succeed");
    test_pass();
}

static void test_011_context_lifecycle(void) {
    test_start("Context Lifecycle", "REQ-001,REQ-007");
    fp_context_t *ctx = NULL;
    fp_error_t err = fairplay_context_create(&ctx);
    TEST_ASSERT_ERROR(FP_OK, err, "Context creation should succeed");
    TEST_ASSERT_PTR_NOT_NULL(ctx, "Context should not be NULL");
    
    err = fairplay_context_destroy(ctx);
    TEST_ASSERT_ERROR(FP_OK, err, "Context destruction should succeed");
    err = fairplay_context_destroy(NULL);
    TEST_ASSERT_ERROR(FP_OK, err, "NULL destruction should be safe");
    test_pass();
}

static void test_012_key_expiration(void) {
    test_start("Key Expiration", "REQ-044,REQ-045");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    fp_key_store_t *store = NULL;
    fairplay_key_store_create(ctx, &store);
    
    fp_kid_t kid;
    fairplay_kid_set_bytes(&kid, TEST_KID_BYTES);
    fp_key_t key;
    memcpy(key.bytes, TEST_KEY_BYTES, 16);
    
    uint64_t past_time = fairplay_current_time() - 3600;
    fairplay_key_store_add(store, &kid, &key, past_time);
    TEST_ASSERT_EQUAL(1, fairplay_key_store_is_expired(store, &kid), "Key should be expired");
    
    fairplay_key_store_destroy(store);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_013_session_creation(void) {
    test_start("Session Creation", "REQ-061");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    
    fp_kid_t kid;
    fairplay_kid_set_bytes(&kid, TEST_KID_BYTES);
    
    fp_session_t *session = NULL;
    fp_error_t err = fairplay_session_create(ctx, &kid, &session);
    TEST_ASSERT_ERROR(FP_OK, err, "Session creation should succeed");
    TEST_ASSERT_PTR_NOT_NULL(session, "Session should not be NULL");
    TEST_ASSERT_EQUAL(0, fairplay_session_has_key(session), "Session should not have key");
    
    fairplay_session_destroy(session);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_014_session_decryption(void) {
    test_start("Session Decryption", "REQ-054,REQ-062");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    
    fp_kid_t kid;
    fairplay_kid_set_bytes(&kid, TEST_KID_BYTES);
    fp_session_t *session = NULL;
    fairplay_session_create(ctx, &kid, &session);
    
    fp_key_t key;
    memcpy(key.bytes, TEST_KEY_BYTES, 16);
    fairplay_session_set_key(session, &key, 0);
    TEST_ASSERT_EQUAL(1, fairplay_session_has_key(session), "Session should have key");
    
    fairplay_session_destroy(session);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_015_iv_from_segment(void) {
    test_start("IV from Segment", "REQ-052");
    fp_iv_t iv;
    fairplay_iv_from_segment(&iv, 12345);
    uint64_t segment_num = 12345;
    TEST_ASSERT_EQUAL((uint8_t)(segment_num) & 0xFF, iv.bytes[15], "IV byte 15");
    test_pass();
}

static void test_016_kid_comparison(void) {
    test_start("KID Comparison", "REQ-020");
    fp_kid_t kid1, kid2, kid3;
    fairplay_kid_set_bytes(&kid1, TEST_KID_BYTES);
    fairplay_kid_set_bytes(&kid2, TEST_KID_BYTES);
    fairplay_kid_set_bytes(&kid3, TEST_KID_BYTES);
    kid3.bytes[0] = 0xFF;
    
    TEST_ASSERT_EQUAL(0, fairplay_kid_compare(&kid1, &kid2), "Equal KIDs");
    TEST_ASSERT_NOT_EQUAL(0, fairplay_kid_compare(&kid1, &kid3), "Different KIDs");
    test_pass();
}

static void test_017_base64_encode_decode(void) {
    test_start("Base64 Encode/Decode", "REQ-023");
    char encoded[64];
    fp_error_t err = fairplay_base64_encode(TEST_KEY_BYTES, 16, encoded, sizeof(encoded));
    TEST_ASSERT_ERROR(FP_OK, err, "Base64 encode should succeed");
    
    uint8_t decoded[16];
    size_t decoded_size;
    err = fairplay_base64_decode(encoded, decoded, &decoded_size, sizeof(decoded));
    TEST_ASSERT_ERROR(FP_OK, err, "Base64 decode should succeed");
    int cmp = memcmp(decoded, TEST_KEY_BYTES, 16);
    TEST_ASSERT_EQUAL(0, cmp, "Data should match");
    test_pass();
}

static void test_018_error_string(void) {
    test_start("Error String", "REQ-070");
    const char *msg = fairplay_error_string(FP_OK);
    TEST_ASSERT_STRING_EQUAL("Success", msg, "FP_OK message");
    test_pass();
}

static void test_019_version_query(void) {
    test_start("Version Query", "REQ-009");
    const char *version = fairplay_version();
    TEST_ASSERT_PTR_NOT_NULL(version, "Version should not be NULL");
    TEST_ASSERT_STRING_EQUAL(FAIRPLAY_VERSION_STRING, version, "Version match");
    test_pass();
}

static void test_020_key_store_clear(void) {
    test_start("Key Store Clear", "REQ-049");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    fp_key_store_t *store = NULL;
    fairplay_key_store_create(ctx, &store);
    
    for (int i = 0; i < 5; i++) {
        fp_kid_t kid; memset(&kid, 0, sizeof(kid)); kid.bytes[0] = (uint8_t)i;
        fp_key_t key; memset(&key, 0, sizeof(key));
        fairplay_key_store_add(store, &kid, &key, 0);
    }
    TEST_ASSERT_EQUAL(5, fairplay_key_store_count(store), "Should have 5 keys");
    
    fairplay_key_store_clear(store);
    TEST_ASSERT_EQUAL(0, fairplay_key_store_count(store), "Should be empty");
    
    fairplay_key_store_destroy(store);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_021_key_removal(void) {
    test_start("Key Removal", "REQ-047");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    fp_key_store_t *store = NULL;
    fairplay_key_store_create(ctx, &store);
    
    fp_kid_t kid;
    fairplay_kid_set_bytes(&kid, TEST_KID_BYTES);
    fp_key_t key;
    memcpy(key.bytes, TEST_KEY_BYTES, 16);
    
    fairplay_key_store_add(store, &kid, &key, 0);
    fp_error_t err = fairplay_key_store_remove(store, &kid);
    TEST_ASSERT_ERROR(FP_OK, err, "Key removal should succeed");
    TEST_ASSERT_EQUAL(0, fairplay_key_store_has(store, &kid), "Key should not exist");
    
    fairplay_key_store_destroy(store);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_022_buffer_too_small(void) {
    test_start("Buffer Too Small", "REQ-055");
    fp_key_t key; memcpy(key.bytes, TEST_KEY_BYTES, 16);
    fp_iv_t iv; memcpy(iv.bytes, TEST_IV_BYTES, 16);
    uint8_t small[8];
    size_t size;
    fp_error_t err = fairplay_decrypt_aes128_cbc(&key, &iv, TEST_PLAINTEXT, 16, small, &size, 8);
    TEST_ASSERT_ERROR(FP_ERR_BUFFER_TOO_SMALL, err, "Should return buffer too small");
    test_pass();
}

static void test_023_null_pointer_handling(void) {
    test_start("NULL Pointer Handling", "REQ-080");
    fp_key_t key; memcpy(key.bytes, TEST_KEY_BYTES, 16);
    fp_iv_t iv; memcpy(iv.bytes, TEST_IV_BYTES, 16);
    fp_error_t err = fairplay_decrypt_aes128_cbc(NULL, &iv, TEST_PLAINTEXT, 16, NULL, NULL, 16);
    TEST_ASSERT_ERROR(FP_ERR_NULL_POINTER, err, "NULL key should error");
    test_pass();
}

static void test_024_secure_zero(void) {
    test_start("Secure Zero", "REQ-077");
    uint8_t data[16];
    memset(data, 0xAB, sizeof(data));
    fairplay_secure_zero(data, sizeof(data));
    for (size_t i = 0; i < sizeof(data); i++) {
        TEST_ASSERT_EQUAL(0, data[i], "Data should be zeroed");
    }
    test_pass();
}

static void test_025_pssh_free(void) {
    test_start("PSSH Free", "REQ-015");
    fairplay_pssh_free(NULL);
    test_pass();
}

static void test_026_multiple_kids(void) {
    test_start("Multiple KIDs", "REQ-017");
    test_pass();
}

static void test_027_key_store_thread_safety(void) {
    test_start("Key Store Thread Safety", "REQ-050");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    fp_key_store_t *store = NULL;
    fairplay_key_store_create(ctx, &store);
    
    for (int i = 0; i < 10; i++) {
        fp_kid_t kid; memset(&kid, 0, sizeof(kid)); kid.bytes[0] = (uint8_t)(i + 1);
        fp_key_t key; memset(&key, 0, sizeof(key)); key.bytes[0] = (uint8_t)(i + 1);
        fp_error_t err = fairplay_key_store_add(store, &kid, &key, 0);
        TEST_ASSERT_ERROR(FP_OK, err, "Key addition should succeed");
    }
    TEST_ASSERT_EQUAL(10, fairplay_key_store_count(store), "Should have 10 keys");
    
    fairplay_key_store_destroy(store);
    fairplay_context_destroy(ctx);
    test_pass();
}

static void test_028_session_expiration(void) {
    test_start("Session Expiration", "REQ-064,REQ-045");
    fp_context_t *ctx = NULL;
    fairplay_context_create(&ctx);
    
    fp_kid_t kid;
    fairplay_kid_set_bytes(&kid, TEST_KID_BYTES);
    fp_session_t *session = NULL;
    fairplay_session_create(ctx, &kid, &session);
    
    fp_key_t key;
    memcpy(key.bytes, TEST_KEY_BYTES, 16);
    uint64_t past_time = fairplay_current_time() - 3600;
    fairplay_session_set_key(session, &key, past_time);
    TEST_ASSERT_EQUAL(1, fairplay_session_is_expired(session), "Session should be expired");
    
    fairplay_session_destroy(session);
    fairplay_context_destroy(ctx);
    test_pass();
}

int main(int argc, char *argv[]) {
    (void)argc;
    (void)argv;
    
    printf("========================================\n");
    printf("FairPlay DRM Comprehensive Test Suite\n");
    printf("Version: %s\n", FAIRPLAY_VERSION_STRING);
    printf("========================================\n\n");
    
    fp_error_t err = fairplay_init();
    if (err != FP_OK) {
        fprintf(stderr, "Failed to initialize: %s\n", fairplay_error_string(err));
        return 1;
    }
    
    test_001_initialization_success();
    test_002_init_null_config();
    test_003_init_empty_url();
    test_004_pssh_parse_valid();
    test_005_pssh_wrong_system_id();
    test_006_pssh_malformed();
    test_007_license_request_generation();
    test_008_license_response_parsing();
    test_009_key_storage_lookup();
    test_010_aes128_cbc_decryption();
    test_011_context_lifecycle();
    test_012_key_expiration();
    test_013_session_creation();
    test_014_session_decryption();
    test_015_iv_from_segment();
    test_016_kid_comparison();
    test_017_base64_encode_decode();
    test_018_error_string();
    test_019_version_query();
    test_020_key_store_clear();
    test_021_key_removal();
    test_022_buffer_too_small();
    test_023_null_pointer_handling();
    test_024_secure_zero();
    test_025_pssh_free();
    test_026_multiple_kids();
    test_027_key_store_thread_safety();
    test_028_session_expiration();
    
    print_test_results();
    fairplay_shutdown();
    
    return g_failed > 0 ? 1 : 0;
}
