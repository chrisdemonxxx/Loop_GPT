# team/PHASES.md — Loop GPT phase ledger (owner: boss-bot)

ROOM POST (boss-bot, 2026-09-26 03:50 EDT): 5 phases on the board (P0..P4); P0 owner =
`ui-visual`; `frontend/` `npx tsc --noEmit` → `TSC_EXIT=0`. P0 is code-complete but
UNCOMMITTED — tree dirty (16 `git status --short` lines, roster says 13), and `team/P0_CLOSEOUT.md`
does not exist. `hooks.ts` stays `ui-visual`'s alone; `core-dev` hands over the `/api/tts` contract.

Written 2026-09-26 03:50 EDT from `team/P0_KICKOFF.md` (roadmap) + `TEAM_ROSTER.md` §4/§5,
then re-verified against the filesystem. Ground truth order: filesystem → `docs/PROGRESS.md` →
`AUDIT_REPORT.md` §6/§8/§10 + `docs/GAP_REGISTER.md`.

Legend — `SHIPPED` = a path was read AND a raw command result is pasted in §EVIDENCE below.
`OPEN` / `IN-FLIGHT` = no filesystem proof of done. A self-report is not evidence.

Repo: `C:\Users\chris\Desktop\Workspace\dev-projects\loop-gpt`, branch
`release/owned-staging-20260917`, HEAD `31cb496` (`git log --oneline -3` → `31cb496`,
`4a792a4`, `7d3016b`).

## 1. Phase board (P0..P4 — 5 phases)

