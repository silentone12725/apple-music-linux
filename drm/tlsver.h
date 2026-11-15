/* TLS version policy for the Android libcurl handles hooked in drm_hybris.c. Pure, so it can be unit tested. */
#ifndef ADAM_TLSVER_H
#define ADAM_TLSVER_H

#define CURLOPT_URL_VAL         10002
#define CURLOPT_SSLVERSION_VAL  32
#define CURL_SSLVERSION_TLSv1_3 7
#define CURL_SSLVERSION_MASK    0xffff

/* The CURLOPT_SSLVERSION value to apply for a setopt call: 1.3 as the minimum, keeping any max-version bits the caller set.
 * Returns -1 when the call needs no change. */
static long tls13_sslversion(int option, long param)
{
    if (option == CURLOPT_URL_VAL) return CURL_SSLVERSION_TLSv1_3;
    if (option == CURLOPT_SSLVERSION_VAL && (param & CURL_SSLVERSION_MASK) < CURL_SSLVERSION_TLSv1_3)
        return (param & ~(long)CURL_SSLVERSION_MASK) | CURL_SSLVERSION_TLSv1_3;
    return -1;
}

#endif
