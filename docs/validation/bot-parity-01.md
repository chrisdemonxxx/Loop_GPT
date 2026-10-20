# Validation: bot mode Grok parity — Phase 1 (1A–1G) + E2B feel blockers

Date: 2026-10-20. Scope: LoopGPT bot mode (`/agents`, team-bot UI, `botBox` /
`botRunner`, noVNC proxy, desktop gateway) end-to-end after Phase 1 fixes and
the E2B Grok-feel blocker plan. Reference: Grok Bot 0.71.2. Out of scope:
`.opencode/`, `.bots/`, `bot-console/`.

## Contracts (frontend ↔ backend)

| Surface | Contract | Status |
| --- | --- | --- |
| Wake | `POST /api/bot/computer/wake` (optional `taskType`); `GET /api/bot/computer` read-only | Wired in api-client + AgentComputerTab / BotFilesPanel |
| Teach skill | Run event `{ type: "skill_saved", skillId, name? }` | Emitted by botRunner; useTeachSession waits on it |
| noVNC WS auth | `POST /api/bot/computer/ws-token` `{ sandboxId }` → `{ token, expiresIn, queryParam: "token" }`; connect `…/websockify?token=` | api-client `mintNovncWsToken`; BotScreen mints before RFB |
| Event cursor | `GET /api/bot/runs/:runId/events?after=<seq>` | streamBotRun resumes with `after=` on reconnect |

## Area matrix

| Area | Unit / integration (no live E2B) | Live E2B still needed |
| --- | --- | --- |
| Persistent box lifecycle (pause-on-timeout, wake, lease extend) | Wake route is side-effecting POST; GET status-only. Reaper unit tests (stale kill, freshness skip, dead sandbox clear). GNOME-first boot awaits swap or fails loudly (no XFCE first paint). | Cold boot / resume latency, provider pause/resume, template GNOME bake |
| Box files | `boxFiles` CommandExitError → not_found; JS sort; realpath jail | Read/write/delete on a real `/workspace` |
| GNOME desktop template | Template + `verify.mjs`; `gnomeSession` unit tests; `createDesktop` requires same `E2B_DESKTOP_TEMPLATE` | Template build/deploy; Chrome + terminal icons on first boot |
| Resolution / clicks | Fallback + tool clamps + `buildComputerSystemAddendum` use live/session 1366×768 (not hardcoded 1024×768) | Grounding probe on a real E2B screenshot |
| noVNC proxy | Signed token mint/verify unit tests; Origin / view-only / buffer covered in novncProxy tests | Browser RFB through websockify with minted `?token=` |
| Named bots | Shared types (`botId`, persona/memory attach); `buildGrantedTools` includes `remember_fact` | Persona + memory round-trip on a live run |
| Routines | Pause/delete-during-run stick on complete/fail (integration); dead-letter resume via `setRoutinePaused` | Full schedule fire + UI pause/resume |
| Teach | useTeachSession: `skill_saved` (not timer), dead_letter, reset, cancel | Record → distill → skill file on a real desktop |
| Wake | Client `wakeBotComputer`; AgentComputerTab probes GET then wakes on expand | Interactive wake from asleep box |
| WS token | Client path/shape; BotScreen appends token before connect | Desktop app Bearer upgrade with token query |

## Tests added / extended (1G + feel blockers)

**Backend (unit)**

- `botRunner.execute.test.ts` — executeBotTask happy path (chat-only + fake ComputerSession / E2B attach miss)
- `botBox.reaper.test.ts` — reap stale / skip fresh / clear dead pointer
- `gnomeSession.test.ts` — GNOME missing fails loud; shell wait; desktop launcher seed; template id
- `computerResolution.test.ts` — fallback 1366×768; addendum embeds live size
- `computerTools.test.ts` — clamps to session screen; `computerToolsForScreen` descriptions
- Existing (not duplicated): `boxFiles.test.ts` CommandExitError; `botRuns.seq.test.ts` after=800; `botRunner.grantedTools.test.ts`; `novncProxy.test.ts`

**Backend (integration)**

- `agentTasks.integration.test.ts` — pause-during-run on complete/fail; delete-during-run on complete

**Frontend**

- `useTeachSession.test.ts` — skill_saved, dead_letter, reset, cancel
- `useRunStream.test.ts` — wait-for-run, no hot poll loop, stream error surface
- `streamBotRun.test.ts` — reconnect with `?after=<seq>`; 404 retry then error