| phase | owner | deliverable | acceptance | status |
|---|---|---|---|---|
| **P0** — land the in-flight work | `ui-visual` (sole writer of `frontend/app/chat/hooks.ts` + `components/chat/Composer.tsx`); `core-dev` owns the `/api/tts` contract, hands off — never edits `hooks.ts`; `boss-bot` owns this ledger + `team/P0_CLOSEOUT.md` | §8-40 composer connector chip (`useWorkspaceConnections`), §8-44 hands-free voice (`useVoiceMode`), §8-45 server Kokoro read-aloud + `ttsEngine` pref, Appearance settings tab — each finished, gated, one commit referencing its §8 number | clean tree; one commit per item; gates green in `frontend/`: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npx playwright test`, `npm run build`; committed revision re-run by `qa-verify` (dynamic) and static-passed by `code-review`; deployed | **IN-FLIGHT** — code present + `tsc` exit 0, tree DIRTY (not clean), 0 of 4 items committed. Proof: §EVIDENCE E2, E3, E4 |
| **P1** — close the launch gaps | `perf-eng` (perf), `ops-release` (release), `qa-verify` (a11y), `research-scout` (recon) | `team/PERF_P1.md` (baseline FIRST: route bundle KB gzip, TTFB, first-token latency, LCP/CLS, then fixes with a before/after number each); `team/RELEASE_P1.md` (DB restore rehearsal, Stripe decision, Figma OAuth live smoke, deliberate test error → observability, `/healthz` uptime probe); GAP-003 axe contrast sweep on dark theme (serious+, element + ratio); frontier-pattern recon feeding `ui-visual` | one line of raw evidence each: byte size, sha256, HTTP status, test count; no `NEEDS CONFIRMATION` left unowned | **OPEN** — none of the four artifacts exist yet; `docs/PROGRESS.md` carries the residues (scratch-restore EXECUTED per the Phase 1 close-out; uptime monitor account still `NEEDS CONFIRMATION`; marketplace live OAuth never round-tripped) |
| **P2** — frontier-parity UI rebuild | `ui-visual` (builds the accepted list), `arch-lead` (contract for any new surface), `mobile-dev` (mirrors accepted IA into `mobile/` GAP-070 + starts GAP-049) | rebuilt chat/landing surface to Claude/ChatGPT/Grok standard — fast + snappy; `mobile/` parity for the accepted IA | accepted pattern list from P1 recon is the only source of work; each item carries a before/after measurement; `arch-lead` contract signed before a new surface lands | **OPEN** — blocked on P1 recon |
| **P3** — independent verification | `qa-verify` (dynamic) + `code-review` (static) on the FROZEN revision; `perf-eng` re-measures after the rebuild | dynamic + static verdicts pinned to a revision hash; post-rebuild perf numbers | **both lanes report the revision hash** — "green" must refer to specific bytes; static review of each shipped phase's bytes (roster convention) | **OPEN** — no frozen revision until P0 commits + P2 lands |
| **P4** — release | `ops-release` (migration state, deploy, `/healthz` read-back of the served revision, tag); `boss-bot` (close-out, roster + docs, declare) | deployed revision + tag; `/healthz` serving that revision; close-out line in `team/` | served revision read back from the live host, not from a deploy log; roster + docs updated in the same pass | **OPEN** |

Lane order (dependency): static review → dynamic test → research. P3 is the only lane that runs both
reviewers; research (`research-scout`) feeds P2.

## 2. SHIPPED inventory — every line has a path + a raw command result (§EVIDENCE)

Everything below is committed on this branch and re-verified from the filesystem at 03:50 EDT,
not copied from a self-report. `git log -1 --format='%h %ad %s' --date=short <sha>` resolved
**21/21** referenced SHAs (E1).

| shipped item | path read | raw result behind it |
|---|---|---|
| §10 open questions resolved; P0 blockers (Resend key swap + `MAIL_FROM`; `postgres-ssl:16` image; Sentry/PostHog vars; `ADMIN_INVITE_CODE`; landing copy) | `docs/PROGRESS.md` L7–147 | `docs/PROGRESS.md` = 79,697 bytes / 1,189 lines (E2); live `/healthz` = 200 (E8) |
| Phase 4 architecture cleanup (`chat/page.tsx` 755→440, `MessageList` 593→142, `Composer` 432→252, backend `routes/agent.ts` 788→389, backend ESLint added) | `frontend/app/chat/page.tsx`, `components/chat/MessageList.tsx`, `components/chat/Composer.tsx`, `backend/src/routes/agent.ts` | current counts 680 / 331 / 419 / 495 lines (E5) — the reduction is real (pre-cleanup targets are larger), but the exact "440/142/252/389" figures are **stale**: P2/P3 work regrew the files. Commits `db08c53`, `22a7443` named in PROGRESS; both pushed |
| Phase 2.1 inline agent activity (`687abb4`), 2.2 artifact surface (`84ae3be`/`a1e249e`/`32960e4`), 2.3 byte-range video (`c670a8c`), 2.4 image CLS + lightbox (`d870c05`), 2.5 transitions (`3eb2f74`), 2.6 mobile/responsive (`78e5e83`), 2.7 composer gaps (`13341a3`) | `docs/PROGRESS.md` L192–396 | 7/7 SHAs resolve with the matching subject line (E1) |
| Phase 3 sidebar group (`a98ca2e`), message-list group (`31e09b0`), composer toggles + KaTeX (`141a601`), stream auto-resume (`7a93f92`), virtualization + rAF batching (`c35acff`), agent activity live output (`4d4a5eb`), §8-34 extraction defense (`962c187`), cross-tenant audit-log leak fix (`53aba87`), §8-22 branch tree (`c8220af`) | `docs/PROGRESS.md` L398–719 | 9/9 SHAs resolve (E1) |
| Nice-to-haves: §8-35 theme switcher (`4a792a4`), §8-39 per-message queue (`7d3016b`), §8-47 doc hygiene; `336f4c0` bakes `NEXT_PUBLIC_*` into the static export | `docs/PROGRESS.md` L725–797; `frontend/app/lib/theme.tsx`; `web/Dockerfile` | 4/4 SHAs resolve (E1); `web/Dockerfile` = 3,498 bytes, sha256 `50f7421ecd39fd1d…` — the live deploy path per `TEAM_ROSTER` §4 (E2) |
| §8-39 queue hook (shipped) | `frontend/app/chat/hooks.ts` | `hooks.ts:379 export function useMessageQueue(isRunning, dispatchNext)` (E4) |
| `/api/tts` contract — text cap 4000, audio bytes or `{url}` (P0 dependency for §8-45) | `backend/src/routes/tts.ts` (2,885 bytes, sha256 `7aa7f3039eee4428…`) | `L17 const text = String(req.body?.text \|\| '').trim().slice(0, 4000)`; audio branch streams bytes with `Content-Length`, else `res.json({ url: audioUrl })`; `ttsRouter.post('/', authenticateToken, …)` (E6). **Contract MATCHES the §8-45 client** (`frontend/app/lib/voice.ts:161 fetch(\`${API_URL}/api/tts\`)`) |

