# team/PHASES.md — Loop GPT phase ledger (owner: boss-bot)

ROOM POST (boss-bot, 2026-09-28, **sixth revision**): **the round's sizes were all object-mismatches,
the M1 gate fails live, and the decoy is the first payload this room didn't author.** `worktree bytes (CRLF)
≠ blob bytes (LF)` explains Δ838 / Δ241 — measure the object, name it (13.1). `builtAt` is a *layer*
signal, proven two-sided (13.2). M1 = `surface:web` + `revision == SHA pinned at deploy` on both
surfaces, never `builtAt`/mtime/**etag** (13.3). `_qa-m1.mjs` exit 1 live on 4 hunks, 3 of them not the
etag literal (13.4). A 75-byte body-swap with `bankerOutreachText` passes every term we assert — shape,
not size (13.5). HEAD unpushed ×5 is now stricter than the missing `ARG` (13.6).

ROOM POST (boss-bot, 2026-09-28, **fifth revision**): **the web marker EXISTS and SERVES — the missing
thing is the *value*, and the cache-hit reading is dead.** Re-probed raw this pass: `GET /version.json` →
`200`, 75 B, `no-store`, and `builtAt` == `last-modified` == the nginx etag's decoded mtime ==
`2026-09-28T03:44:37Z` — so the Dockerfile `RUN` **re-ran**, the `+4h23m` in `research-scout`'s §I was a
stale-body-vs-fresh-header comparison, and M1's acceptance is `revision == <SHA>` (never `builtAt`, never
mtime). P4's "no served marker" line is superseded; one env line on the web service is the whole gap.
Gates re-run by me: `tsc`=0, `vitest` 23 files/151 tests. New: `hr-bot`'s dead aliases are a **live**
endpoint (200, 135 ids) with a **dead model id** (`/repository` → 400) — repair, don't just prune. Full
detail and owners: **§12**.

ROOM POST (boss-bot, 2026-09-27, fourth revision): **the read-back instrument EXISTS and answers.** Live
`GET /api/version` → `200 {"revision":"3a43db8…"}` with `no-store` on both origins, so the API half of
P4's acceptance is provable today. `arch-lead`'s `team/CONTRACT_P2_STREAM.md` (`350ad4d`, 8,023 B) and
`core-dev`'s resolver (`3a43db8`, `thinking.ts` 4,094 B) are both hash-verified on disk; the 23 tests
are re-run by me, not taken on report (§7). The code-equivalence gate passes: **built-only = 0** on
both renamed chunks — live == HEAD's code + one build-time env literal, so "live ≠ HEAD" is retired as a
staleness claim. **Remaining: one served marker on the web/nginx half**; `team/PERF_P1.md`,
`team/RELEASE_P1.md`, `team/A11Y_AXE.md` are still ABSENT.

Third revision (2026-09-27): **P1-d is SHIPPED** — `research-scout`'s
`team/FRONTIER_RECON.md` (9,679 B, sha256 `167d1f3e5f206185…`) is on disk and committed at `ef77e80`,
and it corrects the brief in three places (§0.1–§0.3) before any P2 code is written. The unpushed-docs
defect is **CLOSED**: `git status -sb` shows no ahead marker, `origin/release/owned-staging-20260917`
= `ef77e80` = HEAD. P1's decider gate was re-measured by me this pass and is **unchanged**: 18 served
chunk names, **8 absent** from a build of HEAD, webpack runtime hash differs outright (§E19). P1-a/b/c
(`team/PERF_P1.md`, `team/RELEASE_P1.md`, `team/A11Y_AXE.md`) are still **ABSENT** — three owners
hold the only open P1 artifacts.

Second revision (2026-09-26): **P0 is SHIPPED and gated** — the four in-flight
items landed as **one** commit, `7540a3d`, on a clean tree, with all five gates re-run by me and pasted
in `team/P0_CLOSEOUT.md`. P0's "deployed" acceptance is the only unmet line: the live host is serving
a **different build** than HEAD (§3b/§E11). **P1 is now IN-FLIGHT with four named owners.** Three
defects are new this pass (no `/api/version`, `/healthz` is a static nginx string, `out/` vs served
chunk-set mismatch) — all evidenced, none owned before.

First revision written 2026-09-26 03:50 EDT; this revision re-verified against the filesystem after
`ef77e80`. Ground truth order: filesystem → `docs/PROGRESS.md` → `AUDIT_REPORT.md`
§6/§8/§10 + `docs/GAP_REGISTER.md`.

Legend — `SHIPPED` = a path was read AND a raw command result is pasted in §EVIDENCE below.
`OPEN` / `IN-FLIGHT` = no filesystem proof of done. A self-report is not evidence.

Repo: `C:\Users\chris\Desktop\Workspace\dev-projects\loop-gpt`, branch
`release/owned-staging-20260917`. HEAD `5a74833`; frozen P0 revision `7540a3d`;
`origin/release/owned-staging-20260917` = `7540a3d`; **local is `ahead 2` and unpushed.**

## 1. Phase board (P0..P5 — 6 phases)

| phase | owner | deliverable | acceptance | status |
|---|---|---|---|---|
| **P0** — land the in-flight work | `ui-visual` (solo writer of `hooks.ts`), `core-dev` (`/api/tts` contract), `boss-bot` (this ledger + `team/P0_CLOSEOUT.md`) | §8-40 connector chip, §8-44 hands-free voice, §8-45 server TTS + `ttsEngine` pref, Appearance tab | clean tree; gates green (`tsc`, `lint`, `vitest`, `playwright`, `build`); revision reviewed by both lanes; deployed | **SHIPPED (code + gates) — `team/P0_CLOSEOUT.md`.** `7540a3d`, 14 files, +836/−42. `tsc`=0, `lint`=0 (13 warn / 0 err), `vitest` 23 files/150 tests, `playwright` 20 passed, `build` exit 0 (19 routes). One commit, not four. **"Deployed" NOT met** — §3b. Proof: §E1, E9–E13, `team/P0_CLOSEOUT.md` |
| **P1** — close the launch gaps | `perf-eng` (perf), `ops-release` (release+deploy), `qa-verify` (a11y), `research-scout` (recon), `core-dev` (version endpoint) | `team/PERF_P1.md`; `team/RELEASE_P1.md`; `team/A11Y_AXE.md` (GAP-003 `serious` contrast sweep); `team/FRONTIER_RECON.md`; `GET /api/version` | one line of raw evidence each: byte size, sha256, HTTP status, test count; before/after number per fix; no `NEEDS CONFIRMATION` left unowned | **4 of 5 LANDED.** `FRONTIER_RECON.md` (pass 2, 15,465 B, `2e74b58`), `CONTRACT_P2_STREAM.md` (8,023 B, `350ad4d`), resolver + `/api/version` (live `200`, revision `3a43db8`) all hash-verified by me (§7.1/§7.3). **ABSENT still: `PERF_P1.md`, `RELEASE_P1.md`.** `A11Y_AXE.md` **LANDED on disk** (`53f3450dcf4833a1…`, 3,257 B, pinned `0d5d767`) but is **UNTRACKED** — the commit is the residual, not the doc (§12.4). Proof: §E19, §6, §7, §12.4 |
| **P2** — frontier-parity UI rebuild | `ui-visual` (builds the accepted list), `arch-lead` (contract for any new surface), `mobile-dev` (mirrors accepted IA into `mobile/`) | rebuilt chat/landing surface to Claude/ChatGPT/Grok standard — fast + snappy; `mobile/` parity | accepted pattern list from P1 recon is the only source of work; each item carries a before/after measurement; contract signed before a new surface lands | **IN FLIGHT** — contract signed (`350ad4d`); `ui-visual` has ranks 1/3/5/7 open against it; the effort selector is unblocked (`3a43db8` zod accepts the union) |
| **P3** — independent verification | `qa-verify` (dynamic) + `code-review` (static) on the FROZEN revision; `perf-eng` re-measures post-rebuild | dynamic + static verdicts pinned to a revision hash; post-rebuild perf numbers | both lanes report the revision hash — "green" must refer to specific bytes | **OPEN** — P0's frozen revision (`7540a3d`) is reviewable NOW; re-freeze after P2 |
| **P4** — release | `ops-release` (migration state, deploy, served-revision read-back, tag); `boss-bot` (close-out, roster + docs, declare) | deployed revision + tag; read-back proving the served revision | served revision read back from the live host, not from a deploy log — **assert `revision == <SHA>`; never `builtAt`, never mtime (§12.1)**; roster + docs updated in the same pass | **HALF-CLOSED** — API read-back **works** (`GET /api/version` → `200`, revision `e9f4b52`, `no-store`; docs-only behind HEAD, and HEAD unpushed — §12.5). The web marker now **EXISTS and SERVES**: `GET /version.json` → `200`, 75 B, `no-store` (`nginx.template.conf:13`) — **§7.3's "no served marker" is superseded (§12.2)**. Remaining: the *value* is `unknown` because `GIT_REVISION` is unset on web — one env line + rebuild. §I's cache-hit reading is **FALSIFIED** (§12.1): `builtAt` == `last-modified` == etag mtime == `2026-09-28T03:44:37Z` |
| **P5** — responsive web at phone width (the audit-P6 residual; the phase-2.6 "mobile 12/12" gate never opened a popover) | `ui-visual` (fix — single writer of `frontend/app`), `qa-verify` (the geometry gate: RED → GREEN → live), `code-review` (static, revision-pinned), `ops-release` (deploy + `/version.json` read-back), `research-scout` (feed, not a blocker) | `frontend/tests/e2e/mobile-composer.spec.ts` (**measures rects, not classes**) + one frontend-only fix commit; `team/UI_MOBILE_WEB_ui-visual.md`; kickoffs `team/P5_KICKOFF_{ui-visual,qa-verify,code-review,ops-release}.md` | at 390×844 **and** 360×800 on the **live URL**: every composer control — **including the `ml-auto` Send wrapper** — has `right ≤ innerWidth`; row `scrollWidth ≤ clientWidth`; every chip label span `h ≤ 16`; each of the four popovers `right ≤ innerWidth` and covering **no** suggestion card; settings-sheet last row clears browser chrome, no truncated card titles; the gate runs in Playwright `mobile-chromium` **with a popover open** | **DISPATCHED 2026-09-29 (rev 9, §14) — RED on the live host and on HEAD.** Baseline re-measured by me on a fresh build of `1b9806e`: row box 364 / **`scrollWidth` 455** in a 390 px viewport; worst control **`right=460` (70 px off; 100 px at 360)**; chip label span `24` inside a 32 px chip, `white-space: normal`; Reasoning menu `x=238 right=486`, overlapping **all four** suggestion cards. The note's "28 px clipped" is the `.chip`-only view. Owner confirmed `ui-visual`. Proof: §14 — and the gate's live-session fixture is verified live at §15.2, so the RED run waits on nobody. |

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
| P1-d | **Recon**: which frontier patterns (Claude / ChatGPT / Grok) the audit still lists as missing, each with a source; feeds `ui-visual` | `research-scout` | `team/FRONTIER_RECON.md` — accepted-pattern list with citations | **SHIPPED** — `team/FRONTIER_RECON.md` 9,679 B, sha256 `167d1f3e5f206185…`, commit `ef77e80` (§E19). 6 ranked parity patterns + 4 table-stakes; §0 corrects the audit itself (4 "missing" items already ship; §8 numbering ≠ PROGRESS §8-N; ChatGPT retired Canvas). **UNVERIFIED set is explicit** (§4): OpenAI/Claude article pages 403'd the keyless extractor |
| **NEW** | **No way to read the served revision back** — ~~`/api/version` → 404 on both origins~~ **API HALF CLOSED** (`3a43db8`): live `/api/version` → `200 {"revision":"3a43db8…"}`, `no-store`, unauthenticated, mounted at `server.ts:100` ahead of the global limiter. **Web half OPEN**: `/healthz` is still `nginx return 200 "owned-web\n"` and the served `/chat/` HTML carries no revision/40-hex (§7.3) | `core-dev` (endpoint, done), `ops-release` (web marker + read-back) | `GET /api/version` → `{revision,…}` ✅; a served marker on the nginx half ⏳ | §E12, §7.3 — raw probes, both halves |
| **NEW** | **"The live host is stale"** — 8 of the 18 chunk names `/chat/` serves are absent from a fresh build of HEAD; the webpack runtime hash differs outright. **EXPLAINED, NOT STALENESS (§6/§7.4):** the 8 are renamed pairs; 10/10 identical-name chunks are byte-identical, and the renamed pairs show **built-only literals = 0** with `live-only ⊆ {NEXT_PUBLIC_SENTRY_DSN, NEXT_PUBLIC_POSTHOG_KEY}` (no `.env.local` locally) | `ops-release` (no longer chases this) | **retired** as a deploy criterion; superseded by the §7.4 code-equivalence gate | §6, §7.4 — per-chunk sha + prose-literal set diff |
| **NEW** | ~~**Two unpushed docs commits**~~ (`30ce162`, `5a74833`) — **CLOSED 2026-09-27**: `git status -sb` shows no ahead marker; `origin/release/owned-staging-20260917` = `ef77e80` = HEAD | `boss-bot` (push) | `git rev-list --count origin/…..HEAD` → `0` | `ahead: 0` (§E19) |

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

- **E18** live `/chat/` vs a fresh build — 18 served chunk names, 114 built; **8 served names absent** from the
  build; `webpack-12ed1796ffdc89d3.js` served vs `webpack-bfdd25fdbe871018.js` built. The served chat
  chunk (214,400 B) does contain the P0 markers (`ttsEngine` 1×, `hands-free` 1×, `Appearance` 1×) — so
  live is *near* P0, not older; live == `7540a3d` is still **unproven**. `POST https://api.loop-gpt.cyou/api/tts`
  (no auth) → `504` once (cold start, first hit) then `401` in `0.849 s`; with a bogus bearer →
  `{"error":"Invalid token"}` `401 0.876 s`; `GET /api/models/catalog` → `200 0.879 s`. Full probes:
  `team/P1_FINDINGS.md`. exit 0.

- **E19** (boss-bot, 2026-09-27 — the whole pass re-run against the live host and the filesystem, not
  copied from a self-report)
  - `for f in team/PERF_P1.md team/RELEASE_P1.md team/A11Y_AXE.md team/FRONTIER_RECON.md; do stat -c%s` →
    `PERF_P1.md ABSENT`; `RELEASE_P1.md ABSENT`; `A11Y_AXE.md ABSENT`; **`FRONTIER_RECON.md 9679 B
    sha256 167d1f3e5f206185…`**. exit 0.
  - `git status -sb` → `## release/owned-staging-20260917...origin/release/owned-staging-20260917` (no
    ahead marker); `git log --oneline -1 origin/…` → `ef77e80 docs(team): FRONTIER_RECON …`;
    `git rev-list --count origin/…..HEAD` → **`0`**. exit 0.
  - `curl -s https://loop-gpt.cyou/chat/ | grep -oE '_next/static/chunks/[A-Za-z0-9_./-]+\.js' | sort -u | wc -l`
    → **`18`** served. `find frontend/out/_next/static/chunks -name '*.js' -printf '%P\n'` (out/ rebuilt
    today 17:35, 116 files, 114 unique chunk names) → `comm -23` → **`8` served names absent**, incl.
    `webpack-12ed1796ffdc89d3.js` served vs `webpack-bfdd25fdbe871018.js` built, and
    `app/chat/page-b2100450a5471ec3.js` served vs `page-<other>` built. **Gate unchanged: live ≠ HEAD.**
  - `curl -w '%{http_code} %{size_download}' https://loop-gpt.cyou/api/version` → `404 0`;
    `https://api.loop-gpt.cyou/api/version` → `404 0`; `grep -rn "api/version" backend/src web/nginx.template.conf`
    → **no match**. exit 0.
  - **Methodology trap, logged so the next reader does not repeat it**: diffing served names against
    `find … -printf '%f'` (basenames only) inflates the miss to `18/18` because nested chunks carry an
    `app/…` path prefix. The correct comparator is the path **relative to `out/`**; that yields the
    true **8**. Same file, different `find` format — 10 phantom "missing" chunks.

## 5. Next owner + exact artifact (the hand-off)

**Next owner: `ui-visual` — with `arch-lead`'s one decision in front of it — and three P1 artifact
holders (`perf-eng`, `ops-release`, `qa-verify`) plus `core-dev`.**

1. **`arch-lead`** — **DONE** (`350ad4d`, `team/CONTRACT_P2_STREAM.md`, 8,023 B). Effort signed as a
   widening (`thinking?: boolean | 'low'|'medium'|'high'|'xhigh'`, `true ≡ 'medium'`); `/library`
   read-through confirmed, no migration.
2. **`ui-visual`** — in flight on `FRONTIER_RECON.md` ranks 1 (TOC rail), 3 (429 `Retry-After`), 5
   (wait card on `onRetry`), plus the effort selector now that `agentStream.ts:129` accepts the union.
   Each item carries a before/after measurement; anything that adds bundle weight names what it evicts
   (`/chat` first-load 505–506 kB JS today).
3. **`perf-eng` / `ops-release` / `qa-verify`** — the three still-missing artifacts
   (`team/PERF_P1.md`, `team/RELEASE_P1.md`, `team/A11Y_AXE.md`). One raw line each. `qa-verify`
   must not duplicate `resolveThinking.test.ts` (14) / `thinkingWire.test.ts` (4) — extend, don't copy.
4. **`core-dev` + `ops-release`** — **the one open release blocker:** a served revision marker on the
   web/nginx half. The API half answers; `location = /healthz` is still a static string and the served
   `/chat/` HTML carries no revision. Ship the marker and live == HEAD is provable end to end.

**`code-review` + `qa-verify`: freeze `7540a3d` for P3 now** — it is committed, clean, and gated, and
P2 has not started.

The gate that decides P1/P4, **corrected twice and now sound**: (a) `GET /api/version` read back from
the live host — **done**, revision `3a43db8`; (b) the code-equivalence gate on any renamed chunk —
**built-only literals = 0** (§7.4); (c) a served marker on the web/nginx half — **open**. **Never**
chunk-name set equality, and never a bare `200` on a chunk URL (nginx falls back to `index.html`; assert
content-type — §6.2). ⚠️ **The chunk-set-equality wording below is superseded — read §6 + §7.4.**

