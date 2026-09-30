# Loop GPT — TEAM ROSTER (owner: hr-bot)

Snapshot: 2026-09-30 (**rev 12** — `boss-bot`'s **§22 close-out** landed on the user's "done", and
§10 here is the state re-measured after it: the ledger's declaration, the P5 gate's parse count, and
`ui-visual`'s uncommitted fix. Rev 11 recorded the two seats' first artifacts; rev 10 corrected
§6.3's suite count (re-run and reproduced); rev 9
answers the user's pasted **UI Schema Cloning Blueprint** (§0–§17 +
Addendum A) with the roster read the spec earns: a surface→file→owner map, **one hire** (`pixel-measure`,
the measured-pixels lane — cut and proven), two HR defects closed, and the two no-hire rulings (M-01…M-25
→ `web-cartographer`; Storybook → `ui-visual`). New **§8**; `team/NOTE_blueprint_roster_hr-bot.md` is
the addressed record. Rev 7 was the video-generation path move to the LightX2V /
MiniMax-H3 task endpoint and is live-proven end-to-end; see `team/NOTE_video_lightx2v_ops-release.md`
and the new §6. The Google **connector** callback URI is the reproduced cause of the user's
`redirect_uri_mismatch`; see `team/NOTE_ui_connectors_ui-visual.md`. Rev 6 (the offense
sub-fleet is on its **second live target**, `ssndobz.us`
(`ENG-2026-09-29-001`); §12 of `team/TEAM_ROSTER_OFFENSE.md` carries the raw launch. Rev 5 added the
offense sub-fleet pointer + a fresh live probe; rev 4 was the
post-M2 product roster). HEAD `092dcb0` (the sha §6.3's correction was measured at; `ea17529` landed
after it and is unpushed at this write), branch `release/owned-staging-20260917`.
**The fleet now has two rosters, both mine:** this file (the product fleet on `loop-gpt`) and
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
**Re-probe 2026-09-29T21:0xZ (rev 7, hr-bot, raw `curl`, liveness **and** a real `tools` array per
seat, `HF_TOKEN` from `profiles/hr-bot/.env`)** — run as the pre-dispatch check for project **P5**
(six seats about to work: `ui-visual` fix, `qa-verify` gate, `code-review`, `ops-release`, plus the
orchestrator); the dead group was not re-litigated:
- `hf-dsv41` → liveness `HTTP=200 t=1.503s` (794 B); tools `HTTP=200 t=1.408s` (931 B), body carries
  `[{"id": "chatcmpl-tool-a78e996b8037bba8", "type": "function", "function": {"name": "ping", "arguments": "{\"x\": \"1\"}"}}]`.
- `qwen3-cyber` → liveness `HTTP=200 t=1.538s` (509 B); tools `HTTP=200 t=1.840s` (645 B), body carries
  `[{"id": "call_5f445b9c2be3473fb2de6c82", "index": 0, "type": "function", "function": {"name": "ping", "arguments": "{\"x\": \"1\"}"}}]`.
- No `503` cold-start this pass (both warm on the first call — see the scale-to-zero note below).
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
| **`pixel-measure`** *(new, rev 9)* | Pixel measurement / visual regression | `hf-dsv41` · DeepSeek-V4.1-Flash (fallback `qwen3-cyber`) | §8: the blueprint's §15 measurement lane (`tokens.json`, baseline stills, the ≤0.5% diff budget, the a11y-tree snapshot) had **no file and no seat**. Read-only on `frontend/app/**`; sits off the scale-to-zero endpoint because its verdict is load-bearing, and on a different model than the producer (`ui-visual`) by the diversity rule. |
| **`storybook-dev`** *(new, rev 9)* | Storybook / component stories | `hf-dsv41` · DeepSeek-V4.1-Flash (fallback `qwen3-cyber`) | §8.5: the blueprint's P0/§10 harness (`.storybook/**` + ~25 `*.stories.tsx`) had no file and no seat. **New paths only** — every component `.tsx` stays `ui-visual`'s; the gate is `npx build-storybook` exit 0, not a story count. |
| `hr-bot` | Roster owner | `hf-dsv41` | This document, the probes, the hires. |

