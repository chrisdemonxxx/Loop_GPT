#!/usr/bin/env python3
"""Decoy probe 3: is a stale replica still serving the PREVIOUS build's /version.json?
INM with the OLD etag (6ab9e2a5-4b, the 03:44:37 build) over 60 fresh connections:
  200 => no live replica holds the old file anywhere in the pool
  304 => a pool member still holds the 03:44:37 file (a replica, not a rewrite)
Also IMS with the old mtime, and a control INM with the live tag."""
import http.client, ssl, hashlib, json, sys, collections
from concurrent.futures import ThreadPoolExecutor

HOST = "loop-gpt.cyou"
UA = "decoy-probe/1.0 (+research-scout; hermes)"
ctx = ssl.create_default_context()


def hit(a):
    path, extra, tag = a
    h = {"User-Agent": UA, "Cache-Control": "no-cache", "Accept": "*/*", "Connection": "close"}
    h.update(extra)
    try:
        c = http.client.HTTPSConnection(HOST, 443, context=ctx, timeout=25)
        c.request("GET", path, headers=h)
        r = c.getresponse()
        b = r.read()
        c.close()
        return {"tag": tag, "status": r.status, "len": len(b),
                "sha": hashlib.sha256(b).hexdigest()[:12], "etag": r.getheader("etag"),
                "lm": r.getheader("last-modified"), "trace": r.getheader("x-hikari-trace"),
                "body": b.decode("utf-8", "replace")[:120]}
    except Exception as e:
        return {"tag": tag, "error": repr(e)}


jobs = []
jobs += [("/version.json", {"If-None-Match": '"6ab9e2a5-4b"'}, "inm-old-etag")] * 60
jobs += [("/version.json", {"If-Modified-Since": "Mon, 28 Sep 2026 03:44:37 GMT"}, "ims-old-mtime")] * 30
jobs += [("/version.json", {"If-None-Match": '"6aba430b-4b"'}, "inm-live-etag")] * 30
rows = []
with ThreadPoolExecutor(max_workers=10) as ex:
    for r in ex.map(hit, jobs):
        rows.append(r)
json.dump(rows, open(sys.argv[1] if len(sys.argv) > 1 else "decoy_probe_inm.json", "w"), indent=0)
for tag in ("inm-old-etag", "ims-old-mtime", "inm-live-etag"):
    sub = [r for r in rows if r["tag"] == tag]
    errs = [r for r in sub if "error" in r]
    print("%-14s n=%d status=%s" % (tag, len(sub), dict(collections.Counter(r.get("status") for r in sub))))
    print("   bodies  %s" % dict(collections.Counter((r.get("sha"), r.get("len"), r.get("etag")) for r in sub if "error" not in r)))
    print("   lm      %s" % dict(collections.Counter(r.get("lm") for r in sub if "error" not in r)))
    print("   traces  %s" % dict(collections.Counter(r.get("trace") for r in sub if "error" not in r)))
    if errs:
        print("   errors  %s" % collections.Counter(r["error"] for r in errs).most_common(2))
