# P0 KICKOFF — Loop GPT production-ready pass (from hr-bot)

Team: Arch Lead, Ui Visual, Core Dev, Qa Verify, Boss Bot, Hr Bot, Research Scout, Code Review,
**Mobile Dev, Ops Release, Perf Eng** (hired this pass). Durable channel = this `team/` directory;
the desktop room is for coordination only.

## The directive (user, verbatim intent)
Track the project end to end. Make it production-ready. Polish it and change the UI so it reads more
human. Fix the logical errors. Close **all** pending tasks. The UI is not accepted — rebuild it to the
standard of the frontier products (Claude / ChatGPT / Grok): **fast and snappy**, best-in-class
experience. Hire whatever roles the work needs. Orchestrate the whole thing.

## Two hard constraints you must not re-litigate
1. **Only two live worker models exist right now** (`TEAM_ROSTER.md` §1): `hf-dsv41` /
   `DeepSeek-V4.1-Flash-Abliterated` and `qwen3-cyber` / `Qwen3.8-27B-Uncensored-Cyber`. The HF
   router group and the Azure foundry are `402`/`401` and dead. `arch-lead`, `boss-bot` and
   `research-scout` were pointed at the dead router and have been repinned — if your own turn fails with
   `402`, report it in one line rather than retrying forever.
2. **Evidence or it did not happen.** Paste the raw command beside the raw result (byte size, sha256,
   HTTP status, test count). `docs/PROGRESS.md` is the source of truth for shipped-vs-not;
   `AUDIT_REPORT.md` §6/§8/§10 and `docs/GAP_REGISTER.md` are the gap list.

## Phase roadmap

### P0 — Land the in-flight work (hours)
Four items are sitting uncommitted in the working tree, half-finished. Finish, gate, commit.
- `ui-visual` (owner of `frontend/app/chat/hooks.ts` + `Composer.tsx`): complete §8-40 (composer
  connector chip, `useWorkspaceConnections`), §8-44 (hands-free voice mode, `useVoiceMode`), §8-45
  (server Kokoro read-aloud engine + the `ttsEngine` preference), and the Appearance settings tab
  (`components/settings/AppearanceTab.tsx`, wired in `SettingsPanel.tsx`).
- `core-dev`: confirm the `/api/tts` contract (`backend/src/routes/tts.ts` — text cap 4000, audio
  bytes or `{url}`) and that the §8-45 client matches it. Do not edit `hooks.ts`; hand changes to
  `ui-visual`.
- Gates before each commit, in `frontend/`: `npx tsc --noEmit`, `npm run lint`, `npm test`,
  `npx playwright test`, `npm run build`. One commit per item, message referencing the §8 number.
- `qa-verify`: re-run the browser gate on the committed revision; `code-review`: static-pass the bytes.
- **Exit:** clean tree, one commit per item, gates green, deployed, `team/P0_CLOSEOUT.md` written by
  `boss-bot` with the commit hashes.

### P1 — Close the launch gaps (this cycle)
- `perf-eng`: baseline FIRST (route bundle KB gzip, TTFB, first-token latency, LCP/CLS) →
  `team/PERF_P1.md`, then the fixes with a before/after number each.
- `ops-release`: DB restore rehearsal (needs `DATABASE_URL`); execute the Stripe decision (turn it on
  per `docs/STRIPE_LIVE_CHECKLIST.md`, or freeze an explicit free-only state); the first marketplace
  OAuth live smoke (Figma); observability confirmed by a deliberately-thrown test error; an uptime probe
  on `/healthz`. One line of evidence each in `team/RELEASE_P1.md`.
- `qa-verify`: the GAP-003 axe contrast sweep on the dark theme (serious+ violations, listed with
  element + ratio).
- `research-scout`: which frontier patterns (Claude / ChatGPT / Grok) §8 still lists as missing, each
  with a source; feeds `ui-visual`.

### P2 — Frontier-parity UI rebuild
- `ui-visual` builds the accepted list from P1 recon; `arch-lead` holds the contract for any new
  surface; `mobile-dev` mirrors the accepted IA into `mobile/` (GAP-070) and starts GAP-049.

### P3 — Independent verification
- `qa-verify` (dynamic) and `code-review` (static) on the FROZEN revision — both report the revision
  hash, so "green" refers to specific bytes. `perf-eng` re-measures after the rebuild.

### P4 — Release
- `ops-release`: migration state, deploy, `/healthz` read-back of the served revision, tag.
  `boss-bot`: close-out, roster + docs updated, declare.

## Channel rules
- One owner per file. `hooks.ts` has ONE owner (`ui-visual`) and currently two writers — hand off.
- Short room messages: claim, hand off, or report a real result. No status theatre.
- A blocked seat says so in one line, naming the unblocker.
