# How bug tracking works

Bugs live in GitHub Issues. A workflow (`tracking.yml`) keeps each issue's labels and a single tracking comment in step with the pull requests and releases that fix it. Nobody has to move cards by hand.

## The flow

1. A reporter opens an issue with the **Bug report** form, normally from **Settings, Report a bug** in Adam, which fills in the fields and a diagnostics block.
2. `triage.yml` adds scope labels (`comp:*`, `os:*`) from the form.
3. `tracking.yml` reads every pull request body, finds the issues it fixes (`Fixes #N`) or mentions (`Refs #N`), works out from git where each fix is, and sets the state labels:

| Label | Meaning |
|---|---|
| `needs-info` | no valid diagnostics block yet |
| `needs-triage` | waiting for a maintainer, or no fix is linked yet |
| `in-progress` | a fix PR is open |
| `fixed-in-nightly` | the fix is on `nightly`, not yet in a published release |
| `fixed-in-release` | the fix is in the latest published release |

4. When the fix is in a published release, and everything below is true, the tracker closes the issue.

## When the tracker closes an issue

All of these, with positive evidence (anything unknown blocks closure):

- every linked fix PR is merged and in the latest **published, non-draft, non-prerelease mainline release**, and none is reverted there;
- the release tag is trusted: it is listed in `.github/release-tags.json` at the commit it resolves to now, and an active tag ruleset with no bypass actors protects it;
- no `keep-open` label, no `reopened-needs-review` label, and no unreviewed reopen.

Revert detection is by commit content, not by words in a message: a revert counts only if its tree changes are the exact inverse of the fix. An unverifiable chain makes the fix *unknown*, which blocks closure.

## Labels

Each label has one writer, so workflows never fight.

| Owner | Labels |
|---|---|
| `triage.yml` | `comp:*`, `os:linux`, `os:windows` |
| `tracking.yml` | `needs-triage`, `needs-info`, `in-progress`, `fixed-in-nightly`, `fixed-in-release`, `closed-by-tracking`; it also adds `reopened-needs-review` |
| maintainers | everything else, and they alone remove `reopened-needs-review` |

If you **reopen an issue the tracker closed**, the tracker adds `reopened-needs-review` and will not close it again until a maintainer removes that label. `blocked` and `keep-open` are maintainer overrides.

Edit labels in `.github/labels.json` and run `scripts/sync-labels.sh` (idempotent; it never deletes labels unless `--prune` and the name is under `deprecated`).

## The diagnostics block

The reporter produces a block that starts with the line `Adam diagnostics v1`, then `formatVersion: 1` and `key: value` lines (at least five of: version, channel, commit, os, arch, kernel, desktop, session, install, electron, chromium, gpu, ffmpeg, engine, lossless, spatial). It must be under 8 KB and, if it is in a comment, written by the issue's author. A valid block only means the report is **complete**; it says nothing about whether it is safe to publish.

## One-time repository setup (maintainers)

The tracker is the only thing that should close issues, and it only trusts release tags it can verify. These are settings the workflows cannot make for you:

1. **Settings, General, Issues:** turn **off** "Auto-close issues with merged linked pull requests". (GitHub does not expose this setting through its API, so it is on the checklist printed by `scripts/record-release-tag.sh` and the tracker warns when it sees an issue closed by a commit.)
2. **Settings, General, Pull Requests:** set the squash and merge commit messages to *pull request title* / *blank* so a PR body can never leak a closing keyword into a commit: `squash_merge_commit_title = PR_TITLE`, `squash_merge_commit_message = BLANK`, `merge_commit_title = PR_TITLE`, `merge_commit_message = BLANK`. Check with a test PR on a fork.
3. **Settings, Rules, Rulesets:** an *active* tag ruleset covering your release tags (`v*`) that restricts updates, deletions and non-fast-forwards, with **no bypass actors**.
4. Record each release tag you trust: `scripts/record-release-tag.sh vX.Y.Z`, then commit the line it prints to `.github/release-tags.json` in a reviewed PR. Review each existing tag before you add it; the script cannot know whether a tag moved before the policy existed.
5. Run `scripts/sync-labels.sh` once.

## Recovery

- Everything is recomputed from GitHub and git on each run (every 3 hours, and sooner on events), so a failed run corrects itself on the next one. The tracking comment is only a display: delete it and it is rebuilt.
- Run it now: **Actions, Issue tracker, Run workflow**. A dry run: `GH_TOKEN=... GITHUB_REPOSITORY=owner/name node .github/scripts/reconcile.mjs --dry-run` from a full clone.
- If collection fails partway (a rate limit, a permission problem) the run changes nothing and says so in the job summary.

## Limits

- Fix inclusion relies on release commits keeping their SHAs (true while `main` is an ancestor of `nightly`). A squash from nightly into main breaks it and the tracker will say "unknown" rather than guess.
- Ancestry shows a fix was *included*, not that it still works; revert detection covers git reverts that are exact inverses, not hand-written ones.
- Workflows were developed with unit tests and an in-memory GitHub; the first real runs should be watched.
