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

## Rollback resistance and signing-key lifecycle

Signatures authenticate a build but do not establish that it is current. Give each
channel index a strictly increasing sequence number, an expiry time and a signed
minimum supported build sequence. Persist the highest verified index sequence and
accepted build sequence per channel outside the replaceable application directory,
under the installation lock. Reject expired metadata, lower index sequences and
builds below that channel's accepted sequence, even when their signatures are
valid. Do not use semantic version strings, commit dates or mutable nightly tags
as the ordering authority. An offline client keeps launching its installed build
but cannot install an update from expired metadata. Loss or corruption of trust
state requires explicit recovery; it must not reset the counters automatically.

An explicit user downgrade or channel switch may select an older build after
verification and a clear confirmation, but must not reduce the stored channel
watermarks. Local crash recovery may restore the retained last-known-good payload;
it is not permission to accept an older remote feed. Reject an index below the
signed minimum supported sequence during either operation. These rules assume the
client's local trust state and verification code have not been replaced by an
attacker with write access to the user's installation and state directories.

Ship a pinned, versioned root trust document with separate offline root keys and
shorter-lived channel-signing keys. Routine rotation publishes a new root version
signed by the old root threshold and the new root threshold; clients verify each
intermediate root version in order. The root authorizes channel keys, their roles
and validity periods. A root-signed revocation removes a compromised channel key
and advances the minimum acceptable metadata sequence; clients must refresh root
trust before accepting channel metadata and must reject signatures by revoked
keys. Fetching an update over HTTPS does not bypass these checks. Sign the package
identity and digest with the authorized channel role so metadata from another
channel cannot be substituted.

Publish replacement trust metadata before switching CI to new signing keys, keep
private root keys out of ordinary build jobs, and retain the root transition chain
for clients that missed releases. If the root threshold itself is compromised or
expired without a valid recovery path, stop automatic installation and require a
new trusted installer or independently verified recovery bundle. Do not accept a
new key merely because the same release server supplied it. Revocation cannot
undo an installation already accepted before the client learned of the compromise.

## Acceptance checks

Exercise offline/rate-limited checks, truncated downloads, bad hashes, untrusted
metadata, wrong platform, malformed archives, a running application, busy locks,
disk exhaustion, an interrupted replacement and failed startup. Each case must
preserve or recover the working installation. Also cover unchanged commits,
channel changes, draft releases and failed nightly builds. Verify replay of an
older validly signed build and index, expired/frozen metadata, persisted counters
after a crash, explicit local rollback without lowering watermarks, cross-channel
substitution, routine key rotation across missed releases, revoked channel keys,
and root compromise/recovery. An update must not install if its trust transition
or persistent rollback-protection state cannot be verified.

Local source builders can remain available for development installations with
personal patches. Include patch content in their build identity and fail safely
on patch conflicts. This is a development fallback, not a requirement for ordinary
nightly clients.

## Review and rollout

Agree on artifact identity, channel metadata and recovery behavior first. Then land
CI packaging, platform-specific installation and the Settings flow in separately
reviewable changes. No update channel, release or repository setting is activated
by this proposal.
