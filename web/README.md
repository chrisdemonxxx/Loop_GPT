# Loop owned web/PWA foundation

An independently runnable Vite + React + TypeScript client for the existing Loop
backend. All source, tooling and validation in this change live in `web/`.
This is a foundation slice, **not completion of the full product or production
qualification**. The shared build ledger remains authoritative about backend work.

## Implemented

- Email/password login against the existing account endpoint. Bearer JWTs stay in
  React memory. Local logout aborts outstanding requests and clears the authenticated
  view. A current authenticated 401 returns to login. Reload, page exit and tab
  closure require signing in again; there is no remember-me or refresh-token flow.
- Paginated workspace selection, owner/editor/viewer display, explicit personal
  workspace provisioning, refresh, and read-only viewer behavior. Personal writable
  membership is the default, followed by another writable membership, then a viewer.
- Hosted conversations using the real POST SSE contract. Chat is the default and
  disables tools. Agent/research are explicit choices using existing reviewed
  backend tools. No connections are implicitly selected. New conversations obtain
  the server ID from the first status event and reuse it for subsequent turns.
- Streaming UTF-8 and CR/LF/CRLF parsing, multiline SSE data, authoritative final
  replacement, intermediate tool-step handling, generic progress, protocol/error/EOF
  detection, and cancellation. Stop disconnects the request. Workspace changes and
  logout also abort; late events cannot repopulate the previous view.
- Generated artifact downloads through authenticated bytes, validated file IDs,
  bounded bodies, sanitized names and temporary octet-stream object URLs. URLs
  supplied by model output are ignored. No inline HTML/SVG/media previews.
- On-demand, read-only developer API balance and 30-day usage overview. This is
  account-wide API usage, not the hosted chat-credit balance. No API key writes,
  preview-credit grants, payment flows, provider settings or credential collection.
- Seven locale choices: `en-US`, `en-GB`, `en-CA`, `fr-CA`, `en-AU`, `en-NZ`,
  `en-IE`. Complete French Canadian UI copy; English regions intentionally share
  wording. `Intl.NumberFormat` uses the exact selected locale, including USD
  formatting. User/model/workspace content is not translated. Language comes from
  a valid saved preference, then browser language priority, then `en-US`; other
  French variants fall back to `fr-CA`, other English variants to `en-US`.
- Responsive phone/desktop layout, safe-area padding, dynamic viewport sizing,
  16px form controls, 44px minimum button targets, keyboard focus, skip link,
  labelled inputs, live progress/error announcements, and plain-text message
  rendering. Enter creates a newline in the composer; Send submits explicitly.
- Install manifest, generated PNG icons (192/512px and 180px Apple touch icon), and
  a build-generated app-shell-only service worker.

## Exact local setup

