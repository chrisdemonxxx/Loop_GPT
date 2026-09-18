# Production-readiness audit — 03s

Date: 2026-09-18. Scope: the owned staging candidate
(https://web-production-20d369.up.railway.app), against the plan's claims.
Method: independent re-verification from outside (public origin), the changed
artifacts rebuilt and re-smoked locally, and the previously untested paths
exercised for real. Still **not** a production cutover.

## What was untested and is now verified

| Surface | Evidence |
| --- | --- |
| Core chat (SSE) | `POST /api/agent/new/stream` → 200 `text/event-stream`; streamed `"\n\nPONG"`, `done`, conversation created, 2 messages persisted (user+assistant), assistant text identical to stream; daily usage moved 10→20 in, 2→4 out, 1→2 messages. Event vocabulary (`delta.text`, `final.content`, `done`) confirmed from `agent/types.ts` — the first harness guessed wrong names; the pipeline itself was correct. |
| App/API surface | 22/22 probes ok, 0 flagged: developer overview/pricing/plans, agent tools/completions (400 on empty body = honest validation), account usage/redeem (400 on bad code), models catalog, settings providers, billing config, `/v1/pricing`, all five admin routes, workspace members/audit/connections/catalog. |
| Browser UI chat | Real Chromium, owner login → select workspace → "New conversation" → type → send → streamed answer rendered (`BANANA` present), 0 page errors; screenshot captured mid-stream ("Generating response…", Stop button). |
| Local packaging smoke | Rebuilt and re-run after the nginx `/v1` change: all groups PASS, including the new assertions **"`/v1` forwarding, early SSE frames (`/api` and `/v1`)"**, plus 11 focused regressions and verified cleanup. |
| Admin promotion CLI | New `backend/scripts/promote-admin.mjs` verified on a disposable database: user→admin (adminsTotal 1), idempotent re-run, missing user → exit 3, missing `DATABASE_URL` → exit 2. |

## Fixes/artifacts in this slice

- `deploy/owned-staging/smoke.mjs` + `proxy-fixture.mjs`: the changed nginx
  template is now locally covered (`/v1` path/auth/body forwarding and `/v1`
  SSE first-frame latency).
- `backend/scripts/promote-admin.mjs`: closes the "no promotion CLI" gap noted
  in 03r; registration still always creates `role: user`, promotion is an
  explicit operator action.
- Owner resident state unchanged (1 user, 1 admin) — the script's live use is
  documented, and it was verified against a disposable database, not the
  resident database.

## Still genuinely missing (provisioning/native, not wiring)

- **Image generation** needs a provisioned image endpoint (`HF_IMAGE_ENDPOINT_URL`);
  currently an honest `503 not_configured`.
- **Video** needs a provisioned endpoint and the accounted-flags rollout; currently
  an honest `503 video_accounting_unavailable`.
- **Embeddings** ride the shared router (shared capacity; no dedicated GPU).
- **Vision-tier naming** (`*-vl-*`) outruns the text-only checkpoints; a VL model
  must occupy an endpoint before the branding is literal.
- **Native Store/Direct editions**, broader connectors, packaged MCP, reusable
  agents/memories, sandbox execution and general durable tasks remain as listed in
  `../PRODUCTION_CHECKLIST.md`.
- **Cutover prerequisites**: production data migration/baselining, backups/restore
  rehearsal, TLS/DNS acceptance on the real domains, and rotating the
  historically exposed credentials.

## Verdict

Within staging scope, every built surface that can be exercised without new
provisioning is now verified: both chat tiers, embeddings, the product's own SSE
chat and browser flow, private files, workspaces, developer API, admin gates, and
fail-closed fences — with metered ledger evidence. The remaining work is
provisioning (GPU endpoints) and the native/cutover milestones, not hidden
breakage.
