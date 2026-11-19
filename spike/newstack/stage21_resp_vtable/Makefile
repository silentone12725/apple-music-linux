DRM     := ../../../drm

.PHONY: all run clean

all: probe

$(DRM)/embedded_blobs/embedded_loader.o:
	$(MAKE) -C $(DRM) embedded_blobs/embedded_loader.o

$(DRM)/embedded_blobs/libhybris-core.so.o:
	$(MAKE) -C $(DRM) embedded_blobs/libhybris-core.so.o

probe: stage21_probe.c fake_jni.h \
       $(DRM)/embedded_blobs/embedded_loader.o \
       $(DRM)/embedded_blobs/libhybris-core.so.o
	gcc -O0 -g \
	    -I$(DRM) \
	    stage21_probe.c \
	    $(DRM)/embedded_blobs/embedded_loader.o \
	    $(DRM)/embedded_blobs/libhybris-core.so.o \
	    -o $@ \
	    -ldl -Wno-unused-function

run: all
	cd $(dir $(abspath $(lastword $(MAKEFILE_LIST)))) && ./probe

clean:
	rm -f probe
