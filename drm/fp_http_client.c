/*
 * fp_http_client.c - HTTP License Exchange Client Implementation
 *
 * Version: 2.0
 * Date: 2026-10-08
 *
 * Clean-room implementation of Apple's streaming key delivery protocol.
 * Independently authored by AML DRM Team.
 *
 * Protocol: POST JSON {"challenge":…,"key-system":"com.widevine.alpha",…}
 * to play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense
 * Response: JSON {"ckc":"<base64>","ckcId":"…","expirationTime":…}
 */

#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L

#include "fp_http_client.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/time.h>

#include <curl/curl.h>
#include <openssl/bio.h>
#include <openssl/evp.h>
#include <openssl/buffer.h>

/* =============================================================================
 * Callback Data Structure
 * ============================================================================= */

typedef struct {
    uint8_t *data;
    size_t size;
    size_t capacity;
} http_response_buffer_t;

/* =============================================================================
 * Helper Functions
 * ============================================================================= */

static size_t http_response_callback(
    void *ptr,
    size_t size,
    size_t nmemb,
    void *userp
) {
    http_response_buffer_t *buf = (http_response_buffer_t *)userp;
    size_t data_size = size * nmemb;

    if (buf->size + data_size > buf->capacity) {
        size_t new_capacity = buf->capacity * 2;
        if (new_capacity < data_size + 1024) {
            new_capacity = data_size + 1024;
        }
        uint8_t *new_data = realloc(buf->data, new_capacity);
        if (!new_data) {
            return 0;
        }
        buf->data = new_data;
        buf->capacity = new_capacity;
    }

    memcpy(buf->data + buf->size, ptr, data_size);
    buf->size += data_size;
    return data_size;
}

/* D9 fix: do not write into libcurl's read-only buffer */
static size_t http_header_callback(
    void *ptr,
    size_t size,
    size_t nmemb,
    void *userp
) {
    fp_http_response_t *response = (fp_http_response_t *)userp;
    size_t header_len = size * nmemb;

    if (header_len < 2) {
        return header_len;
    }

    const char *header = (const char *)ptr;

    if (strncasecmp(header, "Content-Type:", 13) == 0) {
        const char *value = header + 13;
        while (value < header + header_len && *value == ' ') value++;
        size_t value_len = header_len - (size_t)(value - header);
        while (value_len > 0 && (value[value_len-1] == '\r' || value[value_len-1] == '\n')) {
            value_len--;
        }
        if (value_len > 0 && value_len < sizeof(response->content_type)) {
            memcpy(response->content_type, value, value_len);
            response->content_type[value_len] = '\0';
        }
    }

    if (strncasecmp(header, "X-Request-ID:", 13) == 0) {
        const char *value = header + 13;
        while (value < header + header_len && *value == ' ') value++;
        size_t value_len = header_len - (size_t)(value - header);
        while (value_len > 0 && (value[value_len-1] == '\r' || value[value_len-1] == '\n')) {
            value_len--;
        }
        if (value_len > 0 && value_len < sizeof(response->x_request_id)) {
            memcpy(response->x_request_id, value, value_len);
            response->x_request_id[value_len] = '\0';
        }
    }

    return header_len;
}

/*
 * Extract and base64-decode the "ckc" field from JSON:
 *   {"ckc":"<base64>","ckcId":"…","expirationTime":…}
 *
 * Writes decoded binary into response->ckc_data / ckc_size.
 * Returns FP_OK, FP_ERR_CKC_PARSE_FAILED, or FP_ERR_OUT_OF_MEMORY.
 */
