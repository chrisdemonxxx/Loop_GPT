# P1 KICKOFF — ops-release (owner: release + the deploy itself)

Baseline: `team/RELEASE_BASELINE.md` (6,554 B, sha256 `79a26de9…`) — yours, keep it.

**Deliverable: `team/RELEASE_P1.md`** — one raw line of evidence per item. Six baseline items
(`#1`–`#6`) plus the two new ones below.

**NEW, and the highest-value line on this sheet: the live host is stale.** Evidence (`team/P0_CLOSEOUT.md` §3):
`/chat/` serves 18 chunk names, **8 of which are absent** from a fresh `npm run build` of HEAD, and the
webpack runtime hash differs outright (`served webpack-12ed1796ffdc89d3.js` vs `built webpack-bfdd25fdbe871018.js`).
So the served bundle is **not** a build of HEAD. Close it with:
1. deploy `7540a3d` (or the post-P1 HEAD) on Railway project `loop-gpt-owned-staging-20260917` / env `production`;
2. **prove it** with the read-back — served chunk set == built chunk set:
   `curl -s https://loop-gpt.cyou/chat/ | grep -oE '_next/static/chunks/[A-Za-z0-9_./-]+\.js' | sort -u`
   vs `ls frontend/out/_next/static/chunks/**/*.js`. Equal sets ⇒ served == built. `#6` in your baseline is
   the procedure; today the sets are **not** equal.
3. tag it.

**NEW #2 — the health check is a lie and the revision is unreadable** (three raw probes, §E12):
- `web/nginx.template.conf:32` → `location = /healthz { return 200 "owned-web\n"; }` — a static string.
  It proves nginx, not the app. A monitor on it stays green with the backend dead.
- `https://api.loop-gpt.cyou/health` → `200 text/html 27285` — the **web** `index.html`, because nginx
  only proxies `^/api(?:/|$)` and `^/v1/`; the backend's `app.get('/health')` (`backend/src/server.ts:171`)
  is unreachable from the API origin's root path.
- `https://loop-gpt.cyou/api/version` → `404`. Nothing anywhere exposes a build SHA.

Fix lands with `core-dev` (`GET /api/version`). Your job: after it ships, make `/healthz` return the SHA
(proxy to the backend or embed it in the static body) and **read the served revision back** into your report.
Own one file at a time — `web/nginx.template.conf` is yours; hand the route to `core-dev`.

Carry-overs to close or explicitly freeze, with the probe line each: DB-restore footer
(`docs/RUNBOOK.md:144` says pending; PROGRESS says 33/33 tables restored — **coordinate the footer edit with
the RUNBOOK's owner**), Stripe freeze-vs-go-live (prod carries no `STRIPE_SECRET_KEY`), Figma OAuth live
smoke, deliberate-error observability (already closed — re-paste the 200s), uptime probe.
Also still open from your baseline: `AGENT_DATA_DIR` unset ⇒ the tool audit log dies on each deploy.

Report the Railway deployment id + the read-back, not the deploy log.
