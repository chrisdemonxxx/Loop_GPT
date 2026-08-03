# Deploy the whole stack on Railway (frontend + backend + Postgres)

Railway hosts all three in **one project**. ~15 minutes. (Railway doesn't scale
to zero, so expect ~$5/service idle; for near-$0 idle use Cloud Run instead —
see PRODUCTION_DEPLOYMENT.md.)

## 0. Prereqs
- A Railway account (railway.app) with a payment method.
- This repo on GitHub.
- Your **rotated** `HF_TOKEN` and your `HF_ENDPOINT_URL` (dedicated endpoint, or
  `https://router.huggingface.co` for serverless).

## 1. Create the project + database
1. Railway → **New Project** → **Deploy from GitHub repo** → pick this repo.
2. In the project, **+ New → Database → Add PostgreSQL**. (Gives `DATABASE_URL`.)

## 2. Backend service
1. **+ New → GitHub Repo →** this repo. Open the service → **Settings**:
   - **Root Directory:** `backend`  (it will use `backend/railway.json` → Dockerfile)
   - **Networking:** enable a public domain → note it, e.g. `loopgpt-backend.up.railway.app`.
2. **Variables** (Settings → Variables):
   ```
   NODE_ENV=production
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   JWT_SECRET=<run: openssl rand -hex 32>
   HF_ENDPOINT_URL=<your endpoint URL or https://router.huggingface.co>
   HF_TOKEN=<your rotated token>
   HF_MODEL=tgi                       # or a router model id, e.g. meta-llama/Llama-3.1-8B-Instruct
   DEFAULT_PROVIDER=huggingface
   HF_IMAGE_MODEL=black-forest-labs/FLUX.1-schnell
   HF_IMAGE_PROVIDER=nscale
   GUARDRAILS_ENABLED=true
   REVEAL_MODEL=false
   ENABLE_DEV_MODE=false
   # FRONTEND_URL is set in step 4.
   ```
   `${{Postgres.DATABASE_URL}}` references the DB service automatically.

## 3. Frontend service
1. **+ New → GitHub Repo →** this repo again. Open it → **Settings**:
   - **Root Directory:** `frontend`
   - Enable a public domain → note it, e.g. `loopgpt.up.railway.app`.
2. **Variables:**
   ```
   NEXT_PUBLIC_API_URL=https://<your backend domain from step 2>
   ```
   (This is a build-time var; the Dockerfile reads it as a build ARG.)

## 4. Wire CORS + redeploy
1. Back in the **backend** service → Variables → add:
   ```
   FRONTEND_URL=https://<your frontend domain from step 3>
   ```
2. Redeploy backend and frontend (Railway → each service → Deploy).

## 5. Go live
Open the frontend domain. First model call may cold-start your endpoint
(30–120s if scaled to zero). Done.

### Notes
- The backend runs `prisma db push` on boot to create tables (no migrations needed).
- Runtime config (MCP servers, connectors, custom tools, user skills) is stored on
  the service's disk — fine for the single instance Railway runs here. For multiple
  instances, move that to Postgres (see PRODUCTION_DEPLOYMENT.md).
- Optional: put **Cloudflare** in front of your Railway domains for WAF + caching.

## CLI alternative
```bash
npm i -g @railway/cli && railway login
railway init
railway add --database postgres
# create the two services in the dashboard (root dirs backend/ and frontend/),
# then set variables with:  railway variables set KEY=VALUE --service backend
railway up
```
