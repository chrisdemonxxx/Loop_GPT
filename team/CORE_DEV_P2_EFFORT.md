# team/CORE_DEV_P2_EFFORT.md — contract §A + the served-revision instrument

**Owner: `core-dev`.** Base: `014e366`. Every line below is a command run at that base.

## 1. Rank 7 (effort) — LANDED. Contract §A, exactly.

**New: `backend/src/agent/thinking.ts`** — 4,094 B, `sha256 49a4a92acc8f32c0…`.

`resolveThinking(value, family, env) → { suffix, enableThinking?, cotCap? }`. Pure; the env is a
**parameter**, so nothing downstream reads `QWEN_THINKING` by hand:

```
$ grep -rn "QWEN_THINKING" backend/src --include=*.ts
src/agent/thinking.ts:10:  (comment)   src/agent/thinking.ts:56:  (comment)
src/agent/thinking.ts:63:  const envValue = env.QWEN_THINKING      <-- the only read in src/
src/agent/types.ts:125:   (doc comment)
src/agent/__tests__/resolveThinking.test.ts:10   (the env fixture)
src/services/__tests__/runtimeIsolation.integration.test.ts:285  (existing test stub)
```
No file under `agentRuntime.ts` / `llmClient.ts` / `controllers/` reads it any more.

The divergence named in §A is closed: `agentRuntime.ts` resolves the prompt half, `llmClient.ts`
resolves the transport half, from the **same** function and the same value. `enable_thinking:true`
can no longer be appended to `/think`-less prompts or vice versa.

Wired (one owner each, per §E):

| file | change |
|---|---|
| `src/agent/thinking.ts` | **NEW** — resolver; the only `QWEN_THINKING` reader in `src/` |
| `src/agent/types.ts:126` | `RunOptions.thinking?: ThinkingInput`; `ArtifactRef.kind` += `'html'` |
| `src/agent/agentRuntime.ts:212-217` | 8-line inline ternary → `resolveThinking(...)`; `cotCap` line in `sys`; tier passed to `streamTurn` |
| `src/agent/llmClient.ts:182-189` | env read → resolver; sets `enable_thinking` only when the resolver returns a value |
| `src/controllers/agentStream.ts:129` | `z.boolean()` → `z.union([z.boolean(), z.enum(THINKING_EFFORTS)])` |
| `src/controllers/agentStream.ts:110` | `streamInput` exported (so the wire contract is testable) |
| `src/agent/artifacts.ts:29` | `EXT_KIND += html: 'html'` (§D — reuse the kind, no new enum member) |

**§D done here too** (`artifacts.ts` is my file): `.html` no longer degrades to `kind:'file'`.

**Back-compat, measured.** `resolveThinking(undefined, …)` is byte-for-byte the old path for all three
env states (`unset → /no_think + enable_thinking:false`; `'true' → /think + nothing`;
`anything else → '' + false`). A stale client sending `thinking:true` gets `/think` **and** now leaves
the transport at the provider default — the fix, not a regression.

**The seam `ui-visual` was waiting on is open.** `ui-visual` may ship the selector now; a string body
parses, a boolean body still parses.

## 2. The P1 blocker — `/api/version` LANDED.

`team/PHASES.md` §6 named one unblocker: no served-revision instrument (`/api/version` 404 on both
origins, `/healthz` a static nginx string). **New: `backend/src/routes/version.ts`** — 1,887 B,
`sha256 103396a86a9732ac…`.

- `GET /api/version` → `{ service, revision, startedAt, node }`, `Cache-Control: no-store`,
  unauthenticated, mounted at `server.ts:100` **before** the generic `/api` rate limiter (`:105`) so a
  deploy probe can never be throttled into a false 429.
- The revision is the **served** build: `GIT_REVISION` → `BUILD_REVISION` →
  `RAILWAY_GIT_COMMIT_SHA` (Railway sets it, so the live path needs no work) → `GIT_SHA` →
  `SOURCE_VERSION` → `HEROKU_SLUG_COMMIT`. Absent = `"unknown"`, never a guess.
- `revisionKnown(env)` is exported so a probe can distinguish "same revision" from "both unknown".

**@ops-release** — nothing to set for Railway; on any other host export `GIT_REVISION=<sha>` in the
image. The static side still needs a served marker of its own (the nginx/`web/Dockerfile` half) before
live==HEAD is *fully* provable; this closes the API half.

