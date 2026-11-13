## Summary

<!-- What changes and why. -->

## Linked issues

<!--
Put "Fixes #123" on its own line when this PR fixes an issue, and "Refs #123" for related ones. The issue tracker reads
this body, and closes the issue only after the fix is in a published release.
Do not put closing keywords (Fixes, Closes, Resolves) in commit messages or in the PR title: CI rejects them.
-->
Fixes #

## Checklist

- [ ] Targets `nightly` (unless it is a hotfix or a `.github` change that must reach `main` first)
- [ ] `scripts/lint.sh` passes
- [ ] `cd engine && go test ./...` and `cd electron && node --test test/*.test.mjs test/engine/*.test.mjs test/github/*.test.mjs` pass
- [ ] After editing `electron/src/engine-playback.js` or `electron/src/engine/*.js`: `cd electron && npm run build:engine`
- [ ] No build artifacts committed (`electron/dist`, `engine/build`, `*.AppImage`, `drm/rootfs`, `drm/files`)
- [ ] Touches the ALAC / VLC / lossless path: yes / no (if yes, say how it was checked)
