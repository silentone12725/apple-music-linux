#!/bin/sh
# Apple Music Linux — self-extracting installer
# Usage: ./apple-music-linux.run [--force] [--system] [--uninstall]
#
# --force      reinstall even if already at this version
# --system     install to /opt/apple-music-linux + /usr/local/bin (needs sudo)
# --uninstall  remove a previous installation

VERSION="__VERSION__"

# ── defaults (user install) ───────────────────────────────────────────────────
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/lib}/apple-music-linux"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"

FORCE=0
SYSTEM=0
UNINSTALL=0

for arg in "$@"; do
    case "$arg" in
        --force)    FORCE=1 ;;
        --system)   SYSTEM=1 ;;
        --uninstall) UNINSTALL=1 ;;
        --help|-h)
            echo "Usage: $0 [--force] [--system] [--uninstall]"
            exit 0 ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

if [ "$SYSTEM" = "1" ]; then
    INSTALL_DIR="/opt/apple-music-linux"
    BIN_DIR="/usr/local/bin"
    DESKTOP_DIR="/usr/share/applications"
    ICON_DIR="/usr/share/icons/hicolor/256x256/apps"
fi

# ── uninstall ─────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
    rm -rf "$INSTALL_DIR"
    rm -f  "$BIN_DIR/apple-music-linux"
    rm -f  "$DESKTOP_DIR/apple-music-linux.desktop"
    rm -f  "$ICON_DIR/apple-music-linux.png"
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    echo "Uninstalled Apple Music Linux."
    exit 0
fi

# ── version guard ─────────────────────────────────────────────────────────────
if [ "$FORCE" = "0" ] && [ -f "$INSTALL_DIR/.version" ]; then
    installed=$(cat "$INSTALL_DIR/.version")
    if [ "$installed" = "$VERSION" ]; then
        echo "Apple Music Linux $VERSION is already installed."
        echo "Run: apple-music-linux   or pass --force to reinstall."
        exit 0
    fi
fi

# ── zstd check ───────────────────────────────────────────────────────────────
if ! command -v zstd >/dev/null 2>&1; then
    echo "Error: zstd is required for installation."
    echo "  Debian/Ubuntu:  sudo apt install zstd"
    echo "  Fedora/RHEL:    sudo dnf install zstd"
    echo "  Arch:           sudo pacman -S zstd"
    echo "  openSUSE:       sudo zypper install zstd"
    exit 1
fi

# ── extract ───────────────────────────────────────────────────────────────────
# Payload starts after the __PAYLOAD_BELOW__ sentinel line.
# Byte-offset method (binary-safe): count bytes through that line, then tail -c.
SENTINEL_LINE=$(grep -an '^__PAYLOAD_BELOW__$' "$0" | tail -1 | cut -d: -f1)
HEADER_BYTES=$(head -n "$SENTINEL_LINE" "$0" | wc -c)
PAYLOAD_START=$((HEADER_BYTES + 1))

echo "Installing Apple Music Linux $VERSION..."
mkdir -p "$INSTALL_DIR"

tail -c +"$PAYLOAD_START" "$0" \
    | zstd -d --long=31 -q \
    | tar -x --strip-components=1 -C "$INSTALL_DIR"

# ── permissions ───────────────────────────────────────────────────────────────
chmod +x \
    "$INSTALL_DIR/apple-music-linux" \
    "$INSTALL_DIR/chrome_crashpad_handler" \
    "$INSTALL_DIR/resources/engine" \
    "$INSTALL_DIR/resources/drm"

# chrome-sandbox: needs setuid root for the Chromium sandbox.
# Without it we fall back to --no-sandbox in the launcher (safe for local use).
if [ "$SYSTEM" = "1" ] && [ "$(id -u)" = "0" ]; then
    chown root:root "$INSTALL_DIR/chrome-sandbox"
    chmod 4755      "$INSTALL_DIR/chrome-sandbox"
fi

# ── launcher ──────────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/apple-music-linux" <<EOF
#!/bin/sh
exec "$INSTALL_DIR/apple-music-linux" --no-sandbox "\$@"
EOF
chmod +x "$BIN_DIR/apple-music-linux"

# ── desktop entry + icon ──────────────────────────────────────────────────────
mkdir -p "$DESKTOP_DIR" "$ICON_DIR"

cp "$INSTALL_DIR/resources/tray-icon.png" "$ICON_DIR/apple-music-linux.png" 2>/dev/null || true

cat > "$DESKTOP_DIR/apple-music-linux.desktop" <<EOF
[Desktop Entry]
Name=Apple Music
GenericName=Music Player
Comment=Apple Music desktop client for Linux
Exec=$INSTALL_DIR/apple-music-linux --no-sandbox %u
Icon=apple-music-linux
Type=Application
Categories=AudioVideo;Music;Network;
StartupWMClass=Apple Music
MimeType=x-scheme-handler/ame;
Keywords=music;apple;streaming;
EOF

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

# ── version stamp ─────────────────────────────────────────────────────────────
echo "$VERSION" > "$INSTALL_DIR/.version"

echo ""
echo "Apple Music Linux $VERSION installed to $INSTALL_DIR"
echo "Launcher: $BIN_DIR/apple-music-linux"

if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
    echo ""
    echo "Note: $BIN_DIR is not in your PATH."
    echo "Add to ~/.bashrc or ~/.zshrc:  export PATH=\"\$PATH:$BIN_DIR\""
fi

exit 0
__PAYLOAD_BELOW__
