import plistlib, sys, uuid, os, ssl, urllib.request
CTX = ssl.create_default_context(cafile='state/apple-roots.pem')
CLIENT_INFO = "<Pixel 7><Android; 14;441323.1><com.apple.android.music>"
dev = open("state/deviceid").read().strip() if os.path.exists("state/deviceid") else str(uuid.uuid4()).upper()
open("state/deviceid", "w").write(dev)
for url in ("https://gsd.apple.com/grandslam/GsService2/lookup/v2", "https://gsa.apple.com/grandslam/GsService2/lookup"):
    req = urllib.request.Request(url, headers={"X-MMe-Client-Info": CLIENT_INFO, "X-MMe-Device-Id": dev,
        "X-Apple-I-Client-Bundle-Id": "com.apple.android.music", "Accept": "*/*", "Content-Type": "text/x-xml-plist"})
    try:
        with urllib.request.urlopen(req, timeout=30, context=CTX) as r:
            body = r.read(); print(url, r.status, len(body))
    except Exception as e:
        print(url, "ERR", e); continue
    try:
        d = plistlib.loads(body)
    except Exception as e:
        print(body[:300]); continue
    urls = d.get("urls", d)
    open("state/gs-lookup.plist", "wb").write(body)
    for k in sorted(urls):
        if "rov" in k or "mid" in k.lower(): print("  ", k, urls[k])
    break
