# CONTRACT — A6 catalog delta (owner: arch-lead, 2026-09-29)

Scope: the **A6 model/Effort** surface only. This is the seam between `core-dev` (server catalog) and
`ui-visual` (picker). It does **not** touch P5 (mobile web) — see `team/PHASES.md` §16.

**Ruling: A6 is backend-gated, not a picker rebuild.** The picker is already shaped for the third row;
the catalog is the gap. Registered as **GAP-029** in `docs/GAP_REGISTER.md` (P2 section, after
GAP-027).

## 1. The frozen wire contract (do not fork)

| piece | file:line | shape |
|---|---|---|
| route | `backend/src/routes/models.ts:8-10` | `GET /api/models/catalog` → `200 {"models":[…]}` |
| projection | `backend/src/services/chatModels.ts:247-254` | `{id, tier, label, description, contextTokens}` |
| rows | `backend/src/services/chatModels.ts:138-140` | `availableChatModels()` = `[CHAT_MODELS.large, CHAT_MODELS.standard]` |
| consumer | `frontend/app/components/ModelSelector.tsx:33-35` | reads `d.models` (fallback `[]`) |

**Allowed change: additive fields on the entries. The `{models:[…]}` envelope and the existing five
keys stay exactly as they are** — `ModelSelector.tsx:35` reads `.models`, `research-scout`'s parity
finding is recorded against this envelope, and `/v1/models` shares the same projection. Do not add
`aliases` to the public payload (the internal-only tier is deliberately unadvertised, `chatModels.ts:52`).

**The selectable value is `id`, not `tier`** — the picker calls `onChange(m.id)`
(`ModelSelector.tsx:70`) and `tierFor()` maps it (`chatModels.ts:151-161`). So the third row must be
emitted with `id: 'loop-vision'` and **never** with the bare string `'vision'` (shadowed to `large`
by the alias table). `tier` stays display metadata.

## 2. The seam — two owners, one feature

`core-dev` (server, first) → `ui-visual` (picker, after the catalog lands). `ui-visual` must not
write a client-side fake row: the picker's job is to render whatever `d.models` returns, plus the
**nesting** delta (Claude nests `Effort ▸` under the model menu; ours is a peer chip). One owner per
file: `ModelSelector.tsx` = `ui-visual`; `chatModels.ts` / `routes/models.ts` = `core-dev`.

## 3. Acceptance criteria for the catalog work — **guard CLOSED 2026-09-29 (`core-dev`)**

**Status: §3.1 and §3.2 are satisfied on disk, independently re-measured by me; the code is
UNCOMMITTED at HEAD `4f707bd` (`M backend/src/services/chatModels.ts`,
`M backend/src/services/__tests__/chatModels.test.ts`).** Shipped hashes: `chatModels.ts`
10,423 B / `dc792b04…`; test 3,755 B / `7f345706…`. Catalog depth is now the **only** gate on row 3.

### 3.1 CLOSED — `loop-vision` must not crash the request path before it becomes selectable

Original defect (raw run, since-deleted scratch probes): `resolveChatTarget('loop-vision')` **threw**
`Cannot read properties of undefined (reading 'replace')` with `HF_LARGE_ENDPOINT_URL` set and
`HF_VISION_ENDPOINT_URL` deleted — `resolveChatTarget()` took the vision branch (`:184`), which is
gated on `visionModelEnabled()`, itself true whenever the large endpoint is set (`:86-90`), then passed
the unset var into the unguarded `toV1()` (`:143-146`). Today nothing user-selectable reaches it
*because the row is never emitted*; emitting the row made it reachable.

Fix, in-seam and wire-neutral: `toV1(raw?: string | null)` = `(raw ?? '').replace(…)` (`:145-147`,
the house `(x || '')` pattern — this file was the tree's only `as string` + unguarded `.replace()`);
and unset `HF_VISION_ENDPOINT_URL` now falls through to **`large`**, the documented intent of
`visionModelEnabled()` (`:182-184`) — not to `standard`, and not a throw.

My independent re-measure, three env shapes, real module (scratch probe since deleted):

```
### shape 1: large set, vision DELETED
tierFor(loop-vision) = vision
target(loop-vision)  = {"tier":"large","model":"big-model","baseUrl":"https://large.invalid/v1",…}
resolveVisionTarget() = big-model @ https://large.invalid/v1
### shape 2: both set
target(loop-vision)  = {"tier":"vision","model":"vlm-model","baseUrl":"https://vlm.invalid/v1",…}
resolveVisionTarget() = vlm-model @ https://vlm.invalid/v1
### shape 3: VLM only (large deleted)
resolveVisionTarget() = vlm-model @ https://vlm.invalid/v1
npx vitest run src/services/__tests__/chatModels.test.ts → Test Files 1 passed (1) / Tests 8 passed (8)
```

### 3.2 CLOSED — a configured VLM endpoint was unreachable (found by `core-dev`, same seam)

`resolveVisionTarget()` passed the **string literal** `'vision'` to `resolveChatTarget()`, and
`'vision'` is shadowed to `large` by `CHAT_MODELS.large.aliases` (`:70`, first-match scan
`:151-161`) — while `CHAT_MODELS.vision`'s own id is `loop-vision`. Measured pre-fix: both
endpoints set → `big-model`; VLM-only → `std-model`; i.e. a configured dedicated VLM was **never
used on the live image path** (`agentStream.ts:247-248` overwrites the target with the vision target on
every image turn). Fix: resolve by canonical id, `CHAT_MODELS.vision.id` (`:221`), and guard on
endpoint presence (`:220`) — shape 2/3 above now return the VLM. 

**`tierFor('vision') === 'large'` is left unchanged on purpose** (pinned at
`chatModels.test.ts:22`). **Rule for this seam: pass ids, never alias strings** — a new alias must be
checked against the whole `CHAT_MODELS` table, since the scan returns on the first match.
### 3.3 OPEN (by design) — the `vision` badge stays
The badge at `ModelSelector.tsx:84` (`m.tier === 'vision'`) is a **dead branch today** (live tiers:
`large`, `standard`) and must stay un-deleted until row 3 ships — it is the already-built render for
the new row.

## 4. Live evidence (re-check, don't trust)

```
curl -s https://loop-gpt.cyou/api/models/catalog  →  200  363 B  sha256 4385e7bf890d600…   (×3 identical)
body: {"models":[{"id":"loop-large","tier":"large","label":"Large Looper",…262144},
                 {"id":"loop-small","tier":"standard","label":"Small Looper",…32768}]}
```

Reproduces `research-scout`'s probe and `boss-bot`'s re-run exactly — no divergence.

**Probe gotcha (cost me a false alarm, hence written down):** under git-bash, native `curl -o
/tmp/x.json` does **not** write MSYS `/tmp` (path conversion is off), so a later `head`/`sha256sum
/tmp/x.json` reads a **stale file from a previous session**. It served a 178 KB body from another lane.
Write probe output to `$LOCALAPPDATA/Temp/…` and hash the file you just wrote.

## 5. Not in scope here

Claude's `Fable 5.1 / Opus 5.5 / Sonnet 5.5` are Anthropic's labels; ours come from the server
catalog, so the schema's model names are cosmetic. Phase/board bookkeeping stays in `team/PHASES.md`.
