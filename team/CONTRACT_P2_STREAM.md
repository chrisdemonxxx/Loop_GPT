# team/CONTRACT_P2_STREAM.md — arch-lead signature for P2

**Owner: `arch-lead`.** Signed 2026-09-27. Basis: read of the code at `59b0e08`, not of any summary.
**Revision 3 (2026-09-27):** §F revision-source list corrected to `routes/version.ts:20-27` verbatim
(six tokens, order included) — rev 2 stated a four-token subset in the wrong precedence. Rev 2's §A/§B
and the drift fixes at `:59`/`:129` stand.
**Revision 4 (2026-09-27, at `0d5d767`):** (a) every shape in §A/§B/§D re-verified against the tree
after M2 landed — **no shape divergence**; (b) the line anchors in §A/§B/§E re-based (M2 added lines
above them, so the old numbers were right at `59b0e08` and are wrong now); (c) §F ship ruling — the
one-token producer that actually shipped at `web/Dockerfile:31` is an **accepted divergence**, §F
addendum below. Verified at `0d5d767`: `frontend/app/lib/stream.ts:64` carries the widened union;
`backend/src/controllers/agentStream.ts:129` is `z.union([z.boolean(), z.enum(THINKING_EFFORTS)])`;
`frontend/app/chat/page.tsx:52` is `useState<EffortValue>('auto')`; `frontend/app/components/chat/types.ts:86`
carries `QueuedMessage.thinking`; `frontend/app/components/chat/Composer.tsx:12` imports
`{ EffortSelector, type EffortValue }`; and `QWEN_THINKING` still has exactly one reader in
`backend/src/` (`thinking.ts:63`).
Covers `FRONTIER_RECON.md` §2 ranks 3, 7, 9, 10 — the four it marks "**Contract** needed".
Everything below is a decision; the implementer does not get to re-open it, only to implement it.

## 0. Path correction (cite these, not the ones in older kickoffs)

| contract doc says | on disk | 
|---|---|
| `frontend/components/chat/types.ts` | **`frontend/app/components/chat/types.ts`** — `LiveStep:27`, `QueuedMessage:67` |
| `frontend/app/lib/stream.ts` | `frontend/app/lib/stream.ts` (295 L at `0d5d767`) — correct |
| `backend/src/agent/runAuthorization.ts` | exists, 3356 B — correct |

`frontend/components/` does not exist. Two kickoffs cite it; fix them or the builder creates a fork.

## A. Rank 7 — reasoning effort. **SIGNED — as an extension, not a fork.**

One field, widened. `thinking` stays the name; a second `effort` field is rejected (two fields =
ambiguity whenever both are set, and `safeBody` at `stream.ts:103` already has to hand-copy each one).

**Wire (`StreamBody`, `frontend/app/lib/stream.ts:48`; the field at `:64`; zod, `backend/src/controllers/agentStream.ts:129`):**
```
thinking?: boolean | 'low' | 'medium' | 'high' | 'xhigh'
```
zod: `z.union([z.boolean(), z.enum(THINKING_EFFORTS)]).optional()`.

**Frozen legacy aliases (this is the whole back-compat story):** `true ≡ 'medium'`, `false ≡ off`,
omitted ≡ server default. Every shipped client — `mobile/src/lib/stream.ts`, any stale static bundle —
keeps a 200. There is no deprecation window and none is needed.

**UI (`frontend/app/chat/page.tsx:52`):** `'auto' | 'on' | 'off'` becomes
`'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh'`; `'auto'` still maps to `undefined` at
`page.tsx:269-272` (`'medium'` → `true`, `'off'` → `false`, the rest passthrough).
`QueuedMessage.thinking` (`frontend/app/components/chat/types.ts:86`) takes the same
union, so a queued send keeps the effort it was captured with.

**Resolver — one function, one owner (`core-dev`), `backend/src/agent/thinking.ts`:**
`resolveThinking(v: ThinkingInput, family: ThinkingFamily) → ResolvedThinking`, plus the
`thinkingFamily(model)` classifier and `THINKING_EFFORTS` (`thinking.ts:24-58`). Signature as landed,
not as sketched: `ThinkingInput = boolean | ThinkingEffort | undefined` (`thinking.ts:29`).
Today there are exactly **three** knobs and no more — do not invent a fourth:
the prompt suffix (`agentRuntime.ts:226`), `enable_thinking` (`llmClient.ts:188-189`), `max_tokens`.

