import json, sys, urllib.request
CLIENT_INFO = "<Pixel 7><Android; 14;441323.1><com.apple.android.music>"
req = urllib.request.Request("https://setup.icloud.com/configurations/init",
    headers={"X-MMe-Client-Info": CLIENT_INFO, "X-MMe-Country": "US", "Accept-Language": "en-us"})
with urllib.request.urlopen(req, timeout=30) as r:
    body = r.read()
    print(r.status, len(body), file=sys.stderr)
d = json.loads(body)
open("state/icloud-bag.json", "w").write(json.dumps(d, indent=1))
urls = d.get("urls", {})
print(len(urls), "urls")
for k in sorted(urls):
    if any(s in k.lower() for s in ("prov", "mid", "anisette", "amd", "gs", "lookup")): print(k, urls[k])
