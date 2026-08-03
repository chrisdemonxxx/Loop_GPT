# Production Deployment — Secure & Cost-Optimized

This guide covers taking Loop GPT to production securely and as cheaply as
feasible. It assumes the Docker setup in this repo (`backend/Dockerfile`,
`frontend/Dockerfile`, `docker-compose.yml`).

## TL;DR — the cheapest secure stack

| Layer | Recommendation | Why | Idle cost |
| --- | --- | --- | --- |
| **Model** | HF **Inference Endpoint with scale-to-zero** (your A100), *or* HF **Inference Providers** (serverless, per-token) | Endpoint bills per-minute only while active; scaled-to-zero = **not billed**. Providers add no markup and suit bursty traffic. | **$0** idle |
| **Backend** | **Google Cloud Run** (container, scale-to-zero) | Pay per request/CPU-second, scales to zero, generous free tier, Secret Manager built in. | **~$0** idle |
| **Frontend** | **Vercel** (Hobby) or Cloud Run | Free static/SSR hosting for Next.js. | $0 |
| **Database** | **Neon** or **Supabase** Postgres (free tier, scales to zero) | Serverless Postgres; no always-on DB bill. | $0 |
| **Secrets** | Cloud Run **Secret Manager** (or Railway/Render vars) | Never bake secrets into images or git. | — |
| **Edge/WAF** | **Cloudflare** (free) in front | TLS, DDoS, rate limiting, hides origin. | $0 |

Net: **near-$0 when idle**; you pay mainly for model compute while requests run.
Simpler (less config) alternative: **Railway** or **Render** for backend+DB in
one place (~$5–7/mo/service, predictable) — trade a few dollars for less setup.
See pricing refs at the bottom.

> **A100 note:** an always-on A100 endpoint is expensive (~$1.8/hr ≈ $1,300/mo).
> For cost control, keep **scale-to-zero** enabled (30-min idle → $0) or switch to
> **HF Inference Providers** serverless for the model and reserve the A100 endpoint
> for sustained load. The app needs **zero code changes** to switch — just point
> `HF_ENDPOINT_URL`/`HF_MODEL` (endpoint) or use the router base URL (providers).

## Security checklist (do all before going live)

- [ ] **Rotate the HF token** and store it only in the platform secret manager. Scope it to inference only.
- [ ] `NODE_ENV=production` and **do NOT set `ENABLE_DEV_MODE`** — this disables the no-auth dev bypass in `routes/auth.ts`.
- [ ] Strong `JWT_SECRET` (32+ random bytes) from the secret manager.
- [ ] **Guardrails ON**: `GUARDRAILS_ENABLED=true`, `REVEAL_MODEL=false` (default) — redacts model/system-prompt/secret leaks (see `agent/guardrails.ts`).
- [ ] Lock **CORS** to your real frontend origin via `FRONTEND_URL` (already enforced in `server.ts`).
- [ ] Keep the **rate limiter** (already on `/api`, 100/15min) and tune per your traffic; add Cloudflare rate limiting at the edge.
- [ ] Serve only over **HTTPS/TLS** (Cloud Run/Vercel/Cloudflare terminate TLS automatically).
- [ ] Run the container as **non-root** (add a `USER node` line) and keep `npm ci --omit=dev`.
- [ ] **No secrets in logs**; guardrails already redact token/endpoint patterns from model output.
- [ ] Review any **MCP servers / connectors / custom webhook tools** you enable — they can make outbound calls; only add trusted ones.
- [ ] Consider **egress controls** if hosting the model yourself (restrict where the agent can fetch).

## Two production concerns to address (repo notes)

1. **Artifacts & config are on local disk today** (`uploads/`, `data/`). That's
   fine for a single instance but breaks horizontal scaling. For multi-instance:
   - Move generated artifacts to **object storage** (S3 / GCS / Cloudflare R2) and
     return signed URLs (swap `agent/artifacts.ts` `saveArtifact`).
   - Move the file-backed `configStore` (MCP/connectors/skills/custom-tools) to
     **Postgres** (Prisma models) so all instances share state. Until then, run a
     **single backend instance** (Cloud Run `--max-instances=1`) or a persistent volume.
2. **Database schema**: no migrations are committed; the Docker entrypoint runs
   `prisma db push`. For prod, generate real migrations (`prisma migrate`).

## Recommended deploy: Google Cloud Run + Neon (cheapest secure)

```bash
# 1. Database — create a free Neon project, copy its DATABASE_URL.

# 2. Secrets
gcloud secrets create HF_TOKEN --data-file=- <<< "hf_your_rotated_token"
gcloud secrets create JWT_SECRET --data-file=- <<< "$(openssl rand -hex 32)"
gcloud secrets create DATABASE_URL --data-file=- <<< "postgresql://…neon…"

# 3. Backend → Cloud Run (scale-to-zero, single instance for now)
gcloud run deploy loopgpt-backend --source ./backend --region us-central1 \
  --allow-unauthenticated --max-instances=1 --port 3001 \
  --set-env-vars NODE_ENV=production,HF_ENDPOINT_URL=https://YOUR-ENDPOINT,HF_MODEL=tgi,DEFAULT_PROVIDER=huggingface,GUARDRAILS_ENABLED=true \
  --update-secrets HF_TOKEN=HF_TOKEN:latest,JWT_SECRET=JWT_SECRET:latest,DATABASE_URL=DATABASE_URL:latest

# 4. Frontend → Vercel (set NEXT_PUBLIC_API_URL to the backend URL), or Cloud Run:
gcloud run deploy loopgpt-frontend --source ./frontend --region us-central1 \
  --allow-unauthenticated --set-env-vars NEXT_PUBLIC_API_URL=https://loopgpt-backend-xxxx.run.app

# 5. Put Cloudflare in front of both custom domains (TLS + WAF + rate limiting).
```

Set `FRONTEND_URL` on the backend to the frontend's final origin so CORS is tight.

### Even simpler (Railway/Render)

Push the repo; create a **backend** service (Docker), a **frontend** service, and
a **Postgres** add-on. Set the same env vars/secrets in the dashboard. Predictable
~$5–7/mo per service. Good when you want one place for app + DB.

## Cost levers

- Keep the model endpoint **scale-to-zero** (biggest lever by far).
- Backend/frontend on **scale-to-zero** platforms → ~$0 when nobody's using it.
- **Serverless Postgres** (Neon/Supabase) instead of an always-on instance.
- Cache model listings (already 1h) and set sane `HF_MAX_TOKENS` / `AGENT_MAX_STEPS`
  (in `config.ts`) to cap tokens per request.

## Sources

- Render vs Railway vs Fly.io pricing — https://expresstech.io/render-vs-railway-vs-fly-io-2026-pricing-showdown/
- Platforms with a real free tier (2026) — https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026
- HF Inference Endpoints scale-to-zero & Providers pricing — https://www.eesel.ai/blog/hugging-face-pricing
- HF Endpoints alternatives / self-host TGI/vLLM — https://www.spheron.network/blog/hugging-face-inference-endpoints-alternatives/
