# Loop GPT — TEAM ROSTER (owner: hr-bot)

Snapshot: 2026-09-29 (rev 6 — the offense sub-fleet is on its **second live target**, `ssndobz.us`
(`ENG-2026-09-29-001`); §12 of `team/TEAM_ROSTER_OFFENSE.md` carries the raw launch. Rev 5 added the
offense sub-fleet pointer + a fresh live probe; rev 4 was the
post-M2 product roster). HEAD `629d7f6`, branch `release/owned-staging-20260917`. **The fleet now has
two rosters, both mine:** this file (the product fleet on `loop-gpt`) and
`team/TEAM_ROSTER_OFFENSE.md` (the 8-seat A–R offensive fleet for the pentest engagements — seats
`recon-passive`, `recon-active`, `web-cartographer`, `input-fuzzer`, `auth-session`, `api-dataflow`,
`exploit-op`, `verifier`; plan `team/PHASES_PENTEST.md`). Project:
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

**Re-probe 2026-09-27 (rev 3, hr-bot, raw `curl` with a real `tools` array)** — both seats re-verified:
- `hf-dsv41` → liveness `HTTP=200 2.488s`; tools `HTTP=200`, response carries
  `"tool_calls":[{"id":"chatcmpl-tool-8cc6a8078698001c","type":"function","function":{"name":"ping","arguments":"{\"x\": \"1\"}"}}]`.
- `qwen3-cyber` → liveness `HTTP=200 1.818s`; tools `HTTP=200`, response carries
  `"tool_calls":[{"id":"call_5d2233335d694aeb8f50e0f2","index":0,"type":"function","function":{"name":"ping","arguments":"{\"x\": \"1\"}"}}]`.
**Re-probe 2026-09-27 (rev 4, hr-bot, raw `curl` + a real `tools` array, `HF_TOKEN` from the profile
env)** — both live seats re-verified at HEAD `0d5d767`; the rejection list re-probed too:
- `hf-dsv41` → liveness `HTTP=200 t=1.747s`; tools `HTTP=200 t=3.886s`, response carries
  `[{"id": "chatcmpl-tool-870ac07d1496afb6", "type": "function", "function": {"name": "ping", "arguments": "{\"x\": \"1\"}"}}]`.
- `qwen3-cyber` → liveness `HTTP=200 t=1.742s`; tools `HTTP=200 t=1.828s`, response carries
  `[{"id": "call_5d6d4ae8fb68474ebd5a8c8f", "index": 0, "type": "function", "function": {"name": "ping", "arguments": "{\"x\": \"1\"}"}}]`.
- Router re-probe (`https://router.huggingface.co/v1`): `zai-org/GLM-5.2` → `HTTP=402 t=1.805s`,
  `Sao10K/L3-8B-Lunaris-v1` → `HTTP=402 t=1.700s`, both body
  `{"error":"You have depleted your monthly included credits. …"}`.
**Re-probe 2026-09-28T12:36Z (rev 5, hr-bot, raw `curl`, liveness **and** a real `tools` array per
seat)** — both live seats re-verified; the dead group was not re-litigated (nothing changed on it):
- `hf-dsv41` → liveness `HTTP=200 t=1.508s`; tools `HTTP=200 t=1.927s`, body carries
  `"tool_calls"`.
- `qwen3-cyber` → liveness `HTTP=200 t=1.616s`; tools `HTTP=200 t=1.784s`, body carries
  `"tool_calls"`.
**Re-probe 2026-09-29T04:5xZ (rev 6, hr-bot, raw `curl`, liveness **and** a real `tools` array per
seat, `HF_TOKEN` from the profile env)** — run as the pre-dispatch check for `ENG-2026-09-29-001`;
the dead group was not re-litigated (nothing changed on it):
- `hf-dsv41` → liveness `HTTP=200 t=1.526s`; tools `HTTP=200 t=1.524s`, body carries
  `[{"id": "chatcmpl-tool-9c8dcaf94422c2b4", "type": "function", "function": {"name": "ping", "arguments": "{\"x\": \"1\"}"}}]`.
- `qwen3-cyber` → liveness `HTTP=200 t=1.671s`; tools `HTTP=200 t=1.855s`, body carries
  `[{"id": "call_76585d39a7d94cc3be9358e2", "index": 0, "type": "function", "function": {"name": "ping", "arguments": "{\"x\": \"1\"}"}}]`.
