# Loop GPT

Loop GPT is a hosted chat product: a Next.js app, an Express API, and Postgres, all on Railway. The web app and the API share one public origin. The phone app is Expo and talks to the API host directly.

## Live architecture

`https://loop-gpt.cyou` is the product. The Railway `web` service builds `apps/web` (package `@loop/web`) and serves the static export. nginx on that service proxies `/api` and `/v1` to the `backend` service. `https://api.loop-gpt.cyou` is the same API for the Expo app and other clients that cannot use the same origin.

| Surface | URL | Served by |
|---|---|---|
| Product UI, same-origin API | https://loop-gpt.cyou | Railway `web` (`apps/web` static export; nginx proxies `/api`, `/v1`) |
| Aliases | https://app.loop-gpt.cyou, https://chat.loop-gpt.cyou, https://www.loop-gpt.cyou | same `web` service |
| API host | https://api.loop-gpt.cyou | `web` → `backend` |

The active Railway project is `loop-gpt-owned-staging-20260917`. Services: `web`, `backend` (Express, the agent runtime, and the settlement workers), and `postgres`. Deploy the API from the repo root with the backend service, and the UI with the web service. Database migrations are a separate step (`npx prisma migrate deploy`); do not rely on the API process to change the schema.

`NEXT_PUBLIC_API_URL` stays empty for the hosted UI so the browser calls `/api` on the same origin. Set it only when the API is on a different origin. The Expo app defaults to `https://api.loop-gpt.cyou` (`EXPO_PUBLIC_API_URL` overrides that).

## Model fleet routing (Auto)

The UI has no model picker — the backend fleet router (`backend/src/services/modelRouter/`) picks the deployment for every turn. Deterministic rules run first (research → flagship tier, image attachments → vision tier, heavy context/tools → flagship); a small fast router model ("JEV", e.g. a GLM-Flash deployment) arbitrates only the remaining ambiguous fast-tier turns and can never downgrade a rule's pick. Env: `ROUTER_ENDPOINT_URL`, `ROUTER_MODEL`, `ROUTER_API_KEY` (falls back to `HF_TOKEN`), `ROUTER_TIMEOUT_MS` — all optional; without them the rules alone decide.

Media turns are dispatched deterministically too (`MEDIA_DIRECT_DISPATCH=true`): `/image` and `/video` execute the pinned tool directly, and the router picks the deployment per use case — MiniMax-H3 for video (verified video-only: `t2av`/`i2av`), the image Space for images (`t2i`/`i2i`), HF providers as the last resort. Each assistant message carries an `auto · <tier>` chip (public tier label only; upstream identity stays hidden per the guardrails). See [docs/MEDIA_GENERATION.md](docs/MEDIA_GENERATION.md).

## Canvas previews

Model HTML is shown only inside an iframe with `sandbox="allow-scripts"` and no `allow-same-origin`. That gives the document an opaque origin, so a script in the preview cannot read the app's token.

Set `NEXT_PUBLIC_ARTIFACT_ORIGIN` to a separate origin when you want the preview to load there instead of `srcdoc`. The iframe's `src` is that origin. After it loads, the app posts `{ type: 'loop-artifact-html', html }` to it. The host page should write that HTML into the document. Leave the variable empty to keep the sandboxed `srcdoc` preview.

## Repo layout

- `apps/web` (`@loop/web`) — the product UI (Next.js static export).
- `backend/` — Express + Prisma API and the agent runtime.
- `packages/` — shared UI, API client, and contracts used by the web app.
- `mobile/` — Expo app (iOS and Android). It is not a Capacitor wrapper.
- `docs/` — runbooks and validation notes for the owned platform.

Older LibreChat and gateway notes in `deploy/` describe a previous topology. They are not what `loop-gpt.cyou` serves now.

The nested `Loop-it/` tree is a separate toolchain: pnpm workspaces and uv, while this root uses npm workspaces. Package-manager unification, the Loop-it admin port, and retirement of `@loopit/ui-kit`, `Loop-it/apps/web`, and `Loop-it/apps/console-mobile` are tracked in [deploy/loopit/README.md](deploy/loopit/README.md).

## Local web app

```bash
npm install
npm run dev -w @loop/web
```

The dev server expects the API at `NEXT_PUBLIC_API_URL` (see `apps/web/.env.example`). Unit tests: `npm test`. End-to-end tests need a production export in `apps/web/out` and Playwright: `npm run test:browser -w @loop/web`.

## Load test

`backend/scripts/loadtest.mjs` hits chat streaming (`POST /api/agent/:id/stream`) and billing (`GET /api/billing/config` and `POST /api/billing/checkout`) with Node's built-in `fetch`. It has no credentials in the file. Streams are aborted after a few seconds; checkout can open a Stripe session and does not capture a payment.

Against staging (not production):

```bash
$env:LOOP_LOADTEST_BASE_URL = "https://<staging-host>"
$env:LOOP_LOADTEST_TOKEN = "<session token from a staging account>"
$env:LOOP_LOADTEST_CONVERSATION_ID = "<conversation id owned by that account>"
node backend/scripts/loadtest.mjs --concurrency 20 --requests 40 --allow-remote
```

Omit `LOOP_LOADTEST_TOKEN` to measure unauthenticated responses only. Loopback does not need `--allow-remote`. A non-zero exit means the client could not reach the server, or a request returned HTTP 500. 401s and a 503 from billing (payments not enabled) are counted in the JSON report and do not fail the run.

## Metrics and alerts

`GET /metrics` returns Prometheus text: request count, 5xx count, 4xx count, and a latency histogram, split into `kind="http"` and `kind="stream"`. It also reports `loop_db_up` and pending/stale billing settlement intents. Health probes are not counted.

In production the route is closed until `METRICS_TOKEN` is set on the API service. Send it as `Authorization: Bearer <token>` or `X-Metrics-Token`. Sentry (`SENTRY_DSN`) remains the exception reporter.

Configure these alerts on the scraper you point at staging first, then production:

| Signal | Page when | For |
|---|---|---|
| 5xx rate (`loop_http_errors_total` / `loop_http_requests_total`, `kind="http"`) | above 2% | 5 minutes |
| Non-stream latency | p95 above 1.5s | 5 minutes |
| Stream 5xx rate (`kind="stream"`) | above 5% | 5 minutes |
| `loop_db_up` | equals 0 | 1 minute |
| `loop_settlement_stale` (daily or api) | greater than 0 | 15 minutes |
| `loop_settlement_pending` (daily or api) | greater than 500 | 15 minutes |

Stale means a settlement intent has been pending or processing for more than 10 minutes, which means the daily or API settlement worker is not draining. Pending without stale is a backlog, not a dead worker.
