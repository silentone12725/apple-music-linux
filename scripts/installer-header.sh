#!/bin/sh
# Adam — self-extracting installer
# Usage: ./adam.run [--force] [--system] [--no-lossless] [--tray-support | --no-tray-check] [--uninstall [--keep-data]]
#
# --force        reinstall even if already at this version
# --system       install to /opt/adam + /usr/local/bin (needs sudo)
# --no-lossless  skip downloading Apple's FairPlay libraries (lossless/ALAC stays off)
# --tray-support    install the system-tray package for this desktop if it has none (GNOME, bare Wayland compositors)
# --no-tray-check   skip the system-tray check
# --uninstall    remove a previous installation, and everything Adam set up for you: your settings, the DRM session,
#                the web sign-in, caches, launch at login and the link associations it wrote
# --keep-data    with --uninstall: keep the settings, DRM session and web sign-in (for reinstalling or testing)

VERSION="__VERSION__"

# ── defaults (user install) ───────────────────────────────────────────────────
INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/lib}/adam"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"

FORCE=0
SYSTEM=0
UNINSTALL=0
LOSSLESS=1
TRAY=ask   # ask | yes | no
KEEP_DATA=0

# ── launcher directory ───────────────────────────────────────────────────────
# The command is installed as `adam`. The standard home for user executables is
# $HOME/.local/bin (XDG Base Directory spec 0.8, systemd file-hierarchy(7)); putting it on PATH
# is the distribution's job, so this installer does not edit shell startup files: the shell and
# how it is configured are the user's business, and the installer cannot know them. The one
# adaptation is to the user's *current* PATH: if ~/.local/bin is not on it but ~/bin (the older
# convention) is, the launcher goes there so the command works immediately.
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; esac; return 1; }

for arg in "$@"; do
    case "$arg" in
        --force)    FORCE=1 ;;
        --system)   SYSTEM=1 ;;
        --uninstall) UNINSTALL=1 ;;
        --keep-data) KEEP_DATA=1 ;;
        --no-lossless) LOSSLESS=0 ;;
        --tray-support) TRAY=yes ;;
        --no-tray-check) TRAY=no ;;
        --help|-h)
            echo "Usage: $0 [--force] [--system] [--no-lossless] [--tray-support | --no-tray-check] [--uninstall [--keep-data]]"
            exit 0 ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

if [ "$SYSTEM" = "1" ]; then
    INSTALL_DIR="/opt/adam"
    BIN_DIR="/usr/local/bin"
    DESKTOP_DIR="/usr/share/applications"
    ICON_DIR="/usr/share/icons/hicolor/256x256/apps"
fi

if [ "$SYSTEM" != "1" ] && ! on_path "$BIN_DIR" && [ -d "$HOME/bin" ] && [ -w "$HOME/bin" ] && on_path "$HOME/bin"; then
    BIN_DIR="$HOME/bin"
fi

# Remove the block Adam wrote ("Adam launch at login" markers) from a compositor config; a symlinked config is
# written through the link, so a dotfiles repo stays in step.
strip_adam_block() {
    [ -f "$1" ] && grep -q "Adam launch at login (managed by Adam" "$1" 2>/dev/null || return 0
    tmp=$(mktemp) || return 0
    awk '/>>> Adam launch at login \(managed by Adam/ { skip = 1 } !skip { print } /<<< Adam launch at login <<</ { skip = 0 }' "$1" > "$tmp" \
        && cat "$tmp" > "$1"
    rm -f "$tmp"
}

# Drop adam.desktop from x-scheme-handler lines of a mimeapps.list. Only an exact adam.desktop after "=" or ";" goes,
# so another application's entry (winpodx-adam.desktop, say) is never touched; a line left empty is removed.
strip_adam_mime() {
    [ -f "$1" ] && grep -q "adam\.desktop" "$1" 2>/dev/null || return 0
    tmp=$(mktemp) || return 0
    sed -e 's/\([=;]\)adam\.desktop;\{0,1\}/\1/g' "$1" | sed -e '/^x-scheme-handler\/[^=]*=[[:space:]]*;*[[:space:]]*$/d' > "$tmp" \
        && cat "$tmp" > "$1"
    rm -f "$tmp"
}

