/*
 * test_live_exchange.c — Live integration test against Apple's key delivery server.
 *
 * Protocol: POST JSON {"uri":…,"adamId":…} to buy.itunes.apple.com/itcs/key/get
 * Response: JSON {"ckc":"<base64>","ckcId":"…","expirationTime":…}
 *
 * Usage: LD_LIBRARY_PATH=.. ./test_live_exchange [storage_path [skd_uri [adam_id]]]
 *
 * Defaults:
 *   storage_path = ../files/
 *   skd_uri      = skd://itunes.apple.com/p1319066669/c23
 *   adam_id      = extracted from URI (1319066669)
 */

#define _POSIX_C_SOURCE 200809L
#define _DEFAULT_SOURCE

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>

#include "../fairplay.h"
#include "../fp_ckc_parser.h"
#include "../fp_http_client.h"

/* ── helpers ─────────────────────────────────────────────────────────────── */

static char *read_file_trimmed(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    if (sz <= 0) { fclose(f); return NULL; }
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return NULL; }
    size_t n = fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[n] = '\0';
    while (n > 0 && (buf[n-1] == '\n' || buf[n-1] == '\r' || buf[n-1] == ' '))
        buf[--n] = '\0';
    return buf;
}

/*
 * Extract the numeric adamId from a skd://itunes.apple.com/p<id>/… URI.
 * Returns a malloc'd string the caller must free, or NULL on failure.
 */
static char *extract_adam_id(const char *skd_uri) {
    /* Match "skd://itunes.apple.com/p<digits>" */
    const char *prefix = "skd://itunes.apple.com/p";
    if (strncmp(skd_uri, prefix, strlen(prefix)) != 0) {
        /* Also try without subdomain */
        const char *alt = "skd://itunes.apple.com/P";
        if (strncmp(skd_uri, alt, strlen(alt)) != 0) {
            return NULL;
        }
        prefix = alt;
    }
    const char *digits_start = skd_uri + strlen(prefix);
    size_t len = 0;
    while (digits_start[len] >= '0' && digits_start[len] <= '9') len++;
    if (len == 0) return NULL;
    char *id = malloc(len + 1);
    if (!id) return NULL;
    memcpy(id, digits_start, len);
    id[len] = '\0';
    return id;
}

/* ── live probe ──────────────────────────────────────────────────────────── */