Blockers named in one line, not worked around: web/nginx served marker missing (§7.3); `team/PERF_P1.md`,
`team/RELEASE_P1.md`, `team/A11Y_AXE.md` absent (§7.6); `CORE_DEV_P2_EFFORT.md` self-quotes 5,005 B
against 5,325 B on disk (§7.1).

## 6. P1 GATE RE-MEASURED AND CORRECTED — live vs HEAD is a BUILD-ENV delta, not staleness
*(boss-bot, 2026-09-27, re-run from the filesystem: `rm -rf .next && npm run build`, then live curls)*

The §E18/§E19 "live ≠ HEAD" verdict stands as a **byte** fact and is now explained. It is **not**
code drift and **not** a stale deploy.

Raw results (all reproducible, pasted in full):

1. **`npm run build` on `ef77e80`, clean `rm -rf .next`** → exit 0, 1m05s, 19 routes,
   `/chat` first-load `506 kB` (baseline said 505 — consistent). Built: `114` chunk files,
   `webpack-bfdd25fdbe871018.js`. Served: `18` chunk URLs, `webpack-12ed1796ffdc89d3.js`.
2. **`comm` on the FULL paths (not basenames)** → `live_only=8 built_only=8`. The 8 renamed pairs are
   exactly the app-router/route chunks + the runtime: `page-…`, `layout-…`, `main-app-…`, `webpack-…`,
   `2631-…`, `3452-…`, `9864-…`, `4951-…`.
3. **`10/10` chunks with IDENTICAL names are byte-identical** live vs built —
   `for n in $(comm -12 live built); do curl … | sha256sum` vs `sha256sum out/…` → `MATCH` ×10
   (`4938` `18d3d287ee52`, `polyfills` `0225eb034d02`, `fd9d1056` `7d500719eea5`, …).
4. **Literal-set diff on the renamed pairs** (extract every `"…"` literal from both sides, set-diff):

   | pair | live B | built B | live-only lits | built-only lits |
   |---|---|---|---|---|
   | `app/chat/page-*` | 216,192 | 216,150 | **2** | **0** |
   | `app/layout-*` | 11,477 | 11,435 | **2** | **0** |
   | `main-app-*` | 474 | 474 | 0 | 0 |
   | `webpack-*` | 5,809 | 5,809 | 0 | 0 |

   The 2 live-only literals are the same in both files, and only those two:
   `https://ad6058…@o4510025877618688.ingest.us.sentry.io/4512145116758016` and
   `phc_WsaOygQ1pv1IQwJyC0jXP3LOdQTJjd0hE2XIfLtLqN8`. Everything else is webpack module-id/symbol
   churn — the size delta is `+42 B` on both chunks, and the byte delta is *inside* the renamed
   minified identifiers, not the code.

5. **Root cause** — `ls -a frontend/ | grep '^\.env'` → **`.env.example` only, no `.env.local`**.
   `grep -rl 'ingest.us.sentry.io' frontend/out/` → **0 files**; `grep -rl 'phc_WsaOyg…'` → **0 files**.
   `NEXT_PUBLIC_SENTRY_DSN` / `NEXT_PUBLIC_POSTHOG_KEY` are baked at build time
   (`frontend/app/components/Analytics.tsx`), so the local build inlines `undefined` while the live
   build inlined the real values. **Live = HEAD's code + the analytics env. Live is ahead, not behind.**

### 6.1 The corrected P1/P4 acceptance (replaces "served set == built set")

- **Instrument (still missing, `core-dev`+`ops-release`):** `GET /api/version` → `{sha,builtAt}`, read
  back from the live host. That is the only sound served-revision proof. Chunk hashes are not.
- **Code-equivalence gate (can be run today, no instrument):** literal-set diff per renamed pair must be
  **`built-only = 0` and `live-only ⊆ {build-time env keys}`**. Verified passing at `ef77e80` (§6.4).
- **Never** assert on chunk-name set equality across builds.

### 6.2 Probe hazard — a `200` on a chunk URL is not proof the chunk exists

`curl -sI https://loop-gpt.cyou/_next/static/chunks/page-b2100450a5471ec3.js` (correct basename,
**wrong directory depth**) → `200 text/html`, 27,285 B, body `<!DOCTYPE html>`. A deliberately bogus
path behaves identically: `does-not-exist-1234.js` → `200 text/html 27,285 B`. nginx falls back to an
`index.html` for any unresolved path. My own first pass was fooled by it; §E18's count did not
flatten paths (`-printf '%P\n'` was already correct). **Any served-vs-built probe must assert
`content-type: application/javascript` and a non-zero body, not the status code.**

### 6.3 Hygiene item confirmed (from `FRONTIER_RECON.md` §2)

`grep -oE '8-[0-9]{1,2}' AUDIT_REPORT.md | sort -u | wc -l` → **`1`**; same on `docs/PROGRESS.md` →
**`27`**. `PROGRESS.md` §8-N ids have almost no counterpart in `AUDIT_REPORT.md` §8, so no
"§8-N shipped" claim is cross-checkable. One hygiene commit, owner `research-scout` or `boss-bot`.
`ui-visual` starts P2 only on `research-scout`'s accepted-pattern list — that list now exists.

Blockers named in one line, not worked around: no served-revision instrument (§E19, **now the #1 P1
item — §6.1**); `arch-lead`'s effort-level contract unsigned (FRONTIER_RECON §1.4).
**Retired blocker:** "live bundle ≠ HEAD" is a build-env delta, not a stale deploy — §6. `ops-release`
no longer has to chase chunk-name equality; `ops-release`/`core-dev` ship the read-back instead.

## 7. FOURTH REVISION — four landings verified from the filesystem; the read-back instrument EXISTS

*(boss-bot, 2026-09-27. Every line below is my own read/run this pass; nothing is copied from a room
post. HEAD `2e74b58`; `@{u}..HEAD` → `0` after I pushed — see 7.5.)*

### 7.1 The four landings, hash-verified on disk

| artifact | on disk | claimed | verdict |
|---|---|---|---|
| `team/CONTRACT_P2_STREAM.md` | 8,023 B, sha256 `51c27942668ae45c…`, `350ad4d` | 8,023 / `51c27942668ae45c…` | ✓ exact |
| `backend/src/agent/thinking.ts` (new) | 4,094 B, sha256 `49a4a92acc8f32c0…` | 4,094 / `49a4a92a…` | ✓ exact |
| `backend/src/routes/version.ts` (new) | 1,887 B, sha256 `103396a86a9732ac…` | 1,887 / `103396a8…` | ✓ exact |
| `team/CORE_DEV_P2_EFFORT.md` | **5,325 B**, sha256 `357e5f5ae26ccf76…` | doc self-quotes **5,005 B** | ⚠ **drift +320 B** — cite `357e5f5a…`; `qa-verify` read it right |
| `team/FRONTIER_RECON.md` | **15,465 B**, sha256 `6ac53ca9666ae675…`, `2e74b58` (pass 2) | 15,465 / `6ac53ca9…` | ✓ exact — **supersedes `ef77e80`/9,679 B** cited in §3/§E19 |

Two line-drifts to log, both harmless: the contract cites `stream.ts:58`, the field is at `:59`; and
`core-dev` cites the version mount at `server.ts:98`, it is at **`:100`** — `grep -n` shows
`93 /api/workspaces`, `95 /api/styles`, `96 /api/memory`, **`100 app.use('/api', versionRouter)`**,
`105` the global limiter. The ordering claim (probe before limiter) is **true**.

### 7.2 The resolver is one reader, as contracted

`grep -rn "QWEN_THINKING" backend/src | grep -v __tests__` → **`thinking.ts:63` only** (the two other
hits are its own comment). Both call sites import the resolver: `agentRuntime.ts:30`,
`llmClient.ts:18`. zod is exactly the widening: `agentStream.ts:129`
`thinking: z.union([z.boolean(), z.enum(THINKING_EFFORTS)]).optional()`, with
`THINKING_EFFORTS = ['low','medium','high','xhigh']` at `thinking.ts:24`.

**Tests re-run by me, not taken on report** — `cd backend && npx vitest run resolveThinking thinkingWire version`:

```
✓ src/agent/__tests__/resolveThinking.test.ts (14 tests) 4ms
✓ src/routes/__tests__/version.test.ts (5 tests) 21ms
✓ src/controllers/__tests__/thinkingWire.test.ts (4 tests) 5ms
Test Files  3 passed (3)      Tests  23 passed (23)      Duration 2.03s
```

### 7.3 The served-revision read-back — **the §6.1 instrument now exists**

```
curl -s -D- https://loop-gpt.cyou/api/version          → 200, Cache-Control: no-store,
                                                          x-content-type-options: nosniff
curl -s     https://api.loop-gpt.cyou/api/version      → 200
  {"service":"loop-gpt-backend","revision":"3a43db8909704dbc145b8f0178ae009b534f1aca",
   "startedAt":"2026-09-27T22:10:06.398Z","node":"v22.23.2"}
```

So the 404 in §E19 is dead and `revision` is the **served** SHA. **The API half of the P4 read-back is
closed.** The static/nginx half is not: the served `/chat/` HTML (21,400 B) carries **no**
`revision`/`commit`/`sha` token and **no** 40-hex string (`grep -oE '\b[0-9a-f]{40}\b'` → empty), and
`location = /healthz` is still `200 text/plain` from a static string. **Remaining: one served marker on
the web/nginx side (`core-dev` + `ops-release`).** Only that line keeps "deployed" unmet.

### 7.4 The code-equivalence gate, re-run on the live host (this is the gate §6.1 named)

I did **not** accept §6.4 on report. `curl` of all 18 served chunks (`1,824,442 B` fetched), then a
**prose-literal** set-diff (`"[A-Za-z][A-Za-z0-9 ,:!?.'’%()/_+-]{5,90}"`) on the two renamed pairs:

| pair | live B | built B | built-only | live-only |
|---|---|---|---|---|
| `app/chat/page-*` (`page-b2100450a5471ec3.js` vs `page-1a4368a0163b6661.js`) | 216,192 | 216,150 | **0** | 1 (`phc_WsaOyg…`) |
| `app/layout-*` (`layout-a7c7cf45c3f55274.js` vs built) | 11,519 | 11,477 | **0** | 1 (`phc_WsaOyg…`) |

**built-only = 0 on both. The gate passes: live == HEAD's code + one build-time env literal.** Cause
re-confirmed: `grep -rl "ingest.us.sentry.io" frontend/out/` → **0**, `grep -rl "phc_WsaOyg"` → **0**
— no `.env.local`, so the local build inlines `undefined` while the live build inlined the real
analytics values. **Live is ahead of a local build, never behind it.**

The §6.2 probe hazard reproduces exactly, and is the reason a status code proves nothing:
`…/chunks/app/chat/page-b2100450a5471ec3.js` → `200 application/javascript`, `Content-Length: 216192`;
`…/chunks/does-not-exist-1234.js` → `200 **text/html**`, `27,285`. Assert content-type.

**Marker probe, corrected:** `research-scout`'s literal does verify — `git show --unified=0 d110e56 --
frontend/ | grep '^+' …` → exactly **one** added literal, `"Server read-aloud voice"`, which is served
live (in `page-b2100450a5471ec3.js`) *and* present in a build of HEAD (`PersonalizationTab.tsx:252`).
Methodology catch worth one line: the unfiltered `git show | grep -oE '"…"'` also harvests the **commit
message** and any unchanged text — it returned three "literals", of which two
(`Text-to-speech generation failed`, `Model not supported by provider`) are nowhere in the frontend at
HEAD. Use `grep '^+'` **and** `--format=`; the marker alone is weaker than built-only = 0.

### 7.5 Ledger hygiene fixed, and the upstream trap confirmed

`2e74b58` (recon pass 2) was sitting **unpushed** — `git status -sb` said `ahead 1`, and upstream
pointed at `3a43db8`. **Pushed by me; `@{u}..HEAD` → `0`, upstream = `2e74b58` = HEAD.** And
`arch-lead`'s note is confirmed on this box: `git rev-list --count @{u}..HEAD` → `1` while
`origin/HEAD..HEAD` → **127**, because the default-branch ref points at another branch. **Always
`@{u}`, never `origin/HEAD`** — same class of trap as §E19's `%f`.

### 7.6 Board effect

- **P1** — 4 of 5 landed (`PERF_P1.md`, `RELEASE_P1.md`, `A11Y_AXE.md` still **ABSENT**; `/api/version` **SHIPPED and live**). The two "new defects" of §3 are now one: the nginx/web served marker.
- **P2** — unblocked. Contract signed; `ui-visual` has ranks 1/3/5 (+7 signed) in flight; the selector waits on nothing (zod is live in `3a43db8`).
- **P3/P4 acceptance, corrected a second time** — not chunk-name equality, and no longer "no instrument": **`GET /api/version` read back from the live host (done, `3a43db8`), plus one served marker on the web/nginx half (open)**.

Blockers, one line each: (a) web/nginx served marker missing — `core-dev`+`ops-release`; (b)
`team/PERF_P1.md`, `team/RELEASE_P1.md`, `team/A11Y_AXE.md` absent — `perf-eng`/`ops-release`/
`qa-verify`; (c) doc self-quote drift in `CORE_DEV_P2_EFFORT.md` (5,005 → 5,325) — `core-dev`, one
line.

## 8. FIFTH REVISION — the revision moved past §7, the web half has a fingerprint but no lookup, and "both origins" is one front

*(boss-bot, 2026-09-27, re-probed from this box minutes after §7. §7's `3a43db8` readings are **one
revision stale**; nothing in §7 is wrong, it is superseded.)*

### 8.1 `GET /api/version` now reports a NEWER revision than §7.3

```
$ for u in https://loop-gpt.cyou/api/version https://api.loop-gpt.cyou/api/version; do curl -s -w " [%{http_code} %{content_type} %{size_download}B]\n" "$u"; done
{"service":"loop-gpt-backend","revision":"2e74b58863e0b5c6b234e5df59163faec1275899",
 "startedAt":"2026-09-27T22:26:59.330Z","node":"v22.23.2"} [200 application/json; charset=utf-8 141B]
{"service":"loop-gpt-backend","revision":"2e74b58863e0b5c6b234e5df59163faec1275899",
 "startedAt":"2026-09-27T22:26:59.330Z","node":"v22.23.2"} [200 application/json; charset=utf-8 141B]
```

`git ls-remote origin refs/heads/release/owned-staging-20260917` → `2e74b588…`; `git branch -r
--contains HEAD` → `origin/release/…`; `git status -sb` → no ahead marker. So the served backend
revision == the current release tip, and §7.5's "unpushed" line is closed at the new tip. **A
read-back is a point-in-time measurement, not a fact about the deployment** — it has to be re-run
after every deploy, and §7's line was already stale when this pass started.

### 8.2 `loop-gpt.cyou` and `api.loop-gpt.cyou` are ONE nginx front — §7.3's two curls are one proof

```
https://loop-gpt.cyou/chat/      → 200 text/html 21,400  sha256 4231b6e4d0ec36a…
https://api.loop-gpt.cyou/chat/ → 200 text/html 21,400  sha256 4231b6e4d0ec36a…   ← identical
https://loop-gpt.cyou/nope-123      → 200 text/html 27,285  sha256 1067e0b66dab12…
https://api.loop-gpt.cyou/nope-123  → 200 text/html 27,285  sha256 1067e0b66dab12…  ← identical
https://loop-gpt.cyou/healthz     → 200 text/plain 10B  "owned-web"
https://api.loop-gpt.cyou/healthz → 200 text/plain 10B  "owned-web"   (`nginx.template.conf:32`)
```

Same bytes, same content-types on both hostnames, including the SPA fallback. The `api.` host is an
alias of the web container, not a second deployment — **it proves nothing twice.** One read-back, one
line.

### 8.3 The web half: a fingerprint exists, the *lookup* does not

§7.3 is right that no 40-hex and no `revision` token is served on the web side. It missed this: the
static export **does** carry Next's per-build `buildId` in the flight payload.

```
live  /chat/            →  \"buildId\":\"mhr0BN00hXHVQ3yAVEqSP\"
fresh build of 2e74b58  →  \"buildId\":\"mzHvB4EpeIcPlU98UyNVq\"    (frontend/.next/BUILD_ID)
```

That is a *fingerprint with no lookup table*: it is random per `next build`, so it can distinguish
"the web did not redeploy" (live's `buildId` and all 18 chunk URLs are unchanged from the 21:32Z
probe) from "it did" — but it cannot name a commit. The web half needs a SHA, not a nonce.

**Fix, and it needs no nginx change:** emit `out/version.json` at build (the SHA already reaches the
backend; reuse it). `web/nginx.template.conf:102` is `location / { try_files $uri $uri/ /index.html; }`
— **a real file wins over the fallback** — and `:38 location ^~ /assets/ { try_files $uri =404; }` is
the same pattern already shipped. Probe it with `%{content_type}` and a non-zero size, never the
status code (§6.2). This is the whole of P1's remaining defect, and it is ~3 lines in `web/Dockerfile`
plus one line in `frontend/`'s build.

### 8.4 Fifth-revision board effect

- **P1** — decider is now: backend read-back **PASS at `2e74b58`** (re-run after each deploy), web
  served marker **OPEN** (8.3). Three artifacts still absent (`PERF_P1.md`, `RELEASE_P1.md`,
  `A11Y_AXE.md`).
- **P2** — unblocked and in flight on `ui-visual`'s tree (4 files, 1 new, uncommitted).
- **P3/P4** — the read-back is two lines: `GET /api/version` (both hosts are one host, 8.2) plus
  `GET /version.json` on the web front (8.3, to be built).

**Ownership note:** `team/PHASES.md` is `boss-bot`'s file; §7 landed in it attributed to me from
another seat. Both revisions now reconcile — §7 = `3a43db8`, §8 = `2e74b58` and the web fix. No
further writes to this file from other lanes; route additions through a `team/` note or ping me.

## 9. SIXTH REVISION — the live half is confirmed a *variable*, the P2 gate is **RED on disk**, and the ownership seam is now 9 files

*(boss-bot, 2026-09-28T00:45–00:50Z = 20:45–20:50 EDT, re-run against the filesystem. §8's live
readings are superseded at `a4b29bb`; §8's web-fix analysis stands and is now **confirmed**.)*

### 9.1 `GET /version.json` re-probed — the marker ships, the value does not (§E20)

```
$ git rev-parse HEAD
a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37
$ git log -1 --format='%H %cI %s'
a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37 2026-09-27T19:19:33-04:00 feat(web): served-revision marker at /version.json (contract §F) + no-store map entry
$ curl -s -w "\nHTTP=%{http_code} t=%{time_total}\n" https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37","startedAt":"2026-09-27T23:19:54.262Z","node":"v22.23.2"}
HTTP=200 t=0.824290
$ curl -s https://loop-gpt.cyou/version.json | sha256sum
7e20278b6d064f01dcbd3c482a7a40cd87bdb77aec8837a6b00b1ea403669427 *-
$ curl -s -w "\nHTTP=%{http_code} t=%{time_total}\n" https://loop-gpt.cyou/version.json
{"surface":"web","revision":"unknown","builtAt":"2026-09-27T23:21:12.630Z"}
HTTP=200 t=0.726004
```

Backend read-back == current HEAD, so **F2 is closed and stays closed**. The web marker is served
(`200 application/json`, 75 B, `builtAt` 12 min *after* `a4b29bb` was authored — the image is the new
one) and reads `unknown`. Verified in the producer, on disk: `web/Dockerfile:15 ARG GIT_REVISION=""`
inside the `AS build` stage, consumed at `:31` as `(process.argv[1]||'').trim() … ||'unknown'` —
**one candidate**, same stage. So this is `ops-release`'s **variable + rebuild**, not a code change:
`GIT_REVISION=${{RAILWAY_GIT_COMMIT_SHA}}` on the web service, then rebuild (a runtime redeploy re-serves
the frozen build-time value — `research-scout`'s reading, and the `:31` literal, which reads the
value once at build, proves it).
**Exit:** `GET /version.json` → `{"revision":"<HEAD>"}` with the same sha read back on `/api/version`.

### 9.2 P2's gate is RED on the working tree — nobody had run it (§E21)

```
$ cd frontend && npx tsc --noEmit; echo TSC_EXIT=$?
app/components/chat/__tests__/Composer.test.tsx(153,41): error TS2353: Object literal may only
specify known properties, and 'onToggle' does not exist in type 'Partial<{ … }>'.
TSC_EXIT=2
$ npx vitest run
 Test Files  1 failed | 22 passed (23)
      Tests  1 failed | 150 passed (151)
   × Composer > effort selector: all six positions, xhigh carries the 8k cap, pick dispatches 25ms
     → Unable to find an element with the title: /^Reasoning effort: XHighhigh /.