# ── uninstall ─────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = "1" ]; then
    rm -rf "$INSTALL_DIR"
    for d in "$BIN_DIR" "$HOME/.local/bin" "$HOME/bin"; do
        # only a launcher this installer wrote (it execs the installed binary)
        if [ -f "$d/adam" ] && grep -qF "$INSTALL_DIR/adam" "$d/adam" 2>/dev/null; then
            rm -f "$d/adam"
        fi
    done
    rm -f  "$DESKTOP_DIR/adam.desktop"
    rm -f  "$ICON_DIR/adam.png"
    update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true

    # Everything else Adam set up for this user. The config, data and cache folders follow the XDG variables.
    CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
    DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
    CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"

    # Launch at login: the autostart entry, the systemd user unit, and the marked block Adam may have put in a
    # compositor config (its toggle in Settings → Startup writes exactly one of these).
    rm -f "$CFG/autostart/adam.desktop"
    if [ -f "$CFG/systemd/user/adam-autostart.service" ]; then
        systemctl --user disable adam-autostart.service >/dev/null 2>&1 || true
        rm -f "$CFG/systemd/user/adam-autostart.service"
        systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    for f in "$CFG/hypr/hyprland.conf" "$CFG/sway/config" "$HOME/.sway/config" "$CFG/i3/config" "$HOME/.i3/config" \
             "$CFG/niri/config.kdl" "$CFG/labwc/autostart" "$CFG/bspwm/bspwmrc" "$CFG/river/init"; do
        strip_adam_block "$f"
    done
    # The link types Adam was made the handler of (Settings → Links): only entries that are exactly adam.desktop.
    for f in "$CFG/mimeapps.list" "$DATA/applications/mimeapps.list"; do strip_adam_mime "$f"; done

    # Settings, the DRM session (its token), the web sign-in (the Electron session) and every cache. --keep-data
    # leaves them, for a reinstall or for testing.
    if [ "$KEEP_DATA" = "1" ]; then
        echo "Uninstalled Adam. Kept your settings and sign-in in $CFG/adam."
        echo "To remove them too:  rm -rf \"$CFG/adam\" \"$CACHE/adam\""
    else
        for d in "$CFG/adam" "$CFG/apple-music-linux" "$CFG/aml" "$CACHE/adam"; do
            [ -n "$HOME" ] && rm -rf "$d"
        done
        echo "Uninstalled Adam, including your settings, sign-in and caches."
    fi
    exit 0
fi

# ── version guard ─────────────────────────────────────────────────────────────
if [ "$FORCE" = "0" ] && [ -f "$INSTALL_DIR/.version" ]; then
    installed=$(cat "$INSTALL_DIR/.version")
    if [ "$installed" = "$VERSION" ]; then
        echo "Adam $VERSION is already installed."
        echo "Run: adam   or pass --force to reinstall."
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

echo "Installing Adam $VERSION..."
mkdir -p "$INSTALL_DIR"

tail -c +"$PAYLOAD_START" "$0" \
    | zstd -d --long=31 -q \
    | tar -x --strip-components=1 -C "$INSTALL_DIR"

# ── permissions ───────────────────────────────────────────────────────────────
chmod +x \
    "$INSTALL_DIR/adam" \
    "$INSTALL_DIR/chrome_crashpad_handler" \
    "$INSTALL_DIR/resources/engine"

# chrome-sandbox: needs setuid root for the Chromium sandbox.
# Without it we fall back to --no-sandbox in the launcher (safe for local use).
if [ "$SYSTEM" = "1" ] && [ "$(id -u)" = "0" ]; then
    chown root:root "$INSTALL_DIR/chrome-sandbox"
    chmod 4755      "$INSTALL_DIR/chrome-sandbox"
fi

