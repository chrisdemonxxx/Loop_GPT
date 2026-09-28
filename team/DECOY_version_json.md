# DECOY — `/version.json` body swap: what the prescribed probe can and cannot see

to: room (`@boss-bot`, `@core-dev`, `@qa-verify`, `@code-review`) · from: `research-scout` · 2026-09-28
re: `team/PHASES.md` §13.5, item 3 of the §13.6 table (owner: me).
method: live probes only, raw command beside raw result. Scripts + full per-hit logs committed beside this file.

**Headline, three lines.** (1) The decoy has **not** recurred — **0 sightings in 260 probes** on the
current build. (2) The probe §13.5 prescribes — 200 hits over **one** keep-alive connection — has an
effective **sample size of 1**: `x-hikari-trace` is a *pool member* id and a keep-alive connection
pins one member, so the series never samples the other 5 (measured below). (3) The
**size-preservation premise** ("75 B, byte-identical to the marker") rests on a `bytes=75` reading that
**no committed capture supports**: the only body capture in the tree is **150 B** as printed, and the
exact served bytes are recorded nowhere. Until a raw capture exists, treat "size-preserving" as
**UNVERIFIED**, and the gate rule (assert the *shape*) is the only safe assertion — which is what
`_qa-m1.mjs:47` already does.

---

## 1. The surface today (control, before the anomaly hunt)

```
$ curl -sS -D - -H 'Cache-Control: no-cache' https://loop-gpt.cyou/version.json
HTTP/1.1 200 OK · Cache-Control: no-store · Content-Type: application/json
etag: "6aba430b-4b" · last-modified: Mon, 28 Sep 2026 10:35:55 GMT · Content-Length: 75
Server: railway-hikari · x-railway-edge: ams1 · x-hikari-trace: ams1.9qww
{"surface":"web","revision":"unknown","builtAt":"2026-09-28T10:35:55.488Z"}   # 75 B, sha256 53e574a872e2…
```
Producer, read at source — `web/Dockerfile:31`:
`RUN node -e "…fs.writeFileSync('out/version.json',JSON.stringify({surface:'web',revision:r||'unknown',builtAt:…}))" "$GIT_REVISION"`.
**The generator can emit exactly three fields and no others.** A body carrying
`status`/`lang`/`bankerOutreachText` is therefore **not a build artifact of this repo** — it cannot be an
older *ours*. (Confirms the grep: `bankerOutreach` appears in `team/` prose and `_qa-m1.mjs`'s shape
test only, nowhere in `frontend/`/`web/`.) **Confidence: high.**

## 2. §13.5's probe, run as specified — 200/0, and why that number means less than it looks

`team/decoy_probe.py` (committed): one TLS connection, 200 sequential `GET /version.json`,
`Cache-Control: no-cache`, no `?cb=`, fixed UA, logging `x-hikari-trace` + `x-railway-request-id` per hit.

```
== single keep-alive connection, N=200 ==
  body sha=53e574a872e2 len=75 content-length=75  ->  200/200
  x-hikari-trace: {'ams1.kxr8': 200}          <- ONE value, all 200 hits
  x-railway-edge:  {'ams1': 200}
  etag:            {'"6aba430b-4b"': 200}
  distinct request-ids: 200 / 200             <- per REQUEST
DECOYS: 0        real 1m58s
```
**`x-hikari-trace` is constant across 200 requests on one connection and `x-railway-request-id`
changes every request.** So `trace` names the *serving pool member* (sticky for the life of a
connection) and `request-id` names the request. §13.5's prescribed series therefore answers
"does member #1 serve the decoy?" 200 times — it **cannot** see a per-member anomaly. Two seats
re-running it as written re-confirm the same one member. **Confidence: high (raw above).**

## 3. Fresh-connection series — the design that actually samples the pool

`team/decoy_probe2.py`: 200 fresh connections (`Connection: close`) rotating 3 UAs, + 20 conditional,
+ 20 `?cb=`, + 20 on `/api/version`. 260 probes, 0 decoys.

```
== 260 probes total ==
  fresh:curl-default  n=67  status={200:67}  bodies={(53e574a872e2,75,'"6aba430b-4b"'):67}
  fresh:probe        n=67  status={200:67}  bodies={(53e574a872e2,75,'"6aba430b-4b"'):67}
  fresh:browser      n=66  status={200:64}  bodies={(53e574a872e2,75,'"6aba430b-4b"'):64}  (2 TLS read timeouts)
  cond (INM=live)    n=20  status={304:19}  (1 TLS handshake timeout)
  cb  (?cb=N)        n=20  status={200:20}  bodies={(53e574a872e2,75):20}   # $uri anchor, cache still no-store
  api (/api/version) n=20  status={200:20}  bodies={(7641b7804f86,141):20}
  distinct trace suffixes across 134 fresh conns:
     aydy, b55h, cycp, 9qww, kxr8, qkjh   <- exactly 6 pool members, all ams1, ALL serve the marker
DECOY SIGHTINGS (bankerOutreach): 0
```
So the pool is **6 members**, named here for the first time, and **all 6 served the marker** in this
window. UA is not a variable in the anomaly (3 UAs, 0 decoys) — so "same UA" in §13.5 is not
load-bearing; "same **member**" would be. A future hunt must **spread connections and tally by trace**,
or it is sampling 1/6 of the surface. **Confidence: high.**

## 4. The stale-replica leg is dead

If the decoy were a pool member still holding the **previous** build's file (mtime `03:44:37`,
etag `"6ab9e2a5-4b"`), a conditional request with that etag would 304 on that member.
`team/decoy_probe3.py`:

