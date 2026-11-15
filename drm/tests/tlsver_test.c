#include "../tlsver.h"

#include <stdio.h>

static int fails;
#define CHECK(c)                                                 \
    do {                                                         \
        if (!(c)) {                                              \
            fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #c); \
            fails++;                                             \
        }                                                        \
    } while (0)

int main(void)
{
    CHECK(tls13_sslversion(CURLOPT_URL_VAL, 0) == CURL_SSLVERSION_TLSv1_3);
    CHECK(tls13_sslversion(CURLOPT_SSLVERSION_VAL, 0) == CURL_SSLVERSION_TLSv1_3); /* default */
    CHECK(tls13_sslversion(CURLOPT_SSLVERSION_VAL, 5) == CURL_SSLVERSION_TLSv1_3); /* min 1.2 */
    CHECK(tls13_sslversion(CURLOPT_SSLVERSION_VAL, 6) == CURL_SSLVERSION_TLSv1_3); /* min 1.2 as TLSv1_2 */
    CHECK(tls13_sslversion(CURLOPT_SSLVERSION_VAL, 7) == -1);                      /* already 1.3 */
    CHECK(tls13_sslversion(CURLOPT_SSLVERSION_VAL, 0x70000 | 4) == (0x70000 | 7)); /* keeps the max-version bits */
    CHECK(tls13_sslversion(CURLOPT_SSLVERSION_VAL, 0x70000 | 7) == -1);
    CHECK(tls13_sslversion(20011, 4) == -1); /* other options untouched */
    if (!fails) puts("tls version tests passed");
    return fails != 0;
}