# ── launcher ──────────────────────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/adam" <<EOF
#!/bin/sh
exec "$INSTALL_DIR/adam" --no-sandbox "\$@"
EOF
chmod +x "$BIN_DIR/adam"

# ── desktop entry + icon ──────────────────────────────────────────────────────
mkdir -p "$DESKTOP_DIR" "$ICON_DIR"

# Resolve the best app icon: bundled icon.png > tray-icon.png fallback
APP_ICON="$INSTALL_DIR/resources/icon.png"
if [ ! -f "$APP_ICON" ]; then
    APP_ICON="$INSTALL_DIR/resources/tray-icon.png"
fi

# Copy to hicolor theme dir (for DEs that resolve icon names)
cp "$APP_ICON" "$ICON_DIR/adam.png" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

# Use absolute path for Icon= — bypasses icon theme cache entirely,
# guaranteed to show the correct icon regardless of DE cache state.
# (Freedesktop spec: absolute paths are used directly, no theme lookup.)
cat > "$DESKTOP_DIR/adam.desktop" <<EOF
[Desktop Entry]
Name=Adam
GenericName=Music Player
Comment=Apple Music desktop client for Linux and Windows
Exec=$INSTALL_DIR/adam --no-sandbox %u
Icon=$APP_ICON
Type=Application
Categories=AudioVideo;Music;Network;
StartupWMClass=Adam
MimeType=x-scheme-handler/adam;x-scheme-handler/music;x-scheme-handler/musics;x-scheme-handler/itms;x-scheme-handler/itmss;x-scheme-handler/itunes;x-scheme-handler/itals;x-scheme-handler/italss;x-scheme-handler/itvls;x-scheme-handler/itvlss;x-scheme-handler/itsradio;x-scheme-handler/itunesradio;x-scheme-handler/daap;x-scheme-handler/itpc;x-scheme-handler/ame;
Keywords=music;apple;streaming;
EOF

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
xdg-mime default adam.desktop x-scheme-handler/adam 2>/dev/null || true

# ── FairPlay libraries (lossless) ─────────────────────────────────────────────
# Apple's Android FairPlay libraries cannot be redistributed with Adam, so they are
# downloaded here from pinned sources and checked against SHA-256 sums
# (resources/fairplay-libs.lock). They live per user, so a system-wide install
# leaves them to each user's first launch, which fetches them automatically.
FETCH="$INSTALL_DIR/resources/fetch-fairplay-libs.sh"
if [ "$LOSSLESS" = "1" ] && [ "$SYSTEM" != "1" ] && [ -f "$FETCH" ]; then
    echo "Downloading Apple's FairPlay libraries for lossless playback (~65 MB)..."
    if sh "$FETCH"; then
        :
    else
        echo "Lossless playback is off for now; Adam will retry on its next launch,"
        echo "or run: sh \"$FETCH\""
    fi
fi

# ── system tray (optional) ────────────────────────────────────────────────────
# Adam's tray icon needs a StatusNotifier host on the session bus. KDE Plasma, MATE, Cinnamon, LXQt, Budgie, Deepin,
# COSMIC and current Xfce have one; GNOME does not, and a bare Wayland compositor needs a bar with a tray module.
# On X11 the older XEmbed tray is used, which the usual bars provide. This only offers the package for the desktop in
# use: nothing is installed without a yes (or --tray-support), and a refusal or a failure never stops the install.
# >>> tray functions
tray_host() {
    command -v dbus-send >/dev/null 2>&1 || { echo unknown; return; }
    out=$(dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
        org.freedesktop.DBus.NameHasOwner string:org.kde.StatusNotifierWatcher 2>/dev/null) || { echo unknown; return; }
    case "$out" in *"boolean true"*) echo true ;; *"boolean false"*) echo false ;; *) echo unknown ;; esac
}

