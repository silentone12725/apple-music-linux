# Makefile for DRM client clean-room implementation
#
# Builds libdrm_client.so shared library and test executable.

CC = gcc
CFLAGS = -Wall -Wextra -Werror -pedantic -std=c11 -fPIC -O2 -g -Wno-format-truncation
LDFLAGS_LIB = -shared -lpthread -lcrypto -lssl -ldl -lcurl -Wl,-z,relro,-z,now
LDFLAGS_TEST = -lpthread -lcrypto -lssl -fno-stack-protector

# Core source files
SRCS = drm_client.c drm_linux.c fairplay.c fairplay_device.c \
       fp_spc_builder.c fp_ckc_parser.c fp_key_unwrapper.c \
       fp_http_client.c fp_license_exchange.c
OBJS = $(SRCS:.c=.o)

# Target library
TARGET = libdrm_client.so

# Headers
HEADERS = drm_client.h drm_types.h fairplay.h fairplay_device.h \
          fp_spc_builder.h fp_ckc_parser.h fp_key_unwrapper.h \
          fp_http_client.h fp_license_exchange.h

# Linux shim compilation rule
drm_linux.o: drm_linux.c drm_types.h fairplay.h
	$(CC) $(CFLAGS) -c $< -o $@

# Test files
TEST_SRC = tests/test_fairplay.c
TEST_TARGET = tests/test_fairplay
TEST_DEVICE_SRC = tests/test_device.c
TEST_DEVICE_TARGET = tests/test_device
TEST_EXCHANGE_SRC = tests/test_fp_exchange.c
TEST_EXCHANGE_TARGET = tests/test_fp_exchange
TEST_LIVE_SRC = tests/test_live_exchange.c
TEST_LIVE_TARGET = tests/test_live_exchange
LDFLAGS_REAL = -lpthread -lcrypto -lcurl -fno-stack-protector

# Default target (live test excluded — requires real credentials)
all: $(TARGET) $(TEST_TARGET) $(TEST_DEVICE_TARGET) $(TEST_EXCHANGE_TARGET)

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
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_TEST) -lcurl

$(TEST_DEVICE_TARGET): $(TEST_DEVICE_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_REAL)

$(TEST_EXCHANGE_TARGET): $(TEST_EXCHANGE_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_TEST)

$(TEST_LIVE_TARGET): $(TEST_LIVE_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_REAL)

# ── Utility targets ───────────────────────────────────────────────────────────

clean:
	rm -f $(OBJS) $(TEST_TARGET) $(TEST_REAL_TARGET) $(TEST_EXCHANGE_TARGET) $(TARGET)

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
	@echo "Running FairPlay tests..."
	@LD_LIBRARY_PATH=. $(TEST_TARGET); exit $$?

test-device: $(TEST_DEVICE_TARGET)
	@echo "Running device tests..."
	@LD_LIBRARY_PATH=. $(TEST_DEVICE_TARGET); exit $$?

test-exchange: $(TEST_EXCHANGE_TARGET)
	@echo "Running license exchange tests..."
	@LD_LIBRARY_PATH=. $(TEST_EXCHANGE_TARGET); exit $$?

test-live: $(TEST_LIVE_TARGET)
	@echo "Running live FPS license server test..."
	@LD_LIBRARY_PATH=. $(TEST_LIVE_TARGET) files/

test-all: $(TEST_TARGET) $(TEST_DEVICE_TARGET) $(TEST_EXCHANGE_TARGET)
	@echo "========================================"
	@echo "Running ALL Tests"
	@echo "========================================"
	@LD_LIBRARY_PATH=. $(TEST_TARGET) && \
	echo "" && \
	echo "========================================" && \
	echo "Running Device Tests" && \
	echo "========================================" && \
	LD_LIBRARY_PATH=. $(TEST_DEVICE_TARGET) && \
	echo "" && \
	echo "========================================" && \
	echo "Running Exchange Tests" && \
	echo "========================================" && \
	LD_LIBRARY_PATH=. $(TEST_EXCHANGE_TARGET)

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

# ── License exchange module compilation rules ────────────────────────────────

fp_spc_builder.o: fp_spc_builder.c fp_spc_builder.h fairplay.h fairplay_device.h
	$(CC) $(CFLAGS) -c $< -o $@

fp_ckc_parser.o: fp_ckc_parser.c fp_ckc_parser.h fairplay.h
	$(CC) $(CFLAGS) -c $< -o $@

fp_key_unwrapper.o: fp_key_unwrapper.c fp_key_unwrapper.h fairplay.h fairplay_device.h fp_ckc_parser.h
	$(CC) $(CFLAGS) -c $< -o $@

fp_http_client.o: fp_http_client.c fp_http_client.h fairplay.h
	$(CC) $(CFLAGS) -c $< -o $@

fp_license_exchange.o: fp_license_exchange.c fp_license_exchange.h \
    fp_spc_builder.h fp_ckc_parser.h fp_http_client.h fp_key_unwrapper.h fairplay.h
	$(CC) $(CFLAGS) -c $< -o $@

.PHONY: all clean release install uninstall test test-device test-exchange test-live \
        test-all analyze format-check format valgrind-test coverage
