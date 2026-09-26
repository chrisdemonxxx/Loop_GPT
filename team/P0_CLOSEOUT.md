# team/P0_CLOSEOUT.md — P0 exit gate (owner: boss-bot)

**P0 verdict: SHIPPED-CODE / GATES-GREEN on the frozen revision; DEPLOY NOT PROVEN.**
Written 2026-09-26 by `boss-bot`, from the filesystem, not from any seat's self-report.

## 1. The revision

| what | raw value |
|---|---|
| branch | `release/owned-staging-20260917` |
| **frozen P0 revision** | `7540a3dcc55dcaaa2308fe78c260686296ca5289` (`7540a3d`) — `git cat-file -t` → `commit` |
| author / date | `chris <chris@loop-gpt.cyou>`, Sat Sep 26 03:52:07 2026 -0400 |
| subject | `feat(voice+connectors): server TTS, hands-free voice mode, connector chips, Appearance tab (audit SS8-45/40/44/36)` |
| diffstat | `14 files changed, 836 insertions(+), 42 deletions(-)` (`git show --stat 7540a3d`) |
| docs commits above it | `30ce162` (hr-bot roster/probes/ledger), `5a74833` (perf baseline) — tree/docs only, no app code |
| origin position | `origin/release/owned-staging-20260917` = **`7540a3d`**; local is `ahead 2` (`30ce162`, `5a74833` **unpushed**) |

Files in the revision (all 4 P0 items land in one commit — the "one commit per item" ideal was
not met, the content was):

`frontend/app/chat/hooks.ts` (+182), `frontend/app/components/chat/Composer.tsx` (+62),
`frontend/app/components/settings/AppearanceTab.tsx` (new, 55 lines),
`frontend/app/components/settings/PersonalizationTab.tsx` (+23), `frontend/app/lib/voice.ts` (+97/-…),
`frontend/app/components/SettingsPanel.tsx`, `frontend/app/components/chat/types.ts`,
`frontend/app/chat/page.tsx`, `frontend/app/lib/stream.ts`, plus 5 test files.

## 2. Gates — raw command, raw result (run by boss-bot on the frozen revision)

| gate | command | raw result |
|---|---|---|
| types | `cd frontend && npx tsc --noEmit; echo TSC_EXIT=$?` | `TSC_EXIT=0` |
| lint | `npm run lint > f; echo LINT_EXIT=$?` | `LINT_EXIT=0`; `grep -c "Warning:"` → **13**, `grep -c "Error:"` → **0** |
| unit | `npx vitest run --reporter=basic` | `Test Files 23 passed (23)` / `Tests 150 passed (150)` / `Duration 4.29s` |
| browser | `npx playwright test --reporter=line` | `20 passed (4.5s)` — 2 projects (`desktop-chromium`, `mobile-chromium`) × 10 specs incl. axe `critical` gate |
| build | `rm -rf out .next && npm run build` | `BUILD_EXIT=0`; 19 routes, `+ First Load JS shared by all 83.5 kB`; `find out -name '*.html' \| wc -l` → **18** (`out/index.html`, `out/chat/index.html` present) |
| tree | `git status --porcelain` | clean at freeze (only `?? team/PERF_BASELINE.md`, since committed as `5a74833`) |
| live host | `curl -s -o /dev/null -w '%{http_code}' https://loop-gpt.cyou/healthz` | `200` |

No `NEEDS CONFIRMATION` remains for P0: the four §8 items are present, wired, and gated.
`AppearanceTab` wired at `SettingsPanel.tsx:12` + `:67`; `/api/tts` contract
(`backend/src/routes/tts.ts`, cap 4000, bytes-or-`{url}`) matches the client at
`frontend/app/lib/voice.ts:161`.

## 3. Deploy — the one P0 acceptance NOT met (evidence)

P0 acceptance said "deployed". **The live host is not serving a build of this revision.**
Method: fetch the chunk names `/chat/` references, then set-diff them against a fresh build of HEAD.