- No `503` cold-start seen this pass (the `qwen3-cyber` scale-to-zero window of the note below is
  real but was not hit — the endpoint was warm).
**No repin needed: both live seats are still live and tool-capable; the dead group is unchanged.**
`config.yaml` now carries exactly two `providers:` keys (`['hf-dsv41', 'qwen3-cyber']`) — the router
and Azure blocks were pruned (`config.yaml.bak.no-hf-router-20260926-040442`), so the rejections are
recorded here rather than left pinned anywhere.

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

**Committed and shipped** (per `docs/PROGRESS.md`, HEAD `0d5d767`): audit §10 questions
resolved; P0 blockers executed (Resend key swap + `MAIL_FROM`; Postgres image swap to
`postgres-ssl:16`; Sentry + PostHog vars set; `ADMIN_INVITE_CODE` set; landing copy fix); Phase 4
architecture cleanup (`chat/page.tsx` 755→440, `MessageList` 593→142, `Composer` 432→252, backend
`routes/agent.ts` 788→389, backend ESLint added); Phase 2 UI rebuild items 2.1–2.7; Phase 3 groups;
nice-to-haves §8-35 theme switcher, §8-39 per-message queue, §8-47 doc hygiene; the cross-tenant
tool-audit-log leak.

Since the last revision: `3a43db8` (effort resolver per contract §A + **served-revision endpoint**
`GET /api/version`; html artifact kind) and `a4b29bb` (**served-revision marker** `out/version.json`
written by `web/Dockerfile` from `ARG GIT_REVISION`, with one `map` no-store entry in
`web/nginx.template.conf` — a map, not a location, so the five security headers survive). `1b16094`
fixes the §F contract, `66e35f9` records the read-back move.

The four UI items this roster last listed as "in flight" are committed — `7540a3d`
(`14 files, +836/−42`): §8-40 connector chip, §8-44 hands-free voice mode, §8-45 server TTS +
`Appearance` tab. Follow-up `d110e56` then **fixed the TTS upstream** (HF Inference Providers dropped
TTS platform-wide → Kokoro Space over `/gradio_api/call`; verified end-to-end before wiring, 156 KB
RIFF/WAV; 7 route tests). The two-writers seam in §5 below was clean at `d110e56`, reopened with the
P2 stream, and is **closed again** by `0d5d767`.

**Since rev 3 (this pass):** `0d5d767` — `feat(chat): composer effort selector + stream hook pair (M2,
two-writer seam rev3)`, **7 files, +206/−32**, `EffortSelector.tsx` 5,978 B tracked. M2 is
frontend-only, so the live backend (`a4b29bb`) remains code-equivalent on the API surface; the served
marker simply no longer names HEAD (see the open table).

**Gates measured at `0d5d767` (re-run by `arch-lead` and `boss-bot`, hr-bot does not re-litigate):**
`npx tsc --noEmit` → `TSC_EXIT=0`; `npx vitest run` → **23 files / 151 tests passed**
(`VITEST_EXIT=0`). At `7540a3d` the same suite was 23 files/150, `lint` 0 err/13 warn, `playwright`
20, `build` exit 0 / 19 routes. The pre-M2 red gate had **three test-side defects only** (patch
`team/PATCH_P2_composer_test.md`), so no product code was implicated.

**Open, by owner** — the work this roster exists to close:

| Item | Owner | Source |
|---|---|---|
| **The web served marker is LIVE but blind.** Measured 2026-09-27 (rev 4, hr-bot, raw): `GET https://loop-gpt.cyou/version.json` → `HTTP=200, 75 B, {"surface":"web","revision":"unknown","builtAt":"2026-09-27T23:21:12.630Z"}`, three probes `t=2.00s / 7.98s / 1.80s`. `builtAt` is *after* `a4b29bb` (`19:19 EDT` = `23:19Z`), so the live image **is** the new one and the path works — but the web service's `GIT_REVISION` build arg is **unset**, so the marker cannot name a revision. One-line unblocker: set `GIT_REVISION=${{RAILWAY_GIT_COMMIT_SHA}}` on the web service and redeploy (per `arch-lead`'s §F.1 ruling: web **set**, backend **unset**). | `ops-release` | this roster, rev 4 |
| ~~F2: `GET /api/version` `404` on both origins~~ **CLOSED** — measured: `HTTP=200, 141 B, {"service":"loop-gpt-backend","revision":"a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37",…}`, i.e. the backend serves exactly HEAD-at-the-time. Backend read-back is proven; the **web half** is the row above. Since `0d5d767` is frontend-only, live remains code-equivalent — a redeploy just makes the read-back *name* HEAD. | `core-dev` ✔ → `ops-release` | this roster, rev 4 |
| One real authed `POST /api/tts` returning audio bytes + `Content-Type` + byte count (F3) | `core-dev` + `qa-verify` | F3 |
| GAP-003 a11y contrast sweep (axe serious-level on the dark theme) | `qa-verify` | `GAP_REGISTER.md`, `AUDIT_REPORT.md` §6 P6 |
| §8-41 / GAP-070 mobile parity; §8-43 / GAP-049 native signing | `mobile-dev` | `AUDIT_REPORT.md` §8-41/43 |
| DB restore rehearsal (needs `DATABASE_URL`); Stripe go-live or an explicit free-only freeze; marketplace OAuth live smoke (Figma first); observability confirmation with a deliberate test error; uptime probe on `/healthz` | `ops-release` | `docs/PROGRESS.md` "Still open", `AUDIT_REPORT.md` §6 P8/P9/P10/P11 |
| Latency + bundle budgets ("fast and snappy") — **the cost is the EDGE, not the bundle or our backend, measured two ways.** My raw probes of the live host: `/healthz` (10 B, nginx `return 200`, **zero** origin work) `tls=1.762s ttfb=2.067s`; `/version.json` (75 B) `tls=1.487s ttfb=1.790s`; `/api/version` (141 B, proxied to the backend) `tls=1.527s ttfb=1.860s`. Fastest runs of both proxied paths land at `ttfb≈0.77–0.81s`, while the TLS phase alone swings `0.46s → 3.38s` across runs — and DNS swung `0.016s → 0.722s` on top. `@arch-lead` isolated the same seam with a two-request session: `req1 ttfb=1.778s → req2 ttfb=0.329s` on a reused connection. A user pays that handshake before the first HTML byte regardless of what `ui-visual` ships. Reportable metric is `time_starttransfer − time_appconnect`. | `perf-eng` (measure) + `ops-release` (edge: keep-alive / session resumption / PoP) | this roster, rev 4; `@arch-lead`'s probe; user directive |
| Frontier-parity pattern recon (what Claude/ChatGPT/Grok do that §8 still lists as missing) | `research-scout` | `AUDIT_REPORT.md` §8 |
| Static review of each shipped phase's bytes | `code-review` | roster convention |

---

## 5. Files an owner must not lose

`frontend/app/chat/hooks.ts` and `frontend/app/components/chat/Composer.tsx` each had **two writers**
while §8-40 and §8-44 were open. That work is committed (`7540a3d`), the seam reopened with the P2
stream, and it is **closed again by `0d5d767`** (`EffortSelector.tsx` landed as a new file, not as an
edit inside `hooks.ts`). The rule stands for the next UI phase: **`hooks.ts` has a single owner,
`ui-visual`; `core-dev` hands changes over rather than editing in place.** This is the exact seam where
the fleet clobbered a file in a previous run. Housekeeping: the untracked `frontend/_fix*.py` /
`_final*.py` scratch files (`_fix.py`, `_fix2–5.py`, `_final2–4.py`) plus `p3.js` / `p5.js` are still
sitting in the tree — `@boss-bot` is keeping them out of the docs commit, but whoever owns them should
delete them.

**Stash-recovery record (rev 4).** The `TEAM_ROSTER.md` in `stash@{0}` (`qa2`) was the rev-3 text,
**12,493 B** blob `sha256 53f89d392e7e55f06070e9652332c8321e99dfc197a9ec1bab4debf5979940c6`; worktree
HEAD still held the older rev-1 text. Recovered with `git checkout 'stash@{0}' -- TEAM_ROSTER.md`;
staged content hashes identically to the stash blob (`git hash-object` on both = `d151a4c5`), and this
rev 4 advances on top of it. Nothing of rev 3 was lost, so the stash is now safe to drop from
`hr-bot`'s side — `arch-lead`'s `CONTRACT_P2_STREAM.md` and the staged `PHASES.md` were the other two.
