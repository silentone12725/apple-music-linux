/*
 * test_fp_exchange.c - FairPlay License Exchange Test Suite
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Tests for the license exchange modules (T1-T11 from CORRECTION_PROMPT_v1.2.md)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include "fairplay.h"
#include "fairplay_device.h"
#include "fp_spc_builder.h"
#include "fp_ckc_parser.h"
#include "fp_key_unwrapper.h"
#include <openssl/evp.h>
#include "fp_http_client.h"
#include "fp_license_exchange.h"

/* =============================================================================
 * Test Infrastructure
 * ============================================================================= */

static int tests_run = 0;
static int tests_passed = 0;
static int tests_failed = 0;

#define TEST(name) do { \
    printf("=== Test: %s ===\n", name); \
    tests_run++; \
} while(0)

#define ASSERT(cond, msg) do { \
    if (!(cond)) { \
        printf("[FAIL] %s\n", msg); \
        tests_failed++; \
        return; \
    } \
} while(0)

#define ASSERT_PASS() do { \
    printf("[PASS] Test completed successfully\n"); \
    tests_passed++; \
    return; \
} while(0)

/* =============================================================================
 * Test T1: fp_ckc_parse on valid CKC blob
 * ============================================================================= */
static void test_t1_ckc_parse_valid(void) {
    TEST("CKC Parser - Valid Blob");
    
    /* Create a minimal valid CKC with proper big-endian values */
    uint8_t ckc_data[512] = {0};
    memcpy(ckc_data, "CKC\x01", 4);  /* Magic */
    ckc_data[4] = 0x00; ckc_data[5] = 0x00; ckc_data[6] = 0x00; ckc_data[7] = 0x01;  /* Version */
    ckc_data[8] = 0x00; ckc_data[9] = 0x00; ckc_data[10] = 0x00; ckc_data[11] = 0x01;  /* Flags */
    memset(ckc_data + 12, 0x41, 16);  /* KID = 0x41... */
    ckc_data[28] = 0x00; ckc_data[29] = 0x00; ckc_data[30] = 0x01; ckc_data[31] = 0x00;  /* Enc key len = 256 */
    memset(ckc_data + 32, 0xBB, 256);  /* Encrypted key */
    ckc_data[288] = 0x00; ckc_data[289] = 0x7F; ckc_data[290] = 0xFF; ckc_data[291] = 0xFF;
    ckc_data[292] = 0xFF; ckc_data[293] = 0xFF; ckc_data[294] = 0xFF; ckc_data[295] = 0xFF;  /* Expiry far future */
    
    fp_ckc_t ckc;
    fp_error_t err = fp_ckc_parse(ckc_data, sizeof(ckc_data), &ckc);
    
    ASSERT(err == FP_OK, "CKC parse failed");
    ASSERT(ckc.kid[0] == 0x41 && ckc.kid[15] == 0x41, "KID not parsed correctly");
    ASSERT(ckc.encrypted_key_size == 256, "Encrypted key size wrong");
    ASSERT(ckc.expires_at > (uint64_t)time(NULL), "Expiry not in future");
    
    fp_ckc_free(&ckc);
    ASSERT_PASS();
}

/* =============================================================================
 * Test T2: fp_ckc_parse on short data
 * ============================================================================= */
static void test_t2_ckc_parse_short(void) {
    TEST("CKC Parser - Short Data");
    
    uint8_t ckc_data[10] = {0};  /* Too short */
    
    fp_ckc_t ckc;
    fp_error_t err = fp_ckc_parse(ckc_data, sizeof(ckc_data), &ckc);
    
    ASSERT(err == FP_ERR_CKC_PARSE_FAILED, "Should fail on short data");
    
    fp_ckc_free(&ckc);
    ASSERT_PASS();
}

/* =============================================================================
 * Test T3: fp_unwrap_rsaes_oaep round-trip
 * ============================================================================= */
static void test_t3_key_unwrap(void) {
    TEST("Key Unwrapper - RSAES-OAEP");
    
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair = NULL;
    
    fairplay_device_context_create(&ctx);
    ASSERT(fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair) == FP_OK,
           "Key pair generation failed");
    
    /* Content key */
    uint8_t content_key[16] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                                0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10};
    
    /* Wrap */
    uint8_t *wrapped = NULL;
    size_t wrapped_size = 0;
    fp_error_t err = fairplay_key_wrap(content_key, 16, keypair->public_key, 
                                        keypair->public_key_size, FP_KEY_TYPE_RSA,
                                        &wrapped, &wrapped_size);
    ASSERT(err == FP_OK && wrapped != NULL, "Key wrap failed");
    
    /* Unwrap */
    uint8_t unwrapped[16];
    err = fp_unwrap_rsaes_oaep(wrapped, wrapped_size, keypair, unwrapped);
    ASSERT(err == FP_OK, "Key unwrap failed");
    ASSERT(memcmp(content_key, unwrapped, 16) == 0, "Unwrapped key mismatch");
    
    free(wrapped);
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    ASSERT_PASS();
}