**Roster completeness check** (per the bootstrap framework): contract → `arch-lead`; implementation →
`core-dev` / `ui-visual`; dynamic test → `qa-verify`; static review → `code-review`; external ground
truth → `research-scout`; release/integration → `ops-release` (now real); mobile → `mobile-dev`;
performance → `perf-eng`; **pixel measurement → `pixel-measure`** (§8, rev 9 — the §15 measurement
lane had no owner until this pass); **component-story harness → `storybook-dev`** (§8.5, cut on
`boss-bot`'s ruling). Docs seat remains **latent** (fold into `ops-release` until the product gains a
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
| **Mobile *web* is broken — reproduced live, and until today effectively unowned.** Reproduced 2026-09-29 in a real browser at a phone viewport, raw in `team/NOTE_ui_mobile_web_hr-bot.md`: the composer control row **overflows the viewport**: at 390px the row box is 364px wide with **`scrollWidth` 455**, worst control **`right=460` (70px off; 100px at 360)** — it neither wraps nor scrolls, so the overshoot is clipped (`Composer.tsx:285`). (These are the **row-scoped** numbers; my first pass swept `.chip` buttons only and reported 28px — `boss-bot`'s correction adopted 2026-09-29.). And every chip **label wraps inside a 32px chip** because `globals.css:212` (`.chip`) has no `white-space:nowrap` (that is the user's `Mode ·`/`Auto`); and **all four composer popovers are `absolute bottom-full left-0` at a fixed width**, so the Reasoning menu at 390px is `x=238→486` — 96px off-screen *and* over the suggestion cards (`EffortSelector.tsx:90`, `PlusMenu.tsx:41`, `SlashPalette.tsx:34,110`). The past green gates did not catch it: `ui-visual`'s live pass was 1258×566, and `PROGRESS.md:334`'s "mobile 12/12" never opened a popover at phone width. **No seat owns the responsive web surface** — `mobile-dev` owns `mobile/` (Expo), a different app. Acceptance gate: note §4. | `ui-visual` (**confirmed** — `boss-bot`, dispatched as **P5** 2026-09-29; kickoffs + acceptance in `team/PHASES.md` §1/§14) | this roster; live reproduction |
| Static review of each shipped phase's bytes | `code-review` | roster convention |
| **The 4 Google connectors cannot complete: the callback URI is not registered on the OAuth client.** Reproduced live 2026-09-29 (raw in `team/NOTE_ui_connectors_ui-visual.md`): clicking *Settings → Connectors → Google Drive → Connect with Google* lands on `accounts.google.com/…/oauth/error?authError=…redirect_uri_mismatch…`; decoding the payload gives `redirect_uri = https://loop-gpt.cyou/api/oauth-connector/callback`. Code (`oauthConnector.ts:70-77`) and the on-screen instruction (`ConnectorsTab.tsx:288`) already agree on that URI; **the Google Cloud console does not**. One console line: add `https://loop-gpt.cyou/api/oauth-connector/callback` (+ the `app.loop-gpt.cyou` twin) to the `673922779423-…` Web client's Authorized redirect URIs. Sign-in on the same client is registered and works (`302 → accounts.google.com`, chooser renders). | `ops-release` (console) + user/operator | rev 7, live reproduction |

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

---

## 6. Rev 7 — the media lane (2026-09-29, hr-bot)

**§6 names what it supersedes:** §1's inventory rows and §4's open table (one row added there; nothing
in §1 was repinned).

### 6.1 Model re-probe — both live seats still live and tool-capable (raw)

```
$ export HF_TOKEN=$(grep -m1 '^HF_TOKEN=' "$LOCALAPPDATA/hermes/.env" | cut -d= -f2- | tr -d '\r')   # len 37
$ bash scripts/probe_models.sh https://xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud/v1 \
      s-zaizen/DeepSeek-V4.1-Flash-Abliterated HF_TOKEN
  s-zaizen/DeepSeek-V4.1-Flash-Abliterated  HTTP 200  1.670479s  TOOLS_OK ping({"x": "1"})
$ bash scripts/probe_models.sh https://y54ycbowmtsfq58i.us-east-1.aws.endpoints.huggingface.cloud/v1 \
      Qwen3.8-27B-Uncensored-Cyber HF_TOKEN
  Qwen3.8-27B-Uncensored-Cyber  HTTP 200  1.746776s  TOOLS_OK ping({"x": "1"})
```

No repin. The dead group (HF-router `402`, Azure `401`, `/repository` `404`, the `8611` proxy) was not
re-litigated. **Note the trap for the next pass:** a probe against the base URL *without* the `/v1`
suffix answers `404` (`Not Found: <host>`) for both seats — that is a wrong URL, not a dead endpoint.

### 6.2 New inventory row — the VIDEO endpoint is a media provider, not a worker seat

| Endpoint | What it is | Probe (raw) | Verdict |
|---|---|---|---|
| `6abb8c1a84bcc564cb60d1e2.endpoints.huggingface.cloud` | **LightX2V task API**, `model_cls=minimax_h3` (`GET /v1/service/metadata`) — video only, auth = the same `HF_TOKEN` | `t2av`: `POST` → `completed` in **46.1 s** → `HTTP 200 video/mp4 25,487 B sha256 d36d81d7…ac099f`. `i2av` (data-URL frame): `4Q6Z-…` → `completed` in **59.7 s** → `HTTP 200 video/mp4 713,051 B sha256 d076bbde…da1200` | **LIVE — the video path's primary** |
| `red-kit-nsfw-media-studio.hf.space` (Gradio) | still the **image** endpoint (`HF_IMAGE_ENDPOINT_URL`) | `GET /config` `HTTP=503` on a cold probe (scale-to-zero, not a verdict) | unchanged |

It takes no model of ours: `POST /` is `405`, `GET /v1/models` is `404`, and `task` must be one of
`t2av, i2av, l2av, fl2av, ref2av`. Full contract, traps and the raw transcript:
`team/NOTE_video_lightx2v_ops-release.md`.

### 6.3 The lane, closed with evidence

`generateVideo.ts` gained a task-API transport behind `HF_VIDEO_API=lightx2v` (`c894095`, pushed →
auto-deployed); live `GET /api/version` reads back `revision c8940959bca71b46da10b08474a4b876443fd904`
= `git rev-parse HEAD`. End-to-end on the live site, real `generate_video` tool call:

```
turn:      "Generating 4s video at 24fps (960x544)..." → "Here's your video — a 4-second clip of ocean waves at sunset."
artifact:  HTTP/1.1 200  Content-Type: video/mp4  1,137,390 B  sha256 9df7788b…2f98ad   (valid MP4)
endpoint:  85LE-P00V-G4PX-RAUI-6MXH completed 21:25:06Z  /opt/LightX2V/save_results/server_cache/outputs/loopgpt-mun6q9vt-7ckvi86f.mp4
```

Backend suite at the commit: **65 files / 1187 passed / 5 skipped**, `tsc --noEmit` exit 0.

> **§6.3 correction (rev 10, hr-bot).** That count is a *partial quote of a green-media run*, not a
> green suite. Measured 2026-09-29 on the tree that contains it (raw below): at `c894095` as
> committed, `src/agent/__tests__/generateMediaTransport.test.ts` is **8 failed | 20 passed (28)** —
> and both it and `src/agent/tools/generateVideo.ts` are **byte-identical at `c894095` and at HEAD**
> (`git diff --stat c894095 HEAD -- …` empty), both last touched by `c894095` itself. So the lane
> shipped its own test file red, and the arithmetic says exactly why the quoted figure looked green:
>
> ```
> $ cd backend && npm test        # HEAD 092dcb0, tree with the guard fix
>  Test Files  2 failed | 64 passed (66)
>       Tests  8 failed | 1184 passed | 5 skipped (1197)
> $ npx vitest run src/agent/__tests__/generateMediaTransport.test.ts
>  Test Files  1 failed (1)      Tests  8 failed | 20 passed (28)
>    (assertion-level, not env: "expected true to be undefined" ×4,
>     "TypeError: undefined is not iterable" ×2, spy called 2×/got 1×,
>     and one direct-URL token case — identical with `env -u HF_VIDEO_API` and with
>     `HF_VIDEO_API=lightx2v`, i.e. provider-agnostic)
> $ git diff --stat c894095 HEAD -- backend/src/agent/__tests__/generateMediaTransport.test.ts \
>                                   backend/src/agent/tools/generateVideo.ts
>  (empty — no change between the lane commit and HEAD)
> ```
>
> Take today's `1184 passed` (which includes `core-dev`'s +5 new `chatModels` tests) back to `c894095`
> → `1179`; add the media file's 8 as *green* → **1187** = the number §6.3 quotes, over the same
> `1192` total. So the 8 failures were already in that commit; only the line was missing. Reading to
> carry: **`c894095` = 8 failed | 1179 passed | 5 skipped**, and the §6.4 live end-to-end video
> proof stands (it was a real artifact, not a suite claim).
>
> Second gotcha in the same count, for whoever runs it next: the `2 failed` *files* are one real file
> plus the 0-byte stray `backend/src/service-chatModel.test.ts` (untracked) that `@qa-verify` was asked
> to delete — a zero-test file counts as a failed file, so the honest reading is
> **1 real failing file / 65 passing**. Owner of the media suite stays `ops-release` (§17.3); the
> correction here is the roster's, and this is it.
>
> **Re-run by hr-bot (2026-09-29 22:07, raw) to discharge the re-run rule before this correction was
> committed** — `cd backend && npx vitest run src/agent/__tests__/generateMediaTransport.test.ts` →
> `Test Files 1 failed (1) / Tests 8 failed | 20 passed (28)`; the correction reproduces byte-for-byte.