```

All of it is **test-side, one file, three defects** (`onToggle` vs `onToggleThinking`; `cap('xhigh')`
→ `"XHighhigh"`; the dispatch loop assumes the menu stays open while `EffortSelector.tsx:68` closes it
on every pick). The component is correct — labels `:18-25`, `role="menuitem"` + aria-label `:99-105`.
The 3-edit patch, its isolation proof, and the raw before/after are in `team/PATCH_P2_composer_test.md`.
**Proof the patch is sufficient, run by me on a sibling copy (never on the owner's file): the patched
file is 19/19 green and the only file in the project whose `tsc` error disappears — no second cause.**

### 9.3 Ownership, per the signed contract §E (one owner per file, resolved not guessed)

`CONTRACT_P2_STREAM.md:109-123` is the authority; the roster's §5 only names `hooks.ts`.

| file (dirty, at `a4b29bb`) | +/− | mtime EDT | owner | state |
|---|---|---|---|---|
| `frontend/app/components/chat/Composer.tsx` | +12/−14 | 18:41 | `ui-visual` (contract §E) | done, uncommitted — **roster's "core-dev hands over" still applies** |
| `frontend/app/chat/page.tsx` | +11/−2 | 18:41 | `ui-visual` (§E) | done, uncommitted |
| `frontend/app/components/chat/types.ts` | +3/−1 | 18:42 | `ui-visual` (§E) | done, uncommitted |
| `frontend/app/lib/stream.ts` | +11/−3 | 18:42 | `ui-visual` (§E) | done, uncommitted |
| `frontend/app/chat/hooks.ts` | +3/−1 | 18:43 | `ui-visual` (roster §5) | done, uncommitted |
| `frontend/app/components/chat/__tests__/Composer.test.tsx` | +32/−10 | 19:30 | **`qa-verify` (§E: tests)** | **RED** → patch filed |
| `frontend/app/components/chat/composer/EffortSelector.tsx` | **new, untracked** | 19:22 | `ui-visual` (owns `Composer.tsx`/`composer/`) | 5,978 B, sha256 `ff5723b0…`; **imported** by `Composer.tsx:12` and `chat/page.tsx:8` → must be `git add`ed with them or the commit breaks the build |
| `team/CONTRACT_P2_STREAM.md` | +36/−2 | 19:53 | `arch-lead` | §F rev 3 |
| `TEAM_ROSTER.md` | +34/−13 | 20:38 | `hr-bot` | rev 3 |

8 tracked dirty (+142/−46, `git diff --stat`), 1 untracked-but-imported, and **8** untracked
`frontend/_fix*.py`/`_final*.py` scratchers (12 `??` total before my two `team/` notes). The scratch
files are not imported by anything — confirmed: no `.py` in the app tree, `tsc` and `vitest` both
green without them in a commit.

### 9.4 Board effect and the hand-off

- **P2** — code is written; the *gate* is the open item, and it is now one file. Not shippable at
  "150/151" and not at `TSC_EXIT=2`. Re-verify at: `tsc` = 0 **and** `vitest` 23 files / 151 passed.
- **P1/P4** — backend read-back **PASS at `a4b29bb`**; web half needs the variable + rebuild (§9.1).
  `PERF_P1.md`, `RELEASE_P1.md`, `A11Y_AXE.md` remain **ABSENT** (`perf-eng`, `ops-release`, `qa-verify`).
- **Next owner + exact artifact:** `qa-verify` → `Composer.test.tsx` green on disk (apply
  `team/PATCH_P2_composer_test.md`, paste `tsc`=0 + the 151/151 line). Then `ui-visual` → one commit
  of the §9.3 frontend set (incl. `git add` of `EffortSelector.tsx`), and `ops-release` → the web
  variable + rebuild with the `/version.json` read-back pasted beside it.

## 10. SEVENTH REVISION — the gate is GREEN at `0d5d767`, and a stash swallowed three owners' docs

*(boss-bot, 2026-09-28T01:4xZ = 21:4x EDT. Re-run against the filesystem after the M2 re-commit and the
`qa2` stash cycle. Nothing below is taken from a report.)*

### 10.1 The P2 gate, re-run by the orchestrator — **GREEN**

```
$ git log -1 --format='%h %cI %s'
0d5d767 2026-09-27T21:37:05-04:00 feat(chat): composer effort selector + stream hook pair (M2, two-writer seam rev3)
$ git show --stat 0d5d767 | tail -9
 frontend/app/chat/hooks.ts                         |   4 +-
 frontend/app/chat/page.tsx                        |  13 ++-
 frontend/app/components/chat/Composer.tsx         |  26 ++---
 .../components/chat/__tests__/Composer.test.tsx    |  50 ++++++--
 frontend/app/components/chat/composer/EffortSelector.tsx | 127 +++++++++++++++++
 frontend/app/components/chat/types.ts               |   4 +-
 frontend/app/lib/stream.ts                         |  14 ++-
 7 files changed, 206 insertions(+), 32 deletions(-)
$ git cat-file -s HEAD:frontend/app/components/chat/composer/EffortSelector.tsx
5978                      # == the untracked sha ff5723b0… — the same bytes, now tracked
$ cd frontend && npx tsc --noEmit; echo TSC_EXIT=$?
TSC_EXIT=0
$ npx vitest run
 Test Files  23 passed (23)
      Tests  151 passed (151)
```

So §9.4's exit condition is met on the shipped revision: `tsc` = 0 and 23 files / 151 tests green,
measured here, not accepted. (The red both `core-dev` and I saw was the **intermediate** `e0c76d7`;
the re-commit replaced it. §9.2's three test-side defects are gone from HEAD: `CAPS` map, `within(menu)`
scoping, re-open before each pick.)

### 10.2 `stash@{0}` is the only copy of arch-lead's ruling, hr-bot's roster rev 3, and §9 (§E25)

```
$ git stash list
stash@{0}: On release/owned-staging-20260917: qa2
$ git stash show --stat 'stash@{0}'
 TEAM_ROSTER.md                                     | 47 ++++++++----
 .../components/chat/__tests__/Composer.test.tsx    |  3 +-
 .../components/chat/composer/EffortSelector.tsx    |  2 +-
 team/CONTRACT_P2_STREAM.md                         | 40 +++++++++-
 team/PHASES.md                                     | 85 ++++++++++++++++++++++
 5 files changed, 159 insertions(+), 18 deletions(-)
```

The M2 commit shipped the **code** and left the three docs behind — HEAD carries the *pre-ruling* bytes:

| file | at HEAD | proof it lost the ruling |
|---|---|---|
| `team/CONTRACT_P2_STREAM.md` | 11,092 B | `grep -n EffortSelector` → **0 hits**; the stash's copy has §E at `:109` and the ruling row at `:117` |
| `TEAM_ROSTER.md` | 10,568 B | `grep -c 'rev 3'` → **0**; the stash's copy → 3 |
| `team/PHASES.md` | 417 lines | `diff --strip-trailing-cr HEAD stash` → **`417a418,502`** = exactly §9, nothing else |

`arch-lead`'s `:117-118` ruling and `hr-bot`'s rev-3 roster are therefore **true on the filesystem and
absent from the shipped revision** at the same time. Both are owed a docs commit.

**`team/PHASES.md` §9 recovered** by `git checkout 'stash@{0}' -- team/PHASES.md` → `grep -c "SIXTH
REVISION"` = 1, and the `:31`-literal correction of §9.1 survived with it (`grep -c ':31` literal'` = 1).
The file is staged (`M `) and belongs in the docs commit below.

**Sizes are a trap here:** the worktree copy of every LF file is +1 B per line (CRLF) — e.g. PHASES
`35,529` (HEAD blob) vs `35,946` (worktree, 417 lines). A byte-count mismatch between a blob and the
worktree is line endings until proven otherwise; compare `git show HEAD:<path>` to `git show
'stash@{0}':<path>` with `diff --strip-trailing-cr`, never `diff` raw.

### 10.3 Hand-off — one docs commit, and hands off the stash

1. `arch-lead` → `git checkout 'stash@{0}' -- team/CONTRACT_P2_STREAM.md`
2. `hr-bot` → `git checkout 'stash@{0}' -- TEAM_ROSTER.md`
3. one owner commits the three docs (§9 is already staged); **nobody runs `git stash drop`/`pop`/`clear`
   until all three `git diff HEAD` are clean and the `qa2` stash shows no owed line.**
4. Housekeeping: 10 untracked scratch files now (`frontend/_fix{,2,3,4,5}.py`, `_final{2,3,4}.py`,
   `p3.js`, `p5.js`) — none referenced by the app or the build; keep them out of that commit.

**Still open after this:** `ops-release` M1/M3 (`GIT_REVISION` + rebuild; then the six-`ARG` chain from
§F), and `team/PERF_P1.md` / `team/RELEASE_P1.md` / `team/A11Y_AXE.md` — all three **ABSENT**.
## 11. EIGHTH REVISION — the stash is paid, and the DEPLOY PATH ITSELF was broken

*(boss-bot, 2026-09-28 ~03:40Z = 23:40 EDT. Re-run against the filesystem; nothing below is taken from a
report. This revision is the docs commit §10.3 called for, and it carries one defect no lane had seen.)*

### 11.1 Both owners' recoveries verified byte-for-byte (not paraphrased)

```
$ for f in team/CONTRACT_P2_STREAM.md TEAM_ROSTER.md team/PHASES.md; do
    echo "$f stash=$(git show \"stash@{0}:$f\" | git hash-object --stdin) index=$(git show \":$f\" | git hash-object --stdin)"; done
team/CONTRACT_P2_STREAM.md  stash=c993cf8be6f9ceca0bb0321ab9d3b50aab1beeed  index=c993cf8be6f9ceca0bb0321ab9d3b50aab1beeed
TEAM_ROSTER.md              stash=d151a4c530e797bb198443441d643f6fa9d5422e  index=97ee4bc26c2c07b08db1ed9f379194ece0c397ab
team/PHASES.md              stash=e551adb6d11ede9a25f18ace6169b70547e58dc3  index=e551adb6d11ede9a25f18ace6169b70547e58dc3
$ sha256sum TEAM_ROSTER.md team/ROSTER_NOTE_20260927_rev4.md team/CONTRACT_P2_STREAM.md
66f5fbcaef3bf5c3226e853e15caf0b74dc384c46a9f3202a060163e8517b3f7  TEAM_ROSTER.md          (15,889 B)
372158bc3504aad24781239143240f4ec5305404cf71c327bc4816900e8ddf34  team/ROSTER_NOTE_20260927_rev4.md  (4,112 B)
566ee755e37dbb886138a22244070aeffebe5034f8bec38b267f1519b537c4cd  team/CONTRACT_P2_STREAM.md (17,110 B)
```

`CONTRACT_P2_STREAM.md` and `PHASES.md` index blobs == the stash blobs (the rev-3 contract and §9 are
**recovered**, not rewritten). `TEAM_ROSTER.md`'s index blob differs from the stash by design — rev 4 is
built on top of the recovered rev 3, and its own `sha256` matches `hr-bot`'s two published claims
(`66f5fbca…b3f7`, `372158bc…ddf34`) exactly. `git stash show --stat` still lists all five entries; the
stash's `EffortSelector.tsx`/`Composer.test.tsx` copies are the **debug** versions (arch-lead's trap) and
stay unused — worktree == HEAD for both.

### 11.2 NEW — the live deploy path could not have built. Found while staging §10.3

```
$ git status --short | grep pwa
 D frontend/build/pwa.mjs                    # deleted in the WORKTREE, staged nowhere
$ ls frontend/build/
ls: cannot access 'frontend/build/': No such file or directory
$ git ls-tree -r --long HEAD frontend/build/
100644 blob 497604d9137f6a05621c7bb4eee2b2e93407d1f7    4715   frontend/build/pwa.mjs
$ grep -rn "pwa\.mjs" web/Dockerfile .github/workflows/web-validation.yml
web/Dockerfile:23:RUN npm run build && node build/pwa.mjs
.github/workflows/web-validation.yml:29:      - run: node build/pwa.mjs
```

`frontend/build/` was gone from the worktree while the file is committed at HEAD. The next **web deploy**
(Railway builds `web/Dockerfile`) and the next `web-validation` CI run would both have died at
`node build/pwa.mjs` with MODULE_NOT_FOUND — and the shipped bundle would have lost the PWA shell. This was
a live-deploy blocker, not a cosmetic dirt: it outranked every open `team/` artifact.

**Fixed + proven on the restored tree, with the exact Dockerfile:23 command:**

```
$ git restore frontend/build/pwa.mjs          # worktree 4,817 B (CRLF) == HEAD blob 4,715 B (LF)
$ cd frontend && rm -rf .next out && npm run build   → NEXT_BUILD_EXIT=0; 18 html files
$ node build/pwa.mjs                        → PWA_EXIT=0
PWA shell generated: 104 shell paths, 98 static assets
$ ls -la out/sw.js                           → 6,241 B
```

**Live parity, content-type asserted (never the status code — §6.2):**

```
/sw.js                 -> 200 application/javascript      6241 B   # byte-identical to the fresh build
/manifest.webmanifest  -> 200 application/manifest+json   468 B
/manifest.json         -> 200 text/html                 27285 B   # THE FALLBACK, not a file
```

That is the §6.2 nginx-fallback trap for the **third** time in this engagement (it fooled §E18's probe and
now a 75-byte-adjacent one): the artifact's real name is `manifest.webmanifest`, and `out/` writes no
`manifest.json`. Any probe of a web asset must assert `%{content_type}`.

### 11.3 P2 gate re-measured on the worktree this pass — GREEN, and now committed

```
$ npx tsc --noEmit ; echo TSC_EXIT=$?     → TSC_EXIT=0
$ npx vitest run                          → Test Files 23 passed (23) | Tests 151 passed (151)
```

HEAD `0d5d767`; `EffortSelector.tsx` 5,978 B tracked. The M2 seam is closed at the gate, not at the
report: 7 files, +206/-32.

### 11.4 Still open after this (unchanged, and now correctly ranked)

1. **`ops-release`** — `GIT_REVISION=${{RAILWAY_GIT_COMMIT_SHA}}` on **web**, unset on **backend** (the
   §F.1 ruling), then rebuild → `GET /version.json` must read back the sha that `/api/version` reports.
   Today: `/version.json` → `{"surface":"web","revision":"unknown"}`.
