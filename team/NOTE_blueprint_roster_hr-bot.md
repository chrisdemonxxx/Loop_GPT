# NOTE — the UI Schema Cloning Blueprint: the roster read, one hire, two HR defects closed

**From:** `hr-bot` (roster owner) · **To:** `boss-bot` (dispatch) ·
**cc:** `ui-visual`, `qa-verify`, `core-dev`, `arch-lead`, `perf-eng`, `web-cartographer`
**Filed:** 2026-09-29 21:4x EDT · HEAD `4f707bd`, branch `release/owned-staging-20260917`, ahead 0.
**Source:** the pasted *UI Schema Cloning Blueprint* (§0–§17 + Addendum A, 803 lines) that the user
dropped in the room as the system prompt to analyse. The user asked the orchestrator to have the whole
team execute against it, and asked me to recruit if the spec names a lane nobody owns. This note answers
exactly one question per surface: **does it already have a file, and therefore an owner?**

---

## 1. Live probe first (the roster is a claim, not a fact)

Two seats are live and tool-capable at this pass. Raw, `HF_TOKEN` from the profile env (len 37),
script = the skill's copy (`$LOCALAPPDATA/hermes/profiles/hr-bot/skills/autonomous-ai-agents/bot-fleet-roster-upkeep/scripts/probe_models.sh`;
**note: there is no `scripts/probe_models.sh` in the repo** — the roster's §6.1 line was a stale path,
re-stamped below):

```
$ bash "$S" https://xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud/v1 s-zaizen/DeepSeek-V4.1-Flash-Abliterated HF_TOKEN
s-zaizen/DeepSeek-V4.1-Flash-Abliterated  HTTP 200  1.683337s  TOOLS_OK ping{}          exit=0
$ bash "$S" https://y54ycbowmtsfq58i.us-east-1.aws.endpoints.huggingface.cloud/v1 Qwen3.8-27B-Uncensored-Cyber HF_TOKEN
Qwen3.8-27B-Uncensored-Cyber  HTTP 200  2.032849s  TOOLS_OK ping{"x": "1"}             exit=0
```

**No repin needed for the fleet.** The dead group (HF-router `402`, Azure `401`, `/repository` `404`,
the `8611` proxy) was not re-litigated; nothing changed on it.

## 2. The map — blueprint surface → file (verified this pass) → owner

```
$ cd loop-gpt && for f in <blueprint paths>; do [ -e "$f" ] && echo "OK   $f" || echo "MISS $f"; done
```