pkg_install_cmd() { # $1 = package; prints the install command for this distribution, or nothing
    rel="${ADAM_OS_RELEASE:-/etc/os-release}"
    [ -r "$rel" ] || return 0
    ids=$(sed -n 's/^ID=//p;s/^ID_LIKE=//p' "$rel" | tr -d '"' | tr '\n' ' ' | tr 'A-Z' 'a-z')
    case " $ids " in
        *" arch "*|*" cachyos "*|*" manjaro "*|*" endeavouros "*|*" garuda "*|*" artix "*) echo "sudo pacman -S --needed $1" ;;
        *" debian "*|*" ubuntu "*|*" linuxmint "*|*" pop "*|*" elementary "*|*" zorin "*) echo "sudo apt install $1" ;;
        *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*|*" nobara "*) echo "sudo dnf install $1" ;;
        *" opensuse "*|*" opensuse-leap "*|*" opensuse-tumbleweed "*|*" suse "*|*" sles "*) echo "sudo zypper install $1" ;;
    esac
}

tray_offer() {
    [ "$TRAY" = "no" ] && return 0
    [ "$(tray_host)" = "false" ] || return 0
    desk=$(printf '%s:%s:%s' "$XDG_CURRENT_DESKTOP" "$XDG_SESSION_DESKTOP" "$DESKTOP_SESSION" | tr 'A-Z' 'a-z')
    enable=""
    case ":$desk:" in
        *:gnome:*|*:gnome-flashback:*|*:ubuntu:*)
            pkg=gnome-shell-extension-appindicator
            enable="gnome-extensions enable appindicatorsupport@rgcjonas.gmail.com" ;;
        *:kde:*|*:plasma:*|*:x-cinnamon:*|*:cinnamon:*|*:mate:*|*:lxqt:*|*:budgie:*|*:budgie-desktop:*|*:deepin:*|*:cosmic:*|*:xfce:*)
            return 0 ;; # the panel has its own tray; it is just not running
        *)
            [ "$XDG_SESSION_TYPE" = "wayland" ] || return 0 # X11 bars have the XEmbed tray
            pkg=waybar ;;
    esac
    cmd=$(pkg_install_cmd "$pkg")
    echo ""
    echo "No system tray was found on this desktop, so Adam's tray icon will not show."
    if [ "$pkg" = "waybar" ]; then
        echo "A bar with a tray module provides one, for example Waybar: enable its \"tray\" module and start it."
    else
        echo "GNOME needs the AppIndicator extension for a tray."
    fi
    if [ -z "$cmd" ]; then echo "Package to install: $pkg"; return 0; fi
    if [ "$TRAY" = "yes" ]; then
        answer=y
    elif [ -t 0 ]; then
        printf 'Install it now with: %s ? [y/N] ' "$cmd"; read -r answer
    else
        echo "To install it:  $cmd"; [ -n "$enable" ] && echo "Then:           $enable"; return 0
    fi
    case "$answer" in
        y|Y|yes|YES)
            if sh -c "$cmd"; then
                [ -n "$enable" ] && { sh -c "$enable" 2>/dev/null || true; echo "Log out and back in to start using the tray."; }
            else
                echo "That did not work; the tray is optional, Adam is installed."
            fi ;;
        *) echo "Skipped. Later:  $cmd"; [ -n "$enable" ] && echo "Then:            $enable" ;;
    esac
    return 0
}
# <<< tray functions
tray_offer || true

# ── version stamp ─────────────────────────────────────────────────────────────
echo "$VERSION" > "$INSTALL_DIR/.version"

echo ""
echo "Adam $VERSION installed to $INSTALL_DIR"
echo "Launcher: $BIN_DIR/adam"

if ! on_path "$BIN_DIR"; then
    echo ""
    echo "Note: $BIN_DIR is not on your PATH in this session, so 'adam' will not be"
    echo "found by name yet. It is the standard per-user location for commands, and most systems"
    echo "add it automatically at your next login once the directory exists. If the command is"
    echo "still not found after logging in again, add $BIN_DIR to PATH in your shell's startup file."
    echo "Until then:  $BIN_DIR/adam"
fi

exit 0
__PAYLOAD_BELOW__