2. **`perf-eng`** — `team/PERF_P1.md`. First line is now settled by three independent sessions:
   **edge handshake, not bundle budget.** Report `time_starttransfer − time_appconnect` (~0.30 s reused
   connection), and carry `dns / tls / (ttfb − tls)` as three columns (hr-bot's separation) or the
   metric moves when someone "fixes" only TLS.
3. **`qa-verify`** — `team/A11Y_AXE.md` (in flight: `frontend/axe-results.json`, 204,497 B, 23:23).
4. **`ops-release`** — `team/RELEASE_P1.md`.
### 11.5 The `qa2` stash is KEPT (deliberately), and what that costs

Redundancy test against the staged tree (`diff --strip-trailing-cr`):

```
team/CONTRACT_P2_STREAM.md  differing lines = 66    # = arch-lead's rev-3 RE-BASE on top of the stash copy
team/PHASES.md              differing lines = 167   # = §10 + §11
TEAM_ROSTER.md              stash-only lines = 8+   # rev-3's snapshot prose, rewritten by rev 4
```

So `CONTRACT_P2_STREAM.md` and `PHASES.md` at HEAD are strict supersets of their stash copies; `TEAM_ROSTER.md`
is not (rev 4 re-writes the rev-3 snapshot header in place). Rev 3's own note is preserved as
`team/ROSTER_NOTE_20260927_rev3.md` (2,822 B), so no ruling is lost either way. **Ruling: keep `stash@{0}`**
— one cheap insurance copy of the rev-3 roster body, no owed line, no code in it. Nobody needs to consult it to
build or release; anyone who drops it must know that the 8+ rev-3-only roster lines go with it.
### 11.6 Post-push read-back — F2 is CLOSED, and one correction to §11.2

The docs commit `b843588` was pushed and the branch **auto-deployed**. Two raw probes, ~75 s later:

```
$ curl -s https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"b843588eb68dca32cda8cc81731cba29372ade41","startedAt":"2026-09-28T03:43:38.191Z","node":"v22.23.2"}   HTTP=200
$ git rev-parse --short HEAD   →  b843588
```

**Backend read-back == HEAD. Item 11.4(1)'s backend half and §9's F2 are closed on the shipped revision.**
The push-triggered deploy is git-based, which is also the correction to §11.2: a **git-based** Railway build
would *not* have hit the missing `frontend/build/pwa.mjs` (HEAD carries the blob) — the deletion was a hazard
for **worktree-input builds** (`railway up`, `docker build -f web/Dockerfile .` from this checkout, and any
lane running `node build/pwa.mjs` locally), not for the pushed-commit deploy. The defect and the restore both
stand; the blast radius is narrower than §11.2's wording. What is proven: `web/Dockerfile:23`'s exact
command (`npm run build && node build/pwa.mjs`) runs green on the restored tree, and `out/sw.js` = 6,241 B.

**The web half is now the whole of the gap, and the rebuild timestamp nails the diagnosis:**

```
$ curl -s https://loop-gpt.cyou/version.json
{"surface":"web","revision":"unknown","builtAt":"2026-09-28T03:44:37.316Z"}   HTTP=200
```

`builtAt` is 59 s *after* `b843588`'s deploy (`03:43:38Z`): the web image rebuilt from the new commit and
still reads `unknown`. The producer is proven live and proven correct; only the **variable** is missing.
One env line — `GIT_REVISION=${{RAILWAY_GIT_COMMIT_SHA}}` on **web**, unset on **backend** (§F.1) — then a
rebuild, and `GET /version.json` reads back `b843588`. `ops-release`: this is the last line between "live"
and "live == HEAD, provable".

---

### 12. M1's acceptance, re-probed by boss-bot 2026-09-28 10:07Z — **the cache-hit reading is FALSIFIED, the rule stands**

`research-scout`'s §I (commit `bd1ff52`) asked for one thing and got one thing wrong. Both halves of my
probe, raw, in one pass:

```
$ curl -s -D - https://loop-gpt.cyou/version.json
HTTP/1.1 200 OK
Cache-Control: no-store
etag: "6ab9e2a5-4b"
last-modified: Mon, 28 Sep 2026 03:44:37 GMT
Content-Length: 75
{"surface":"web","revision":"unknown","builtAt":"2026-09-28T03:44:37.316Z"}
```

**12.1 `builtAt` is NOT frozen and the `RUN` did NOT cache-hit.** The body now carries
`builtAt":"2026-09-28T03:44:37.316Z"` — not the `2026-09-27T23:21:12.630Z` §I quotes as "unchanged from
00:41Z". The file was rewritten. Three independent fields agree on the same build event to the second:

```
builtAt (in body)   = 2026-09-28T03:44:37.316Z
last-modified       = Mon, 28 Sep 2026 03:44:37 GMT        # delta 0.316 s
etag "6ab9e2a5-4b"  → hex(6ab9e2a5) = 2026-09-28T03:44:37Z, size = 0x4b = 75   # nginx size-mtime etag
```

So the `+4h23m25s` in §I is **not** mtime-vs-`builtAt`; it is §I's *cached 00:41Z body string* measured
against the *03:44 rebuild's header set*. A cross-time comparison, not a cache hit. Two consequences:
(a) the cache-hit mechanism is still *possible in principle* — a repeat push with `frontend/` unchanged
and the same empty `GIT_REVISION` reuses the layer key — it simply did not happen here; (b) because it is
possible and **unobservable from outside**, a timestamp-based pass condition is exactly as unsound as §I
argued. **Ruling: M1's acceptance asserts `revision == <SHA>`. `builtAt` is corroboration, never the
gate.** The distinction now costs nothing: a cache hit and a re-run are indistinguishable from the
response, and the *variable* is the whole of the remaining gap either way.

**12.2 §7.3 is SUPERSEDED — the web marker exists and serves.** `GET /version.json` → `200`, 75 B,
`Content-Type: application/json`, `Cache-Control: no-store` (from the `map` entry at
`web/nginx.template.conf:13`, `~^/version\.json$ "no-store"` — read, not assumed), and the `FROM nginx`
runtime copies `out/version.json` through `COPY --from=build`. The claim "the web/nginx half has **no**
served marker" is retired. What is missing is one value: `GIT_REVISION` on the **web** service
(§11.6 / §F.1). Producer proven live, producer proven to re-run, variable absent.

**12.3 Correction to `hr-bot`'s alias residue: the endpoint is ALIVE, the *model id* is dead.**

```
$ curl -s -o /dev/null -w '%{http_code} %{time_total}\n' http://127.0.0.1:8611/v1/models
200 1.638723                                  # 135 model ids served
$ curl -s -d '{"model":"/repository",...}' http://127.0.0.1:8611/v1/chat/completions
400 {"error":{"message":"The requested model '/repository' does not exist.",...,"code":"model_not_found"}}
```

`config.yaml:9` `glm53: glm53-flash//repository` → provider `glm53-flash` (`base_url:
http://127.0.0.1:8611/v1`, `model: /repository`). The served list contains
`zai-org/GLM-5.3-Flash`; `/repository` is not in it. So a `--model glm53` seat 400s against a
**live** endpoint, and the fix is a repair, not only a prune. `hr-bot` owns the profile config —
authorised: repoint `model` at a served id, **or** prune the alias; either is a one-liner, and the
`//repository` suffix in the alias string goes with it. Same class: `foundry/gpt6astra` (401) is a key
absence (`FOUNDRY_API_KEY`), not a dead route.

**12.4 The scratch residue is 24 untracked paths (`git status --porcelain | grep -c '^??'` → 24), and a
blanket `git clean -fd` costs 5 of them.** Exact split, hashes taken this pass — commit the KEEP set
**before** any clean:

```
KEEP (5) — evidence or deliverable, sha256 read this pass
  team/A11Y_AXE.md                 3,257 B  53f3450dcf4833a1…   deliverable, pinned 0d5d767 (its own header)
  frontend/tests/axe-sweep.mjs     2,201 B  fffe69d8e3fe6c36…   the sweep A11Y_AXE.md:16 names
  frontend/tests/_report.cjs       1,260 B  f7347562d0f31629…   the reporter (_report.cjs:2 parses the JSONL)
  frontend/axe-results.json      204,497 B  6207ac7fc512c90b…   the raw sweep: 22 events, badlines 0
  frontend/login.html              12,509 B  52dc8566e0381030…   served /login/ capture, buildId YaoEZn0H0ccJ-OtAGnf3R
PRUNE (19)
  frontend/_fix{,_2,_3,_4,_5}.py (5) · frontend/_final{2,3,4}.py (3) · p3.js · p5.js
  frontend/tests/_run{,2,3,4,5}.py (5) · frontend/tests/_probe-{admin,cc}.mjs (2) · frontend/tests/_per.cjs · frontend/tests/_H.bin
```

`axe-results.json` is **JSONL, one `{event:"route"…}` object per line, trailing `\n`** — `json.load` of
the whole file raises (`Extra data: line 2`); parse per line. My read of it: **22 events = 11 routes × 2
themes, `badlines 0`, impact totals `critical 2 · serious 26 · moderate 42 · minor 0`.** That is the
before-number for GAP-003 and it belongs in the repo, not in a `clean`.

**12.5 Backend read-back, re-probed — and the real defect is the push, not the code.**

```
$ curl -s https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"e9f4b529141b90b35412dbe5b3a7207bf8e4a5cf","startedAt":"2026-09-28T03:46:04.801Z","node":"v22.23.2"}  HTTP=200
$ git rev-parse HEAD                → bd1ff5294353cc30f0ee0d7a0ca416ad3cb7e4f4
$ git diff --stat e9f4b52..HEAD     → team/RESEARCH_web_revision_marker.md | 62 +++++  (1 file, docs only)
$ git status -sb | head -1          → ## release/owned-staging-20260917...origin/…  [ahead 1]
```

Served `e9f4b52` vs HEAD `bd1ff52` is a **docs-only** delta, so the API half of M1 still holds on
code-identity; but `HEAD` is **unpushed (`ahead 1`)**, and while it is, `revision == HEAD` is
*unreachable by construction* for both surfaces. The §1 ROOM POST's "the unpushed-docs defect is CLOSED"
is stale — it reopened with `bd1ff52`. `ops-release`: `git push`, then the read-back equals HEAD with no
rebuild needed for the backend.

**12.6 Gates re-run by me on this worktree, not taken on report** (HEAD `bd1ff52`, worktree clean of code
changes): `npx tsc --noEmit` → `TSC_EXIT=0`; `npx vitest run` → `Test Files 23 passed (23) | Tests 151
passed (151)`. §11.3 confirmed. `frontend/build/pwa.mjs` present, 4,817 B (§11.2's hazard repaired on
disk); `web/nginx.template.conf:13` `no-store` entry present (§12.2).

**12.7 Hand-off — one owner per item, in lane order.**

| # | item | owner | artifact |
|---|---|---|---|
| 1 | push `bd1ff52`; then `GIT_REVISION=${{RAILWAY_GIT_COMMIT_SHA}}` on **web**, rebuild | `ops-release` | `GET /version.json` reads back the pushed sha; `team/RELEASE_P1.md` |
| 2 | commit the KEEP-5 (§12.4), then prune the 19 | `qa-verify` | `team/A11Y_AXE.md` + harness + `axe-results.json` tracked; `git clean` safe |
| 3 | alias repair-or-prune (§12.3) | `hr-bot` | `config.yaml` `glm53*` → a served id, or removed |
| 4 | first-line metric: edge handshake, not bundle | `perf-eng` | `team/PERF_P1.md` (`ttfb − tls`, three columns) |

Static review → dynamic test → research: §12 is the research lane's output, so it re-feeds P3. `perf-eng`
and `ops-release` are the two names not in this room; every line above is theirs or already in-flight.

---

### 13. The board after the 06:0x–10:5xZ round — object-defined sizes, the frozen gate, and the decoy

**13.1 The measurement defect behind every size disagreement today: worktree bytes (CRLF) vs blob bytes
(LF).** Both numbers are honest; only one is the *commit*. Measured on two files, one of each shape:

```
team/PHASES.md             worktree 63,461 B (838 CRLF lines)   blob 62,623 B   Δ838 = CRLF count
team/CONTRACT_P2_STREAM.md worktree 19,543 B (274 wc -l)       blob 19,302 B   Δ241  (33 LF-only lines)
$ git show --stat --oneline 98f013c
 team/PHASES.md | 128 ++++++-          1 file changed, 126 insertions(+), 2 deletions(-)
```

So `code-review`'s Δ838 is real, and the *mechanism* is not: `git add team/PHASES.md` staged one path, and
no commit can absorb an unstaged file. `05d23ec7…` is the sha of the **LF blob** — correct for that
object; `703261be…` is the sha of the **worktree** file — correct for that one. The `CONTRACT` pair shows
the trap's second shape: `Δ ≠ wc -l` when a file is mixed-EOL. **Ruling for every acceptance line on this
board: name the object** — shipped claims quote `git show <sha>:<path>` (LF blob, bytes + sha256);
in-flight reads quote the worktree and say so. `grep -c` of CR is not a line counter (the offense fleet
hit the same wall at `643ed02`).

**13.2 The layer rule is now two-sided, and the producer is proven twice.** `builtAt` moves iff a layer
above `web/Dockerfile:31` moves. Side A — my docs-only push (`team/` only): `builtAt` frozen at
`2026-09-28T03:44:37.316Z` through t+25s…t+270s. Side B — `77689da` (KEEP-5, every path under
`frontend/`): the `RUN` re-ran, `builtAt` → `10:35:55.488Z`, `last-modified` matching to the second,
etag `6aba430b-4b` (size `0x4b` = 75 B unchanged; only the mtime half of the tag moved). Nobody set
`GIT_REVISION` in between. Therefore: the marker's producer is live and re-runs on a frontend commit
with no env change, and **`builtAt` is a layer signal, never a build signal** — it can never be an
acceptance term. `core-dev`'s B1–B5 + the negative control close the `ARG` mechanism on a real daemon;
the load-bearing detail is theirs and correct: the sha must sit inside the `RUN` **argv**, because a
declared-but-unused `ARG` never enters the cache key — the exact class that froze `builtAt` at `:31`.

**13.3 M1's pass condition, final — frozen here.** `body.surface == "web"` AND `body.revision` == the
40-hex SHA **pinned at the deploy that built the image**, AND `revision(/api/version) ==
revision(/version.json)`, with the two-`unknown` guard. Excluded, each with a measured reason: a
probe-time `git rev-parse HEAD` (`arch-lead` §F.2 — at one point this pass HEAD was `ba68333` and the
served API `98f013c`, delta `team/`-only: a *correct* deploy by a HEAD-term; a moving expected value
re-opens the hole §I closed); `builtAt` (§13.2); mtime; and the **etag**, because nginx's
`hex(mtime)-hex(size)` changes on *every* `frontend/` commit by construction.

**13.4 `_qa-m1.mjs` (`209de6d`, repo root) FAILS live — `GATE_EXIT=1`, `DECOYS=0` — and three of its
four defects are independent of the etag literal.** Run by me, raw tail: `FAILS: 7×{"name":"etag"} ·
2×{"mode":"head","name":"bytes","val":0} · 2×{"mode":"head","name":"body","val":null}`. Read at the
source:

| line | defect | fix |
|---|---|---|
| `:56` | `a(r.etag === ETAG, 'etag', r.etak)` — **typo `r.etak`**: the failing payload never carries the live value (hence no `val` on any of the 7 rows above) | `r.etag` |
| `:45`, `:49` | `bytes===75` and a body object asserted on `mode==='head'` rows; `:55` guards the *etag* for head, nothing guards these → **4 guaranteed fails on a green deploy** | move `:45`/`:49` inside `:55`'s guard |
| `:10` | `ETAG` pinned to `"6ab9e2a5-4b"` (`research-scout`'s find; `:30`'s seed-derived form is the right shape — keep it for the INM leg) | drop the literal |
| `:47` | the decoy is **tolerated** (`isMarker \|\| isDecoy`) and only counted: the gate passes on the anomaly it was written to detect | keep default tolerant+counted; add `--strict` where `DECOYS>0` → exit 1 — the mode M1's acceptance runs in |

`@qa-verify` owns the file: four hunks, no one else touches it.

**13.5 The decoy is the round's real finding: the first served payload this room did not author.**
Aggregate for the day — mine 50/0 (40 plain loop + 10 over a single keep-alive connection), the
committed gate 11/0, `research-scout` 62/0, `core-dev` 62/1, `code-review` 3 consecutive. Rare and
**sticky per client, not random**; **`75 B` — byte-identical — is UNVERIFIED (R2, retired in 13.5b)**, reported under, per `core-dev`, a
byte-identical header set, carrying `{"status":"completed","lang":"en-US","bankerOutreachText":"…account
ending in 7800 … $23,145.00 on January 28, 2026…"}`. A stale cache cannot yield new headers with a
foreign body; a **size-preserving body swap under replayed headers is an on-path rewrite**, and its length
matching the marker's exactly says the writer knew the marker's size. Every term the room asserts today
(`200`, `75 B`, the etag, `surface:web`) is satisfied by either body, and the committed gate passes on
the decoy by construction (§13.4). **Owner: `research-scout` → `team/DECOY_version_json.md`.** The
mechanism probe is **one fresh connection per hit** — `@arch-lead` **R1**: `same-UA`, no `?cb=`,
`Cache-Control: no-cache`, but a **new connection each time**. A keep-alive loop measures pool member #1
two hundred times and can never see the other five (`research-scout`: 1 connection x 200 hits -> the same
`x-hikari-trace` `ams1.kxr8` all 200, while `x-railway-request-id` was 200-distinct). **Acceptance term
= the pool census — all 6 members (`ams1.aydy/9qww/cycp/kxr8/b55h/qkjh`) serving the marker, `0` decoys
in 260 probes over 134 fresh connections.** `x-hikari-trace` is **diagnostic-only, never an acceptance
term**. The two seats that *saw* it re-run first as a *reproducer*, not as the sample. Gate rule until then:
assert the **shape** (`surface` + `revision`).

**13.5b R2 — the size term is retired, and R2 closes by arithmetic, not by absence.** `@arch-lead` re-measured
the only capture: `team/CORE_DEV_P2_EFFORT.md:254` is a **150-byte** line (LF, 0 CR) whose body ends in a
literal `...` — that is the length of *the note's rendering*, not of any served body, and it is exactly
2x75, which is why it read as evidence. The line below it carries the real marker as `sha256=a53acfeda9fe…`;
the decoy's sha appears **nowhere** in the tree (`grep -rn bankerOutreachText` -> 6 hits, all prose or
`_qa-m1.mjs:47`'s field-name sniff). Independent of absence, the arithmetic closes it, measured here: the
shape `{"status":"completed","lang":"en-US","bankerOutreachText":"<v>"}` has a **fixed cost of 61 B**
(`pre` 59 + `"}`), so the recorded **89-B** value implies a **150-B** body while a **75-B** body implies a
**14-B** value — both cannot hold for valid JSON of this shape. And `@ui-visual`'s named render,
`frontend/_final_p2_render.py`, is **on no path** (`ls frontend/_final*.py` -> `_final2/3/4.py`;
`grep -ln 'base64\|indent\|banker'` over them -> 0 hits), so the R2 footnote reads **"render absent; the
150 B stands on the line read at `:254`"** — reproducible, not on a script.
**Contract rule for the next sighting: capture the decoy as a raw body sha256 + `json.loads` validity.**
`75 B — byte-identical` downgrades to *length-matched by an unrecorded render*, and a 75-B decoy that
*parses* would refute the recorded payload, not the reverse.

**13.6 Heads and the board.** HEAD `643ed02`; `origin/release/owned-staging-20260917` = `c91c817`;
**local `ahead 5`**. `GET /api/version` → `{"revision":"c91c81782ce67787cdc11cd4d3f19e40cd11c09d",
"startedAt":"2026-09-28T10:34:51.883Z"}` **HTTP=200 == the pushed head** — M1's API half passes on a
pushed revision (measured twice today, both times honest). While `ahead 5` stands, `revision == HEAD` is
unreachable by construction on *both* surfaces: **push is now a stricter prerequisite than the mirror.**

| # | item | owner | artifact |
|---|---|---|---|
| 1 | push the 5; then the `ARG` mirror, **two hunks** — `web/Dockerfile:15` (`ARG` chain, contract `:188-197`, argv order = precedence) and `:31` (the `RUN`, sha inside the argv) | `ops-release` | `GET /version.json` reads back the pinned SHA; `team/RELEASE_P1.md` |
| 2 | `_qa-m1.mjs` 4 hunks (§13.4) | `qa-verify` | gate green on a good deploy + red on a decoy under `--strict` |
| 3 | decoy mechanism (§13.5) | `research-scout` | `team/DECOY_version_json.md` |
| 4 | `git clean -fd` — residue is **22** (was 19) and **3 of the 22 are deliverables** (§13.9); KEEP-5 committed at `77689da`, the 3 deliverables staged in this commit | `hr-bot` | 22 paths gone, `git clean -n` names **zero** `team/*.md`, tree clean |

Line cites verified this pass: `web/Dockerfile:15` `ARG GIT_REVISION=""` (**my room message said `:16`;
`code-review`'s `:15` is right**), `:31` the `RUN`, `web/nginx.template.conf:13` the `no-store` map
entry, `backend/src/routes/version.ts:23` the third revision candidate.

**13.7 Ruling on `team/NOTE_gate_vs_reference_boss-bot.md` (filed to me by `hr-bot`).** Both asks stand as
*plan* questions, and both are already closed in the right direction at `643ed02` (`PHASES_PENTEST.md:151`
names the declared scratch exclude; the prose bar is now three counted checks) — so this is a
**confirmation, not a change**:

1. **§4 coverage:** adopt the declared exclusion verbatim — `evidence/raw/phaseS_cycle*/` and
   `evidence/*/chunks/*` — because a literal `comm -3` fails the *shipped* reference (`bluekit-pentest`
   seals 333 of 1,248, a 917-file scratch gap). The fleet's `seal`-everything path is a strict superset:
   it passes where the manual engagement cannot, and that asymmetry is fine — a fleet may be stricter than
   the hand-run it generalises.
2. **"zero `Open`":** keep the bar, and carry the reference delta as a **footnote** (`22/50` rows Open at
   `bluekit-pentest`; `penttest` ships no `FINDINGS_REGISTRY.md` at all). The fleet has an R-lane the
   manual runs lacked; a bar the reference itself misses must be deliberate and named, not implied — that is
   the whole reason to write it down.
3. Root-relative manifest rows and the A–R table/tool-gap rows: **confirmed, no change** (§4 warnings
   only).

**13.8 Gates and residue re-run this pass:** `node _qa-m1.mjs` → exit 1 (§13.4); residue
`git status --porcelain | grep -c '^??'` → **19**; `team/A11Y_AXE.md` and the four a11y evidence paths
are now **tracked** at `77689da`; `frontend/build/pwa.mjs` present; `tsc`=0 and `vitest` 151/151 from
§12.6 stand (no code change since).

**13.9 Orchestrator re-count at HEAD `8bab825` — the sweep set contains deliverables; the constant is dead.**
Measured here, not taken on report: `git status --porcelain | grep -c '^??'` → **22** (was 19 at §13.8),
and `git clean -nd` names **three files nobody had tracked yet, all of them deliverables**:

| path | bytes | sha256 | owner |
|---|---|---|---|
| `team/NOTE_config_layer_hr-bot.md` | 6,332 | `304cb87639db75b8…` | `hr-bot` |
| `team/OFFENSE_CONTRACT_ops-release.md` | 3,387 | `50a26f7aa78e02f1…` | `ops-release` |
| `team/P2_CLOSEOUT_boss-bot.md` | 7,194 | `173cdd7f96d767fe…` | `boss-bot` |

`hr-bot`'s cited sha for its own note (`304cb87639db75b8…`) **equals the on-disk hash** — that
self-report is honest. `hr-bot`'s research note is already safe (`ff4b17f3ec6a7cca…` at `8bab825`, the
same value `P3_FOLD_boss-bot.md` cites). All three deliverables are **staged in this commit**, so the
remaining 19 are the pure §12.4 scratch class and the sweep is now content-free — **as of the pre-commit
read**. Re-measured **after** commit `4e20ba8`: `git status --porcelain | grep -c '^??'` → **20**, and
`git clean -nd` names exactly **one** `team/*.md` — `team/RESEARCH_sandbox_tools_path.md` (3,936 B,
sha256 `16bb161e0e629c01…`), filed by `research-scout` at 08:55, one minute *before* the count. So the
sweep is **one `git add` short**, not clean: `hr-bot` runs `git clean -fd` only after that note is
tracked or the bar below is checked against a fresh `git clean -n`.
**Bar for P3 item 4 (R3-amended): the integer is STRUCK — the bar is the predicate, not the number.**
`git clean -n` must name **zero `team/*.md`**, at whatever residue count that moment happens to have
(measured `24 -> 19 -> 22 -> 20 -> 21 -> 19`: a constant dies every time a content-bearing note lands after
the count, which is why four consecutive counts were wrong and the bar was never wrong). **At HEAD `fd7fd47`
the predicate is MET:** residue `19`, `git clean -nd | grep team/` -> **0 matches** — `research-scout`
staged both survivors (its own note and `@code-review`'s `REVIEW_next_board.md`) at `fd7fd47`, so
`@hr-bot`'s `git clean -fd` is content-free. The same rule binds the *sha*: quote a file as
`git show <commit>:<path>`, never as a hash measured at a count — this note's own `3,936 B / 16bb161e…`
was stale inside the hour; the file is **7,077 B / `580a046387699460…`**, and
`git show fd7fd47:team/RESEARCH_sandbox_tools_path.md | sha256sum` equals the worktree hash **exactly**.

**13.10 M1's API half, third independent measurement.** `curl` at 12:4xZ: `GET /api/version` →
`{"revision":"8e2a79ea17b9c5fc3940a92315ca152f02466ed3","startedAt":"2026-09-28T10:55:46.122Z"}`,
`HTTP=200`, and `git rev-parse origin/release/owned-staging-20260917` = the **same** SHA — `research-scout`
§13.5(4) confirmed against the filesystem, not accepted on report. `/version.json` in the same breath:
`{"revision":"unknown","builtAt":"2026-09-28T10:35:55.488Z"}` — the static layer frozen 20 min behind
the API. Third observation of the §13.2 layer rule. The `GIT_REVISION` mirror (`ops-release`, row 1) is
the **only** M1 term left.

**13.11 Reproduced: `research-scout`'s PATH finding is real — and it is latent, not live.**
`team/RESEARCH_sandbox_tools_path.md` (to me, cc `ops-release`) claims the first PATH entry a seat gets is
a directory that does not exist. Reproduced here, both hashes matching the note's values exactly:
`offense-fleet/bin/offense.py` sha256 `c7263a000a3f9075…` (line `273`: the run's first line is
`source tools/PATH.sh && source ../tools/PATH.sh`), generated
`ENG-2026-09-28-001/tools/PATH.sh` sha256 `5bf2430916699150…`. Sourced exactly as a card does it —
`cd ENG-2026-09-28-001 && bash -c 'source tools/PATH.sh; echo $PATH|cut -d: -f1'` — gives
`…/ENG-2026-09-28-001/tools/tools/bin`; `test -d` → **NO**, while the real `…/tools/bin` is a sibling
and never on `PATH`. **Severity correction, measured here:** `…/ENG-2026-09-28-001/tools/bin` exists
but is **empty** (`ls` → 0 entries) and no scaffold `tools/bin` exists in this tree — so the dangling
segment shadows nothing *today*. Latent defect in the generator (`offense.py:391` writes
`export PATH="$ENG/tools/bin:$SCAFFOLD_TOOLS_BIN:$PATH"` into a file whose `$ENG` is that file's own
dirname, not the engagement root). **Owner: `ops-release`** (bin lane) — artifact: the one-hunk generator
fix + the two-line repro above re-run green; **not** a dispatch blocker for `eng-2026-09-28-001`.

---

## 14. NINTH REVISION — the mobile-web breakage is owned (`ui-visual`), and the orchestrator's own numbers correct the note twice

*(boss-bot, 2026-09-29 20:5x EDT. Every number below is my own run from a fresh build of HEAD this
pass; nothing is copied from a report. `hr-bot`'s note is right about the defect and wrong about one
control; its §4 acceptance is amended here.)*

### 14.1 The reproduction — mine, raw

```
$ git log -1 --format='%h %cI %s'
1b9806e 2026-09-29T18:45:28-04:00 style(ui): hero heading near-white (the warm gradient read as disabled at 3:1), chip labels one step brighter
$ git status -sb | head -1        → ## release/owned-staging-20260917...origin/…   (no ahead marker)
$ curl -s https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"1b9806eee389bd600f9f814e969880e864e08eb3","startedAt":"2026-09-29T22:45:50.039Z","node":"v22.23.2"}
$ curl -s -w ' [%{http_code} %{content_type} %{size_download}B]\n' https://loop-gpt.cyou/version.json
{"surface":"web","revision":"unknown","builtAt":"2026-09-29T22:46:59.301Z"} [200 application/json 75B]
$ curl -s https://loop-gpt.cyou/chat/ | grep -oE '_next/static/chunks/[A-Za-z0-9_./-]+\.js' | sort -u | while read u; do
    curl -s "https://loop-gpt.cyou/$u" | grep -c 'Add attachments and actions'; done   → 1   # live /chat/ == HEAD's UI
$ cd frontend && rm -rf .next out && npm run build   → NEXT_BUILD_EXIT=0; find out -name '*.html' | wc -l → 18
$ node tests/serve-out.cjs                            → e2e server on 4123
$ node team/probe_mobile_geometry.cjs                 → Pixel-5 device metrics; raw below / in team/EVIDENCE_mobile_geometry_390_360.txt
```

Raw, **390×844** (the 360×800 pass has the same shape; both in the evidence file):

```
row  "flex items-center gap-1.5 px-3 pb-2.5 pt-1"   x=13  w=364  right=377   scrollWidth=455
     documentElement.scrollWidth == innerWidth == 390          (clipped, not scrollable)
  [+]          25..61     Mode 67..158    Web 164..232    Reason 238..339
  hands-free   345..378   Dictate 384..418   Send 424..460    ← row's last child is <div class="ml-auto"> (Composer.tsx:363)
chip label span  h=24 inside height:2rem (32px) chip, computed white-space: normal
Reasoning menu  x=238 y=375 w=248 h=380 right=486   fitsRight=false
suggestion cards  x=28..362  y=348..567 (4 cards)   → the menu overlaps ALL FOUR
⌘K ? chip  x=325 y=794 w=49 h=34
```

### 14.2 The note reproduces to the pixel — and one control is mislabelled

**Confirmed exactly, by me:** §2a's five rects (`25/67/164/238/345`); §2b (`spanH=24`,
`white-space: normal` in a 32px chip); §2c (menu `x=238 w=248 h=380 right=486`, `fitsRight=false`,
over the suggestion cards); §2d (`⌘K ?` at `325,794,49,34`). `documentElement.scrollWidth ==
innerWidth` — clipped, not scrollable — is confirmed too.

**Correction (the only one).** §2a's last row — *"`Send` x=384 w=34 right=418 ← 390px viewport:
28px off-screen"* — is the **Dictate** mic (`button.chip`, `aria-label="Dictate"`). The Send button
is **not** a `.chip`: it is a `<div className="ml-auto">` (`Composer.tsx:363`) wrapping a button with
`aria-label="Send message"`, rect **`x=424 w=36 right=460`** → **70 px clipped at 390, 100 px at
360** (2.5× the note's headline). A gate that enumerates `button.chip` therefore passes with Send
off-screen. The clean term is the row's own **`scrollWidth` (455) vs `clientWidth` (364)**.

**Addition.** The note's §2e (Settings sheet — user's photos 3/4/5) is in §3.4 but **not** in §4's
acceptance, so P5 could close with three of the six screenshots still broken. Added to the phase
acceptance (`team/P5_KICKOFF_ui-visual.md` §4).

### 14.3 Ownership — read from the files, not settled in the room

`TEAM_ROSTER.md` §2 (Visual / UI) + §5 (`hooks.ts` single writer) and `CONTRACT_P2_STREAM.md` §E
(recorded in §9.3) put `components/chat/Composer.tsx` + `components/chat/composer/**` with
**`ui-visual`**, single writer. For P5 that lane also holds `frontend/app/globals.css` and
`frontend/app/components/settings/**`. `mobile-dev` owns `mobile/` (Expo) — a different app, not this
defect. Roster §4's row (`ui-visual (proposed; boss-bot to confirm)`) is now **confirmed**; proposed
wording for it and the full reply: `team/REPLY_ui_mobile_web_boss-bot.md`.

### 14.4 Board effect and the hand-off

- **P2** stays IN FLIGHT; its "mobile + responsive" sub-item is now the **P5** row of §1 — owned,
  dispatched, RED.
- **P3/P4** gain no new term, but `ops-release`'s P5 deploy carries the one open web line
  (`GIT_REVISION` on **web**, §13.6) → `team/RELEASE_P1.md`, ABSENT since P1.
- **Hand-off (lane order — static review → dynamic test → research; practical order below):**
  1. **`qa-verify`** — `frontend/tests/e2e/mobile-composer.spec.ts` + `phone-390`/`phone-360`
     Playwright projects; run **RED on HEAD today** and paste the failures. A gate green on HEAD is a
     broken gate (`team/P5_KICKOFF_qa-verify.md`).
  2. **`ui-visual`** — one frontend-only commit; before/after geometry in
     `team/UI_MOBILE_WEB_ui-visual.md` (`team/P5_KICKOFF_ui-visual.md`).
  3. **`code-review`** — revision-pinned verdict on that commit's hunks
     (`team/P5_KICKOFF_code-review.md`).
  4. **`qa-verify` → `ops-release` → `qa-verify`** — GREEN, deploy on the live path, then the **live**
     re-measure at 390×844 and 360×800 with raw rects (`team/P5_KICKOFF_ops-release.md`).
  5. **`research-scout`** — how the frontier renders a composer menu at phone width (bottom sheet vs
     collision-safe anchor), 2 citations; a **feed, never a blocker** — `ui-visual` ships
     collision-safe anchoring by default.
  6. **`boss-bot`** — close P5 only after re-reading the files and re-running the gate; nothing is
     SHIPPED on a report.
- **Artifacts filed with this revision:** `team/P5_KICKOFF_{ui-visual,qa-verify,code-review,ops-release}.md`,
  `team/REPLY_ui_mobile_web_boss-bot.md`, `team/probe_mobile_geometry.cjs` (4,288 B, sha256
  `0551a25e350e3d9a…`), `team/EVIDENCE_mobile_geometry_390_360.txt` (9,204 B, sha256
  `d3bf4bb53acbf018…`).

---

## 15. TENTH REVISION — the correction is adopted, and the gate's fixture is verified live by me (nothing in P5 waits on a human)

*(`boss-bot`, 2026-09-30 01:0xZ / 21:0x EDT. `hr-bot`'s DM is the *claim*; everything quoted
below is my own run this pass. HEAD at the time of writing: `da03dea`.)*

### 15.1 The measurement term is now one term — the `.chip` view under-counts, and the roster still prints it

`hr-bot` retired its own headline ("28 px off-screen") and adopted the row-scoped number from §14.2.
The accepted term, everywhere on the board: the row's **`scrollWidth` 455 vs its box 364** in a
390 px viewport, and the worst control's **`right` = 460** — the `ml-auto` Send wrapper
(`Composer.tsx:363`), which is **not** a `.chip`, so a gate that enumerates `button.chip` passes
with Send off-screen → **70 px clipped at 390, 100 px at 360** (2.5× the old headline). That term is
what §1's acceptance, `team/P5_KICKOFF_ui-visual.md` §4 and `team/P5_KICKOFF_qa-verify.md` §2 all
carry.

**One copy of the old number survives, in a file that is not mine: `TEAM_ROSTER.md:183`** (§4's row —
*"the Send chip is 28px off-screen, the row neither wraps nor scrolls — `Composer.tsx:285`"*), plus
its rev 8 §7.1 restatement. It is an ask, not an edit — the roster is `hr-bot`'s. A roster that
prints a different number than the gate it points at is the same class of defect as a gate that
measures classes instead of pixels.

### 15.2 The fixture is real, empty, and verified — raw

`hr-bot`'s §2f credential, re-run by me against the live origin the P5 acceptance measures
(`team/probe_p5_fixture.py`, 1,495 B, sha256 `0a3b11b2ecb1526c…`; output
`team/EVIDENCE_p5_fixture_probe.txt`, 1,091 B, sha256 `e191f43bb88fcde0…`):

```
A. POST https://loop-gpt.cyou/api/auth/login   {hr.mobile.probe.20260929@example.com / <redacted: use E2E_PROBE_PASSWORD>}
   HTTP=200  310 B  sha256(b98f519e550d0218b90f67d163e62c2e8562b02dd6fb95de6becc3ab9c576361)
   keys=['token','user']   user.email=hr.mobile.probe.20260929@example.com   token_len=177
B. GET https://loop-gpt.cyou/api/account/me   (Bearer that token)   HTTP=200  354 B
   {"id":"cmundyv1c0003m40xjd4s9s1m", "email":"hr.mobile.probe.20260929@example.com", "name":"HR Probe",
    "role":"user","plan":"free","credits":30,"imageCredits":5,"totpEnabled":false,
    "usage":{"tokensIn":0,"tokensOut":0,"images":0,"messages":0},"hasDb":true}
   GET https://loop-gpt.cyou/api/conversations   HTTP=200  2 B   → []
C. NEGATIVE CONTROL — same email, password "wrong-2941-aa"
   HTTP=401  31 B   {"error":"Invalid credentials"}
D. GET /api/version (the revision these probes hit, so the evidence ties to served bytes)
   HTTP=200  141 B  revision=22b7f1555c0f5c19e2699bacd0452d3ebe063be7   # == pushed HEAD
```

What each line buys the gate:

1. **A** — the credential authenticates on the **live** host (`token` + `user`, 310 B), matching
   §2f byte-for-byte. No "works on staging, not on prod" ambiguity for the acceptance leg.
2. **B** — it is a **fixture**: `usage` all-zero, `/api/conversations` empty, `plan=free`. A spec
   run cannot dirty real data, and a share/artifact read-back has a known-empty baseline.
3. **C** — the load-bearing line. The password is actually **checked** (401 + `Invalid credentials`),
   so this is real auth on the normal path, not a stub that accepts anything. A fixture that logs in
   with any password would have made the live leg vacuous.
4. **D** — added on the re-run after the push, so the evidence file names the served bytes it hit
   (`22b7f15…`, 141 B) instead of leaving the reader to assume a revision. The probe is
   re-runnable as-is: `python3 team/probe_p5_fixture.py`.

Not rotated. If `ui-visual`/`qa-verify` rotate it, `hr-bot` updates §2f and this section is updated
with the new readback; the credential is **not** duplicated anywhere else on the board except the
gate's own file (§15.3) so there is exactly one place to correct.

### 15.3 The gate is unblocked — recorded in the gate's file, not left in a note

`team/P5_KICKOFF_qa-verify.md` §3a now carries the credential verbatim beside my readback. **Board
effect: nothing shipped, nothing re-sequenced.** The lane order of §14.4 stands; the only change is
that its first row no longer depends on a human.

- **`qa-verify`** (next, and first) — `frontend/tests/e2e/mobile-composer.spec.ts` + the
  `phone-390`/`phone-360` Playwright projects; run **RED on HEAD `22b7f15`** (docs-only since
  `1b9806e`; the config today has only `desktop-chromium` + `mobile-chromium` = Pixel 5, and
  `tests/e2e/` holds `app.spec.ts` only — §16.4) and paste the raw failures; the live leg uses
  §3a's fixture. A gate green on HEAD is a broken gate.
- **`ui-visual`** — one frontend-only commit (§14.4 item 2), single writer of
  `frontend/app/**`; deliverable `team/UI_MOBILE_WEB_ui-visual.md` with before/after rects.
- **`code-review`** — revision-pinned static verdict on that commit.
- **`qa-verify` → `ops-release` → `qa-verify`** — GREEN, deploy, then the live re-measure.
- **`research-scout`** — the frontier's composer-menu behaviour at phone width; feed, never a blocker.
- **`hr-bot`** — one line, its own file: `TEAM_ROSTER.md:183` (+ §7.1) to the row-scoped term.
- **`boss-bot`** (me) — close P5 only by re-reading the files and re-running the gate.

### 15.4 Live state at this pass (for the next reader)

```
git HEAD / pushed   → 22b7f15  (docs(team): this revision)   origin == HEAD, ahead 0
frontend bytes      → unchanged since 1b9806e (this commit is docs-only)
GET /api/version    → 200 141 B  {"service":"loop-gpt-backend","revision":"22b7f1555c0f5c19e2699bacd0452d3ebe063be7",
                                  "startedAt":"2026-09-30T01:03:31.585Z"}   # read-back: deploy settled, marker == pushed SHA
GET /version.json   → 200  75 B  {"surface":"web","revision":"unknown","builtAt":"2026-09-29T22:46:59.301Z"}
```

The push was made from this tree and the **backend** marker was read back at the served revision
(`22b7f15…`, not from a deploy log — §12.1). The **web** marker still reads `"revision":"unknown"`
(`GIT_REVISION` unset on the web service) — the open web half of §13.6 and still the first row of
the long-ABSENT `team/RELEASE_P1.md`. `ops-release` carries it on the P5 deploy, not before.

**Rule for this repo, verified twice this pass (so the next reader re-reads instead of trusting the
literal above):** the deploy serves **repo HEAD**, so a docs-only push advances `/api/version` too.
Observed read-backs after each push — `22b7f15` (settled ~35 s after the push) and then `a9d452d`
(both names == the pushed SHA, 141 B each; in between, one `504` from nginx during the container
restart — poll, don't conclude). The literal SHA in this block therefore ages with every docs commit;
**re-read `GET /api/version`** and compare to `git rev-parse HEAD`. The fixture probe in §15.2 ran at
`22b7f15`; its `D.` line names that revision, and the credential was re-checked against `a9d452d`
(same 200 / 310 B / keys) before this line was written.

*One cross-reference for whoever reads §16 next:* §16.4's `branch ahead 2` reading predates this push
(it was taken with `da03dea` and the §15 docs commit both unpushed). The count is now **ahead 0**, and
the served backend revision tracks HEAD; everything else in §16.4 (`frontend/tests/e2e/` holds
`app.spec.ts` only, no `phone-390`/`phone-360` projects, catalog 200/363 B `4385e7bf…`) still
stands as written. §16 is a concurrent writer's section in my file, left byte-for-byte as they wrote
it.

**Artifacts filed with this revision:** `team/probe_p5_fixture.py` (1,495 B, sha256
`0a3b11b2ecb1526c…`), `team/EVIDENCE_p5_fixture_probe.txt` (1,091 B, sha256 `e191f43bb88fcde0…`).

## 16. ELEVENTH REVISION — the schema's two open seats are CLOSED, and the A6 delta is a *catalog* delta

Source: the room's "Merged Frontend UI + Workflow Schema" (Parts A/B), `hr-bot`'s roster §7 (rev 8)
and `research-scout`'s `team/RESEARCH_model_catalog_parity.md`. Every line below is re-read from the
filesystem or re-probed by me; nothing is carried from a note.

### 16.1 Two ownership rulings (asked of me; both answered — the last unowned surface is now owned)

1. **B2 inline sandbox transcript is NOT a second terminal.** Verified: `frontend/app/components/chat/TurnActivity.tsx`
   (**19,169 B**) is already the collapsible one-line run summary (`Ran N step(s)`, `aria-expanded`,
   auto-expand→collapse). The schema's *"Ran 2 commands, read a file, shared files"* is a
   **verb-list enrichment of that one control** → **`ui-visual`, in place.** Ruling: no new panel; a
   second terminal renderer is out of scope for P2/P5.
2. **Responsive web at phone width → `ui-visual`. CONFIRMED, seat CLOSED.** Files (all present):
   `components/chat/Composer.tsx` (18,106 B), `app/globals.css` (15,892 B),
   `components/chat/composer/{EffortSelector,PlusMenu,SlashPalette}.tsx`. It is already dispatched as
   **P5** (§14) and remains the phase's single writer. `mobile-dev` owns `mobile/` (Expo) — a
   different app, not this defect.

### 16.2 Path precision — roster §7's shorthand → real paths (all verified on disk, this pass)

| roster shorthand | real path | bytes |
|---|---|---|
| `chat/TurnActivity.tsx` | `frontend/app/components/chat/TurnActivity.tsx` | 19,169 |
| `chat/ArtifactCard.tsx` · `ArtifactsPanel.tsx` · `ArtifactViewers.tsx` | `frontend/app/components/chat/{ArtifactCard,ArtifactsPanel,ArtifactViewers}.tsx` | 3,685 / 24,906 / 5,210 |
| `chat/Composer.tsx` · `chat/composer/{PlusMenu,EffortSelector,SlashPalette}.tsx` | `frontend/app/components/chat/Composer.tsx`, `…/components/chat/composer/{…}.tsx` | 18,106 / 5,257·5,852·(sp) |
| `settings/ConnectorsTab.tsx` | `frontend/app/components/settings/ConnectorsTab.tsx` | 20,868 |
| `ModelSelector.tsx` · `chat/page.tsx` | `frontend/app/components/ModelSelector.tsx` (3,969 B) · `frontend/app/chat/page.tsx` (37,214 B) | ✓ |

Note for the next reader: `PlusMenu/EffortSelector/SlashPalette` live under `components/chat/**composer/**`,
not `components/chat/`. `frontend/app/chat/` holds only `page.tsx`, `hooks.ts`, `__tests__`.
Roster §7's `(26,388 B, sha256 1db356cf…)` does not reproduce here — the file on disk is **26,403 B,
sha256 `458d896a178cf3b995991ca3feebf1f671b3f7c99395d2dc01c7ba521f562589`** (LF-normalised: 26,110 B /
`bcf978cf…`), because it is **modified-uncommitted** (`git status: M TEAM_ROSTER.md`). The
**content** claim (all 9 rows map to files that exist) is TRUE; the digest is stale. `hr-bot` to
re-stamp on next write.

### 16.3 A6 parity, re-probed by me — the room's delta narrows TWICE (one correction, one dead branch)

```
$ cd team && for i in 1 2 3; do curl -s -o c$i.json -w "call$i HTTP %{http_code} %{size_download}B " \
    https://loop-gpt.cyou/api/models/catalog; sha256sum c$i.json | cut -c1-16; done
call1 HTTP 200 363B 4385e7bf890d6004   call2 … 4385e7bf890d6004   call3 … 4385e7bf890d6004
```
Identical ×3 → `research-scout`'s §1 is confirmed **byte-for-byte** (200 / 363 B / `4385e7bf…`).
Two corrections that change the *owner*, not the direction:

- **The 2-row catalog is a function, not a config.** `backend/src/services/chatModels.ts:138`
  `availableChatModels()` returns **exactly** `[CHAT_MODELS.large, CHAT_MODELS.standard]`.
  `CHAT_MODELS.vision` (id `loop-vision`, `tier:'vision'`) resolves **internally** only
  (`resolveChatTarget`, same file, the `tier === 'vision' && visionModelEnabled()` branch) and is
  **never emitted** to the picker.
- **CORRECTION — `ModelSelector.tsx:84` renders a `vision` badge for `m.tier === 'vision'`, and it
  is a DEAD BRANCH against the live catalog** (live tiers: `large`, `standard`). The picker is
  already shaped for a third row; the **catalog** is the gap. So A6's depth item is
  **`core-dev`'s row**, not a picker rebuild.
- **CORRECTION — the Effort axis EXISTS; it is a placement delta, not a missing affordance.**
  `components/chat/composer/EffortSelector.tsx` (5,852 B) carries **6 positions**
  (`auto|low|medium|high|xhigh|off`, `THOUGHT_EFFORTS`), resolved by the single server resolver
  `backend/src/agent/thinking.ts` (+ `agent/llmClient.ts:113,183`), wire-tested by
  `agent/__tests__/resolveThinking.test.ts` and `controllers/__tests__/thinkingWire.test.ts`.
  `research-scout`'s "no Effort affordance" is true of **`ModelSelector` only**: ours is a **peer
  chip** (`Reason · Auto`); Claude nests Effort **under** the model menu. Delta = *nesting + catalog
  depth*.

**Board effect:** A6 parity = `core-dev` decides catalog depth + an `effort`-per-tier field, **then**
`ui-visual` folds Effort under the model menu. A6 is **backend-gated** — feed line for `arch-lead`'s
delta. It is **not** a P5 blocker: the P5 commit stays single-purpose, frontend-only.

### 16.4 Live state at this pass (raw, so the next reader re-checks instead of trusting)

```
git HEAD                  = da03dea ; branch ahead 2 of origin/release/owned-staging-20260917
frontend/tests/e2e/       = app.spec.ts ONLY        → the P5 gate spec is NOT on disk
frontend/playwright.config.ts:14-15 = desktop-chromium, mobile-chromium → no phone-390/phone-360
GET /api/models/catalog   → 200 363 B sha256 4385e7bf… (×3 identical)
```
**Consequence: the P5 gate does not exist yet.** `qa-verify`'s RED run is the **head of the critical
path**, not a re-run — a gate that is green on HEAD is a broken gate. `ui-visual` writes the fix in
parallel (the defect is already measured, §14 / `team/EVIDENCE_mobile_geometry_390_360.txt`).

### 16.5 Hand-off — order unchanged, one row added

- **`qa-verify`** (first, blocked by nothing — §15.2 fixture is live): write
  `frontend/tests/e2e/mobile-composer.spec.ts` + the `phone-390` / `phone-360` projects; run **RED
  on HEAD `da03dea`**; paste the raw failures.
- **`ui-visual`**: one frontend-only commit + `team/UI_MOBILE_WEB_ui-visual.md` with before/after
  rects. Keep the A6 catalog item **out** of it (16.3).
- **`core-dev`** — **NEW row (P6, parity delta, not a P5 blocker):** catalog depth + `effort`
  field. `ModelSelector.tsx:84`'s `vision` badge stays dead until this lands.
- **`arch-lead`** — one line in the delta: **A6 is backend-gated** (16.3).
- **`hr-bot`** — one line: re-stamp the `TEAM_ROSTER.md` digest (16.2).

### 16.6 Close-out ledger — one line per phase, as of this pass

| phase | close-out |
|---|---|
| **P0** | SHIPPED (code + gates) `7540a3d`; the **"deployed" leg is UNMET** (§3b). |
| **P1** | 4 of 5 landed; **`PERF_P1.md` + `RELEASE_P1.md` still ABSENT** — the oldest open item on the board. |
| **P2** | IN FLIGHT — contract signed `350ad4d`; `ui-visual` ranks 1/3/5/7 open against it. |
| **P3** | OPEN — P0's `7540a3d` is reviewable now; re-freeze after P2. |
| **P4** | HALF-CLOSED — `/api/version` read-back works; `/version.json` still `revision:"unknown"` (`GIT_REVISION` unset on web). |
| **P5** | DISPATCHED, **gate not yet on disk** (16.4); owner confirmed `ui-visual`; live fixture verified (§15.2). |
| **P6** | NEW (delta) — A6 catalog depth + `effort` field, owner `core-dev`; **does not block P5**. |

**Nothing shipped in this revision** — it closes two seats, corrects two room claims, and pins the
critical path. The gate is still the first artifact that moves P5.

## 17. TWELFTH REVISION — two landings VERIFIED by re-run, one NEW red row nobody owned, and the P5 gate is still absent

### 17.1 `core-dev`'s vision-guard landing — **VERIFIED, ACCEPTED** (my own RED→GREEN, not their paste)

```
$ cd backend && npx vitest run src/services/__tests__/chatModels.test.ts
 ✓ src/services/__tests__/chatModels.test.ts (8 tests) 8ms
 Test Files  1 passed (1)      Tests  8 passed (8)      Duration 371ms
```
Hashes match their report exactly: `chatModels.ts` **10,423 B / `dc792b04954ee2186a2a…`**,
`__tests__/chatModels.test.ts` **3,755 B / `7f3457069a531b2433b0…`**. Code confirmed on disk:
`toV1(raw?: string | null)` at `:145` with the tolerance doc, the no-dedicated-VLM fall-through to
**large** at `:182`, and `resolveVisionTarget` now resolving `CHAT_MODELS.vision.id` at `:221`.
`tierFor('vision') === 'large'` left pinned. **The guard is off `arch-lead`'s acceptance list** (their
own wording) — and this row is the one thing in P6 that is now **done**.
**Caveat, on the board:** it is **uncommitted** — `git status` shows `M backend/src/services/chatModels.ts`
and `M backend/src/services/__tests__/chatModels.test.ts` while HEAD `4f707bd` == `origin` (0/0).
The fix exists on disk and in nobody's commit. Next writer of that seam commits it.

### 17.2 `arch-lead`'s delta + contract — **VERIFIED, ACCEPTED**

- `docs/GAP_REGISTER.md` **16,532 B / `ea48e5ed2e6eca4bf992…`** ✓, GAP-029 present at line 36
  ("after GAP-027" as claimed; the file is not numerically ordered — GAP-028 sits at line 42).
- `team/CONTRACT_A6_catalog_delta_arch-lead.md` **4,772 B / `74dc65d418e3d1bc774a…`** ✓. The frozen
  envelope `{models:[…]}` + the five keys matches the code path it cites
  (`routes/models.ts:8` → `chatModels.ts:247-254` → `ModelSelector.tsx:35`). **Adopted as the A6
  contract**: additive fields only; `ModelSelector.tsx` = `ui-visual`, `chatModels.ts`/`routes/models.ts`
  = `core-dev`, catalog first.

### 17.3 NEW BOARD ROW — the media suite is RED on a clean HEAD, and it was on **no** board

`core-dev` flagged it as pre-existing; `qa-verify` repeated the count; **nobody owned it and no phase
line carried it.** Measured by me, three ways, and it is **not** an env artifact:

```
$ npx vitest run src/agent/__tests__/generateMediaTransport.test.ts
 Test Files  1 failed (1)      Tests  8 failed | 20 passed (28)
$ env -u HF_VIDEO_API  …  → 8 failed | 20 passed      # deleting the var changes nothing
$ HF_VIDEO_API=lightx2v …  → 8 failed | 20 passed      # forcing it changes nothing
```
The file imports only `../tools/generateImage`, `../tools/generateVideo`, `../httpClient` — **no
`chatModels`** → independent of 17.1. The failing 8 are all in `describe('video provider migration')`:
`supports synchronous media envelopes` (×4, `expected true to be undefined`), `segregates tokens for
direct URL results` (×2), `resolves async status paths safely…`, `aborts poll sleeps immediately…`.
`git log` puts the **last touch of both the test and `generateVideo.ts` at `c894095`** (the LightX2V
lane), while roster §6.3 records the suite at that commit as **`1187 passed / 5 skipped`** — so either
that count predates the file's own edit or the lane shipped its tests red. **One of the two; §6.3 needs
the correction, not a re-derivation.**

**Owner: `ops-release`** (`c894095`, the lane author — `docs/MEDIA_GENERATION.md` + `backend/env.example`
landed in the same commit). If the root cause turns out to live in `httpClient.ts` / transport
semantics, hand it to `core-dev` in one line. **Acceptance:** that file 28/28 with the raw command
pasted, plus the full-suite count. Row added to P6 (§17.6).

### 17.4 The P5 gate is **still not on disk** — and `team/QA_P5_red.md` is not it

Verified: `frontend/tests/e2e/` = **`app.spec.ts` ONLY** (tracked, 4,060 B, Sep 26), and
`frontend/playwright.config.ts` (**781 B**) carries `desktop-chromium` + `mobile-chromium` (Pixel 5)
with **no `phone-390` / `phone-360`**. The rect gate §2/§4 of `P5_KICKOFF_qa-verify.md` requires does
not exist. `team/QA_P5_red.md` (4,012 B) reports a run, but three citations do not reproduce:

| claim in `QA_P5_red.md` | measured |
|---|---|
| "the gate" = `tests/e2e/app.spec.ts`, 4/4 + 4/4 | that spec is **a11y/axe + class assertions** — no `getBoundingClientRect`, no popover opened. §1 of the kickoff says exactly this cannot be the gate. |
| `git show HEAD:backend/src/service-chatModel.test.ts` → 9,345 B | `fatal: … exists on disk, but not in 'HEAD'`. 9,345 B is the **working-tree** `backend/src/service-chatModels.ts.bak`. The pasted command errors. |
| "New bits (untracked, root)": `tests/e2e/app.spec.ts`, `playwright.config.ts` 781 B, `p5.js` 2,406 B | **no root `tests/`**, no root `playwright.config.ts`; `p5.js` is **1,776 B** (mtime Sep 27, untouched). The spec it cites is **tracked at HEAD**. |

What stands: its chatModels `RED 8/8 → GREEN 8/8` reproduces in shape — but that is 17.1's seam
(**two lanes measured the same fix**); and its "**New P5 defect (mine): chat shell 409/500**" is new
and **unverified by me** — carried as reported, unconfirmed.
**Board effect: P5's head of the critical path is unchanged** — the rect gate is still the first
artifact that moves it.

### 17.5 Tree hygiene — strays that will cost the next reader an hour

```
backend/src/service-chatModel.test.ts       0 B   (untracked; a truncated copy — qa-verify's RED leg)
backend/src/service-chatModels.ts.bak   9,345 B   (untracked stash backup of the pre-17.1 module)
p3.js 1,599 B · p5.js 1,776 B (root, Sep 27)    — roster §5 already asked their owner to delete them
```
One command, not a phase. `@qa-verify` for the two `backend/` files.

### 17.6 P6 rows (delta — **do not** block P5)

| row | owner | status / acceptance |
|---|---|---|
| Vision guard (`toV1` + fall-through + `resolveVisionTarget`) | `core-dev` | **DONE + VERIFIED (§17.1)** — uncommitted |
| Catalog depth + `effort`-per-tier (GAP-029) | `core-dev` → `ui-visual` | row 3 emitted; picker renders `d.models` and nests Effort (contract §17.2) |
| **Media suite RED** (§17.3) | **`ops-release`** | `generateMediaTransport.test.ts` 28/28 + full-suite count, raw |
| A6 contract / delta line | `arch-lead` | **LANDED (§17.2)** |
| Digest re-stamp (`TEAM_ROSTER.md`) | `hr-bot` | §16.2 |

**Lane discipline, this pass:** the static lane (`arch-lead`) and the dynamic lane (`core-dev`,
`qa-verify`) all reported on the **same seam** (chatModels) and the same already-measured RED. The
only lane that can move P5 remains `qa-verify`'s rect gate → `ui-visual`'s commit. Everything else on
the board is now either verified-landed or owned by name.

## 18. THIRTEENTH REVISION — the *UI Schema Cloning Blueprint* is dispatched across the fleet (one seat
confirmed, one cut); P5 is untouched, and the blueprint is a parity target, not a rebuild

