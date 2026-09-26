# P1 FINDINGS — raw probes taken while driving P1 (owner: boss-bot)

Time: 2026-09-26. Frozen revision `7540a3d`. Nothing here is inferred; each line is a command and its
raw output. Items with a fix have an owner.

## F1 — the live `/chat/` bundle is not a build of HEAD (deploy gap)

```
$ curl -s https://loop-gpt.cyou/chat/ | grep -oE '_next/static/chunks/[A-Za-z0-9_./-]+\.js' | sort -u   → 18 names
$ rm -rf frontend/out frontend/.next && (cd frontend && npm run build)  → BUILD_EXIT=0, 19 routes
$ find frontend/out/_next/static/chunks -name '*.js' | wc -l                                            → 114
```
Set-diff: **8 of 18 served names are absent from the build**, including the runtime itself —
`served webpack-12ed1796ffdc89d3.js` vs `built webpack-bfdd25fdbe871018.js` — and same-module-id
collisions with different content hashes (`2631-7754d38b30959869.js` vs `2631-0c0b19adc4c4a71b.js`,
`3452-c378463bd237c50e.js` vs `3452-89f59a52a39385fe.js`,
`app/layout-a7c7cf45c3f55274.js` vs `app/layout-4b219603817a6a76.js`).

Nuance, for honesty: the served chat chunk (`app/chat/page-4ad1d24a9176ae82.js`, 214,400 B) **does**
contain the P0 strings (`ttsEngine` 1×, `hands-free` 1×, `Appearance` 1×) — so the live build is
*close to* P0, not older than it. What is unproven is that live == the frozen revision. **Owner:
`ops-release`** — deploy, then the served-vs-built set-diff must be equal.

## F2 — no served-revision read-back exists

```
$ curl -s -o /dev/null -w '%{http_code}\n' https://loop-gpt.cyou/api/version                          → 404
$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
      https://api.loop-gpt.cyou/api/version                                                            → 404 text/html 150
$ curl -s -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' \
      https://api.loop-gpt.cyou/health                                                                 → 200 text/html 27285   # the WEB page
$ grep -rn "healthz" backend/src --include=*.ts                                                         → no match
```
- `web/nginx.template.conf:32` → `location = /healthz { access_log off; default_type text/plain; return 200 "owned-web\n"; }`
  — the live health check is a **static string**; it proves nginx, not the app or the revision.
- `backend/src/server.ts:171` → `app.get('/health')` returns JSON, but nginx proxies only
  `^/api(?:/|$)` and `^/v1/`, so on the API origin `/health` falls through to `location /` and returns
  the static export's `index.html`. **A monitor there is green with the API dead.**
**Owner: `core-dev`** (`GET /api/version`), hand-off to `ops-release` (vhost).

## F3 — the authed TTS path is unverified live; one cold-start gateway timeout

```
$ POST https://api.loop-gpt.cyou/api/tts  {"text":"hello"}   (no auth)
   attempt 1: HTTP=504  time=20.x  (first hit after idle — cold start)
   attempt 2: HTTP=401  time=0.849
$ POST … with `Authorization: Bearer bogus.token.x`            → {"error":"Invalid token"}  HTTP=401 0.876s
$ GET  https://api.loop-gpt.cyou/api/models/catalog          → HTTP=200 0.879s   (gateway healthy)
$ GET  https://api.loop-gpt.cyou/api/definitely-not-a-route  → HTTP=404 0.825s
```
The route exists and gates on auth in <0.9 s. The **authed** path — the one that calls the TTS upstream —
cannot be probed without a token, and the P0 client points at `HF_TTS_ENDPOINT_URL`/HF inference. The
in-flight rewrite of `backend/src/routes/tts.ts` (working tree, `+106/−31`, Kokoro Space via
`/gradio_api/call` because "HF's Inference Providers dropped TTS platform-wide") is the right cure and is
already in progress. **Owner: `core-dev`.** Evidence needed: one real `POST /api/tts` with a token
returning audio bytes + `Content-Type`, and the byte count.

## F4 — docs commits were unpushed

`git status -sb` → `ahead 2` (`30ce162`, `5a74833`). **Fixed:** pushed as `c925c3a`
(`7540a3d..c925c3a release/owned-staging-20260917`), then `## …origin/…` with no ahead marker.
