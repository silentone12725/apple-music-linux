# AMSKit JVM bridge

Hosts `libAMSKit.so` — Apple's own Android native GrandSlam/anisette auth library,
extracted unmodified from the Apple Music Android APK — inside OpenJDK on Linux via
hybris, so GrandSlam sign-in can be driven from plain Java instead of needing an Android
emulator. This supersedes the earlier response-forging spike (`stage22_inline_resp` /
`stage23_real_http`): AMSKit does its own HTTP via a Java `IAndroidHTTPProvider` we
implement, so there's no response to forge — we just drive the real library with real
network traffic.

**Status: session initializes and runs end-to-end, but sign-in itself does not yet
succeed.** See "Current status" below before spending time on this — several deep
hypotheses have already been tried and ruled out.

## Quick start

```sh
./setup.sh /path/to/apple-music-7.0.1.apk    # builds everything into build/
./run.sh adam.AdamAuth "$PWD/bridge/libamskit_jni_bridge.so" "$PWD/build/libs/amskit-v52.jar" \
    <state-dir> <cred-file|INTERACTIVE> <stage9-bin> <prov-dir> [allowReprovision]
```

The APK is never committed to this repo — download Apple Music 7.0.1 for Android
yourself (an APK mirror works) and pass its path to `setup.sh`. `versionCode 1622` /
`versionName 7.0.1` is the build this was developed and tested against.

### Running it

`AdamAuth`'s arguments (positional, see `java/adam/AdamAuth.java:main`):

| # | arg | meaning |
|---|---|---|
| 1 | bridge.so | `bridge/libamskit_jni_bridge.so` |
| 2 | classes.jar | `build/libs/amskit-v52.jar` |
| 3 | state-dir | holds `apple-roots.pem` (CA bundle) and, unless INTERACTIVE, `cred_username.txt` |
| 4 | cred-file \| `INTERACTIVE` | PET token filename in state-dir, or `INTERACTIVE` to prompt for Apple ID + password on the terminal |
| 5 | stage9-bin | path to `spike/newstack/stage9_prov_native` (built separately, see its own README/NOTES) |
| 6 | prov-dir | holds `adi.pb` + `ANDROID_ID` for the device identity to use |
| 7 | allowReprovision | `true`/`false` (default `true`); **must be `false`** when prov-dir is a mirror of a real device's identity — see "Safety notes" |

`INTERACTIVE` mode prompts for the Apple ID and password directly on the controlling
terminal via `System.console()`, which refuses to run outside a real TTY — it cannot be
driven from a script or pipe. The password is read with echo off, never written to a
file/log/argument, and the backing `char[]` is zeroed after use.

If AMSKit shows a verification-code (2FA) dialog, it's printed to the terminal and the
code is read the same way — directly from the console, never logged.

### Safety notes