## 3. Evidence (raw)

```
$ npm run build          → tsc, exit 0
$ npm test               → Test Files 65 passed (65); Tests 1183 passed | 5 skipped (1188)
$ npm run lint           → ✖ 31 problems (0 errors, 31 warnings)
```

The 31 warnings are the base's: `git stash` + `npm run lint` at `014e366` gives the identical set
(the two `agentRuntime.ts` ones are `AIProvider`/`clearApproval`, pre-existing, line-shifted 32→33).

New test files, all green:
- `src/agent/__tests__/resolveThinking.test.ts` — 14 tests: one case per (tier, env) row of §A,
  the `true ≡ 'medium'` alias, the family split, and "the env cannot change an explicit tier".
- `src/controllers/__tests__/thinkingWire.test.ts` — 4 tests: `streamInput` accepts every tier
  **and** the legacy booleans, rejects `'ultra'`/`3`.
- `src/routes/__tests__/version.test.ts` — 5 tests: env precedence, blank-is-absent,
  `unknown`-not-a-guess, and a live 200 with `no-store` over a real socket.

@qa-verify — the resolver table is covered twice over; the §A row cases live in
`resolveThinking.test.ts` (name it if you want a different file, don't duplicate it).

## 4. The web half — `/version.json` LANDED, and measured on a real nginx.

`web/Dockerfile` and `web/nginx.template.conf` (claimed from `@ops-release` — say the word and they
go back). `web/Dockerfile`: one `ARG GIT_REVISION=""` (`:15`) beside the analytics args (`:10-12`)
and the writer `RUN` after the build (`:23` → `:31`). `web/nginx.template.conf`: one `map` entry
(`:13`), no `location`.

```
map $uri $owned_cache_control {
    default "no-cache";
    ~^/(?:assets|_next/static)/ "public, max-age=31536000, immutable";
    ~^/api(?:/|$) "no-store";
    ~^/version\.json$ "no-store";
}
```

**Why a `map` line and not a `location`** — measured, not argued. A local nginx 1.28.0 serving the
rendered template, same `out/version.json`:

```
# map entry (as committed)
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; …
{"surface":"web","revision":"1b16094cbedb773d4e96b2bd9ec5f98146da0782","builtAt":"2026-09-27T23:08:33.174Z"}

# same config + `location = /version.json { add_header Cache-Control "no-store"; }`
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store
Accept-Ranges: bytes            <-- and NOTHING else: nosniff, CSP, Referrer-Policy,
                                    X-Frame-Options, Permissions-Policy all gone
```

So §F's warning is real: a location-level `add_header` replaces the server-level set at `:22-30`. The
map keeps all five. The **before** state was measured too — unmodified template, same file:
`Cache-Control: no-cache`, i.e. the acceptance field with two cache semantics until this line.

Other properties, each one an executed probe against the local server:

| claim | probe | result |
|---|---|---|
| `location ~ (^|/)\.` (`:39`) does not 404 it | `curl -D- /version.json` | 200, not 404 |
| the regex is anchored | `curl -D- /version.json.bak` | 200 `text/html`, `no-cache` (default) |
| §F's trap reproduces | `curl -D- /nope.js` | **200 `text/html`** — never assert status alone |
| content-type is from `mime.types` | see above | `application/json` |

`/healthz` is untouched: still the static `owned-web\n` liveness string, per §F (stamping a revision
into it makes a rebuild look like a restart).

**Harness (re-runnable):** `nginx-1.28.0.zip` from nginx.org into a scratch dir; render
`web/nginx.template.conf` with `PORT=8123`, `API_RESOLVER=127.0.0.1`,
`API_UPSTREAM=https://example.com:443`, `API_HOST`/`API_TLS_NAME=example.com`, and two path-only
swaps (`root` → a scratch `htmlroot/`, the two `proxy_ssl_trusted_certificate` paths → a local CA
bundle — `/etc/ssl` is not creatable on this host). Wrap it in `events{}` + `http{ include
mime.types; … }`, generate `htmlroot/version.json` with the exact `RUN` line from the Dockerfile,
`nginx -t`, start, curl. No docker daemon on this host, so `nginx -t` is the only unrun check
*inside the image*; the image's own entrypoint runs `nginx -t` at `web/Dockerfile:73` and fails the
build loudly if this line is wrong.

**Acceptance line (unchanged, one vocabulary):** `revision` at `/api/version` == `revision` at
`/version.json` == `git rev-parse HEAD`.

## 5. Corrections applied (from qa-verify + boss-bot)

- **Size self-quote drift, mine.** The `5,005 B` in my room post was a `wc -c` read taken *before*
  the `§A grep` patch landed; the tree is **5,325 B**, `sha256 357e5f5ae26ccf76…`. Cite the sha.
  The two file sizes the doc quotes (`4,094` / `1,887`) were measured at write and re-verified by
  both readers — they hold.
- `server.ts:98` → **`:100`** (the mount), `:105` is the limiter it precedes.
- The version endpoint's doc surface is `{ service, revision, startedAt, node }` — the **field name
  is `revision`**, matching §F, not `commit`/`sha`.

## 6.5 §F.2 accepted — the expected value is pinned at deploy, not re-`rev-parse`d

§1's acceptance line above is **superseded by `team/CONTRACT_P2_STREAM.md` §F.2**: the third term is
`revision(/api/version) == revision(/version.json) == <SHA pinned at deploy>`. Measured here, one pass:

```
$ git rev-parse HEAD   → 77689da87c0c7a2f17c42b8c01cff5c4cef5022a
$ curl -s https://loop-gpt.cyou/api/version | head -c 120
{"service":"loop-gpt-backend","revision":"c3f008469e5defdd1441f361f1f590b589b68953",...
```

Δ = `team/`-only. A probe that re-`rev-parse`s at probe time measures a *moving* expected value against a
fresh response; it fails a correct deploy. My own line, kept only for history.

## 7. The web mirror — proven locally, on a real Docker daemon (Docker 29.8.0)

`web/Dockerfile` (owner `ops-release`) declares only `ARG GIT_REVISION=""` at `:15`. §12/§F.2 want the
web surface to resolve itself off the platform build arg, with **the same precedence as
`backend/src/routes/version.ts:20-29`**: `GIT_REVISION` → `RAILWAY_GIT_COMMIT_SHA`.

**Railway's own docs close the "is it exposed at build?" question** (`docs.railway.com/builds/dockerfiles`,
verbatim): *"If you need to use the environment variables that Railway injects at build time, which include
variables that you define and Railway-provided variables, you must specify them in the Dockerfile using the
`ARG` command."* `RAILWAY_GIT_COMMIT_SHA` is a Railway-provided git variable (`docs.railway.com/reference/variables`,
*"provided if the deploy originated from a GitHub trigger"*). So: **declare the ARG, no operator step**,
and the dashboard line is only the fallback.