static int probe_live_exchange(
    const char *storage_path,
    const char *skd_uri,
    const char *adam_id,
    const char *music_token,
    const char *storefront_id
) {
    /* Load device GUID */
    char guid_path[512];
    snprintf(guid_path, sizeof(guid_path), "%s/device_id", storage_path);
    char *device_guid = read_file_trimmed(guid_path);
    printf("[1] Device GUID : %s\n", device_guid ? device_guid : "(none)");

    /* POST JSON to Apple's key delivery endpoint */
    fp_http_config_t http_config;
    fp_http_config_init(&http_config);

    printf("[2] POST %s\n", http_config.license_server_url);
    printf("    uri     = %s\n", skd_uri);
    printf("    adamId  = %s\n", adam_id);

    fp_http_response_t *response = NULL;
    fp_error_t err = fp_license_exchange(
        &http_config,
        skd_uri,
        adam_id,
        music_token,
        storefront_id,
        device_guid,
        &response);

    free(device_guid);

    if (err != FP_OK) {
        printf("    fp_license_exchange failed: %d (%s)\n",
               err, fairplay_error_string(err));
        if (response) {
            printf("    HTTP %d  content-type: %s\n",
                   response->http_status_code, response->content_type);
            if (response->response_size > 0 && response->response_size < 4096) {
                printf("    Body (%zu bytes): %.*s\n",
                       response->response_size,
                       (int)response->response_size,
                       (char *)response->response_data);
            }
        }
        fp_http_response_free(response);
        return 1;
    }

    printf("[3] HTTP %d  raw body %zu bytes  content-type: %s\n",
           response->http_status_code,
           response->response_size,
           response->content_type);

    if (!response->ckc_data || response->ckc_size == 0) {
        printf("    FAIL no CKC decoded from response\n");
        if (response->response_size > 0 && response->response_size < 4096) {
            printf("    Body: %.*s\n",
                   (int)response->response_size,
                   (char *)response->response_data);
        }
        fp_http_response_free(response);
        return 1;
    }

    printf("[4] CKC decoded from JSON: %zu bytes\n", response->ckc_size);
    printf("    First 16 bytes:");
    size_t dump = response->ckc_size < 16 ? response->ckc_size : 16;
    for (size_t i = 0; i < dump; i++) {
        printf(" %02x", response->ckc_data[i]);
    }
    printf("\n");

    /* Try to parse the binary CKC */
    fp_ckc_t ckc;
    err = fp_ckc_parse(response->ckc_data, response->ckc_size, &ckc);

    if (err != FP_OK) {
        printf("[5] fp_ckc_parse failed: %d (%s)\n", err, fairplay_error_string(err));
        printf("    (Dumping full CKC for manual inspection)\n");
        printf("    Full CKC (%zu bytes):\n    ", response->ckc_size);
        for (size_t i = 0; i < response->ckc_size && i < 256; i++) {
            printf("%02x", response->ckc_data[i]);
            if ((i + 1) % 16 == 0) printf("\n    ");
        }
        printf("\n");
        fp_http_response_free(response);
        return 1;
    }

    fp_http_response_free(response);
    printf("[5] CKC parsed OK  enc_key_size=%zu  expires_at=%llu\n",
           ckc.encrypted_key_size, (unsigned long long)ckc.expires_at);

    /* Print the content key fields (without unwrapping — just verify it's there) */
    printf("[6] CKC enc_key (first 8 bytes):");
    size_t kdump = ckc.encrypted_key_size < 8 ? ckc.encrypted_key_size : 8;
    for (size_t i = 0; i < kdump; i++) {
        printf(" %02x", ckc.encrypted_key[i]);
    }
    printf("...\n");

    fp_ckc_free(&ckc);
    printf("\nRESULT: PASS — CKC received and parsed\n");
    return 0;
}

/* ── main ────────────────────────────────────────────────────────────────── */

int main(int argc, char *argv[]) {
    const char *storage_path = argc > 1 ? argv[1] : "../files/";
    const char *skd_uri      = argc > 2 ? argv[2]
                             : "skd://itunes.apple.com/p1319066669/c23";
    const char *adam_id_arg  = argc > 3 ? argv[3] : NULL;

    printf("=== Live FairPlay Key Delivery Test ===\n\n");
    printf("Storage path : %s\n", storage_path);
    printf("skd:// URI   : %s\n", skd_uri);

    /* Determine adamId */
    char *adam_id_alloc = NULL;
    const char *adam_id;
    if (adam_id_arg && adam_id_arg[0]) {
        adam_id = adam_id_arg;
    } else {
        adam_id_alloc = extract_adam_id(skd_uri);
        adam_id = adam_id_alloc ? adam_id_alloc : "";
    }
    printf("Adam ID      : %s\n\n", adam_id);

    /* Read auth credentials */
    char token_path[512], sf_path[512];
    snprintf(token_path, sizeof(token_path), "%s/MUSIC_TOKEN", storage_path);
    snprintf(sf_path,    sizeof(sf_path),    "%s/STOREFRONT_ID", storage_path);

    char *music_token   = read_file_trimmed(token_path);
    char *storefront_id = read_file_trimmed(sf_path);

    if (!music_token || strlen(music_token) < 20) {
        fprintf(stderr, "ERROR: MUSIC_TOKEN not found or too short at %s\n", token_path);
        free(music_token); free(storefront_id); free(adam_id_alloc);
        return 1;
    }
    if (!storefront_id) {
        fprintf(stderr, "ERROR: STOREFRONT_ID not found at %s\n", sf_path);
        free(music_token); free(storefront_id); free(adam_id_alloc);
        return 1;
    }

    printf("MUSIC_TOKEN  : %.20s... (%zu chars)\n", music_token, strlen(music_token));
    printf("Storefront   : %s\n\n", storefront_id);

    int rc = probe_live_exchange(storage_path, skd_uri, adam_id,
                                 music_token, storefront_id);

    free(music_token);
    free(storefront_id);
    free(adam_id_alloc);
    return rc;
}
