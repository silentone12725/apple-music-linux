# Stable and nightly update channels

Design proposal, based on nightly `7fdcc91a051c4b1f7ba6fe9980271f99ddce3792`.
This document adds no updater implementation and enables no automatic publication.

## Existing distribution

The manual `.github/workflows/release.yml` builds the Linux `.run` installer,
AppImage and Windows NSIS installer, and attaches them to a draft release.
Published v1.5.0 includes those packages and `SHA256SUMS`. The current CI workflow
checks pull requests and pushes to main; it does not publish every nightly push.

## Proposed distribution

Build each nightly once in CI rather than requiring every client to compile it.
Reuse the existing packaging jobs, bundled VLC/FFmpeg, renderer-bundle checks and
Ubuntu 22.04 / glibc 2.35 baseline.

- **Stable:** consume published, non-draft, non-prerelease releases with a compatible
  package. Keep stable publication as an explicit maintainer action.
- **Nightly:** test and build the exact nightly commit, publish an artifact under an
  immutable commit-specific identity, and update a channel index only after the
  build succeeds. Cancel superseded builds. A failed build leaves the index intact.
- **Identity:** include channel, version, commit, build date, OS, architecture,
  package format, minimum updater version and package digest. The package.json
  version alone cannot distinguish successive nightlies.

## Client behavior

Check the selected channel at startup with a bounded timeout and backoff. Offline
or failed checks must still launch the installed version. Keep an existing channel
selection; use Stable for new general-purpose installs. Channel changes and
intentional downgrades must be explicit.

Download into staging and verify size and SHA-256 against authenticated release
metadata. A separately hosted channel index needs a signed manifest and a pinned
verification key. Validate HTTPS destinations, archive paths, symlinks, platform,
manifest and completeness before any replacement. Never execute instructions from
the update feed. Preserve account state and preferences outside the payload.

For a user-installed Linux directory, share an installation lock with the launcher,
wait for the application to exit, replace on the same filesystem with rollback
recovery, and retain the previous build until startup is confirmed. Validate engine
startup in an isolated profile without credentials or playback; validate normal UI
startup after installation without treating a required sign-in as a failed update.

AppImage replacement preserves executable permissions and the previous image.
Windows uses its NSIS installer after exit, with its own recovery tests. Flatpak and
other package-managed installs use their package manager. System installations use
their privileged installer rather than an unprivileged updater writing system files.

Expose installed build, selected channel, available update, progress and restart in
Settings. A nightly failure must not silently switch the client to Stable.

## Acceptance checks

Exercise offline/rate-limited checks, truncated downloads, bad hashes, untrusted
metadata, wrong platform, malformed archives, a running application, busy locks,
disk exhaustion, an interrupted replacement and failed startup. Each case must
preserve or recover the working installation. Also cover unchanged commits,
channel changes, draft releases and failed nightly builds.

Local source builders can remain available for development installations with
personal patches. Include patch content in their build identity and fail safely
on patch conflicts. This is a development fallback, not a requirement for ordinary
nightly clients.

## Review and rollout

Agree on artifact identity, channel metadata and recovery behavior first. Then land
CI packaging, platform-specific installation and the Settings flow in separately
reviewable changes. No update channel, release or repository setting is activated
by this proposal.
