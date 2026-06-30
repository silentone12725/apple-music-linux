# Summary of Changes

- Embedded wrapper and apple-music-cli binaries with per-arch build tags (amd64/arm64) and added split build scripts for each architecture.
- Added embedded rootfs extraction (amd64 + arm64), created required data directories, and switched to the rootless wrapper binary.
- Implemented playback hijack: songs stream via apple-music-cli with buffering overlay; radio/music video stay on web audio; web audio is muted/restored accordingly.
- Added apple-music-cli integration with config generation, embedded CLI extraction, and process management.
- Fixed wrapper startup: persistent data dir, -F on first login, stdin credentials, unsupported-arch guard, and pre-created base directories.
- Updated navigation flow to load Apple Music as the top-level page and removed iframe; use DOM-ready JS redirect for Wails v2 and set ProgramName.
- Added amd64/arm64 build scripts and embedded asset handling; adjusted .gitignore and added placeholder files for embedding.
- Removed legacy wrapper Docker folders from the repo (later reintroduced rootfs as embedded assets).

## Files and Folders Added

- internal/embedded/embedded_linux_amd64.go
- internal/embedded/embedded_linux_arm64.go
- internal/embedded/embedded_linux_unsupported.go
- internal/embedded/rootfs_amd64/
- internal/embedded/rootfs_arm64/
- internal/embedded/wrapper_amd64
- internal/embedded/wrapper_arm64
- internal/embedded/apple-music-cli_amd64
- internal/embedded/apple-music-cli_arm64
- internal/embedded/rootfs_amd64/data/KEEP
- internal/embedded/rootfs_arm64/data/KEEP
- internal/embedded/rootfs_arm64/dev/KEEP
- cliplayer/player.go
- scripts/build-amd64.sh
- scripts/build-arm64.sh
- SUMMARY.md

## Files Updated

- wrapperproc/wrapperproc.go
- main.go
- app.go
- frontend/src/preload.js
- frontend/src/index.html
- .gitignore

## Notes

- Wrapper now uses the embedded rootfs; extracted to ~/.config/apple-music-linux/wrapper-data/rootfs.
- apple-music-cli is embedded and extracted to ~/.config/apple-music-linux/apple-music-cli/bin.
- For login persistence, Apple Music is now loaded as the top-level page (no iframe).

## Tests Run

- wails dev -tags webkit2_41
- go run /tmp/wrapper_check.go
