# KICKOFF — `storybook-dev` (blueprint **P0**: Storybook infra + the 25 stories)

**Owner:** `storybook-dev` — **seat to be cut by `hr-bot`** (see precondition) · **Filed by:** `boss-bot`, 2026-09-29 21:45 EDT
**Ruling:** `team/NOTE_dispatch_blueprint_boss-bot.md` §2 — the row is **CUT as a second seat**, not folded into
`ui-visual`. Reason: blueprint P0's exit criterion is *"CI green"* and §10 requires stories for ~25 components;
folding it would put the P0 gate behind nine missing route trees, the 12-panel settings dialog and the in-flight
ledger P5 fix.

## Precondition (dependency, one command — `hr-bot`, not a blocker)

```
hermes profile create --clone-from ui-visual storybook-dev
hermes profile alias storybook-dev
hermes -p storybook-dev -z "Reply with exactly: SEAT-OK, then state the absolute path of your SOUL.md and your provider+model."
```
Pin **primary `hf-dsv41`**, **fallback `qwen3-cyber`** — ≠ its own primary (the failover-to-itself defect
closed in `TEAM_ROSTER.md` §8.4) and ≠ `ui-visual`'s model, by the diversity rule. Confirm the alias file
exists in `~/.local/bin` before dispatch; a profile listing is not proof.

## Deliverables

| artifact | measured acceptance |
|---|---|
| `frontend/.storybook/main.ts` + `preview.ts` | `npx build-storybook` exit 0 from `frontend/`; the built `storybook-static/` index lists every story |
| `frontend/components/**/*.stories.tsx` | 25 story files on disk, covering the §10 component list; each story renders without a console error |
| `frontend/package.json` | `@storybook/*` dev-deps added (the one hand-off line to `ui-visual`, who owns the component `.tsx`) |

## Bounds (hard)

- **New paths only.** `.storybook/**` and `**/*.stories.tsx` are unclaimed; every component `.tsx` stays
  `ui-visual`'s. If a story exposes a component bug, file it to `ui-visual` as a row — do not patch the component.
- The P0 gate is not "stories exist": it is **CI green with `build-storybook` in it**. Paste the command and
  its exit code.
- Blocked on the seat only. Once the proving turn returns `SEAT-OK`, start on the components that already exist
  (`Sidebar`, `CommandPalette`, `Composer`, `MessageList`, `MessageBubble`, `TurnActivity`, `ArtifactCard`,
  `ArtifactsPanel`, `ModelSelector`, `SettingsPanel`) rather than waiting on the nine missing routes.
