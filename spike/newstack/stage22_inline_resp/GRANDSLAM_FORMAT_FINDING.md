# GrandSlam auth format — captured from the Linux probe (stage22)

Captured by hooking `IHTTPProvider::submitRequest` (provider vtable slot 3) in the
Linux stage22 probe and dumping the outgoing `AMSCore::HTTPRequest` object
(arg `b` = `self+0x20`) **before TLS**. This is the exact request libAMSKit's
`CredentialsAuthenticateTask` emits on Linux.

## What the task actually does

`perform(Session, CredentialsAuthenticateTaskOptions)` makes **exactly one** HTTP
request and then fails:

1. **GrandSlam service-discovery lookup** (the only call that fires):

   ```
   GET https://gsd.apple.com/grandslam/GsService2/lookup/v2
   headers:
     Accept:            <redacted in log as <H:2104BB5FD522FC12>>
     X-MMe-Client-Info: <redacted in log as <H:F5D5D013D86A4CEC>>
     User-Agent:        <H:F5D5D013D86A4CEC>
   bodySize: 0   (no postData — plain GET)
   ```

   Full User-Agent string (seen un-redacted elsewhere in the object):
   ```
   <linux> <android;x86_64;android/x86_64 build/6.5.2 maker/linux model/en_US FW/x64> <com.apple.AuthKitAndroid/1.0 (/)>
   ```

   Also referenced in the same request object: `https://bag.itunes.apple.com/bag.xml?ix=5`
   (the AMS "bag" the BagService/IdMSBagService resolve against).

2. **No second request.** The task never reaches the GrandSlam `authenticate`
   (SRP) POST.

## Root cause of error 3169 (0xc61) — CORRECTED

The Error object (class_id 0x7, at `result+0x8`) decodes to:

```
value (+0x28) = 0xc61 = 3169
name  (+0x50) = "idmsAccountLoginFailed"   (secondary code +0x58 = 1205)
detail(+0x18 → +0x10) = "authenticationFailed"
```

**3169 = idmsAccountLoginFailed / authenticationFailed — a real auth rejection,
NOT a lookup-parse failure.** It fires **locally, after the single lookup GET,
with NO second HTTP call** (the authenticate POST is never built).

Proof it's not the lookup body: planting the real 4550-byte `lookup/v2` plist as
the response body (verified in memory at `buf_data+0x100`: data ptr + size 0x11c6
+ cap|1) changed nothing — same 3169, still one HTTP call. Empty body and real
body give the identical result.

### Why it fails during auth *preparation*

The stage22 harness calls `perform(Session, CredentialsAuthenticateTaskOptions)`
with an essentially empty options object (no username, no password/credential
token, no working anisette provider). The task resolves the GrandSlam lookup,
then tries to build the `authenticate` request, has no valid credential material
to put in it, and concludes `authenticationFailed` before sending anything.

## The fix path (next step)

To make the task actually build + send the GrandSlam `authenticate` POST (and so
reveal that SRP/`cpd`/`X-Apple-I-MD` format — and ultimately authenticate), the
`CredentialsAuthenticateTaskOptions` must be populated via
`CredentialsAuthenticateTaskOptionsBuilder`:
  - `withUserName(...)` + `withCredential(...)` / `withType(...)` — real credential
    material (password, or an IDMS credential/token),
  - a working anisette V3 provider (`IAnisetteV3Provider` / `provision_linux.py`,
    already solved — see memory `project_linux_native_anisette`).

Credentials are the user's to supply; they are not handled by the agent. The
lookup plist itself is NOT the blocker (already fetched live and embedded as
`lookup_v2_body.h`, kept for when the task reaches that stage).

## Progress: extracted credentials wired (and accepted)

Wired the user's own extracted-session creds into the task:
  - username = account id (from the extracted `AccountTable`),
  - credential = extracted `idmsAuthToken` wrapped in a proper **`AccountCredential`**
    via JNI `AccountCredential_allocate(..BytePointer.., typeByte)`.
  - `AccountCredential$Type` (decompiled APK): **PasswordEquivalentToken=0**,
    RawPassword=1, CKToken=2.

Read at runtime from scratchpad sidecar files via `read_cred()` (secrets kept out
of the repo); token file + type overridable with `ADAM_CRED_FILE` / `ADAM_CRED_TYPE`.

**Result:** `withCredential` + `build` now succeed (previously the probe passed a
raw BytePointer where an AccountCredential object was expected → crash). `perform()`
advances past credential prep — the error moved from 3169 to ~49/53 — but across
**every** extracted token (idmsAuthToken / idmsPersonalEmailToken / idmsHeartbeatToken)
and type (0/2), the outcome is the same: still only the one lookup GET, **no
authenticate POST**, failing `authenticationFailed` (or an intermittent null-deref;
the harness is ASLR/heap-fragile).

## Remaining blocker: anisette

The credential is no longer the gate. The task stops right after the lookup, before
building the authenticate request — the point where it needs valid **anisette**
(`X-Apple-I-MD` one-time password from a provisioned ADI). The probe wires only the
**builtin `IAnisetteProvider`** (`Session_setAnisetteProvider`), which on Linux has
no provisioned ADI → `authenticationFailed`.

**Next step:** back the Session with the native ADI anisette that already works
(`provision_linux.py` / `stage9_prov_native`) as a real `IAnisetteV3Provider`
(`makeAnisetteV3Provider` + `Session::setInterface<IAnisetteV3Provider>`). Only then
should the task build + send the GrandSlam `authenticate` POST.

## UPDATE — anisette ruled out; real blocker is the forged lookup response

