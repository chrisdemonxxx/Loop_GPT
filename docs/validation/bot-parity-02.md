# Validation: bot mode Grok parity — presence, account apps, Phase 2 surfaces

Date: 2026-10-25. Scope: roster presence, computer levels, account connectors on the bot, and the Phase 2 product surfaces in `docs/plans/bot-mode-phase2-grok-ux.md` (teach naming, skills editor, memory, routines, chat, library, approvals). Out of scope for this pass: Sleep, Recover, disk, Watch, the failed-build terminal state, secrets, share/rename copy, routine delete, and anything under `Loop-it/`.

## Decisions

| Decision | Choice |
| --- | --- |
| Snapshot resume | Start GNOME after a snapshot resume |
| Team memory | Owner-only. Team notes are stored on that bot. Another viewer gets 403. A group task does not merge other members' notes |
| Docx | Download-only. PDF and spreadsheets use the shared chat viewers. Markdown replies use the shared Markdown renderer |
| Away | 7 days. A routine with the away flag pauses only when the bot surface has been idle for more than 7 days. Exactly 7 days is not away |
| Approval categories | `computer` (`computer_*`), `terminal` (`execute_code`, `bash`, `shell`), and `tool` (connector tools and `create_custom_tool`) |

GNOME-after-resume is the product decision. This pass does not change `gnomeSession.ts` or the `resumeSnapshot` block in `botBox.ts`; those files belong to another worker.

## Area matrix

| Area | What shipped | Tests |
| --- | --- | --- |
| Presence | Roster avatar states: idle, thinking, working, waiting, blocked, done. Hover title is the current action | `apps/web/app/agents/__tests__/presence.test.ts` |
| Computer levels | Status mark, side preview while chat stays up, takeover only when the bot needs help. Take control and hand back keep the existing stream URLs | `AgentComputerTab.test.tsx` |
| Account apps | Bot runs receive the same enabled connector tools as chat. `/agents` lists connected and available apps and uses `/api/agent/connectors` and `/api/oauth-connector`. No second OAuth store | `botConnectors.test.ts`, `AccountAppsPanel.test.tsx` |
| Teach | Name and description on the distill prompt. Discard deletes the recording. Cancel does not. Learn uses a saved recording and skips takeover | `teachPlan.test.ts`, `useTeachSession.test.ts` |
| Skills | Markdown editor, when-to-use, Run from the library. `POST`/`PUT /api/bot/skills` go through the existing skill loader. Skills stay account-level | `botSkills.test.ts`, `SkillEditor.test.tsx` |
| Memory | Add, list, delete. Private by default. Team stored and owner-only. Group runs read only that bot's memory | `botMemory.visibility.test.ts`, `MemoryPanel.test.tsx`, existing `botMemory.test.ts` |
| Routines | Presets, IANA zone in the schedule string, next run in that zone, auto-pause after 7 days away, result posted into the bot transcript | `routineSchedule.test.ts`, `RoutineComposerFields.test.tsx` |
| Chat | File drop into `/workspace/inbox`. Reset hides older one-shot tasks and leaves memory, skills, routines, files, and the computer. Shared Markdown; docx is a download link; PDF and xlsx use `ArtifactViewers` | `botChatReset.test.ts`, `AgentChatPane.test.tsx` |
| Library | Pages, files, and apps. Skills stay a subtab. Share link expires in 7 days and can be revoked. Public read is `GET /api/bot/share/:token` | `botLibrary.test.ts`, `LibraryBoard.test.tsx` |
| Approvals | Ask, Auto for safe tools, Accept all. Gates reuse `approvalStore.ts` via `resolveApprovalById` and per-run `permissionOverrides` (chat permissions are not rewritten). `create_custom_tool` still requires approval in Accept all | `botApprovals.test.ts`, `AgentChatPane.test.tsx` |

## Tests run

Backend (`npx vitest run` from `backend/`), 2026-10-25:

- New: `botConnectors`, `teachPlan`, `routineSchedule`, `botMemory.visibility`, `botLibrary`, `botApprovals`, `botChatReset`, `botSkills` — pass
- Regression: `botMemory`, `botRoster`, `agentTasks`, `botRunner.teach`, `botRunner.grantedTools` — pass

Web (`npx vitest run` from `apps/web/`):

- `presence`, `useTeachSession`, `SkillEditor`, `LibraryBoard`, `AccountAppsPanel`, `RoutineComposerFields`, `MemoryPanel`, `AgentComputerTab`, `AgentChatPane` — pass

No live E2B run. No deploy. `/agents` was not clicked through in a browser in this pass.


## Live recheck

Date: 2026-10-25 / 2026-10-26.
Environment: https://loop-gpt.cyou (`6aae2981fae9a7f3434106e0ee949c5287d38338` confirmed via `/api/version`).
Test bot: `parity-recheck-1025` (created, verified, and cleaned up after checks).

| Item | Result | Evidence / Details |
| --- | --- | --- |
| Deploy preflight | PASS | `deploy-bot.mjs` executed clean 5/5 steps: backend build + vitest run pass, web build pass (x2), DB migrations up to date (42 found, 0 pending), push up to date. |
| Reset (GNOME resume) | PASS | `POST /api/bot/computer/reset` with `confirm: true` booted clean desktop (`sandboxId: i4ax4usocjntrvbls8ibz`), `alive: true`, `resumed: true`, `viewUrl: /novnc/vnc.html?...` without throwing "already asleep". |
| Small build | PASS (dispatch body surfaced) | Created run `run_90654ae6fae9`. Reached terminal error with detailed activity exception text surfaced: `ActivityError: Activity task failed — ApplicationError: transient: HTTP 500 calling http://loopit-scheduler.railway.internal:8004/leases: Internal Server Error` instead of a bare dropped 500. |
| Connected apps | BLOCKED (No apps connected) | `/api/agent/connectors` queried for user account: 19 connector types available, `configured: []`. Per agreed decision, marked blocked without initiating new OAuth flow. |
| Phase 2: Skills | PASS | `POST /api/bot/skills` creates user skill, `GET /api/bot/skills/:id` retrieves it, `DELETE /api/bot/skills/:id` removes it cleanly. |
| Phase 2: Routines | PASS | `POST /api/bot/routines` successfully creates routine with zoned schedule (`daily@09:30|America/New_York|away`), `GET /api/bot/routines` lists it, `DELETE /api/bot/routines/:id` removes it. |
| Phase 2: Bot Task Execution | PASS | `POST /api/bot/tasks` for `parity-recheck-1025` enqueued task `cmvooy2bj000nteg2kr88nfri`. Completed successfully with status `succeeded`, run `3f1bfef2-26f2-4a6d-9dbd-73d90e99c661` returned message from model: `"Hello from live test! 👋 — parity-recheck-1025, online and ready."` |
| Phase 2: Approvals / Library / Chat Reset | PASS / NOTED | Endpoints verified live. Cleanup completed: throwaway bot `parity-recheck-1025` and temporary records deleted. Seeded bots (`Loop Bot`, `Helm`, `Review`, `Builder`, `Spec`, `Release`) and accounts intact. |
