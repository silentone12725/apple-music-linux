# Builds libdrm_client.so: the flat C API the engine calls (drm_linux.c), the
# libhybris loader for Apple's Android FairPlay libraries (drm_hybris.c) and the
# vendored wrapper that runs the FairPlay session (native/).
#
# The library embeds libhybris-core.so (loaded from a memfd). Apple's Android libraries are
# not part of the build: they load from rootfs/system/lib64 at runtime and are downloaded by
# scripts/fetch-fairplay-libs.sh (pinned and checksummed in fairplay-libs.lock).

.DEFAULT_GOAL := all

CC = gcc
AS = as
CFLAGS = -Wall -Wextra -Werror -pedantic -std=c11 -fPIC -O2 -g -fno-stack-protector -Wno-format-truncation -Wno-deprecated-declarations -Wno-stringop-truncation
HYBRIS_CFLAGS = $(CFLAGS) -Wno-pedantic
LDFLAGS_LIB = -shared -lpthread -lcrypto -lssl -ldl -lm -lstdc++ -Wl,--no-as-needed -lcurl -Wl,--as-needed -Wl,-z,relro,-z,now

# libhybris-core.so (Git LFS) lives beside the sources; override on the command line to
# build against another copy.
HYBRIS_CORE ?= libhybris-core.so

# Android library directory (loaded from disk at runtime)
LIB64 = rootfs/system/lib64

# libandroid.so, libOpenSLES.so and libdl.so are listed as dependencies by Apple's libraries
# but nothing is imported from them, so they are built from our own stubs instead of shipping
# the real ones (which drag in the whole Android graphics/media stack). They are packaged in
# resources/android-stubs; scripts/fetch-fairplay-libs.sh installs them next to Apple's libraries.
STUB_DIR = stubs/out
STUB_LIBS = $(STUB_DIR)/libandroid.so $(STUB_DIR)/libOpenSLES.so $(STUB_DIR)/libdl.so
STUB_LDFLAGS = -shared -fPIC -nostdlib -O2 -Wl,--hash-style=both

$(STUB_DIR)/libandroid.so $(STUB_DIR)/libOpenSLES.so: stubs/empty_stub.c
	@mkdir -p $(STUB_DIR)
	$(CC) $(STUB_LDFLAGS) -Wl,-soname,$(notdir $@) -o $@ $<

$(STUB_DIR)/libdl.so: stubs/empty_stub.c stubs/libdl.map
	@mkdir -p $(STUB_DIR)
	$(CC) $(STUB_LDFLAGS) -Wl,-soname,libdl.so -Wl,--version-script=stubs/libdl.map -o $@ stubs/empty_stub.c

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

# Windows/MSYS2 portability check. Windows loads the MinGW-built libhybris core
# as a normal module, so it must not assemble or link the Linux embedded blob.
MINGW_CC ?= x86_64-w64-mingw32-gcc
MINGW_CXX ?= x86_64-w64-mingw32-g++
WINDOWS_BUILD_DIR ?= build-windows
WINDOWS_CFLAGS ?= -D_WIN32 -Wall -Wextra -Werror -pedantic -std=c11 -O2 -I.
WINDOWS_LOADER_OBJ = $(WINDOWS_BUILD_DIR)/embedded_loader.o
WINDOWS_NATIVE_CFLAGS ?= -D_WIN32 -DMyRelease -D_GNU_SOURCE -DDRM_LIB_BUILD \
                        -include sys/time.h -O2 -g -fPIC -Wall \
                        -Wno-unused-variable -Wno-unused-function \
                        -Wno-unused-but-set-variable -Wno-format-truncation \
                        -Wno-stringop-overflow -I. -I$(NATIVE_DIR)
WINDOWS_NATIVE_CXXFLAGS ?= -D_WIN32 -DMyRelease -D_GNU_SOURCE -DDRM_LIB_BUILD \
                          -O2 -g -fPIC -Wall -fexceptions -I. -I$(NATIVE_DIR)
