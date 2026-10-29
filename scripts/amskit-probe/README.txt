Probes for the 6.5.2 libraries staged in drm/rootfs-6.5.2 (see its README). They run on Linux through the engine's own
libhybris-core.so and touch no session, no network and no repo file. Paths are absolute to this checkout; edit the
two constants near the top of each file if it moves. Build each with, for example:

  RES=../../electron/dist/resources
  gcc -O1 -g -o /tmp/session_probe session_probe.c -L"$RES" -lhybris-core -Wl,-rpath,"$(cd $RES && pwd)" -ldl

  functest.c       calls into zlib, libxml2, CoreFoundation, libdispatch, ICU, libm, libc++ and AMSKit (needs -lm)
  symtest.c        resolves every exported function of one library (arg: library file name); run
                   ./gen-symlists.sh first, then the program once per library (each in its own process)
  session_probe.c  builds a host-side AMSCore::IBundleInfo (14-slot vtable) and runs Session::makeDefaults()

Hybris needs three shims for libAMSKit, which each probe installs through hybris_set_hook_callback: the stdin/stdout/stderr
variables (pointing at the host streams), __register_atfork (no-op) and __memchr_chk (forwards to memchr).

Findings so far (Session built with a host IBundleInfo, then Session::makeDefaults(); default provider factories called
on that session):
  real object returned:   IAccountProvider (sqlite-backed accounts), IFairPlayCoreProvider, IDataProvider
  NULL, host must supply: IHTTPProvider (AMSKit has no TLS/HTTP stack of its own), IMescalProvider,
                          IAnisetteV3Provider (needs an INativeAnisetteProvider over libCoreADI)
  Task<AuthenticateResult, Error> has no exported wait/then: completion is only reachable through the JNI adapters, so
  driving CredentialsAuthenticateTask::perform from C needs the private Task member functions located by address.

HTTP provider (looked at before building it):
  The C++ IHTTPProvider vtable is not exported and the Android-side contract is a JavaCPP adapter, IAndroidHTTPProvider:
  shutdown() and submitRequest(HTTPRequest{urlString, method, headers, body, msTimeout}, Callback{complete,
  completeExceptionally}). AMSKit's adapter functions reach Java only through the JNI function table (NewGlobalRef,
  CallVoidMethod, field accessors), so there are two ways in:
    A. a minimal fake JNIEnv: AMSKit's own adapters do the C++ ABI work and our "Java side" is C callbacks (libcurl for
       submitRequest). Needs the few JNI slots the adapters use plus JavaCPP's Pointer address field handling.
    B. rebuild the C++ IHTTPProvider vtable and the HTTPRequest/HTTPResponse/URL/DataBuffer objects by hand.
  The same choice applies to the Mescal, anisette and interrupt-handler providers.

Feasibility results for the two routes (route_a_fake_jni.c, route_b_url.c):
  A. fake JNIEnv/JavaVM that log each slot: JNI_OnLoad completes and IAndroidHTTPProvider.allocate completes. Only a
     dozen JNI slots are touched (GetVersion, FindClass, ExceptionClear, Push/PopLocalFrame, NewGlobalRef,
     DeleteLocalRef, GetMethodID, GetFieldID, GetStaticMethodID, NewStringUTF, ExceptionCheck, plus a few more in the
     adapters), so the fake environment can stay small. Slot numbers in the probe's name table are partly wrong; trust
     the numbers, not the labels.
  B. URL::parse is exported and works (the object holds the scheme and host as inline strings; getLastPathComponent
     read back "native"). DataBuffer and the header map have no exported constructors or accessors, so HTTPRequest /
     HTTPResponse would need their inline layouts reverse engineered.