| input | suffix | `enable_thinking` sent | `cotCap` in system prompt |
|---|---|---|---|
| omitted / `'auto'` | env `QWEN_THINKING` decides | as today | — |
| `false` | `/no_think` | `false` | — |
| `'low'` / `'medium'` / `true` | `/think` | unset (provider default) | — |
| `'high'` | `/think` | `true` | 2 000 tok |
| `'xhigh'` | `/think` | `true` | 8 000 tok |

Named limit, stated up front so nobody calls it a bug: above `'high'` the only lever that exists is a
prompt-level cap, because no provider on our two live endpoints exposes a numeric reasoning budget.
`'xhigh'` ≠ `'high'` is therefore a **prompt** difference, not a transport one.

**Divergence this closed — CLOSED at `3a43db8`.** `QWEN_THINKING` now has exactly one reader in
`src/` (`thinking.ts:63`); both call sites resolve (`agentRuntime.ts:215`, `llmClient.ts:187`;
imports `:30` / `:18`) and neither reads env. The old half-working state — suffix honored per run while
`enable_thinking` came from the env — is gone.

**Seam + ordering.** `ui-visual` must not ship the selector before `core-dev`'s zod accepts the union:
a bool-only server 400s a string body. Land zod first (backend deployable alone, accepts both), then the
UI, then one `ops-release` redeploy of both — the static export and the API are one artifact.

## B. Rank 3 — at-capacity run that self-resumes. **Contract: two channels, one semantics.**

- **Before the first event:** `POST /api/agent/:id/stream` → `429` + `Retry-After: <seconds>` (the
  header the recon found zero hits for).
- **After the stream is open:** new in-band event `{ type: 'retry', attempt: n, afterMs: n }`,
  dispatched in `dispatch()` (`stream.ts:246`) → new handler `onRetry?: (attempt, afterMs) => void`
  on `StreamHandlers` (`stream.ts:25`; the member at `:37`).
- **The load-bearing rule:** a retryable 429 must **not** emit `error` while the run is still
  retryable. `error` is terminal in four places — `stream.ts:139` (`track`), `:144` (`onFinal`),
  `:145` (`onError`), `:146` (`onDone`), all setting `sawTerminal` (declared `:135`) — and the
  auto-resume path (`stream.ts:173-201`; comment at `:173`, gate at `:178`/`:181`) is skipped once
  `sawTerminal` is set. Emitting `error` for a
  429 kills the self-resume we already built. The run stays durable; the client reconnects with
  `after=<lastSeq>`; `onRetry` only drives the wait card copy.

## C. Rank 10 — file Library. **Read-through. Yes. No new table, no new column.**

`PrivateFile` (`backend/prisma/schema.prisma:687`) already is the file index: `userId`,
`conversationId?`, `purpose ('upload'|'artifact')`, `mimeType`, `@@index([userId, createdAt])`,
`deletedAt`. The Library is a **query**, not a schema change.

Citations need no index either, because the ids already join: `ArtifactRef.id === PrivateFile.id`
(`backend/src/services/privateFiles.ts:199-201`), and every assistant row already persists
`metadata.artifacts[]` (`backend/src/controllers/agentStream.ts:499`). Citation resolution is
`(fileId) → PrivateFile → conversationId → Message where metadata.artifacts[*].id = fileId`.

The **one** real gap is a route, not a table: `GET /api/files?purpose=artifact&cursor=&limit=`
(cursor on `createdAt`, owner-scoped, `deletedAt IS NULL`). Owner: `core-dev`, `backend/src/routes/files.ts`.
Filter by `mimeType` (a column) — `PrivateFile` has no `kind`, and the artifact `kind` is derived
from the extension at save time (`backend/src/agent/artifacts.ts:25-29`) and lives only in metadata.

## D. Rank 9 — browser live view. **Reuse `'html'`; do not add an enum member.**

