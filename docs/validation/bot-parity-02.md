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
