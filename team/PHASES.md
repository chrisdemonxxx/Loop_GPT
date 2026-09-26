# team/PHASES.md — Loop GPT phase ledger (owner: boss-bot)

ROOM POST (boss-bot, 2026-09-26, second revision): **P0 is SHIPPED and gated** — the four in-flight
items landed as **one** commit, `7540a3d`, on a clean tree, with all five gates re-run by me and pasted
in `team/P0_CLOSEOUT.md`. P0's "deployed" acceptance is the only unmet line: the live host is serving
a **different build** than HEAD (§3b/§E11). **P1 is now IN-FLIGHT with four named owners.** Three
defects are new this pass (no `/api/version`, `/healthz` is a static nginx string, `out/` vs served
chunk-set mismatch) — all evidenced, none owned before.

First revision written 2026-09-26 03:50 EDT; this revision re-verified against the filesystem after
`7540a3d`/`30ce162`/`5a74833`. Ground truth order: filesystem → `docs/PROGRESS.md` → `AUDIT_REPORT.md`
§6/§8/§10 + `docs/GAP_REGISTER.md`.

Legend — `SHIPPED` = a path was read AND a raw command result is pasted in §EVIDENCE below.
`OPEN` / `IN-FLIGHT` = no filesystem proof of done. A self-report is not evidence.

Repo: `C:\Users\chris\Desktop\Workspace\dev-projects\loop-gpt`, branch
`release/owned-staging-20260917`. HEAD `5a74833`; frozen P0 revision `7540a3d`;
`origin/release/owned-staging-20260917` = `7540a3d`; **local is `ahead 2` and unpushed.**

## 1. Phase board (P0..P4 — 5 phases)

| phase | owner | deliverable | acceptance | status |
|---|---|---|---|---|
| **P0** — land the in-flight work | `ui-visual` (solo writer of `hooks.ts`), `core-dev` (`/api/tts` contract), `boss-bot` (this ledger + `team/P0_CLOSEOUT.md`) | §8-40 connector chip, §8-44 hands-free voice, §8-45 server TTS + `ttsEngine` pref, Appearance tab | clean tree; gates green (`tsc`, `lint`, `vitest`, `playwright`, `build`); revision reviewed by both lanes; deployed | **SHIPPED (code + gates) — `team/P0_CLOSEOUT.md`.** `7540a3d`, 14 files, +836/−42. `tsc`=0, `lint`=0 (13 warn / 0 err), `vitest` 23 files/150 tests, `playwright` 20 passed, `build` exit 0 (19 routes). One commit, not four. **"Deployed" NOT met** — §3b. Proof: §E1, E9–E13, `team/P0_CLOSEOUT.md` |
| **P1** — close the launch gaps | `perf-eng` (perf), `ops-release` (release+deploy), `qa-verify` (a11y), `research-scout` (recon), `core-dev` (version endpoint) | `team/PERF_P1.md`; `team/RELEASE_P1.md`; `team/A11Y_AXE.md` (GAP-003 `serious` contrast sweep); `team/FRONTIER_RECON.md`; `GET /api/version` | one line of raw evidence each: byte size, sha256, HTTP status, test count; before/after number per fix; no `NEEDS CONFIRMATION` left unowned | **IN-FLIGHT** — baselines landed (`team/PERF_BASELINE.md` 6,059 B, `team/RELEASE_BASELINE.md` 6,554 B, `team/MOBILE_BASELINE.md` 3,716 B); none of the four P1 deliverables exists yet. Proof: §E14–E16 |
| **P2** — frontier-parity UI rebuild | `ui-visual` (builds the accepted list), `arch-lead` (contract for any new surface), `mobile-dev` (mirrors accepted IA into `mobile/`) | rebuilt chat/landing surface to Claude/ChatGPT/Grok standard — fast + snappy; `mobile/` parity | accepted pattern list from P1 recon is the only source of work; each item carries a before/after measurement; contract signed before a new surface lands | **OPEN** — blocked on P1 recon |
| **P3** — independent verification | `qa-verify` (dynamic) + `code-review` (static) on the FROZEN revision; `perf-eng` re-measures post-rebuild | dynamic + static verdicts pinned to a revision hash; post-rebuild perf numbers | both lanes report the revision hash — "green" must refer to specific bytes | **OPEN** — P0's frozen revision (`7540a3d`) is reviewable NOW; re-freeze after P2 |
| **P4** — release | `ops-release` (migration state, deploy, served-revision read-back, tag); `boss-bot` (close-out, roster + docs, declare) | deployed revision + tag; read-back proving the served revision | served revision read back from the live host, not from a deploy log; roster + docs updated in the same pass | **OPEN** — and the read-back instrument does not exist yet (§E12) |