Run commands from `C:/Users/chris/Desktop/Workspace/dev-projects/loop-gpt/web`
(or your checkout's `web/`). Node **22.12+** is required; local validation used
Node **24.18.0** and npm **12.0.2**.

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The default development proxy forwards `/api/*` to
`http://127.0.0.1:3001`. A real backend must already be running there with its
database/migrations, an existing account, and hosted model/credit configuration.
This module does not start, configure, seed, migrate or replace that backend.
There are no production fixtures or demo-login fallback screens.

### API configuration

Only two public configuration values are read. Optional examples are in
`.env.example`; create **web/.env.local** yourself if needed. Never place JWTs,
passwords, provider keys or database credentials in Vite configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_ORIGIN` | empty | Browser API origin, compiled at build time. Empty uses same-origin `/api`. Otherwise an absolute HTTPS origin, e.g. `https://api.example.com`, with no path/query/fragment/userinfo. HTTP is accepted only for exact localhost/loopback development hosts. |
| `WEB_DEV_API_ORIGIN` | `http://127.0.0.1:3001` | Target for the local Vite development/preview `/api` proxy. Same origin-only validation. Never bundled into the browser. |

Development with a different local backend port (PowerShell):

```powershell
$env:WEB_DEV_API_ORIGIN = 'http://127.0.0.1:3002'
npm run dev
```

Build for a separately hosted API (public example origin; substitute yours):

```powershell
$env:VITE_API_ORIGIN = 'https://api.example.com'
npm run build
```

To return to same-origin configuration, set `$env:VITE_API_ORIGIN = ''` before the
next build. Changes require restarting Vite/rebuilding. Invalid configuration
fails the build; the runtime also disables login rather than silently selecting a
different origin.

The backend's `FRONTEND_URL` is a comma-separated exact-origin allowlist. For
direct cross-origin requests, the backend operator must **add** this new client's
origin to their existing allowlist (including the exact scheme and port) and
permit the Authorization/Content-Type preflight. Retain existing gateway/mobile
origins. This implementation has made no changes to server environment settings.
Vite's proxy is same-origin from the browser's perspective; production static
hosting does not provide that proxy automatically.

### Production artifact / PWA preview

```powershell
npm run build
npm run preview
```

Preview runs at `http://127.0.0.1:4173`; it includes a local `/api` proxy for
development verification only. `dist/` contains the complete static application.
Serve it at the **root of a new dedicated origin** over HTTPS. This build is not
subpath-configurable. Do not mount its `/` service-worker scope over the existing
gateway or another deployed app. Same-origin production mode requires your new
host to proxy `/api/*` to the existing backend before any SPA fallback. Preserve
POST bodies, Authorization headers, streaming chunks and disconnects; disable
proxy buffering and API caching. Direct API-origin mode instead requires CORS.

Serve `sw.js` and HTML with revalidation (`Cache-Control: no-cache`), JavaScript
with its proper MIME type, and the manifest as `application/manifest+json`.
Hashed `/assets/*` may be public immutable assets. Never apply a CDN cache rule to
`/api/*`. Proxy timeouts must accommodate the server's streamed responses.
Only deploy the static `dist/` output, not development sources or local env files.

On iPhone, visit the dedicated HTTPS origin in Safari, then Share → Add to Home
Screen. Native iOS/Safari install/download/keyboard/VoiceOver qualification is
still required. The browser tests here use Chromium phone-size emulation, not an
iOS device. No programmatic install prompt is provided.

## Endpoint contract consumed

| Method/path | Request / consumed response |
| --- | --- |
| `POST /api/auth/login` | `{email,password}` → `{token,user:{name,email}}` |
| `GET /api/workspaces[?after=cursor]` | bearer JWT → `{workspaces:[{id,name,role,personalOwnerId}],nextCursor}`; reads successive pages |
| `POST /api/workspaces/personal` | bearer JWT, `{}`; only on the explicit provisioning button, then reload memberships |
| `POST /api/agent/new/stream` | bearer JWT, `{content,workspaceId,mode,connectionIds:[]}`; `toolNames:[]` additionally in chat mode |
| `POST /api/agent/:id/stream` | same body; reuse the returned conversation ID |
| `GET /api/files/:uuid/content` | bearer JWT → bytes, up to 50 MiB |
| `GET /api/developer/overview` | bearer JWT → balanceUsd and usage requests/spendUsd/tokensIn/tokensOut; ignored metadata is not retained |

Stream events use `data: <JSON>` followed by a blank line. Consumed events are
`status` (`conversation:<id>`), `warming`, `delta` (`step`,`text`), `tool_call`,
`tool_result`, `artifact`, `final` (`content`), `error`, `done`. Tool arguments and
raw errors are not reflected into the interface. Unknown events are ignored;
malformed known events fail. `[DONE]` OpenAI framing belongs to a different
endpoint and is intentionally not accepted here. A final response is not reported
complete until `done`; `error` plus `done` is still a failure. EOF without `done`
is an interrupted stream. The UI does not retry billable POSTs automatically.

No client provider, key, URL or model override is sent. The backend chooses its
standard hosted target. Agent mode uses backend default built-ins; research uses
backend search/fetch defaults. Workspace roles are enforced by the server; the
client's viewer disablement is only user experience, not authorization.

Limits: 100,000 input characters; 1,000,000 displayed response characters;
2,000,000 characters per SSE frame; 8 MiB stream bytes; 2 MiB JSON responses;
100 artifacts; at most 101 workspace pages before rejecting further pagination.
Request deadlines: 30 seconds for login/metadata, 60 seconds for downloads,
10 minutes for a streamed turn. Large JSON/file reads fail closed and release
their readers. Server limits can be lower.

## Session, rendering and cache behavior

- JWT/passwords never enter localStorage, sessionStorage, IndexedDB, Cache Storage,
  URLs, telemetry or application logs. Only `loop.web.locale` is stored by the UI.
  The browser's user-controlled password manager is separate from app storage.
- API requests use `cache: no-store`, `credentials: omit`, `redirect: error`,
  `referrerPolicy: no-referrer`. Authentication travels only in a bearer header.
  Cross-origin redirects are not followed with credentials.
- The worker precaches an explicit build allowlist: HTML, manifest, icons, hashed
  JS/CSS. Installation fetches omit cookies. It never handles API paths, arbitrary
  navigation paths, cross-origin requests, non-GETs, query-bearing requests, or
  requests with Authorization headers. **There is no runtime response caching**.
  Cache cleanup affects only this module's `loop-owned-shell-*` caches.
- Offline startup loads the public shell and locale. No offline message history,
  credentials, downloads, queues, background sync or authenticated data caches.
  An already-open tab may still display its in-memory messages when connectivity
  drops; reloading clears them and requires a fresh online login.
- Updates wait for the old worker's clients to close rather than forcibly swapping
  bundles mid-conversation. Reopen the app to activate the waiting update. Offline
  availability begins only after one successful online shell installation.
- Model content is React text, with no HTML, Markdown link activation or remote
  images. Artifact downloads use validated UUID paths rather than response URLs.
  Object URLs are revoked after 30 seconds or authenticated-view teardown.
  Files intentionally saved by the user remain in the browser/OS Downloads folder.

## Genuine boundaries and remaining work

- The current backend issues 7-day JWTs but has **no logout/revocation endpoint**.
  Local sign-out cannot invalidate a copied token server-side. Backend session
  hardening, refresh/revocation and account recovery remain separate work.
- Only the active conversation is held in this client. Workspace changes, New
  conversation and reload clear its view. Server-side records can remain. The
  existing conversation-list API omits workspace IDs and legacy history/file
  routes have incomplete workspace lifecycle enforcement. Workspace-filtered
  history/reopening/search/delete and cross-device sync are not implemented here.
- Stop aborts the fetch; the backend observes response disconnect and propagates
  cancellation. A saved user turn, partial assistant message or usage may remain.
  There is no durable cancellation ID, rollback, idempotent retry or claim that
  already-issued tools/charges were undone. In an early connection failure before
  the status ID arrives, a subsequent send starts a new conversation.
- Private-file backend access is owner-scoped, not fully workspace-revocation-aware.
  This client exposes only artifacts received in the current run. No uploads,
  file browser, rich previews, vision input, media-job UI or object storage.
- No Canvas, project retrieval/indexing, code editing, repository integration,
  terminal, managed sandbox, durable jobs, organization invitations, reusable agent
  builder, connectors/OAuth/MCP configuration, private skill learning, API-key
  management, checkout, native Expo/iOS implementation or full API console.
- The shared `../docs/BUILD_PROGRESS.md` ledger identifies production gates:
  incomplete metering/reservations, session protections, workspace lifecycle,
  provider qualification, durable execution/storage and dependency review beyond
  this module. This frontend does not close those backend gates.
- Functional use needs a reachable configured backend, working hosted provider,
  account, workspace membership, credits and matching origins. Live backend/user
  APIs and provider services were deliberately not called during this work.
  Browser fixtures validate wiring, not live provider reliability or billing.

## Verification

```powershell
npm run build
npm test
npm audit
```

Optional browser suite, entirely against intercepted fixture APIs and a local
production-build preview (no backend needed). Browser binaries and results stay
under `web/` with these commands:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD/.cache/ms-playwright"
npx playwright install chromium
npm run build
npm run test:browser
```

POSIX equivalent for that suite:

```sh
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright"
npx playwright install chromium
npm run build
npm run test:browser
```

The test server uses its own port `4179`, refuses to reuse another process, and
exits when Playwright finishes. Its unused proxy points to loopback port 9; all
API requests are intercepted with fixtures. Nonlocal browser page requests are
aborted. Screenshots go to ignored `test-results/`; traces are retained on failures.
Successful screenshots were inspected at desktop and 390px phone widths.

Validation results and exact source manifest: [VALIDATION.md](VALIDATION.md).
