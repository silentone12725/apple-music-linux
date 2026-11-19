DRM   = ../../../drm
PROBE = stage23_probe

.PHONY: all clean run

# `all` must be the default goal: otherwise a bare `make` builds only the first
# real target below (the .o) and silently skips recompiling the probe, so source
# edits never take effect.  (This bit us 2026-11-19 — hours spent testing a stale
# binary.)  Keep this line directly under .PHONY.
.DEFAULT_GOAL := all

$(DRM)/embedded_blobs/embedded_loader.o:
	$(MAKE) -C $(DRM) embedded_blobs/embedded_loader.o

$(DRM)/embedded_blobs/libhybris-core.so.o:
	$(MAKE) -C $(DRM) embedded_blobs/libhybris-core.so.o

all: $(PROBE)

$(PROBE): stage23_probe.c ../stage22_inline_resp/fake_jni.h \
          $(DRM)/embedded_blobs/embedded_loader.o \
          $(DRM)/embedded_blobs/libhybris-core.so.o
	gcc -O0 -g3 \
	    -I$(DRM) \
	    -I../stage22_inline_resp \
	    -Wno-unused-function -Wno-unused-variable \
	    stage23_probe.c \
	    $(DRM)/embedded_blobs/embedded_loader.o \
	    $(DRM)/embedded_blobs/libhybris-core.so.o \
	    -o $@ \
	    -ldl -lpthread -lcurl -rdynamic

clean:
	rm -f $(PROBE)

run: all
	./$(PROBE)