/* =============================================================================
 * Test T4: fp_verify_content_key rejects all-zero and all-0xFF
 * ============================================================================= */
static void test_t4_verify_content_key(void) {
    TEST("Content Key Verification");
    
    uint8_t all_zero[16] = {0};
    uint8_t all_ff[16] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
    uint8_t valid_key[16] = {0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
                             0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10};
    
    ASSERT(fp_verify_content_key(all_zero) == false, "Should reject all-zero key");
    ASSERT(fp_verify_content_key(all_ff) == false, "Should reject all-0xFF key");
    ASSERT(fp_verify_content_key(valid_key) == true, "Should accept valid key");
    
    ASSERT_PASS();
}

/* =============================================================================
 * Test T5: fp_spc_build returns valid SPC
 * ============================================================================= */
static void test_t5_spc_build(void) {
    TEST("SPC Builder - Build SPC");
    
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair = NULL;
    
    fairplay_device_context_create(&ctx);
    ASSERT(fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair) == FP_OK,
           "Key pair generation failed");
    
    uint8_t kid[16] = {0};
    uint8_t *spc = NULL;
    size_t spc_size = 0;
    
    fp_error_t err = fp_spc_build(keypair, kid, "test_token", "https://test.com", &spc, &spc_size);
    ASSERT(err == FP_OK, "SPC build failed");
    ASSERT(spc != NULL, "SPC is NULL");
    ASSERT(spc_size > 100, "SPC size too small");
    
    fp_spc_free(spc, spc_size);
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    ASSERT_PASS();
}

/* =============================================================================
 * Test T6: fp_spc_verify accepts SPC from fp_spc_build (D5 fix)
 * ============================================================================= */
static void test_t6_spc_verify(void) {
    TEST("SPC Verify - Self Verification (D5)");
    
    fp_device_context_t *ctx = NULL;
    fp_key_pair_t *keypair = NULL;
    
    fairplay_device_context_create(&ctx);
    ASSERT(fairplay_keypair_generate_rsa(ctx, 2048, FP_KEY_FORMAT_PEM, &keypair) == FP_OK,
           "Key pair generation failed");
    
    uint8_t kid[16] = {0};
    uint8_t *spc = NULL;
    size_t spc_size = 0;
    
    fp_error_t err = fp_spc_build(keypair, kid, "test_token", "https://test.com", &spc, &spc_size);
    ASSERT(err == FP_OK, "SPC build failed");
    
    /* Verify with public key */
    err = fp_spc_verify(spc, spc_size, keypair->public_key, keypair->public_key_size);
    ASSERT(err == FP_OK, "SPC verify failed (D5 not fixed)");
    
    fp_spc_free(spc, spc_size);
    fairplay_keypair_free(keypair);
    fairplay_device_context_destroy(ctx);
    ASSERT_PASS();
}

/* =============================================================================
 * Test T7: fp_is_key_context_expired with future expiry (D1 fix)
 * ============================================================================= */
static void test_t7_key_context_expiry(void) {
    TEST("Key Context Expiry (D1)");
    
    drm_key_context_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    
    /* Set expiry far in future */
    ctx.expires_at = UINT64_MAX;
    
    ASSERT(fp_is_key_context_expired(&ctx) == false, "Should not be expired (D1 not fixed)");
    
    /* Set expiry in past */
    ctx.expires_at = 1;  /* Unix epoch */
    ASSERT(fp_is_key_context_expired(&ctx) == true, "Should be expired");
    
    ASSERT_PASS();
}

/* =============================================================================
 * Test T8: fp_derive_sample_iv with sample number 1
 * ============================================================================= */
static void test_t8_derive_iv_simple(void) {
    TEST("IV Derivation - Simple (T8)");
    
    drm_key_context_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    
    uint8_t out_iv[16];
    fp_derive_sample_iv(&ctx, 1, out_iv);
    
    /* Base IV is all zeros, sample number 1 should give 0x...0001 */
    ASSERT(out_iv[15] == 0x01, "Last byte should be 0x01");
    ASSERT(out_iv[0] == 0x00, "First byte should be 0x00");
    
    ASSERT_PASS();
}

/* =============================================================================
 * Test T9: fp_derive_sample_iv carry propagation (D3 fix)
 * ============================================================================= */