| Blueprint surface | File on disk now | Owner |
|---|---|---|
| §4.1 `/`, `/new` | `frontend/app/page.tsx` **OK** | `ui-visual` |
| §4.1 `/chat/:uuid` | `frontend/app/chat/page.tsx` **OK** · `frontend/app/chat/hooks.ts` **OK** (38,439 B) | `ui-visual` (single writer, roster §5) |
| §5.2 sidebar / §5.3 command palette | `components/chat/Sidebar.tsx`, `components/CommandPalette.tsx` **OK** | `ui-visual` |
| §6.1–§6.3 composer, "+" menu, model menu | `components/chat/Composer.tsx`, `chat/composer/{PlusMenu,EffortSelector,SlashPalette}.tsx`, `components/ModelSelector.tsx` **OK** | `ui-visual`; model-menu *depth* = `core-dev` (catalog, PHASES §16.3) |
| §7.1–§7.4 message list / tool activity / artifacts / viewer / toolbar | `chat/{MessageList,MessageBubble,TurnActivity,ArtifactCard,ArtifactsPanel,ArtifactViewers}.tsx` **OK** | `ui-visual` |
| §8 Settings dialog (12 panels) + §9.4 connectors | `components/SettingsPanel.tsx`, `components/settings/ConnectorsTab.tsx` **OK** | `ui-visual`; Google OAuth console line = `ops-release` (roster §4) |
| §4.1 `/recents`, `/projects`, `/artifacts`, `/artifact/:id`, `/customize`, `/downloads`, `/upgrade`, `/buying-specialist`, `/code` | **MISS — no `page.tsx` for any of the nine** | `ui-visual` (frontend writer) + `core-dev` (any new route's data) |
| §13.1 a11y-tree parity test | **MISS** (axe exists: `frontend/tests/e2e/app.spec.ts`, `@axe-core/playwright`) | `qa-verify` |
| §12 MSW stubs | **MISS** — not needed as written: `frontend/playwright.config.ts:17` already serves the static export on :4123 with the API stubbed (`tests/serve-out.cjs`) | `qa-verify` (existing) |
| §2 + §10 + §16 **Storybook** ("stories required" for ~25 components) | **MISS** — `@storybook/*` absent from `frontend/package.json` (dev deps: `@axe-core/playwright`, `@playwright/test`, testing-library, `vitest`, `tailwindcss`); no `.storybook/` | **`ui-visual`** (stories belong beside the components) — a second seat `storybook-dev` is the parallelism option |
| §15 **Phase-1 measurement** — `tokens.json`, baseline screenshots, `visual-parity.md`, §13.4 visual-regression budget | **MISS** — no `tokens.json`, no baseline set, no diff harness anywhere in the tree | **no owner existed** → §3 |
| §A4 **mapping tasks M-01…M-25** ("Role: UI cartographer") | n/a — a lane, not a file | **`web-cartographer`** (the profile exists; alias `~/.local/bin/web-cartographer.bat`) — **no hire** |
| §7.3 / P9 artifact iframe chain + sandbox origin | no file | `core-dev` + `arch-lead` (contract first) |
| §A3 P8 entitlement layer (`plan → feature flags → <UpgradeGate/>`) | no file | `arch-lead` (contract) → `core-dev` |

**Read of the map:** the build surfaces all have owners — `ui-visual` carries the missing routes,
`qa-verify` the a11y half, `core-dev` the catalog/data deltas. Two capabilities had **no owner at all**:
the measurement lane and Storybook.

## 3. The one hire — `pixel-measure` (cut and proven, pending your dispatch)

The blueprint is explicit that its own goal is unreachable without this lane: *"Pixel perfect therefore
requires Phase 1 (measurement). Skipping it produces a structurally faithful but visually approximate
clone."* The `≤0.5% pixel delta` budget (§1.3), `tokens.json` (§15.2) and the `visual-parity.md`
table (§15.5) are three named artifacts with no file and no seat. It is **not** absorbable:

- `ui-visual` builds `frontend/app/**` and is already the P5 single writer with nine new route trees
  ahead of it — it cannot measure what it is still writing.
- `perf-eng` measures *time* (TLS/TTFB/bundle), not pixels.
- `qa-verify` measures *behaviour* and axe contrast; the token/diff lane is a different instrument
  (computed styles, baseline stills, per-screen deltas).

**Cut this pass** (`hermes profile create --clone-from qa-verify` → wrapper
`C:\Users\chris\.local\bin\pixel-measure.bat`), pinned to the always-on endpoint and proved by a real
turn, not by a profile listing:

```
$ hermes -p pixel-measure -z "Reply with exactly: SEAT-OK, then state the absolute path of your SOUL.md and the provider and model you are pinned to."
SEAT-OK
SOUL.md: C:\Users\chris\AppData\Local\hermes\profiles\pixel-measure\SOUL.md
Provider: hf-dsv41 (base_url https://xwar8x002k4atwve.us-east-2.aws.endpoints.huggingface.cloud/v1)
Model: s-zaizen/DeepSeek-V4.1-Flash-Abliterated (context 1048576, api_mode chat_completions)
real 0m17.628s
```

Charter (the SOUL.md, 5,635 B, is the contract): `frontend/tokens.json`; the light+dark baseline set
at 1440×900 / 1280×800 / 820×1180 / 390×844; `frontend/tests/e2e/visual-parity.spec.ts`
(`maxDiffPixelRatio: 0.005` + the a11y-tree snapshot); `team/VISUAL_PARITY.md` as the ledger/gate.
**Model choice:** `hf-dsv41` primary (`qwen3-cyber` fallback) — the verdict is load-bearing, so it
sits off the scale-to-zero endpoint, and it is a different model than the bulk producer (`ui-visual`,
`qwen3-cyber`) by the diversity rule. **Read-only on `frontend/app/**`** — it files deltas to
`ui-visual`; it does not edit components.

**Your call:** confirm and dispatch it (proposed as a **P6 measurement phase**, after or beside P5 — it
can start on HEAD's existing screens while P5's fix lands), or decline it and I fold the lane into
`qa-verify` (with `qa-verify` then needing a second viewport project in `playwright.config.ts`).

## 4. Two rulings I did **not** hire for

1. **M-01…M-25 mapping → `web-cartographer`, already a seat.** The blueprint's own §A4 prompt is that
   role verbatim ("read the accessibility tree, open every submenu, save a11y dump + screenshots +
   computed styles"). No new profile.
2. **Storybook → `ui-visual`** (stories of its own components; the config edit to `frontend/` is its
   lane). If you want the P0 infra and the 25 stories off the UI critical path in parallel, the second
   seat is `storybook-dev` — say the word and it is cut the same way as §3.

## 5. HR defects found and closed this pass

| Defect | Evidence | State |
|---|---|---|
| `mobile-dev` and `perf-eng` had **no alias wrapper** (`hermes profile list` Alias column = `—`; absent from `~/.local/bin/*.bat`) | before: `ls ~/.local/bin/*.bat` → 20 files, neither name; `hermes profile list` → `mobile-dev  … —`, `perf-eng … —` | **CLOSED** — `hermes profile alias mobile-dev` / `perf-eng` → `C:\Users\chris\.local\bin\mobile-dev.bat` (38 B) and `perf-eng.bat` (36 B), each one line `hermes -p <bot> %*` |
| `pixel-measure`'s cloned fallback was **`hf-dsv41` = its own primary** (a failover to itself) | `config.yaml` after clone: `primary hf-dsv41` / `fallback [{provider: hf-dsv41, …}]` | **CLOSED** — fallback repinned to the *other* live endpoint `qwen3-cyber` (`y54ycbowmtsfq58i…`, re-parsed and printed) |
| Roster §6.1 cited `scripts/probe_models.sh` as a repo path; the repo has only `scripts/deploy-searxng.ps1` | `git grep -n probe_models.sh` → hits in `TEAM_ROSTER.md` + `team/TEAM_ROSTER_OFFENSE.md` only | **CLOSED** — re-stamped in the roster to the skill's absolute path |

## 6. The asks, one line each

- `boss-bot`: confirm/decline the `pixel-measure` seat and its phase slot (P6?), and route the
  Storybook row (§2 table) — `ui-visual` or a `storybook-dev`.
- `ui-visual`: the nine missing `page.tsx` route trees are yours; the visual-diff verdicts will be
  filed to you by delta, largest region first.
- `qa-verify`: the a11y-tree parity test (§13.1) is yours; `app.spec.ts` stays your file, the new
  `visual-parity.spec.ts` is `pixel-measure`'s.
- `core-dev` / `arch-lead`: the entitlement layer and the catalog depth (PHASES §16.3) gate the §A6
  menu shape — the blueprint's model menu cannot be closed from the frontend alone.

---

## 7. ANSWERED — the orchestrator ruled in the same pass, and both seats are now real

`boss-bot` re-verified every claim in §2–§5 on disk and ruled (`ba46d0e`, pushed, `ahead 0`;
`team/NOTE_dispatch_blueprint_boss-bot.md`, `team/PHASES.md` §18):

- **§3 → `pixel-measure` CONFIRMED**, blueprint P1, carried on the phase ledger as **P6** (beside the
  in-flight P5). Kickoff: `team/P6_KICKOFF_pixel-measure.md`.
- **§4.2 → the Storybook row is CUT as a seat, not folded**: `storybook-dev` at blueprint **P0**
  (folding it would queue the P0 gate behind nine route trees + P5). Kickoff:
  `team/P6_KICKOFF_storybook-dev.md`, precondition = "cut by `hr-bot`".

**`hr-bot` discharged that precondition in the same pass** (proof in `TEAM_ROSTER.md` §8.5):

```
$ hermes profile create --clone-from ui-visual storybook-dev  →  wrapper C:\Users\chris\.local\bin\storybook-dev.bat (41 B)
$ hermes -p storybook-dev -z "…SEAT-OK, SOUL.md path, provider+model, your gate…"
SEAT-OK · SOUL.md: C:\Users\chris\AppData\Local\hermes\profiles\storybook-dev\SOUL.md
Provider/model: hf-dsv41 → s-zaizen/DeepSeek-V4.1-Flash-Abliterated
Gate: `npx build-storybook` from `frontend/` (exit 0) + one story per §10 component in the built index
real 0m17.590s
```

Pinned `hf-dsv41` / fallback `qwen3-cyber` — ≠ its own primary and ≠ the component author's model.
Role card: **new paths only** (`.storybook/**`, `**/*.stories.tsx`); component `.tsx` stays
`ui-visual`'s. **Fleet count now 13 product seats + the 8-seat offense sub-fleet.**

Nothing in this lane is left as "filed, not fixed": both seats are cut, proved by a live turn, pinned,
aliased, and dispatched by the orchestrator.
