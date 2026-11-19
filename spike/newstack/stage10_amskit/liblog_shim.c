/* Android liblog shim for use on Linux.
 * libAMSKit.so links against liblog.so for __android_log_print etc.
 * We provide no-op / stderr-forwarding stubs so the library loads cleanly.
 */
#include <stdio.h>
#include <stdarg.h>
#include <sys/types.h>

/* Android log priorities */
#define ANDROID_LOG_VERBOSE 2
#define ANDROID_LOG_DEBUG   3
#define ANDROID_LOG_INFO    4
#define ANDROID_LOG_WARN    5
#define ANDROID_LOG_ERROR   6
#define ANDROID_LOG_FATAL   7

int __android_log_print(int prio, const char *tag, const char *fmt, ...) {
    if (prio >= ANDROID_LOG_WARN) {
        va_list ap; va_start(ap, fmt);
        fprintf(stderr, "[%s] ", tag ? tag : "?");
        vfprintf(stderr, fmt, ap);
        fprintf(stderr, "\n");
        va_end(ap);
    }
    return 0;
}

int __android_log_write(int prio, const char *tag, const char *text) {
    if (prio >= ANDROID_LOG_WARN)
        fprintf(stderr, "[%s] %s\n", tag ? tag : "?", text ? text : "");
    return 0;
}

int __android_log_vprint(int prio, const char *tag, const char *fmt, va_list ap) {
    if (prio >= ANDROID_LOG_WARN) {
        fprintf(stderr, "[%s] ", tag ? tag : "?");
        vfprintf(stderr, fmt, ap);
        fprintf(stderr, "\n");
    }
    return 0;
}

void __android_log_assert(const char *cond, const char *tag, const char *fmt, ...) {
    fprintf(stderr, "[%s] ASSERT(%s) ", tag ? tag : "?", cond ? cond : "");
    if (fmt) {
        va_list ap; va_start(ap, fmt);
        vfprintf(stderr, fmt, ap);
        va_end(ap);
    }
    fprintf(stderr, "\n");
}

/* __android_log_buf_write, __android_log_buf_print — also no-ops */
int __android_log_buf_write(int bufID, int prio, const char *tag, const char *text) {
    return __android_log_write(prio, tag, text);
}
int __android_log_buf_print(int bufID, int prio, const char *tag, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    int r = __android_log_vprint(prio, tag, fmt, ap);
    va_end(ap); return r;
}

/* log_id_t logger_write shim */
int android_logger_list_read(void *logger_list, void *log_msg) { return -1; }
void android_logger_list_free(void *logger_list) {}
void *android_logger_list_alloc(int mode, unsigned int tail_lines, pid_t pid) { return 0; }
void *android_logger_list_alloc_time(int mode, unsigned long long start, pid_t pid) { return 0; }
void *android_logger_open(void *logger_list, int id) { return 0; }
int android_logger_get_log_size(void *logger) { return 0; }
int android_logger_get_log_readable_size(void *logger) { return 0; }
