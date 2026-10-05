# Validation: Grok-grade bot computer + teach mode (workstreams A–E)

Date: 2026-10-05. Branch: `release/owned-staging-20260917`.
Scope: smoother sessions, true-SSE realtime feed, one-command deploy,
futuristic dual-page UI, and teach mode (record → distill → Skill → automate).

## A. Smoother sessions
- `computerSession.start` boot sequence: staged `status` events (boot → stream →
  desktop prep), screen blanking disabled (`xset s off && xset -dpms 0 0`),
  **Chrome auto-launched** before the agent's first turn (Grok-style boot),
  and **true display geometry synced from the VM** (`xdpyinfo`) — coordinate
  tools now clamp against the real screen instead of static env values
  (`captureSilent` added for teach recording).
- Takeover pause window: `BOT_TAKEOVER_TIMEOUT_MS` (default 30 min, was 10).

## B. Realtime
- `frontend/app/lib/botSse.ts`: fetch-based SSE reader (Bearer-capable,
  EventSource can't authenticate) with bounded reconnect → DB-poll fallback.
- Admin console run feed is now one live socket (thought line, tool events,
  artifacts, frames) with a `● realtime / ● poll fallback` indicator.
- Live view: 16:10 aspect-ratio container, fullscreen link (noVNC's native
  toolbar), gradient-glass hero card with `LIVE` pulse and VM-minute meter.

## C. Deploy
- `scripts/deploy-bot.mjs`: one reviewed command = backend build+tests →
  frontend build → push → `railway connect postgres --tunnel-only` SSH tunnel
  → `prisma migrate deploy` → tunnel closed. Supervisor's migration preflight
  remains the fail-closed backstop.
- Packaging regression: `deploy/owned-staging/regressions.test.mjs` now
  asserts every supervisor-spawnable script appears in the backend image
  COPY line (12/12) — the `BOT_WORKER_ENABLED` missing-script class is dead.

## D. UI
- Shared component system (`frontend/app/components/bot/`): `EnqueueForm`
  (Task | 🎓 Teach toggle), `TaskQueueList`, `LiveComputerCard`, `FramesStrip`,
  `RunTimeline`, `SkillManager` — glass/gradient language, reused by the
  rebuilt `/admin/bot` and (via its own lib) `/agents`.

## E. Teach mode
- `kind: 'teach'` (computer required): phase 1 announces readiness; phase 1.5
  records the operator's demonstration as a screen-state timeline (frame
  every ~1.5s, cap 40) while takeover is active; phase 2 feeds a distilled
  ≤10-frame timeline to the model as real image parts and it writes a proper
  SKILL.md via `create_skill`.
- **Per-user skills** (chosen doctrine): `createUserSkill(…, ownerId)` writes
  `data/skills/<userId>/<id>/`, `loadSkillsForUser`, `loadAllUserSkills` (admin),
  `deleteUserSkillForUser`, `matchSkillsForGoal` (auto-suggest, confirm-before-
  apply — suggestions ride the enqueue response, nothing auto-attaches).
- Endpoints: `GET/DELETE /api/bot/skills[/:id]`, `GET /api/admin/bot/skills`
  (+ cross-user delete); enqueue accepts `skillId`, runner folds the skill's
  instructions into the system prompt and merges its tools into the allowlist.
- Frontend: admin console teach toggle + all-users skill grid; `/agents` gets
  a 🎓 Teach sheet, skills section with delete, and inline teach entry.
- Honest limitation (stated in-product): raw input capture during noVNC
  takeover isn't possible without a custom VNC client — teach records the
  screen-state timeline, which is what real demonstration systems use.

## Evidence
- Unit: **1258 passed (73 files)** — new: boot sequence order + Chrome-missing
  resilience + `parseScreenDimensions`, dynamic screen bounds, per-user skill
  ownership/isolation/trigger-matching/admin enumeration/delete scoping, zod
  `teach`/`skillId` validation.
- Integration: **29/29** on fresh postgres:16 (35 migrations) — queue suite +
  ownership + claim guard + budgets (updated to the free 5-min teaser
  doctrine), run/computer scoping, reservation lifecycle.
- Frontend: `next build` clean — `/admin/bot` 8.57 kB, `/agents` 12.7 kB.
- Deploy: this slice ships through `scripts/deploy-bot.mjs` itself (dogfood).

## Limits
- The teach E2E (real operator demo → distilled SKILL.md → one-click rerun)
  verifies next as a live session; the pipeline is otherwise fully covered.
- Admin-side skill "Run" button queues with the skill attached but does not
  yet pre-open a confirmation modal (the suggestion chips confirm explicitly).
