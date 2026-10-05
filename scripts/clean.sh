#!/usr/bin/env bash
# clean.sh — remove generated build output.
#
#   scripts/clean.sh             intermediates: compiler objects, the generated embedded-blob
#                                sources (~400 MB), probe/test binaries, installer staging,
#                                stray engine binaries
#   scripts/clean.sh --dist      also packaged output: dist/, AppImage, electron/dist/linux-unpacked
#   scripts/clean.sh --all       also the built library (drm/libdrm_client.so) and electron/dist,
#                                including electron/dist/resources — the engine `npx electron .`
#                                runs; rebuild with `npm run build:go` and `make -C drm`
#   scripts/clean.sh --dry-run   list what would be removed, remove nothing (combine with the above)
#
# Never touched: sources, node_modules, drm/files (your Apple session), drm/rootfs.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DRY=0; DIST=0; ALL=0
for arg in "$@"; do
    case "$arg" in
        -n|--dry-run) DRY=1 ;;
        --dist)       DIST=1 ;;
        --all)        DIST=1; ALL=1 ;;
        -h|--help)    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
done

targets=(
    drm/embedded_blobs drm/corefp_probe drm/tests/test_drm_client drm/tests/test_drm_realworld
    .installer-stage engine/build engine/core/apple-music-cli
)
while IFS= read -r -d '' f; do targets+=("${f#"$REPO"/}"); done < <(
    find "$REPO/drm" "$REPO/engine" \( -name '*.o' -o -name '*.test' \) -type f -print0)

if [ "$DIST" = 1 ]; then
    targets+=(dist electron/dist/linux-unpacked)
    for f in "$REPO"/electron/dist/*.AppImage "$REPO"/electron/dist/builder-*.y*ml; do
        [ -e "$f" ] && targets+=("${f#"$REPO"/}")
    done
fi
if [ "$ALL" = 1 ]; then
    targets+=(drm/libdrm_client.so electron/dist)
fi

total=0
for rel in "${targets[@]}"; do
    path="$REPO/$rel"
    [ -e "$path" ] || continue
    kb=$(du -sk "$path" | cut -f1)
    total=$((total + kb))
    printf '%s %8s  %s\n' "$([ "$DRY" = 1 ] && echo would-remove || echo removed)" "$((kb / 1024))M" "$rel"
    [ "$DRY" = 1 ] || rm -rf "$path"
done
echo "$([ "$DRY" = 1 ] && echo 'would free' || echo 'freed') $((total / 1024)) MB"
