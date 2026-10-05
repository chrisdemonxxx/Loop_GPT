# RESEARCH — model catalog: Claude's menu vs ours (live-verified)

Topic: Part A6 model menu of the merged /new UI schema. Owner: research-scout. Date: 2026-09-29.

## Claims (one per line, source beside, confidence stated)

- Claude's picker labels "Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 4.5" name REAL Anthropic models as of 2026-09: Fable 5.1 shipped 2026-09-01, Opus 5.5 2026-09-22 — primary: https://www.anthropic.com/claude-opus-5-5 , https://www.anthropic.com/claude-sonnet-5-5 . CONFIDENCE: high (vendor pages).
- Claude's "More models ▸" / "Effort ▸" are Claude-internal affordances; the external model IDs are `claude-fable-5-1`, `claude-opus-5` (secondary: myclaw.ai/blog/fable-5-1-vs-opus-5, checked 2026-09-02). CONFIDENCE: medium (secondary source; vendor API-ID list not probed — we hold no Anthropic key).
- OURS: `GET https://loop-gpt.cyou/api/models/catalog` → HTTP 200, 363 B, sha256 `4385e7bf890d6004b5409089e94f805961caed5b7e2abfde2d57b390f874845f`, stable across 3 calls, `Server: railway-hikari`, `x-powered-by: Express`. Raw probe (2026-09-29):
  ```
  curl -s -o c1.json -w "HTTP %{http_code} %{size_download}B" https://loop-gpt.cyou/api/models/catalog
  => HTTP 200 363B   body:
  {"models":[{"id":"loop-large","tier":"large","label":"Large Looper",
    "description":"The flagship. Sees images, reasons deeply, ...","contextTokens":262144},
   {"id":"loop-small","tier":"standard","label":"Small Looper",
    "description":"Fast and light. ...","contextTokens":32768}]}
  ```
  CONFIDENCE: high (live probe, 3x identical sha).
- Handler is `backend/src/routes/models.ts:8` → `res.json({ models: chatModelCatalog() })`; catalog built by `chatModelCatalog()` in `backend/src/services/chatModels.ts:246`, which returns ONLY `{id,tier,label,description,contextTokens}` per `availableChatModels()`. CONFIDENCE: high (filesystem).
- `frontend/app/components/ModelSelector.tsx:33` consumes exactly this route (`fetch(\`${API_URL}/api/models/catalog\`)` → `d.models`). So Hr Bot's §1 call is CORRECT: our picker is driven by our catalog, and it must render `loop-large` / `loop-small`, never Claude labels. CONFIDENCE: high.

## Parity delta (external ground truth → build delta)

- Frontier menu depth: Claude exposes ≥4 selectable models + an Effort submenu + "More models ▸". Our catalog exposes 2 (`loop-large`, `loop-small`) and `ModelSelector` has no Effort/More-models affordance (read to line 60; render is a flat list). GAP: the /new model menu cannot reach Claude's shape from the current catalog without new server entries.
- Schema A6 lists `Model: Sonnet 5.5 Medium (base-ui-_r_3o_)` as a control in the composer; the `Medium` suffix = the Effort axis, which we have no field for. Closing the UI without a backend `effort`/`models` extension produces a static dropdown, not parity.

## Probe-discipline note (Windows)

Native `curl` here does NOT translate MSYS `/tmp`: `-o /tmp/x.json` writes `C:\tmp\x.json` while MSYS `head`/`sha256sum` read MSYS `/tmp`. A stale file made an early probe look like `/api/models/catalog` returned unrelated lead data. Use RELATIVE paths after `cd`, or `$LOCALAPPDATA/Temp`, for probe output. (Re-confirmed clean: the relative-path probe above.)

## UNVERIFIED

- Whether Railway staging serves the same catalog bytes as production `loop-gpt.cyou` — not probed this pass (no staging host in hand).