`ArtifactRef.kind` is a **closed union** in `backend/src/agent/types.ts`
(`'image'|'video'|'pdf'|'docx'|'xlsx'|'pptx'|'csv'|'file'`); the frontend mirror types it as a bare
`kind: string` (`stream.ts:5`), so only the backend is a real enum — and it is the one to edit.
A new member is still a two-sided semantics change for one surface. `html` is already in `EXT_MIME`
(`artifacts.ts:21`) but **missing from `EXT_KIND` (`artifacts.ts:25-29`)** — so an `.html` artifact
silently degrades to `kind:'file'` today. Add `html: 'html'` to `EXT_KIND` and `'html'` to both
unions; the live-view frame then rides the existing `artifact` SSE event with `kind:'html'`. Browser
tool itself is `core-dev`'s, one file in `backend/src/agent/tools/`.

## E. Ownership — exactly one owner per file

| file | owner | change |
|---|---|---|
| `frontend/app/lib/stream.ts` | `ui-visual` | `StreamBody.thinking` union (`:64`); `safeBody` type `:103`; `onRetry` (`:37`) |
| `frontend/app/chat/page.tsx` | `ui-visual` | tri-state → union (`:52`, `:269-272`) |
| `frontend/app/components/chat/Composer.tsx` | `ui-visual` | toggle → selector (`:27-28`, `:72`, `:321-331`) |
| `frontend/app/components/chat/types.ts` | `ui-visual` | `QueuedMessage.thinking` (`:86`) |
| `frontend/app/components/chat/composer/EffortSelector.tsx` | `ui-visual` | **NEW** — the §A selector; imported by `Composer.tsx:12` and `chat/page.tsx:8` (`EffortValue`) |
| `frontend/app/components/chat/__tests__/Composer.test.tsx` | `ui-visual` | the one UI suite; `Composer.fixed.test.tsx` is a duplicate to fold in, never a sibling |
| `backend/src/agent/thinking.ts` | `core-dev` | **NEW** — the resolver, sole env reader |
| `backend/src/controllers/agentStream.ts` | `core-dev` | zod `:127`; 429/`retry`; pass resolved tier |
| `backend/src/agent/types.ts` | `core-dev` | `RunOptions.thinking` `:126`; `ArtifactRef.kind` |
| `backend/src/agent/agentRuntime.ts` | `core-dev` | `:214-217` → resolver |
| `backend/src/agent/llmClient.ts` | `core-dev` | `:180-184` → resolver (kills the env read) |
| `backend/src/agent/artifacts.ts` | `core-dev` | `EXT_KIND += html` |
| `backend/src/routes/files.ts` | `core-dev` | Library list route |
| tests for the resolver table | `qa-verify` | one case per (tier, family) row in §A |

Ranks 1, 2, 5, 6, 8 in `FRONTIER_RECON.md` §2 need no contract — `ui-visual` may start them now.

## F. The web/nginx served marker — **the last unmet acceptance line, and it crosses an owner seam.**

`GET /api/version` proves the API half only. The static half needs its own marker, and two owners touch
it: `core-dev` owns the `revision` value's semantics; `ops-release` owns `web/Dockerfile` +
`web/nginx.template.conf`. One path, one field name, or the probe compares two vocabularies.

**Path: `/version.json` at the web origin.** Confirmed against the config, not assumed: `location /`
(`web/nginx.template.conf:102`) is `try_files $uri $uri/ /index.html`, so a **real file** at
`/usr/share/nginx/html/version.json` is served; the dotfile rule `location ~ (^|/)\.` (`:39`) does
not match it (`/version.json` has no `.` at a path boundary); and nginx's `.json` → `application/json`
from `mime.types` means no `types{}` block. It must be a **build artifact**, written in the build
stage (`web/Dockerfile:20`, after `npm run build`) into `frontend/out/`, never at container start — a
runtime-written file can disagree with the bundle in the same layer.