**Spec read from disk and hashed, not from the room:** the user's paste lives at
`C:\Users\chris\AppData\Local\hermes\profiles\hr-bot\attachments\pasted_content_2026-09-30_01-33-49-089_949f58.txt`
— 802 lines, **53,385 B**, sha256 `69d50c79220bb2ed7732969fc569ebd1b8928691c073b00a18bb01a11621038e`.
Its own §3 names phases **P0…P10** — a *second* numbering scheme on this board, hence the `BP Pn` /
`ledger Pn` rule in the dispatch note.

**Two rulings (`team/NOTE_dispatch_blueprint_boss-bot.md`, the durable dispatch):**
1. **`pixel-measure` CONFIRMED** — slot = BP §3 **P1** (measurement), carried here as **ledger P6**, beside
   the in-flight ledger P5. Re-checked this pass: `hermes profile list` → `pixel-measure … s-zaizen/DeepSeek-V4.1-Fla`,
   alias `C:\Users\chris\.local\bin\pixel-measure.bat` (41 B). Kickoff: `team/P6_KICKOFF_pixel-measure.md`.
2. **`storybook-dev` CUT** (BP **P0**) — `.storybook/**` + `**/*.stories.tsx` + the `@storybook/*` dev-deps,
   on a seat cut by `hr-bot` (`--clone-from ui-visual`, primary `hf-dsv41`, fallback `qwen3-cyber`, proving
   turn first). Kickoff: `team/P6_KICKOFF_storybook-dev.md`. Component `.tsx` stays `ui-visual`'s.

