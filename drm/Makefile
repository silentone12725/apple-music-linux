# Makefile for DRM client clean-room implementation
#
# Builds libdrm_client.so shared library and test executable

CC = gcc
CFLAGS = -Wall -Wextra -Werror -pedantic -std=c11 -fPIC -O2 -g -fno-stack-protector
LDFLAGS_LIB = -shared -lpthread -lcrypto
LDFLAGS_TEST = -lpthread -lcrypto -fno-stack-protector

# Source files
SRCS = drm_client.c
OBJS = $(SRCS:.c=.o)

# Target library
TARGET = libdrm_client.so

# Headers
HEADERS = drm_client.h drm_types.h

# Test files
TEST_SRC = tests/test_drm_client.c
TEST_TARGET = tests/test_drm_client

# Real-world test files
TEST_REAL_SRC = tests/test_drm_realworld.c
TEST_REAL_TARGET = tests/test_drm_realworld
LDFLAGS_REAL = -lpthread -lcrypto -lcurl -fno-stack-protector

# Default target
all: $(TARGET) $(TEST_TARGET) $(TEST_REAL_TARGET)

# Link shared library
$(TARGET): $(OBJS)
	$(CC) $(LDFLAGS_LIB) -o $@ $^

# Compile object files
%.o: %.c $(HEADERS)
	$(CC) $(CFLAGS) -c -o $@ $<

# Build test executable
$(TEST_TARGET): $(TEST_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_TEST)

# Build real-world test executable
$(TEST_REAL_TARGET): $(TEST_REAL_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_REAL)

# Clean build artifacts
clean:
	rm -f $(OBJS) $(TARGET) $(TEST_TARGET) $(TEST_REAL_TARGET)

# Install (optional)
install: $(TARGET)
	install -d $(DESTDIR)/usr/lib
	install -m 755 $(TARGET) $(DESTDIR)/usr/lib/
	install -d $(DESTDIR)/usr/include
	install -m 644 $(HEADERS) $(DESTDIR)/usr/include/

# Uninstall (optional)
uninstall:
	rm -f $(DESTDIR)/usr/lib/$(TARGET)
	rm -f $(DESTDIR)/usr/include/drm_client.h
	rm -f $(DESTDIR)/usr/include/drm_types.h

# Run tests
test: $(TEST_TARGET)
	@echo "Running acceptance tests..."
	@LD_LIBRARY_PATH=. $(TEST_TARGET); exit $$?

# Run real-world tests
test-realworld: $(TEST_REAL_TARGET)
	@echo "Running real-world tests..."
	@LD_LIBRARY_PATH=. $(TEST_REAL_TARGET); exit $$?

# Run all tests
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

# Static analysis
analyze:
	clang-analyze $(CFLAGS) -c $(SRCS)

# Format check
format-check:
	clang-format --dry-run --Werror $(SRCS) $(HEADERS) $(TEST_SRC)

# Format fix
format:
	clang-format -i $(SRCS) $(HEADERS) $(TEST_SRC)

# Run with valgrind (memory leak detection)
valgrind-test: $(TEST_TARGET)
	valgrind --leak-check=full --show-leak-kinds=all \
		LD_LIBRARY_PATH=. $(TEST_TARGET)

# Coverage build
coverage: CFLAGS += --coverage
coverage: LDFLAGS_LIB += --coverage
coverage: LDFLAGS_TEST += --coverage
coverage: clean all

# Phony targets
.PHONY: all clean install uninstall test analyze format-check format valgrind-test coverage
