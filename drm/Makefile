# Makefile for DRM client clean-room implementation
#
# Builds libdrm_client.so shared library and test executable.
# The library embeds libhybris-core.so (loaded from a memfd). The Android libraries are NOT
# embedded: they load from rootfs/system/lib64 on disk, which must hold everything in
# android-libs.txt.

CC = gcc
AS = as
CFLAGS = -Wall -Wextra -Werror -pedantic -std=c11 -fPIC -O2 -g -fno-stack-protector -Wno-format-truncation
# drm_hybris.c uses setjmp/longjmp for SIGSEGV probing — clobbered-by-longjmp is expected
HYBRIS_CFLAGS = $(CFLAGS) -Wno-clobbered -Wno-maybe-uninitialized -Wno-pedantic
LDFLAGS_LIB = -shared -lpthread -lcrypto -lssl -ldl -lm -lstdc++ -Wl,--no-as-needed -lcurl -Wl,--as-needed -Wl,-z,relro,-z,now
LDFLAGS_TEST = -lpthread -lcrypto -lssl -fno-stack-protector

# libhybris-core.so (Git LFS) lives beside the sources; override on the command line to
# build against another copy.
HYBRIS_CORE ?= libhybris-core.so

# Android library directory (loaded from disk at runtime)
LIB64 = rootfs/system/lib64

# libandroid.so and libOpenSLES.so are listed as dependencies by Apple's libraries but nothing
# is imported from them, so they are built here from an empty stub instead of shipping the real
# ones (which drag in the whole Android graphics/media stack). See stubs/empty_stub.c.
STUB_LIBS = $(LIB64)/libandroid.so $(LIB64)/libOpenSLES.so
$(STUB_LIBS): stubs/empty_stub.c
	@mkdir -p $(LIB64)
	$(CC) -shared -fPIC -nostdlib -O2 -Wl,-soname,$(notdir $@) -Wl,--hash-style=both -o $@ $<
android-stubs: $(STUB_LIBS)

# ICU open-source build (x86_64-linux-android via NDK).
# `make build-icu` (or `make`) runs build-icu-ndk.sh which builds ICU 68.2
# from source inside the wrapper-build Docker container and writes the three
# libicuXX_sv_apple.so files into $(LIB64).
ICU_LIBS = $(LIB64)/libicudata_sv_apple.so \
           $(LIB64)/libicuuc_sv_apple.so \
           $(LIB64)/libicui18n_sv_apple.so

# Embedded blob output directory
BLOBS_DIR = embedded_blobs

# libhybris-core.so is embedded and loaded from a memfd (see embedded_loader.c)
EMBED_BLOB_OBJS = $(BLOBS_DIR)/libhybris-core.so.o

EMBEDDED_LOADER_OBJ = $(BLOBS_DIR)/embedded_loader.o

# Core source files
SRCS = drm_client.c
HYBRIS_SRCS = drm_hybris.c
OBJS = $(SRCS:.c=.o)
HYBRIS_OBJS = $(HYBRIS_SRCS:.c=.o)

# Target library
TARGET = libdrm_client.so

# ── Vendored host-native wrapper (native/) ──────────────────────────────────
# Lease management + recovery state machine, FairPlay request-context setup,
# key-context derivation and decrypt, from the wrapper's library mode.
# The Android libs themselves are still loaded by embedded_loader.c; the
# android_dlopen/dlsym API the stubs expect is mapped onto it by android_shim.c.
NATIVE_DIR = native
NATIVE_CFLAGS = -O2 -g -fPIC -Wall -Wno-unused-variable -Wno-unused-function \
                -Wno-unused-but-set-variable -Wno-format-truncation -Wno-stringop-overflow \
                -DMyRelease -D_GNU_SOURCE -DDRM_LIB_BUILD -include sys/time.h -I$(NATIVE_DIR)
NATIVE_CXXFLAGS = -std=c++17 -O2 -g -fPIC -Wall -fexceptions -D_GNU_SOURCE -DDRM_LIB_BUILD -I$(NATIVE_DIR)
NATIVE_C_OBJS = $(NATIVE_DIR)/main.o $(NATIVE_DIR)/cmdline.o $(NATIVE_DIR)/hybris_stubs.o \
                $(NATIVE_DIR)/drm_lib.o $(NATIVE_DIR)/cJSON.o $(NATIVE_DIR)/android_shim.o
