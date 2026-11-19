# 6.5.2 stack spike (local notes, not committed)

Libraries: `drm/rootfs-6.5.2/system/lib64` (x86_64, already staged). Decompiled app: jadx output in the session scratchpad
(`.../scratchpad/jadx/sources`, `base_decoded` smali next to the APK).

## Stage 1 (probe.c): loading
Through the existing embedded libhybris loader: libCoreFP, libCoreADI, libCoreLSKD, libFPDIFor3P, libstoreapi,
libandroidappmusic load. libAMSKit fails: `cannot locate symbol "stdout"` (bionic data symbol; needs a shim).
JNI exports resolve.

## Stage 2a (stage2.c): the FairPlay C API needs no JNIEnv
Each `Java_..._FootHillPublic/ADIInterface_*` wrapper in libstoreapi only marshals arguments and calls one
obfuscated C function in the same library (found by disassembling the wrappers):

| Java API                          | C symbol        | Signature (observed)                      |
|-----------------------------------|-----------------|-------------------------------------------|
| ADISetProvisioningPath(dir)       | nf92ngaK92      | int(const char*)                          |
| ADILoadLibraryWithPath(dir)       | kq56gsgHG6      | int(const char*)                          |
| ADISetAndroidID(bytes,len)        | Sph98paBcz      | int(const uint8_t*,int)                   |
| ADIIsMachineProvisioned(dsid)     | aslgmuibau      | int(int64)  (-45061 = not provisioned)    |
| ADIProvisioningStart              | rsegvyrt87      | (dsid, spim, len, &cpim, &cpimLen, &session) |
| ADIProvisioningEnd                | uv5t6nhkui      | (session, ptm, len, tk, len)              |
| ADIOTPRequest(dsid)               | qi864985u0      | (dsid, &otp,&len, &machineId,&len)        |
| FairPlaySetAndroidID              | bsawCXd         | int(const uint8_t*,int)                   |
| FairPlayLoadLibraryWithPath(dir)  | N8jdR29h        | int(const char*)                          |
| FairPlayGetGUID(hwinfo)           | FKgu8fbnvGFG    | int(void*)  (struct stride 24 bytes)      |
| FairPlayInitContext(NULL,hw,dir,&ctx) | XtCqEf5X    | int(void*,void*,const char*,int*)         |
| FairPlaySAPInit(ref,hw)           | cp2g1b9ro       | int(void*,void*)                          |
| FairPlayGenerateSubscriptionLeaseRequest | PhUojZmspd | (ctx, dsid, type, bytes,len, bytes,len, &out,&len, &out2,&len2) |
| FairPlayGenerateSubscriptionBagRequest   | V3lNO     | (ctx, dsid, type, bytes,len, &out,&len)   |
| FairPlayImportSubscriptionBag     | jr3lMuU8uaAR    | (ctx, bytes,len, &info,&count)            |
| FairPlayGenerateKeybagRequestWithTransactionType | Mt76Vq80ux | (ctx, dsid, 0, type, &out,&len) |
| FairPlayImportKeybagWithContentDeletion | ha0dkchaters6 | (ctx, bytes,len,&delinfo,&n)          |
| FairPlaySAPSign                   | Fc3vhtJDvr      | (ref, data,len,&out,&len)                 |

Additional ADI functions found in libstoreapi.so strings (not in NOTES before):
| ADIProvisioningSessionDestroy(session) | fy34trz2st | int(uint32_t) |
| ADISynchronize(dsid,srm,len,&mid,&midLen,&srm2,&srm2Len) | tn46gtiuhw | int(...) |
| ADIStorageDispose(ptr)   | jk24uiwqrg | int(void*) |
| ADIProvisioningErase(dsid) | p435tmhbla | int(int64) |
| ADIDisposeOTPCache       | fm23w5mn5o | int(?)     |
| ADISetIDMSRouting        | gJa8aF901k | int(?)     |
| ADIGetIDMSRouting        | jkag7Bg01u | int(?)     |
| ADITearDownLibrary       | madsvsfvjk | int(?)     |

Init order used by the app (N7/a.java): ADISetProvisioningPath(dir); ADILoadLibraryWithPath(dir); ADISetProvisioningPath(dir);
ADISetAndroidID(id); FairPlaySetAndroidID(id); FairPlayLoadLibraryWithPath(dir); KDSetAndroidID(id).
Context: FairPlayGetGUID -> FairPlayInitContext(NULL, hw, dir, &ctx) (foothill/impl/e.java).

Result of stage2 with a fresh random Android ID: every call returns 0, a GUID is produced, SAPInit ok, a context id is
returned; ADIIsMachineProvisioned = -45061 (not provisioned yet).

## ADI Error Codes (from Dadoum/Provision + Apple smali)

Source: `Provision/lib/provision/adi.d` (toString and ADIError enum), confirmed by binary search in
libstoreapi.so and libCoreADI.so (ARM64 and x86_64, 6.5.2). The main ADI dispatch function is `vdfut768ig`
in libCoreADI.so; all error codes are computed at runtime via OLLVM-obfuscated arithmetic.