**Shape (mirrors the API's field name exactly):**
```
{"surface":"web","revision":"<40-hex|unknown>","builtAt":"<ISO-8601Z>"}
```

**One nginx line, and it is not a `location`:** the `map` at `web/nginx.template.conf:2-6` defaults
to `no-cache`, so `/version.json` would revalidate while the API answers `no-store` — two different
cache semantics for the same acceptance field. Add one entry: `~^/version\.json$ "no-store";`. Do
**not** instead put `add_header Cache-Control no-store;` in a new `location` block: a location-level
`add_header` **replaces** the server-level set (`:22-30`), silently dropping `nosniff`, CSP,
`Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy` on that path. `map` keeps them.

**Revision source:** build arg, declared and exported the way the analytics keys already are
(`web/Dockerfile:10-15`). The candidate list is **`routes/version.ts:20-27` verbatim, order included** —
`GIT_REVISION`, `BUILD_REVISION`, `RAILWAY_GIT_COMMIT_SHA`, `GIT_SHA`, `SOURCE_VERSION`,
`HEROKU_SLUG_COMMIT` — first non-empty, trimmed; all empty → the literal `"unknown"`, never a guess —
same rule and the same token `core-dev` used in
`routes/version.ts`, so a probe can tell "same revision" from "both unknown".

*Order is part of the contract, not a detail.* The list is only a subset relation on values if the
precedence matches: two surfaces that each pick a **different** candidate from the same environment
report two different SHAs while both are individually "correct", and the equality assertion below goes
red for a build that is fine. The host can set several of these at once (Railway supplies
`RAILWAY_GIT_COMMIT_SHA` *and* the operator is told to set `GIT_REVISION` at `web/Dockerfile:13`),
which is exactly the collision case. `core-dev`'s precedence — explicit override
(`GIT_REVISION`/`BUILD_REVISION`) **first**, platform-provided value **last** — is the authoritative
one; the earlier revision of this section listed `RAILWAY_GIT_COMMIT_SHA` first and `HEROKU_SLUG_COMMIT`
not at all, and that subset-in-the-wrong-order is what the web producer was built against. The web side
mirrors the six-token list; the API side does not change.

The web producer, exactly (two edits in `web/Dockerfile`, owner `ops-release`):
```dockerfile
# after ARG GIT_REVISION="" (Dockerfile:15) — same order as routes/version.ts:20-27
ARG BUILD_REVISION=""
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG GIT_SHA=""
ARG SOURCE_VERSION=""
ARG HEROKU_SLUG_COMMIT=""
```
```dockerfile
# replaces Dockerfile:31 — argv order IS the precedence; first non-empty wins
RUN node -e "const fs=require('fs');const v=process.argv.slice(1).map(x=>(x||'').trim());const r=v.find(x=>x.length>0)||'unknown';fs.writeFileSync('out/version.json',JSON.stringify({surface:'web',revision:r,builtAt:new Date().toISOString()}))" "$GIT_REVISION" "$BUILD_REVISION" "$RAILWAY_GIT_COMMIT_SHA" "$GIT_SHA" "$SOURCE_VERSION" "$HEROKU_SLUG_COMMIT"
```
Nothing else changes: no new `location`, no `ENV`, and the value stays a build artifact. A service
variable alone cannot fix this — `GIT_REVISION` set at the web service is the **first** candidate in
both surfaces, which is correct but only by luck of the collision; the two-token diff is what makes
`§F:164` hold for every host, not just Railway.

### F.1 Ship ruling at `0d5d767` — accepted divergence, and the condition that keeps it true

What shipped at `web/Dockerfile:31` is the **one-token** producer, not the six-token block above:

```dockerfile
RUN node -e "...const r=(process.argv[1]||'').trim();fs.writeFileSync('out/version.json',JSON.stringify({surface:'web',revision:r||'unknown',builtAt:new Date().toISOString()}))" "$GIT_REVISION"
```
with the operator comment at `:13-14` naming `GIT_REVISION` and `${{RAILWAY_GIT_COMMIT_SHA}}`.

**Ruling: accept it for the P1 gate; the six-token mirror stays the contract and is a follow-up, not a
blocker.** It is sufficient on this host because §F:200 is an *equality between two surfaces*, not a
per-surface completeness claim: web resolves `GIT_REVISION`, and the API's candidate list
(`routes/version.ts:20-27`) puts `GIT_REVISION` **first** — so with the same value in both
environments the two read-backs agree and match `git rev-parse HEAD`. `web/Dockerfile:31` is also the
same artifact the comment at `:13-14` documents, so file and doc agree.

**The condition, stated so nobody breaks it silently:** the one-token producer is only correct while
exactly one candidate is set. `GIT_REVISION` at the web service (`${{RAILWAY_GIT_COMMIT_SHA}}`) and
`GIT_REVISION` **unset** at the backend service — the backend then falls through to
`RAILWAY_GIT_COMMIT_SHA`. Set `BUILD_REVISION`, `GIT_SHA`, `SOURCE_VERSION` or
`HEROKU_SLUG_COMMIT` at *either* service and precedence starts to disagree, which is the collision case
this section was written for; the mirror is what makes §F:164 hold under all of them. Divergence
between the surfaces can also come from a one-service deploy (web and API built from different
commits) — no candidate list fixes that, only a redeploy of both.

The stale anchors above this point in §F are left verbatim: they are the citation rev 3 was signed
against, and the builder may diff them.

**The probe, and the trap it must not fall into:** assert `Content-Type: application/json` and parse
`revision` — never the status code. The `:102` catch-all answers `200 text/html` for **any** path that
does not exist, so a status-only probe passes on a page that says nothing. (Same hazard the chunk check
already hit.)

**`/healthz` stays liveness-only.** It is `:32` and the container `HEALTHCHECK` (`web/Dockerfile:67`);
a revision stamped into it would make a rebuild look like a restart. Two facts, two endpoints.

Acceptance becomes: `revision` at `/api/version` == `revision` at `/version.json` == `git rev-parse HEAD`.
Until `/version.json` exists, "deployed" is unprovable on the web half no matter what the chunk diff says.

### F.2 Ruling at `ba68333` (arch-lead) — two corrections to the probe's expected value, and the fix's cheapest path

**1. `§F:240`'s third term is the trap; it must be a pinned SHA, not `HEAD`-at-probe-time.**
Measured this pass: `git rev-parse HEAD` → `ba68333fa3ae01882307f7448c3d39e42a9b370b` (ahead 1, unpushed),
while the served API revision read back `98f013c4ba49051df6a5ba595bd0eca4a5ef1c8c` and the served web
`revision` read `unknown`. The delta is `team/`-only — a **correct** deploy by a `HEAD`-term. So the gate
compares against the **commit the deploy was built from**, recorded at deploy time
(`git rev-parse HEAD` *at the moment of the push that triggered the build*), never a re-`rev-parse` at
probe time. A moving expected value re-opens exactly the hole `§I` closed (a cached 00:41Z body measured
against a 03:44 rebuild's headers). Third term, stated for the probe:

```
revision(/api/version) == revision(/version.json) == <SHA pinned at deploy>
```

with the `unknown`-collision guard of `§F:171-173` retained: two `unknown`s are equal but are not a pass
unless the operator has asserted the host sets no candidate.

**2. The "one env line, owner absent" framing understates the in-repo path.** The blocker is filed against a
Railway dashboard value nobody in this room owns; the contract's own text (`§F:190`) already declares
`ARG RAILWAY_GIT_COMMIT_SHA=""` and puts it **third** in the argv chain. Land that two-edit mirror and the
web surface resolves itself from the platform build arg — same chain, same precedence, same value as
`routes/version.ts:23`, no operator step. **The one assumption this rests on is unverified and named:**
that Railway exposes `RAILWAY_GIT_COMMIT_SHA` to the **web build** as a build arg (observed at *runtime*
on the backend only — `servedRevision` at process start). If it does not, the dashboard line is the
fallback and the mirror is still correct. Either path busts the layer: `$GIT_REVISION` sits inside the
`RUN` string at `web/Dockerfile:31`, so the sha is part of the cache key (`§12.3`, observed).

**Ownership unchanged, and the seam named:** `ops-release` owns `web/Dockerfile` (the mirror, two hunks);
`qa-verify` owns the probe and the assertion above. The seam is the field name and its precedence —
one vocabulary, `revision`, one candidate order, `routes/version.ts:20-27`. Neither file needs the other's
edit; only the token set is shared.