NATIVE_CXX_OBJS = $(NATIVE_DIR)/main_cpp.o $(NATIVE_DIR)/guard_cpp.o
NATIVE_OBJS = $(NATIVE_C_OBJS) $(NATIVE_CXX_OBJS)
NATIVE_HEADERS = $(wildcard $(NATIVE_DIR)/*.h)

$(NATIVE_DIR)/hybris_stubs.o: $(NATIVE_DIR)/hybris_stubs.c $(NATIVE_HEADERS)
	$(CC) $(NATIVE_CFLAGS) -Dandroid_dlopen=aml_android_dlopen -Dandroid_dlsym=aml_android_dlsym \
	      -Dandroid_dlerror=aml_android_dlerror -c -o $@ $<

$(NATIVE_DIR)/%.o: $(NATIVE_DIR)/%.c $(NATIVE_HEADERS)
	$(CC) $(NATIVE_CFLAGS) -c -o $@ $<

$(NATIVE_DIR)/main_cpp.o: $(NATIVE_DIR)/main.cpp $(NATIVE_HEADERS)
	$(CXX) $(NATIVE_CXXFLAGS) -c -o $@ $<

$(NATIVE_DIR)/guard_cpp.o: $(NATIVE_DIR)/guard.cpp $(NATIVE_HEADERS)
	$(CXX) $(NATIVE_CXXFLAGS) -c -o $@ $<

# Hybris probe binary (standalone)
PROBE_TARGET = corefp_probe

# Headers
HEADERS = drm_client.h drm_types.h drm_hybris.h

# Test files
TEST_SRC = tests/test_drm_client.c
TEST_TARGET = tests/test_drm_client
TEST_REAL_SRC = tests/test_drm_realworld.c
TEST_REAL_TARGET = tests/test_drm_realworld
LDFLAGS_REAL = -lpthread -lcrypto -lcurl -fno-stack-protector

# Default target
all: $(TARGET) $(TEST_TARGET) $(TEST_REAL_TARGET)

# ── ICU open-source build ─────────────────────────────────────────────────────

# Build ICU 68.2 from source (x86_64-linux-android via NDK inside Docker).
# Writes libicudata/uc/i18n_sv_apple.so into $(LIB64).
# Skipped automatically if all three output files already exist.
$(ICU_LIBS):
	@echo "=== Building ICU from source (x86_64-linux-android) ==="
	bash build-icu-ndk.sh

build-icu: $(ICU_LIBS)

# ── Embedded blob generation ─────────────────────────────────────────────────

$(BLOBS_DIR):
	mkdir -p $(BLOBS_DIR)

# Generate the libhybris-core.so blob and assemble it. The sentinel file tracks whether it is
# up to date vs. the source .so.
$(BLOBS_DIR)/.blobs_built: $(HYBRIS_CORE) | $(BLOBS_DIR)
	@echo "=== Generating embedded library blobs ==="
	@# ── libhybris-core.so blob ──
	@ident=libhybris_core_so; \
	 printf '.section .rodata."%s"\n.global %s_data\n.global %s_size\n.global %s_data_end\n.type %s_data, @object\n.type %s_size, @object\n.type %s_data_end, @object\n\n%s_data:\n' \
	     "libhybris-core.so" "$$ident" "$$ident" "$$ident" "$$ident" "$$ident" "$$ident" "$$ident" \
	     > $(BLOBS_DIR)/libhybris-core.so.S; \
	 xxd -p $(HYBRIS_CORE) | sed 's/\(..\)/0x\1,/g' | sed 's/,$$//' | awk '{print "    .byte " $$0}' \
	     >> $(BLOBS_DIR)/libhybris-core.so.S; \
	 printf '\n%s_data_end:\n\n%s_size:\n    .quad %s_data_end - %s_data\n' \
	     "$$ident" "$$ident" "$$ident" "$$ident" >> $(BLOBS_DIR)/libhybris-core.so.S; \
	 $(AS) -o $(BLOBS_DIR)/libhybris-core.so.o $(BLOBS_DIR)/libhybris-core.so.S; \
	 echo "  embedded libhybris-core.so"
	@touch $@
	@echo "=== Blob generation complete ==="

# All blob .o files are created atomically by the .blobs_built recipe.
# This empty rule tells Make "these targets exist after .blobs_built runs."
$(EMBED_BLOB_OBJS): $(BLOBS_DIR)/.blobs_built
	@:

gen-blobs: $(BLOBS_DIR)/.blobs_built

# ── Embedded loader ───────────────────────────────────────────────────────────

$(BLOBS_DIR)/embedded_loader.o: embedded_loader.c embedded_loader.h | $(BLOBS_DIR)
	$(CC) $(CFLAGS) -Wno-pedantic -c -o $@ $<

# ── Library link ─────────────────────────────────────────────────────────────

$(TARGET): $(OBJS) $(HYBRIS_OBJS) $(NATIVE_OBJS) $(EMBED_BLOB_OBJS) $(EMBEDDED_LOADER_OBJ)
	$(CXX) -o $@ $^ $(LDFLAGS_LIB)

# ── Compile rules ─────────────────────────────────────────────────────────────

%.o: %.c $(HEADERS)
	$(CC) $(CFLAGS) -c -o $@ $<

drm_hybris.o: drm_hybris.c drm_hybris.h embedded_loader.h native/drm_lib.h
	$(CC) $(HYBRIS_CFLAGS) -Wno-pedantic -c -o $@ $<

# ── Probe binary ──────────────────────────────────────────────────────────────

probe: $(PROBE_TARGET)

$(PROBE_TARGET): drm_hybris.c drm_hybris.h
	$(CC) $(HYBRIS_CFLAGS) -DCOREFP_PROBE_MAIN -o $@ drm_hybris.c -lpthread -ldl

# ── Tests ─────────────────────────────────────────────────────────────────────

$(TEST_TARGET): $(TEST_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_TEST)

$(TEST_REAL_TARGET): $(TEST_REAL_SRC) $(TARGET)
	$(CC) $(CFLAGS) -I. -o $@ $< -L. -ldrm_client $(LDFLAGS_REAL)

# ── Utility targets ───────────────────────────────────────────────────────────

# Compiler output only: objects, the generated embedded-blob sources, probe and test
# binaries. The built library stays, so `make clean-objs` after a build keeps what you ship.
clean-objs:
	rm -f $(OBJS) $(HYBRIS_OBJS) $(NATIVE_OBJS) $(TEST_TARGET) $(TEST_REAL_TARGET) $(PROBE_TARGET)
	rm -rf $(BLOBS_DIR)

# Everything `make` produced, including the library itself.
clean: clean-objs
	rm -f $(TARGET)

# Build the library, then drop everything it was built from (objects and generated blobs).
# The next `make` regenerates them.
release: $(TARGET)
	$(MAKE) clean-objs

# Remove ICU build outputs so they are rebuilt from source on next make.
clean-icu:
	rm -f $(ICU_LIBS)

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

# HTTP client and cookie jar against a local TLS server that misbehaves on purpose.
test-https: $(TARGET)
	@./tests/run_https_test.sh

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

.PHONY: all android-stubs clean clean-objs release clean-icu install uninstall test test-https test-realworld test-all \
        analyze format-check format valgrind-test coverage probe gen-blobs build-icu

# Authentication challenge retries and long passwords, without contacting Apple.
.PHONY: test-auth
test-auth:
	$(CC) -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -g tests/auth_credentials_test.c -o /tmp/aml-auth-credentials-test
	/tmp/aml-auth-credentials-test
	rm -f /tmp/aml-auth-credentials-test

.PHONY: test-recovery
test-recovery:
	$(CXX) -std=c++17 -Wall -Wextra -Wno-unused-parameter -ffunction-sections -fdata-sections -Wl,--gc-sections -fsanitize=address,undefined -g tests/recovery_lifecycle_test.cpp -pthread -o /tmp/aml-recovery-lifecycle-test
	/tmp/aml-recovery-lifecycle-test
	rm -f /tmp/aml-recovery-lifecycle-test

.PHONY: test-auth-transport
test-auth-transport: $(TARGET)
	$(CC) -std=c11 -Wall -Wextra -Werror tests/auth_transport_test.c -L. -ldrm_client -o /tmp/aml-auth-transport-test
	LD_LIBRARY_PATH=. /tmp/aml-auth-transport-test
	rm -f /tmp/aml-auth-transport-test

.PHONY: test-subscription
test-subscription:
	$(CC) -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -g tests/subscription_status_test.c -o /tmp/aml-subscription-status-test
	/tmp/aml-subscription-status-test
	rm -f /tmp/aml-subscription-status-test

.PHONY: test-music-token-request
test-music-token-request:
	$(CC) -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -g tests/music_token_request_test.c native/cJSON.c -lm -o /tmp/aml-music-token-request-test
	/tmp/aml-music-token-request-test
	rm -f /tmp/aml-music-token-request-test

# Call the production native handler with Android ABI stubs; catches borrowed
# password buffers freed before Apple reads them, including repeated 2FA replies.
.PHONY: test-credential-handler
test-credential-handler:
	$(CC) -D_GNU_SOURCE -DMyRelease -DDRM_LIB_BUILD -include sys/time.h -std=c11 -Wall -Wextra -Wno-unused-parameter -Wno-format -ffunction-sections -fdata-sections -Wl,--gc-sections -fsanitize=address,undefined -g tests/credential_handler_test.c -o /tmp/aml-credential-handler-test
	/tmp/aml-credential-handler-test
	rm -f /tmp/aml-credential-handler-test