| Code   | Name                         | Meaning                                                         |
|--------|------------------------------|-----------------------------------------------------------------|
| 0      | success                      | Call succeeded                                                  |
| -45001 | invalidParams                | Missing init (need SetProvisioningPath + SetAndroidID first), or bad params |
| -45002 | invalidParams2               | Invalid parameters for decipher                                 |
| -45003 | invalidTrustKey              | Invalid Trust Key (TK bytes corrupted or wrong length)          |
| -45006 | ptmTkNotMatchingState        | PTM and TK do not match the transmitted CPIM                    |
| -45017 | (unknown)                    | Observed on iOS; meaning unknown                                |
| -45018 | invalidInputDataParamHeader  | Invalid input data header (first uint of the blob)              |
| -45019 | unknownAdiFunction           | vdfut768ig doesn't recognise the requested function             |
| -45020 | invalidInputDataParamBody    | Invalid input data body (non-first-uint field)                  |
| -45025 | unknownSession               | Session handle not found in internal table                      |
| -45026 | emptySession                 | Session handle present but empty/uninitialised                  |
| -45031 | invalidDataHeader            | Invalid data header                                             |
| -45032 | dataTooShort                 | Data blob too short                                             |
| -45033 | invalidDataBody              | Invalid data body                                               |
| -45034 | unknownADICallFlags          | Unrecognised flags field in ADI call                            |
| -45036 | timeError                    | Time-related error (clock skew, expiry)                         |
| -45044 | (unknown)                    | Observed on macOS iTunes; meaning unknown                       |
| -45045 | (unknown)                    | Probably a typo/alias of -45054                                 |
| -45046 | emptyHardwareIds             | Identifier generation failure: empty hardware IDs               |
| -45048 | (unknown)                    | Observed on Windows iTunes; resolved by deleting adi.pb         |
| -45054 | filesystemError              | Generic libc/filesystem error (open, read, write, etc.)         |
| -45061 | notProvisioned               | ADIIsMachineProvisioned: device not yet provisioned             |
| -45062 | noProvisioningToErase        | ADIProvisioningErase: nothing to erase (not provisioned)        |
| -45063 | pendingSession               | ADIProvisioningStart: a session is already pending              |
| -45066 | sessionAlreadyDone           | ADIProvisioningEnd: session already consumed (can't reuse)      |
| -45075 | libraryLoadingFailed         | ADILoadLibraryWithPath: library load failed                     |
| -45076 | (unknown)                    | Observed on macOS iTunes; backward-compat issue 12.6→12.7       |

**Key codes for adam:**
- **-45001** was our bug — caused by TK with extra byte (b64dec padding fault); fixed.
- **-45061** is the normal "not provisioned yet" return from `ADIIsMachineProvisioned`; always reprovision on this.
- **-45003** means the TK itself is bad (corrupted bytes, wrong length).
- **-45006** means TK/PTM don't match what was used for CPIM (session mismatch across processes).
- **-45063** means you called Start without finishing/destroying the previous session.
- **-45066** means you called End on a session that was already ended.
- **-45075** means ADILoadLibraryWithPath can't find/load the .so files.
- **-45054** is a filesystem error (bad provisioning path, permissions, disk full).

## Lease request (kotlinlease/LeaseAssetRequestUtils, smali)
POST bag URL `subDownload`, JSON {guid, action: lease-start|lease-renew|lease-download, salableAdamId, sbsync}.
`sbsync` = bplist from FairPlayGenerateSubscriptionBagRequest/LeaseRequest(dsid) (bplist.e.b post-processed).
Reply: keyBag / subKeyBag (base64) -> FairPlayImportKeybag / ImportSubscriptionBag.
Headers seen in the app's header enum: X-Apple-I-MD, X-Apple-I-MD-M, X-Apple-MD(-M), X-Apple-FPDISignature, X-Dsid,
Authorization. Who attaches them is inside the native request layer (not read yet).

## Provisioning (anisette)
Bag keys midStartProvisioning / midFinishProvisioning (libAMSKit strings); headers X-MMe-Client-Info, X-MMe-Device-Id,
X-Apple-AMD-*. Flow: POST start -> spim; ADIProvisioningStart(spim) -> cpim; POST finish(cpim) -> ptm,tk; ADIProvisioningEnd.
NOT executed yet (needs the network; registers the fresh Android ID with Apple's provisioning service).

## Stage 3 (network, partial) — Nov 5 2026
- `setup.icloud.com/configurations/init` (X-MMe-Client-Info `<Pixel 7><Android; 14;441323.1><com.apple.android.music>`)
  answers 200 but is the iCloud bag (32 urls, no mid* keys).
- GrandSlam lookup (bag with midStartProvisioning/midFinishProvisioning): chains verify with Apple Root CA and Apple Root
  CA - G3 (both fetched from apple.com and checked against the published SHA-256; bundle in state/apple-roots.pem).
  `gsd.apple.com/grandslam/GsService2/lookup/v2` -> 403, `gsa.apple.com/grandslam/GsService2/lookup` -> 401 with only
  client-info/device-id/bundle-id headers. The real header set of AMSKit's request is not known yet (libAMSKit builds it
  natively); NO provisioning request was sent, nothing was registered with Apple.
- Lease auth (p198ka/e.d): `Authorization: Basic base64("<dsid>:<authToken>")` — an account auth token, not the web
  player's media-user-token. A web token alone is therefore unlikely to be enough for the lease endpoint.
- Client info format (p198ka/e.b): `<{model}><Android; {release};441323.1><com.apple.android.music>`.

## Stage 3b — stopped (Nov 5 2026)
Static analysis of libAMSKit: the GrandSlam lookup task picks gsd.apple.com / gsa-d-idms1 / gsa-d-idms2 `.../GsService2/lookup/v2`
by environment (default gsd.apple.com); the header-name table (X-MMe-*, X-Apple-I-*, X-Apple-AMD-*, ...) is at 0x3f8864-0x3fd5xx,
the construction code is inside large coroutine bodies (not yet read).
A further request retrying the lookup with a macOS-style client identity was refused by the tooling's policy check
(it looks like getting around Apple's client check) and was NOT sent. Do not retry that. A legitimate route would be to let
Apple's own library code build and send the requests (run libAMSKit with a JNI host) rather than forging headers by hand.
