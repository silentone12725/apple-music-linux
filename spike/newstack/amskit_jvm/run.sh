#!/bin/bash
# Usage: run.sh adam.Smoke <bridge.so> <classes.jar>
# Needs: BUILD (dir with libs/amskit-v52.jar, libs/javacpp-1.5.10.jar, java/out, lib64-701/)
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BUILD="${BUILD:-$HERE/build}"
export HYBRIS_LINKER_DIR="$REPO/drm/hybris-linker" ADAM_AMSKIT_LIB64="$BUILD/lib64-701" LD_LIBRARY_PATH="${DRM_LINK_DIR:-/tmp/adam-drm}:$REPO/drm"
exec java -XX:+UnlockDiagnosticVMOptions -XX:-BytecodeVerificationRemote -XX:-BytecodeVerificationLocal \
  -Dorg.bytedeco.javacpp.loadlibraries=false --enable-native-access=ALL-UNNAMED \
  -cp "$BUILD/java/out:$BUILD/libs/amskit-v52.jar:$BUILD/libs/javacpp-1.5.10.jar" "$@"
