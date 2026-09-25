# Loop GPT — Production Codebase (single source of truth)

Everything Loop GPT lives in this one folder. The architecture below describes the existing deployment; local rebuild work is tracked separately. Older duplicates were deleted 2026-09-07.

## Active production rebuild

- [Build progress and remaining milestones](docs/BUILD_PROGRESS.md)
- [Complete remaining production-build checklist](docs/PRODUCTION_CHECKLIST.md)
- [Foundation validation and database release runbook](docs/FOUNDATION_RUNBOOK.md)
- [Verified foundation results](docs/validation/foundation-01.md)
- [Private-file and account API changes](docs/PRIVATE_FILES.md)
- [Workspace configuration and encrypted credentials](docs/WORKSPACES.md)
- [Workspace-bound runtime and retired configuration routes](docs/RUNTIME_AUTHORIZATION.md)
- [Public HTTP controls and connector readiness](docs/PUBLIC_HTTP.md)
- [Verified isolation results](docs/validation/foundation-02.md)
- [Verified opt-in Notion/GitLab connector results](docs/validation/foundation-03d.md)
- [Hosted model request-boundary validation](docs/validation/foundation-03e.md)
- [Legacy messages and global model-state retirement](docs/validation/foundation-03f.md)
- [Model SDK destination policy and limits](docs/MODEL_HTTP.md)
- [Pinned DNS and bounded model-stream validation](docs/validation/foundation-03h.md)
- [Provider/media transport and isolated sidecar policy](docs/PROVIDER_MEDIA_HTTP.md)
- [Verified provider/media migration results](docs/validation/foundation-03i.md)
- [Daily and prepaid reservation contracts](docs/ACCOUNTING.md)
- [Combined ledger/backend validation](docs/validation/foundation-03j.md)
- [Daily settlement recovery worker](docs/DAILY_SETTLEMENT_RECOVERY.md)
- [Verified recovery results](docs/validation/foundation-03k.md)
- [Prepaid capture recovery worker](docs/API_SETTLEMENT_RECOVERY.md)
- [Verified prepaid recovery results](docs/validation/foundation-03l.md)
- [Reservation-linked prepaid video jobs](docs/ACCOUNTED_VIDEO_JOBS.md)
- [Verified video lifecycle results](docs/validation/foundation-03m.md)
- [Verified daily/JWT video accounting](docs/validation/foundation-03n.md)
- [Owned web/PWA client setup](web/README.md)
- [Owned client validation and limitations](web/VALIDATION.md)

Local changes are not automatically deployed. The backend now requires a separate
reviewed migration release step; read the runbook before deploying this revision.

## Live architecture

**The rebuilt owned platform is now live.** `loop-gpt.cyou` serves the product
UI from `frontend/` (Next static export) via the `web` service, which proxies
`/api` and `/v1` to the `backend` service. Verified 2026-09-21:

| Surface | URL | Served by |
|---|---|---|
| Product UI (app + API, same-origin) | https://loop-gpt.cyou | Railway service `web` (builds `frontend/` → static export; nginx proxies `/api`, `/v1`) |
| Aliases | https://app.loop-gpt.cyou, https://chat.loop-gpt.cyou, https://www.loop-gpt.cyou | same `web` service |
| Public API (OpenAI-compatible) | https://api.loop-gpt.cyou/v1 | same `web` service → `backend.railway.internal:3001` |

Railway project (active): `loop-gpt-owned-staging-20260917`
(id `8584f5ac-2000-4311-9dae-ae283b70216f`, production env `2faec73c-12aa-47c9-9a6c-94a9276eb6d5`).
Services: `web` (product UI), `backend` (Express + agent runtime), `postgres`
(`loop_staging`), `cf-tunnel` (Cloudflare connector, spare path). The legacy
`loop-gpt` project (`c4381399-…`, services `frontend`/`librechat`/`backend`)
is the older topology and no longer owns the apex domains.

Deploy: `railway up --ci -s backend -p 8584f5ac-… -e production` (repo root) and
`railway up --ci -s web -p 8584f5ac-… -e production` (repo root). Migrations are
a separate release step: `DATABASE_URL=<public> npx prisma migrate deploy`.

