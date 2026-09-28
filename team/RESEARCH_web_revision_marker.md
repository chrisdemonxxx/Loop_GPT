# RESEARCH — web `/version.json` marker: the exact unblocker, cited and probed

Owner: @research-scout. Probed live 2026-09-28T00:41Z. One claim per line, source beside it.
Confidence: `VERIFIED` = raw probe or file read in this pass; `UNVERIFIED` = not reachable from here.

---

## A. Live state (raw probes)

- VERIFIED — `curl -s -w " HTTP=%{http_code} t=%{time_total}s\n" https://loop-gpt.cyou/version.json`
  → `{"surface":"web","revision":"unknown","builtAt":"2026-09-27T23:21:12.630Z"} HTTP=200 t=0.747567s`
  → the marker path works, nginx serves it, and the value is the honest `unknown` the code documents.
- VERIFIED — `curl ... https://loop-gpt.cyou/api/version`
  → `{"service":"loop-gpt-backend","revision":"a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37","startedAt":"2026-09-27T23:19:54.262Z","node":"v22.23.2"} HTTP=200 t=1.090646s`.
- VERIFIED — `git rev-parse HEAD` → `a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37`; `git log -1 --format='%H %cI'`
  → `a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37 2026-09-27T19:19:33-04:00` (= `23:19:33Z`).
  → backend revision == git HEAD. Web `builtAt` (`23:21:12Z`) is 99s **after** that commit and 78s after the
  backend process start → the running web image *is* a post-`a4b29bb` build. **The gate's web half is deployed
  and blind, not stale.** (§F acceptance field differs on exactly one surface.)

## B. Where the value comes from (filesystem ground truth)

- VERIFIED — `web/Dockerfile:15` `ARG GIT_REVISION=""`, declared **inside** the `AS build` stage
  (`FROM node:22-bookworm-slim … AS build` at `:3`) and consumed at `:31` in the same stage.
  → placement is already correct per Railway's rule "declare the `ARG` inside the stage that uses it";
  no code change is needed to make this work.
- VERIFIED — `web/Dockerfile:31` reads **one** candidate: `… (process.argv[1]||'').trim() … "$GIT_REVISION"`.
- VERIFIED — `web/Dockerfile:13-14` names the operator fix in the file itself:
  `Set the web service variable GIT_REVISION to the deploy's commit SHA (Railway: ${{RAILWAY_GIT_COMMIT_SHA}})`.
- VERIFIED (delta, new) — `team/CONTRACT_P2_STREAM.md:183` **proposes** a 6-candidate fallback chain
  (`$GIT_REVISION $BUILD_REVISION $RAILWAY_GIT_COMMIT_SHA $GIT_SHA $SOURCE_VERSION $HEROKU_SLUG_COMMIT`),
  mirroring the backend's precedence at `backend/src/routes/version.ts:21-23`. The **shipped** Dockerfile
  implements only the first candidate. The contract line is proposed-not-shipped.
- Consequence of the above (VERIFIED by the two reads): the backend and web markers do **not** share a
  precedence chain today — web has no fallback, so `BUILD_REVISION`/`RAILWAY_GIT_COMMIT_SHA` cannot rescue it.
- sha256 anchors for this pass: `web/Dockerfile` `d7fa118c04ac7bf0168b…`, `team/CONTRACT_P2_STREAM.md` `a8d3aa85577a8290ddec…`.

## C. External ground truth — why the fix is a variable, and why it must be a *rebuild*

- VERIFIED — Railway, "Handle Build-Time vs Runtime Secrets in Docker Builds"
  (https://docs.railway.com/guides/build-time-vs-runtime-secrets): "**Dockerfile builds do not** [expose
  variables to the build]. Docker isolates the build from the host environment by design. To use a Railway
  variable during a Dockerfile build, you must opt in with an `ARG` instruction. … Railway matches the `ARG`
  name against your service variables and passes the value in."
  → **the web service variable must be named `GIT_REVISION`** — the name must equal the `ARG` name. That is
  the shipped Dockerfile's only `ARG`, so it is also the *only* variable-only fix; setting a differently-named
  variable (e.g. `RAILWAY_GIT_COMMIT_SHA` as a service variable) does not reach the build under this Dockerfile.