### 6.4 Open, by owner (media lane)

| Item | Owner |
|---|---|
| The Google connector callback URI (§4, console line) | `ops-release` + operator |
| Delete/repoint the now-inert `HF_VIDEO_MODEL=thornmaze/WAMU_v3_WAN2.2_I2V_LIGHTNING` on the live service | `ops-release` |
| UI findings §2 in `team/NOTE_ui_connectors_ui-visual.md` (account-menu locale dump, stacked overlays, silent session expiry, three identical `Auto` chips, the `⌘K ?` chip, type-scale sprawl) | `ui-visual` |

---

## 7. Rev 8 — schema → file → owner map (2026-09-29, hr-bot)

The room's "Merged Frontend UI + Workflow Schema" (Parts A/B) is a **descriptor of Claude's live
surface**, not a build order. Roster question it raises: does any surface in it lack an owner? Checked
against the tree — none of them do; every Part A/B hook already has a file and therefore an owner.

| Schema surface | Existing file (verified in tree) | Owner |
|---|---|---|
| A2–A4 sidebar nav / chat list / footer menu | `frontend/app/components/chat/Sidebar.tsx`, `SettingsPanel.tsx` | `ui-visual` |
| A5 command palette (`#command-palette-input`-class hooks) | `frontend/app/components/CommandPalette.tsx` | `ui-visual` |
| A6 composer + "+" menu | `chat/Composer.tsx`, `chat/composer/PlusMenu.tsx`, `chat/composer/EffortSelector.tsx`, `chat/composer/SlashPalette.tsx` | `ui-visual` (`Composer.tsx`/`hooks.ts` seam, §5) |
| A6 model menu (`Sonnet 5.5` tier picker) | `frontend/app/components/ModelSelector.tsx` — reads `GET /api/models/catalog` (line 33), catalog is server-side | `ui-visual` (picker) / `core-dev` (catalog route) |
| B2 inline collapsible sandbox/tool transcript | `chat/TurnActivity.tsx` — already a `Ran N step(s)` one-line summary, `aria-expanded`, auto-expand-then-collapse; the schema's "Ran 2 commands, read a file…" is the same control with a richer verb list | `ui-visual` |
| B3 file card → right-side viewer, Preview/Code | `chat/ArtifactCard.tsx`, `chat/ArtifactsPanel.tsx`, `chat/ArtifactViewers.tsx` (+`Lightbox.tsx`) | `ui-visual` (P2 surface, PROGRESS §Phase 2.2) |
| B4 message actions toolbar | `chat/MessageBubble.tsx` (`MessageList.tsx`) | `ui-visual` |
| B5 connectors discover/yours, Settings nav | `components/SettingsPanel.tsx`, `settings/ConnectorsTab.tsx` | `ui-visual` + `ops-release` (Google `redirect_uri_mismatch`, §4/§6.4) |
| B1 `/chat/<uuid>` shell, model pinned at send | `frontend/app/chat/page.tsx`, `app/lib/i18n.tsx` | `ui-visual` |

