# P6 prerequisite — vision routing: the unguarded `toV1()` (measured, fixed, tested)

`core-dev`, branch `release/owned-staging-20260917`, HEAD `4f707bd` + this diff (uncommitted, backend only).

## Repro of @arch-lead's report — confirmed, plus a second defect nobody had named

Probe: `backend/scratch_vision_guard.ts` (tsx, deleted after the run) driving the real module
`backend/src/services/chatModels.ts`. `HF_VISION_ENDPOINT_URL` **truly unset** (`env -u`; note
`X=` in bash is the empty string, and `toV1('')` returns `'/v1'` — it does *not* throw).

BEFORE, config = production shape (`backend/.env` has `HF_LARGE_*`, no `HF_VISION_*`):

```
tierFor('loop-vision') = "vision"
tierFor('vision')      = "large"
resolveChatTarget('loop-vision') THREW: Cannot read properties of undefined (reading 'replace')
resolveChatTarget('vision')      = {"tier":"large","model":"big-model","baseUrl":"https://example.invalid/large/v1"}
```
raw: `$LOCALAPPDATA/Temp/visionA2.txt`, sha256 `abf01d71d40bfcec2952909ba0575013d12a2d67d13f93748af55c5e50a4646f`.

**Second defect (new):** with a dedicated VLM endpoint configured, it is never used —
`resolveVisionTarget` called `resolveChatTarget('vision')`, and `'vision'` is shadowed to the
`large` tier by `CHAT_MODELS.large.aliases` (`chatModels.ts:70`, first-match alias scan at `:158-161`).

```
BEFORE, both endpoints set:      resolveVisionTarget -> {"model":"big-model",  baseUrl":".../large/v1"}   (VLM ignored)
BEFORE, VLM endpoint only:       resolveVisionTarget -> {"model":"std-model",  baseUrl":".../std/v1"}     (VLM ignored)
```
This is the live image-attachment path: `controllers/agentStream.ts:247` → `:248` overwrites the
chat target with the vision target for every turn that carries an image.

## Fix (one seam, `chatModels.ts`)

1. `toV1(raw?: string | null)` — tolerates a missing value; the house pattern in every sibling site
   is `(x || '')` (`v1.ts:589`, `billing.ts:15`, `auth.ts:50`, `webSearch.ts:108`). `chatModels.ts`
   was the only file using `as string` + an unguarded `.replace()`.
2. `resolveChatTarget`: an unset `HF_VISION_ENDPOINT_URL` now falls through to the **large** tier
   (the documented intent in `visionModelEnabled()`), not to `standard` and not to a throw.
3. `resolveVisionTarget`: resolves the canonical id (`CHAT_MODELS.vision.id`), not the shadowed
   string; guards on endpoint presence only (the model name already defaults, `:198`).
   `tierFor('vision') === 'large'` is deliberately **unchanged** — it is pinned public behaviour
   (`chatModels.test.ts:22`).

AFTER (same probe, same three configs): prod shape → large target, no throw; both set → `vlm`/`vision`
endpoint; VLM-only → `vlm`/`vision` endpoint.

## Evidence

- RED→GREEN: `git stash push -- src/services/chatModels.ts` → `npx vitest run src/services/__tests__/chatModels.test.ts`
  = **3 failed | 5 passed (8)** on HEAD; with the fix = **8 passed (8)**.
- `npm run build` → exit 0 (tsc clean).
- `npm run lint` → exit 0, 0 errors, 31 pre-existing warnings.
- `npm test` → 64/65 files, 1184 passed, 8 failed — **all 8 in
  `src/agent/__tests__/generateMediaTransport.test.ts` (video provider migration), and the same
  8 fail on HEAD with my files stashed** (`28 tests | 8 failed`). Pre-existing, unrelated
  (no `chatModels` import in that file), **not fixed here** — flagged for the owner.

`backend/src/services/chatModels.ts` 10423 B sha256 `dc792b04…` ·
`backend/src/services/__tests__/chatModels.test.ts` 3755 B sha256 `7f345706…`
(`git diff --stat -- backend/` = 2 files, +93/-9).
