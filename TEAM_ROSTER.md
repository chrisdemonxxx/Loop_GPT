# Loop GPT — TEAM ROSTER (owner: hr-bot)

Snapshot: 2026-09-27 (updated; first issued 2026-09-26). HEAD `d110e56`, branch
`release/owned-staging-20260917`, working tree clean. Project:
`C:\Users\chris\Desktop\Workspace\dev-projects\loop-gpt` (live https://loop-gpt.cyou).
Durable channel for this fleet: `team/` in the project root.

---

## 1. Model inventory — LIVE PROBES (not assumptions)

Every candidate was probed twice: (a) a liveness call, (b) a **tool-calling** call
(a chat-capable model that rejects tools cannot be a worker). Raw results:

| Provider (`config.yaml` key) | Model | (a) liveness | (b) tools | Verdict |
|---|---|---|---|---|
| `hf-dsv41` | `s-zaizen/DeepSeek-V4.1-Flash-Abliterated` | `200` 1.0s | `TOOLS_OK ping({"x":"1"})` | **LIVE — flagship** |
| `qwen3-cyber` | `Qwen3.8-27B-Uncensored-Cyber` | `200` 1.3s | `TOOLS_OK ping({"x":"1"})` | **LIVE — fast tier** |
| `glm52-abliterated` | `zai-org/GLM-5.2` (HF router) | `402` | `402` | **REJECTED — router credits depleted** |
| `lunaris-abliterated` | `Sao10K/L3-8B-Lunaris-v1` (router) | `402` | `402` | **REJECTED — same account credit wall** |
| `glm53-cyber-big` / `glm53-abliterated-big` | `/repository` @ `gaxe6hi6mcx4mtn6…` | `404` | `404` | **REJECTED — endpoint gone (`Not Found: gaxe6hi6mcx4mtn6…`)** |
| `glm53-flash` | `/repository` @ `http://127.0.0.1:8611/v1` | `400 model '/repository' does not exist` | `400` | **REJECTED — stale local router proxy** |
| `foundry-gpt6astra` | `gpt-6-astra-1` (Azure) | `401` | `401` | **REJECTED — invalid subscription key** |

Also probed and rejected: every HF-router model behind the `8611` proxy (`Qwen/Qwen3.8-27B`,
`deepseek-ai/DeepSeek-V4.1-Flash`, `zai-org/GLM-5.3`, `moonshotai/Kimi-K3`,
`openai/gpt-oss-120b`) → all `402 depleted your monthly included credits`.

**Re-probe 2026-09-27 (hr-bot, raw, `curl` against each endpoint's `/v1/chat/completions`)** — both
live seats re-verified with a liveness call and a `tools` call:
- `hf-dsv41` → liveness `HTTP=200 1.089s`; tools `HTTP=200 1.297s`, response carries
  `"tool_calls":[{"id":"chatcmpl-tool-81d199048f2a0488","type":"function"…`.
- `qwen3-cyber` → **first 4 probes `503 SERVICE_UNAVAILABLE` (`0.69–0.76s`), 5th `200 1.069s`,
  then 4 consecutive `200`s.** Warm: liveness `HTTP=200 0.968s`, tools `HTTP=200 1.739s` with
  `"tool_calls"` present.
Both are live and can call tools. Dead group unchanged (`402` router, `401` Azure, `404` `/repository`).

**New finding — `qwen3-cyber` is a scale-to-zero endpoint with a `503` cold-start window** (≥60s of
consecutive `503`s observed at 21:22Z before the first `200`; `GET /v1/models` `503`s the same way).
**Five seats are pinned primary to it** (`ui-visual`, `qa-verify`, `code-review`, `mobile-dev`,
`perf-eng`), so a seat's *first* call after idle can fail with `503`. Each of the five already lists
`hf-dsv41` as fallback; the roster keeps that ordering deliberately, but any bot that sees a `503`
should retry once before reporting a dead endpoint.

**Defect found and fixed (this pass):** `hr-bot`'s own `config.yaml` declared the `qwen3-cyber`
fallback provider (`model.fallback`) but had **no `providers.qwen3-cyber` block** — its failover would
have resolved to nothing. Block added from the fleet-identical definition (mirrors `boss-bot`'s); `yaml`
parses with `providers: ['hf-dsv41', 'qwen3-cyber']`, backup at `config.yaml.bak.pre-qwen-block-*`.

**Consequence: the fleet has exactly two live worker models.** The router-based provider group
(`glm52-abliterated`, `lunaris-abliterated`, `stheno-abliterated`, `glm53-flash`) and the Azure
foundry are dead until the operator restores credits / rotates the key.

**Defect found and fixed:** `arch-lead`, `boss-bot` and `research-scout` were all pinned to
`glm52-abliterated` — i.e. **three of eight seats were pointed at a `402` endpoint**. All three are
repinned to `hf-dsv41` with `qwen3-cyber` as fallback.

---

## 2. Roster

| Bot | Role | Provider / model | Rationale |
|---|---|---|---|
| `boss-bot` | **Orchestrator** | `hf-dsv41` · DeepSeek-V4.1-Flash | Long-horizon planning + filesystem verification; the one seat that must never be down. |
| `arch-lead` | Architecture / Lead | `hf-dsv41` · DeepSeek-V4.1-Flash | Contracts and schema reasoning; flagship tier. |
| `core-dev` | Core Implementation | `hf-dsv41` · DeepSeek-V4.1-Flash | High-throughput coding on `backend/`; strongest coding tier available. |
| `ui-visual` | Visual / UI | `qwen3-cyber` · Qwen3.8-27B | Fast, vision-capable; rapid UI iteration without queueing behind backend work. |
| `qa-verify` | Independent QA (dynamic) | `qwen3-cyber` · Qwen3.8-27B | Fast reasoning/QA tier; runs the browser gates. **Moved off `hf-dsv41`** to keep the flagship endpoint free for heavy implementation. |
| `code-review` | Static review | `qwen3-cyber` · Qwen3.8-27B | **Model diversity by design** — an independent reviewer on a different model than the builder catches what the builder's model would rationalise. |
| `research-scout` | External ground truth | `hf-dsv41` (fallback `qwen3-cyber`) | Cited-source verification + frontier-product recon; needs the deeper reasoning tier. |
| **`mobile-dev`** *(new)* | Mobile (Expo/RN) | `qwen3-cyber` · Qwen3.8-27B | Pairs with `ui-visual` for screen parity; no existing seat owned `mobile/`. |
| **`ops-release`** *(new)* | Release & Ops | `hf-dsv41` · DeepSeek-V4.1-Flash | The release/integration seat. Now *real*, not latent: the project deploys repeatedly, runs 25 migrations, and is aiming at a paying audience. |
| **`perf-eng`** *(new)* | Performance | `qwen3-cyber` · Qwen3.8-27B | The user's "fast and snappy" had **no owner**. Measurement + budget work, separate from correctness QA. |
| `hr-bot` | Roster owner | `hf-dsv41` | This document, the probes, the hires. |

**Roster completeness check** (per the bootstrap framework): contract → `arch-lead`; implementation →
`core-dev` / `ui-visual`; dynamic test → `qa-verify`; static review → `code-review`; external ground
truth → `research-scout`; release/integration → `ops-release` (now real); mobile → `mobile-dev`;
performance → `perf-eng`. Docs seat remains **latent** (fold into `ops-release` until the product gains a
non-builder user).

---

## 3. Team defect found while tracking this project

Every SOUL.md in the fleet described a **previous project** ("the Number Guessing Game") — `core-dev`
and `ui-visual` were still told their deliverable was `index.html` for a guessing game. All 11 SOUL.md
files have been rewritten against the real project (repo map, `docs/PROGRESS.md` as shipped-truth,
`AUDIT_REPORT.md` as the gap list, evidence rules, `team/` channel).

---

## 4. Current state of the project (filesystem-verified, not self-reported)

**Committed and shipped** (per `docs/PROGRESS.md`, HEAD `d110e56`, tree clean): audit §10 questions
resolved; P0 blockers executed (Resend key swap + `MAIL_FROM`; Postgres image swap to
`postgres-ssl:16`; Sentry + PostHog vars set; `ADMIN_INVITE_CODE` set; landing copy fix); Phase 4
architecture cleanup (`chat/page.tsx` 755→440, `MessageList` 593→142, `Composer` 432→252, backend
`routes/agent.ts` 788→389, backend ESLint added); Phase 2 UI rebuild items 2.1–2.7; Phase 3 groups;
nice-to-haves §8-35 theme switcher, §8-39 per-message queue, §8-47 doc hygiene; the cross-tenant
tool-audit-log leak.

**The four UI items this roster last listed as "in flight" are committed** — `7540a3d`
(`14 files, +836/−42`): §8-40 connector chip, §8-44 hands-free voice mode, §8-45 server TTS +
`Appearance` tab. Follow-up `d110e56` then **fixed the TTS upstream** (HF Inference Providers dropped
TTS platform-wide → Kokoro Space over `/gradio_api/call`; verified end-to-end before wiring, 156 KB
RIFF/WAV; 7 route tests). The two-writers seam in §5 below is closed: the tree is clean.

**Gates measured on HEAD this pass (hr-bot):** `frontend` `npm run build` → `BUILD_EXIT=0`, 19
routes; `webpack-bfdd25fdbe871018.js`.

**Open, by owner** — the work this roster exists to close:

| Item | Owner | Source |
|---|---|---|
| **The live host does not serve a build of HEAD** — re-measured 2026-09-27: 18 served chunk names vs 114 built, **8 served names absent**; `webpack-12ed1796ffdc89d3.js` served vs `webpack-bfdd25fdbe871018.js` built; `app/chat/page-b2100450a5471ec3.js` served (216,192 B, sha256 `f1598704…`) vs `app/chat/page-1a4368a0163b6661.js` built (sha256 `e22c39c6…`). The served chat chunk *does* carry the `d110e56` frontend markers (`Kokoro` ×1, `serverVoice` ×1) — live is *near* HEAD, not equal. Ship + prove by served-vs-built set-diff equal. | `ops-release` | `team/P1_FINDINGS.md` F1, re-probed |
| `GET /api/version` (F2: `404` on both origins, no served-revision read-back; `/healthz` is a static nginx string, `/health` falls through to the web `index.html`) | `core-dev` → `ops-release` (vhost) | F2 |
| One real authed `POST /api/tts` returning audio bytes + `Content-Type` + byte count (F3) | `core-dev` + `qa-verify` | F3 |
| GAP-003 a11y contrast sweep (axe serious-level on the dark theme) | `qa-verify` | `GAP_REGISTER.md`, `AUDIT_REPORT.md` §6 P6 |
| §8-41 / GAP-070 mobile parity; §8-43 / GAP-049 native signing | `mobile-dev` | `AUDIT_REPORT.md` §8-41/43 |
| DB restore rehearsal (needs `DATABASE_URL`); Stripe go-live or an explicit free-only freeze; marketplace OAuth live smoke (Figma first); observability confirmation with a deliberate test error; uptime probe on `/healthz` | `ops-release` | `docs/PROGRESS.md` "Still open", `AUDIT_REPORT.md` §6 P8/P9/P10/P11 |
| Latency + bundle budgets ("fast and snappy") | `perf-eng` | user directive; no prior owner |
| Frontier-parity pattern recon (what Claude/ChatGPT/Grok do that §8 still lists as missing) | `research-scout` | `AUDIT_REPORT.md` §8 |
| Static review of each shipped phase's bytes | `code-review` | roster convention |

---

## 5. Files an owner must not lose

`frontend/app/chat/hooks.ts` and `frontend/app/components/chat/Composer.tsx` each had **two writers**
while §8-40 and §8-44 were open. That work is committed (`7540a3d`) and the tree is clean, so the seam
is closed for now — but the rule stands: `hooks.ts` has a single owner, `ui-visual`, and `core-dev`
hands changes over rather than editing in place. This is the exact seam where the fleet clobbered a file
in a previous run.