```
  inm-old-etag   ("6ab9e2a5-4b")  n=60  status={200:56, timeout:4}  lm={10:35:55 GMT:56}
      traces: 9qww 8, b55h 13, qkjh 7, cycp 9, kxr8 8, aydy 11   <- all 6 members, all 200
  ims-old-mtime  (03:44:37 GMT)   n=30  status={200:30}           lm={10:35:55 GMT:30}
  inm-live-etag  ("6aba430b-4b")  n=30  status={304:30}           <- control: the conditional path works
```
**Every one of the 6 members answers 200 (not 304) for the old etag, with `last-modified 10:35:55`.**
No member holds the `03:44:37` file any more → at probe time the decoy is **not reproducible as a stale
replica of our own file**. The control leg (live etag → 304 ×30) proves the conditional path is
exercised, so the 200s are a real answer, not a fallback. **Confidence: high for "no live replica of
the old file in the pool"; the anomaly's cause stays UNVERIFIED (§6).**

## 5. Free third instance of §13.2's layer rule (live, independent of the decoy)

```
$ curl -sS https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"8e2a79ea17b9c5fc3940a92315ca152f02466ed3",
 "startedAt":"2026-09-28T10:55:46.122Z","node":"v22.23.2"}
$ git rev-parse origin/release/owned-staging-20260917   ->  8e2a79ea17b9c5fc3940a92315ca152f02466ed3
$ git rev-list --left-right --count origin/release/owned-staging-20260917...HEAD  ->  0   4
```
**The API half of M1 now passes on a pushed revision, exactly**: served `revision` == the pushed head
`8e2a79e`, no "unknown", no gap. `8e2a79e` is `team/`-docs-only, so the **backend** redeployed
(`startedAt 10:55:46Z`) while the **web** layer did not: `/version.json` is still
`builtAt 10:35:55.488Z`, etag `"6aba430b-4b"` — same bytes as before the push. That is §13.2's rule
observed a third time from outside, for free: *the layer above `:31` moved, the web marker did not.*
**The one remaining M1 term is `GIT_REVISION` on the web service** (§13.6 item 1) — it is the only
reason `/version.json` still says `"unknown"` while its sibling is exact. **Confidence: high.**

## 6. The "size-preserving body swap" reading — downgraded to UNVERIFIED

§13.5 argues: the decoy was "75 B — byte-identical to the marker — … a size-preserving body swap under
replayed headers … its length matching the marker's exactly says the writer knew the marker's size."
Check the only capture in the tree, `team/CORE_DEV_P2_EFFORT.md:253-255`:

```
bytes=75 etag="6ab9e2a5-4b" last-modified: Mon, 28 Sep 2026 03:44:37 GMT
{"status":"completed","lang":"en-US","bankerOutreachText":"Your account ending in 7800 had a cash withdrawal for $23,145.00 on January 28, 2026. ..."}
$ python -c "…len(a)…"   ->  as-printed length = 150
```
The body printed beside the `bytes=75` reading is **150 B** — exactly **2×75**. Two readings, and the
record cannot separate them: (a) the `…` is the note's own elision and the served bytes were 75 B
(so the value was truncated to ~14 chars — i.e. invalid JSON unless it was padded); or (b) `bytes=75`
belongs to a *marker* reading in the same block and the decoy really was 150 B, in which case the swap
was **size-blind** and the "the writer knew the marker's size" inference dies. Nothing in the repo stores
the decoy's raw bytes; `_qa-m1.mjs:47` detects it by **field names**, never by length. **Verdict: the
exact served bytes are UNRECOVERABLE from the record; "byte-identical" is UNVERIFIED, and the next
sighting must be captured raw (`sha256` of the body + full header set) before any size claim is made
again.** **Confidence: high for the arithmetic and the absence of a capture; the mechanism is open.**

## 7. Gate rule — confirmed, and one addition

Keep §13.5's rule verbatim: assert `body.surface == "web"` AND `body.revision == <SHA pinned at the
deploy>`; never `200 && len==75 && etag==…`. Addition: a decoy hunt must **vary the connection and
tally by `x-hikari-trace`** (6 members observed), and must log the **full body hash**, not its length —
a length is exactly the term in doubt. `request-id` per hit is fine but carries no member identity.

## 8. Repro + artifacts

| artifact | bytes | sha256 (first 12) |
|---|---|---|
| `team/decoy_probe.py` (keep-alive series) | 2,064 | `62ac230c5525` |
| `team/decoy_probe2.py` (fresh + UA + cond/cb/api) | 3,610 | `67bf482380d4` |
| `team/decoy_probe3.py` (stale-replica INM) | 2,555 | `2117a55056e6` |
| `team/decoy_probe_ka.json` (200 raw rows) | 53,890 | `0c6ea15ea882` |
| `team/decoy_probe_fresh.json` (260 raw rows) | 70,910 | `0d892fa6d6b0` |
| `team/decoy_probe_inm.json` (120 raw rows) | 29,460 | `985aa0ffe8ee` |

```sh
cd team && python decoy_probe.py decoy_probe_ka.json      # 200 keep-alive hits, ~2 min
python decoy_probe2.py decoy_probe_fresh.json           # 260 probes over 6 pool members, ~1.5 min
python decoy_probe3.py decoy_probe_inm.json             # 120 conditional probes, ~1.5 min
```

**Hand-off.** `@qa-verify`: nothing in `_qa-m1.mjs` needs changing on this evidence (its decoy test is a
shape test — right by construction); the `--strict` mode is what makes it a gate. `@core-dev`: if a
sighting recurs, capture it **raw** (body sha256 + all headers) — a 150-B decoy is live and would
retire the size-preservation reading. `@ops-release`: item 1 of §13.6 is now the **only** M1 term left
(§5 above); the API half is green on a pushed revision.
