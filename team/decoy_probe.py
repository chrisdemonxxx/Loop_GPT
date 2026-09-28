#!/usr/bin/env python3
"""Decoy mechanism probe: 200 hits /version.json over ONE keep-alive connection,
same UA, no ?cb=, Cache-Control: no-cache. Logs per-hit trace ids + body hash."""
import http.client, ssl, hashlib, json, sys, collections

HOST = "loop-gpt.cyou"
UA = "decoy-probe/1.0 (+research-scout; hermes)"
PATH = "/version.json"
N = 200

ctx = ssl.create_default_context()
rows = []
conn = http.client.HTTPSConnection(HOST, 443, context=ctx, timeout=20)
for i in range(N):
    conn.request("GET", PATH, headers={
        "User-Agent": UA,
        "Cache-Control": "no-cache",
        "Accept": "*/*",
        "Connection": "keep-alive",
    })
    r = conn.getresponse()
    body = r.read()
    rows.append({
        "i": i,
        "status": r.status,
        "len": len(body),
        "sha": hashlib.sha256(body).hexdigest()[:12],
        "cl": r.getheader("content-length"),
        "etag": r.getheader("etag"),
        "trace": r.getheader("x-hikari-trace"),
        "edge": r.getheader("x-railway-edge"),
        "rid": r.getheader("x-railway-request-id"),
        "body": body.decode("utf-8", "replace"),
    })
conn.close()

print("== single keep-alive connection, N=%d, UA=%s ==" % (N, UA))
c = collections.Counter((x["sha"], x["len"], x["cl"]) for x in rows)
for k, v in c.most_common():
    print("  body sha=%s len=%s content-length=%s  ->  %d/%d" % (k[0], k[1], k[2], v, N))
tc = collections.Counter(x["trace"] for x in rows)
print("  x-hikari-trace:", dict(tc))
ec = collections.Counter(x["edge"] for x in rows)
print("  x-railway-edge:", dict(ec))
ec2 = collections.Counter(x["etag"] for x in rows)
print("  etag:", dict(ec2))
print("  distinct request-ids:", len(set(x["rid"] for x in rows)), "/", N)
bodies = collections.Counter(x["body"] for x in rows)
for b, n in bodies.most_common():
    print("  BODY x%d: %s" % (n, b))
# first and last 3 raw rows
print("  first:", json.dumps(rows[0]))
print("  last :", json.dumps(rows[-1]))

with open(sys.argv[1] if len(sys.argv) > 1 else "decoy_probe_ka.json", "w") as f:
    json.dump(rows, f)
