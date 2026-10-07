/*
 * fairplay_device.c - FairPlay Device Certificate & ID Generation Implementation
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay device certificate and ID generation.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/FAIRPLAY_DEVICE_CERT_SPEC.md v1.0
 */

#define _POSIX_C_SOURCE 200809L

#include "fairplay_device.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>

#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/rsa.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/pem.h>
#include <openssl/x509.h>
#include <openssl/x509_vfy.h>
#include <openssl/err.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

/* =============================================================================
 * Internal Constants
 * ============================================================================= */

#define FP_DEVICE_ID_FILE "device_id"
#define FP_PRIVATE_KEY_FILE "device_key.pem"
#define FP_PUBLIC_KEY_FILE "device_key_pub.pem"
#define FP_CERTIFICATE_FILE "device_cert.pem"

/* =============================================================================
 * Internal Data Structures
 * ============================================================================= */

struct fp_device_context {
    int refcount;
};

/* =============================================================================
 * Helper Functions
 * ============================================================================= */

static void fp_device_secure_zero(void *ptr, size_t size) {
    volatile uint8_t *p = (volatile uint8_t *)ptr;
    while (size--) {
        *p++ = 0;
    }
}

/* Secure file deletion: zero contents before unlink (REQ-014 enhancement) */
static fp_error_t fp_device_secure_delete(const char *file_path) {
    struct stat st;
    if (stat(file_path, &st) != 0) {
        return FP_OK;  /* File doesn't exist, nothing to delete */
    }
    
    /* Zero the file contents */
    int fd = open(file_path, O_WRONLY);
    if (fd >= 0) {
        off_t file_size = st.st_size;
        uint8_t *buf = malloc(file_size > 4096 ? 4096 : file_size);
        if (buf) {
            /* Zero in 4KB chunks */
            for (off_t offset = 0; offset < file_size; offset += 4096) {
                size_t chunk_size = file_size - offset < 4096 ? 
                                    (size_t)(file_size - offset) : 4096;
                fp_device_secure_zero(buf, chunk_size);
                lseek(fd, offset, SEEK_SET);
                write(fd, buf, chunk_size);
            }
            free(buf);
        }
        close(fd);
    }
    
    /* Unlink the file */
    if (unlink(file_path) != 0) {
        return FP_ERR_CREDENTIAL_RESET_FAILED;
    }
    
    return FP_OK;
}

/* Encrypt data using AES-256-GCM */
static fp_error_t fp_device_encrypt_aes256_gcm(
    uint8_t *plaintext, size_t plaintext_size,
    const char *password,
    uint8_t **out_ciphertext, size_t *out_ciphertext_size
) {
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Derive key from password using PBKDF2.
     * salt (16 bytes): PBKDF2 input salt — stored in output so decrypt can re-derive the key.
     * iv   (12 bytes): GCM nonce — separate random value, stored after salt. */
    uint8_t key[32];
    uint8_t salt[16];
    uint8_t iv[12];

    if (RAND_bytes(salt, 16) != 1 || RAND_bytes(iv, 12) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    if (PKCS5_PBKDF2_HMAC(password, (int)strlen(password),
                          salt, 16, 100000, EVP_sha256(), 32, key) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    /* Initialize GCM encryption */
    if (EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    /* GCM IV must be 12 bytes (96 bits) per NIST SP 800-38D recommendation */
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    if (EVP_EncryptInit_ex(ctx, NULL, NULL, key, iv) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    /* Wire format: [16 salt][12 iv][ciphertext][16 tag] */
    size_t out_size = 16 + 12 + plaintext_size + 16;
    uint8_t *out = malloc(out_size);
    if (!out) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_OUT_OF_MEMORY;
    }

    memcpy(out,      salt, 16);
    memcpy(out + 16, iv,   12);

    int len = 0;
    if (EVP_EncryptUpdate(ctx, out + 28, &len, plaintext, (int)plaintext_size) != 1) {
        free(out);
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    int final_len = 0;
    if (EVP_EncryptFinal_ex(ctx, out + 28 + len, &final_len) != 1) {
        free(out);
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    uint8_t tag[16];
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag) != 1) {
        free(out);
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_ENCRYPTION_FAILED;
    }

    memcpy(out + 28 + len + final_len, tag, 16);

    EVP_CIPHER_CTX_free(ctx);
    fp_device_secure_zero(key, 32);

    *out_ciphertext = out;
    *out_ciphertext_size = 28 + len + final_len + 16;

    return FP_OK;
}

/* Decrypt data using AES-256-GCM */
static fp_error_t fp_device_decrypt_aes256_gcm(
    const uint8_t *ciphertext, size_t ciphertext_size,
    const char *password,
    uint8_t **out_plaintext, size_t *out_plaintext_size
) {
    /* Wire format: [16 salt][12 iv][ciphertext][16 tag] — minimum 44 bytes */
    if (ciphertext_size < 44) {
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }

    const uint8_t *salt     = ciphertext;
    const uint8_t *iv       = ciphertext + 16;
    const uint8_t *data     = ciphertext + 28;
    const uint8_t *tag      = ciphertext + ciphertext_size - 16;
    size_t         data_size = ciphertext_size - 44;

    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) {
        return FP_ERR_OUT_OF_MEMORY;
    }

    /* Derive key from password using PBKDF2 */
    uint8_t key[32];
    if (PKCS5_PBKDF2_HMAC(password, (int)strlen(password),
                          salt, 16, 100000, EVP_sha256(), 32, key) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }

    /* Initialize GCM decryption */
    if (EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), NULL, NULL, NULL) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }

    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_IVLEN, 12, NULL) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }

    if (EVP_DecryptInit_ex(ctx, NULL, NULL, key, iv) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }

    /* Set tag for verification */
    if (EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, (void *)tag) != 1) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }
    
    /* Allocate output buffer */
    uint8_t *out = malloc(data_size + 16);
    if (!out) {
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    int len = 0;
    if (EVP_DecryptUpdate(ctx, out, &len, data, (int)data_size) != 1) {
        free(out);
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }
    
    int final_len = 0;
    if (EVP_DecryptFinal_ex(ctx, out + len, &final_len) != 1) {
        free(out);
        EVP_CIPHER_CTX_free(ctx);
        return FP_ERR_KEY_DECRYPTION_FAILED;
    }
    
    EVP_CIPHER_CTX_free(ctx);
    fp_device_secure_zero(key, 32);
    
    *out_plaintext = out;
    *out_plaintext_size = len + final_len;
    
    return FP_OK;
}

static fp_error_t fp_device_create_directory(const char *path) {
    struct stat st;
    
    /* Check if directory exists */
    if (stat(path, &st) == 0) {
        if (S_ISDIR(st.st_mode)) {
            return FP_OK;  /* Directory exists */
        }
        return FP_ERR_DEVICE_ID_STORAGE_FAILED;  /* Path exists but is not a directory */
    }
    
    /* Directory doesn't exist, create it */
    if (mkdir(path, 0700) != 0 && errno != EEXIST) {
        return FP_ERR_DEVICE_ID_STORAGE_FAILED;
    }
    
    return FP_OK;
}

