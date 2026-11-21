#!/usr/bin/env bash
# Fails if a commit message or a title contains one of GitHub's native closing keywords followed by an issue reference
# (close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved, optional colon). Only the issue tracker may close
# issues, so use the non-closing "Refs #N" here; "Fixes #N" belongs in the PR body.
#   scripts/check-closing-keywords.sh --range A..B [--title "PR title"]
#   scripts/check-closing-keywords.sh --message-file FILE        (for a commit-msg hook)
set -euo pipefail

range=""; title=""; msgfile=""
while [ $# -gt 0 ]; do
    case "$1" in
        --range) range="$2"; shift ;;
        --title) title="$2"; shift ;;
        --message-file) msgfile="$2"; shift ;;
        -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
[ -n "$range$title$msgfile" ] || { echo "nothing to check" >&2; exit 2; }

# keyword, optional colon, whitespace, then #N or owner/repo#N; the keyword must start a word.
pattern='(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?):?[[:space:]]+([[:alnum:]_.-]+/[[:alnum:]_.-]+)?#[0-9]+'
bad=0

report() { echo "::error::$1: native closing keyword (use \"Refs #N\"; \"Fixes #N\" belongs in the PR body)"; echo "    $2"; bad=1; }

if [ -n "$title" ] && printf '%s\n' "$title" | grep -Eiq "$pattern"; then report "PR title" "$title"; fi
if [ -n "$msgfile" ]; then
    # ignore git's own comment lines in a commit-msg hook
    if grep -v '^#' "$msgfile" | grep -Eiq "$pattern"; then report "commit message" "$(grep -v '^#' "$msgfile" | grep -Ei "$pattern" | head -1)"; fi
fi
if [ -n "$range" ]; then
    while IFS= read -r sha; do
        msg="$(git log -1 --format=%B "$sha")"
        if printf '%s\n' "$msg" | grep -Eiq "$pattern"; then report "commit ${sha:0:10}" "$(printf '%s\n' "$msg" | grep -Ei "$pattern" | head -1)"; fi
    done < <(git rev-list "$range")
fi
exit "$bad"