WINDOWS_LIBS ?= -lws2_32 -lwinpthread
WINDOWS_TARGET = $(WINDOWS_BUILD_DIR)/libdrm_client.dll
WINDOWS_OBJS = $(WINDOWS_BUILD_DIR)/drm_linux.o \
               $(WINDOWS_BUILD_DIR)/drm_hybris.o \
               $(WINDOWS_BUILD_DIR)/main.o \
               $(WINDOWS_BUILD_DIR)/cmdline.o \
               $(WINDOWS_BUILD_DIR)/hybris_stubs.o \
               $(WINDOWS_BUILD_DIR)/drm_lib.o \
               $(WINDOWS_BUILD_DIR)/cJSON.o \
               $(WINDOWS_BUILD_DIR)/android_shim.o \
               $(WINDOWS_BUILD_DIR)/main_cpp.o \
               $(WINDOWS_BUILD_DIR)/guard_cpp.o \
               $(WINDOWS_LOADER_OBJ)

# Core source files
SRCS = drm_linux.c
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
	      -Dandroid_dlerror=aml_android_dlerror \
	      -Dandroid_update_LD_LIBRARY_PATH=aml_android_update_LD_LIBRARY_PATH -c -o $@ $<

$(NATIVE_DIR)/%.o: $(NATIVE_DIR)/%.c $(NATIVE_HEADERS)
	$(CC) $(NATIVE_CFLAGS) -c -o $@ $<

$(NATIVE_DIR)/main_cpp.o: $(NATIVE_DIR)/main.cpp $(NATIVE_HEADERS)
	$(CXX) $(NATIVE_CXXFLAGS) -c -o $@ $<

$(NATIVE_DIR)/guard_cpp.o: $(NATIVE_DIR)/guard.cpp $(NATIVE_HEADERS)
	$(CXX) $(NATIVE_CXXFLAGS) -c -o $@ $<

# Headers
HEADERS = drm_types.h drm_hybris.h embedded_loader.h

TEST_TARGET = tests/test_drm_linux

all: $(TARGET) android-stubs

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

# ── Tests ─────────────────────────────────────────────────────────────────────

$(TEST_TARGET): tests/test_drm_linux.c drm_linux.c drm_types.h
	$(CC) -std=gnu11 -g -I. -o $@ tests/test_drm_linux.c drm_linux.c -lpthread

# ── Utility targets ───────────────────────────────────────────────────────────

# Compiler output only: objects, the generated embedded-blob sources and the test
# binary. The built library stays, so `make clean-objs` after a build keeps what you ship.
clean-objs:
	rm -f $(OBJS) $(HYBRIS_OBJS) $(NATIVE_OBJS) $(TEST_TARGET)
	rm -rf $(STUB_DIR)
	rm -rf $(BLOBS_DIR)
	rm -rf $(WINDOWS_BUILD_DIR)

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
	rm -f $(addprefix $(DESTDIR)/usr/include/,$(HEADERS))

# Unit tests for header-only wrapper helpers (adapted from PR #1).
NATIVE_C_TESTS = tests/music_token_request_test tests/subscription_status_test

tests/music_token_request_test: tests/music_token_request_test.c native/music_token_request.h native/cJSON.c
	$(CC) -std=gnu11 -g -Inative -o $@ tests/music_token_request_test.c native/cJSON.c -lm

tests/subscription_status_test: tests/subscription_status_test.c native/subscription_status.h
	$(CC) -std=gnu11 -g -Inative -o $@ tests/subscription_status_test.c

test: $(TEST_TARGET) $(NATIVE_C_TESTS)
	@$(TEST_TARGET)
	@for t in $(NATIVE_C_TESTS); do ./$$t || exit 1; done

# Compile the Windows loader branch without requiring credentials or Android
# libraries. Run this in an MSYS2 MinGW shell, or override MINGW_CC in CI.
$(WINDOWS_LOADER_OBJ): embedded_loader.c embedded_loader.h
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_CFLAGS) -c -o $@ $<