Model endpoints (Hugging Face, namespace `red-kit`, OAuth token via `hf auth token`): chat `qwen3-8-27b-cyber` (vision + tools + reasoning), large-context `glm53-ablit-*` / `vu3pi203abtenqrc`, image `loop-gpt-image` (GLM image handler), video `loop-gpt-video-14b` (SkyReels, scale-to-zero — first request takes minutes).

## Repo layout

- `backend/` — Express + Prisma API. Metered `/v1` (chat/tools/vision passthrough, `/v1/media/publish`, `/v1/images/generations`, `/v1/videos/generations`). Deploys automatically on push to `main` (service rootDirectory `/backend`, Dockerfile build).
- `skills/` — LibreChat skills catalog (`SKILL.md` files), synced hourly + on boot by LibreChat from this repo (`skillSync` → owner `Seentiourcio47`, repo `loop-gpt`, path `skills`).
- `deploy/librechat/spike/` — the LibreChat production image (branded, 6 MCP servers: loop-media, loop-code, loop-files, loop-memory, github, sequential-thinking; sandboxed code runner; Tavily web search; modelSpecs with vision/tools/artifacts/skills).
- `deploy/cloudflared/` — cf-tunnel service config.
- `gateway/` — nginx web gateway: static landing mirror at `/`, everything else proxied to LibreChat. Deployed by snapshot upload.
- `loop-code/` — Loop Code CLI product.
- `mobile/` — LoopGPT mobile app (Capacitor; not yet deployed).

## Deploy procedures

```bash
# Backend — commit to clean-main, push, Railway auto-builds:
git push neworigin clean-main:main

# LibreChat — from deploy/librechat/spike:
railway link --project c4381399-65b9-4998-8716-b1d5b71c802f --environment production --service librechat
railway up --ci

# Gateway — from gateway/:
railway link --project c4381399-65b9-4998-8716-b1d5b71c802f --environment production --service frontend
railway up --ci
```

Railway CLI links are **keyed by directory path** — after moving this folder, re-run the `railway link` commands above once per directory.

## Configuration lives in Railway service variables (not files)

All secrets (HF tokens, `sk-loop-…` API key, Google/GitHub OAuth client creds, Tavily, JWT secrets, Mongo/Postgres URLs) are set as Railway variables on the respective services. `librechat.yaml` references them via `${ENV}` placeholders.

## OAuth social login (bridge architecture)

Google/GitHub apps whitelist only `https://api.loop-gpt.cyou/api/auth/oauth/<provider>/callback` (legacy registration). Flow: LibreChat button → api-host `/oauth/<provider>` relay (backend route) → apex `/oauth/<provider>` initiation → Google/GitHub consent → api-host callback → backend bridge 302 (code+state verbatim) → apex `/oauth/<provider>/callback` → LibreChat exchanges code with the identical redirect_uri string → session. Do not change `DOMAIN_SERVER` / `*_CALLBACK_URL` on the librechat service without re-reading `backend/src/routes/oauth.ts`.

## Hard-won gotchas

- Railway `rootDirectory` is per service-instance; CLI snapshot uploads are prefix-trimmed — flat build contexts only.
- Railway private DNS returns IPv6 first; nginx literals need brackets or `getent ahostsv4`.
- Historical backend images ran destructive schema synchronization on boot. The rebuilt source removes it and provides committed migrations; existing databases require reconciliation/baselining before deploying this revision. API keys are sha256-hashed rows in Postgres.
- LibreChat model vision detection is substring matching against a whitelist — model ids `qwen-vl-loop` / `qwen-vl-loop-large` are chosen to match; backend `chatModels.ts` maps them to tiers.
- Failed Railway deployments never replace running instances; safe to iterate.

## Removed on purpose (do not resurrect)

`database/`, railpack configs, and all standalone backend copies
(`deploy-backend*`, `Loop_GPT_*` variants) are gone from the working tree.
`frontend/` and `docs/` were later restored and are the live product UI and
plan docs (`docs/AUDIT.md`, `GAP_REGISTER.md`, `PROGRESS.md`, `DECISIONS.md`).
History preserves everything in git.