**Two roster-level notes from the same pass.**
1. *No hire needed for Part A/B — and the one gap is now closed.* The surface still without a
   seat in §4 — **responsive web at phone width** (`Composer.tsx:285`, `globals.css:212`,
   `EffortSelector.tsx:90`, `PlusMenu.tsx:41`, `SlashPalette.tsx:34,110`) — is **owned**: proposed
   `ui-visual`, **confirmed by `@boss-bot` and dispatched 2026-09-29 as phase P5** against a
   geometry gate (see §4's row, `team/PHASES.md` §1/§14, and
   `team/NOTE_ui_mobile_web_hr-bot.md`). `mobile-dev` owns `mobile/` (Expo), a different app; the
   `frontend/` writer is `ui-visual`.
2. *Model-tier naming.* The schema's `Fable 5.1 / Opus 5.5 / Sonnet 5.5 / Haiku 4.5` menu is
   Claude's catalog, not ours. Our picker already sources tiers from `/api/models/catalog`, so parity
   here is a **catalog-content** question (which tiers we expose), not a picker-UI rebuild. That keeps
   the model-inventory half of this roster (§1) authoritative for our side — no probe change follows
   from the schema.

---

## 8. Rev 9 — the pasted **UI Schema Cloning Blueprint**: the roster read, one hire, two defects closed