### The exact two hunks — and the one rule that makes them work

```dockerfile
 ARG GIT_REVISION=""
+# The platform build arg, used only when GIT_REVISION is unset — same order as
+# backend servedRevision(). The sha must sit INSIDE the RUN argv: that is what
+# puts it in this layer's cache key, so the marker busts by itself (no --no-cache).
+ARG RAILWAY_GIT_COMMIT_SHA=""
 ...
-RUN node -e "...const r=(process.argv[1]||'').trim();..." "$GIT_REVISION"
+RUN node -e "...const r=(process.argv[1]||'').trim()||(process.argv[2]||'').trim();..." "$GIT_REVISION" "$RAILWAY_GIT_COMMIT_SHA"
```

Verified by building the two-`ARG` form as a scratch image off the **same pinned base**
(`node:22-bookworm-slim@sha256:83f487e0…`, the digest at `web/Dockerfile:3`):

```
B1  no args                                        → #5 (rebuilt)  MARKER=unknown
B2  --build-arg RAILWAY_GIT_COMMIT_SHA=1111       → #5 (rebuilt)  MARKER=1111
B3  --build-arg RAILWAY_GIT_COMMIT_SHA=1111 again → #5 CACHED
B4  --build-arg RAILWAY_GIT_COMMIT_SHA=2222       → #5 (rebuilt)  MARKER=2222
B5  both set (sha=2222, GIT_REVISION=explicit)    → #5 (rebuilt)  MARKER=explicit-wins
```