Gave the anisette provider its own labelled vtable (`g_ani_vtable`, separate from the
HTTP `g_trace_vtable`) and confirmed **AMS never calls the anisette provider** during
the task (zero `ani_slot` hits across runs). The task fails — or intermittently
SIGSEGVs in `perform()` — right after the lookup, *before* anisette is needed. So
anisette is not the current gate.

The real blocker is earlier: the **forged lookup RESPONSE is not being parsed into the
AMSCore `AnyMap`** the GrandSlam task expects (error detail carried "AnyMap type" +
"authenticationFailed"). Proof: empty body and the real 4550-byte plist planted at
`buf_data+0x100` yield the **identical** error — so `0x100` is not the response-body
field the parser reads, and the `HARStreamWriter` `buf_data` inline-response forging
isn't delivering a usable lookup response.

Status of the pieces (all still valid/ready):
- Extracted creds wired + accepted (AccountCredential, PET type) — error 3169 → 49.
- Native ADI anisette RESTORED and working: re-provisioned (`provision_linux.py
  --android-id 155ffb4abc258e01`), fresh `adi.pb`, `ADIOTPRequest` rc=0, fresh
  `otp_md.b64` / `otp_mdm.b64`. Full anisette architecture + JNI builders mapped.

**Corrected next step:** fix the forged lookup-response delivery so the task parses it
into an `AnyMap`. Either locate the real response-body field in the inline
(`HARStreamWriter` `buf_data`) path, or stop hand-forging `buf_data` and instead build a
real response with the exported `AMSCore::HTTPResponse(URL, status, headers, body,
metrics)` constructor. Only once the lookup parses will the task reach the authenticate
POST (and then call anisette, which is now ready).

## UPDATE 2 — exact blocker pinpointed: missing `Content-Type` header

Disassembled the inline-copy ctor (`lib+0x3425c8`) and confirmed the body/status
offsets are correct (the ctor's src is `new_data_ptr+8`, so `buf_data+0x100` body /
`+0xd0` status are right; an "off by 8" attempt was wrong and reverted). So the body
**is** delivered.

The exact library error string is: **`Body was not of AnyMap type.`** The task copies
the body into the `HTTPResponse`, then tries to decode it into an AMSCore `AnyMap`
(dictionary) and fails. Empty body and the real 4550-byte XML plist produce the
**identical** error — so the decoder isn't parsing the plist at all.

**Cause:** the forged response has its header map (`buf_data+0xd8`) **zeroed** (to avoid
destructor crashes), so there is no `Content-Type: text/x-xml-plist` to tell AMSCore to
use the plist decoder. Without it the body never decodes to an `AnyMap`. (Related lib
strings on this path: "Missing or invalid altDSID/DSID", "Missing PET from idms
response", "Account properties were of unexpected type".)

**Next:** give the forged response a `Content-Type` header — which means forging a valid
C++ `IHTTPHeaderMap` at `buf_data+0xd8` (non-trivial; it's currently zeroed on purpose),
or switching to the exported `AMSCore::HTTPResponse(...)` constructor that builds the
header map correctly. For real login, the same inline path carries **real** curl
response bytes (status + headers + body) instead of forged ones.

## UPDATE 3 — where the error is thrown, and why "real HTTPResponse" isn't a shortcut

Disassembled the throw site (string vaddr `0x139956`, 7 xrefs). It's thrown by
`AMSCore::Any::getOptInternal<…std::map<string, Any>>` (e.g. at `lib+0x69a2d4`): the
response body is first **decoded into an `Any`**, then accessed as a map. The decode is
`HTTPResponse::getDecodedObject()`, which picks a parser by **Content-Type**. No
Content-Type header → the `Any` is not a map → "Body was not of AnyMap type".

So the fix is unavoidably "add a Content-Type header". But: the library exports **no
`IHTTPHeaderMap` / `DataBuffer` constructors or helpers** — so the
`AMSCore::HTTPResponse(URL, StatusCode, IHTTPHeaderMap, DataBuffer, metrics)`
constructor can't be fed without hand-building those libc++ containers anyway. The
constructor route is therefore **not** the clean shortcut it appeared to be; both routes
require constructing a libc++ `unordered_map`/`map` (Content-Type entry) and a
`DataBuffer` from raw memory.

Tractable options, in order of likely effort:
1. **Hook `HTTPResponse::getDecodedObject()`** (exported) to parse our body as a plist
   regardless of Content-Type, returning a valid AnyMap — sidesteps header-map building
   (but the `Any` by-value return ABI must be matched).
2. **Hand-build a 1-entry header map** at `buf_data+0xd8` with `Content-Type:
   text/x-xml-plist` (match libc++ layout + hash/bucket convention).
3. Accept this is a multi-session implementation and plan accordingly.

## Capture mechanism (reusable)

- `dump_request()` in `stage22_probe.c`: fault-guarded (saves/restores the outer
  `g_recover`), dumps the request object inline + follows every heap-pointer slot,
  string-dumping targets. Wired into `trace_vt3` (`if (N==3) dump_request(...)`).
- arm64 `libAMSKit.so` exports the whole AMSCore HTTP C++ API by name
  (`HTTPRequestBuilder`, `HTTPResponse(URL,status,headers,body,metrics)`,
  `HARStreamWriter::writeEntry`, `IHTTPProvider::makeDefault`) — hookable without
  offsets if device-side capture is ever needed.
- Device/conscrypt note: Apple statically links BoringSSL into libAMSKit/libCoreFP
  with **stripped SSL symbols**, so hooking conscrypt `SSL_read/SSL_write` only
  catches ExoPlayer media (mvod.itunes.apple.com), never AMS/GrandSlam traffic.
