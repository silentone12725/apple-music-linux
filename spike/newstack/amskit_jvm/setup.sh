#!/bin/bash
# setup.sh — builds everything needed to run AdamAuth (the JVM/hybris AMSKit bridge)
# from a clean checkout.
#
# Usage:
#   ./setup.sh /path/to/apple-music-7.0.1.apk
#
# What it does (all local, no Apple account interaction):
#   1. Downloads javacpp-1.5.10.jar (Maven Central) and dex-tools v2.4 (GitHub release)
#      — both public, redistributable build tools, not Apple's.
#   2. Runs dex2jar on the supplied APK to get AMSKit's compiled Java/Kotlin classes,
#      then patches their class-file version from 50 (dex2jar's output) to 52, since the
#      JVM refuses to verify dex2jar's output otherwise (see README.md "Gotchas").
#   3. Extracts the APK's lib/x86_64/*.so and merges them with drm/rootfs-6.5.2's Android
#      system libs into one directory hybris can load from.
#   4. Builds libdrm_client.so (if not already built) and the glibc JNI bridge
#      (bridge/amskit_jni_bridge.c).
#   5. Compiles the Java sources.
#
# The APK itself is never committed or redistributed — download Apple Music 7.0.1 for
# Android yourself (e.g. an APK mirror) and pass its path as $1. versionCode 1622 /
# versionName 7.0.1 is the build this was developed and tested against; a different
# version's libAMSKit.so may or may not be ABI-compatible with the Java bindings here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
APK="${1:-}"
BUILD="${BUILD:-$HERE/build}"

if [ -z "$APK" ] || [ ! -f "$APK" ]; then
    echo "Usage: $0 /path/to/apple-music-7.0.1.apk" >&2
    echo "  (download it yourself from an APK mirror; it is never committed to this repo)" >&2
    exit 1
fi

for tool in java javac gcc python3 unzip wget; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done

mkdir -p "$BUILD/libs" "$BUILD/java/out" "$BUILD/apk_extract" "$BUILD/dex-tools" "$BUILD/lib64-701"

# --- 1. javacpp runtime jar ---
if [ ! -f "$BUILD/libs/javacpp-1.5.10.jar" ]; then
    echo "[setup] downloading javacpp-1.5.10.jar..."
    wget -q "https://repo1.maven.org/maven2/org/bytedeco/javacpp/1.5.10/javacpp-1.5.10.jar" \
        -O "$BUILD/libs/javacpp-1.5.10.jar"
fi

# --- 2. dex-tools (for d2j-dex2jar) ---
if [ ! -x "$BUILD/dex-tools/dex-tools-v2.4/d2j-dex2jar.sh" ]; then
    echo "[setup] downloading dex-tools v2.4..."
    wget -q "https://github.com/pxb1988/dex2jar/releases/download/v2.4/dex-tools-v2.4.zip" \
        -O "$BUILD/dex-tools/dex-tools-v2.4.zip"
    unzip -oq "$BUILD/dex-tools/dex-tools-v2.4.zip" -d "$BUILD/dex-tools"
    chmod +x "$BUILD/dex-tools/dex-tools-v2.4/"*.sh
fi

# --- 3. APK -> JAR, then patch class version 50 -> 52 ---
if [ ! -f "$BUILD/libs/amskit-v52.jar" ]; then
    echo "[setup] running dex2jar on the APK (this takes a minute)..."
    bash "$BUILD/dex-tools/dex-tools-v2.4/d2j-dex2jar.sh" "$APK" \
        -o "$BUILD/libs/amskit-classes.jar" -f

    echo "[setup] patching class file version 50 -> 52..."
    python3 -I - "$BUILD/libs/amskit-classes.jar" "$BUILD/libs/amskit-v52.jar" <<'EOF'
import sys, zipfile
src_path, dst_path = sys.argv[1], sys.argv[2]
src = zipfile.ZipFile(src_path)
dst = zipfile.ZipFile(dst_path, 'w', zipfile.ZIP_DEFLATED)
n = 0
for info in src.infolist():
    data = src.read(info.filename)
    if info.filename.endswith('.class') and data[:4] == b'\xca\xfe\xba\xbe' and data[6:8] == b'\x00\x32':
        data = data[:6] + b'\x00\x34' + data[8:]
        n += 1
    dst.writestr(info, data)
dst.close()
print(f"patched {n} class files")
EOF
fi

# --- 4. extract the APK's x86_64 libs and merge with the Android rootfs ---
if [ ! -f "$BUILD/apk_extract/lib/x86_64/libAMSKit.so" ]; then
    echo "[setup] extracting lib/x86_64 from the APK..."
    unzip -oq "$APK" 'lib/x86_64/*' -d "$BUILD/apk_extract"
fi

ROOTFS="$REPO/drm/rootfs-6.5.2/system/lib64"
if [ ! -d "$ROOTFS" ]; then
    echo "error: $ROOTFS not found — this script must run inside the apple-music-linux repo" >&2
    exit 1
fi
echo "[setup] linking lib64-701/ (rootfs + APK libs)..."
for f in "$ROOTFS"/*; do ln -sf "$f" "$BUILD/lib64-701/$(basename "$f")"; done
for f in "$BUILD/apk_extract/lib/x86_64/"*.so; do ln -sf "$f" "$BUILD/lib64-701/$(basename "$f")"; done

# --- 5. libdrm_client.so (spaceless symlink, matching CLAUDE.md's convention) ---
ln -sfT "$REPO/drm" /tmp/adam-drm
if [ ! -f "$REPO/drm/libdrm_client.so" ]; then
    echo "[setup] building drm/libdrm_client.so..."
    (cd "$REPO/drm" && make libdrm_client.so)
fi

# --- 6. the glibc JNI bridge ---
echo "[setup] building the JNI bridge..."
JAVA_HOME="${JAVA_HOME:-$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")}"
make -C "$HERE/bridge" JVM_INCLUDE="$JAVA_HOME/include"

# --- 7. compile the Java sources ---
echo "[setup] compiling Java sources..."
javac -nowarn -cp "$BUILD/libs/amskit-v52.jar:$BUILD/libs/javacpp-1.5.10.jar" \
    -d "$BUILD/java/out" "$HERE/java/adam/"*.java "$HERE/java/android/system/"*.java

echo
echo "[setup] done. Run with, e.g.:"
echo "  BUILD=\"$BUILD\" ./run.sh adam.AdamAuth \"$HERE/bridge/libamskit_jni_bridge.so\" \"$BUILD/libs/amskit-v52.jar\" <state-dir> <cred-file|INTERACTIVE> <stage9-bin> <prov-dir> [allowReprovision]"
echo "See README.md for the full argument list and current known-issue status."