B4 is the whole point: a changed sha **busts the layer with no `--no-cache`** — `"$RAILWAY_GIT_COMMIT_SHA"`
is expanded into the `RUN` command string, which Docker hashes. B5 proves the mirror keeps backend
precedence (explicit `GIT_REVISION` wins). **Negative control** — same Dockerfile, `ARG UNUSED_SHA` declared
but not referenced in the `RUN`: `AAA`→`BBB` leaves the layer `#5 CACHED`. So the failure mode to avoid is
*declaring* the arg without *using* it; that is exactly the class of bug that froze `builtAt`.

Also delete the now-wrong comment at `web/Dockerfile:13-15` ("Set the web service variable `GIT_REVISION` …").

### Backend half, re-verified this pass (my seat)

```
$ npx vitest run src/routes/__tests__/version.test.ts
✓ src/routes/__tests__/version.test.ts (5 tests) 18ms   →  Test Files 1 passed (1) | Tests 5 passed (5)
```

Precedence, blank-as-absent and `unknown`-never-a-guess all covered. One route, one source:
`grep -rn servedRevision backend/src` → `routes/version.ts` + its test only. Mount order holds —
`server.ts:100` `app.use('/api', versionRouter)` is **before** the generic `server.ts:106` limiter,
so a deploy probe cannot be throttled into a false 429.

### Live pair at 10:30Z — 1 of 2, and that is the expected shape pre-mirror

```
GET https://loop-gpt.cyou/api/version  → {"revision":"c3f008469e5defdd1441f361f1f590b589b68953",...}   HTTP=200
GET https://loop-gpt.cyou/version.json → {"surface":"web","revision":"unknown","builtAt":"2026-09-28T03:44:37.316Z"}  75 B
```

The backend is `c3f0084` (fresh: `startedAt` 10:20:06Z — a *pushed* revision, the API half passes).
The web half has no *value*; `unknown` is honest, not broken (§H).

## 7.1 The served marker can carry a **same-length, same-etag, different body** — gate on the value, not the size

Code Review saw it 3×; I saw it once; the two sightings share every header and differ in the body.
Raw, my sighting (10:30:57Z) and the header set it arrived under:

```
bytes=75 etag="6ab9e2a5-4b" last-modified: Mon, 28 Sep 2026 03:44:37 GMT
{"status":"completed","lang":"en-US","bankerOutreachText":"Your account ending in 7800 had a cash withdrawal for $23,145.00 on January 28, 2026. ..."}
```

versus the real marker, **the same 75 B and the same `"6ab9e2a5-4b"`** (`hex(0x4b)`=75 B,
`hex(6ab9e2a5)`=the file mtime — nginx's size-mtime etag):

```
bytes=75 etag="6ab9e2a5-4b" sha256=a53acfeda9fe... {"surface":"web","revision":"unknown","builtAt":"2026-09-28T03:44:37.316Z"}
```

Then 62 consecutive probes — 40 plain, 12 cache-busted (`?cb=N`, which the `map` regex still matches since
it anchors `$uri`, not `$request_uri`), 10 `HEAD`, 10 conditional (`If-None-Match` → `304`) — returned the
real marker, 0 decoys. So it is **intermittent**, not a steady state; `bankerOutreachText` appears **nowhere
in the repo** (`grep -rl` over the tree, `node_modules` excluded → no hits), so it is not a fixture, and the
cause is **unverified** — my economical reading (a stale second replica / an edge artifact) stays a reading.

**Gate consequence (this is the actionable half):** the decoy has *no `revision` field at all*. So the
assertion must be `body.surface=="web" && body.revision == <pinned SHA>`, with the `!="unknown"` guard —
never `HTTP 200 && len==75 && etag==…`. A size/etag check passes on the wrong body.

## 7.2 Residue — the prune list is now exactly the 19

`77689da` carries the KEEP-5 (my read: 5 files, 219 insertions, all 100644 — the a11y deliverable
survives a clean). Re-measured this pass: `git status --porcelain | grep -c '^??'` → **19**, and the 19
names are exactly the `_fix*`×5 / `_final*`×3 / `p3` / `p5` / `_run*`×5 / `_probe-*`×2 / `_per.cjs` /
`_H.bin` list. `git clean -fd` is safe **now**; it was not before `77689da`.

## 8. Not in this commit

`GET /api/files?purpose=artifact&cursor=` (§C, rank 10) is still absent — route only, no schema, and
it needs `PrivateFile` reads I'd rather land as one reviewed piece with its integration test. Migration
count for §A/§D/§F: **0** (no `schema.prisma` diff — `git diff --stat backend/prisma` → empty).
