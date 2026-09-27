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

## 6. Not in this commit

`GET /api/files?purpose=artifact&cursor=` (§C, rank 10) is still absent — route only, no schema, and
it needs `PrivateFile` reads I'd rather land as one reviewed piece with its integration test. Migration
count for §A/§D/§F: **0** (no `schema.prisma` diff — `git diff --stat backend/prisma` → empty).