## 3. P0 in-flight — what the tree actually holds (verified, not asserted)

`TEAM_ROSTER.md` §4 claims **13 in-flight entries**. Raw `git status --short` = **16 lines**
(10 modified, 6 untracked) — 14 code entries + 2 team artifacts (`TEAM_ROSTER.md`, `team/`).
The roster's list is 10 distinct files; the tree carries 4 more modified files it does not name:
`frontend/app/chat/page.tsx`, `components/chat/__tests__/Composer.test.tsx`,
`components/settings/__tests__/SettingsTabs.test.tsx`, `frontend/app/lib/stream.ts`.
**Verdict: the "13" is wrong (stale by 3 lines); 14 code entries are in flight.** (E3)

Per-item presence in the tree:

| item | owner | artifact present? | evidence |
|---|---|---|---|
| §8-40 connector chip | `ui-visual` | YES | `hooks.ts:429 export function useWorkspaceConnections(workspaceId)`; `chat/__tests__/useWorkspaceConnections.test.tsx` 3,462 bytes (E4, E7) |
| §8-44 hands-free voice | `ui-visual` | YES | `hooks.ts:500 export function useVoiceMode({running, answer, speak, stopSpeech, speakingId, onAutoSend})`; `chat/__tests__/useVoiceMode.test.tsx` 4,584 bytes (E4, E7) |
| §8-45 server Kokoro + `ttsEngine` pref | `ui-visual` (client) / `core-dev` (contract) | YES | `lib/voice.ts` (`TTS_ENGINE_KEY = 'ttsEngine'` L98, `saveTtsEngine` L108, server-engine playback L155–200) 9,358 bytes sha256 `31a30a071be2ff55…`; `lib/__tests__/voice.test.tsx` 5,225 bytes; `PersonalizationTab.tsx` 13,760 bytes (E2, E7) |
| Appearance settings tab | `ui-visual` | YES, WIRED | `components/settings/AppearanceTab.tsx` 2,361 bytes / 55 lines sha256 `38ce8747ae2ed0ec…`; `SettingsPanel.tsx:12` import, `SettingsPanel.tsx:67 {tab === 'appearance' && <AppearanceTab />}` (E2, E4) |

**Not done:** all 4 items still uncommitted; no per-item commit; `npm test` / `npm run lint` /
`npx playwright test` / `npm run build` not re-run in this pass (only `tsc` was, exit 0);
`team/P0_CLOSEOUT.md` does not exist. **Exit condition not met.**

## 4. EVIDENCE (raw commands, raw results)

- **E1** `for c in 84ae3be a1e249e 32960e4 c670a8c d870c05 3eb2f74 78e5e83 13341a3 a98ca2e 31e09b0 141a601 7a93f92 c35acff 4d4a5eb 962c187 53aba87 c8220af 7d3016b 4a792a4 336f4c0 687abb4; do git log -1 --format='%h %ad %s' --date=short $c; done`
  → 21 lines, e.g. `84ae3be 2026-09-25 feat(chat): right-hand panel is the artifact surface (audit P2)`,
  `c8220af 2026-09-26 feat(branching): <2/3> version arrows - full message tree (audit SS8-22)`.
  **21/21 resolve. exit_code=0**
- **E2** `for f in frontend/app/chat/hooks.ts frontend/app/components/chat/Composer.tsx frontend/app/components/settings/AppearanceTab.tsx frontend/app/lib/voice.ts backend/src/routes/tts.ts web/Dockerfile web/nginx.template.conf docs/PROGRESS.md; do stat -c%s "$f"; sha256sum "$f"; done`
  → `hooks.ts bytes=37927 lines=846 sha256=bc5b9602720b4f3d`; `Composer.tsx bytes=18215 lines=419
  sha256=d56dbe5b9e1fa732`; `AppearanceTab.tsx bytes=2361 lines=55 sha256=38ce8747ae2ed0ec`;
  `voice.ts bytes=9358 lines=225 sha256=31a30a071be2ff55`; `tts.ts bytes=2885 lines=57
  sha256=7aa7f3039eee4428`; `web/Dockerfile bytes=3498 lines=67 sha256=50f7421ecd39fd1d`;
  `web/nginx.template.conf bytes=4461 lines=103 sha256=98fed1dff66abf6f`; `PROGRESS.md bytes=79697
  lines=1189`. **exit_code=0**