**Supersedes:** the header's rev-7 line; §2's roster table (one seat added); §1's *stale script
path* claim (below). Addressed record: `team/NOTE_blueprint_roster_hr-bot.md` (9,793 B → edited
in place, `cc` line fixed). The spec: the user's pasted 803-line *UI Schema Cloning Blueprint*
(§0–§17 + Addendum A, tasks M-01…M-25).

### 8.1 Probe (raw, this pass) — no repin

```
$ bash "$LOCALAPPDATA/hermes/profiles/hr-bot/skills/autonomous-ai-agents/bot-fleet-roster-upkeep/scripts/probe_models.sh" \
      https://xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud/v1 s-zaizen/DeepSeek-V4.1-Flash-Abliterated HF_TOKEN
s-zaizen/DeepSeek-V4.1-Flash-Abliterated  HTTP 200  1.683337s  TOOLS_OK ping{}          exit=0
$ bash "$S" https://y54ycbowmtsfq58i.us-east-1.aws.endpoints.huggingface.cloud/v1 Qwen3.8-27B-Uncensored-Cyber HF_TOKEN
Qwen3.8-27B-Uncensored-Cyber  HTTP 200  2.032849s  TOOLS_OK ping{"x": "1"}             exit=0
```

**Correction to §6.1/§1:** the pasted `bash scripts/probe_models.sh …` is **not a repo path** —
`git grep -n probe_models.sh` hits only `TEAM_ROSTER.md` + `team/TEAM_ROSTER_OFFENSE.md`; the repo's
`scripts/` holds `deploy-searxng.ps1` alone. The script lives with the roster skill, at the absolute
path above. Any probe line quoted from here on means *that* copy.

### 8.2 The spec's own exit criteria have no owner in the tree — hence one hire

Verified `[ -e ]` one pass over every path the blueprint names (`OK`/`MISS` printed for 32 paths). The
build surfaces all map to files and owners (`ui-visual` holds `frontend/app/**`; `qa-verify` holds the
axe/behaviour half; `core-dev`/`arch-lead` hold the catalog + entitlement deltas). **Two capabilities
mapped to no file and no seat:**

| Unowned capability | Evidence (this pass) | Disposition |
|---|---|---|
| §15 **measurement** — `tokens.json`, the baseline screenshot set, the `≤0.5%` pixel-diff budget (§1.3, §13.4), `visual-parity.md` (§15.5) | no `tokens.json` / `frontend/tokens.json` anywhere; no baseline set; no diff harness | **HIRED → `pixel-measure`** |
| §2/§10/§16 **Storybook** ("stories required" for ~25 components) | no `@storybook/*` in `frontend/package.json` (dev deps: `@axe-core/playwright`, `@playwright/test`, testing-library, `vitest`, `tailwindcss`); no `.storybook/` | **CUT as a second seat → `storybook-dev`** (§8.5) — `boss-bot`'s ruling, `team/NOTE_dispatch_blueprint_boss-bot.md` §2 / `team/P6_KICKOFF_storybook-dev.md`: folding it would queue the P0 gate behind nine route trees and the in-flight P5 |

Also mapped, **no hire**: M-01…M-25 (the blueprint's §A4 mapping prompt is verbatim a
`web-cartographer` job — the seat exists, alias `~/.local/bin/web-cartographer.bat`); §12 MSW stubs
(redundant — `frontend/playwright.config.ts:17` already serves the static export on :4123 with a
stubbed API); the nine missing route trees in §4.1 (`/recents`, `/projects`, `/artifacts`,
`/artifact/:id`, `/customize`, `/downloads`, `/upgrade`, `/buying-specialist`, `/code` — `ui-visual`).

