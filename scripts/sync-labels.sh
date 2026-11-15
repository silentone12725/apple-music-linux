#!/usr/bin/env bash
# Creates or updates every label in .github/labels.json (idempotent: running it twice changes nothing).
# Never deletes a label, except names listed under "deprecated" when --prune is given.
#   scripts/sync-labels.sh [--repo owner/name] [--dry-run] [--prune]
set -euo pipefail
cd "$(dirname "$0")/.."

repo=""; dry=0; prune=0
while [ $# -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift ;;
        --dry-run) dry=1 ;;
        --prune) prune=1 ;;
        -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[ -n "$repo" ] || repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

# Validate before touching anything: unique names, known groups, colours.
jq -e '
  (.labels | map(.name) | length) == (.labels | map(.name) | unique | length)
  and all(.labels[]; (.group | IN("classification","state","resolution","lifecycle","priority","scope")) and (.color | test("^[0-9a-fA-F]{6}$")) and (.description | length <= 100))
' .github/labels.json >/dev/null || { echo ".github/labels.json failed validation" >&2; exit 1; }

jq -c '.labels[]' .github/labels.json | while read -r l; do
    name=$(jq -r .name <<<"$l"); color=$(jq -r .color <<<"$l"); desc=$(jq -r .description <<<"$l")
    if [ "$dry" = 1 ]; then echo "would sync: $name"; else
        gh label create "$name" --repo "$repo" --color "$color" --description "$desc" --force >/dev/null
        echo "synced: $name"
    fi
done

if [ "$prune" = 1 ]; then
    jq -r '.deprecated[]?' .github/labels.json | while read -r name; do
        [ -n "$name" ] || continue
        if [ "$dry" = 1 ]; then echo "would delete: $name"; else gh label delete "$name" --repo "$repo" --yes && echo "deleted: $name"; fi
    done
fi