- **E3** `git status --short` → `modified(M)=10  untracked(??)=6  total_lines=16` (6 `??` =
  `TEAM_ROSTER.md`, `team/`, and the 4 new in-flight test/tab files). `git log --oneline -3` →
  `31cb496 docs: nice-to-have SS8-39 queue + SS8-35 theme + SS8-47 hygiene shipped in PROGRESS`.
  **exit_code=0. Roster's "13 entries" = WRONG.**
- **E4** `grep -n "useWorkspaceConnections\|useVoiceMode\|ttsEngine\|useMessageQueue" frontend/app/chat/hooks.ts`
  → `379:export function useMessageQueue(...)`, `429:export function useWorkspaceConnections(...)`,
  `500:export function useVoiceMode(...)`. `grep -n AppearanceTab components/SettingsPanel.tsx` →
  `12:import AppearanceTab from './settings/AppearanceTab'`, `67:{tab === 'appearance' && <AppearanceTab />}`.
  **exit_code=0** (last grep in a pipeline → 23, matches printed)
- **E5** `for f in frontend/app/chat/page.tsx frontend/app/components/chat/MessageList.tsx frontend/app/components/chat/Composer.tsx backend/src/routes/agent.ts; do wc -l < $f; done`
  → `680 / 331 / 419 / 495` lines. PROGRESS's Phase-4 numbers (`440/142/252/389`) are **stale**.
  **exit_code=0**
- **E6** `sed -n '1,57p' backend/src/routes/tts.ts` → `const text = String(req.body?.text || '').trim().slice(0, 4000)`;
  audio branch `res.setHeader('Content-Length', String(buffer.length)); … return res.send(buffer)`;
  else `if (audioUrl) return res.json({ url: audioUrl })`; `return res.status(400).json({error:'text is required.'})` on empty.
  **exit_code=0**
- **E7** `ls -la frontend/app/chat/__tests__/useWorkspaceConnections.test.tsx frontend/app/chat/__tests__/useVoiceMode.test.tsx frontend/app/lib/__tests__/voice.test.tsx`
  → `3462`, `4584`, `5225` bytes; mtimes `Sep 26 03:46`, `03:42`, `03:43`. **exit_code=0**
- **E8** `curl -s -o /dev/null -w "healthz_http=%{http_code}\n" https://loop-gpt.cyou/healthz`
  → `healthz_http=200`. Live host serves. **exit_code=0**
- **E9** `cd frontend && npx tsc --noEmit; echo "TSC_EXIT=$?"` → `TSC_EXIT=0`. **exit_code=0**
  (roster §4's `tsc` exit-0 claim: **CONFIRMED** on this tree.)

## 5. Two open claims in `TEAM_ROSTER.md` §4 — adjudicated

| claim | roster says | raw result | verdict |
|---|---|---|---|
| (a) in-flight count | 13 entries | 16 `git status --short` lines (10 M + 6 ??); 14 code + 2 team artifacts; 4 modified files the roster never names (`chat/page.tsx`, `chat/__tests__/Composer.test.tsx`, `settings/__tests__/SettingsTabs.test.tsx`, `lib/stream.ts`) | **FALSE / stale** — the tree moved after the snapshot |
| (b) `frontend` `npx tsc --noEmit` | exit 0 | `TSC_EXIT=0` | **TRUE** |

## 6. Next owner + exact artifact (the hand-off)

**Next owner: `ui-visual`.** Produce, for `frontend/`: one commit per in-flight item in the order
§8-40 → §8-44 → §8-45 → Appearance, each with `npx tsc --noEmit`, `npm run lint`, `npm test`,
`npx playwright test`, `npm run build` pasted beside the commit hash; `hooks.ts` stays yours alone
(`core-dev` hands the `/api/tts` contract over, verified at E6 and matching). Then `qa-verify`
re-runs the browser gate on the committed SHA and `code-review` static-passes the bytes. **`boss-bot`
writes `team/P0_CLOSEOUT.md` with the commit hashes** — that file's existence is the P0 exit gate.

Blockers to name in one line, not to work around: the roster's in-flight count is stale (E3);
`npm run lint` / `npm test` / `playwright` / `build` have not been run on this tree in this pass,
so P0 is *code-complete but uncommitted and un-gated*.
