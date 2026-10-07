# Makefile for DRM client clean-room implementation
#
# Builds libdrm_client.so shared library and test executable.

CC = gcc
CFLAGS = -Wall -Wextra -Werror -pedantic -std=c11 -fPIC -O2 -g -Wno-format-truncation
LDFLAGS_LIB = -shared -lpthread -lcrypto -lssl -ldl -Wl,-z,relro,-z,now
LDFLAGS_TEST = -lpthread -lcrypto -lssl -fno-stack-protector

# Core source files
SRCS = drm_client.c fairplay.c fairplay_device.c
OBJS = $(SRCS:.c=.o)

# Target library
TARGET = libdrm_client.so

# Headers
HEADERS = drm_client.h drm_types.h fairplay.h fairplay_device.h

# Test files
TEST_SRC = tests/test_drm_client.c
TEST_TARGET = tests/test_drm_client
TEST_REAL_SRC = tests/test_drm_realworld.c
TEST_REAL_TARGET = tests/test_drm_realworld
LDFLAGS_REAL = -lpthread -lcrypto -lcurl -fno-stack-protector

# Default target
all: $(TARGET) $(TEST_TARGET) $(TEST_REAL_TARGET)

# ── Library link ─────────────────────────────────────────────────────────────

$(TARGET): $(OBJS)
	$(CC) -o $@ $^ $(LDFLAGS_LIB)

# ── Compile rules ─────────────────────────────────────────────────────────────

%.o: %.c $(HEADERS)
	$(CC) $(CFLAGS) -c -o $@ $<

fairplay_device.o: fairplay_device.c $(HEADERS)
	$(CC) $(CFLAGS) -Wno-deprecated-declarations -Wno-stringop-truncation -c -o $@ $<

# ── Tests ─────────────────────────────────────────────────────────────────────

$(TEST_TARGET): $(TEST_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_TEST)

$(TEST_REAL_TARGET): $(TEST_REAL_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_REAL)

# ── Utility targets ───────────────────────────────────────────────────────────

clean:
	rm -f $(OBJS) $(TEST_TARGET) $(TEST_REAL_TARGET) $(TARGET)

release: $(TARGET)
	rm -f $(OBJS)

install: $(TARGET)
	install -d $(DESTDIR)/usr/lib
	install -m 755 $(TARGET) $(DESTDIR)/usr/lib/
	install -d $(DESTDIR)/usr/include
	install -m 644 $(HEADERS) $(DESTDIR)/usr/include/

uninstall:
	rm -f $(DESTDIR)/usr/lib/$(TARGET)
	rm -f $(DESTDIR)/usr/include/drm_client.h
	rm -f $(DESTDIR)/usr/include/drm_types.h

test: $(TEST_TARGET)
	@echo "Running acceptance tests..."
	@LD_LIBRARY_PATH=. $(TEST_TARGET); exit $$?

test-realworld: $(TEST_REAL_TARGET)
	@echo "Running real-world tests..."
	@LD_LIBRARY_PATH=. $(TEST_REAL_TARGET); exit $$?

test-all:
	@echo "========================================"
	@echo "Running ALL Tests"
	@echo "========================================"
	@LD_LIBRARY_PATH=. $(TEST_TARGET) && \
	echo "" && \
	echo "========================================" && \
	echo "Running Real-World Tests" && \
	echo "========================================" && \
	LD_LIBRARY_PATH=. $(TEST_REAL_TARGET)

analyze:
	clang-analyze $(CFLAGS) -c $(SRCS)

format-check:
	clang-format --dry-run --Werror $(SRCS) $(HEADERS) $(TEST_SRC)

format:
	clang-format -i $(SRCS) $(HEADERS) $(TEST_SRC)

valgrind-test: $(TEST_TARGET)
	valgrind --leak-check=full --show-leak-kinds=all \
		LD_LIBRARY_PATH=. $(TEST_TARGET)

coverage: CFLAGS += --coverage
coverage: LDFLAGS_LIB += --coverage
coverage: LDFLAGS_TEST += --coverage
coverage: clean all

.PHONY: all clean release install uninstall test test-realworld test-all \
        analyze format-check format valgrind-test coverage
