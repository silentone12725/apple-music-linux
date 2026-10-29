#!/bin/sh
# Writes one file of exported function names per staged library into ./syms (input for symtest).
set -eu
here=$(cd "$(dirname "$0")" && pwd); lib=${1:-$here/../../drm/rootfs-6.5.2/system/lib64}
mkdir -p "$here/syms"
for f in "$lib"/*.so; do
  readelf --dyn-syms -W "$f" | awk '$4=="FUNC" && $7!="UND" && $8!="" {sub(/@.*/,"",$8); print $8}' | sort -u > "$here/syms/$(basename "$f").txt"
done
