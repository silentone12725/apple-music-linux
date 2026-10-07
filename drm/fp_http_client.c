/*
 * fp_http_client.c - HTTP License Exchange Client Implementation
 * 
 * Version: 1.0
 * Date: 2026-10-07
 * 
 * Clean-room implementation of FairPlay HTTP license exchange.
 * Independently authored by AML DRM Team.
 *
 * Based on specification: drm/CLEANROOM_IMPLEMENTATION_PROMPT.md v1.1
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

/**
 * HTTP response body callback for libcurl.
 */
static size_t http_response_callback(
    void *ptr,
    size_t size,
    size_t nmemb,
    void *userp
) {
    http_response_buffer_t *buf = (http_response_buffer_t *)userp;
    size_t data_size = size * nmemb;
    
    /* Expand buffer if needed */
    if (buf->size + data_size > buf->capacity) {
        size_t new_capacity = buf->capacity * 2;
        if (new_capacity < data_size + 1024) {
            new_capacity = data_size + 1024;
        }
        
        uint8_t *new_data = realloc(buf->data, new_capacity);
        if (!new_data) {
            return 0;  /* Out of memory */
        }
        
        buf->data = new_data;
        buf->capacity = new_capacity;
    }
    
    /* Append data */
    memcpy(buf->data + buf->size, ptr, data_size);
    buf->size += data_size;
    
    return data_size;
}

/**
 * HTTP header callback for libcurl.
 * D9 fix: Do not write into libcurl's read-only buffer.
 */
static size_t http_header_callback(
    void *ptr,
    size_t size,
    size_t nmemb,
    void *userp
) {
    fp_http_response_t *response = (fp_http_response_t *)userp;
    size_t header_len = size * nmemb;
    
    /* Skip HTTP status line and empty lines */
    if (header_len < 2) {
        return header_len;
    }
    
    const char *header = (const char *)ptr;
    
    /* Check for Content-Type header */
    if (strncasecmp(header, "Content-Type:", 13) == 0) {
        const char *value = header + 13;
        while (value < header + header_len && *value == ' ') value++;
        /* Use header_len arithmetic — libcurl buffer is not null-terminated */
        size_t value_len = header_len - (size_t)(value - header);
        while (value_len > 0 && (value[value_len-1] == '\r' || value[value_len-1] == '\n')) {
            value_len--;
        }
        if (value_len > 0 && value_len < sizeof(response->content_type)) {
            memcpy(response->content_type, value, value_len);
            response->content_type[value_len] = '\0';
        }
    }

    /* Check for X-Request-ID header */
    if (strncasecmp(header, "X-Request-ID:", 13) == 0) {
        const char *value = header + 13;
        while (value < header + header_len && *value == ' ') value++;
        /* Use header_len arithmetic — libcurl buffer is not null-terminated */
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
    
    memset(response, 0, sizeof(fp_http_response_t));
}

bool fp_http_is_success(int status_code) {
    return status_code >= 200 && status_code < 300;
}

bool fp_http_should_retry(int status_code) {
    /* Retry on 5xx server errors and 429 Too Many Requests */
    return (status_code >= 500 && status_code < 600) || status_code == 429;
}

fp_error_t fp_license_exchange(
    const fp_http_config_t *config,
    const uint8_t *spc,
    size_t spc_size,
    const char *auth_token,
    const char *storefront_id,
    const char *device_guid,
    fp_http_response_t **out_response
) {
    if (!config || !spc || !out_response) {
        return FP_ERR_NULL_POINTER;
    }
    
    const char *url = config->license_server_url;
    if (!url || strlen(url) == 0) {
        url = FP_LICENSE_SERVER_URL;
    }
    
    /* Initialize response structure */
    fp_http_response_t *response = calloc(1, sizeof(fp_http_response_t));
    if (!response) {
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    http_response_buffer_t buffer = {0};
    
    CURL *curl = curl_easy_init();
    if (!curl) {
        free(response);
        return FP_ERR_OUT_OF_MEMORY;
    }
    
    fp_error_t err = FP_OK;
    int retry_count = 0;
    
    while (retry_count <= config->max_retries) {
        /* Setup curl options */
        curl_easy_reset(curl);
        
        curl_easy_setopt(curl, CURLOPT_URL, url);
        curl_easy_setopt(curl, CURLOPT_POST, 1L);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, spc);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)spc_size);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, config->timeout_seconds);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, config->verify_ssl ? 1L : 0L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, config->verify_ssl ? 2L : 0L);
        
        /* Setup headers */
        struct curl_slist *headers = NULL;
        headers = curl_slist_append(headers, "Content-Type: application/octet-stream");
        headers = curl_slist_append(headers, "Accept: application/octet-stream");
        
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
        
        /* Setup callbacks */
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, http_response_callback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buffer);
        curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, http_header_callback);
        curl_easy_setopt(curl, CURLOPT_HEADERDATA, response);
        
        /* Perform request */
        CURLcode curl_err = curl_easy_perform(curl);
        
        /* Get response code (D8 fix: use long for CURLINFO_RESPONSE_CODE) */
        long http_code = 0;
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &http_code);
        /* Range-check and assign to int field */
        if (http_code >= 100 && http_code <= 599) {
            response->http_status_code = (int)http_code;
        } else {
            response->http_status_code = 0;
        }
        
        /* Cleanup headers */
        curl_slist_free_all(headers);
        
        /* Check for success */
        if (curl_err == CURLE_OK && fp_http_is_success(response->http_status_code)) {
            /* Success! */
            response->response_data = buffer.data;
            response->response_size = buffer.size;
            break;
        }
        
        /* Check if we should retry */
        bool should_retry = (retry_count < config->max_retries) &&
                           (curl_err == CURLE_OPERATION_TIMEDOUT ||
                            curl_err == CURLE_COULDNT_CONNECT ||
                            fp_http_should_retry(response->http_status_code));
        
        if (!should_retry) {
            /* Determine error */
            if (curl_err != CURLE_OK) {
                if (curl_err == CURLE_OPERATION_TIMEDOUT) {
                    err = FP_ERR_NETWORK_TIMEOUT;
                } else {
                    err = FP_ERR_LICENSE_REQUEST_FAILED;
                }
            } else if (response->http_status_code == 401) {
                err = FP_ERR_LICENSE_REQUEST_FAILED;  /* Unauthorized */
            } else if (response->http_status_code == 403) {
                err = FP_ERR_LICENSE_REQUEST_FAILED;  /* Forbidden */
            } else {
                err = FP_ERR_HTTP_ERROR;
            }
            break;
        }
        
        /* Retry with backoff */
        retry_count++;
        int backoff_ms = config->retry_backoff_ms * retry_count;
        usleep(backoff_ms * 1000);
        
        /* Reset buffer for retry */
        if (buffer.data) {
            free(buffer.data);
            buffer.data = NULL;
        }
        buffer.size = 0;
        buffer.capacity = 0;
    }
    
    curl_easy_cleanup(curl);
    
    if (err != FP_OK) {
        if (buffer.data) {
            free(buffer.data);
        }
        free(response);
        *out_response = NULL;
        return err;
    }
    
    *out_response = response;
    return FP_OK;
}
