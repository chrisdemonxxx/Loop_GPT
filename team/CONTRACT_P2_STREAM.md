# team/CONTRACT_P2_STREAM.md — arch-lead signature for P2

**Owner: `arch-lead`.** Signed 2026-09-27. Basis: read of the code at `59b0e08`, not of any summary.
Covers `FRONTIER_RECON.md` §2 ranks 3, 7, 9, 10 — the four it marks "**Contract** needed".
Everything below is a decision; the implementer does not get to re-open it, only to implement it.

## 0. Path correction (cite these, not the ones in older kickoffs)

| contract doc says | on disk | 
|---|---|
| `frontend/components/chat/types.ts` | **`frontend/app/components/chat/types.ts`** — `LiveStep:27`, `QueuedMessage:67` |
| `frontend/app/lib/stream.ts` | `frontend/app/lib/stream.ts` (287 L) — correct |
| `backend/src/agent/runAuthorization.ts` | exists, 3356 B — correct |

`frontend/components/` does not exist. Two kickoffs cite it; fix them or the builder creates a fork.

## A. Rank 7 — reasoning effort. **SIGNED — as an extension, not a fork.**

One field, widened. `thinking` stays the name; a second `effort` field is rejected (two fields =
ambiguity whenever both are set, and `safeBody` at `stream.ts:98` already has to hand-copy each one).

**Wire (`StreamBody`, `frontend/app/lib/stream.ts:59`; zod, `backend/src/controllers/agentStream.ts:129`):**
```
thinking?: boolean | 'low' | 'medium' | 'high' | 'xhigh'
```
zod: `z.union([z.boolean(), z.enum(THINKING_EFFORTS)]).optional()`.

**Frozen legacy aliases (this is the whole back-compat story):** `true ≡ 'medium'`, `false ≡ off`,
omitted ≡ server default. Every shipped client — `mobile/src/lib/stream.ts`, any stale static bundle —
keeps a 200. There is no deprecation window and none is needed.

**UI (`frontend/app/chat/page.tsx:49`):** `'auto' | 'on' | 'off'` becomes
`'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh'`; `'auto'` still maps to `undefined` at
`page.tsx:263`. `QueuedMessage.thinking` (`frontend/app/components/chat/types.ts:84`) takes the same
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
  dispatched in `dispatch()` (`stream.ts:241`) → new handler `onRetry?: (attempt, afterMs) => void`
  on `StreamHandlers` (`stream.ts:25`).
- **The load-bearing rule:** a retryable 429 must **not** emit `error` while the run is still
  retryable. `error` is terminal in three places — `stream.ts:134`, `:140`, `:156-162` — and the
 auto-resume path (`stream.ts:170-196`; comment at `:168`) is gated on "no terminal event".
 Emitting `error` for a
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
| `frontend/app/lib/stream.ts` | `ui-visual` | `StreamBody.thinking` union; `safeBody` type `:98`; `onRetry` |
| `frontend/app/chat/page.tsx` | `ui-visual` | tri-state → union (`:49`, `:263`) |
| `frontend/app/components/chat/Composer.tsx` | `ui-visual` | toggle → selector (`:27-28`, `:72`, `:321-331`) |
| `frontend/app/components/chat/types.ts` | `ui-visual` | `QueuedMessage.thinking` (`:84`) |
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
(`web/Dockerfile:10-15`). `RAILWAY_GIT_COMMIT_SHA`, then `GIT_SHA`/`SOURCE_VERSION`/`GIT_REVISION`;
empty → the literal `"unknown"`, never a guess — same rule and the same token `core-dev` used in
`routes/version.ts`, so a probe can tell "same revision" from "both unknown".

**The probe, and the trap it must not fall into:** assert `Content-Type: application/json` and parse
`revision` — never the status code. The `:102` catch-all answers `200 text/html` for **any** path that
does not exist, so a status-only probe passes on a page that says nothing. (Same hazard the chunk check
already hit.)

**`/healthz` stays liveness-only.** It is `:32` and the container `HEALTHCHECK` (`web/Dockerfile:67`);
a revision stamped into it would make a rebuild look like a restart. Two facts, two endpoints.

Acceptance becomes: `revision` at `/api/version` == `revision` at `/version.json` == `git rev-parse HEAD`.
Until `/version.json` exists, "deployed" is unprovable on the web half no matter what the chunk diff says.