static const char *fp_device_error_string_impl(fp_error_t error) {
    switch (error) {
        case FP_OK:                     return "Success";
        case FP_ERR_DEVICE_ID_GENERATION_FAILED:  return "Device ID generation failed";
        case FP_ERR_DEVICE_ID_STORAGE_FAILED:     return "Device ID storage failed";
        case FP_ERR_DEVICE_ID_NOT_FOUND:          return "Device ID not found";
        case FP_ERR_DEVICE_ID_INVALID_FORMAT:     return "Device ID invalid format";
        case FP_ERR_KEY_GENERATION_FAILED:        return "Key generation failed";
        case FP_ERR_INVALID_DEVICE_KEY_SIZE:      return "Invalid device key size";
        case FP_ERR_INVALID_CURVE:                return "Invalid curve";
        case FP_ERR_KEY_STORAGE_FAILED:           return "Key storage failed";
        case FP_ERR_KEY_ENCRYPTION_FAILED:        return "Key encryption failed";
        case FP_ERR_KEY_DECRYPTION_FAILED:        return "Key decryption failed";
        case FP_ERR_CERTIFICATE_SIGNING_FAILED:   return "Certificate signing failed";
        case FP_ERR_CERTIFICATE_STORAGE_FAILED:   return "Certificate storage failed";
        case FP_ERR_CERTIFICATE_INVALID_FORMAT:   return "Certificate invalid format";
        case FP_ERR_CERTIFICATE_INVALID_SIGNATURE:return "Certificate invalid signature";
        case FP_ERR_CERTIFICATE_EXPIRED:          return "Certificate expired";
        case FP_ERR_CERTIFICATE_NOT_YET_VALID:    return "Certificate not yet valid";
        case FP_ERR_CSR_SIGNING_FAILED:           return "CSR signing failed";
        case FP_ERR_INVALID_KEY:                  return "Invalid key";
        case FP_ERR_INVALID_PUBLIC_KEY:           return "Invalid public key";
        case FP_ERR_INVALID_PRIVATE_KEY:          return "Invalid private key";
        case FP_ERR_KEY_WRAPPING_FAILED:          return "Key wrapping failed";
        case FP_ERR_KEY_UNWRAPPING_FAILED:        return "Key unwrapping failed";
        case FP_ERR_KEY_ENCRYPTED:                return "Key encrypted";
        case FP_ERR_INVALID_PASSWORD:             return "Invalid password";
        case FP_ERR_CERTIFICATE_ENCODING_FAILED:  return "Certificate encoding failed";
        case FP_ERR_CREDENTIAL_RESET_FAILED:      return "Credential reset failed";
        case FP_ERR_DEVICE_NOT_INITIALIZED:       return "Device not initialized";
        case FP_ERR_DEVICE_ALREADY_INITIALIZED:   return "Device already initialized";
        default:                                  return fairplay_error_string(error);
    }
}

/* =============================================================================
 * Device Context Management
 * ============================================================================= */

fp_error_t fairplay_device_context_create(fp_device_context_t **out_ctx) {
    if (!out_ctx) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_device_context_t *ctx = calloc(1, sizeof(fp_device_context_t));
    if (!ctx) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    ctx->refcount = 1;
    *out_ctx = ctx;
    return FP_OK;
}

void fairplay_device_context_destroy(fp_device_context_t *ctx) {
    if (!ctx) return;
    
    ctx->refcount--;
    if (ctx->refcount <= 0) {
        fp_device_secure_zero(ctx, sizeof(fp_device_context_t));
        free(ctx);
    }
}

const char *fairplay_device_error_string(fp_error_t error) {
    return fp_device_error_string_impl(error);
}

/* =============================================================================
 * Device ID Functions (REQ-001, REQ-002, REQ-003)
 * ============================================================================= */

fp_error_t fairplay_device_id_generate(fp_device_context_t *ctx, fp_device_id_t *out_id) {
    (void)ctx;
    
    if (!out_id) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Generate random UUID v4 (REQ-001) */
    if (RAND_bytes(out_id->bytes, FP_DEVICE_ID_SIZE) != 1) {
        return FP_ERR_DEVICE_ID_GENERATION_FAILED;
    }
    
    /* Set version to 4 (random UUID) */
    out_id->bytes[6] = (out_id->bytes[6] & 0x0F) | 0x40;
    
    /* Set variant to RFC 4122 */
    out_id->bytes[8] = (out_id->bytes[8] & 0x3F) | 0x80;
    
    /* Format as string: 8-4-4-4-12 */
    snprintf(out_id->string, FP_DEVICE_ID_STRING_SIZE,
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        out_id->bytes[0], out_id->bytes[1], out_id->bytes[2], out_id->bytes[3],
        out_id->bytes[4], out_id->bytes[5],
        out_id->bytes[6], out_id->bytes[7],
        out_id->bytes[8], out_id->bytes[9],
        out_id->bytes[10], out_id->bytes[11], out_id->bytes[12],
        out_id->bytes[13], out_id->bytes[14], out_id->bytes[15]);
    
    return FP_OK;
}

fp_error_t fairplay_device_id_ensure(const char *storage_path, fp_device_id_t *out_id) {
    if (!storage_path || !out_id) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Try to load existing device ID */
    fp_error_t err = fairplay_device_id_load(storage_path, out_id);
    if (err == FP_OK) {
        return FP_OK;  /* Found existing ID */
    }
    
    /* Generate new device ID */
    err = fairplay_device_id_generate(NULL, out_id);
    if (err != FP_OK) {
        return err;
    }
    
    /* Save to storage */
    err = fairplay_device_id_save(storage_path, out_id);
    if (err != FP_OK) {
        return err;
    }
    
    return FP_OK;
}

fp_error_t fairplay_device_id_load(const char *storage_path, fp_device_id_t *out_id) {
    if (!storage_path || !out_id) {
        return FP_ERR_NULL_POINTER;
    }
    
    char file_path[1024];
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_DEVICE_ID_FILE);
    
    FILE *f = fopen(file_path, "r");
    if (!f) {
        return FP_ERR_DEVICE_ID_NOT_FOUND;
    }
    
    char buffer[FP_DEVICE_ID_STRING_SIZE];
    if (fgets(buffer, sizeof(buffer), f) == NULL) {
        fclose(f);
        return FP_ERR_DEVICE_ID_INVALID_FORMAT;
    }
    fclose(f);
    
    /* Remove newline */
    size_t len = strlen(buffer);
    while (len > 0 && (buffer[len-1] == '\n' || buffer[len-1] == '\r')) {
        buffer[--len] = '\0';
    }
    
    /* Parse hex string */
    return fairplay_device_id_from_hex(buffer, out_id);
}

fp_error_t fairplay_device_id_save(const char *storage_path, const fp_device_id_t *device_id) {
    if (!storage_path || !device_id) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Create directory if needed */
    fp_error_t err = fp_device_create_directory(storage_path);
    if (err != FP_OK) {
        return err;
    }
    
    char file_path[1024];
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_DEVICE_ID_FILE);
    
    /* Write with restricted permissions (0600) */
    int fd = open(file_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        return FP_ERR_DEVICE_ID_STORAGE_FAILED;
    }
    
    ssize_t written = write(fd, device_id->string, strlen(device_id->string));
    write(fd, "\n", 1);
    close(fd);
    
    if (written != (ssize_t)strlen(device_id->string)) {
        return FP_ERR_DEVICE_ID_STORAGE_FAILED;
    }
    
    return FP_OK;
}

fp_error_t fairplay_device_id_to_hex(const fp_device_id_t *device_id, char *out, size_t out_size) {
    if (!device_id || !out || out_size < 33) {
        return FP_ERR_BUFFER_TOO_SMALL;
    }
    
    /* Output as 32 hex chars (no dashes) */
    for (int i = 0; i < FP_DEVICE_ID_SIZE; i++) {
        sprintf(out + (i * 2), "%02x", device_id->bytes[i]);
    }
    out[FP_DEVICE_ID_SIZE * 2] = '\0';
    
    return FP_OK;
}

fp_error_t fairplay_device_id_from_hex(const char *hex_string, fp_device_id_t *out_id) {
    if (!hex_string || !out_id) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Remove dashes if present */
    char clean_hex[33] = {0};
    size_t clean_idx = 0;
    for (size_t i = 0; hex_string[i] && clean_idx < 32; i++) {
        if (hex_string[i] != '-') {
            clean_hex[clean_idx++] = hex_string[i];
        }
    }
    
    if (clean_idx != 32) {
        return FP_ERR_DEVICE_ID_INVALID_FORMAT;
    }
    
    /* Parse hex */
    for (int i = 0; i < FP_DEVICE_ID_SIZE; i++) {
        unsigned int byte;
        if (sscanf(clean_hex + (i * 2), "%02x", &byte) != 1) {
            return FP_ERR_DEVICE_ID_INVALID_FORMAT;
        }
        out_id->bytes[i] = (uint8_t)byte;
    }
    
    /* Format as standard UUID string */
    snprintf(out_id->string, FP_DEVICE_ID_STRING_SIZE,
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        out_id->bytes[0], out_id->bytes[1], out_id->bytes[2], out_id->bytes[3],
        out_id->bytes[4], out_id->bytes[5],
        out_id->bytes[6], out_id->bytes[7],
        out_id->bytes[8], out_id->bytes[9],
        out_id->bytes[10], out_id->bytes[11], out_id->bytes[12],
        out_id->bytes[13], out_id->bytes[14], out_id->bytes[15]);
    
    return FP_OK;
}

