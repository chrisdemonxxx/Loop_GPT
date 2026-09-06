# Loop GPT — Production Codebase (single source of truth)

Everything Loop GPT lives in this one folder. It is deployed and live. There are no other copies — older duplicates were deleted 2026-09-07.

## Live architecture

| Surface | URL | Served by |
|---|---|---|
| Landing page | https://loop-gpt.cyou | `gateway/` (nginx, static mirror + reverse proxy) |
| Chat app (LibreChat) | https://loop-gpt.cyou/* and https://chat.loop-gpt.cyou | Railway service `librechat`, built from `deploy/librechat/spike/` |
| Public API (OpenAI-compatible) | https://api.loop-gpt.cyou/v1 | Railway service `backend`, built from `backend/` via git push to `main` |
| Media CDN | https://api.loop-gpt.cyou/uploads/* | backend `/v1/media/publish` writes here |

Railway project: `loop-gpt` (id `c4381399-65b9-4998-8716-b1d5b71c802f`, production env `78eea8e7-c69e-427d-bcee-57b33cb88f9c`).
Services: `frontend` (= the gateway, snapshot-deployed), `backend` (git-deployed), `librechat` (snapshot-deployed), `librechat-rag` (image `ghcr.io/danny-avila/librechat-rag-api:latest`), `cf-tunnel`, `Postgres`, `MongoDB`.

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
- `prisma db push --accept-data-loss` runs on backend boot — schema drift wipes data (it emptied the ApiKey table once; keys are sha256-hashed rows in Postgres).
- LibreChat model vision detection is substring matching against a whitelist — model ids `qwen-vl-loop` / `qwen-vl-loop-large` are chosen to match; backend `chatModels.ts` maps them to tiers.
- Failed Railway deployments never replace running instances; safe to iterate.

## Removed on purpose (do not resurrect)

The old Next.js portal (`frontend/`), its docs, `docs/`, `database/`, `.github/` CI, railpack configs, and all standalone backend copies (`deploy-backend*`, `Loop_GPT_*` variants) are gone from the working tree. The product frontend is the gateway + LibreChat. History preserves everything in git.