```
$ curl -s https://loop-gpt.cyou/chat/ | grep -oE '_next/static/chunks/[A-Za-z0-9_./-]+\.js' | sort -u   # 18 names
$ ls out/_next/static/chunks/**/*.js                                                                    # 114 files (fresh build of HEAD)
```

8 of the 18 served names are **absent** from the fresh build:
`2631-7754d38b30959869.js`, `3452-c378463bd237c50e.js`, `4951-189c2c7dd73b3de3.js`,
`9864-960151d4ff000335.js`, `app/chat/page-4ad1d24a9176ae82.js`, `app/layout-a7c7cf45c3f55274.js`,
`main-app-2f3800c6e4826db2.js`, `webpack-12ed1796ffdc89d3.js`.

The webpack runtime hash differs outright — `served webpack-12ed1796ffdc89d3.js` vs
`built webpack-bfdd25fdbe871018.js` — and the same module ids carry different content hashes
(`2631-7754d38b…` vs built `2631-0c0b19adc4c4a71b.js`; `3452-c378463b…` vs built
`3452-89f59a52a39385fe.js`; `app/layout-a7c7cf45c3f55274.js` vs built
`app/layout-4b219603817a6a76.js`). The webpack hash is content-derived, so the served bundle
is a **different build** than HEAD. **A deploy is required before P4 can claim a served revision.**

### 3b. There is no way to read the served revision back (3 raw probes)

```
$ curl -s -o /dev/null -w '%{http_code}\n' https://loop-gpt.cyou/api/version          → 404
$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
      https://api.loop-gpt.cyou/api/version                                            → 404 text/html 150
$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
      https://api.loop-gpt.cyou/health                                                 → 200 text/html 27285   ← the WEB page, not backend JSON
```

- `web/nginx.template.conf:32` — `location = /healthz { return 200 "owned-web\n"; }` → the
  live `/healthz` is a **static string from nginx**. It proves nginx is up. It proves nothing
  about the backend or the revision. A monitor on it can be green while the API is down.
- `backend/src/server.ts:171` serves `app.get('/health')` → `{status:'ok',timestamp}`, but
  nginx only proxies `^/api(?:/|$)` and `^/v1/`, so the API origin's `/health` falls through to
  `location /` and returns the static export's `index.html` — a **false-green** (HTTP 200,
  `text/html`, 27,285 B, no JSON).
- Nothing anywhere exposes a build SHA. `grep -rn "GIT_SHA\|/api/version" backend/src` → no match.

## 4. What changed (paths) and what remains

**Changed:** `frontend/` ×14 files (voice/connectors/Appearance, `7540a3d`) — the P0 feature set;
`team/` ledgers (`30ce162`, `5a74833`, this file).

**Remains for P1 (each with an owner — see `team/PHASES.md` §1):**
1. **Deploy the frozen revision and prove it** — `ops-release`; the read-back above is the test, and
   the read-back needs a **`GET /api/version` → `{sha, builtAt}`** endpoint that does not exist yet
   (`core-dev`, contract + `web/nginx.template.conf:32` → proxy or embed the SHA in the static
   `/healthz` body). Both are new, evidenced work, not previously on the board.
2. **Perf** — `/chat` first-load is **505 kB JS**; mermaid is loaded unconditionally at
   **2.5 MB raw / ~692 kB gzip** (`team/PERF_BASELINE.md`, measured). `perf-eng`.
3. **A11y** — the axe suite gates on `impact==='critical'` only
   (`frontend/tests/e2e/app.spec.ts:10-13`); the `serious` contrast sweep (GAP-003) is still open. `qa-verify`.
4. **Release items** — `team/RELEASE_BASELINE.md` #1–#6, incl. the stale `docs/RUNBOOK.md:144`
   footer (restore is closed per PROGRESS, footer says pending) and the absent `STRIPE_*`/`SMTP_*`
   prod vars. `ops-release`.

**Two unpushed docs commits** (`30ce162`, `5a74833`) sit on a local branch — push or they don't exist
for the rest of the fleet.