/* =============================================================================
 * Key Pair Functions (REQ-004, REQ-005)
 * ============================================================================= */

fp_error_t fairplay_keypair_generate_rsa(
    fp_device_context_t *ctx,
    int key_bits,
    fp_key_format_t format,
    fp_key_pair_t **out_key_pair
) {
    (void)ctx;
    
    if (!out_key_pair) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Validate key size (REQ-004) */
    if (key_bits < FP_RSA_MIN_BITS || key_bits > FP_RSA_MAX_BITS) {
        return FP_ERR_INVALID_DEVICE_KEY_SIZE;
    }
    
    /* Allocate key pair structure */
    fp_key_pair_t *key_pair = calloc(1, sizeof(fp_key_pair_t));
    if (!key_pair) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    key_pair->type = FP_KEY_TYPE_RSA;
    key_pair->format = format;
    key_pair->key_bits = key_bits;
    
    /* Generate RSA key pair */
    RSA *rsa = NULL;
    BIGNUM *bn = NULL;
    EVP_PKEY *pkey = NULL;
    
    bn = BN_new();
    if (!bn) {
        free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    if (!BN_set_word(bn, RSA_F4)) {
        BN_free(bn);
        free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    rsa = RSA_new();
    if (!rsa) {
        BN_free(bn);
        free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    if (RSA_generate_key_ex(rsa, key_bits, bn, NULL) != 1) {
        RSA_free(rsa);
        BN_free(bn);
        free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    BN_free(bn);
    
    /* Convert to EVP_PKEY */
    pkey = EVP_PKEY_new();
    if (!pkey) {
        RSA_free(rsa);
        free(key_pair);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (EVP_PKEY_assign_RSA(pkey, rsa) != 1) {
        EVP_PKEY_free(pkey);
        free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    /* Export private key */
    BIO *bio_priv = BIO_new(BIO_s_mem());
    if (format == FP_KEY_FORMAT_PEM) {
        if (PEM_write_bio_PrivateKey(bio_priv, pkey, NULL, NULL, 0, NULL, NULL) != 1) {
            BIO_free(bio_priv);
            EVP_PKEY_free(pkey);
            fairplay_keypair_free(key_pair);
            return FP_ERR_KEY_GENERATION_FAILED;
        }
    } else {
        if (i2d_PrivateKey_bio(bio_priv, pkey) <= 0) {
            BIO_free(bio_priv);
            EVP_PKEY_free(pkey);
            fairplay_keypair_free(key_pair);
            return FP_ERR_KEY_GENERATION_FAILED;
        }
    }
    
    /* Export public key */
    BIO *bio_pub = BIO_new(BIO_s_mem());
    if (format == FP_KEY_FORMAT_PEM) {
        if (PEM_write_bio_PUBKEY(bio_pub, pkey) != 1) {
            BIO_free(bio_priv);
            BIO_free(bio_pub);
            EVP_PKEY_free(pkey);
            fairplay_keypair_free(key_pair);
            return FP_ERR_KEY_GENERATION_FAILED;
        }
    } else {
        if (i2d_PUBKEY_bio(bio_pub, pkey) <= 0) {
            BIO_free(bio_priv);
            BIO_free(bio_pub);
            EVP_PKEY_free(pkey);
            fairplay_keypair_free(key_pair);
            return FP_ERR_KEY_GENERATION_FAILED;
        }
    }
    
    /* Read data from BIOs */
    key_pair->private_key_size = BIO_pending(bio_priv);
    key_pair->private_key = malloc(key_pair->private_key_size);
    if (!key_pair->private_key) {
        BIO_free(bio_priv);
        BIO_free(bio_pub);
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_OUT_OF_MEMORY;
    }
    BIO_read(bio_priv, key_pair->private_key, key_pair->private_key_size);
    BIO_free(bio_priv);
    
    key_pair->public_key_size = BIO_pending(bio_pub);
    key_pair->public_key = malloc(key_pair->public_key_size);
    if (!key_pair->public_key) {
        BIO_free(bio_pub);
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_OUT_OF_MEMORY;
    }
    BIO_read(bio_pub, key_pair->public_key, key_pair->public_key_size);
    BIO_free(bio_pub);
    
    EVP_PKEY_free(pkey);
    
    *out_key_pair = key_pair;
    return FP_OK;
}

fp_error_t fairplay_keypair_generate_ec(
    fp_device_context_t *ctx,
    const char *curve_name,
    fp_key_format_t format,
    fp_key_pair_t **out_key_pair
) {
    (void)ctx;
    
    if (!out_key_pair) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Use default curve if not specified */
    if (!curve_name) {
        curve_name = FP_EC_DEFAULT_CURVE;
    }
    
    /* Allocate key pair structure */
    fp_key_pair_t *key_pair = calloc(1, sizeof(fp_key_pair_t));
    if (!key_pair) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    key_pair->type = FP_KEY_TYPE_EC;
    key_pair->format = format;
    
    /* Get curve NID */
    int nid = OBJ_sn2nid(curve_name);
    if (nid == NID_undef) {
        nid = OBJ_txt2nid(curve_name);
    }
    if (nid == NID_undef) {
        free(key_pair);
        return FP_ERR_INVALID_CURVE;
    }
    
    /* Get curve bits for metadata */
    EC_GROUP *group = (EC_GROUP *)EC_GROUP_new_by_curve_name(nid);
    if (!group) {
        free(key_pair);
        return FP_ERR_INVALID_CURVE;
    }
    
    key_pair->key_bits = (int)EC_GROUP_get_degree(group);
    const char *curve_sn = OBJ_nid2sn(nid);
    key_pair->curve_name = curve_sn ? strdup(curve_sn) : strdup(curve_name);
    if (!key_pair->curve_name) {
        fairplay_keypair_free(key_pair);
        EC_GROUP_free(group);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    EC_GROUP_free(group);
    
    /* Generate EC key pair */
    EC_KEY *ec_key = EC_KEY_new_by_curve_name(nid);
    if (!ec_key) {
        fairplay_keypair_free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    if (EC_KEY_generate_key(ec_key) != 1) {
        EC_KEY_free(ec_key);
        fairplay_keypair_free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    EVP_PKEY *pkey = EVP_PKEY_new();
    if (!pkey) {
        EC_KEY_free(ec_key);
        fairplay_keypair_free(key_pair);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (EVP_PKEY_assign_EC_KEY(pkey, ec_key) != 1) {
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    /* Export private key */
    BIO *bio_priv = BIO_new(BIO_s_mem());
    if (format == FP_KEY_FORMAT_PEM) {
        if (PEM_write_bio_ECPrivateKey(bio_priv, ec_key, NULL, NULL, 0, NULL, NULL) != 1) {
            BIO_free(bio_priv);
            EVP_PKEY_free(pkey);
            fairplay_keypair_free(key_pair);
            return FP_ERR_KEY_GENERATION_FAILED;
        }
    } else {
        if (i2d_ECPrivateKey_bio(bio_priv, ec_key) <= 0) {
            BIO_free(bio_priv);
            EVP_PKEY_free(pkey);
            fairplay_keypair_free(key_pair);
            return FP_ERR_KEY_GENERATION_FAILED;
        }
    }
    
    /* Export public key */
    BIO *bio_pub = BIO_new(BIO_s_mem());
    if (PEM_write_bio_PUBKEY(bio_pub, pkey) != 1) {
        BIO_free(bio_priv);
        BIO_free(bio_pub);
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_KEY_GENERATION_FAILED;
    }
    
    /* Read data from BIOs */
    key_pair->private_key_size = BIO_pending(bio_priv);
    key_pair->private_key = malloc(key_pair->private_key_size);
    if (!key_pair->private_key) {
        BIO_free(bio_priv);
        BIO_free(bio_pub);
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_OUT_OF_MEMORY;
    }
    BIO_read(bio_priv, key_pair->private_key, key_pair->private_key_size);
    BIO_free(bio_priv);
    
    key_pair->public_key_size = BIO_pending(bio_pub);
    key_pair->public_key = malloc(key_pair->public_key_size);
    if (!key_pair->public_key) {
        BIO_free(bio_pub);
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_OUT_OF_MEMORY;
    }
    BIO_read(bio_pub, key_pair->public_key, key_pair->public_key_size);
    BIO_free(bio_pub);
    
    EVP_PKEY_free(pkey);
    
    *out_key_pair = key_pair;
    return FP_OK;
}

fp_error_t fairplay_keypair_load(
    const uint8_t *private_key,
    size_t private_key_size,
    const uint8_t *public_key,
    size_t public_key_size,
    fp_key_format_t format,
    fp_key_pair_t **out_key_pair
) {
    if (!private_key || !out_key_pair) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_key_pair_t *key_pair = calloc(1, sizeof(fp_key_pair_t));
    if (!key_pair) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Detect key type from format */
    key_pair->format = format;
    
    BIO *bio = BIO_new_mem_buf(private_key, (int)private_key_size);
    EVP_PKEY *pkey = NULL;
    
    if (format == FP_KEY_FORMAT_PEM) {
        /* Pass "" rather than NULL so OpenSSL fails with an error instead of
           blocking on console input when the PEM happens to be encrypted. */
        pkey = PEM_read_bio_PrivateKey(bio, NULL, NULL, (void *)"");
    } else {
        pkey = d2i_PrivateKey_bio(bio, NULL);
    }

    BIO_free(bio);

    if (!pkey) {
        fairplay_keypair_free(key_pair);
        return FP_ERR_INVALID_PRIVATE_KEY;
    }
    
    /* Determine key type */
    int pkey_type = EVP_PKEY_base_id(pkey);
    if (pkey_type == EVP_PKEY_RSA) {
        key_pair->type = FP_KEY_TYPE_RSA;
        RSA *rsa = EVP_PKEY_get1_RSA(pkey);
        if (rsa) {
            key_pair->key_bits = RSA_bits(rsa);
            RSA_free(rsa);
        }
    } else if (pkey_type == EVP_PKEY_EC) {
        key_pair->type = FP_KEY_TYPE_EC;
        EC_KEY *ec_key = EVP_PKEY_get1_EC_KEY(pkey);
        if (ec_key) {
            const EC_GROUP *group = EC_KEY_get0_group(ec_key);
            if (group) {
                key_pair->key_bits = (int)EC_GROUP_get_degree(group);
                int nid = EC_GROUP_get_curve_name(group);
                const char *curve_sn = OBJ_nid2sn(nid);
                key_pair->curve_name = curve_sn ? strdup(curve_sn) : NULL;
            }
            EC_KEY_free(ec_key);
        }
    } else {
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_INVALID_KEY;
    }
    
    /* Store private key */
    key_pair->private_key_size = private_key_size;
    key_pair->private_key = malloc(private_key_size);
    if (!key_pair->private_key) {
        EVP_PKEY_free(pkey);
        fairplay_keypair_free(key_pair);
        return FP_ERR_OUT_OF_MEMORY;
    }
    memcpy(key_pair->private_key, private_key, private_key_size);
    
    /* Store or extract public key */
    if (public_key && public_key_size > 0) {
        key_pair->public_key_size = public_key_size;
        key_pair->public_key = malloc(public_key_size);
        if (!key_pair->public_key) {
            EVP_PKEY_free(pkey);
            fairplay_keypair_free(key_pair);
            return FP_ERR_OUT_OF_MEMORY;
        }
        memcpy(key_pair->public_key, public_key, public_key_size);
    } else {
        /* Extract public key from private key */
        BIO *bio_pub = BIO_new(BIO_s_mem());
        if (format == FP_KEY_FORMAT_PEM) {
            PEM_write_bio_PUBKEY(bio_pub, pkey);
        } else {
            i2d_PUBKEY_bio(bio_pub, pkey);
        }
        
        key_pair->public_key_size = BIO_pending(bio_pub);
        key_pair->public_key = malloc(key_pair->public_key_size);
        if (key_pair->public_key) {
            BIO_read(bio_pub, key_pair->public_key, key_pair->public_key_size);
        }
        BIO_free(bio_pub);
    }
    
    EVP_PKEY_free(pkey);
    *out_key_pair = key_pair;
    return FP_OK;
}

fp_error_t fairplay_keypair_save(
    const char *storage_path,
    const fp_key_pair_t *key_pair,
    bool encrypt_private,
    const char *encryption_password
) {
    if (!storage_path || !key_pair) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Create directory if needed */
    fp_error_t err = fp_device_create_directory(storage_path);
    if (err != FP_OK) {
        return err;
    }
    
    char file_path[1024];
    
    /* Save private key */
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_PRIVATE_KEY_FILE);
    
    int fd = open(file_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    if (fd < 0) {
        return FP_ERR_KEY_STORAGE_FAILED;
    }
    
    /* Encrypt private key if requested */
    if (encrypt_private && encryption_password) {
        uint8_t *encrypted = NULL;
        size_t encrypted_size = 0;
        
        err = fp_device_encrypt_aes256_gcm(
            key_pair->private_key, key_pair->private_key_size,
            encryption_password,
            &encrypted, &encrypted_size
        );
        if (err != FP_OK) {
            close(fd);
            return err;
        }
        
        ssize_t written = write(fd, encrypted, encrypted_size);
        free(encrypted);
        close(fd);
        
        if (written != (ssize_t)encrypted_size) {
            return FP_ERR_KEY_STORAGE_FAILED;
        }
    } else {
        /* Write unencrypted */
        ssize_t written = write(fd, key_pair->private_key, key_pair->private_key_size);
        close(fd);
        
        if (written != (ssize_t)key_pair->private_key_size) {
            return FP_ERR_KEY_STORAGE_FAILED;
        }
    }
    
    /* Save public key */
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_PUBLIC_KEY_FILE);
    
    fd = open(file_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        return FP_ERR_KEY_STORAGE_FAILED;
    }
    
    ssize_t written = write(fd, key_pair->public_key, key_pair->public_key_size);
    close(fd);
    
    if (written != (ssize_t)key_pair->public_key_size) {
        return FP_ERR_KEY_STORAGE_FAILED;
    }
    
    return FP_OK;
}

fp_error_t fairplay_keypair_load_from_storage(
    const char *storage_path,
    const char *encryption_password,
    fp_key_pair_t **out_key_pair
) {
    if (!storage_path || !out_key_pair) {
        return FP_ERR_NULL_POINTER;
    }
    
    char file_path[1024];
    
    /* Load private key */
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_PRIVATE_KEY_FILE);
    
    FILE *f = fopen(file_path, "rb");
    if (!f) {
        return FP_ERR_KEY_NOT_FOUND;
    }
    
    fseek(f, 0, SEEK_END);
    long priv_size = ftell(f);
    fseek(f, 0, SEEK_SET);
    
    uint8_t *priv_key = malloc(priv_size);
    if (!priv_key) {
        fclose(f);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (fread(priv_key, 1, priv_size, f) != (size_t)priv_size) {
        free(priv_key);
        fclose(f);
        return FP_ERR_INVALID_KEY;
    }
    fclose(f);
    
    /* Decrypt private key if needed */
    if (encryption_password && priv_size >= 32) {
        /* Check if encrypted (not starting with PEM header) */
        if (priv_key[0] != '-' || priv_key[1] != '-') {
            uint8_t *decrypted = NULL;
            size_t decrypted_size = 0;
            
            fp_error_t err = fp_device_decrypt_aes256_gcm(
                priv_key, priv_size,
                encryption_password,
                &decrypted, &decrypted_size
            );
            
            free(priv_key);
            
            if (err != FP_OK) {
                if (err == FP_ERR_KEY_DECRYPTION_FAILED) {
                    return FP_ERR_INVALID_PASSWORD;
                }
                return err;
            }
            
            priv_key = decrypted;
            priv_size = decrypted_size;
        }
    }
    
    /* Load public key */
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_PUBLIC_KEY_FILE);
    
    f = fopen(file_path, "rb");
    uint8_t *pub_key = NULL;
    size_t pub_size = 0;
    
    if (f) {
        fseek(f, 0, SEEK_END);
        long size = ftell(f);
        fseek(f, 0, SEEK_SET);
        
        pub_key = malloc(size);
        if (pub_key) {
            pub_size = (size_t)size;
            if (fread(pub_key, 1, pub_size, f) != pub_size) {
                free(pub_key);
                pub_key = NULL;
                pub_size = 0;
            }
        }
        fclose(f);
    }
    
    /* Detect format — PEM starts with "-----BEGIN" */
    fp_key_format_t format = (priv_key[0] == '-' && priv_key[1] == '-')
                             ? FP_KEY_FORMAT_PEM : FP_KEY_FORMAT_DER;

    /* When the stored file is PEM and a password was supplied, it may be an
       OpenSSL-encrypted PEM (BEGIN ENCRYPTED PRIVATE KEY / Proc-Type: 4,ENCRYPTED).
       Decrypt it with OpenSSL here and re-encode as unencrypted DER so that
       fairplay_keypair_load can load it without needing a password. */
    if (format == FP_KEY_FORMAT_PEM && encryption_password) {
        BIO *bio_pem = BIO_new_mem_buf(priv_key, (int)priv_size);
        EVP_PKEY *pkey = PEM_read_bio_PrivateKey(bio_pem, NULL, NULL,
                                                  (void *)encryption_password);
        BIO_free(bio_pem);

        if (pkey) {
            /* Re-serialize as unencrypted DER */
            BIO *bio_der = BIO_new(BIO_s_mem());
            if (!bio_der) {
                EVP_PKEY_free(pkey);
                free(priv_key);
                free(pub_key);
                return FP_ERR_OUT_OF_MEMORY;
            }
            if (i2d_PrivateKey_bio(bio_der, pkey) <= 0) {
                EVP_PKEY_free(pkey);
                BIO_free(bio_der);
                free(priv_key);
                free(pub_key);
                return FP_ERR_INVALID_PRIVATE_KEY;
            }
            EVP_PKEY_free(pkey);

            free(priv_key);
            priv_size = (size_t)BIO_pending(bio_der);
            priv_key = malloc(priv_size);
            if (!priv_key) {
                BIO_free(bio_der);
                free(pub_key);
                return FP_ERR_OUT_OF_MEMORY;
            }
            BIO_read(bio_der, priv_key, (int)priv_size);
            BIO_free(bio_der);
            format = FP_KEY_FORMAT_DER;
        }
        /* If pkey is NULL the PEM is either unencrypted (password ignored by
           OpenSSL) or uses our own GCM wrapper — fall through to normal load. */
    }

    fp_error_t err = fairplay_keypair_load(
        priv_key, priv_size, pub_key, pub_size, format, out_key_pair
    );

    free(priv_key);
    free(pub_key);

    return err;
}

void fairplay_keypair_free(fp_key_pair_t *key_pair) {
    if (!key_pair) return;
    
    fp_device_secure_zero(key_pair->private_key, key_pair->private_key_size);
    free(key_pair->private_key);
    fp_device_secure_zero(key_pair->public_key, key_pair->public_key_size);
    free(key_pair->public_key);
    free(key_pair->curve_name);
    free(key_pair->encryption_password);
    fp_device_secure_zero(key_pair, sizeof(fp_key_pair_t));
    free(key_pair);
}

fp_key_type_t fairplay_keypair_get_type(const fp_key_pair_t *key_pair) {
    return key_pair ? key_pair->type : FP_KEY_TYPE_RSA;
}

int fairplay_keypair_get_bits(const fp_key_pair_t *key_pair) {
    return key_pair ? key_pair->key_bits : 0;
}

/* =============================================================================
 * Certificate Functions (REQ-006, REQ-007, REQ-009, REQ-012)
 * ============================================================================= */

fp_error_t fairplay_cert_create_self_signed(
    fp_device_context_t *ctx,
    const fp_key_pair_t *key_pair,
    const fp_device_id_t *device_id,
    int validity_years,
    fp_key_format_t format,
    fp_certificate_t **out_certificate
) {
    (void)ctx;
    
    if (!key_pair || !device_id || !out_certificate) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Default validity period */
    if (validity_years <= 0) {
        validity_years = FP_CERT_DEFAULT_VALIDITY_YEARS;
    }
    
    /* Load private key */
    BIO *bio_priv = BIO_new_mem_buf(key_pair->private_key, (int)key_pair->private_key_size);
    EVP_PKEY *pkey = NULL;
    
    if (key_pair->format == FP_KEY_FORMAT_PEM) {
        pkey = PEM_read_bio_PrivateKey(bio_priv, NULL, NULL, (void *)"");
    } else {
        pkey = d2i_PrivateKey_bio(bio_priv, NULL);
    }
    BIO_free(bio_priv);
    
    if (!pkey) {
        return FP_ERR_INVALID_PRIVATE_KEY;
    }
    
    /* Create X.509 certificate */
    X509 *cert = X509_new();
    if (!cert) {
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Set version to v3 */
    X509_set_version(cert, 2);  /* 0 = v1, 1 = v2, 2 = v3 */
    
    /* Generate serial number */
    {
        uint8_t serial_bytes[16];
        if (RAND_bytes(serial_bytes, 16) == 1) {
            BIGNUM *bn = BN_bin2bn(serial_bytes, 16, NULL);
            if (bn) {
                ASN1_INTEGER *serial = BN_to_ASN1_INTEGER(bn, NULL);
                BN_free(bn);
                if (serial) {
                    X509_set_serialNumber(cert, serial);
                    ASN1_INTEGER_free(serial);
                }
            }
        }
    }
    
    /* Set validity period */
    time_t now = time(NULL);
    time_t not_after = now + (validity_years * 365LL * 24 * 60 * 60);
    
    ASN1_TIME *not_before = X509_gmtime_adj(NULL, 0);
    ASN1_TIME *not_after_time = X509_gmtime_adj(NULL, (long)((not_after - now) / 60));
    
    if (not_before && not_after_time) {
        X509_set1_notBefore(cert, not_before);
        X509_set1_notAfter(cert, not_after_time);
        ASN1_TIME_free(not_before);
        ASN1_TIME_free(not_after_time);
    }
    
    /* Set subject and issuer (same for self-signed) */
    X509_NAME *name = X509_NAME_new();
    if (name) {
        /* Add CN = device_id */
        X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_UTF8,
                                   (unsigned char *)device_id->string, -1, -1, 0);
        
        X509_set_subject_name(cert, name);
        X509_set_issuer_name(cert, name);  /* Self-signed: issuer = subject */
        X509_NAME_free(name);
    }
    
    /* Set public key */
    if (X509_set_pubkey(cert, pkey) != 1) {
        X509_free(cert);
        EVP_PKEY_free(pkey);
        return FP_ERR_CERTIFICATE_SIGNING_FAILED;
    }
    
    /* Sign the certificate */
    if (X509_sign(cert, pkey, EVP_sha256()) <= 0) {
        X509_free(cert);
        EVP_PKEY_free(pkey);
        return FP_ERR_CERTIFICATE_SIGNING_FAILED;
    }
    
    /* Export certificate */
    fp_certificate_t *certificate = calloc(1, sizeof(fp_certificate_t));
    if (!certificate) {
        X509_free(cert);
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    certificate->format = format;
    
    BIO *bio_cert = BIO_new(BIO_s_mem());
    if (format == FP_KEY_FORMAT_PEM) {
        PEM_write_bio_X509(bio_cert, cert);
    } else {
        i2d_X509_bio(bio_cert, cert);
    }
    
    certificate->data_size = BIO_pending(bio_cert);
    certificate->data = malloc(certificate->data_size);
    if (certificate->data) {
        BIO_read(bio_cert, certificate->data, certificate->data_size);
    }
    BIO_free(bio_cert);
    
    X509_free(cert);
    EVP_PKEY_free(pkey);
    
    *out_certificate = certificate;
    return FP_OK;
}

fp_error_t fairplay_cert_create_csr(
    fp_device_context_t *ctx,
    const fp_key_pair_t *key_pair,
    const fp_device_id_t *device_id,
    fp_key_format_t format,
    fp_csr_t **out_csr
) {
    (void)ctx;
    
    if (!key_pair || !device_id || !out_csr) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Load private key */
    BIO *bio_priv = BIO_new_mem_buf(key_pair->private_key, (int)key_pair->private_key_size);
    EVP_PKEY *pkey = NULL;
    
    if (key_pair->format == FP_KEY_FORMAT_PEM) {
        pkey = PEM_read_bio_PrivateKey(bio_priv, NULL, NULL, (void *)"");
    } else {
        pkey = d2i_PrivateKey_bio(bio_priv, NULL);
    }
    BIO_free(bio_priv);
    
    if (!pkey) {
        return FP_ERR_INVALID_PRIVATE_KEY;
    }
    
    /* Create CSR */
    X509_REQ *req = X509_REQ_new();
    if (!req) {
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Set version (0 for PKCS#10) */
    X509_REQ_set_version(req, 0);
    
    /* Set subject */
    X509_NAME *name = X509_NAME_new();
    if (name) {
        X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_UTF8,
                                   (unsigned char *)device_id->string, -1, -1, 0);
        X509_REQ_set_subject_name(req, name);
        X509_NAME_free(name);
    }
    
    /* Set public key */
    if (X509_REQ_set_pubkey(req, pkey) != 1) {
        X509_REQ_free(req);
        EVP_PKEY_free(pkey);
        return FP_ERR_CSR_SIGNING_FAILED;
    }
    
    /* Sign the CSR */
    if (X509_REQ_sign(req, pkey, EVP_sha256()) <= 0) {
        X509_REQ_free(req);
        EVP_PKEY_free(pkey);
        return FP_ERR_CSR_SIGNING_FAILED;
    }
    
    /* Export CSR */
    fp_csr_t *csr = calloc(1, sizeof(fp_csr_t));
    if (!csr) {
        X509_REQ_free(req);
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    csr->format = format;
    
    BIO *bio_csr = BIO_new(BIO_s_mem());
    if (format == FP_KEY_FORMAT_PEM) {
        PEM_write_bio_X509_REQ(bio_csr, req);
    } else {
        i2d_X509_REQ_bio(bio_csr, req);
    }
    
    csr->data_size = BIO_pending(bio_csr);
    csr->data = malloc(csr->data_size);
    if (csr->data) {
        BIO_read(bio_csr, csr->data, csr->data_size);
    }
    BIO_free(bio_csr);
    
    X509_REQ_free(req);
    EVP_PKEY_free(pkey);
    
    *out_csr = csr;
    return FP_OK;
}

fp_error_t fairplay_cert_load(
    const uint8_t *data,
    size_t data_size,
    fp_key_format_t format,
    fp_certificate_t **out_certificate
) {
    if (!data || !out_certificate) {
        return FP_ERR_NULL_POINTER;
    }
    
    BIO *bio = BIO_new_mem_buf(data, (int)data_size);
    X509 *cert = NULL;
    
    if (format == FP_KEY_FORMAT_PEM) {
        cert = PEM_read_bio_X509(bio, NULL, NULL, NULL);
    } else {
        cert = d2i_X509_bio(bio, NULL);
    }
    BIO_free(bio);
    
    if (!cert) {
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    
    /* Re-export to normalize format */
    fp_certificate_t *certificate = calloc(1, sizeof(fp_certificate_t));
    if (!certificate) {
        X509_free(cert);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    certificate->format = format;
    
    BIO *bio_out = BIO_new(BIO_s_mem());
    if (format == FP_KEY_FORMAT_PEM) {
        PEM_write_bio_X509(bio_out, cert);
    } else {
        i2d_X509_bio(bio_out, cert);
    }
    
    certificate->data_size = BIO_pending(bio_out);
    certificate->data = malloc(certificate->data_size);
    if (certificate->data) {
        BIO_read(bio_out, certificate->data, certificate->data_size);
    }
    BIO_free(bio_out);
    
    X509_free(cert);
    *out_certificate = certificate;
    return FP_OK;
}

fp_error_t fairplay_cert_save(
    const char *storage_path,
    const fp_certificate_t *certificate
) {
    if (!storage_path || !certificate) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Create directory if needed */
    fp_error_t err = fp_device_create_directory(storage_path);
    if (err != FP_OK) {
        return err;
    }
    
    char file_path[1024];
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_CERTIFICATE_FILE);
    
    int fd = open(file_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        return FP_ERR_CERTIFICATE_STORAGE_FAILED;
    }
    
    ssize_t written = write(fd, certificate->data, certificate->data_size);
    close(fd);
    
    if (written != (ssize_t)certificate->data_size) {
        return FP_ERR_CERTIFICATE_STORAGE_FAILED;
    }
    
    return FP_OK;
}

fp_error_t fairplay_cert_load_from_storage(
    const char *storage_path,
    fp_certificate_t **out_certificate
) {
    if (!storage_path || !out_certificate) {
        return FP_ERR_NULL_POINTER;
    }
    
    char file_path[1024];
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_CERTIFICATE_FILE);
    
    FILE *f = fopen(file_path, "rb");
    if (!f) {
        return FP_ERR_KEY_NOT_FOUND;
    }
    
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    
    uint8_t *data = malloc(size);
    if (!data) {
        fclose(f);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    if (fread(data, 1, size, f) != (size_t)size) {
        free(data);
        fclose(f);
        return FP_ERR_CERTIFICATE_INVALID_FORMAT;
    }
    fclose(f);
    
    /* Detect format - PEM starts with "-----BEGIN" */
    fp_key_format_t format = (data[0] == '-' && data[1] == '-') ? FP_KEY_FORMAT_PEM : FP_KEY_FORMAT_DER;
    
    fp_error_t err = fairplay_cert_load(data, (size_t)size, format, out_certificate);
    free(data);
    
    return err;
}

fp_error_t fairplay_cert_validate(
    const fp_certificate_t *certificate,
    const fp_device_id_t *expected_device_id,
    fp_cert_validation_result_t *out_result
) {
    if (!certificate || !out_result) {
        return FP_ERR_NULL_POINTER;
    }
    
    memset(out_result, 0, sizeof(fp_cert_validation_result_t));
    out_result->is_valid = true;
    
    /* Load certificate */
    BIO *bio = BIO_new_mem_buf(certificate->data, (int)certificate->data_size);
    X509 *cert = NULL;
    
    if (certificate->format == FP_KEY_FORMAT_PEM) {
        cert = PEM_read_bio_X509(bio, NULL, NULL, NULL);
    } else {
        cert = d2i_X509_bio(bio, NULL);
    }
    BIO_free(bio);
    
    if (!cert) {
        out_result->error_code = FP_ERR_CERTIFICATE_INVALID_FORMAT;
        snprintf(out_result->error_message, sizeof(out_result->error_message),
                 "Failed to parse certificate");
        return FP_OK;  /* Validation completed, just failed */
    }
    
    /* Verify signature (self-signed) */
    X509_STORE *store = X509_STORE_new();
    X509_STORE_CTX *ctx = X509_STORE_CTX_new();
    
    if (X509_STORE_CTX_init(ctx, store, cert, NULL) != 1) {
        out_result->is_valid = false;
        out_result->has_valid_signature = false;
        out_result->error_code = FP_ERR_CERTIFICATE_INVALID_SIGNATURE;
        snprintf(out_result->error_message, sizeof(out_result->error_message),
                 "Failed to initialize verification context");
        X509_STORE_CTX_free(ctx);
        X509_STORE_free(store);
        X509_free(cert);
        return FP_OK;
    }
    
    /* Add cert to store for self-verification */
    X509_STORE_add_cert(store, cert);
    
    int verify_result = X509_verify_cert(ctx);
    if (verify_result <= 0) {
        out_result->is_valid = false;
        out_result->has_valid_signature = false;
        out_result->error_code = FP_ERR_CERTIFICATE_INVALID_SIGNATURE;
        snprintf(out_result->error_message, sizeof(out_result->error_message),
                 "Certificate signature verification failed: %s",
                 X509_verify_cert_error_string(X509_STORE_CTX_get_error(ctx)));
    } else {
        out_result->has_valid_signature = true;
    }
    
    X509_STORE_CTX_free(ctx);
    X509_STORE_free(store);
    
    /* Check validity period */
    const ASN1_TIME *not_before = X509_get0_notBefore(cert);
    const ASN1_TIME *not_after = X509_get0_notAfter(cert);
    
    if (not_before) {
        struct tm tm_time;
        if (ASN1_TIME_to_tm(not_before, &tm_time) == 1) {
            out_result->not_before = mktime(&tm_time);
        }
    }
    if (not_after) {
        struct tm tm_time;
        if (ASN1_TIME_to_tm(not_after, &tm_time) == 1) {
            out_result->not_after = mktime(&tm_time);
        }
    }
    
    time_t now = time(NULL);
    if (out_result->not_before > now) {
        out_result->is_valid = false;
        out_result->is_within_validity = false;
        out_result->error_code = FP_ERR_CERTIFICATE_NOT_YET_VALID;
        snprintf(out_result->error_message, sizeof(out_result->error_message),
                 "Certificate not yet valid");
    } else if (out_result->not_after < now) {
        out_result->is_valid = false;
        out_result->is_within_validity = false;
        out_result->error_code = FP_ERR_CERTIFICATE_EXPIRED;
        snprintf(out_result->error_message, sizeof(out_result->error_message),
                 "Certificate has expired");
    } else {
        out_result->is_within_validity = true;
    }
    
    /* Check subject */
    X509_NAME *subject = X509_get_subject_name(cert);
    if (subject) {
        char subject_str[256];
        X509_NAME_oneline(subject, subject_str, sizeof(subject_str));
        strncpy(out_result->subject, subject_str, sizeof(out_result->subject) - 1);
        
        /* Check if subject contains expected device ID */
        if (expected_device_id) {
            out_result->has_expected_subject = (strstr(subject_str, expected_device_id->string) != NULL);
            if (!out_result->has_expected_subject) {
                out_result->is_valid = false;
                snprintf(out_result->error_message, sizeof(out_result->error_message),
                         "Subject does not contain expected device ID");
            }
        }
    }
    
    /* Get issuer */
    X509_NAME *issuer = X509_get_issuer_name(cert);
    if (issuer) {
        char issuer_str[256];
        X509_NAME_oneline(issuer, issuer_str, sizeof(issuer_str));
        strncpy(out_result->issuer, issuer_str, sizeof(out_result->issuer) - 1);
    }
    
    /* Get serial number */
    ASN1_INTEGER *serial = X509_get_serialNumber(cert);
    if (serial && serial->data && serial->length > 0) {
        size_t copy_len = (size_t)serial->length < FP_CERT_MAX_SERIAL_LENGTH ? 
                          (size_t)serial->length : FP_CERT_MAX_SERIAL_LENGTH;
        memcpy(out_result->serial_number, serial->data, copy_len);
        out_result->serial_number_size = copy_len;
    }
    
    X509_free(cert);
    return FP_OK;
}

void fairplay_cert_free(fp_certificate_t *certificate) {
    if (!certificate) return;
    
    fp_device_secure_zero(certificate->data, certificate->data_size);
    free(certificate->data);
    fp_device_secure_zero(certificate, sizeof(fp_certificate_t));
    free(certificate);
}

void fairplay_csr_free(fp_csr_t *csr) {
    if (!csr) return;
    
    fp_device_secure_zero(csr->data, csr->data_size);
    free(csr->data);
    fp_device_secure_zero(csr, sizeof(fp_csr_t));
    free(csr);
}

/* =============================================================================
 * Key Wrapping Functions (REQ-010, REQ-011)
 * ============================================================================= */

fp_error_t fairplay_key_wrap(
    const uint8_t *content_key,
    size_t content_key_size,
    const uint8_t *public_key,
    size_t public_key_size,
    fp_key_type_t key_type,
    uint8_t **out_wrapped_key,
    size_t *wrapped_key_size
) {
    if (!content_key || !public_key || !out_wrapped_key || !wrapped_key_size) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Load public key */
    BIO *bio = BIO_new_mem_buf(public_key, (int)public_key_size);
    EVP_PKEY *pkey = PEM_read_bio_PUBKEY(bio, NULL, NULL, NULL);
    BIO_free(bio);
    
    if (!pkey) {
        /* Try DER format */
        bio = BIO_new_mem_buf(public_key, (int)public_key_size);
        pkey = d2i_PUBKEY_bio(bio, NULL);
        BIO_free(bio);
    }
    
    if (!pkey) {
        return FP_ERR_INVALID_PUBLIC_KEY;
    }
    
    /* Allocate output buffer */
    size_t max_wrapped_size = EVP_PKEY_size(pkey);
    uint8_t *wrapped = malloc(max_wrapped_size);
    if (!wrapped) {
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    size_t wrapped_len = 0;
    
    if (key_type == FP_KEY_TYPE_RSA) {
        /* RSAES-OAEP with SHA-256 */
        EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new(pkey, NULL);
        if (!pctx) {
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_OUT_OF_MEMORY;
        }
        
        if (EVP_PKEY_encrypt_init(pctx) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_WRAPPING_FAILED;
        }
        
        if (EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_OAEP_PADDING) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_WRAPPING_FAILED;
        }
        
        if (EVP_PKEY_CTX_set_rsa_oaep_md(pctx, EVP_sha256()) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_WRAPPING_FAILED;
        }
        
        /* Get required size first */
        if (EVP_PKEY_encrypt(pctx, NULL, &wrapped_len,
                            content_key, content_key_size) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_WRAPPING_FAILED;
        }
        
        /* Reallocate if needed */
        if (wrapped_len > max_wrapped_size) {
            uint8_t *new_wrapped = realloc(wrapped, wrapped_len);
            if (!new_wrapped) {
                EVP_PKEY_CTX_free(pctx);
                free(wrapped);
                EVP_PKEY_free(pkey);
                return FP_ERR_OUT_OF_MEMORY;
            }
            wrapped = new_wrapped;
        }
        
        /* Now encrypt */
        if (EVP_PKEY_encrypt(pctx, wrapped, &wrapped_len,
                            content_key, content_key_size) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_WRAPPING_FAILED;
        }
        
        EVP_PKEY_CTX_free(pctx);
    } else {
        /* For EC keys, use EVP_PKEY_CTX for encryption */
        EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new(pkey, NULL);
        if (!pctx) {
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_OUT_OF_MEMORY;
        }
        
        if (EVP_PKEY_encrypt_init(pctx) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_WRAPPING_FAILED;
        }
        
        if (EVP_PKEY_encrypt(pctx, wrapped, &wrapped_len,
                            content_key, content_key_size) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(wrapped);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_WRAPPING_FAILED;
        }
        
        EVP_PKEY_CTX_free(pctx);
    }
    
    EVP_PKEY_free(pkey);
    
    if (wrapped_len <= 0) {
        free(wrapped);
        return FP_ERR_KEY_WRAPPING_FAILED;
    }
    
    *out_wrapped_key = wrapped;
    *wrapped_key_size = (size_t)wrapped_len;
    return FP_OK;
}

fp_error_t fairplay_key_unwrap(
    const uint8_t *wrapped_key,
    size_t wrapped_key_size,
    const uint8_t *private_key,
    size_t private_key_size,
    const char *password,
    fp_key_type_t key_type,
    uint8_t **out_content_key,
    size_t *content_key_size
) {
    if (!wrapped_key || !private_key || !out_content_key || !content_key_size) {
        return FP_ERR_NULL_POINTER;
    }
    
    /* Load private key */
    BIO *bio = BIO_new_mem_buf(private_key, (int)private_key_size);
    EVP_PKEY *pkey = NULL;
    
    /* Detect format - PEM starts with "-----BEGIN" */
    if (private_key[0] == '-' && private_key[1] == '-') {
        pkey = PEM_read_bio_PrivateKey(bio, NULL, NULL,
                                        password ? (void *)password : NULL);
    } else {
        pkey = d2i_PrivateKey_bio(bio, NULL);
    }
    BIO_free(bio);
    
    if (!pkey) {
        return FP_ERR_INVALID_PRIVATE_KEY;
    }
    
    /* Allocate output buffer */
    size_t max_content_size = EVP_PKEY_size(pkey);
    uint8_t *content = malloc(max_content_size);
    if (!content) {
        EVP_PKEY_free(pkey);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    size_t content_len = 0;
    
    if (key_type == FP_KEY_TYPE_RSA) {
        /* RSAES-OAEP with SHA-256 */
        EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new(pkey, NULL);
        if (!pctx) {
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_OUT_OF_MEMORY;
        }
        
        if (EVP_PKEY_decrypt_init(pctx) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_UNWRAPPING_FAILED;
        }
        
        if (EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_OAEP_PADDING) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_UNWRAPPING_FAILED;
        }
        
        if (EVP_PKEY_CTX_set_rsa_oaep_md(pctx, EVP_sha256()) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_UNWRAPPING_FAILED;
        }
        
        /* Get required size first */
        if (EVP_PKEY_decrypt(pctx, NULL, &content_len,
                            wrapped_key, wrapped_key_size) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_UNWRAPPING_FAILED;
        }
        
        /* Reallocate if needed */
        if (content_len > max_content_size) {
            uint8_t *new_content = realloc(content, content_len);
            if (!new_content) {
                EVP_PKEY_CTX_free(pctx);
                free(content);
                EVP_PKEY_free(pkey);
                return FP_ERR_OUT_OF_MEMORY;
            }
            content = new_content;
        }
        
        /* Now decrypt */
        if (EVP_PKEY_decrypt(pctx, content, &content_len,
                            wrapped_key, wrapped_key_size) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_UNWRAPPING_FAILED;
        }
        
        EVP_PKEY_CTX_free(pctx);
    } else {
        /* EC unwrapping using EVP_PKEY_CTX */
        EVP_PKEY_CTX *pctx = EVP_PKEY_CTX_new(pkey, NULL);
        if (!pctx) {
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_OUT_OF_MEMORY;
        }
        
        if (EVP_PKEY_decrypt_init(pctx) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_UNWRAPPING_FAILED;
        }
        
        if (EVP_PKEY_decrypt(pctx, content, &content_len,
                            wrapped_key, wrapped_key_size) <= 0) {
            EVP_PKEY_CTX_free(pctx);
            free(content);
            EVP_PKEY_free(pkey);
            return FP_ERR_KEY_UNWRAPPING_FAILED;
        }
        
        EVP_PKEY_CTX_free(pctx);
    }
    
    EVP_PKEY_free(pkey);
    
    *out_content_key = content;
    *content_key_size = content_len;
    return FP_OK;
}

/* =============================================================================
 * Credential Management (REQ-014)
 * ============================================================================= */

fp_error_t fairplay_credentials_ensure(
    const char *storage_path,
    fp_device_context_t *ctx,
    fp_key_type_t key_type,
    const char *encryption_password,
    fp_credentials_t **out_credentials,
    bool *generated_new
) {
    if (!storage_path || !out_credentials) {
        return FP_ERR_NULL_POINTER;
    }
    
    bool new_generated = false;
    
    /* Try to load existing credentials */
    fp_credentials_t *creds = NULL;
    fp_error_t err = fairplay_credentials_load(storage_path, encryption_password, &creds);
    
    if (err == FP_OK) {
        *out_credentials = creds;
        if (generated_new) *generated_new = false;
        return FP_OK;
    }
    
    /* Generate new credentials */
    creds = calloc(1, sizeof(fp_credentials_t));
    if (!creds) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Generate device ID */
    err = fairplay_device_id_generate(ctx, &creds->device_id);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    /* Save device ID */
    err = fairplay_device_id_save(storage_path, &creds->device_id);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    /* Generate key pair */
    if (key_type == FP_KEY_TYPE_EC) {
        err = fairplay_keypair_generate_ec(ctx, FP_EC_DEFAULT_CURVE,
                                           FP_KEY_FORMAT_PEM, &creds->key_pair);
    } else {
        err = fairplay_keypair_generate_rsa(ctx, FP_RSA_DEFAULT_BITS,
                                            FP_KEY_FORMAT_PEM, &creds->key_pair);
    }
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    /* Save key pair */
    err = fairplay_keypair_save(storage_path, creds->key_pair, false, NULL);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    /* Generate certificate */
    err = fairplay_cert_create_self_signed(ctx, creds->key_pair, &creds->device_id,
                                           FP_CERT_DEFAULT_VALIDITY_YEARS,
                                           FP_KEY_FORMAT_PEM, &creds->certificate);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    /* Save certificate */
    err = fairplay_cert_save(storage_path, creds->certificate);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    new_generated = true;
    
    *out_credentials = creds;
    if (generated_new) *generated_new = new_generated;
    return FP_OK;
}

fp_error_t fairplay_credentials_load(
    const char *storage_path,
    const char *encryption_password,
    fp_credentials_t **out_credentials
) {
    if (!storage_path || !out_credentials) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_credentials_t *creds = calloc(1, sizeof(fp_credentials_t));
    if (!creds) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Load device ID */
    fp_error_t err = fairplay_device_id_load(storage_path, &creds->device_id);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    /* Load key pair */
    err = fairplay_keypair_load_from_storage(storage_path, encryption_password, &creds->key_pair);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    /* Load certificate */
    err = fairplay_cert_load_from_storage(storage_path, &creds->certificate);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        return err;
    }
    
    *out_credentials = creds;
    return FP_OK;
}

fp_error_t fairplay_credentials_reset(const char *storage_path) {
    if (!storage_path) {
        return FP_ERR_NULL_POINTER;
    }
    
    char file_path[1024];
    
    /* Remove device ID file */
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_DEVICE_ID_FILE);
    fp_device_secure_delete(file_path);
    
    /* Remove key files (use secure deletion for private key) */
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_PRIVATE_KEY_FILE);
    fp_device_secure_delete(file_path);
    
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_PUBLIC_KEY_FILE);
    fp_device_secure_delete(file_path);
    
    /* Remove certificate file */
    snprintf(file_path, sizeof(file_path), "%s/%s", storage_path, FP_CERTIFICATE_FILE);
    fp_device_secure_delete(file_path);
    
    return FP_OK;
}

void fairplay_credentials_free(fp_credentials_t *credentials) {
    if (!credentials) return;
    
    fairplay_keypair_free(credentials->key_pair);
    fairplay_cert_free(credentials->certificate);
    fp_device_secure_zero(credentials, sizeof(fp_credentials_t));
    free(credentials);
}

/* =============================================================================
 * Convenience Functions
 * ============================================================================= */

fp_error_t fairplay_quick_device_id(fp_device_id_t *out_id) {
    return fairplay_device_id_generate(NULL, out_id);
}

fp_error_t fairplay_quick_credentials(fp_credentials_t **out_credentials) {
    if (!out_credentials) {
        return FP_ERR_NULL_POINTER;
    }
    
    fp_device_context_t *ctx = NULL;
    fairplay_device_context_create(&ctx);
    
    fp_credentials_t *creds = calloc(1, sizeof(fp_credentials_t));
    if (!creds) {
        fairplay_device_context_destroy(ctx);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    /* Generate device ID */
    fp_error_t err = fairplay_device_id_generate(ctx, &creds->device_id);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Generate RSA key pair */
    err = fairplay_keypair_generate_rsa(ctx, FP_RSA_DEFAULT_BITS,
                                        FP_KEY_FORMAT_PEM, &creds->key_pair);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    /* Generate self-signed certificate */
    err = fairplay_cert_create_self_signed(ctx, creds->key_pair, &creds->device_id,
                                           FP_CERT_DEFAULT_VALIDITY_YEARS,
                                           FP_KEY_FORMAT_PEM, &creds->certificate);
    if (err != FP_OK) {
        fairplay_credentials_free(creds);
        fairplay_device_context_destroy(ctx);
        return err;
    }
    
    fairplay_device_context_destroy(ctx);
    *out_credentials = creds;
    return FP_OK;
}
