# Live generation acceptance — 03r

Date: 2026-09-18 evening. Continuation of `railway-live-candidate-03q.md`: the
isolated candidate gained working hosted models, metered embeddings and proven
fail-closed fences. Still **not** a production cutover; the fresh database ended
the night with zero users.

## Fixes shipped

1. **`/v1/*` never reached the backend** — the web nginx template only proxied
   `^/api`, so the SPA catch-all answered `/v1/models` with `index.html`
   (a 200 that was secretly HTML) and `POST /v1/chat/completions` with 405.
   Fix: mirrored `/api` proxy block for `^~ /v1/` (same fixed validated target,
   SSE-friendly, reuses only the already-exported `${API_*}` substitutions).
   Commit `94a58f3` on `release/owned-staging-20260917`; web rollout `5f8cc264`
   (SUCCESS), bonus backend rebuild `26d91207` (SUCCESS, harmless).

2. **`HF_TOKEN` never landed** — five-variable wiring reported success, but the
   runtime disagreed: `modelCredential(undefined)` → `ModelTransportError` → 502.
   Diagnosis trail: direct undici probes (200, 2.6 s, `finish_reason: stop`),
   the guarded chain reproduced locally from `dist/` (200, 2.1 s — guard,
   node-fetch, SDK, DNS logic all exonerated), SSH ground truth (the endpoint
   resolves to three legitimately public addresses, `100.57.210.164` included —
   it sits below the 100.64/10 CGNAT fence), then the confession:
   `railway variable list` showed `HF_ENDPOINT_URL`, `HF_MODEL`,
   `HF_LARGE_ENDPOINT_URL`, `HF_LARGE_MODEL` present and `HF_TOKEN` absent.
   Fix: one honest `variable set` without `--skip-deploys` → rollout `f4c0db8c`
   (SUCCESS). Earlier rollouts: `ded879d8` (router URLs + token attempt),
   `69f3415c` (dedicated endpoint URLs + model names).

## Wiring

| Variable | Value class |
| --- | --- |
| `HF_TOKEN` | dedicated-endpoints bearer (set once, printed once inoperatively) |
| `HF_ENDPOINT_URL` | `https://y54ycbowmtsfq58i.us-east-1.aws.endpoints.huggingface.cloud` |
| `HF_MODEL` | `Qwen3.8-27B-Uncensored-Cyber` (discovered via `/v1/models`, not guessed) |
| `HF_LARGE_ENDPOINT_URL` | `https://xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud` |
| `HF_LARGE_MODEL` | `s-zaizen/DeepSeek-V4.1-Flash-Abliterated` |

Embeddings needed **no** wiring: the coded default
(`sentence-transformers/all-MiniLM-L6-v2` via the shared router's
`pipeline/feature-extraction` + `HF_TOKEN`) worked as designed.

## Results (all through the public HTTPS origin, one developer key)

| Surface | Result | Ledger |
| --- | --- | --- |
| `loop-chat` (standard) | 200, `"WIRED"`, 237/18 tokens | +0.00051 |
| `loop-chat-large` | 200, `"LARGE-WIRED"`, 206/23 tokens | +0.00069 — tier-differentiated pricing verified |
| `/v1/embeddings` | 200, 384-dim (parity with direct router probe), 13 estimated tokens (11 bytes + 2 special — the documented estimator, exactly) | +0.00002 |
| `/v1/images/generations` | 503 `not_configured` — fail-closed, honest | — |
| `/v1/videos/generations` | 503 `video_accounting_unavailable` — fail-closed, honest | — |

Ledger trajectory: preview grant 1.0 → 0.998803 USD; `requests` counted 6
including three failed-then-refunded reserve cycles (honest accounting: failures
consume nothing, successful capture alone bills).

## Cleanup

One canary user (`railway-gen-…@example.invalid`) + its key, workspace, 6
reservations, 6 usage rows and settlement intents removed via SSH. Foreign-key
ordinance respected: `ApiSettlementIntent` → `ApiUsage` → `ApiReservation` →
`User` (the 03q canaries were freeloaders; this one actually paid, so
`Restrict` relations demanded ordered deletion). Final state:
`totalUsersInFreshDb: 0`.

## Owner provisioned

The first resident: `owner@loop-gpt.cyou` (real domain; password printed once,
flagged for rotation), registered through the public origin, then promoted to
`admin` by direct database update — registration always creates `role: user`
and no promotion CLI exists yet. Verified through the public origin: fresh
login, `/api/account/me` → `role: admin`, `/api/admin/stats` → 200 with
`{total: 1, admins: 1, free: 1, new24h: 1}`, anonymous → 401. Final
population: one user, one admin, zero guests. Starter grant: 30 account
credits. Owner id: `cmu7f33j800008ssokymbyyd1`.

## Honest residuals

- Both model tiers are text-only; the product's `*-vl-*` vision naming outruns
  reality until a VL checkpoint occupies one of the dedicated endpoints.
- Images/video need provisioned endpoints (and, for video, the accounted-flags
  rollout) before they can graduate from honest 503s.
- Embeddings ride the shared router (shared capacity, no dedicated GPU).
- One diagnostic rabbit hole remains unfenced: `variable set … | Out-Null`
  reported success for a variable that did not persist; the first wire's
  exit-0 theatre cost forty minutes. Future wiring should verify with
  `variable list` (names) rather than trusting silenced exit codes.
- Still not a cutover: old production domains/data untouched; owner
  provisioning, real-invitation flows, backups/restore and the rest of
  `../PRODUCTION_CHECKLIST.md` remain.

Temporary operator tooling (outside the repository):
`loop-live-gen2.mjs`, `loop-live-large.mjs`, `hf-embed.mjs`, `loop-fenced.mjs`,
`hf-direct.mjs`, `hf-direct2.mjs`, `llm-repro.cjs`, `wire-hf*.ps1`,
`railway-*-logs*.json` in `C:/Users/chris/AppData/Local/Temp/opencode/`.
