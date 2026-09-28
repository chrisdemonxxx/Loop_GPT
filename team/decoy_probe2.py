#!/usr/bin/env python3
"""Decoy probe 2: fresh connections (Connection: close), UA dimension, conditional + cache-bust legs.
Tally x-hikari-trace suffixes => is the trace a per-connection id or a backend id?"""
import http.client, ssl, hashlib, json, sys, collections
from concurrent.futures import ThreadPoolExecutor

HOST = "loop-gpt.cyou"
UAS = {
    "curl-default": "curl/8.21.0",
    "probe": "decoy-probe/1.0 (+research-scout; hermes)",
    "browser": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
}
ctx = ssl.create_default_context()


def hit(path, ua, extra=None, tag=""):
    h = {"User-Agent": ua, "Cache-Control": "no-cache", "Accept": "*/*", "Connection": "close"}
    if extra:
        h.update(extra)
    try:
        c = http.client.HTTPSConnection(HOST, 443, context=ctx, timeout=25)
        c.request("GET", path, headers=h)
        r = c.getresponse()
        b = r.read()
        c.close()
        return {"tag": tag, "path": path, "status": r.status, "len": len(b),
                "sha": hashlib.sha256(b).hexdigest()[:12], "etag": r.getheader("etag"),
                "trace": r.getheader("x-hikari-trace"), "edge": r.getheader("x-railway-edge"),
                "body": b.decode("utf-8", "replace")[:120]}
    except Exception as e:
        return {"tag": tag, "path": path, "error": repr(e)}


rows = []
# A) 200 fresh connections, rotating UA
jobs = []
for i in range(200):
    name = list(UAS)[i % 3]
    jobs.append((("/version.json", UAS[name], None, "fresh:" + name)))
with ThreadPoolExecutor(max_workers=10) as ex:
    for r in ex.map(lambda a: hit(*a), jobs):
        rows.append(r)

# B) 20 conditional (If-None-Match = live etag)
with ThreadPoolExecutor(max_workers=5) as ex:
    for r in ex.map(lambda a: hit(*a), [("/version.json", UAS["probe"],
                                         {"If-None-Match": '"6aba430b-4b"'}, "cond")] * 20):
        rows.append(r)

# C) 20 cache-busted (map regex anchors $uri, so ?cb= should still match no-store)
with ThreadPoolExecutor(max_workers=5) as ex:
    for r in ex.map(lambda a: hit(*a), [("/version.json?cb=%d" % i, UAS["probe"], None, "cb") for i in range(20)]):
        rows.append(r)

# D) the API surface, for the paired-shape rule
with ThreadPoolExecutor(max_workers=5) as ex:
    for r in ex.map(lambda a: hit(*a), [("/api/version", UAS["probe"], None, "api")] * 20):
        rows.append(r)

json.dump(rows, open(sys.argv[1] if len(sys.argv) > 1 else "decoy_probe_fresh.json", "w"), indent=0)

print("== %d probes total ==" % len(rows))
for tag in ("fresh:curl-default", "fresh:probe", "fresh:browser", "cond", "cb", "api"):
    sub = [r for r in rows if r["tag"] == tag]
    if not sub:
        continue
    errs = [r for r in sub if "error" in r]
    sc = collections.Counter(r["status"] for r in sub)
    sh = collections.Counter((r.get("sha"), r.get("len")) for r in sub if "error" not in r)
    tr = collections.Counter(r.get("trace") for r in sub if "error" not in r)
    print("  %-18s n=%-4d status=%s bodies=%s errors=%d" % (tag, len(sub), dict(sc), dict(sh), len(errs)))
    print("  %-18s distinct traces: %s" % ("", dict(tr)))
    if errs:
        print("      first error:", errs[0]["error"])
# decoy hunt
DECOY_MARK = "bankerOutreach"
dec = [r for r in rows if DECOY_MARK in (r.get("body") or "")]
print("DECOY SIGHTINGS (%s): %d" % (DECOY_MARK, len(dec)))
for d in dec:
    print("   ", json.dumps(d))
print("distinct trace suffixes across all rows:", sorted(set(
    (r.get("trace") or "?").split(".")[-1] for r in rows if "error" not in r)))