Lane order (dependency): static review → dynamic test → research. P3 is the only lane that runs both
reviewers; research (`research-scout`) feeds P2.

## 2. SHIPPED inventory — every line has a path + a raw command result (§EVIDENCE)

Everything below is committed on this branch and re-verified from the filesystem, not copied from a
self-report.

| shipped item | path read | raw result behind it |
|---|---|---|
| **P0 feature set** — §8-45 server TTS + `ttsEngine`, §8-44 hands-free voice, §8-40 connector chip, Appearance tab | `frontend/app/chat/hooks.ts`, `components/chat/Composer.tsx`, `components/settings/AppearanceTab.tsx`, `lib/voice.ts` | `git show --stat 7540a3d` → 14 files, +836/−42; `hooks.ts:379 useMessageQueue`, `:429 useWorkspaceConnections`, `:500 useVoiceMode`; `SettingsPanel.tsx:12` import + `:67` render; all five gates green (§E9–E13) |
| §10 open questions resolved; Phase 0 blockers (Resend key swap + `MAIL_FROM`; `postgres-ssl:16` image; Sentry/PostHog vars; `ADMIN_INVITE_CODE`; landing copy) | `docs/PROGRESS.md` L7–147 | `docs/PROGRESS.md` = 79,697 bytes / 1,189 lines (E2); live `/healthz` = 200 (E8) |
| `/api/tts` contract — text cap 4000, audio bytes or `{url}` | `backend/src/routes/tts.ts` (2,885 B, sha256 `7aa7f3039eee4428…`) | `L17 …trim().slice(0, 4000)`; audio branch sets `Content-Length`; else `res.json({url})`; matches client `frontend/app/lib/voice.ts:161` (E6) |
| Phases 2/3/4 UI work (activity, artifacts, branching, virtualization, theme, queue, a11y hardening, cross-tenant audit-log fix) | `docs/PROGRESS.md` L192–797 | 21/21 referenced SHAs resolve with matching subjects (E1) |
| `team/` baselines: perf, release, mobile | `team/PERF_BASELINE.md` 6,059 B sha256 `5015e199…`; `team/RELEASE_BASELINE.md` 6,554 B sha256 `79a26de9…`; `team/MOBILE_BASELINE.md` 3,716 B sha256 `00a1da7d…` | all three present, measured (real `npm run build`, live curl, `tsc --noEmit`) — §E14–E16 |

Stale-but-real: PROGRESS's Phase-4 line counts (`chat/page.tsx` 440, `MessageList` 142, `Composer` 252,
`routes/agent.ts` 389) are **stale**; current = 680 / 331 / 419 / 495 (E5). The reduction is real;
the exact figures are not.

## 3. P1 in-flight — the four owned deliverables, plus three new defects

