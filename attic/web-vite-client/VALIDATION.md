# Web foundation validation

## Independent local rerun — 2026-09-17

Working directory: `C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/web`.
Node `v24.18.0`, npm `12.0.2`; repository HEAD
`c6b20263423b8ab4d5c14c0f13900c7b91953c0e` with existing uncommitted/concurrent work.
Existing `node_modules/` and documented `.cache/ms-playwright` were present.

Exact PowerShell invocations:

```powershell
Test-Path -LiteralPath '.'; if ($?) { npm run build }
npm test
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/ms-playwright"; if (Test-Path -LiteralPath $env:PLAYWRIGHT_BROWSERS_PATH) { npm run test:browser } else { throw 'Documented browser cache is missing' }
```

All completed successfully:

- Build: TypeScript check and Vite `8.3.0` production build passed, 21 modules,
  178 ms. CSS `index-BnWsX9Kx.css`: 5.69 kB (gzip 1.93 kB);
  JS `index-BlRxKDJb.js`: 245.52 kB (gzip 77.53 kB).
- Vitest `5.0.1`: **5 files, 94 tests passed**, duration 1000 ms.
  `stream.test.ts`: 22; `api.test.ts`: 17; `pwa.test.ts`: 16;
  `security.test.ts`: 30; `App.test.tsx`: 9.
- Playwright: **4 tests passed**, 4 workers, 2.3 s. Both desktop Chromium
  (1280x900) and phone-layout Chromium (390x844) passed login/stream/authenticated
  download/developer usage/locale/logout and service-worker shell-only caching /
  offline reload tests. APIs were intercepted fixtures; preview used port 4179.

Post-run `Get-NetTCPConnection -LocalPort 4179 -State Listen -ErrorAction
SilentlyContinue` returned no listeners: Playwright preview cleanup confirmed.
Generated `dist/` and `test-results/`, installed dependencies and browser cache
remain in their documented ignored locations. No install or audit rerun was needed
for this requested validation. No screenshots were visually reviewed in this rerun.

No local build or automated-test defects found. The isolated packaging smoke also
passed; image IDs/digests and container/volume cleanup are recorded in
`../deploy/owned-staging/VALIDATION.md`. Only these two validation documents were
edited; source/schema/client and the backend full suite were left to the main task.

## Earlier foundation evidence — 2026-09-16

Local validation: 2026-09-16, Windows, Node 24.18.0, npm 12.0.2.
All implementation edits are in the newly added `web/` directory. Existing
uncommitted repository work was present at the start of this task. No backend,
gateway, deployed frontend, mobile, schema or shared documentation was edited.
No commit, push, deployment, real-user API call or live model request was made.

## Final commands and results

`npm run build` — exit 0, TypeScript check and production bundle succeeded:

```text
vite v8.3.0 building client environment for production...
✓ 21 modules transformed.
dist/index.html                   0.83 kB │ gzip:  0.41 kB
dist/apple-touch-icon.png         1.00 kB
dist/icon-192.png                 1.08 kB
dist/sw.js                        1.53 kB
dist/icon-512.png                 4.19 kB
dist/assets/index-BnWsX9Kx.css    5.69 kB │ gzip:  1.93 kB
dist/assets/index-BlRxKDJb.js   245.52 kB │ gzip: 77.53 kB
✓ built in 107ms
```

`npm test` — exit 0 (ANSI formatting removed):

```text
RUN v5.0.1 C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/web
✓ tests/api.test.ts (17 tests) 28ms
✓ tests/pwa.test.ts (16 tests) 29ms
✓ tests/stream.test.ts (22 tests) 28ms
✓ tests/security.test.ts (30 tests) 26ms
✓ tests/App.test.tsx (9 tests) 154ms

Test Files 5 passed (5)
Tests      94 passed (94)
Start at   18:57:01
Duration   648ms
```

`npm run test:browser`, with `PLAYWRIGHT_BROWSERS_PATH` pointing to
`web/.cache/ms-playwright` — exit 0:

```text
Running 4 tests using 4 workers
ok [desktop-chromium] installed PWA caches only shell and reloads offline without auth or messages (377ms)
ok [iphone-layout-chromium] installed PWA caches only shell and reloads offline without auth or messages (385ms)
ok [desktop-chromium] login, hosted stream, inert authenticated download, developer usage, locale and logout (642ms)
ok [iphone-layout-chromium] login, hosted stream, inert authenticated download, developer usage, locale and logout (751ms)
4 passed (1.7s)
```

`npm audit --json` — exit 0:

```json
{
  "vulnerabilities": {},
  "counts": { "info": 0, "low": 0, "moderate": 0, "high": 0, "critical": 0, "total": 0 },
  "dependencies": { "prod": 4, "dev": 136, "optional": 47, "peer": 0, "peerOptional": 0, "total": 139 }
}
```

Audit counts are a projection of npm's `metadata` output, not a code security
certification. Runtime direct dependencies are React and React DOM; Vite,
TypeScript, React tooling, Vitest, jsdom and Playwright are development dependencies.
`package-lock.json` fixes the resolved dependency graph.

## Evidence and test scope

- SSE: every-character framing splits; LF/CRLF/CR; comments; multiline data;
  split Unicode; final replacement; tool step changes; unknown events; malformed
  fields/JSON; unexpected EOF; error-then-done; aborting stalled readers; size caps.
- API: exact login/stream bodies, membership pagination/defaults/provisioning,
  bearer headers, request no-store/omit/redirect policies, private byte downloads,
  overview projection, HTTP errors, no automatic retries.
- UI: login/logout/401, no auth storage, late-event rejection after Stop or workspace
  changes, stale 401 after another login, read-only viewer gating, pagehide,
  French selection, safe React text rendering.
- Worker VM: exact shell allowlist, credential-free install fetches, API/auth/query/
  arbitrary URL bypass, no runtime writes, scoped cache cleanup, PNG dimensions.
- Real Chromium: production bundle at 1280×900 and 390×844 (touch/mobile emulation),
  native browser fetch, login/workspace/stream/download/overview/logout wiring,
  keyboard skip link, no horizontal overflow, 44px button targets, locale change,
  actual service-worker installation/Cache Storage inspection/offline reload.
  All API responses in these browser tests are intercepted fixtures; unexpected
  page API routes and external page requests are aborted. No backend is started.
- Desktop and phone screenshots were visually inspected. The browser run found
  and fixed a native-fetch receiver bug missed by mocked unit tests. Phone visual
  inspection found and fixed an offscreen skip-link screenshot artifact.

Current screenshot paths (ignored, locally generated):

```text
web/test-results/client-login-hosted-stream-b7e2d-per-usage-locale-and-logout-desktop-chromium/client.png
web/test-results/client-login-hosted-stream-b7e2d-per-usage-locale-and-logout-iphone-layout-chromium/client.png
```

## Genuine blockers / unverified work

No remaining local build or automated-test failure. Live end-to-end acceptance
requires an existing configured database-backed backend, test account/membership,
credits, hosted provider and origin configuration; real-user APIs were outside the
requested validation. Hardware iPhone/Safari install, download behavior, keyboard,
VoiceOver and full WCAG evaluation have not been certified by Chromium emulation.

Server-side JWT logout/revocation is absent. Workspace-filtered history is absent
from this client because the existing listing does not expose workspace identity;
legacy history/file lifecycle authorization still has backend gaps. Cancellation
is disconnect-based, not durable rollback. Metering/reservations, production auth,
provider qualification and the other release gates in `../docs/BUILD_PROGRESS.md`
remain. Canvas, retrieval, coding/sandboxes, durable jobs, connector management,
agent builder, private skills, full API console and native clients are not
implemented by this module. See README for the precise functional boundaries.

## Exact deliverable source manifest (28 files)

```text
web/.env.example
web/.gitignore
web/README.md
web/VALIDATION.md
web/build/pwa.ts
web/index.html
web/package-lock.json
web/package.json
web/playwright.config.ts
web/public/icon.svg
web/public/manifest.webmanifest
web/src/App.tsx
web/src/api.ts
web/src/i18n.ts
web/src/main.tsx
web/src/requests.ts
web/src/security.ts
web/src/stream.ts
web/src/styles.css
web/tests/App.test.tsx
web/tests/api.test.ts
web/tests/browser/client.spec.ts
web/tests/pwa.test.ts
web/tests/security.test.ts
web/tests/stream.test.ts
web/tsconfig.json
web/vite.config.ts
web/vitest.config.ts
```

Generated production output (ignored):

```text
web/dist/index.html
web/dist/manifest.webmanifest
web/dist/icon.svg
web/dist/icon-192.png
web/dist/icon-512.png
web/dist/apple-touch-icon.png
web/dist/sw.js
web/dist/assets/index-BnWsX9Kx.css
web/dist/assets/index-BlRxKDJb.js
```

Local dependency/browser/test artifacts are under ignored `web/node_modules/`,
`web/.cache/` and `web/test-results/`. These are generated installations/results,
not deliverable source. No `.env` or `.env.local` containing credentials was created.