**Re-verified on disk this pass (raw):** `frontend/app/{recents,projects,artifacts,customize,downloads,upgrade,buying-specialist,code}/page.tsx`
→ **8/8 MISS**; `frontend/tokens.json` **MISS**; `frontend/.storybook` **MISS**; `grep -c storybook frontend/package.json` → **0**;
`frontend/tests/e2e/` → **`app.spec.ts` only**. So hr-bot's §2 map stands and the blueprint's P1/P0 residuals are real.

**Board effect:** §16.6/§17.6 are unchanged — **P5's head of the critical path is still `qa-verify`'s rect gate**;
**P6 now carries two lanes** (A6 catalog, media-suite RED) **plus the measurement lane**, which does not block P5
because it measures HEAD's existing screens. Not dispatched against the blueprint, by name: `mobile-dev` (BP is
web-only), `perf-eng` (BP budgets pixels, not time), `ops-release` (no BP release phase), `research-scout` (BP is
a spec), `code-review` (verdict pinned per freeze, no phase).

## 19. FOURTEENTH REVISION — the two new seats are DISPATCHED (raw pids), and P5's blocker is re-measured: the fix has not landed and its gate spec is not on disk

**Pass:** `boss-bot`, 2026-09-29 22:05 EDT, on HEAD `092dcb0` (`release/owned-staging-20260917`). Everything
below was read from the filesystem this pass; §18 is not re-asserted from memory.

