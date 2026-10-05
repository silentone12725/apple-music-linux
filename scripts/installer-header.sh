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

# ── PATH helpers ──────────────────────────────────────────────────────────────
# The launcher is installed as `apple-music-linux`. For a user install its directory may not
# be on PATH, so the installer adds it to the shell startup files. Each edit carries a marker
# line so reinstalling never duplicates it and --uninstall can remove exactly what was added.
PATH_MARK="# apple-music-linux: launcher directory on PATH"
FISH_CONF="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/apple-music-linux.fish"
PATH_EDITED=""

# Append "export PATH" to a POSIX-style startup file (created if needed).
add_path_line() { # <file>
    f="$1"
    if [ -f "$f" ] && grep -qF "$PATH_MARK" "$f"; then return 0; fi
    printf '\n%s\nexport PATH="%s:$PATH"\n' "$PATH_MARK" "$BIN_DIR" >> "$f" || return 1
    PATH_EDITED="$PATH_EDITED $f"
}

ensure_on_path() {
    case ":$PATH:" in *":$BIN_DIR:"*) return 0 ;; esac
    # Login shells (and anything sourcing it) and bash interactive shells.
    add_path_line "$HOME/.profile"
    [ -f "$HOME/.bashrc" ] && add_path_line "$HOME/.bashrc"
    # zsh reads .zshrc for every interactive shell. Only edit one that exists: creating it would
    # suppress zsh's first-run setup for someone who has not configured zsh yet.
    [ -f "${ZDOTDIR:-$HOME}/.zshrc" ] && add_path_line "${ZDOTDIR:-$HOME}/.zshrc"
    # fish has its own syntax and a conf.d drop-in directory.
    if command -v fish >/dev/null 2>&1 || [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/fish" ]; then
        mkdir -p "$(dirname "$FISH_CONF")"
        [ -f "$FISH_CONF" ] || PATH_EDITED="$PATH_EDITED $FISH_CONF"
        printf '%s\nif not contains -- "%s" $PATH\n    set -gx PATH "%s" $PATH\nend\n' "$PATH_MARK" "$BIN_DIR" "$BIN_DIR" > "$FISH_CONF"
    fi
}

remove_path_lines() {
    rm -f "$FISH_CONF"
    for f in "$HOME/.profile" "$HOME/.bashrc" "${ZDOTDIR:-$HOME}/.zshrc"; do
        [ -f "$f" ] && grep -qF "$PATH_MARK" "$f" || continue
        awk -v m="$PATH_MARK" '$0==m{skip=1;next} skip{skip=0;next} {print}' "$f" > "$f.aml-tmp" \
            && cat "$f.aml-tmp" > "$f"
        rm -f "$f.aml-tmp"
    done
}

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
    [ "$SYSTEM" = "1" ] || remove_path_lines
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
    "$INSTALL_DIR/resources/engine"

chmod -R +x "$INSTALL_DIR/resources/hybris-linker" 2>/dev/null || true

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
[ "$SYSTEM" = "1" ] || ensure_on_path

# ── desktop entry + icon ──────────────────────────────────────────────────────
mkdir -p "$DESKTOP_DIR" "$ICON_DIR"

# Resolve the best app icon: bundled icon.png > tray-icon.png fallback
APP_ICON="$INSTALL_DIR/resources/icon.png"
if [ ! -f "$APP_ICON" ]; then
    APP_ICON="$INSTALL_DIR/resources/tray-icon.png"
fi

# Copy to hicolor theme dir (for DEs that resolve icon names)
cp "$APP_ICON" "$ICON_DIR/apple-music-linux.png" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

# Use absolute path for Icon= — bypasses icon theme cache entirely,
# guaranteed to show the correct icon regardless of DE cache state.
# (Freedesktop spec: absolute paths are used directly, no theme lookup.)
cat > "$DESKTOP_DIR/apple-music-linux.desktop" <<EOF
[Desktop Entry]
Name=Apple Music
GenericName=Music Player
Comment=Apple Music desktop client for Linux
Exec=$INSTALL_DIR/apple-music-linux --no-sandbox %u
Icon=$APP_ICON
Type=Application
Categories=AudioVideo;Music;Network;
StartupWMClass=Apple Music
MimeType=x-scheme-handler/aml;x-scheme-handler/ame;
Keywords=music;apple;streaming;
EOF

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
xdg-mime default apple-music-linux.desktop x-scheme-handler/aml 2>/dev/null || true

# ── version stamp ─────────────────────────────────────────────────────────────
echo "$VERSION" > "$INSTALL_DIR/.version"

echo ""
echo "Apple Music Linux $VERSION installed to $INSTALL_DIR"
echo "Launcher: $BIN_DIR/apple-music-linux"

if [ -n "$PATH_EDITED" ]; then
    echo ""
    echo "Added $BIN_DIR to your PATH in:$PATH_EDITED"
    echo "Open a new terminal, then run:  apple-music-linux"
    echo "(In this terminal: export PATH=\"$BIN_DIR:\$PATH\")"
fi

exit 0
__PAYLOAD_BELOW__
