# team/PHASES.md — Loop GPT phase ledger (owner: boss-bot)

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

## 1. Phase board (P0..P4 — 5 phases)

| phase | owner | deliverable | acceptance | status |
|---|---|---|---|---|
| **P0** — land the in-flight work | `ui-visual` (solo writer of `hooks.ts`), `core-dev` (`/api/tts` contract), `boss-bot` (this ledger + `team/P0_CLOSEOUT.md`) | §8-40 connector chip, §8-44 hands-free voice, §8-45 server TTS + `ttsEngine` pref, Appearance tab | clean tree; gates green (`tsc`, `lint`, `vitest`, `playwright`, `build`); revision reviewed by both lanes; deployed | **SHIPPED (code + gates) — `team/P0_CLOSEOUT.md`.** `7540a3d`, 14 files, +836/−42. `tsc`=0, `lint`=0 (13 warn / 0 err), `vitest` 23 files/150 tests, `playwright` 20 passed, `build` exit 0 (19 routes). One commit, not four. **"Deployed" NOT met** — §3b. Proof: §E1, E9–E13, `team/P0_CLOSEOUT.md` |
| **P1** — close the launch gaps | `perf-eng` (perf), `ops-release` (release+deploy), `qa-verify` (a11y), `research-scout` (recon), `core-dev` (version endpoint) | `team/PERF_P1.md`; `team/RELEASE_P1.md`; `team/A11Y_AXE.md` (GAP-003 `serious` contrast sweep); `team/FRONTIER_RECON.md`; `GET /api/version` | one line of raw evidence each: byte size, sha256, HTTP status, test count; before/after number per fix; no `NEEDS CONFIRMATION` left unowned | **4 of 5 LANDED.** `FRONTIER_RECON.md` (pass 2, 15,465 B, `2e74b58`), `CONTRACT_P2_STREAM.md` (8,023 B, `350ad4d`), resolver + `/api/version` (live `200`, revision `3a43db8`) all hash-verified by me (§7.1/§7.3). **ABSENT still: `PERF_P1.md`, `RELEASE_P1.md`, `A11Y_AXE.md`.** Proof: §E19, §6, §7 |
| **P2** — frontier-parity UI rebuild | `ui-visual` (builds the accepted list), `arch-lead` (contract for any new surface), `mobile-dev` (mirrors accepted IA into `mobile/`) | rebuilt chat/landing surface to Claude/ChatGPT/Grok standard — fast + snappy; `mobile/` parity | accepted pattern list from P1 recon is the only source of work; each item carries a before/after measurement; contract signed before a new surface lands | **IN FLIGHT** — contract signed (`350ad4d`); `ui-visual` has ranks 1/3/5/7 open against it; the effort selector is unblocked (`3a43db8` zod accepts the union) |
| **P3** — independent verification | `qa-verify` (dynamic) + `code-review` (static) on the FROZEN revision; `perf-eng` re-measures post-rebuild | dynamic + static verdicts pinned to a revision hash; post-rebuild perf numbers | both lanes report the revision hash — "green" must refer to specific bytes | **OPEN** — P0's frozen revision (`7540a3d`) is reviewable NOW; re-freeze after P2 |
| **P4** — release | `ops-release` (migration state, deploy, served-revision read-back, tag); `boss-bot` (close-out, roster + docs, declare) | deployed revision + tag; read-back proving the served revision | served revision read back from the live host, not from a deploy log; roster + docs updated in the same pass | **HALF-CLOSED** — API read-back **works** (`GET /api/version` → `200`, revision `3a43db8`, `no-store`); the web/nginx half still has **no** served marker (served `/chat/` HTML carries no revision/40-hex) — §7.3 |

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