| # | item | owner | artifact / exit | evidence today |
|---|---|---|---|---|
| P1-a | **Perf**: baseline exists; the fixes now need before/after numbers. Biggest: mermaid loaded unconditionally at 2.5 MB raw (~692 kB gzip) on every `/chat` first-load; `/chat` first-load = **505 kB JS** | `perf-eng` | `team/PERF_P1.md` — one before/after pair per fix, measured with the same command | `team/PERF_BASELINE.md` (real build + live `curl` timings, §E14) |
| P1-b | **Release**: DB-restore footer, Stripe freeze-vs-go-live, Figma OAuth live smoke, deliberate-error observability, uptime probe, **and the deploy itself** | `ops-release` | `team/RELEASE_P1.md` — one raw line per item | `team/RELEASE_BASELINE.md`: 6 items with probes; #2 already closed (both DSNs → HTTP 200) (§E15) |
| P1-c | **A11y / GAP-003**: the axe suite gates on `impact==='critical'` **only**; the `serious` contrast sweep on the dark theme is unrun | `qa-verify` | `team/A11Y_AXE.md` — every `serious+` violation with element + ratio, per route | `frontend/tests/e2e/app.spec.ts:10-13` (the `critical`-only filter is in the source) (§E16) |
| P1-d | **Recon**: which frontier patterns (Claude / ChatGPT / Grok) the audit still lists as missing, each with a source; feeds `ui-visual` | `research-scout` | `team/FRONTIER_RECON.md` — accepted-pattern list with citations | none yet; `AUDIT_REPORT.md` §8 is the input |
| **NEW** | **No way to read the served revision back** — `/api/version` → 404 on both origins; `/healthz` is `nginx return 200 "owned-web\n"` (proves nginx, not the app); the API origin's `/health` returns the web `index.html` (200 `text/html`, 27,285 B) because nginx only proxies `^/api(?:/|$)` and `^/v1/` | `core-dev` (endpoint + contract), `ops-release` (deploy + read-back) | `GET /api/version` → `{sha,builtAt}` baked at build; `/healthz` proxies or embeds the SHA | §E11, §E12 — three raw probes |
| **NEW** | **The live host is stale**: 8 of the 18 chunk names `/chat/` serves are absent from a fresh build of HEAD; the webpack runtime hash differs outright | `ops-release` | deploy the frozen revision, then the served-vs-built set-diff must be **equal** | §E11 — `comm`-style set diff, not a deploy log |
| **NEW** | **Two unpushed docs commits** (`30ce162`, `5a74833`) — `ahead 2` of origin. The durable channel is not durable until it is pushed | `boss-bot` (push), then all | `git status -sb` → no ahead marker | `git log --oneline origin/…..HEAD` = 2 lines |

## 4. EVIDENCE (raw commands, raw results)

- **E1** `for c in 84ae3be … 687abb4; do git log -1 --format='%h %ad %s' --date=short $c; done`
  → 21 lines, **21/21 resolve**. exit 0.
- **E2** `for f in frontend/app/chat/hooks.ts … docs/PROGRESS.md; do stat -c%s "$f"; sha256sum "$f"; done`
  → `hooks.ts 37927 bc5b9602720b4f3d`; `Composer.tsx 18215 d56dbe5b9e1fa732`; `AppearanceTab.tsx 2361 38ce8747ae2ed0ec`;
  `voice.ts 9358 31a30a071be2ff55`; `tts.ts 2885 7aa7f3039eee4428`; `web/Dockerfile 3498 50f7421ecd39fd1d`;
  `nginx.template.conf 4461 98fed1dff66abf6f`; `PROGRESS.md 79697`. exit 0.
- **E3** (first pass) `git status --short` → 16 lines (10 M + 6 ??) → roster's "13" was **wrong**; the tree
  later committed clean at `7540a3d` / `30ce162`. exit 0.
- **E4** `grep -n "useMessageQueue\|useWorkspaceConnections\|useVoiceMode" frontend/app/chat/hooks.ts` →
  `379:`, `429:`, `500:`. exit 0.
- **E5** `wc -l` on `chat/page.tsx`, `MessageList.tsx`, `Composer.tsx`, `backend/src/routes/agent.ts` →
  `680 / 331 / 419 / 495`. exit 0.