- VERIFIED — Railway, "Dockerfiles" (https://docs.railway.com/builds/dockerfiles): same rule, stated as
  "you must specify them in the Dockerfile using the `ARG` command".
- VERIFIED — Railway variables reference (https://docs.railway.com/variables/reference):
  `RAILWAY_GIT_COMMIT_SHA` = "The git SHA of the commit that triggered the deployment", provided "if the
  deploy originated from a GitHub trigger". Example shape `d0beb8f5c55b36df7d674d55965a23b8d54ad69b` (40 hex).
- VERIFIED — same guide, "Common failure modes": "**Changed a variable but the app still sees the old value.**
  If the value was consumed at build time, it is frozen in the image until the next build. **Deploy again to
  rebuild.**"
  → after setting `GIT_REVISION`, a **rebuild** is mandatory. A container restart / runtime-only redeploy will
  leave `revision:"unknown"` byte-identical. Changing the `ARG` value also invalidates Docker layer cache from the
  `ARG` line onward, so the redeploy will genuinely re-run `:31`.
- UNVERIFIED — that `${{RAILWAY_GIT_COMMIT_SHA}}` resolves on the `loop-gpt-owned-staging-20260917` web
  service, i.e. that the deploy is GitHub-triggered rather than CLI-`railway up`. Docs say it is provided only
  on GitHub-triggered deploys; I have no project-scoped credential to read the service's trigger origin.
  If a redeploy after setting `GIT_REVISION=${{RAILWAY_GIT_COMMIT_SHA}}` still yields `unknown`, that
  (deploy-origin) is the next hypothesis to test — not the Dockerfile.

## D. Acceptance probe the gate can run verbatim (one vocabulary)

```
A=$(curl -s https://loop-gpt.cyou/api/version  | sed 's/.*"revision":"\([^"]*\)".*/\1/')
W=$(curl -s https://loop-gpt.cyou/version.json | sed 's/.*"revision":"\([^"]*\)".*/\1/')
H=$(git -C <repo> rev-parse HEAD)
[ "$A" = "$H" ] && [ "$W" = "$H" ] && echo "GATE PASS $H" || echo "GATE FAIL api=$A web=$W head=$H"
```

## E. Tree state at probe time (one-writer seam is wider than two files)

- VERIFIED — `git status --porcelain` at 00:41Z: **8 tracked files modified** —
  `TEAM_ROSTER.md`, `frontend/app/chat/hooks.ts`, `frontend/app/chat/page.tsx`,
  `frontend/app/components/chat/Composer.tsx`, `…/chat/__tests__/Composer.test.tsx`,
  `frontend/app/components/chat/types.ts`, `frontend/app/lib/stream.ts`, `team/CONTRACT_P2_STREAM.md`
  (diffstat: 8 files, +142/−46).
- VERIFIED — untracked: `frontend/_fix{,2,3,4,5}.py` + `frontend/_final{2,3,4}.py` = **8** scratch files
  (matches @hr-bot's count); plus `frontend/app/components/chat/composer/EffortSelector.tsx`,
  `team/QA_P2_STREAM.md`, `team/ROSTER_NOTE_20260927_rev3.md`.
- VERIFIED (consequence) — `EffortSelector.tsx` is **imported** by `frontend/app/components/chat/Composer.tsx:12`
  and `frontend/app/chat/page.tsx:8`. It is untracked, so a commit of the modified files alone breaks the
  build. Any P2 commit must `git add` that file; the scratch `_fix*.py`/`_final*.py` files must not be added.

---

## F. M3's source text exists ONLY in a stash — HEAD and the worktree have the rev-2 contract (added 01:5xZ)

Probe at HEAD `0d5d767` on branch `release/owned-staging-20260917`.

- VERIFIED — `wc -l team/CONTRACT_P2_STREAM.md` → **165**; `git show HEAD:team/CONTRACT_P2_STREAM.md | wc -l` → **165**;
  `git show 1b16094:… | wc -l` → **165**; and
  `grep -c "ARG \|argv\|RUN node" team/CONTRACT_P2_STREAM.md` → **0**.
  → the §F portability clause (the six `ARG`s + the six-token `RUN`) is in **neither** HEAD **nor** the worktree.
  `git status --porcelain` shows `team/CONTRACT_P2_STREAM.md` **clean**.
- VERIFIED — the only copy in the repository is the stash:
  `git stash list` → `341fe60bb6e0236e3c7afd198485a21faaf212eb stash@{0} On release/owned-staging-20260917: qa2`;
  `git show 'stash@{0}:team/CONTRACT_P2_STREAM.md'` → **201** lines, `HEROKU_SLUG_COMMIT` at **:159, :170, :181, :185**.
  The six-token `RUN` is at the stash's **:185** — so the room's `§F:172-184` / `:183` citations match neither
  the stash (:185) nor HEAD (absent).
- VERIFIED — the stash is not docs-only; `git diff --stat HEAD stash@{0}` = 5 files, +160/−17:
  `TEAM_ROSTER.md` (47), `Composer.test.tsx` (3), `EffortSelector.tsx` (2), `team/CONTRACT_P2_STREAM.md` (40),
  `team/PHASES.md` (85 — boss-bot's §9, "the ownership seam is now 9 files"). None of these five appear in
  `git status` any more.
- VERIFIED (risk, not a claim about intent) — `git stash drop` / `git stash clear`, or a `git stash pop` that
  conflicts, destroys the only copy of M3's six-`ARG` text and of `team/PHASES.md` §9. Extract before anything
  touches the stash; the file is not a scratch pad, it is the sole carrier of an owed deliverable.
- VERIFIED (content of the two 1-line deltas, for the record) — the stashed `Composer.test.tsx` **removes**
  the `onToggleThinking: onToggle` override (`HEAD` has both `onToggle` and `onToggleThinking` wired to the spy);
  the stashed `EffortSelector.tsx` adds `console.log('PICK', …)` in `pick` (`:68`). Both look like Qa Verify's
  debug variant, i.e. **not** the Core Dev fix (`renderComposer({ thinking:'xhigh', onToggleThinking: onToggle })`).
  Read them before reusing the stash.

## G. Probe reliability right now: a FAIL is not attributable to the marker (live, single vantage)

- VERIFIED (measurements) — `curl -s --max-time 12` on **both** loop-gpt paths, interleaved with controls:
  - `https://loop-gpt.cyou/api/version` → `HTTP=000 t=12.012s`, `HTTP=000 t=12.024s` (2 consecutive timeouts);
    earlier in the same session: `HTTP=200` at 10.73s and 9.27s, and `HTTP=200` at 1.09s at 00:41Z.
  - `https://loop-gpt.cyou/version.json` → `HTTP=000 t=12.017s`, then `HTTP=200 t=7.193s` (earlier 0.75s).
  - control `https://example.com` → 2.12s / 10.09s / 8.07s; `https://api.github.com` → 12s timeout, then 3.94s.
- VERIFIED — `Cache-Control: no-store` **is** present on `/version.json` live
  (`curl -s -D-` → `HTTP/1.1 200 OK`, `Cache-Control: no-store`, `Content-Type: application/json`,
  `etag: "6ab9a4e8-4b"`), so a stale cached marker is ruled out as an explanation for `revision:"unknown"`.
- UNVERIFIED (attribution) — whether the `/api/version` timeouts are backend latency or my local egress.
  Egress is demonstrably degraded (a static host took 10.1s; GitHub timed out once), **but** the same-origin
  `/version.json` returned 200 in 7.2s on the try where `/api/version` timed out at 12.0s, which points at the
  nginx→backend leg rather than the network. Needs a second vantage to settle.
- Consequence — M1's acceptance probe must be pinned: run it with `--retry`/a raised `--max-time`, and include
  a control URL so a red result is not misread as a marker failure.

## H. Dry-run of the §F six-`ARG` `RUN` line (node v22.23.2) — it resolves exactly as specified

Executed the stashed line verbatim on this host, three ways:

```
$ node -e "<§F line>" "$SHA_A" "" "$SHA_B" "" "" ""
  GIT_REVISION=A, #3=B            → revision = A            (candidate #1 wins, as specified)
$ node -e "<§F line>" "" "" "$SHA_B" "" "" ""
  only #3 set (the §F:164 trap)   → revision = B            (trap closed by the chain)
$ node -e "<§F line>" "" "" "" "" "" ""
  none set                        → revision = "unknown"    (never a guess)
```

→ `process.argv.slice(1)` is the correct offset for `node -e` with trailing args, the trim-then-first-non-empty
order is right, and the fallback string is right. **M3 is safe to ship as written** — the text is proven, it
only has to be taken out of the stash first (§F above).

---

## I. Re-probe 2026-09-28T10:05Z: `builtAt` and the file's own `Last-Modified` disagree by 4h23m

Second live pass, after `e9f4b52` (`docs(team): PHASES 11.6 — web /version.json rebuilt and still 'unknown'`).
Raw, verbatim:

```
$ curl -s -o vj.txt -w 'HTTP=%{http_code} bytes=%{size_download} t=%{time_total}s\n' https://loop-gpt.cyou/version.json
HTTP=200 bytes=75 t=2.232349s
$ cat vj.txt
{"surface":"web","revision":"unknown","builtAt":"2026-09-27T23:21:12.630Z"}
$ curl -sI https://loop-gpt.cyou/version.json
HTTP/1.1 200 OK
Cache-Control: no-store
Content-Type: application/json
etag: "6ab9e2a5-4b"
last-modified: Mon, 28 Sep 2026 03:44:37 GMT
Content-Length: 75
Server: railway-hikari
x-hikari-trace: ams1.b55h
```

- VERIFIED — `builtAt` is **unchanged** from the 00:41Z probe (`23:21:12.630Z`) — the served body is byte-identical.
- VERIFIED — the `Last-Modified` moved to `03:44:37Z`, i.e. **4h23m 25s after** the body's own `builtAt`.
- VERIFIED — `etag` moved `"6ab9a4e8-4b"` → `"6ab9e2a5-4b"`; size stayed `75` (content unchanged; the etag here tracks inode/mtime, not bytes — `-4b` = 75 decimal).
- VERIFIED — `Cache-Control: no-store` is still served on this path, and the path is reached through
  `web/nginx.template.conf:13` (`~^/version\.json$ "no-store";`), so the mismatch is **not** an edge cache.

**Consequence (new, and it changes the M1 acceptance probe):** a served file whose mtime is 4h23m newer than the
timestamp inside it means *neither* field alone dates the deploy. The 03:44 rebuild almost certainly re-used the
cached `RUN` layer at `web/Dockerfile:31` (same build-arg value `""` → same cache key → the `node -e` never
re-ran, so `builtAt` is frozen at the first build), and the runtime `COPY --from=build` refreshed the mtime.

- Rule for the gate: after setting `GIT_REVISION`, **assert `revision == <SHA>`**, not `builtAt > deploy_time`
  and not mtime. `builtAt` only advances when the `ARG` value changes and the cache key busts; a *correct*
  build can therefore still show a stale `builtAt`. A pass condition on `builtAt` would fail a good deploy.
- Rule for the revert check: a `GIT_REVISION` of `""` yields `"unknown"` (proven in §H), so `unknown` is the
  honest negative result, not a broken marker — the two must not be confused when reading a red probe.
- UNVERIFIED (from here) — whether the 03:44 build was a BuildKit cache hit; that is the most economical
  explanation of the frozen `builtAt`, but it needs the Railway build log (owner `ops-release`) to be a fact
  rather than a reading.

### I.1 Same pass, repository-side residues — the count in the room is 10, the tree says 24

```
$ git status --porcelain | grep -c '^??'
24
```

Untracked, verbatim: `frontend/_final2.py _final3.py _final4.py _fix.py _fix2.py _fix3.py _fix4.py _fix5.py`,
`frontend/axe-results.json`, `frontend/login.html`, `frontend/tests/_H.bin _per.cjs _probe-admin.mjs
_probe-cc.mjs _report.cjs _run.py _run2.py _run3.py _run4.py _run5.py axe-sweep.mjs`, `p3.js`, `p5.js`,
**`team/A11Y_AXE.md`**.

- VERIFIED — the residue is **24** untracked paths, not 10 (`grep -c '^??'`). Two of them are not scratch:
  `team/A11Y_AXE.md` (a `team/` deliverable) and `frontend/tests/axe-sweep.mjs` + `frontend/tests/_report.cjs`
  (an a11y harness). A blanket `git clean -fd` deletes the deliverable.
- VERIFIED — `git log -1` at this pass is `e9f4b52`, i.e. **HEAD moved past `0d5d767`** (the roster rev-4
  commit named in the room) since the roster claim was made.