Route A, second step (route_a_fake_jni.c now captures the adapter):
  IAndroidHTTPProvider.allocate hands the native adapter pointer to Java through one JNI call, slot 93
  (CallNonvirtualVoidMethodA, JavaCPP's Pointer.init; args[0].j = native address). The fake env records it. The
  adapter's vtable: [0],[1] destructors (libAMSKit+0x558e66, +0x558ea8), [2] +0x341712, [3] +0x33ec4a, [4] +0x4f3434 which
  is the submitRequest override (it uses NewGlobalRef and std::function virtual calls).
  The JNI getters IAndroidHTTPProvider$HTTPRequest.urlString/method/headers/body/msTimeout are stubs that only throw, so
  the adapter must fill Java fields itself (SetObjectField/SetIntField/SetLongField on an object it created with
  NewObject): the fake env has to implement a small object model that records those field writes.
  Consumers of the HTTP provider are AMSKit's own tasks (ExecuteHTTPRequestTask, bag loading), so exercising HTTP needs
  such a task to run.
  Also: the JNI exports are the intended way to drive tasks and wait for them (AuthenticateResultTask$Completable_make,
  $TaskCallbackAdaptor_then, CommerceAuthenticateTaskOptionsBuilder_*, CredentialsAuthenticateTaskOptionsBuilder_*),
  which gives route A a way around the unexported Task::then/get problem: register a Java callback token through
  TaskCallbackAdaptor_then and receive the result in the fake CallVoidMethod.

Route A, session built (fake_jni.h / fake_jni.c / session_jni_probe.c):
  fake_jni.c is a small JNI environment (objects, classes, interned method/field ids, strings, arrays, exceptions, all
  Call/NewObject/field slots) plus a JavaVM. JavaCPP's Pointer.init(address, ...) is modelled so each Java-side object
  carries its native address. java.lang.String.getBytes() is built in; every other native-to-Java call goes to
  fake_jni_java_call() in the host program, which logs it.
  session_jni_probe.c follows the Android app's own sequence through the JNI exports: JNI_OnLoad, BundleInfoWrapper.make,
  SessionBuilder.allocate, IAndroidHTTPProvider.allocate + SessionBuilder.setHTTPProvider, then SessionBuilder.make with the
  device strings, the bundle info and two database paths. Result: ExpectedSession.hasValue == 1, i.e. a real native
  AMSKit Session, with no JVM and no hand-built C++ objects. Set JNI_TRACE=1 to log every JNI call.
  Build: gcc -O1 -g -o /tmp/session_jni_probe session_jni_probe.c fake_jni.c -L<resources> -lhybris-core -Wl,-rpath,<resources> -ldl
  Not done yet: a task that makes AMSKit call the HTTP provider (bag load or ExecuteHTTPRequestTask), the
  submitRequest handler over libcurl, and the Mescal / anisette / dialog-handler providers.

Route A, first real HTTP request (bag_probe.c; build adds -lcurl -lpthread):
  Same sequence as session_jni_probe.c, then ExpectedSession.takeValue (a STATIC native: takeValue(ExpectedSession)),
  BagService.allocate(session, "Music", "1", bundle) and BagService.getFrozenBag(). AMSKit logs its own progress
  ("Starting a bag load", "Encoding network request", "Submitting the HTTP request") through the Android log hook, then
  calls the adapter's submitRequest, which reaches the host's fake_jni_java_call("submitRequest"). The host reads the
  request through the adapter's own natives (HTTPRequest.urlString/method/headers/body/msTimeout), runs it with libcurl and
  delivers a java-side Response (status, headers as an ArrayList of kotlin.Pair, body byte[], metrics with its internal
  object) through IAndroidHTTPProvider$Callback.complete. HTTP method names arrive as enum names ("Head"): upper-case them.
  Result so far: bag.itunes.apple.com answered the HEAD request with HTTP 200 and 37 headers.
  Open: after Callback.complete reads status/headers it traps (ud2 at libAMSKit+0x3410d0, reached from the check
  cmp byte [r12+0x120],0 at +0x340b40 inside the handler that starts at +0x34025e): an std::optional inside the object
  the callback holds (loaded from callback+0x20) is empty. Not yet known whether the adapter leaves it empty by design
  (state filled by a step we skip) or because we pass the wrong Callback object.
  Failure path: completeExceptionally(Throwable) makes native code call ExceptionUtil$Callback.call(ThrowableWrapper) and
  expects a native Error object back; returning NULL crashes. Not handled yet.

== Bag load (bag_probe.c) - WORKS ==
Result: BagService.allocate("Music","1",bundle) + getFrozenBag drives two real HTTP requests (HEAD then GET
bag.itunes.apple.com/bag.xml, 71 KB body) through our IAndroidHTTPProvider, ends with
"Successfully loaded the bag: Music, 1" and BagService.isLoaded == 1.

Root cause of the earlier empty-std::optional trap in Callback.complete:
  IAndroidHTTPProvider.allocate() only creates the native adapter; the Kotlin constructor then also calls
  IAndroidHTTPProvider.init(). Without init() the adapter's internal state has no registered callback state, so
  complete() hits ud2 on an empty optional ([r12+0x120]==0). Call init() right after allocate() (before
  SessionBuilder.setHTTPProvider). Deferring complete() to a worker thread was irrelevant.
Other notes:
  - HEAD must be sent as upper-case verb (CURLOPT_NOBODY), else HTTP 400.
  - The probe must wait for isLoaded, not for the first completed request (attempt 2 is a follow-up GET).
  - Still unhandled: completeExceptionally -> ExceptionUtil$Callback.call must return a native Error object
    (returning NULL crashes). Needed before any failure path (offline, TLS error) is safe.

== Do the 6.5.2 FairPlay/ADI/playback libs work with our wrapper? NO (checked statically, 2026-10-29) ==
- drm/native wrapper mangled symbols: 92; resolvable in the working rootfs: 90; in rootfs-6.5.2: 13.
  Gone from 6.5.2 libandroidappmusic: AuthenticateFlow, StoreErrorCondition, lease manager, getPersistentKey,
  most of storeservicescore::RequestContext/URLRequest/PurchaseRequest/DeviceGUID, FootHillConfig::config.
  libandroidappmusic no longer needs libstoreservicescore or libcurl (that logic moved into libAMSKit/libstoreapi
  + Java providers; libmediaplatform has no curl imports).
- libCoreFP: all 7 exports renamed (per-build obfuscated names). libCoreADI: 22 -> 6 exports (the fp_dh_* set is
  gone; only cvu8io98wun, vdfut768ig, JNI_OnLoad remain). libCoreLSKD 37 removed/39 added.
  libmedialibrarycore 2151 removed/5521 added; libdaapkit 45 removed.
- Conclusion: 6.5.2 is a different architecture (AMSKit-driven), not a drop-in for the current wrapper. Keep the
  working rootfs; rootfs-6.5.2 is reference material only.

== Newer old-architecture builds (4.9.7.2, 5.2.1) vs the wrapper - live test on Linux (2026-10-29) ==
Staged x86_64 libs: drm/rootfs-5.2.1, drm/rootfs-4.9.7.2 (git-ignored; app libs from the APK/split_config.x86_64.apk,
system libs from the working rootfs). Harness: hybris_backend_init + hybris_fairplay_init with a throwaway base dir and
fake credentials. Baseline (working rootfs) reaches Apple's "Check the account information" rejection.
5.2.1 progress:
  1. Needs hooks for __register_atfork and __memchr_chk (new libc imports).
  2. FootHillConfig::config now takes std::string BY VALUE and frees it -> pass a heap-owned copy (done in
     drm/native/hybris_stubs.c, falls back to the old const& name when exported).
  3. make_shared<RequestContext|AuthenticateFlow|AndroidPresentationInterface> and shared_ptr<SVFootHillPContext>::~
     are no longer exported -> built by hand (make_shared_manual in hybris_stubs.c): control block vptr=vtable+0x10,
     object at +0x20; alloc sizes 0x5e0/0x100/0x120; enable_shared_from_this weak_this at object+0 / +8 / +0x18.
     With these, init_ctx completes (RequestContext::init, presentation interface, setFairPlayDirectoryPath).
  4. BLOCKER: AuthenticateFlow::run throws std::bad_function_call. RequestContextConfig gained 16 std::function
     callbacks the Java app normally supplies (get/set cookie, cookie list, all cookies for user, account value,
     active account DSID, value for key, set value for key, add profile, create account proto action, update
     account flags/status/storefront/xtoken, play-integrity hash, use-legacy-store), plus setSupportsDialogs,
     setRequiresPlatformSignature, setAllowedToGetOfflineSlot, setCPFlag. They must be built as libc++ std::function
     objects from C (custom __func vtable) and given working behaviour (in-memory/key-value store, cookies, DSID).
4.9.7.2: same three missing make_shared exports; not run yet.

== 4.9.7.2 / 5.2.1: RequestContextConfig callbacks implemented; Mescal signing is now the blocker (2026-10-29) ==
Done (drm/native/hybris_stubs.c + one call in main.c drm_init_ctx; installs nothing on the old rootfs):
  - libc++ std::function built from C: NDK layout is char buf[32] + callable pointer at +0x20; vtable slots
    {~D1,~D0,clone(),clone(dest),destroy,destroy_deallocate,operator(),target,target_type}; the setter copies via
    clone() so the vtable must outlive the install. Args reach operator() by pointer, non-trivial returns via sret.
  - Callbacks that actually fire during login: UseLegacyStore, GetActiveAccountDSID, GetValueForKey("StoreFrontIdentifier"),
    GetCookieList, SetCookie, SetValueForKey. All stubbed in memory (UseLegacyStore=false, DSID=0, strings empty).
  - The old rootfs exports setBagInvalidateCallback only; installing there crashed, so install is gated on setGetCookieCallback.
Result with fake credentials (curl capture, no credentials printed):
  baseline : bag -> register -> setupCert.plist -> fpinit signSapSetup/legacy -> auth (X-Apple-ActionSignature) ->
             otp/1.5/finish -> auth -> "-5000 Check the account information".
  4.9.7.2 / 5.2.1 : bag -> register -> setupCert.plist -> auth POST WITHOUT X-Apple-ActionSignature; no signSapSetup,
             no otp/finish. 4.9.7.2 gets HTTP 200 with an empty body, wrapper reports an empty auth error.
  Tried without effect: setRequiresPlatformSignature / setSupportsDialogs / setAllowedToGetOfflineSlot / setCPFlag = true,
  UseLegacyStore = true. Mescal-related exports are identical between old and 4.9.7.2, so the skip is internal.
  Next: find why Mescal setup/sign is not run (trace RequestContext::mescal(), Mescal::sign, SAP setup; check libCoreFP
  init and the library's own log output, which the wrapper does not currently surface).

== RESOLVED: 4.9.7.2 and 5.2.1 now work through FairPlay init + login (fake credentials) (2026-10-29) ==
Root causes of the "Mescal skipped / unsigned auth" failure and what fixed it:
  1. Android ID with a leading zero. The newer libs parse the id as a hex number ("0123..." -> "123..."), then
     KDSetAndroidID fails (-42650), FairPlayConfig::config fails (-45001), and the SAP/Mescal steps are silently skipped
     (no signSapSetup, no X-Apple-ActionSignature, no otp/finish). Use ids whose first hex digit is not 0.
     NOTE: engine/core/drm/deviceid.go generates 8 random bytes, so 1 id in 16 starts with '0'; avoid that before
     moving to newer libs.
  2. FootHillConfig::config takes the string by value in the newer libs; a non-trivial by-value parameter is still passed
     as a POINTER, but the wrapper's cap=1 "long" string is not valid there. Pass a short-form libc++ string
     (size<<1 in byte 0, characters inline) by pointer.
  3. The two libc imports __register_atfork / __memchr_chk: drm_hybris.c now registers a hook callback (Linux) through
     embedded_set_hook_callback (new, embedded_loader.c). Harmless for the old libs (bionic libc here defines neither).
  4. Hand-built make_shared for RequestContext / AuthenticateFlow / AndroidPresentationInterface and the
     SVFootHillPContext shared_ptr destructor (hybris_stubs.c), and the 16 RequestContextConfig std::function callbacks
     (installed only when the lib exports setGetCookieCallback).
  5. Separate, pre-existing bug found on the way: dialogHandler (native/main.c) built the ProtocolDialogResponse and its
     control block in a stack array, but the library uses it after the handler returns -> intermittent SIGSEGV in
     ShowDialogProtocolAction::performWithContext (5 of 6 runs crashed on the shipped lib in this environment). Now
     calloc'd (never freed).
Result (harness: hybris_backend_init + hybris_fairplay_init, throwaway base dir, fake credentials, 6 runs each):
  old rootfs 6/6, 4.9.7.2 6/6, 5.2.1 6/6 reach Apple's server verdict ("Your account is disabled" for a fake account),
  with signSapSetup, X-Apple-ActionSignature and otp/1.5/finish all present, same as the baseline.
Not tested: real account login, 2FA, key/lease fetch, ALAC decrypt/playback, Play Integrity on a real account,
Windows build of the hybris_stubs/main.c changes, and moving drm/native hooks for the ARM-free engine build.

== (disabled for now) APK-based lib fetch, to replace scripts/fetch-fairplay-libs.sh ==
# Kept as notes only; commented out until we decide to switch. Nothing in the repo uses it.
# Candidates (x86_64 libs inside the APK):
#   - 4.9.7.2 (build 1472): universal APK, nodpi, 137.74 MB / 144434636 bytes; libs under lib/x86_64/.
#   - 5.2.1 (build 1545): APKMirror bundle (.apkm, 150429532 bytes); libs are in split_config.x86_64.apk (lib/x86_64/).
#   - 6.5.x is a different design (AMSKit) and does NOT work with the wrapper.
# Steps:
#   1. Download the APK/bundle (APKMirror blocks scripted access; Uptodown or a manual download may be needed), verify the size/hash.
#   2. Extract only lib/x86_64/*.so (for a bundle, from split_config.x86_64.apk) into a NEW empty directory.
#   3. Copy the 17 app libs into rootfs/system/lib64: libandroidappmusic, libBlocksRuntime, libCoreADI, libCoreFoundation, libCoreFP,
#      libCoreLSKD, libc++_shared, libcurl, libdaapkit, libdispatch, libicudata_sv_apple, libicui18n_sv_apple, libicuuc_sv_apple,
#      libmedialibrarycore, libmediaplatform, libstoreservicescore, libxml2.
#   4. The APK has no bionic system libs: keep libc, libm, liblog, libstdc++, libz, libdl, libandroid, libOpenSLES from the current rootfs.
#   5. Delete the extracted directory and the downloaded APK/bundle.
# Before switching the default: make sure the Android ID never starts with '0' (engine/core/drm/deviceid.go), re-check the SHA-256
# lock (drm/fairplay-libs.lock) for the new files, and test a real login, key fetch and ALAC playback.
