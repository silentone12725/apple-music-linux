#!/usr/bin/env bash
set -euo pipefail

echo "=== Cavern JOC Installer for Apple Music Linux ==="
echo ""

# ── Detect package manager ─────────────────────────────────────────────────────
if command -v pacman &>/dev/null; then
    PKG=pacman
elif command -v apt-get &>/dev/null; then
    PKG=apt
elif command -v dnf &>/dev/null; then
    PKG=dnf
elif command -v zypper &>/dev/null; then
    PKG=zypper
else
    echo "ERROR: No supported package manager found (pacman / apt / dnf / zypper)."
    echo "       Install .NET SDK 8.0 manually then re-run."
    exit 1
fi

# ── Install .NET SDK ───────────────────────────────────────────────────────────
if ! command -v dotnet &>/dev/null; then
    echo "Installing .NET SDK..."
    case $PKG in
        pacman)  sudo pacman -Sy --noconfirm dotnet-sdk ;;
        apt)     sudo apt-get install -y dotnet-sdk-8.0 ;;
        dnf)     sudo dnf install -y dotnet-sdk-8.0 ;;
        zypper)  sudo zypper install -y dotnet-sdk-8.0 ;;
    esac
else
    echo ".NET SDK already installed: $(dotnet --version)"
fi

# ── Clone Cavern ───────────────────────────────────────────────────────────────
echo "Cloning Cavern repository..."
rm -rf /tmp/Cavern
git clone --depth=1 https://github.com/VoidXH/Cavern /tmp/Cavern

# ── Build CavernPipeServer ─────────────────────────────────────────────────────
echo "Building CavernPipeServer (Release, linux-x64, self-contained)..."
dotnet publish /tmp/Cavern/CavernSamples/CavernPipeServer.Multiplatform \
    --configuration Release \
    --runtime linux-x64 \
    --self-contained true \
    -p:PublishSingleFile=true \
    --output /tmp/cavern-publish

# Find the binary (self-contained publish names it after the project)
BINARY=""
for candidate in /tmp/cavern-publish/CavernPipeServer \
                 /tmp/cavern-publish/CavernPipeServer.Multiplatform; do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
        BINARY="$candidate"
        break
    fi
done

if [ -z "$BINARY" ]; then
    # Fallback: any executable that isn't a .pdb/.json/.so
    BINARY=$(find /tmp/cavern-publish -maxdepth 1 -type f -perm /111 \
        ! -name "*.pdb" ! -name "*.json" ! -name "*.so" ! -name "*.dylib" \
        | head -1)
fi

if [ -z "$BINARY" ] || [ ! -f "$BINARY" ]; then
    echo "ERROR: Could not locate built binary in /tmp/cavern-publish"
    ls /tmp/cavern-publish/ 2>/dev/null || true
    exit 1
fi

echo "Found binary: $BINARY"

# ── Install ────────────────────────────────────────────────────────────────────
echo "Installing to /usr/local/bin/CavernPipeServer..."
sudo install -m 755 "$BINARY" /usr/local/bin/CavernPipeServer

# ── Verify ────────────────────────────────────────────────────────────────────
if command -v CavernPipeServer &>/dev/null; then
    echo "Verified: CavernPipeServer is in PATH"
else
    echo "WARNING: /usr/local/bin is not in PATH. Add it or set AML_CAVERN=/usr/local/bin/CavernPipeServer"
fi

# ── Clean up ───────────────────────────────────────────────────────────────────
echo "Cleaning up build artifacts..."
rm -rf /tmp/Cavern /tmp/cavern-publish

echo ""
echo "DONE!"