static void test_t9_derive_iv_carry(void) {
    TEST("IV Derivation - Carry Propagation (D3)");
    
    drm_key_context_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    
    /* Set base IV to 0x...01 */
    ctx.base_iv[15] = 0x01;
    
    uint8_t out_iv[16];
    uint64_t sample_num = 0xFF;  /* Add 0xFF */
    fp_derive_sample_iv(&ctx, sample_num, out_iv);
    
    /* 0x01 + 0xFF = 0x100, so last byte should be 0x00 and byte 14 should be 0x01 */
    ASSERT(out_iv[15] == 0x00, "Last byte should be 0x00 (D3 not fixed)");
    ASSERT(out_iv[14] == 0x01, "Second-to-last byte should be 0x01 (D3 not fixed)");
    
    ASSERT_PASS();
}

/* =============================================================================
 * Test T10: fp_decrypt_sample AES-128-CBC round-trip (D2 fix)
 * ============================================================================= */
static void test_t10_decrypt_cbc(void) {
    TEST("Decrypt Sample - AES-128-CBC (D2)");
    
    /* Test key and IV */
    uint8_t key[16] = {0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
                       0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F};
    uint8_t iv[16] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
    uint8_t plaintext[16] = {0x48, 0x65, 0x6C, 0x6C, 0x6F, 0x20, 0x57, 0x6F,
                             0x72, 0x6C, 0x64, 0x21, 0x21, 0x21, 0x21, 0x21};  /* "Hello World!!!!" */
    
    /* Encrypt with AES-128-CBC */
    EVP_CIPHER_CTX *ctx_enc = EVP_CIPHER_CTX_new();
    ASSERT(ctx_enc != NULL, "Failed to create cipher context");
    
    ASSERT(EVP_EncryptInit_ex(ctx_enc, EVP_aes_128_cbc(), NULL, key, iv) == 1,
           "Failed to init encryption");
    
    uint8_t ciphertext[32];
    int out_len = 0;
    ASSERT(EVP_EncryptUpdate(ctx_enc, ciphertext, &out_len, plaintext, 16) == 1,
           "Failed to encrypt");
    
    int final_len = 0;
    uint8_t final_block[16];
    ASSERT(EVP_EncryptFinal_ex(ctx_enc, final_block, &final_len) == 1,
           "Failed to finalize encryption");
    
    /* Combine ciphertext and final block */
    uint8_t full_ciphertext[32];
    memcpy(full_ciphertext, ciphertext, out_len);
    memcpy(full_ciphertext + out_len, final_block, final_len);
    int total_len = out_len + final_len;
    
    EVP_CIPHER_CTX_free(ctx_enc);
    
    /* Now decrypt using fp_decrypt_sample */
    drm_key_context_t ctx;
    memset(&ctx, 0, sizeof(ctx));
    memcpy(ctx.aes_key, key, 16);
    memcpy(ctx.base_iv, iv, 16);
    
    uint8_t decrypted[32];
    fp_error_t err = fp_decrypt_sample(&ctx, 0, full_ciphertext, total_len, decrypted);
    ASSERT(err == FP_OK, "fp_decrypt_sample failed (D2 not fixed)");
    
    /* Compare (ignoring PKCS#7 padding) */
    ASSERT(memcmp(decrypted, plaintext, 16) == 0, "Decrypted plaintext mismatch (D2 not fixed)");
    
    ASSERT_PASS();
}

/* =============================================================================
 * Test T11: extract_kid_from_uri returns error for HTTPS URI (D4 fix)
 * ============================================================================= */
static void test_t11_kid_extract_error(void) {
    TEST("KID Extraction - HTTPS URI Error (D4)");
    
    /* Use fp_acquire_content_key with a plain HTTPS URI */
    drm_key_context_t *ctx = NULL;
    fp_error_t err = fp_acquire_content_key(
        "/tmp/test_drm_nonexistent",
        "https://example.com/playlist.m3u8",  /* Not skd:// */
        "test_token",
        "143441",
        &ctx
    );
    
    /* Should return an error, not FP_OK with garbage KID */
    ASSERT(err != FP_OK, "Should return error for HTTPS URI (D4 not fixed)");
    
    if (ctx) fp_free_key_context(ctx);
    ASSERT_PASS();
}

/* =============================================================================
 * Main
 * ============================================================================= */

int main(void) {
    printf("=== FairPlay License Exchange Tests ===\n\n");
    
    fairplay_init();
    
    test_t1_ckc_parse_valid();
    test_t2_ckc_parse_short();
    test_t3_key_unwrap();
    test_t4_verify_content_key();
    test_t5_spc_build();
    test_t6_spc_verify();
    test_t7_key_context_expiry();
    test_t8_derive_iv_simple();
    test_t9_derive_iv_carry();
    test_t10_decrypt_cbc();
    test_t11_kid_extract_error();
    
    fairplay_shutdown();
    
    printf("\n=== Summary ===\n");
    printf("Tests run:   %d\n", tests_run);
    printf("Passed:      %d\n", tests_passed);
    printf("Failed:      %d\n", tests_failed);
    
    return tests_failed > 0 ? 1 : 0;
}
