#!/usr/bin/env bash
# Validates a release tag and prints the line to add to .github/release-tags.json. It refuses unless:
#   - the tag exists and peels to exactly one commit,
#   - it is a published, non-draft, non-prerelease GitHub release of that name,
#   - the commit is an ancestor of main and comparable (ancestor or descendant) with every tag already in the manifest,
#   - the manifest has no different SHA recorded for the tag.
# It prints nothing on refusal. Review the resulting PR: that human review is the gate for closing issues.
#   scripts/record-release-tag.sh vX.Y.Z [--repo owner/name] [--main-ref origin/main]
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:-}"; shift || true
repo=""; mainref="origin/main"
while [ $# -gt 0 ]; do
    case "$1" in
        --repo) repo="$2"; shift ;;
        --main-ref) mainref="$2"; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || { echo "usage: $0 vX.Y.Z" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
manifest=".github/release-tags.json"
fail() { echo "refusing: $1" >&2; exit 1; }

git rev-parse -q --verify "refs/tags/$tag" >/dev/null || fail "tag $tag does not exist locally (git fetch --tags)"
[ "$(git for-each-ref "refs/*/$tag" | wc -l)" = 1 ] || fail "$tag is ambiguous: more than one ref has that name"
sha="$(git rev-parse "refs/tags/$tag^{commit}")"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail "$tag does not peel to exactly one commit"

[ -n "$repo" ] || repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
rel="$(gh release view "$tag" --repo "$repo" --json tagName,isDraft,isPrerelease,publishedAt 2>/dev/null)" || fail "no GitHub release named $tag"
jq -e --arg t "$tag" '.tagName == $t and .isDraft == false and .isPrerelease == false and (.publishedAt // "") != ""' <<<"$rel" >/dev/null \
    || fail "$tag is not a published, non-draft, non-prerelease release"

git merge-base --is-ancestor "$sha" "$mainref" || fail "$tag ($sha) is not an ancestor of $mainref"

existing="$(jq -r --arg t "$tag" '.tags[$t] // empty' "$manifest")"
if [ -n "$existing" ] && [ "$existing" != "$sha" ]; then fail "the manifest already records $tag at $existing, not $sha"; fi
while read -r other; do
    [ -n "$other" ] || continue
    git cat-file -e "$other^{commit}" 2>/dev/null || fail "manifest entry $other is not in this clone"
    if ! git merge-base --is-ancestor "$other" "$sha" && ! git merge-base --is-ancestor "$sha" "$other"; then
        fail "$tag is not comparable with manifest entry $other (releases must be on one line of history)"
    fi
done < <(jq -r '.tags | to_entries[] | select(.key != "'"$tag"'") | .value' "$manifest")

if [ "$existing" = "$sha" ]; then echo "already recorded: \"$tag\": \"$sha\""; else echo "    \"$tag\": \"$sha\""; fi
cat >&2 <<NOTE

Checklist for this release:
  [ ] Review the line above in a PR that adds it to $manifest.
  [ ] Settings > General > Issues: "Auto-close issues with merged linked pull requests" is OFF (it cannot be read through the API).
  [ ] Merge-commit title/message fields are PR_TITLE / BLANK for squash and merge, and the tag ruleset for v* has no bypass actors.
NOTE
