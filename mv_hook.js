// Frida hook — Apple Music Android MV: capture lease API URL + request/response
// Usage: frida -U -f com.apple.android.music -l mv_hook.js
//   then tap an MV in the emulator

'use strict';
const TAG = '[mv]';
function log(msg) { console.log(TAG + ' ' + msg); }

// ── OkHttp3: capture every request to play.itunes.apple.com ──────────────────
Java.perform(function () {

    // 1. Hook OkHttpClient.newCall → intercept the Request object before sending
    try {
        const OkHttpClient = Java.use('okhttp3.OkHttpClient');
        const Request = Java.use('okhttp3.Request');

        OkHttpClient.newCall.implementation = function (request) {
            try {
                const url = request.url().toString();
                if (url.includes('play.itunes.apple.com')) {
                    log('\n=== OkHttp → play.itunes ===');
                    log('  URL: ' + url);
                    log('  method: ' + request.method());
                    // Log headers
                    const headers = request.headers();
                    for (let i = 0; i < headers.size(); i++) {
                        log('  hdr: ' + headers.name(i) + ': ' + headers.value(i));
                    }
                    // Log request body if present
                    const body = request.body();
                    if (body !== null) {
                        try {
                            const Buffer = Java.use('okio.Buffer');
                            const buf = Buffer.$new();
                            body.writeTo(buf);
                            const bodyStr = buf.readUtf8();
                            log('  body: ' + bodyStr.substring(0, 2000));
                        } catch (e) { log('  body read err: ' + e); }
                    }
                }
            } catch (e) { log('OkHttp newCall err: ' + e); }
            return this.newCall(request);
        };
        log('OkHttp3 newCall hooked');
    } catch (e) { log('OkHttp3 newCall FAILED: ' + e); }

    // 2. Also hook the response body for play.itunes responses
    try {
        const RealCall = Java.use('okhttp3.internal.connection.RealCall');
        // Try to hook execute() to get the response
        RealCall.execute.implementation = function () {
            const response = this.execute();
            try {
                const url = response.request().url().toString();
                if (url.includes('play.itunes.apple.com')) {
                    const body = response.body();
                    if (body !== null) {
                        const bodyStr = body.string();
                        log('=== RESPONSE from ' + url + ' ===');
                        log(bodyStr.substring(0, 4000));
                        // Reconstruct response with same body (body is one-shot)
                        const MediaType = Java.use('okhttp3.MediaType');
                        const ResponseBody = Java.use('okhttp3.ResponseBody');
                        const newBody = ResponseBody.create(body.contentType(), bodyStr);
                        return response.newBuilder().body(newBody).build();
                    }
                }
            } catch (e) { log('RealCall execute resp err: ' + e); }
            return response;
        };
        log('OkHttp3 RealCall.execute hooked');
    } catch (e) { log('RealCall.execute FAILED: ' + e); }

    // 3. setDownloadUrl — fires when mvod URL assigned (confirms the URL works)
    try {
        const MAI = Java.use('com.apple.android.music.playback.model.MediaAssetInfo');
        MAI.setDownloadUrl.implementation = function (url) {
            if (url && url.toString().includes('mvod')) {
                log('\n=== setDownloadUrl FIRED ===');
                log('  url: ' + url.toString().substring(0, 300));
            }
            return this.setDownloadUrl(url);
        };
        log('setDownloadUrl hooked');
    } catch (e) { log('setDownloadUrl FAILED: ' + e); }

    log('=== hooks ready — NOW TAP AN MV IN THE EMULATOR ===');
});
