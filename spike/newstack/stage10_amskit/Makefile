APK_LIB := /home/daksh/Downloads/com.apple.android.music_6.5.2-1586_4arch_7dpi_def1a16c2e92397f2908de1de00b7f34_apkmirror.com/split_config.x86_64/lib/x86_64
DRM     := ../../../drm
BLOBS   := $(DRM)/embedded_blobs

.PHONY: all run clean

all: probe

# embedded_loader.o and libhybris-core.so.o are pre-built by drm/Makefile;
# build them if stale.
$(BLOBS)/embedded_loader.o: $(DRM)/embedded_loader.c $(DRM)/embedded_loader.h
	$(MAKE) -C $(DRM) embedded_blobs/embedded_loader.o

$(BLOBS)/libhybris-core.so.o:
	$(MAKE) -C $(DRM) embedded_blobs/libhybris-core.so.o

probe: stage10_amskit_probe.c fake_jni.h \
       $(BLOBS)/embedded_loader.o $(BLOBS)/libhybris-core.so.o
	gcc -O0 -g \
	    -I$(DRM) \
	    stage10_amskit_probe.c \
	    $(BLOBS)/embedded_loader.o \
	    $(BLOBS)/libhybris-core.so.o \
	    -o $@ \
	    -ldl -Wno-unused-function

run: all
	cd $(dir $(abspath $(lastword $(MAKEFILE_LIST)))) && ./probe

clean:
	rm -f probe