windows-loader-check: $(WINDOWS_LOADER_OBJ)
	@echo "Windows embedded loader compile check passed"

$(WINDOWS_BUILD_DIR)/drm_linux.o: drm_linux.c drm_types.h
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_CFLAGS) -Wno-format-truncation -c -o $@ $<

$(WINDOWS_BUILD_DIR)/drm_hybris.o: drm_hybris.c drm_hybris.h embedded_loader.h native/drm_lib.h
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_NATIVE_CFLAGS) -Wno-pedantic -c -o $@ $<

$(WINDOWS_BUILD_DIR)/main.o: native/main.c $(NATIVE_HEADERS)
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_NATIVE_CFLAGS) -c -o $@ $<

$(WINDOWS_BUILD_DIR)/cmdline.o: native/cmdline.c $(NATIVE_HEADERS)
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_NATIVE_CFLAGS) -c -o $@ $<

$(WINDOWS_BUILD_DIR)/hybris_stubs.o: native/hybris_stubs.c $(NATIVE_HEADERS)
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_NATIVE_CFLAGS) \
		-Dandroid_dlopen=aml_android_dlopen \
		-Dandroid_dlsym=aml_android_dlsym \
		-Dandroid_dlerror=aml_android_dlerror \
		-Dandroid_update_LD_LIBRARY_PATH=aml_android_update_LD_LIBRARY_PATH \
		-c -o $@ $<

$(WINDOWS_BUILD_DIR)/drm_lib.o: native/drm_lib.c $(NATIVE_HEADERS)
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_NATIVE_CFLAGS) -c -o $@ $<

$(WINDOWS_BUILD_DIR)/cJSON.o: native/cJSON.c $(NATIVE_HEADERS)
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_NATIVE_CFLAGS) -c -o $@ $<

$(WINDOWS_BUILD_DIR)/android_shim.o: native/android_shim.c embedded_loader.h
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CC) $(WINDOWS_NATIVE_CFLAGS) -c -o $@ $<

$(WINDOWS_BUILD_DIR)/main_cpp.o: native/main.cpp $(NATIVE_HEADERS)
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CXX) $(WINDOWS_NATIVE_CXXFLAGS) -c -o $@ $<

$(WINDOWS_BUILD_DIR)/guard_cpp.o: native/guard.cpp $(NATIVE_HEADERS)
	@mkdir -p $(WINDOWS_BUILD_DIR)
	$(MINGW_CXX) $(WINDOWS_NATIVE_CXXFLAGS) -c -o $@ $<

$(WINDOWS_TARGET): $(WINDOWS_OBJS)
	$(MINGW_CXX) -shared -o $@ $^ -Wl,--allow-shlib-undefined \
		-Wl,--export-all-symbols $(WINDOWS_LIBS)

windows-build: $(WINDOWS_TARGET)
	@echo "Windows DRM client built: $(WINDOWS_TARGET)"

windows-check: windows-loader-check windows-build

# Our own C/C++ (style in /.clang-format). Vendored and third-party files are excluded.
FORMAT_SRCS = drm_linux.c drm_hybris.c drm_hybris.h drm_types.h embedded_loader.c \
              embedded_loader.h stubs/empty_stub.c tests/test_drm_linux.c \
              native/android_shim.c native/guard.cpp

analyze:
	clang-analyze $(CFLAGS) -c $(SRCS)

format-check:
	clang-format --dry-run --Werror $(FORMAT_SRCS)

format:
	clang-format -i $(FORMAT_SRCS)

coverage: CFLAGS += --coverage
coverage: LDFLAGS_LIB += --coverage
coverage: clean all

.PHONY: all android-stubs clean clean-objs release clean-icu install uninstall test \
        windows-loader-check windows-build windows-check analyze format-check format coverage gen-blobs build-icu