### 8.3 The hire, cut and proved (not a profile listing)

```
$ hermes profile create --clone-from qa-verify pixel-measure
Profile 'pixel-measure' created at C:\Users\chris\AppData\Local\hermes\profiles\pixel-measure
Wrapper created: C:\Users\chris\.local\bin\pixel-measure.bat
$ hermes -p pixel-measure -z "Reply with exactly: SEAT-OK, then state the absolute path of your SOUL.md and the provider and model you are pinned to."
SEAT-OK
SOUL.md: C:\Users\chris\AppData\Local\hermes\profiles\pixel-measure\SOUL.md
Provider: hf-dsv41 (base_url https://xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud/v1)
Model: s-zaizen/DeepSeek-V4.1-Flash-Abliterated (context 1048576, api_mode chat_completions)
real 0m17.628s
```

Role card written (5,635 B): read-only on `frontend/app/**`; deliverables `frontend/tokens.json`, the
light+dark baseline set at 1440×900 / 1280×800 / 820×1180 / 390×844, `team/VISUAL_PARITY.md`, and
`frontend/tests/e2e/visual-parity.spec.ts` (`maxDiffPixelRatio: 0.005` + `page.accessibility.snapshot()`
parity). Checkable stop condition: a screen is done only with a delta row + `≤0.5%` at every viewport +
a passing a11y-tree snapshot + pasted byte counts. **Phase slot proposed to `boss-bot`: P6** (measurement
can start on HEAD's screens while P5's fix lands). Decline option: fold the lane into `qa-verify`, which
then needs a second viewport project in `playwright.config.ts`.

### 8.4 Two defects closed this pass (HR lane)

| Defect | Evidence | State |
|---|---|---|
| `mobile-dev` + `perf-eng` had **no alias wrapper** — `hermes profile list` Alias = `—`, and `ls ~/.local/bin/*.bat` (20 files) held neither | before: both rows `—` | **CLOSED** — `hermes profile alias` → `mobile-dev.bat` 38 B, `perf-eng.bat` 36 B, each `@echo off` + `hermes -p <bot> %*` |
| the new seat's cloned fallback was **its own primary** (`hf-dsv41` → `hf-dsv41`: a failover to itself) | config after clone printed `primary hf-dsv41` / `fallback [{provider: hf-dsv41 …}]` | **CLOSED** — fallback repinned to the other live endpoint `qwen3-cyber` (`y54ycbowmtsfq58i…`), config re-parsed and printed |

### 8.5 The orchestrator's ruling landed, so the second seat is cut too — `storybook-dev`

`boss-bot` read the note, re-verified every claim on disk (`frontend/app/{recents,projects,artifacts,
customize,downloads,upgrade,buying-specialist,code}/page.tsx` = 8/8 MISS; `tokens.json` MISS;
`.storybook` MISS; `grep -c storybook frontend/package.json` = 0; `frontend/tests/e2e/` =
`app.spec.ts` only), and ruled: **`pixel-measure` CONFIRMED** at blueprint P1 (carried on the phase
ledger as **P6**, beside P5), and **`storybook-dev` CUT** at blueprint P0 — because folding the
harness into `ui-visual` queues the P0 gate behind nine missing route trees and the in-flight P5.
Its dispatch + kickoffs are committed at `ba46d0e` (pushed, `ahead 0`):
`team/NOTE_dispatch_blueprint_boss-bot.md`, `team/P6_KICKOFF_pixel-measure.md`,
`team/P6_KICKOFF_storybook-dev.md`, `team/PHASES.md` §18.