static fp_error_t parse_ckc_from_json(
    const uint8_t *json,
    size_t json_size,
    fp_http_response_t *response
) {
    /* Locate the "ckc" key */
    const char *p = (const char *)json;
    size_t remaining = json_size;

    const char *ckc_key = "\"ckc\"";
    const char *found = NULL;
    while (remaining >= strlen(ckc_key)) {
        if (strncmp(p, ckc_key, strlen(ckc_key)) == 0) {
            found = p;
            break;
        }
        p++;
        remaining--;
    }
    if (!found) {
        return FP_ERR_CKC_PARSE_FAILED;
    }

    /* Skip past "ckc" and optional whitespace/colon */
    p = found + strlen(ckc_key);
    remaining = json_size - (size_t)(p - (const char *)json);
    while (remaining > 0 && (*p == ' ' || *p == '\t' || *p == ':')) {
        p++;
        remaining--;
    }
    if (remaining == 0 || *p != '"') {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    p++;  /* skip opening quote */
    remaining--;

    /* Find closing quote */
    const char *b64_start = p;
    size_t b64_len = 0;
    while (remaining > 0 && *p != '"') {
        p++;
        remaining--;
        b64_len++;
    }
    if (remaining == 0) {
        return FP_ERR_CKC_PARSE_FAILED;
    }
    if (b64_len == 0) {
        return FP_ERR_CKC_PARSE_FAILED;
    }

    /* Base64 decode */
    BIO *b64 = BIO_new(BIO_f_base64());
    BIO *mem = BIO_new_mem_buf(b64_start, (int)b64_len);
    if (!b64 || !mem) {
        if (b64) BIO_free(b64);
        if (mem) BIO_free(mem);
        return FP_ERR_OUT_OF_MEMORY;
    }
    BIO_set_flags(b64, BIO_FLAGS_BASE64_NO_NL);
    BIO_push(b64, mem);

    /* Allocate output buffer (base64 expands by ~4/3) */
    size_t max_decoded = (b64_len * 3) / 4 + 4;
    uint8_t *decoded = malloc(max_decoded);
    if (!decoded) {
        BIO_free_all(b64);
        return FP_ERR_OUT_OF_MEMORY;
    }

    int decoded_len = BIO_read(b64, decoded, (int)max_decoded);
    BIO_free_all(b64);

    if (decoded_len <= 0) {
        free(decoded);
        return FP_ERR_CKC_PARSE_FAILED;
    }

    response->ckc_data = decoded;
    response->ckc_size = (size_t)decoded_len;
    return FP_OK;
}

/* =============================================================================
 * Public API Functions
 * ============================================================================= */

void fp_http_config_init(fp_http_config_t *config) {
    if (!config) return;

    memset(config, 0, sizeof(fp_http_config_t));

    config->license_server_url = FP_LICENSE_SERVER_URL;
    config->user_agent = "AppleMusicLinux/2.0 (Linux; x86_64)";
    config->timeout_seconds = FP_HTTP_TIMEOUT_SECONDS;
    config->max_retries = FP_HTTP_MAX_RETRIES;
    config->retry_backoff_ms = FP_HTTP_RETRY_BACKOFF_MS;
    config->verify_ssl = true;
    config->proxy_host = NULL;
    config->proxy_port = 0;
}

void fp_http_response_free(fp_http_response_t *response) {
    if (!response) return;

    if (response->response_data) {
        fairplay_secure_zero(response->response_data, response->response_size);
        free(response->response_data);
        response->response_data = NULL;
    }
    if (response->ckc_data) {
        fairplay_secure_zero(response->ckc_data, response->ckc_size);
        free(response->ckc_data);
        response->ckc_data = NULL;
    }

    memset(response, 0, sizeof(fp_http_response_t));
}

bool fp_http_is_success(int status_code) {
    return status_code >= 200 && status_code < 300;
}

bool fp_http_should_retry(int status_code) {
    return (status_code >= 500 && status_code < 600) || status_code == 429;
}

fp_error_t fp_license_exchange(
    const fp_http_config_t *config,
    const char *media_uri,
    const char *adam_id,
    const char *auth_token,
    const char *storefront_id,
    const char *device_guid,
    fp_http_response_t **out_response
) {
    if (!config || !media_uri || !out_response) {
        return FP_ERR_NULL_POINTER;
    }

    const char *url = config->license_server_url;
    if (!url || strlen(url) == 0) {
        url = FP_LICENSE_SERVER_URL;
    }

    fp_http_response_t *response = calloc(1, sizeof(fp_http_response_t));
    if (!response) {
        return FP_ERR_OUT_OF_MEMORY;
    }

    /*
     * Build JSON body:
     *   {"uri":"<media_uri>","adamId":"<adam_id>",
     *    "key-system":"com.apple.streamingkeydelivery",
     *    "isLibrary":false,"user-initiated":true}
     */
    const char *aid = (adam_id && adam_id[0]) ? adam_id : "";
    /* Worst-case size: fixed JSON skeleton + URI + adamId */
    size_t body_len = strlen(media_uri) + strlen(aid) + 128;
    char *post_body = malloc(body_len);
    if (!post_body) {
        free(response);
        return FP_ERR_OUT_OF_MEMORY;
    }
    int bi = snprintf(post_body, body_len,
        "{\"uri\":\"%s\",\"adamId\":\"%s\","
        "\"key-system\":\"com.apple.streamingkeydelivery\","
        "\"isLibrary\":false,\"user-initiated\":true}",
        media_uri, aid);

    http_response_buffer_t buffer = {0};

    CURL *curl = curl_easy_init();
    if (!curl) {
        free(post_body);
        free(response);
        return FP_ERR_OUT_OF_MEMORY;
    }

    fp_error_t err = FP_OK;
    int retry_count = 0;

    while (retry_count <= config->max_retries) {
        curl_easy_reset(curl);

        curl_easy_setopt(curl, CURLOPT_URL, url);
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, post_body);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)bi);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, (long)config->timeout_seconds);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, config->verify_ssl ? 1L : 0L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, config->verify_ssl ? 2L : 0L);

        struct curl_slist *headers = NULL;
        headers = curl_slist_append(headers, "Content-Type: application/json");
        headers = curl_slist_append(headers, "Accept: application/json");

        if (config->user_agent) {
            char ua_header[512];
            snprintf(ua_header, sizeof(ua_header), "User-Agent: %s", config->user_agent);
            headers = curl_slist_append(headers, ua_header);
        }

        if (auth_token && strlen(auth_token) > 0) {
            char auth_header[512];
            snprintf(auth_header, sizeof(auth_header), "Authorization: Bearer %s", auth_token);
            headers = curl_slist_append(headers, auth_header);
        }

        if (storefront_id && strlen(storefront_id) > 0) {
            char sf_header[256];
            snprintf(sf_header, sizeof(sf_header), "X-Storefront: %s", storefront_id);
            headers = curl_slist_append(headers, sf_header);
        }

        if (device_guid && strlen(device_guid) > 0) {
            char guid_header[256];
            snprintf(guid_header, sizeof(guid_header), "X-Device-GUID: %s", device_guid);
            headers = curl_slist_append(headers, guid_header);
        }

        curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, http_response_callback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buffer);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, http_header_callback);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, response);

        CURLcode curl_err = curl_easy_perform(curl);

        long http_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
        if (http_code >= 100 && http_code <= 599) {
            response->http_status_code = (int)http_code;
        } else {
            response->http_status_code = 0;
        }

        curl_slist_free_all(headers);

        if (curl_err == CURLE_OK && fp_http_is_success(response->http_status_code)) {
            response->response_data = buffer.data;
            response->response_size = buffer.size;
            buffer.data = NULL;
            break;
        }

        bool should_retry = (retry_count < config->max_retries) &&
                            (curl_err == CURLE_OPERATION_TIMEDOUT ||
                             curl_err == CURLE_COULDNT_CONNECT ||
                             fp_http_should_retry(response->http_status_code));

        if (!should_retry) {
            if (curl_err == CURLE_OPERATION_TIMEDOUT) {
                err = FP_ERR_NETWORK_TIMEOUT;
            } else if (curl_err != CURLE_OK) {
                err = FP_ERR_LICENSE_REQUEST_FAILED;
            } else {
                err = FP_ERR_HTTP_ERROR;
            }
            break;
        }

        retry_count++;
        usleep((useconds_t)(config->retry_backoff_ms * retry_count * 1000));

        if (buffer.data) {
            free(buffer.data);
            buffer.data = NULL;
        }
        buffer.size = 0;
        buffer.capacity = 0;
    }

    curl_easy_cleanup(curl);
    free(post_body);

    if (err != FP_OK) {
        /* Preserve response for diagnostics */
        if (buffer.data) {
            response->response_data = buffer.data;
            response->response_size = buffer.size;
            buffer.data = NULL;
        }
        *out_response = response;
        return err;
    }

    /* Parse CKC from JSON response */
    fp_error_t ckc_err = parse_ckc_from_json(
        response->response_data, response->response_size, response);
    if (ckc_err != FP_OK) {
        /* Still return the raw response so callers can inspect the body */
        response->ckc_data = NULL;
        response->ckc_size = 0;
        *out_response = response;
        return ckc_err;
    }

    *out_response = response;
    return FP_OK;
}
