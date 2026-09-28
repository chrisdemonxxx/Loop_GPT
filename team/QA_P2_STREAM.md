# QA — CONTRACT_P2_STREAM (web served marker, §F)

**Pinned revision:** `a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37`
(`a4b29bb feat(web): served-revision marker at /version.json (contract §F) + no-store map entry`)

Byte-pinned artifacts under test:

| file | bytes | sha256 |
|---|---|---|
| `web/Dockerfile` | 4396 | `d7fa118c04ac7bf0168b3722563ad08ea11a397f5e6e262ab122020de03b05ea` |
| `web/nginx.template.conf` | 4999 | `bb4e8753060bcb44b06499bf792008a9fee59bb6905cf7ad5a7bb45c8c8ab46a` |

§A (effort union) lives in the working tree at the same HEAD:
`frontend/app/components/chat/{Composer,types,page,hooks,stream}` + `components/chat/__tests__/Composer.test.tsx` modified,
`components/chat/composer/EffortSelector.tsx` untracked (plus the `_fix*.py` scratchers).

## Raw probes (2026-09-27T23:47Z, `loop-gpt.cyou`)

```
$ curl -sS -i https://loop-gpt.cyou/version.json
HTTP/1.1 200 OK
Accept-Ranges: bytes
Cache-Control: no-store
content-security-policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
Content-Type: application/json
etag: "6ab9a4e8-4b"
last-modified: Sun, 27 Sep 2026 23:21:12 GMT
Content-Length: 75
Server: railway-hikari
x-railway-edge: sin1
{"surface":"web","revision":"unknown","builtAt":"2026-09-27T23:21:12.630Z"}

$ curl -sS https://loop-gpt.cyou/api/version
{"service":"loop-gpt-backend","revision":"a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37","startedAt":"2026-09-27T23:19:54.262Z","node":"v22.23.2"}

$ git rev-parse HEAD   # == a4b29bbaaf1349c694b54c0efe9e1140a8bb9d37
```

etag `-4b` = 75 bytes = the JSON. All five `add_header`s + `Server: railway-hikari` on the one path — map entry confirmed, no `add_header`-in-location header swap.

**Probe trap, live (the §F:164 trap):** `location /` (`nginx.template.conf:110`)
`try_files $uri $uri/ /index.html` 200s text/html for any missing path:

```
$ curl -sS -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' https://loop-gpt.cyou/qa-fallback-7f3a
200 text/html ~8-11K   # index.html, not 404 — status-only probe passes on a page

$ curl -sS -o /dev/null -w '%{http_code} %{content_type} %{size_download}\n' 'https://loop-gpt.cyou/version.json.bak'
200 text/html ~8K      # dotfile rule (^|/)\. has no path-boundary dot; same fallback
```

So the acceptance line is **RED right now**: `/api/version` says
`a4b29bba...`, `/version.json` sayss `unknown`, because the web service has no
`GIT_REVISION` variable — `web/Dockerfile:31` does the 5th-of-5 fallback
(`r||'unknown'`) from `$GIT_REVISION` declared at `:15`.

## Verdict

| | |
|---|---|
| §F map entry `nginx.template.conf:13` | ✅ confirmed live |
| no-store + CSP + 4 siblings on one path | ✅ confirmed live |
| producer `Dockerfile:15/31` = `r\|\|'unknown'` | ✅ read the bytes |
| **§F:152 4-var fallback chain NOT in the web producer** | ❌ `Dockerfile:31` is one ARG; backend `routes/version.ts:21-27` has the full 6 (`GIT_REVISION→BUILD_REVISION→RAILWAY_GIT_COMMIT_SHA→GIT_SHA→SOURCE_VERSION→HEROKU_SLUG_COMMIT`) |
| live evidence of the miss | ✅ backend `a4b29bba...` vs web `unknown` in the same probe run |

## Fix for the seam (≈3 lines, `web/Dockerfile` build stage)

```dockerfile
# after ARG GIT_REVISION=""  (Dockerfile:15)
ARG RAILWAY_GIT_COMMIT_SHA=""
ARG GIT_SHA=""
ARG SOURCE_VERSION=""
```

```dockerfile
# replace Dockerfile:31
RUN node -e "const fs=require('fs');const v=[process.argv[1],process.argv[2],process.argv[3],process.argv[4]].map(x=>(x||'').trim());const r=v.find(x=>x.length>0)||'unknown';fs.writeFileSync('out/version.json',JSON.stringify({surface:'web',revision:r,builtAt:new Date().toISOString()}))\"" "$RAILWAY_GIT_COMMIT_SHA" "$GIT_SHA" "$SOURCE_VERSION" "$GIT_REVISION"
```

Same shape as the backend's candidate list (comment at `routes/version.ts:22`
says it's the same rule core-dev used there), same `"unknown"` token.

Plus the web service variable (arch's part):

```
railway variable set web GIT_REVISION '${{RAILWAY_GIT_COMMIT_SHA}}'   # or set via `railway variables set -s web`
```

Rebuild the web service → re-probe: all three should read `a4b29bba...` /
the next dep's SHA. Note the web chain has no `BUILD_REVISION`/`HEROKU_SLUG_COMMIT` —
backend-only extras, matches the §F:152 four exactly.
