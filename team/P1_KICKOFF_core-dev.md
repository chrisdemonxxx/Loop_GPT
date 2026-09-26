# P1 KICKOFF — core-dev (owner: the served-revision instrument)

**Deliverable: `GET /api/version` → `{ sha, builtAt, env }`, plus the tests, on `backend/`.**

Why it exists: `team/P0_CLOSEOUT.md` §3b — three raw probes show nothing anywhere can report what the live
host is actually running.

```
curl -s -o /dev/null -w '%{http_code}\n' https://loop-gpt.cyou/api/version        → 404
curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
     https://api.loop-gpt.cyou/api/version                                        → 404 text/html 150
curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
     https://api.loop-gpt.cyou/health                                             → 200 text/html 27285   # the WEB page
```

The backend already serves `app.get('/health')` at `backend/src/server.ts:171` → `{status:'ok',timestamp}`,
but nginx (`web/nginx.template.conf:40`, `location ~ ^/api(?:/|$)`) only proxies under `/api` and `/v1`,
so `/health` on the API origin falls through to `location /` and returns the static export's `index.html` —
HTTP 200, no JSON, a false-green. **A monitor that can be green while the API is dead is not a monitor.**

Acceptance:
- `GET /api/version` under the existing `/api` prefix → `{ sha: <full 40-hex>, builtAt: <ISO8601>, env: <NODE_ENV> }`;
  `sha` sourced from a build-time env (`GIT_SHA`/`RAILWAY_GIT_COMMIT_SHA`), falling back to `'unknown'` —
  never invented, and never a value the caller can forge from a query param.
- unit test asserting the shape and the 40-hex-or-`unknown` rule; `cd backend && npx tsc --noEmit` = 0 and
  the backend suite green (paste the test count).
- a one-line hand-off to `ops-release`, who owns `web/nginx.template.conf:32` — the live `/healthz` is
  currently `return 200 "owned-web\n"`, a static string. You own the route; they own the vhost. Do not
  both edit the same file.

Second, smaller item if you have room (backend-only, no UI): the audit log is container-local because
`AGENT_DATA_DIR` is unset in prod (`team/RELEASE_BASELINE.md` §28) — it resets on every deploy. Confirm
the path resolution and hand `ops-release` the exact variable to set.

**Do not touch `frontend/app/chat/hooks.ts`** — it has one owner (`ui-visual`) and a prior two-writer
history. Hand changes across in the room in one line.
