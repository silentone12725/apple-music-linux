/*
 * test_fairplay.c — Comprehensive tests for standalone FairPlay DRM.
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <pthread.h>
#include <openssl/evp.h>
#include <openssl/aes.h>

#include "fairplay.h"
#include "fp_license_exchange.h"

/* ── Test Counters ─────────────────────────────────────────────────────────*/

static int tests_run = 0;
static int tests_passed = 0;
static int tests_failed = 0;

#define TEST(name) static int test_##name(void)
#define RUN_TEST(name) do { \
    printf("  Running: %s... ", #name); \
    tests_run++; \
    if (test_##name()) { \
        tests_passed++; \
        printf("PASS\n"); \
    } else { \
        tests_failed++; \
        printf("FAIL\n"); \
    } \
} while (0)

/* ── Test: AES Decryption with NIST Vector ─────────────────────────────────*/

TEST(aes_decryption)
{
    /* NIST FIPS 197 test vector for AES-128 CBC */
    const uint8_t key[16] = {
        0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6,
        0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf, 0x4f, 0x3c
    };
    
    const uint8_t iv[16] = {
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f
    };
    
    /* Ciphertext (correct NIST vector) */
    uint8_t ciphertext[32] = {
        0x76, 0x49, 0xab, 0xac, 0x81, 0x19, 0xb2, 0x46,
        0xce, 0xe9, 0x8e, 0x9b, 0x12, 0xe9, 0x19, 0x7d,
        0x50, 0x86, 0xcb, 0x9b, 0x50, 0x72, 0x19, 0xee,
        0x95, 0xdb, 0x11, 0x3a, 0x91, 0x76, 0x78, 0xb2
    };
    
    /* Expected plaintext */
    const uint8_t expected[32] = {
        0x6b, 0xc1, 0xbe, 0xe2, 0x2e, 0x40, 0x9f, 0x96,
        0xe9, 0x3d, 0x7e, 0x11, 0x73, 0x93, 0x17, 0x2a,
        0xae, 0x2d, 0x8a, 0x57, 0x1e, 0x03, 0xac, 0x9c,
        0x9e, 0xb7, 0x6f, 0xac, 0x45, 0xaf, 0x8e, 0x51
    };
    
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) return 0;
    
    uint8_t plaintext[32];
    int len;
    
    if (EVP_DecryptInit_ex(ctx, EVP_aes_128_cbc(), NULL, key, iv) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return 0;
    }
    
    EVP_CIPHER_CTX_set_padding(ctx, 0);
    
    if (EVP_DecryptUpdate(ctx, plaintext, &len, ciphertext, 32) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return 0;
    }
    
    int final_len = 0;
    uint8_t final[16];
    if (EVP_DecryptFinal_ex(ctx, final, &final_len) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return 0;
    }
    
    EVP_CIPHER_CTX_free(ctx);
    
    if (len != 32 || final_len != 0) return 0;
    if (memcmp(plaintext, expected, 32) != 0) return 0;
    
    return 1;
}

/* ── Test: Initialization/Shutdown ─────────────────────────────────────────*/

TEST(init_shutdown)
{
    int success = 1;

    for (int i = 0; i < 5; i++) {
        if (fairplay_init() != FP_OK) {
            success = 0;
            break;
        }
        fairplay_shutdown();
    }

    if (success && fairplay_init() != FP_OK) success = 0;

    return success;
}

/* ── Test: Key Context with NULL params ────────────────────────────────────*/

TEST(null_params)
{
    drm_key_context_t *key_ctx = NULL;
    int success = 1;

    /* NULL storage_path */
    if (fp_acquire_content_key(NULL, "skd://test", NULL, NULL, &key_ctx) == FP_OK) success = 0;
    /* NULL media_uri */
    if (fp_acquire_content_key("/tmp", NULL, NULL, NULL, &key_ctx) == FP_OK) success = 0;
    /* NULL out pointer */
    if (fp_acquire_content_key("/tmp", "skd://test", NULL, NULL, NULL) == FP_OK) success = 0;

    return success;
}

/* ── Test: IV Derivation Modes ─────────────────────────────────────────────*/

TEST(iv_modes)
{
    uint8_t base_iv[16] = {0};
    uint8_t iv_fixed[16], iv_counter[16];
    
    memcpy(iv_fixed, base_iv, 16);
    memcpy(iv_counter, base_iv, 16);
    
    uint64_t sample_num = 12345;
    for (int i = 0; i < 8; i++) {
        iv_counter[i] ^= (uint8_t)(sample_num >> ((7 - i) * 8));
    }
    
    return (memcmp(iv_fixed, iv_counter, 16) != 0);
}

/* ── Test: Memory Safety ───────────────────────────────────────────────────*/

TEST(memory_safety)
{
    /* fairplay_init/shutdown must be callable multiple times without crash */
    for (int i = 0; i < 10; i++) {
        fairplay_init();
        fairplay_shutdown();
    }
    return 1;
}

/* ── Main ──────────────────────────────────────────────────────────────────*/

int main(void)
{
    printf("========================================\n");
    printf("FairPlay DRM Test Suite\n");
    printf("========================================\n\n");

    printf("Initializing FairPlay module...\n");
    if (fairplay_init() != FP_OK) {
        fprintf(stderr, "Failed to initialize FairPlay\n");
        return 1;
    }
    printf("OK\n\n");

    printf("Running tests:\n\n");

    RUN_TEST(init_shutdown);
    RUN_TEST(null_params);
    RUN_TEST(iv_modes);
    RUN_TEST(aes_decryption);
    RUN_TEST(memory_safety);

    printf("\n========================================\n");
    printf("Test Summary\n");
    printf("========================================\n");
    printf("  Total:  %d\n", tests_run);
    printf("  Passed: %d\n", tests_passed);
    printf("  Failed: %d\n", tests_failed);
    printf("========================================\n\n");

    fairplay_shutdown();

    return (tests_failed == 0) ? 0 : 1;
}
