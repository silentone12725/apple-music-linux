DRM     := ../../../drm
BLOBS   := $(DRM)/embedded_blobs

.PHONY: all run clean

all: probe

$(BLOBS)/embedded_loader.o: $(DRM)/embedded_loader.c $(DRM)/embedded_loader.h
	$(MAKE) -C $(DRM) embedded_blobs/embedded_loader.o

$(BLOBS)/libhybris-core.so.o:
	$(MAKE) -C $(DRM) embedded_blobs/libhybris-core.so.o

probe: stage15_probe.c fake_jni.h \
       $(BLOBS)/embedded_loader.o $(BLOBS)/libhybris-core.so.o
	gcc -O0 -g \
	    -I$(DRM) \
	    stage15_probe.c \
	    $(BLOBS)/embedded_loader.o \
	    $(BLOBS)/libhybris-core.so.o \
	    -o $@ \
	    -ldl -Wno-unused-function

run: all
	cd $(dir $(abspath $(lastword $(MAKEFILE_LIST)))) && ./probe

clean:
	rm -f probe
