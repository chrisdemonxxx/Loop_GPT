# Loop GPT — TEAM ROSTER (owner: hr-bot)

Snapshot: 2026-09-26. Project: `C:\Users\chris\Desktop\Workspace\dev-projects\loop-gpt`
(branch `release/owned-staging-20260917`, live https://loop-gpt.cyou).
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

**Committed and shipped** (per `docs/PROGRESS.md`, HEAD `31cb496`): audit §10 questions resolved; P0
blockers executed (Resend key swap + `MAIL_FROM`; Postgres image swap to `postgres-ssl:16`; Sentry +
PostHog vars set; `ADMIN_INVITE_CODE` set; landing copy fix); Phase 4 architecture cleanup
(`chat/page.tsx` 755→440, `MessageList` 593→142, `Composer` 432→252, backend `routes/agent.ts`
788→389, backend ESLint added); Phase 2 UI rebuild items 2.1–2.7; Phase 3 groups; nice-to-haves
§8-35 theme switcher, §8-39 per-message queue, §8-47 doc hygiene; the cross-tenant tool-audit-log leak.

**In flight in the working tree right now** (13 entries, agents actively writing):
- §8-40 composer connector chip — `frontend/app/chat/hooks.ts` (`useWorkspaceConnections`),
  `components/chat/Composer.tsx`, `components/chat/types.ts`, new
  `chat/__tests__/useWorkspaceConnections.test.tsx`
- §8-44 hands-free voice mode — `frontend/app/chat/hooks.ts` (`useVoiceMode`), new
  `chat/__tests__/useVoiceMode.test.tsx`
- §8-45 server (Kokoro) read-aloud engine + preference — `lib/voice.ts`,
  `components/settings/PersonalizationTab.tsx`, new `lib/__tests__/voice.test.tsx`
- Appearance settings tab — `components/settings/AppearanceTab.tsx` (new, untracked) +
  `components/SettingsPanel.tsx`
- `frontend` `npx tsc --noEmit` → **exit 0** on this tree (verified by hr-bot).

**Open, by owner** — the work this roster exists to close:

| Item | Owner | Source |
|---|---|---|
| Finish + commit the 4 in-flight UI items (gates, then one commit per item) | `ui-visual` (+`core-dev` for the `/api/tts` contract) | working tree |
| GAP-003 a11y contrast sweep (axe serious-level on the dark theme) | `qa-verify` | `GAP_REGISTER.md`, `AUDIT_REPORT.md` §6 P6 |
| §8-41 / GAP-070 mobile parity; §8-43 / GAP-049 native signing | `mobile-dev` | `AUDIT_REPORT.md` §8-41/43 |
| DB restore rehearsal (needs `DATABASE_URL`); Stripe go-live or an explicit free-only freeze; marketplace OAuth live smoke (Figma first); observability confirmation with a deliberate test error; uptime probe on `/healthz` | `ops-release` | `docs/PROGRESS.md` "Still open", `AUDIT_REPORT.md` §6 P8/P9/P10/P11 |
| Latency + bundle budgets ("fast and snappy") | `perf-eng` | user directive; no prior owner |
| Frontier-parity pattern recon (what Claude/ChatGPT/Grok do that §8 still lists as missing) | `research-scout` | `AUDIT_REPORT.md` §8 |
| Static review of each shipped phase's bytes | `code-review` | roster convention |

---

## 5. Files an owner must not lose

`frontend/app/chat/hooks.ts` and `frontend/app/components/chat/Composer.tsx` currently have **two
writers in one file each** (§8-40 and §8-44 both land in `hooks.ts`). `hooks.ts` has a single owner —
`ui-visual` — and `core-dev` must hand changes over rather than edit in place. This is the exact seam
where the fleet clobbered a file in a previous run.
