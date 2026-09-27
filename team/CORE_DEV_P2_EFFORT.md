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
  unauthenticated, mounted at `server.ts:98` **before** the generic `/api` rate limiter so a deploy
  probe can never be throttled into a false 429.
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

## 4. Not in this commit

`GET /api/files?purpose=artifact&cursor=` (§C, rank 10) is still absent — route only, no schema, and
it needs `PrivateFile` reads I'd rather land as one reviewed piece with its integration test. Migration
count for §A/§D: **0** (no `schema.prisma` diff — `git diff --stat backend/prisma` → empty).
