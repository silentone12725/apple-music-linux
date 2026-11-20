package adam;

import com.apple.mediaservices.amskit.bindings.*;
import com.apple.mediaservices.amskit.network.*;
import java.net.*;
import java.io.*;
import java.util.*;
import kotlin.Pair;

public class Smoke {
    static class HttpProv extends IAndroidHTTPProvider {
        public void shutdown() {}
        public void submitRequest(IAndroidHTTPProvider.HTTPRequest req, IAndroidHTTPProvider.Callback cb) {
            System.err.println("submitRequest url=" + req.urlString() + " method=" + req.method());
            cb.completeExceptionally(new RuntimeException("smoke: not implemented"));
        }
    }

    public static void main(String[] a) throws Exception {
        System.load(a[0]);
        System.err.println("bridge loaded");
        Native.registerAll(a[1], "com/apple/mediaservices/amskit/");
        BundleInfoWrapper bi = BundleInfoWrapper.Companion.invoke(new com.apple.mediaservices.amskit.AndroidBundleInfo() {
            public String getIdentifier() { return "com.apple.android.music"; }
            public String getName() { return "Music"; }
            public String getVersion() { return "7.0.1"; }
        });
        SessionBuilder sb = new SessionBuilder();
        sb.setHTTPProvider(new HttpProv());
        ExpectedSession es = sb.make("0123456789abcdef", "1.0", "Android", "Android", "linux", "14", "adam", "pc",
            "stable-id", "com.apple.android.music", bi, "", "", true, (byte)0, false);
        System.err.println("hasValue=" + es.hasValue());
        if (!es.hasValue()) System.err.println("error=" + es.error());
    }
}
