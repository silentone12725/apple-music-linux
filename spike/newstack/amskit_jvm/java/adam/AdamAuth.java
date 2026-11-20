package adam;

import com.apple.mediaservices.amskit.bindings.*;
import com.apple.mediaservices.amskit.fairplay.NativeAnisetteProviderAdaptor;
import com.apple.mediaservices.amskit.network.HTTPMetrics;
import com.apple.mediaservices.amskit.network.IAndroidNetworkProvider;
import java.lang.reflect.Proxy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import kotlin.Pair;

public class AdamAuth {
    static final String BUNDLE = "com.apple.android.music";

    static javax.net.ssl.SSLSocketFactory SSL;

    static void initTrust(String pem) throws Exception {
        java.security.KeyStore ks = java.security.KeyStore.getInstance(java.security.KeyStore.getDefaultType());
        ks.load(null, null);
        javax.net.ssl.TrustManagerFactory d = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());
        d.init((java.security.KeyStore) null);
        int i = 0;
        for (javax.net.ssl.TrustManager tm : d.getTrustManagers())
            if (tm instanceof javax.net.ssl.X509TrustManager)
                for (java.security.cert.X509Certificate c : ((javax.net.ssl.X509TrustManager) tm).getAcceptedIssuers()) ks.setCertificateEntry("d" + i++, c);
        try (java.io.InputStream in = Files.newInputStream(Path.of(pem))) {
            for (java.security.cert.Certificate c : java.security.cert.CertificateFactory.getInstance("X.509").generateCertificates(in)) ks.setCertificateEntry("a" + i++, c);
        }
        javax.net.ssl.TrustManagerFactory t = javax.net.ssl.TrustManagerFactory.getInstance(javax.net.ssl.TrustManagerFactory.getDefaultAlgorithm());
        t.init(ks);
        javax.net.ssl.SSLContext ctx = javax.net.ssl.SSLContext.getInstance("TLS");
        ctx.init(null, t.getTrustManagers(), null);
        SSL = ctx.getSocketFactory();
    }

    static class HttpProv extends IAndroidHTTPProvider {
        public void shutdown() {}

        public void submitRequest(IAndroidHTTPProvider.HTTPRequest req, IAndroidHTTPProvider.Callback cb) {
            String url = req.urlString();
            String method = String.valueOf(req.method()).toUpperCase(Locale.ROOT);
            byte[] body = req.body();
            Object hdrs = req.headers();
            System.err.println("[http] " + method + " " + url + " body=" + (body == null ? 0 : body.length));
            new Thread(() -> {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    if (c instanceof javax.net.ssl.HttpsURLConnection) ((javax.net.ssl.HttpsURLConnection) c).setSSLSocketFactory(SSL);
                    c.setRequestMethod(method);
                    c.setInstanceFollowRedirects(false);
                    int to = req.msTimeout() > 0 ? req.msTimeout() : 30000;
                    c.setConnectTimeout(to);
                    c.setReadTimeout(to);
                    if (hdrs instanceof Iterable) for (Object o : (Iterable<?>) hdrs) {
                        Pair<?, ?> p = (Pair<?, ?>) o;
                        String hn = String.valueOf(p.getFirst()), hv = String.valueOf(p.getSecond());
                        // AMSKit's own HAR-style logger redacts every header value as <H:hash>,
                        // so the actual bytes it put in the anisette headers were never visible.
                        // Log just these two (never anything auth/SRP-related) to check whether
                        // AMSKit transcribes our OTPResponse bytes verbatim or re-derives them.
                        if (hn.equalsIgnoreCase("X-Apple-I-MD") || hn.equalsIgnoreCase("X-Apple-I-MD-M")) {
                            System.err.println("[http]    header " + hn + " = " + hv);
                        }
                        c.setRequestProperty(hn, hv);
                    }
                    if (body != null && body.length > 0) {
                        c.setDoOutput(true);
                        c.getOutputStream().write(body);
                    }
                    int st = c.getResponseCode();
                    java.io.InputStream is = st >= 400 ? c.getErrorStream() : c.getInputStream();
                    byte[] rb = is == null ? new byte[0] : is.readAllBytes();
                    List<Pair<String, String>> rh = new ArrayList<>();
                    for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet())
                        if (e.getKey() != null) for (String v : e.getValue()) rh.add(new Pair<>(e.getKey(), v));
                    System.err.println("[http] <- " + st + " " + rb.length + " bytes");
                    // GsService2's "200 OK with the real error inside the body" pattern (classic
                    // Apple GSA) means the byte count alone doesn't say why anisetteSyncMachineFailed
                    // keeps firing. Dump small response bodies (never the request, which can carry
                    // SRP exchange data) as base64 so the actual server-reported reason is visible.
                    if (rb.length > 0 && rb.length <= 4096) {
                        System.err.println("[http]    body(b64)=" + Base64.getEncoder().encodeToString(rb));
                    }
                    cb.complete(new IAndroidNetworkProvider.Response(st, rh, rb, new HTTPMetrics()));
                } catch (Throwable t) {
                    System.err.println("[http] failed: " + t);
                    cb.completeExceptionally(t);
                }
            }, "adam-http").start();
        }
    }

    static byte[] b64(String path) throws Exception {
        return Base64.getDecoder().decode(Files.readString(Path.of(path)).trim());
    }

    /**
     * Calls the already-validated stage9_prov_native "otp" mode fresh (local ADI crypto,
     * no network) to get a live one-time OTP+MID pair. Serving the same cached bytes on
     * every AMSKit retry made it hand back an already-consumed OTP forever.
     */
    static byte[][] freshOtp(String stage9Bin, String provDir, String androidId) throws Exception {
        // stage9_prov_native hardcodes HYBRIS_LINKER_DIR="../../drm/hybris-linker" (relative,
        // overwriting any inherited env), so it must run with cwd = its own directory.
        Process p = new ProcessBuilder(stage9Bin, "otp", provDir, androidId)
            .directory(Path.of(stage9Bin).toAbsolutePath().getParent().toFile())
            .redirectErrorStream(false).start();
        String out = new String(p.getInputStream().readAllBytes());
        String err = new String(p.getErrorStream().readAllBytes());
        int rc = p.waitFor();
        System.err.println("[anisette] stage9 otp rc=" + rc + " stderr=" + err.trim());
        if (rc != 0) throw new RuntimeException("stage9_prov_native otp failed (rc=" + rc + "): " + err);
        String otpB64 = null, mdmB64 = null;
        for (String line : out.split("\n")) {
            if (line.startsWith("OTP_B64=")) otpB64 = line.substring(8).trim();
            if (line.startsWith("MDM_B64=")) mdmB64 = line.substring(8).trim();
        }
        if (otpB64 == null || mdmB64 == null) throw new RuntimeException("stage9_prov_native otp: missing OTP_B64/MDM_B64 in: " + out);
        return new byte[][] {Base64.getDecoder().decode(mdmB64), Base64.getDecoder().decode(otpB64)};
    }

    /**
     * Starts a persistent stage9_prov_native "provision" subprocess and sends it the SPIM.
     * The ADI session handle lives only in that process's memory (see memory note
     * project-linux-native-anisette), so startProvisioning and the later finishProvisioning
     * for the same session MUST talk to the same live process, not two fresh invocations.
     */
    static Process startProvisionProcess(String stage9Bin, String provDir, String androidId) throws Exception {
        return new ProcessBuilder(stage9Bin, "provision", provDir, androidId)
            .directory(Path.of(stage9Bin).toAbsolutePath().getParent().toFile())
            .redirectErrorStream(false).start();
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    static Object anisetteProxy(String stage9Bin, String provDir, String androidId, boolean allowReprovision) throws Exception {
        Class<?> iface = Class.forName("com.apple.mediaservices.amskit.fairplay.INativeAnisetteProvider");
        Class<?> otp = Class.forName("com.apple.mediaservices.amskit.fairplay.INativeAnisetteProvider$OTPResponse");
        Class<?> startResp = Class.forName("com.apple.mediaservices.amskit.fairplay.INativeAnisetteProvider$StartProvisionResponse");
        Object companion = Class.forName("com.apple.mediaservices.amskit.bindings.Expected").getField("Companion").get(null);
        java.lang.reflect.Method success = companion.getClass().getMethod("success", Object.class);
        // dex2jar renamed kotlin.Unit's singleton field from INSTANCE to "a"; find it by type instead of name.
        Class<?> unitClass = Class.forName("kotlin.Unit");
        Object unitTmp = null;
        for (java.lang.reflect.Field f : unitClass.getDeclaredFields())
            if (f.getType() == unitClass) { f.setAccessible(true); unitTmp = f.get(null); break; }
        if (unitTmp == null) throw new RuntimeException("could not locate kotlin.Unit singleton field");
        final Object unit = unitTmp;
        final int[] requestCount = {0};
        final int MAX_REQUESTS = 3; // hard stop: a controlled attempt, not an unbounded retry loop
        final AtomicLong nextSession = new AtomicLong(1);
        final Map<Long, Process> sessions = new ConcurrentHashMap<>();
        final Map<Long, java.io.BufferedReader> sessionOut = new ConcurrentHashMap<>();
        return Proxy.newProxyInstance(AdamAuth.class.getClassLoader(), new Class<?>[] {iface}, (p, m, a) -> {
            String n = m.getName();
            System.err.println("[anisette] " + n);
            if (n.startsWith("request")) {
                if (++requestCount[0] > MAX_REQUESTS) {
                    throw new RuntimeException("anisette request() called " + requestCount[0] +
                        " times — aborting instead of retrying forever (fresh OTP was still rejected)");
                }
                byte[][] fresh = freshOtp(stage9Bin, provDir, androidId);
                System.err.println("[anisette]    handing AMSKit mid(b64)=" + Base64.getEncoder().encodeToString(fresh[0]) +
                    " otp(b64)=" + Base64.getEncoder().encodeToString(fresh[1]));
                return success.invoke(companion, otp.getConstructor(byte[].class, byte[].class).newInstance(fresh[0], fresh[1]));
            }
            if (n.startsWith("startProvisioning")) {
                if (!allowReprovision) {
                    // Refuse instead of silently re-provisioning: this identifier may be a
                    // real device's (e.g. a phone-mirrored session) in active use elsewhere,
                    // and re-provisioning it from here would hit Apple's real
                    // startMachineProvisioning/finishMachineProvisioning under that SAME
                    // identifier, risking desyncing or invalidating that device's own
                    // working session server-side.
                    throw new RuntimeException("startProvisioning refused: allowReprovision=false " +
                        "(this identifier belongs to a real device session; re-provisioning it here " +
                        "could disrupt that device's own session)");
                }
                byte[] spim = (byte[]) a[1];
                Process proc = startProvisionProcess(stage9Bin, provDir, androidId);
                java.io.BufferedReader rd = new java.io.BufferedReader(new java.io.InputStreamReader(proc.getInputStream()));
                java.io.OutputStream in = proc.getOutputStream();
                in.write(("SPIM_B64=" + Base64.getEncoder().encodeToString(spim) + "\n").getBytes());
                in.flush();
                String line = rd.readLine();
                System.err.println("[anisette] stage9 provision(start) -> " + line);
                if (line == null || !line.startsWith("CPIM_B64=")) {
                    String err = new String(proc.getErrorStream().readAllBytes());
                    proc.destroy();
                    throw new RuntimeException("stage9_prov_native provision(start) failed: " + line + " stderr=" + err);
                }
                byte[] cpim = Base64.getDecoder().decode(line.substring(9).trim());
                long sessionId = nextSession.getAndIncrement();
                sessions.put(sessionId, proc);
                sessionOut.put(sessionId, rd);
                java.lang.reflect.Constructor<?> ctor = startResp.getConstructor(long.class, byte[].class, Class.forName("kotlin.jvm.internal.g"));
                return success.invoke(companion, ctor.newInstance(sessionId, cpim, null));
            }
            if (n.startsWith("finishProvisioning")) {
                long sessionId = (Long) a[0];
                byte[] ptm = (byte[]) a[1], tk = (byte[]) a[2];
                Process proc = sessions.remove(sessionId);
                java.io.BufferedReader rd = sessionOut.remove(sessionId);
                if (proc == null) throw new RuntimeException("finishProvisioning: no live session " + sessionId);
                java.io.OutputStream in = proc.getOutputStream();
                in.write(("PTM_B64=" + Base64.getEncoder().encodeToString(ptm) + "\n").getBytes());
                in.write(("TK_B64=" + Base64.getEncoder().encodeToString(tk) + "\n").getBytes());
                in.flush();
                String line = rd.readLine();
                System.err.println("[anisette] stage9 provision(finish) -> " + line);
                proc.waitFor(10, TimeUnit.SECONDS);
                proc.destroy();
                if (!"PROVISIONED=1".equals(line)) throw new RuntimeException("stage9_prov_native provision(finish) failed: " + line);
                // A successful re-provisioning is a legitimate reason for AMSKit to retry
                // request() again — don't let the earlier pre-provisioning attempts count
                // against that fresh cycle.
                requestCount[0] = 0;
                return success.invoke(companion, unit);
            }
            // eraseProvisioning/dispose must return a successful Expected<Unit>, not throw —
            // an unhandled exception here was what made AMSKit discard the session and retry
            // request() from scratch every time, masking the real stale-OTP bug as a loop.
            if (n.startsWith("eraseProvisioning")) {
                sessions.values().forEach(Process::destroy);
                sessions.clear(); sessionOut.clear();
                return success.invoke(companion, unit);
            }
            if (n.startsWith("dispose")) return null;
            throw new UnsupportedOperationException(n);
        });
    }

    public static void main(String[] a) throws Exception {
        // a: bridge.so classes.jar state-dir [credential-token-file|INTERACTIVE] [stage9-bin] [prov-dir]
        //
        // INTERACTIVE mode: prompts for the Apple ID and password directly on the controlling
        // terminal via System.console() — which is null (and this refuses to start) unless a
        // real TTY is attached, so it cannot be driven from a non-interactive pipe. The
        // password is read with echo off and never written to a file, logged, or passed as a
        // process argument; it lives only in this JVM's memory for the one AccountCredential
        // construction below, then the backing char[] is zeroed.
        System.load(a[0]);
        Native.registerAll(a[1], "com/apple/mediaservices/amskit/");
        Native.registerAll(System.getProperty("javacpp.jar"), "org/bytedeco/javacpp/");
        String state = a[2];
        initTrust(state + "/apple-roots.pem");

        String user, token;
        byte credType;
        boolean interactive = a.length > 3 && a[3].equals("INTERACTIVE");
        if (interactive) {
            java.io.Console console = System.console();
            if (console == null) throw new RuntimeException(
                "No controlling terminal (System.console() is null) — INTERACTIVE mode must run in a real terminal, not a pipe/redirect.");
            user = console.readLine("Apple ID: ");
            if (user == null) throw new RuntimeException("no Apple ID entered");
            user = user.trim();
            char[] pw = console.readPassword("Password: ");
            if (pw == null) throw new RuntimeException("no password entered");
            token = new String(pw);
            Arrays.fill(pw, '\0');
            credType = AccountCredential.rawPassword;
        } else {
            // credential-token-file must hold the PET (idmsPersonalEmailToken, cred_pet.txt,
            // 503 bytes) to match AccountCredential.Type.PasswordEquivalentToken below — NOT
            // cred_idmsauth.txt (idmsAuthToken, 280 bytes), a different token that caused
            // srpInitFailed when passed here.
            user = Files.readString(Path.of(state + "/cred_username.txt")).trim();
            token = Files.readString(Path.of(state + "/" + (a.length > 3 ? a[3] : "cred_pet.txt"))).trim();
            credType = AccountCredential.passwordEquivalentToken;
        }
        String stage9Bin = a.length > 4 ? a[4] : "../stage9_prov_native";
        String provDir = a.length > 5 ? a[5] : "/home/daksh/Git Projects/apple-music-linux/drm/files";
        String androidId = Files.readString(Path.of(provDir + "/ANDROID_ID")).trim();
        // false when provDir is a mirrored copy of a real device's identity (e.g. phone_mirror):
        // re-provisioning that identifier here would hit Apple's real servers under the SAME
        // identifier the real device actively uses, risking its session. Defaults true (own
        // freshly-provisioned Linux identities are always safe to re-provision).
        boolean allowReprovision = a.length > 6 ? Boolean.parseBoolean(a[6]) : true;

        java.lang.reflect.Method mk = BundleInfoWrapper.class.getMethod("access$make", String.class, String.class, String.class, String.class, String.class, String.class);
        // The real app's AndroidBundleInfo implementation (jadx p097e7/a.java,
        // C0670a.getIdentifier()) returns the literal string "musicAndroid" — NOT the
        // Android package name "com.apple.android.music". This is AMSKit's own internal
        // bundle-identifier scheme (used for `identifier`, and by default for
        // bundleIdentifierForMetrics/mediaAPIClientIdentifier too), completely separate
        // from the OS package name. Every prior attempt sent the wrong identifier here —
        // very plausibly the actual, most direct cause of the server's "environment
        // mismatch", since -29004 appears exactly where the server would validate the
        // client identifier against its list of known GrandSlam clients, and
        // "com.apple.android.music" is not one of them. applicationId (passed separately
        // to SessionBuilder.make() below) is correctly still the OS package name — that's
        // a different field (IDeviceInfo.applicationId = context.getPackageName()).
        String realIdentifier = "musicAndroid";
        String accountClientId = BundleInfoWrapper.getClientIdentifierAppStore();
        BundleInfoWrapper bi = (BundleInfoWrapper) mk.invoke(null, realIdentifier, realIdentifier, realIdentifier, "Music", "7.0.1", accountClientId);

        // Cross-verified against the real app's decompiled IDeviceInfo defaults and a connected
        // physical device (adb getprop / settings get global device_name / dumpsys package),
        // not guessed: platformName's real literal default is "Android" (not lowercase);
        // hardwareType/model are Build.MANUFACTURER+Build.MODEL with non-alphanumerics
        // stripped (real device here: manufacturer=motorola, model="motorola edge 60 pro" ->
        // model already starts with manufacturer, so hardwareType == sanitized model);
        // machineName is the raw Settings.Global "device_name" string, unsanitized;
        // platformVersion is Build.VERSION.RELEASE; buildVersion is the APK's versionCode
        // (1622 for the 7.0.1 build whose libAMSKit.so this bridge loads — confirmed via
        // `adb shell dumpsys package com.apple.android.music`); and stableIdentifier's real
        // algorithm (AMSStableIdentifierKt.getAppleStableIdentifier) is NOT a random UUID —
        // it falls back to Settings.Secure "android_id", the same 16-hex format as our own
        // provisioned ANDROID_ID, so it's set to the same value here for self-consistency.
        SessionBuilder sb = new SessionBuilder();
        sb.setHTTPProvider(new HttpProv());
        ExpectedSession es = sb.make(androidId, "1622", "motorolaedge60pro", "Android", "Daksh's Moto", "17", "motorola", "motorolaedge60pro",
            androidId, BUNDLE, bi, "", "", true, (byte) 0, false);
        if (!es.hasValue()) throw new RuntimeException("session: " + es.error());
        Session session = es.value();

        NativeAnisetteProviderAdaptor ad = new NativeAnisetteProviderAdaptor((com.apple.mediaservices.amskit.fairplay.INativeAnisetteProvider) anisetteProxy(stage9Bin, provDir, androidId, allowReprovision));
        AppleMediaServicesCore.makeAnisetteV3Provider(session, ad);

        BagService bag = new BagService(session, "AndroidMusic", "1", bi);
        IdMSBagService idms = AppleMediaServicesCore.createIdMSBagService(session);
        CredentialsAuthenticateTaskOptionsBuilder ob = new CredentialsAuthenticateTaskOptionsBuilder(idms, bag, "adam-auth");
        ob.withUserName(user);
        ob.withCredential(new AccountCredential(token, credType));
        ob.withType((byte) 0);
        ob.withHandler(new com.apple.mediaservices.amskit.authentication.IInterruptHandlerAdaptor());
        CredentialsAuthenticateTaskOptions opts = ob.build();

        AuthenticateResultTask task = AppleMediaServicesCore.perform(session, opts);
        Class<?> tca = Class.forName("com.apple.mediaservices.amskit.bindings.AuthenticateResultTask$TaskCallbackAdaptor");
        java.lang.reflect.Method mkm = tca.getDeclaredMethod("make"); mkm.setAccessible(true);
        Object cba = mkm.invoke(null);
        CountDownLatch done = new CountDownLatch(1);
        java.lang.reflect.Method then = tca.getDeclaredMethod("then", NativeCallback.class, Class.class, AuthenticateResultTask.class); then.setAccessible(true);
        then.invoke(cba, (NativeCallback) () -> done.countDown(), NativeCallback.class, task);
        if (!done.await(120, TimeUnit.SECONDS)) { System.err.println("timeout"); System.exit(2); }
        java.lang.reflect.Method get = tca.getDeclaredMethod("get"); get.setAccessible(true);
        ExpectedAuthenticateResult r = (ExpectedAuthenticateResult) get.invoke(cba);
        System.err.println("hasValue=" + r.hasValue());
        if (!r.hasValue()) System.err.println("error=" + r.error());
        System.exit(0);
    }
}