**Live smoke**

- `backend/scripts/bot-live-smoke.mjs`
  - Default: **skips cleanly (exit 0) when `E2B_API_KEY` is unset**.
  - `BOT_LIVE=1`: **fails (exit 1) when key or `E2B_DESKTOP_TEMPLATE` unset**; requires `BOT_SMOKE_API_URL` + `BOT_SMOKE_TOKEN`.
  - With key: create → stream → pause → connect **same sandbox id** → kill.
  - With API: wake, ws-token, file R/W, computer task, takeover, teach enqueue + skills list, wake same id.

## Live run results (this environment)

| Gate | Result |
| --- | --- |
| `E2B_API_KEY` in user env / `backend/.env` | **Set** (from `e2b auth login` → `~/.e2b/config.json` projectApiKey) |
| `E2B_DESKTOP_TEMPLATE` | **`i2xxeb90xf7iskqkerzi`** (`loop-gnome-desktop`) |
| Railway staging (`loop-gpt-owned-staging-20260917`) | E2B vars synced; backend Online. `railway up` of local code **blocked** (workspace trial/billing). Live Grok-feel code run via `railway run` + public Postgres proxy on `127.0.0.1:4000`. |
| Provider smoke (create/stream/GNOME/pause/wake-same-id) | **PASS** |
| `BOT_LIVE=1` API smoke (wake, ws-token, files, computer task, teach enqueue, wake-same-id) | **PASS** (2026-10-20) |
| Takeover while run active | Soft-skipped when short smoke goals finish before poll (409 not active) |
| Browser RFB / desktop gateway | **Not yet** interactive-proven |
| Teach → `skill_saved` → library → rerun | Enqueue **PASS**; full distill needs operator demo (frame-only) |

**Bug found live:** `Sandbox.create({ template })` ignored the template and booted stock XFCE. Fixed to `Sandbox.create(template, opts)` in `botBox.ts` / `e2bDesktop.ts`.

**Verdict:** Provider + API live gates pass against local Grok-feel backend + Railway DB/E2B. Deploying that code to Railway still needs a billing-capable `railway up` or git push to the linked repo.

### Teach limit (honest)

noVNC cannot capture raw local input into the teach timeline. Teach records **screen frames only**; distill uses that frame timeline. A custom input-capturing client is out of scope for this plan.

## How to re-run

```bash
# Backend unit (bot-focused + feel blockers)
cd backend && npx vitest run src/services/__tests__/botRunner.execute.test.ts \
  src/services/__tests__/botBox.reaper.test.ts \
  src/services/__tests__/gnomeSession.test.ts \
  src/services/__tests__/computerResolution.test.ts \
  src/services/__tests__/boxFiles.test.ts \
  src/services/__tests__/botRuns.seq.test.ts \
  src/services/__tests__/botRunner.grantedTools.test.ts \
  src/services/__tests__/novncProxy.test.ts \
  src/agent/__tests__/computerTools.test.ts

# Backend integration (needs loop_foundation_test)
cd backend && npm run test:integration -- src/services/__tests__/agentTasks.integration.test.ts

# Web team-bot hooks + streamBotRun
cd apps/web && npx vitest run app/components/team-bot/__tests__ app/lib/__tests__/streamBotRun.test.ts

# Live smoke — default skips without key
cd backend && node scripts/bot-live-smoke.mjs

# Live smoke — hard gate (fails without key/template/API)
cd backend && BOT_LIVE=1 E2B_API_KEY=… E2B_DESKTOP_TEMPLATE=… \
  BOT_SMOKE_API_URL=http://127.0.0.1:4000 BOT_SMOKE_TOKEN=… \
  node scripts/bot-live-smoke.mjs
```

## Remaining gaps

- Live E2B: set `E2B_API_KEY` + rebuild/verify GNOME template; run `BOT_LIVE=1` smoke; RFB in browser; full teach demo → `skill_saved`.
- Desktop app WS upgrade with Bearer + token (gateway) still needs interactive live proof.
- Phase 2 product gaps (computer Sleep/Recover/Reset UI, skills editor, memory UI, routine timezone schedules, attachments, approvals) — only after A–E live green; see `docs/plans/bot-mode-phase2-grok-ux.md`.
