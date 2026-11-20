CC = gcc
JVM_INCLUDE = /usr/lib/jvm/java-27-openjdk/include
DRM_DIR = /home/daksh/Git\ Projects/apple-music-linux/drm
# use a symlink to avoid spaces
DRM_NOSP = /tmp/adam-drm

CFLAGS = -Wall -std=c11 -fPIC -O2 -g \
         -I$(JVM_INCLUDE) -I$(JVM_INCLUDE)/linux \
         -I$(DRM_NOSP)

LDFLAGS = -shared -Wl,-soname,libamskit_jni_bridge.so \
          -L$(DRM_NOSP) -ldrm_client \
          -Wl,-rpath,'$$ORIGIN' \
          -ldl

all: libamskit_jni_bridge.so

libamskit_jni_bridge.so: amskit_jni_bridge.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $<

clean:
	rm -f libamskit_jni_bridge.so