- **E6** `sed -n '1,57p' backend/src/routes/tts.ts` → 4000-char cap; bytes-or-`{url}`; `authenticateToken`. exit 0.
- **E7** `ls -la …/useWorkspaceConnections.test.tsx …/useVoiceMode.test.tsx …/voice.test.tsx` → `3462`, `4584`, `5225` B. exit 0.
- **E8** `curl -s -o /dev/null -w '%{http_code}' https://loop-gpt.cyou/healthz` → `200`. exit 0.
- **E9** `cd frontend && npx tsc --noEmit; echo TSC_EXIT=$?` → **`TSC_EXIT=0`**.
- **E10** `npm run lint; echo LINT_EXIT=$?` → `LINT_EXIT=0`; `grep -c Warning:` → `13`; `grep -c Error:` → `0`.
- **E11** `curl -s https://loop-gpt.cyou/chat/ | grep -oE '_next/static/chunks/…\.js' | sort -u` → **18** names;
  `find frontend/out -name '*.js'` after `rm -rf out .next && npm run build` → **114**. Set-diff:
  **8 served names absent from the build**, incl. `webpack-12ed1796ffdc89d3.js` (built: `webpack-bfdd25fdbe871018.js`)
  and `2631-7754d38b30959869.js` (built: `2631-0c0b19adc4c4a71b.js`) — same module id, different content hash.
  **The served bundle is not a build of HEAD.** exit 0.
- **E12** `curl … /api/version` (web origin) → `404`; `https://api.loop-gpt.cyou/api/version` → `404 text/html 150`;
  `https://api.loop-gpt.cyou/health` → `200 text/html 27285` (the **web** `index.html`, not backend JSON);
  `grep -rn "GIT_SHA\|/api/version" backend/src` → no match; `web/nginx.template.conf:32` → `location = /healthz { return 200 "owned-web\n"; }`. exit 0.
- **E13** `git cat-file -t 7540a3dcc55dcaaa2308fe78c260686296ca5289` → `commit`; `git show --stat 7540a3d`
  → `14 files changed, 836 insertions(+), 42 deletions(-)`. exit 0.
- **E14** `team/PERF_BASELINE.md` = 6,059 B, sha256 `5015e199d72c3be7…`. Content is real: `npm run build`
  route table (17 routes + 404; `/chat` 505 kB first-load), per-chunk raw+gzip over `out/_next/static/chunks`
  (7,471,010 B raw / ~2,121 KB gzip), 5× live `curl` timings (`/` median ~0.73 s, `/chat/` median ~0.73 s).
- **E15** `team/RELEASE_BASELINE.md` = 6,554 B, sha256 `79a26de9…`. 6 ops items with raw probes;
  #2 (deliberate test error) closed today — both Sentry store endpoints `HTTP 200`; Stripe read back live:
  `/api/billing/config` → `enabled:false, checkoutEnabled:false, publishableKey:null`, and prod carries
  **no `STRIPE_SECRET_KEY`/`WEBHOOK_SECRET`/`PRICE_*`/`PUBLISHABLE_KEY`** and **no `SMTP_*`**.
- **E16** `team/MOBILE_BASELINE.md` = 3,716 B, sha256 `00a1da7d…`. 11 of 16 web routes have no mobile
  counterpart; `mobile` `tsc --noEmit` exit 0.
- **E17** `npm run test:browser` → `npx playwright test` → `20 passed (4.5s)`. `vitest run` → `23 files / 150 tests passed`.
  `npm run build` → `BUILD_EXIT=0`, `19 routes`, `find out -name '*.html' | wc -l` → `18`.

## 5. Next owner + exact artifact (the hand-off)

**Next owner: `perf-eng`, `ops-release`, `qa-verify`, `research-scout` — in parallel, one artifact each**
(`team/PERF_P1.md`, `team/RELEASE_P1.md`, `team/A11Y_AXE.md`, `team/FRONTIER_RECON.md`), and
**`core-dev`** for `GET /api/version` (`backend/src/server.ts` + `web/nginx.template.conf:32`).

The single gate that decides P1: **the live host must serve the frozen revision, proven by the
served-vs-built chunk-set diff being equal** — today it is not (§E11). `ui-visual` starts P2 only on
`research-scout`'s accepted-pattern list. `qa-verify` + `code-review` can freeze `7540a3d` for P3
**now** — it is committed, clean, and gated.

Blockers named in one line, not worked around: no served-revision instrument (§E12); live bundle ≠ HEAD
(§E11); docs commits unpushed.