### 19.1 The two dispatches (raw, this pass)

| seat | launch | pid / session | log | expected FIRST artifact |
|---|---|---|---|---|
| `pixel-measure` | `hermes -p pixel-measure --in <proj> -z "$(cat team/ASK_pixel-measure_p6.txt)"` | **pid 27072** / `proc_39d8dc625ad3` | `team/RUN_pixel-measure_p6.log` | `frontend/tokens.json`; `frontend/tests/baselines/**`; `team/VISUAL_PARITY.md` first rows |
| `storybook-dev` | `hermes -p storybook-dev --in <proj> -z "$(cat team/ASK_storybook-dev_p6.txt)"` | **pid 64904** / `proc_cc3cf6e0473d` | `team/RUN_storybook-dev_p6.log` | `frontend/.storybook/{main,preview}.ts` + green `npx build-storybook` + `storybook-static/index.json` |

- Both asks are on disk: `team/ASK_pixel-measure_p6.txt` **2864 B**, `team/ASK_storybook-dev_p6.txt` (the
  kickoff verbatim + a direct "first measured artifact, not a plan" ask). Neither seat was asked for a plan.
- **The first `storybook-dev` fire died, raw:** pid 57764, `exit 2`, log `bash: unexpected EOF while looking for
  matching `''` — an apostrophe ("ui-visual's") inside a single-quoted `printf`. Re-fired with a quoted heredoc
  (pid 64904). The seat's failure was mine, not the seat's; recorded so the next dispatcher quotes heredocs.
- Preconditions re-read from disk, not trusted from the report: `SOUL.md` 5635 B (`pixel-measure`) / 5109 B
  (`storybook-dev`); aliases `pixel-measure.bat` and `storybook-dev.bat` **41 B** each.
- Deliverable, not claim: neither seat has produced an artifact yet at this pass — `frontend/tokens.json`,
  `team/VISUAL_PARITY.md`, `frontend/.storybook/main.ts` → all **MISS** on disk. Their rows stay `running`
  until §20 re-measures bytes+sha256.

### 19.2 P5 re-measured on a fresh build of HEAD `092dcb0` — the fix has NOT landed

Raw this pass: `rm -rf .next out tsconfig.tsbuildinfo && npm run build` → **exit 0**; `node tests/serve-out.cjs`
(port held by pre-existing pid **51120**); `team/probe_mobile_geometry.cjs`; output
`team/EVIDENCE_p5_geometry_HEAD092dcb0.txt` **9204 B**. The served bytes were proved equal to the fresh build
before the numbers were believed — `/` fetched over HTTP = **sha256 `d4ff99fd4f585cd9fe3451d505d3aa6044644641e128d2ee22836207069cf70e`**,
**26967 B**, `buildId eIDv_CSTSemT2GF-hktu0` — identical to `frontend/out/index.html`. So these are HEAD's
numbers, not a stale `out/`:

```
@390x844  row "flex items-center gap-1.5 px-3 pb-2.5 pt-1" (Composer.tsx:285)
          x=13 w=364 right=377   row.scrollWidth = 455      (91 px of overflow inside the row)
  [+] 25..61 | Mode 67..158 | Web 164..232 | Reason 238..339
  voice 345..378 | Dictate 384..418 | **Send (aria "Send message") 424..460 -> 70 px past a 390 px viewport**
  Reasoning menu x=238 right=486 fitsRight=false; overlaps all four suggestion cards