- `allowReprovision=false` makes `startProvisioning` refuse (throwing, which surfaces in
  AMSKit's error chain) instead of letting AMSKit silently trigger a real
  `finishMachineProvisioning` against Apple's servers. Always use `false` when `prov-dir`
  mirrors a real device's identity (e.g. pulled from a phone) — re-provisioning that
  identifier from here would hit Apple's servers under the *same* identifier the real
  device is actively using, risking that device's own session.
- Response bodies under 4KB are logged as base64 (server-side diagnostic text only,
  never request bodies, which can carry SRP exchange data).
- Credentials are never committed. `spike/.gitignore`'s `state/` pattern covers any
  `state/` directory under `spike/newstack/`; verify with `git check-ignore -v` before
  adding a new one.

## Architecture

- `bridge/amskit_jni_bridge.c` — glibc shared library. Loads `libAMSKit.so` through
  hybris (`drm/embedded_loader.h`), forwards `JNI_OnLoad` to the JVM, and exports
  `Java_adam_Native_find`/`reg` so Java can resolve and `RegisterNatives` AMSKit's ~3827
  `Java_*` methods itself (`JNI_OnLoad` doesn't register them — the JVM can't `dlsym`
  them directly since the library is loaded via hybris, not the JVM's own loader).
- `java/adam/Native.java` — `registerAll(jar, packagePrefix)`: walks a jar's `.class`
  entries, finds `native` methods via reflection, mangles their JNI names, and calls the
  bridge's `find`/`reg` to wire them up. Called once for AMSKit's own classes and once
  for JavaCPP's own `Pointer$NativeDeallocator` (JavaCPP's generated static initializers
  expect their own natives to already be registered too).
- `java/adam/AdamAuth.java` — the actual auth flow:
  - `HttpProv` (`IAndroidHTTPProvider`) — real HTTP via `java.net.HttpURLConnection`.
  - `anisetteProxy` (`INativeAnisetteProvider`, via `java.lang.reflect.Proxy`) —
    `request()` calls `stage9_prov_native otp` fresh each time (ADI OTP is one-time;
    serving a cached value forever got AMSKit stuck retrying it endlessly).
    `startProvisioning`/`finishProvisioning` drive `stage9_prov_native provision`'s
    combined-mode protocol (one persistent subprocess per session — the ADI session
    handle lives only in that process's memory, see `project-linux-native-anisette`
    memory). Hard-capped at 3 `request()` calls unless reset by a successful
    `finishProvisioning`, so a real failure terminates instead of looping forever.
  - `InterruptHandler` (`IInterruptHandlerAdaptor`) — 2FA/dialog prompts, answered
    directly on the console (see above).
- `java/adam/Smoke.java` — minimal standalone smoke test (just builds a `Session`, no
  auth attempt).
- `java/android/system/ErrnoException.java` — stub; AMSKit's native code references
  `android.system.ErrnoException` but nothing in this harness actually needs Android's
  real implementation, just the class to exist.

## Gotchas (each one cost real debugging time)

- **Java classes and `libAMSKit.so` must be the exact same build.** Use `lib/x86_64/*.so`
  from the *same* APK you ran dex2jar on — a mismatched native-library version throws
  during `JNI_OnLoad`.
- **dex2jar's output (class version 50) fails JVM bytecode verification** (it doesn't
  emit `StackMapTable` correctly) — `setup.sh` patches the class-file major-version byte
  to 52, and `run.sh` runs the JVM with
  `-XX:+UnlockDiagnosticVMOptions -XX:-BytecodeVerificationRemote -XX:-BytecodeVerificationLocal`.
  A `VerifyError` during `JNI_OnLoad` surfaces as a confusing native-looking `SIGSEGV` in
  `_Unwind_Resume` (C++ exception unwinding through hybris code doesn't work) — check
  `-Xlog:class+load` for a `VerifyError` first if you see that.
- **hybris's libc shim is missing `stdout`/`stderr`/`stdin`, `__register_atfork`, and
  `__memchr_chk`** — the bridge adds them via `embedded_set_hook_callback`.
- **`stage9_prov_native` hardcodes `HYBRIS_LINKER_DIR` relative to its own directory**
  (`setenv(..., "../../drm/hybris-linker", 1)`, overwrite=1) — when invoking it via
  `ProcessBuilder`, set the working directory to the binary's own folder, or the hybris
  linker load fails.
- **dex2jar renames `kotlin.Unit.INSTANCE`** to a single letter (`a` in this build) —
  find the singleton field by type, not name.
- **`StartProvisionResponse`'s public constructor takes `kotlin.jvm.internal.g`**, not
  `DefaultConstructorMarker` as jadx's decompiled name (`C5268g`) might suggest —
  `javap` on the actual jar is the source of truth, not jadx's renamed classes.

## Current status (2026-11-20)

Session setup, provisioning, and the full JVM/hybris plumbing all work correctly —
confirmed against both freshly-provisioned Linux identities *and* a real phone's live,
currently-working identity (pulled via Frida from the phone's debuggable app clone, see
`project-grandslam-phone-fetch-and-sso` memory). **Sign-in itself fails with
`ec=-29004 "environment mismatch"` on the anisette-sync HTTP call**, consistently,
across every hypothesis tried:

- ❌ Credential type/value (idmsAuthToken vs PET token)
- ❌ Device-identity mismatch (tested with a 100%-genuine, currently-Apple-valid real
  phone identity + real live PET token — identical result)
- ❌ `dsid` (the real app does pass a dsid to `ADIOTPRequest`, but direct verification on
  the real phone's own live ADI state shows the account's real dsid is *not* provisioned
  even there — `-2` is correct)
- ❌ Device fingerprint fields (cross-verified against the real app's decompiled
  defaults and a connected physical device via `adb`)
- ❌ `BundleInfoWrapper` identifiers (`accountClientIdentifier`, `identifier` — both
  fixed to match the real app's actual values, found by reading its decompiled
  `AndroidBundleInfo` implementation)
- ❌ Header/encoding mismatch (logged the exact bytes handed to `OTPResponse` vs. the
  literal `X-Apple-I-MD`/`X-Apple-I-MD-M` header strings AMSKit sends — byte-for-byte
  identical)

One run got a different, deeper error (`-332000 idmsServiceError`) that looked like
progress past the anisette gate; a follow-up run under identical conditions did not
reproduce it, reverting to the standard `-29004` pattern. Treat that as noise, not a
lead, until it reproduces.

**Leading remaining hypothesis, not yet tested:** something at the TLS/HTTP transport
level (cipher suite order, HTTP/1.1 vs HTTP/2, connection-reuse pattern, or similar
fingerprinting signal) distinguishing our plain `HttpURLConnection`-based `HttpProv` from
whatever HTTP stack the real Android app uses (likely OkHttp, based on an `OkHttpCache/`
directory seen in its app data). Everything in the request's *logical content* has now
been exhaustively cross-checked against the real app's own source and a real device.

See the `amskit-jvm-bridge` memory note for the full, dated investigation log.
