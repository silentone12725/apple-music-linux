# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue or on Discord:

- Use GitHub's private vulnerability reporting: <https://github.com/silentone12725/apple-music-linux/security/advisories/new>

Include what you found, how to reproduce it, and the Adam version. You will get an acknowledgement, and we will agree on a disclosure date with you before anything is published.

## Scope

In scope: the Adam app and its local engine (loopback API, DRM session handling, update and install scripts). Out of scope: Apple's own services and libraries, and issues that need an already-compromised machine.

## Reports and logs

Bug reports created from Adam are sanitized, but sanitizing is best-effort. If you think a log or report exposed a secret, tell us privately using the link above and rotate the secret.
