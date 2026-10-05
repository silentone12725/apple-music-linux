/* Exercises drm_https_fetch and the cookie jar against https_server.py.
 * Usage: https_fetch_test PORT COOKIE_DIR
 * Needs SSL_CERT_FILE=<server cert> and AML_HTTPS_TIMEOUT_SEC=2. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include "../drm_client.h"

static int failures, checks;
static char base[64];

#define CHECK(cond, ...) do { checks++; if (!(cond)) { failures++; printf("  FAIL line %d: ", __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

struct res { int rc, status; uint8_t *data; uint32_t len; };

static struct res fetch(const char *method, const char *path, const char *body)
{
    char url[256];
    snprintf(url, sizeof(url), "%s%s", base, path);
    struct res r = {0};
    r.rc = drm_https_fetch(url, method, (const uint8_t *)body, body ? (uint32_t)strlen(body) : 0,
                           &r.data, &r.len, &r.status);
    return r;
}

static int body_is(const struct res *r, const char *want)
{
    return r->rc == 0 && r->len == strlen(want) && (r->len == 0 || memcmp(r->data, want, r->len) == 0);
}

static int body_has(const struct res *r, const char *sub)
{
    if (r->rc != 0 || !r->data) return 0;
    char *copy = calloc(1, r->len + 1);
    memcpy(copy, r->data, r->len);
    int has = strstr(copy, sub) != NULL;
    free(copy);
    return has;
}

static int count_of(const char *needle, const struct res *r)
{
    char *copy = calloc(1, r->len + 1);
    memcpy(copy, r->data, r->len);
    int n = 0;
    for (char *p = copy; (p = strstr(p, needle)); p += strlen(needle)) n++;
    free(copy);
    return n;
}

static int number(const char *path)
{
    struct res r = fetch("GET", path, NULL);
    int v = r.rc == 0 && r.len ? atoi((char *)r.data) : -1;
    free(r.data);
    return v;
}

static void freeres(struct res *r) { free(r->data); r->data = NULL; }

int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    if (argc < 3) return 2;
    snprintf(base, sizeof(base), "https://localhost:%s", argv[1]);
    const char *cookie_dir = argv[2];

    if (drm_https_init(0) != 0) { printf("https init failed\n"); return 2; }

    printf("framing\n");
    int c0 = number("/conns");
    struct res r;
    for (int i = 0; i < 3; i++) { r = fetch("GET", "/len", NULL); CHECK(body_is(&r, "hello") && r.status == 200, "/len #%d", i); freeres(&r); }
    CHECK(number("/conns") == c0, "keep-alive: connection reused (%d vs %d)", number("/conns"), c0);

    time_t t0 = time(NULL);
    r = fetch("GET", "/lower", NULL);
    CHECK(body_is(&r, "hello"), "lowercase content-length");
    CHECK(time(NULL) - t0 < 2, "lowercase content-length must not wait for the server to close");
    freeres(&r);

    r = fetch("GET", "/chunked", NULL); CHECK(body_is(&r, "chunk1chunk2"), "chunked body decoded (len %u)", r.len); freeres(&r);
    r = fetch("GET", "/close", NULL);   CHECK(body_is(&r, "closebody"), "close-delimited body (len %u)", r.len); freeres(&r);
    r = fetch("GET", "/len", NULL);     CHECK(body_is(&r, "hello"), "fresh connection after a close-delimited response"); freeres(&r);

    printf("redirects\n");
    r = fetch("GET", "/redirect", NULL);     CHECK(body_is(&r, "hello") && r.status == 200, "relative redirect followed (status %d)", r.status); freeres(&r);
    r = fetch("GET", "/redirect-abs", NULL); CHECK(body_is(&r, "hello") && r.status == 200, "absolute redirect followed"); freeres(&r);
    r = fetch("GET", "/redirect-http", NULL);CHECK(r.rc == 0 && r.status == 302, "redirect to http:// is handed back, not followed (status %d)", r.status); freeres(&r);
    r = fetch("GET", "/loop", NULL);         CHECK(r.rc == 0 && r.status == 302, "redirect loop stops (status %d)", r.status); freeres(&r);
    r = fetch("POST", "/post303", "x");      CHECK(body_is(&r, "GET"), "303 turns POST into GET"); freeres(&r);

    printf("limits and failures\n");
    r = fetch("GET", "/big", NULL); CHECK(r.rc != 0, "40 MB response refused (rc %d)", r.rc); freeres(&r);
    r = fetch("GET", "/trunc", NULL);
    CHECK(r.rc != 0, "truncated body is an error, not a short success"); freeres(&r);
    CHECK(number("/hits/trunc") == 3, "GET retried on truncation (%d hits)", number("/hits/trunc"));
    r = fetch("POST", "/post-trunc", "x");
    CHECK(r.rc != 0, "truncated POST response is an error"); freeres(&r);
    CHECK(number("/hits/post-trunc") == 1, "POST not repeated once the server answered (%d hits)", number("/hits/post-trunc"));

    t0 = time(NULL);
    r = fetch("GET", "/slow", NULL);
    CHECK(r.rc != 0, "stalled server times out"); freeres(&r);
    CHECK(time(NULL) - t0 < 15, "timeout is bounded (%ld s)", (long)(time(NULL) - t0));

    printf("stale pooled connections\n");
    r = fetch("GET", "/dropafter", NULL); CHECK(body_is(&r, "first"), "dropafter"); freeres(&r);
    r = fetch("GET", "/len", NULL);       CHECK(body_is(&r, "hello"), "GET retried on a fresh connection"); freeres(&r);
    r = fetch("GET", "/dropafter", NULL); freeres(&r);
    r = fetch("POST", "/echo", "abc");    CHECK(body_is(&r, "abc"), "POST retried when nothing came back"); freeres(&r);

    printf("headers\n");
    r = fetch("GET", "/auth-echo", NULL); CHECK(body_is(&r, "no"), "no bearer token sent to a non-Apple host"); freeres(&r);
    char want_host[64]; snprintf(want_host, sizeof(want_host), "localhost:%s", argv[1]);
    r = fetch("GET", "/host-echo", NULL); CHECK(body_is(&r, want_host), "Host carries a non-default port"); freeres(&r);

    printf("URL validation\n");
    uint8_t *d; uint32_t l; int st;
    CHECK(drm_https_fetch("http://localhost/len", "GET", NULL, 0, &d, &l, &st) != 0, "http:// refused");
    CHECK(drm_https_fetch("https://user@localhost/len", "GET", NULL, 0, &d, &l, &st) != 0, "userinfo refused");
    CHECK(drm_https_fetch("https://localhost/a b", "GET", NULL, 0, &d, &l, &st) != 0, "space in URL refused");
    CHECK(drm_https_fetch("https://localhost/a\r\nX: y", "GET", NULL, 0, &d, &l, &st) != 0, "CRLF in URL refused");
    CHECK(drm_https_fetch("https://localhost:99999/", "GET", NULL, 0, &d, &l, &st) != 0, "bad port refused");
    CHECK(drm_https_fetch("https://localhost/len", "GE T", NULL, 0, &d, &l, &st) != 0, "bad method refused");

    printf("cookies\n");
    CHECK(drm_cookie_init_at(cookie_dir) == 0, "cookie init");
    r = fetch("GET", "/cookie-set", NULL); freeres(&r);
    r = fetch("GET", "/cookie-echo", NULL);
    CHECK(body_has(&r, "a=1") && body_has(&r, "f=6"), "host cookies sent");
    CHECK(!body_has(&r, "b=2"), "cookie scoped to /sub is not sent to /");
    CHECK(!body_has(&r, "c=3") && !body_has(&r, "d=4") && !body_has(&r, "e=5"), "Domain attributes the host doesn't belong to are rejected");
    freeres(&r);
    r = fetch("GET", "/sub/echo", NULL); CHECK(body_has(&r, "b=2") && body_has(&r, "a=1"), "path-scoped cookie sent under /sub"); freeres(&r);

    char buf[512];
    drm_cookie_get_for_url("https://evillocalhost/", buf, sizeof(buf));        CHECK(buf[0] == '\0', "host-only cookie not sent to evillocalhost");
    drm_cookie_get_for_url("https://localhost.evil.com/", buf, sizeof(buf));   CHECK(buf[0] == '\0', "host-only cookie not sent to localhost.evil.com");

    char file[512]; snprintf(file, sizeof(file), "%s/cookies.txt", cookie_dir);
    struct stat sb;
    CHECK(stat(file, &sb) == 0 && (sb.st_mode & 0777) == 0600, "cookie file is mode 0600 (%o)", stat(file, &sb) == 0 ? sb.st_mode & 0777 : 0);

    r = fetch("GET", "/cookie-update", NULL); freeres(&r);
    r = fetch("GET", "/cookie-echo", NULL);
    CHECK(body_has(&r, "a=updated") && count_of("a=", &r) == 1, "same-name cookie replaced, not duplicated");
    CHECK(!body_has(&r, "f="), "Max-Age=0 deletes the cookie");
    freeres(&r);

    drm_cookie_shutdown();
    CHECK(drm_cookie_init_at(cookie_dir) == 0, "reload");
    r = fetch("GET", "/cookie-echo", NULL); CHECK(body_has(&r, "a=updated"), "jar survives a restart"); freeres(&r);

    drm_https_shutdown();
    printf("\n%d checks, %d failed\n", checks, failures);
    return failures ? 1 : 0;
}