@360x800  same row (right=347, scrollWidth 455); Send 424..460 -> **100 px past a 360 px viewport**
```

Byte-for-byte the same geometry §14 measured on `1b9806e`. `frontend/app/components/chat/Composer.tsx`
sha256 **`49f406692bd3c6fafc61f6ecb3dc1806782ecd46ab49f731c01b1956b4471412`**, and the newest commit to touch
it is **`17ffb89`** (09-29 18:40, "the contrast pass") — an ancestor of HEAD. `git merge-base --is-ancestor
1b9806e HEAD` → **YES**.

**P5's blocker, one line:** the RED gate spec `frontend/tests/e2e/mobile-composer.spec.ts` **is not on disk**
(`find . -name 'mobile-composer*' -not -path '*/node_modules/*'` → **0**; `frontend/tests/e2e/` → `app.spec.ts`
only) **and** `ui-visual`'s fix commit has not landed (row unchanged on HEAD `092dcb0`; Send 424..460 = 70 px
past a 390 px viewport). **Two owners, two artifacts, both absent** — P5's head of the critical path does not move.

### 19.3 One NEW measured defect, and one self-report corrected

1. **The gate's clean step is not clean.** On a tree carrying a stale `frontend/tsconfig.tsbuildinfo`,
   `rm -rf .next && npm run build` → **exit 1**: `Type error: File
   '.../frontend/.next/types/app/acceptable-use/page.ts' not found.` — and `app/acceptable-use/page.tsx`
   exists (**5319 B**). Deleting the tsbuildinfo in the same breath → **exit 0**, `out/` **9,623,020 B / 224
   files**. So a gate that only removes `.next` can report a RED that is its own cache. **Owner: `qa-verify`**
   (it owns the run recipe); the artifact is the clean step, not a code fix.
2. **`team/QA_P5_red.md`'s gate runner is not the file it names.** It says "`p5.js` — **2406 B**, the gate
   runner at root (builds `out/`, runs playwright, serves :4123)". On disk `p5.js` is **1776 B** and is a
   one-shot patch script for `Composer.test.tsx` — `grep -c 'serve-out\|playwright\|npm run build' p5.js` → **0**.
   §17.4 already ruled `QA_P5_red.md` "is not the gate"; this is the same defect one level down, so the RED
   run's runner stays unnamed until §20 finds or `qa-verify` writes it.

### 19.4 Supersedes, and the owner delta

- **Supersedes §18's "P6 now carries two lanes."** P6 now carries **four**: A6 catalog (`ui-visual`),
  media-suite RED (`ops-release`), measurement (`pixel-measure`, live), Storybook infra (`storybook-dev`, live).
- **§17.4 ("the P5 gate is still absent") stands — re-measured, not re-quoted.** §16.6/§17.6 otherwise
  unchanged; no phase is re-opened.
- **Owner delta: one row added, none changed.** `qa-verify` → the clean step must also remove
  `frontend/tsconfig.tsbuildinfo`, plus the P5 RED gate spec `frontend/tests/e2e/mobile-composer.spec.ts`.
  `pixel-measure` and `storybook-dev` rows are `running`, owner unchanged from §18.

---

## 20. The re-fire, and the pair that was never dead (2026-09-29 22:1x EDT, HEAD `48e613d`)

### 20.1 The re-fire, and the duplicate it collided with

Two seats were re-fired detached by `boss-bot` (terminal-tool background session, stdout+stderr redirected to
`team/RUN_<seat>_p6.log`, prompt = `team/ASK_<seat>_p6.txt` + an appended RE-FIRE DELTA, ask files NOT re-authored):

| seat | re-fire launcher pid | python child | created | owed first artifact |
|---|---|---|---|---|
| `pixel-measure` | **21832** | 62756 | 22:10:14 | `frontend/tokens.json` + first rows of `team/VISUAL_PARITY.md` |
| `storybook-dev` | **27900** | 44436 | 22:10:14 | `frontend/.storybook/{main,preview}.ts` + a GREEN `build-storybook` + the story index |

**hr-bot's premise is CORRECTED, not confirmed.** The 22:0x fire was **never dead**: at 22:12 the
22:08:34 pair was still running - `pixel-measure` launcher **36920** (descendant tree 12 procs, **18.5 s CPU**,
4 x `headless_shell` mid-render) and `storybook-dev` launcher **14340** (3 procs, 26.8 s CPU). The pids
§19 logged (27072 / 64904) were that fire's *shell* pids, so `absent from tasklist` was a **wrong-pid
measurement, not a death**. The 0 B `RUN_*_p6.log` files are also not evidence of death: `hermes -z` writes
to a file fd, so the log is block-buffered and flushes only at exit.

**That made TWO seats per lane in ONE `frontend/`** - both pixel-measure trees held 4 headless Chromium shells
each, rendering the same `frontend/out/` and the same `:4123`. Deduped, dupes first:

```
$ taskkill /PID 36920 /T /F   -> GONE (tree: 65080, 45188, 46856, + headless_shells)
$ taskkill /PID 14340 /T /F   -> GONE (tree: 59516, 60344, 6324)
survivors: 21832 (pixel-measure) ALIVE | 27900 (storybook-dev) ALIVE
```

The later fire was kept because its delta carries the load-bearing guard the earlier one lacked:
*"do NOT run `npm ci` (it wipes `node_modules`)"* - two lanes share one `frontend/`.
**No corruption from the kill:** sha256 of every baseline file identical pre/post; the only change in that
window was one added file, `deltas.json`.

### 20.2 On disk, measured (not self-reported)

| path | bytes | sha256 |
|---|---|---|
| `frontend/tokens.json` | **1,089,146** | `8d94ad1ea9d20075f1e28eb0dedaf9bbb8bfd46b9db0b60234b1eaa6d4250418` |
| `frontend/tests/visual/measure.cjs` | 12,408 | `475601f391a2b727ad2859ce2e779fab17aa324254c6970e70080dd7c613c0b8` |
| `frontend/tests/baselines/MANIFEST.json` | 4,247 | `9804cec294858b605f0a1303d016cb629cb6a9901307fd14b4836bcdd17aed9e` |
| `frontend/tests/baselines/deltas.json` | 15,252 | - |
| `frontend/.storybook/main.ts` | 1,219 | `b74f2911694cf09298c6f91e1ce75d2d96e8c6ff87ee53151a7dea07ec087ed2` |
| `frontend/.storybook/preview.ts` | 3,859 | `0a4eb3d6bb462498a0ad14da9b73f1e879d3f8750c3f1414107153a93c7820a9` |
| `frontend/storybook-static/index.json` | 8,176 | `98e42da70c6ce195c264852129cb9eba5bb4d9b88a7cbc9edd5e90db4e4e1956` |

- `frontend/tests/baselines/**` - **62 files** = 30 PNG + 30 a11y json + MANIFEST + deltas;
  sha256 of the sorted `"<sha>  <path>"` manifest of the whole set = **`11cd0d329839c3b5be930c78447035ffdcb665e00350db59b964dc5bcc56b7f9`**.
  Grown from the 24 files §19 measured (settings lane + `MANIFEST.json` + `deltas.json` added).
- `frontend/tokens.json` **meets its acceptance**: `headRevision` = `48e613dcb3bcb66f5fbdd41c7f58947d263fc63a`
  (= HEAD), `themes.light` **and** `themes.dark`, 6 families each, and every value is
  `{"name","selector","value"}` - **the element selector is recorded per value**. Captured by
  `node tests/visual/tokens.cjs` against the real static export on `:4123`, chromium 131.0.6778.33, DSF 2.
- `frontend/package.json` 1,720 -> **2,149 B** (`@storybook/*` dev-deps + `storybook` / `build-storybook`
  scripts); 5 story files (`Composer` 4,566, `MessageList` 4,371, `Sidebar` 3,224, `ArtifactCard` 1,576,
  `ModelSelector` 1,396) -> `storybook-static/index.json` v5 lists **31 story entries**.
- **STILL MISS:** `team/VISUAL_PARITY.md` (pixel-measure); the seat's own `build-storybook` **exit code**.

### 20.3 The one gate that is RED: `build-storybook` exits 1

`storybook-dev`'s exit criterion is a GREEN build. The seat's log is still buffered, so `boss-bot` ran the
gate independently, twice, into a throwaway `-o` dir (no clobber), the second with telemetry off and `CI=1`:

```
$ STORYBOOK_DISABLE_TELEMETRY=1 CI=1 ./node_modules/.bin/storybook build -o .sb-verify2 --quiet --disable-telemetry
info => Manager built (153 ms)
info => Building preview..
=> Failed to build the preview
SB_BUILDER-WEBPACK5_0002 (WebpackInvocationError): Module not found: TypeError: Cannot read properties of
undefined (reading 'tap')   at @storybook/builder-webpack5/dist/index.js:1:25029
EXIT=1
```

**Reproducible: `EXIT=1` on both runs** - while still writing a complete 3.7 MB / 31-entry index.
So *"stories exist"* is true and *"green"* is FALSE: the manager builds, the **preview** build throws
(`reading 'tap'` at `builder-webpack5` - the signature of a webpack-version mismatch between
`@storybook/builder-webpack5` and the project's webpack, not a story-file defect). A seat that pastes
`index.json` and calls the gate green would be self-reporting over a red exit code. **Owner: `storybook-dev`.**

### 20.4 Push

**Nothing to push; the §19 claim is stale.** Authoritative check, bypassing local refs:

```
$ git ls-remote origin release/owned-staging-20260917
48e613dcb3bcb66f5fbdd41c7f58947d263fc63a   refs/heads/release/owned-staging-20260917
$ git rev-parse HEAD                                   -> 48e613d
$ git rev-list --left-right --count origin/...HEAD     -> 0    0
```

Remote tip == local HEAD, ahead **0**. §19's *"HEAD `ea17529` unpushed, remote `fdea17d`"* is superseded:
both `ea17529` and `48e613d` are on the remote.

### 20.5 Supersedes, and the owner delta

- **Supersedes §19's seat pids (27072 / 64904)** as the live seats, and supersedes the premise
  *"the seat runs did NOT survive their caller"*: they did survive - the measurement used the wrong pid.
- **§19.2 stands, re-measured:** P5's RED gate spec is still absent and `Composer.tsx`'s 70 px Send
  overflow is still unfixed; no phase is re-opened.
- **Owner delta:** no row changed hands. `pixel-measure` (21832) still owes `team/VISUAL_PARITY.md` first
  rows; `storybook-dev` (27900) now owes a **green** `build-storybook` (exit 0), which is a *config* fix,
  not a story fix.
- **New hygiene rows (two):**
  1. *A seat's launcher pid is not the seat.* Measure liveness with
     `Get-CimInstance Win32_Process` matched on the profile flag in the command line, and measure *work* by
     summing CPU over the descendant tree - the launcher sits at 0.0 s CPU with 1 thread while its python
     child renders.
  2. *Do not infer a second fire before checking for a live first.* The 22:10 fire duplicated a live 22:08
     pair and put two renderers on one `frontend/`; dedupe before dispatch, not after.
- **Concurrent-writer hazard:** a sibling `boss-bot` session (pid **20240**, `-p boss-bot`, 22:08:27) is
  still live with this same prompt and may also append a section 20. If `team/PHASES.md` carries two
  `## 20.` headings, this one is the one whose pids are 21832 / 27900.

---

## 21. §20 CLOSE-OUT — the two rows §20 left open are CLOSED, measured (the pass the boss asked for as "§20")

`boss-bot`, 2026-09-29 22:2x EDT, HEAD **`3b994cd`**. A sibling `boss-bot` (pid **20240**, same prompt)
appended its `## 20.` first, so this is the same pass numbered **21** — one `## 20.` and one `## 21.`,
not two §20s. Every number below is mine, from the filesystem.

### 21.1 `team/VISUAL_PARITY.md` — landed, and its gate re-run by the orchestrator

`team/VISUAL_PARITY.md` **10,164 B**, sha256 **`6bf5178fcbe570bb108e4b9a2ee3aeabb711cac0fab5cd277efd9bd70cf9f44f`**
(22:19). §20.2's "STILL MISS: `team/VISUAL_PARITY.md`" and §20.5's "21832 still owes it" are **closed**.

- 30 rows (screen × theme × viewport), each carrying bytes + sha256 + delta % + verdict; `chat-shell` @390x844
  and @320x844 carry **pending P5** because P5's fix has not landed.
- **Independent re-run of the seat's own gate:** `node tests/visual/measure.cjs --verify` → **EXIT 0**,
  `rows 30 · worst delta 0.0000% · FAIL 0`. Row 1 JSON: `baselineSha256 == liveSha256 == 92439c18eb06…`,
  `diffPixels 0`, `a11yDiff 0`, `verdict PASS`.
- Spot-checked against disk: `frontend/tests/baselines/landing/dark/1440x900.png` **401999 B**, sha256
  `92439c18eb0658a3dd55c2fd32550f5c2040b60fec55eef39a24010a7b0ea50c` — byte for byte the ledger's number.
  `find … -name '*.png' -printf '%s' | awk` → **5,659,631 B in 30 PNG** = the ledger's own manifest total.
- **Supersedes §20.2's MANIFEST row:** on disk now `frontend/tests/baselines/MANIFEST.json` **12,633 B**,
  sha256 **`059194bb3f5e47134c28ea718739640620880e7c699843538d409c0b37844786`** (the ledger cites exactly this),
  **not** the 4,247 B / `9804cec2…` §20.2 measured — the later capture rewrote it. The `deltas.json` on disk
  (sha `c6f703e8…`) is my re-run's, written after the ledger's; the row set is identical.
- `frontend/tokens.json` 1,089,146 B sha `8d94ad1e…` (unchanged, re-hashed) — light+dark, selector per value.

### 21.2 `build-storybook` is GREEN — §20.3's RED is superseded by the config patch

Two raw runs, both on the current config (`frontend/.storybook/main.ts` **1,598 B**, sha256
`3ac88f3cddb1e2d52c8ed8233ec5000ed075eda920556f940487ac01117419cb`, mtime 22:17):

```
cd frontend && npx build-storybook                        -> EXIT 0   ("Preview built (39 s)")
cd frontend && ./node_modules/.bin/storybook build -o <tmp> --quiet --disable-telemetry
                                                          -> RAW_CLI_EXIT 0 ("Preview built (38 s)", 31 entries)
frontend/storybook-static/index.json  8176 B  sha256 98e42da70c6ce195c264852129cb9eba5bb4d9b88a7cbc9edd5e90db4e4e1956
```

The `reading 'tap'` throw in §20.3 was the webpack cache-shutdown path; `main.ts` now forces
`config.cache = false` in `webpackFinal`. **§20.3 measured the 1,219 B pre-patch config** (sha `b74f2911…`);
both exit codes above are post-patch. Evidence file: `team/EVIDENCE_storybook_p6.txt` **2,213 B**.
`.storybook/preview.ts` 3,859 B (`0a4eb3d6…`), `build-storybook.mjs` 743 B, `@storybook/*` deps in
`frontend/package.json`; 5 story files → 31 index entries. **~20 of the §10 stories are still owed.**

### 21.3 Log-diagnosis correction (mine), and the one durable recipe

A 0-byte `team/RUN_*_p6.log` proves **nothing about a seat**. Here it had two causes, in order: (1) the v1
pair was **SIGKILLed** (`taskkill /PID 36920 /T /F` / `14340 /T /F`, §20.1), so block-buffered stdout never
flushed; (2) `hermes -z` writes to a file fd, so a log is only as fresh as the last 4 KiB block. The 4,074 B
in `team/RUN_pixel-measure_p6.log` (pid **63928**) is exactly one block — a flush at a seat's own exit, not a
console-flag effect. **Recipe kept: `team/refire_seat.py`** (1451 B, sha256
`9752228920aa7176a21d9bf0ac5fe45ea9008904d763586e5f85047694573bb4`) — spawns `hermes.exe -p <seat> --in
<proj> -z "<ask + delta-note>"` with `CREATE_NEW_CONSOLE|CREATE_NEW_PROCESS_GROUP`, stdout+stderr to the log.
Ask files were read, never re-authored. Pids this pass: **36920**, **14340** (both killed), **63928** (clean exit).

### 21.4 Push

`git rev-list --left-right --count origin/release/owned-staging-20260917...HEAD` → **`0	0`**; HEAD `3b994cd`
== remote tip. §19's `ea17529` is on the remote. Nothing left unpushed.

### 21.5 Supersedes, and the owner delta

- **Supersedes §20.2's MANIFEST row and its two "STILL MISS" rows; supersedes §20.3 (RED) and §20.5's
  "owes a green build".** §20.1/§20.4 (dedupe, remote tip) stand.
- **§19.2 stands, re-measured:** P5's fix has not landed and `frontend/tests/e2e/mobile-composer.spec.ts`
  is still absent — **`ui-visual` and `qa-verify` hold the head of the critical path.**
- **Owner delta, three rows, none changed hands:**
  `pixel-measure` → first artifacts landed (`tokens.json`, baselines 62 files, `VISUAL_PARITY.md`); still owes
  `frontend/tests/e2e/visual-parity.spec.ts`. `storybook-dev` → `.storybook/**` + a green `build-storybook` +
  the 31-entry index landed; still owes ~20 §10 stories and the storybook line in the gate. `boss-bot` →
  two hygiene rows: **dedupe before dispatch** (two lanes ran two renderers each on one `frontend/` this window)
  and **never `taskkill /T /F` a seat whose stdout is a file** (you lose its transcript, then misread the 0 B
  as death — which is exactly how §19's premise and my own §20 draft went wrong).

## 22. §22 CLOSE-OUT — the P5 gate is ON DISK and RED at HEAD; the ledger closes on measured state

**Pass:** `boss-bot`, 2026-09-30 00:1x–00:3x EDT. Filed against `team/ASK_boss-bot_done.txt` on the user's
word "done". **Supersedes §21.5's owner-delta and §16.6's ledger table; §21.1/§21.2 (measurement +
storybook landed) and §21.3 (the 0-B log recipe) stand.** Everything below is re-measured this pass.

### 22.0 Three deltas the ask's numbers took before I read them (all measured)

```
$ git rev-parse --short HEAD                      -> ca3682a   (ask said bd031ba)
$ git diff --stat bd031ba ca3682a                 -> team/ASK_boss-bot_done.txt 36+, team/NOTE_boss-bot_done_state.md 3+  (docs only)
$ git rev-list --left-right --count origin/release/owned-staging-20260917...HEAD  -> 0  0
$ sha256sum frontend/playwright.config.ts          -> 307984c5…  781 B, 2 projects   (mtime 00:11:13)
$ sha256sum frontend/tests/e2e/mobile-composer.spec.ts -> 9ae21ebf…  12,644 B  (mtime 00:05:29)
```

1. HEAD is **`ca3682a`**, one docs commit past the ask's `bd031ba` (hr-bot filed the ask; already on the remote).
2. **`frontend/playwright.config.ts` was REVERTED to HEAD's 781 B at 00:11:13** — the `phone-390` / `phone-360`
   projects the ask calls "LANDED" are **gone from the live tree** (it was `78b51845…` with 4 projects when the ask
   was written). The live `qa-verify` seat (pid 59476, still alive) is the writer. **The gate's viewports live in
   the config, and the spec calls no `setViewportSize`: with the revert, the describe labels (`viewport 390x844`)
   are cosmetic and both projects run at the project's own width.**
3. Same window: `frontend/package.json` + `package-lock.json` are back at HEAD (no `storybook` /
   `build-storybook` scripts, no `@storybook/*` devDeps), so the `.storybook/**` on disk has no manifest entry.
   `node_modules/.bin/storybook` still resolves (untracked tree).

### 22.1 The P5 gate on a build of HEAD — **RED, and RED before it asserts anything**

```
$ git worktree add --detach …/lg-headgate ca3682a && cd lg-headgate/frontend && npx next build
  -> RAW_CLI_EXIT 0 ; frontend/out/ 9.7M
$ cd frontend && npx playwright test tests/e2e/mobile-composer.spec.ts --project=phone-390 --project=phone-360
  -> SyntaxError: mobile-composer.spec.ts:141:124 Missing semicolon.  ->  Error: No tests found.
$ node -e "ts.createSourceFile(…spec…).parseDiagnostics.length"   ->  9
```

The landed spec **does not parse**. Three distinct syntax defects, by line: **141** stray `)` closing
`route.fulfill(…)` (`…JSON.stringify(b) }))`); **149** stray `)` closing the `stubApi` arrow (`return ok({}, 200)`
+ `}))`); **154** stray `}` inside `micInit`'s `setTimeout(() => this.onresult?.({…}) }, 150)`.

Two further defects surface only once it parses (measured on a scratch copy of the *same* 12,644 B spec — product
code untouched, `next build` unchanged):

- **74 / 116:** `CARDS` is closed over inside `PROBE` and `MENU_PROBE` and handed to `page.evaluate`, and
  `label` likewise in `MENU_PROBE` → `ReferenceError: CARDS is not defined` / `label is not defined`.
  All 24 tests fail before one assertion runs.
- With `CARDS` and `label` passed as arguments, the gate runs: **20 failed, 4 passed (5.4 s)**.

**The units it asserts, measured on HEAD** (`team/RUN_gate_p5_scratch2.log`):

```
phone-390 project (390 wide):  row.scrollWidth 376  >  row.clientWidth 364   Expected <= 364, Received 376
phone-360 project (360 wide):  row.scrollWidth 455  >  row.clientWidth 334   Expected <= 334, Received 455
popovers:  "open EffortSelector: role=menu rendered"  Received: null (menu never renders)
           locator.click: Element is not visible  on  button.chip[aria-label^="Reasoning effort"]
chips (the 4 green):  pass by ASSERTING THE DEFECT — expect(wrap).toHaveLength(3) counts the 3
           white-space:normal spans (span h=24 in a 32px chip); they invert when ui-visual's fix lands.
```

**The one line the next pass needs:** `mobile-composer.spec.ts` is RED on HEAD (376>364 at 390; 455>334 at 360)
and needs **five** fixes before it is a gate — the three syntax defects (141/149/154), `CARDS`+`label` passed into
`page.evaluate`, and the four chips assertions flipped from *defect-present* to *defect-absent*. Owner `qa-verify`;
the defect it guards is still `ui-visual`'s.

### 22.2 The ledger close-out — one line per phase, done / owed / owner

| phase | done (measured artifact) | owed | owner |
|---|---|---|---|
| **P0** | SHIPPED code+gates `7540a3d` | the deployed leg (`/version.json` `revision:"unknown"`, live re-probe below) | `ops-release` |
| **P1** | `A11Y_AXE.md` 3,257 B; `FRONTIER_RECON.md` shipped `ef77e80` | `team/PERF_P1.md` **MISS**, `team/RELEASE_P1.md` **MISS** (re-measured this pass) | `perf-eng`, `ops-release` |
| **P2** | gate GREEN at `0d5d767` (§11.3); contract `350ad4d` | — | — |
| **P3** | P0 reviewable since `7540a3d` | the re-freeze, after P2 (now unblocked) | `arch-lead` |
| **P4** | `/api/version` read-back works | `/version.json` still `revision:"unknown"` — live now: `{"surface":"web","revision":"unknown","builtAt":"2026-09-30T02:09:19.467Z"}` | `ops-release` |
| **P5** | gate **ON DISK** `mobile-composer.spec.ts` 12,644 B sha `9ae21ebf…` — **RED** (§22.1) | `ui-visual`'s fix commit + `team/UI_MOBILE_WEB_ui-visual.md` (**MISS**); qa-verify's 5 spec fixes; the 2 phone projects back in the tracked config | `ui-visual`, `qa-verify` |
| **P6** | measurement: `frontend/tokens.json` 1,089,146 B, `team/VISUAL_PARITY.md` 10,164 B, `frontend/tests/baselines/` **62 files 5.7 MB**; storybook: `.storybook/{main.ts,preview.ts,build-storybook.mjs}`, 5 story files → 31-entry index, `storybook-static/index.json` 8,176 B | `visual-parity.spec.ts` **MISS**; ~20 of ~25 §10 stories; the A6 catalog depth | `pixel-measure`, `storybook-dev`, `core-dev` |

**Blueprint phases (BP §3's own P0…P10 — the second numbering on this board).** Only **BP P0 (Storybook)** and
**BP P1 (measurement)** were ever dispatched, and the only blueprint kickoffs on disk are
`team/P6_KICKOFF_storybook-dev.md` 2,347 B and `team/P6_KICKOFF_pixel-measure.md` 2,070 B. **BP P2–P10 have no
kickoff file and no artifact**; ledger-side they fold into ledger P2 / P5 / P6. That is a measured statement, not
a plan: `ls team/P6_KICKOFF_*` → those two files.

### 22.3 The owed list — one line each, with owner

- `pixel-measure` → `frontend/tests/e2e/visual-parity.spec.ts` (**MISS**; its three named artifacts are already on disk).
- `storybook-dev` → the **~20 remaining §10 stories** (5 of 52 `frontend/app/**/*.tsx` have one), plus restoring the
  `storybook` / `build-storybook` scripts and the `@storybook/*` devDeps to `frontend/package.json`, plus one line
  in the gate.
- `ui-visual` → the **P5 fix commit** + `team/UI_MOBILE_WEB_ui-visual.md` with after-geometry (**MISS**).
- `qa-verify` → the **clean-step recipe** (`frontend/tsconfig.tsbuildinfo` 312,030 B, matched by `.gitignore`'s
  `*.tsbuildinfo` — remove it before a clean build) and **the real runner name**, **and** the five spec defects in §22.1.

### 22.4 The two hygiene rows (`boss-bot` owns both, §21.5 carried)

1. **Dedupe before dispatch.** Two lanes ran two renderers over one `frontend/` this window; the 00:11:13 config
   revert is the cost, and §22.0 is the re-measure that caught it. Rule: one writer per file per window.
2. **The two untracked trees, and who pays.** `frontend/storybook-static/` **36 MB** → **ignore** (reproducible:
   `node .storybook/build-storybook.mjs`); owner to add the line: **`storybook-dev`**. `frontend/tests/baselines/`
   **5.7 MB / 62 files** → **commit** (a baseline outside the repo cannot gate a pixel diff); owner to commit:
   **`pixel-measure`**, with `visual-parity.spec.ts`. Neither has a `.gitignore` line today
   (`grep -n -E 'storybook-static|baselines' frontend/.gitignore .gitignore` → **0 hits**).

### 22.5 Declaration

**DONE today, on the evidence above:** the product on `release/owned-staging-20260917` (`ca3682a`) builds clean from
a HEAD checkout (`next build` EXIT 0, `out/` 9.7 M) and is live (`https://loop-gpt.cyou` → HTTP 200); the P2 gate
is green and committed; the a11y + desktop e2e suite exists; the P6 measurement lane landed all three of its named
artifacts (`tokens.json`, 62 baselines, `VISUAL_PARITY.md`); Storybook builds to a 31-entry index; and the **P5
gate now exists on disk**. **NOT done, and named with owners:** the P5 phone fix has not landed and its gate is RED
on HEAD and does not even parse (5 defects); the gate's two phone projects are absent from the tracked config;
`visual-parity.spec.ts`, `PERF_P1.md`, `RELEASE_P1.md`, `UI_MOBILE_WEB_ui-visual.md` are MISS; the deployed
`revision` is still `"unknown"`; ~20 §10 stories are unwritten. **Nothing in §22.2 is owed without an owner.**
