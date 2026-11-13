# Contributing to Adam

Thanks for helping. Short version:

- **Bugs:** open **Settings, Report a bug** inside Adam (or the *Bug report* form on GitHub). Reports are public and permanent, so read what you attach first.
- **Questions and chat:** the [Discord server](https://discord.gg/tY4v52KpVV).
- **Pull requests** target the `nightly` branch; `main` is the stable release branch. Run the checks in the PR template.

## Linking a PR to an issue

The issue tracker (see [TRACKING.md](TRACKING.md)) follows your PR to the release that ships it.

- In the **PR body** write `Fixes #123` (also `Closes`, `Resolves`) on its own line for each issue the PR fixes. Use `Refs #123` for related issues.
- In **commit messages and the PR title** use only `Refs #123`. Never `Fixes`, `Closes` or `Resolves`: GitHub would close the issue the moment the commit lands on `main`, before any release exists, and CI rejects those words.
- The tracker marks the issue *fixed in nightly* when the fix is on `nightly`, and closes it once a published release contains it.

## Security

Please do not report vulnerabilities in a public issue. See [SECURITY.md](SECURITY.md).