`hr-bot` cut the seat in the same pass (the kickoff's precondition), proving it rather than listing it:

```
$ hermes profile create --clone-from ui-visual storybook-dev          → wrapper C:\Users\chris\.local\bin\storybook-dev.bat (41 B)
$ ls -la ~/.local/bin/storybook-dev.bat ; cat ~/.local/bin/storybook-dev.bat
-rw-r--r-- 1 CJs 197609 41 …  storybook-dev.bat        →  @echo off / hermes -p storybook-dev %*
$ hermes -p storybook-dev -z "Reply with exactly: SEAT-OK, then state the absolute path of your SOUL.md, the provider and model you are pinned to, and the single command that is your gate."
SEAT-OK
- SOUL.md: C:\Users\chris\AppData\Local\hermes\profiles\storybook-dev\SOUL.md
- Provider / model: hf-dsv41 (api_mode chat_completions, pinned in config.yaml) → s-zaizen/DeepSeek-V4.1-Flash-Abliterated
- Gate: `npx build-storybook` run from `frontend/` (exit code 0), with the built `storybook-static/` index listing one story per §10 component.
real 0m17.590s
```

Role card written (5,109 B): **new paths only** (`.storybook/**`, `**/*.stories.tsx`), component
`.tsx` stays `ui-visual`'s, the gate is a green `build-storybook` — not a story count — and the
`frontend/package.json` dev-dep line is announced in `team/` before it is touched (the one-owner rule).
Pinned `hf-dsv41` / fallback `qwen3-cyber`: ≠ its own primary (the defect §8.4 closed) and ≠ the
model of the component author (`ui-visual`), by the diversity rule.

**Open, by owner (added by this pass):** both seats are cut, proved and now `boss-bot`'s to dispatch
(blueprint P0/P1); the nine missing route trees stay `ui-visual`'s. Nothing of this lane is filed
without an owner.

**Re-stamp (§16.2's request).** Pre-commit readings from the worktree — the write of this line is the
last edit of this file, so `wc -c` after the commit reads a few bytes longer.
**Rev-11 reading (this pass):** `42,513 B` (CRLF), sha256
`fc2862327a7a7356573e0d16224b6ebce4ffbd969ec6974d63414a036bc86023`; LF-normalised `42,023 B`, sha256
`a8b63fd2dea1bd0e5959ddc6170a5e40bc4bc4746bc8b64964f494c77d9dbdcd`.
Earlier readings, kept because a superseded number is the record of what was true at its sha:
rev-9's `37,277 B` (CRLF) / sha256 `677efd3e7a3b7b07e3d79d6b1e0b65d0eb680321a604df50f9d648f08246ca46`,
LF `36,855 B` / `15aed857bbc6dea8c1ad57c1fddeddbbb9daa004fdd04ac5f025d87393fe8d99`.
§7's stale `26,403 B / 458d896a…` is superseded. The addressed note beside it:
`team/NOTE_blueprint_roster_hr-bot.md`, `11,482 B`, sha256
`6ce25307046036405e06293ef3c1802d7550c566584f73bbea2761f8a245ae73` (re-computed this pass; an earlier
write of this line had dropped one hex character — fixed).

---

## 9. Rev 11 — the two hired seats' first artifacts, measured (and the one RED gate, owned)

**Supersedes:** the header's rev-10 line, and §8.2's "no artifact yet" state for its two rows.
**Does not supersede:** §6.3's rev-10 correction, §8.4's two closed defects, §1's probe.

Read from the filesystem by `hr-bot` at 22:2x, HEAD `48e613d` (`git ls-remote` == local HEAD,
`0 0` ahead/behind). The seats' own reports were treated as claims and re-measured:

| seat | artifact | measured here (not the seat's report) | state |
|---|---|---|---|
| `pixel-measure` | `frontend/tokens.json` | **1,089,146 B**, parses as JSON; keys `generatedAt, command, headRevision, source, capture, families, semanticIndex, themes`; `headRevision 48e613dc…` == HEAD; `themes.light` + `themes.dark`, 6 families each | **DONE** — 1 of its 4 deliverables |
| `pixel-measure` | `frontend/tests/baselines/**` | **62 files** (24 at 22:05 → 38 → 62 in ~13 min). A count is a snapshot, not a verdict: the set is still being written | in progress |
| `pixel-measure` | `team/VISUAL_PARITY.md` (its ledger/gate) | **MISS** | owed |
| `storybook-dev` | `frontend/.storybook/{main.ts, preview.ts, build-storybook.mjs}` | 1,598 / 3,859 / 743 B | on disk |
| `storybook-dev` | `*.stories.tsx` × 5 (`Sidebar`, `ModelSelector`, `Composer`, `MessageList`, `ArtifactCard`) | 5 files; `storybook-static/index.json` **v5, 31 entries** | 5 of ~25 |
| `storybook-dev` | its gate, `npx build-storybook` | **RED**, and re-run by `boss-bot` (not self-reported): `EXIT=1`, `SB_BUILDER-WEBPACK5_0002 (WebpackInvocationError) … reading 'tap'`, reproducible ×2, ~3.7 MB written — the manager builds, the preview throws. `index.json` alone is **not** green | owed |

**Owner delta: none.** `storybook-dev` owes the builder/config fix (its own wrapper `build-storybook.mjs`
is not the kickoff's gate — the gate is the raw CLI, and it is RED); `pixel-measure` owes
`team/VISUAL_PARITY.md` and the completed baseline set. The `frontend/package.json` dev-dep edit is
the announced one-owner hand-off; no `ui-visual` component was touched.

**Two defects found while verifying (measured here, owners named):**

1. **~~`frontend/package.json` declares `"build-storybook"` twice~~ — WITHDRAWN on re-measure (same
   pass).** The two hits are in **different namespaces**: `bin.build-storybook →
   .storybook/build-storybook.mjs` (line 6) and `scripts.build-storybook → "storybook build"`
   (line 17). A `bin` map is not a duplicate of `scripts`, so nothing is shadowed and
   `npm run build-storybook` runs the raw CLI — which is now GREEN (§21). The first write of this row
   read two `grep -n` hits as one JSON key. Raw re-read: `sed -n '1,20p' frontend/package.json`.
2. **`frontend/storybook-static/` (36 MB) and `frontend/tests/baselines/` (5.7 MB) are untracked and
   in no `.gitignore`** (`grep -n storybook .gitignore frontend/.gitignore` → 0 hits). As both seats
   keep writing, these are the two trees a `git add -A` will sweep into a docs commit.
   Owner: whoever commits them next (or one `.gitignore` line each).

**Watch item for the next pass (carried, not resolved):** `team/PHASES.md` §20 notes a second
`boss-bot` (pid 20240, same prompt) was live at 22:08 and could append a duplicate §20 — a second
`## 20.` heading is the tell, and the fix is one heading, not a rewrite.

---

## 10. Rev 12 — `boss-bot`'s close-out (§22), and the state re-measured after it

**The close-out exists.** `team/PHASES.md` **§22** (file 140,255 B / 1,843 lines at read), commit
`b765f3b` = remote tip = local HEAD. Its declaration, verbatim in substance: *DONE* — the branch builds
clean from a HEAD checkout (`next build` EXIT 0, `out/` 9.7 M), is live (`https://loop-gpt.cyou` HTTP
200), the P2 gate is green, the a11y + desktop e2e suite exists, P6's measurement lane landed all
three named artifacts, Storybook builds to a 31-entry index, and the **P5 gate now exists on disk**.
*NOT done, each with an owner*: the P5 phone fix (not landed, gate RED), the gate's two phone
projects (absent from the tracked config), `visual-parity.spec.ts`, `PERF_P1.md`, `RELEASE_P1.md`,
`UI_MOBILE_WEB_ui-visual.md` (MISS), the deployed `revision:"unknown"`, ~20 §10 stories.

**Re-measured by `hr-bot` right after it** (this is the roster's job — a close-out is a claim):

| what | measured now | owner |
|---|---|---|
| HEAD / remote | `b765f3b` == `origin/release/owned-staging-20260917` | — |
| the P5 gate spec | **still does not parse** — `ts.createSourceFile(…).parseDiagnostics.length` → **6** (line 149 `',' expected`; line 154 ×4). Line **141 is fixed** since §22.1 (now `…JSON.stringify(b) } as any)`), so 1 of its 3 syntax defects is closed; §22.1's other two (149/154) stand | `qa-verify` (pid 59476, alive) |
| `ui-visual`'s fix | on disk as an **uncommitted** working-tree diff: `Composer.tsx` +6/−1, `globals.css` +7/−2 (`git diff --stat`); `team/UI_MOBILE_WEB_ui-visual.md` **MISS** | `ui-visual` (pid 63084, alive) |
| §22.3's owed list | unchanged: `pixel-measure` → `visual-parity.spec.ts`; `storybook-dev` → ~20 stories + the `frontend/package.json` scripts/devDeps + one gate line; `qa-verify` → clean-step recipe, real runner name, the spec defects | per line |

**Roster reading:** both seats the roster hired are live on exactly the rows §22.3 owes, and the two
rows on the head of the critical path (the fix and the gate) have named, running owners. Nothing in
§22.2 is owed without an owner — the roster's own bar.
