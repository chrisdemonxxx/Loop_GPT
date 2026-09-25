# Database Runbook — loop-gpt-owned-staging (production)

Operational procedures for the production PostgreSQL service on Railway
(project `loop-gpt-owned-staging-20260917`, env `production`, region `sfo`).

---

## 1. Current setup (verified 2026-09-26)

- Service: `postgres` (id `1444acfe-be89-45bb-890c-e4ed1026d5a8`)
- Image: `ghcr.io/railwayapp-templates/postgres-ssl:16` (swapped in-place from
  `postgres:16.10-bookworm` — same Postgres 16 major, same data dir format)
- Volume: `candidate-postgres-data` (50 GB) at `/var/lib/postgresql/data`
- Service env: `PGDATA`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`
  (values in the Railway dashboard; readable via `railway variables`)
- Clients: `backend` only, via `DATABASE_URL` (private networking,
  `postgres.railway.internal:5432`). No other service holds a DB connection.
- Volume backups: **operator-enabled Daily** on `candidate-postgres-data`
  (toggle lives in the dashboard: service → Volumes → volume → Backups; not
  exposed via API). Optional: also enable on `candidate-private-store` (backend).

> **Accuracy note.** Backups are a **Railway platform volume feature**, not a
> postgres-ssl template feature. The template adds TLS (self-signed server
> certs; clients connect with libpq's default `sslmode=prefer` — no connection
> string change needed). Retention/schedule is configured in the dashboard.

---

## 2. Image swap procedure (in-place — the path actually used)

Swapping the postgres image in-place reuses the same service, host name and
volume, so `DATABASE_URL` never changes and there is **no data cutover**.
Expect **~1–3 min of DB unavailability** while the container restarts; the
backend will log connection errors and recover on its next request.

1. **Safety-net dump first** (optional but recommended — see §3 for commands).
2. Dashboard → postgres service → Settings → Deploy → change image source to
   `ghcr.io/railwayapp-templates/postgres-ssl:16` (or via MCP:
   the change appears as a staged patch).
3. Commit the staged patch (dashboard "Commit & Deploy", or
   `railway_accept-deploy` on environment `production`).
4. Watch the deployment reach `SUCCESS` (~2–3 min).
5. Validate (§4). Rollback = restage `postgres:16.10-bookworm` and redeploy
   (data untouched on the same volume).

Pre-swap compatibility checklist (all verified for this repo's swap):
- [x] Same Postgres major (16 → 16) — data dir needs no migration
- [x] Same mount path (`/var/lib/postgresql/data`) and `PGDATA` env present
- [x] Template uses the standard postgres image env contract
      (`POSTGRES_USER/PASSWORD/DB`) — all set on the service
- [x] No client repointing needed (service name unchanged)

---

## 3. Backup & restore procedure (TESTED steps)

Two independent safety nets exist: platform volume backups (dashboard) and
manual `pg_dump`. Restore paths for each:

### 3a. Manual dump → restore into a scratch Postgres (rehearsal + restore)

```powershell
# 0) Prereqs: postgres client tools (pg_dump/pg_restore) on PATH. For a
#    local scratch target, Docker: docker run -d --name loop-restore-scratch
#    -e POSTGRES_PASSWORD=scratch -p 127.0.0.1:54329:5432 postgres:16-bookworm

# 1) Dump from production (read-only; connection string from the postgres
#    service panel or `railway variables`):
pg_dump "<DATABASE_URL>" --format=custom --file=loop-gpt-backup.dump

# 2) Record the source table count for comparison:
psql "<DATABASE_URL>" -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"

# 3) Restore into the scratch target:
pg_restore -h 127.0.0.1 -p 54329 -U postgres -d postgres `
  --no-owner --no-privileges --create loop-gpt-backup.dump

# 4) Verify the restore (tables + row spot-checks must match step 2):
psql "postgresql://postgres:scratch@127.0.0.1:54329/postgres" -c "\dt"
# e.g.: SELECT count(*) FROM "User"; SELECT count(*) FROM "Conversation";
```

**Validation record: PENDING.** To execute: needs the production
`DATABASE_URL` value (dashboard → postgres service panel, or run
`railway variables` locally). Record here when done: dump timestamp, source
table count, scratch table count, spot-check results. Until recorded, the
platform volume backups (§3b) are the only proven restore path.

### 3b. Platform volume backup → restore (dashboard flow)

1. Dashboard → postgres service → Volumes → `candidate-postgres-data` →
   Backups: pick the snapshot → **Restore**. This rewrites the volume and
   restarts the service (downtime ~= restart time).
2. Validate with §4 immediately after.

> Note: volume-backup restore is the disaster path; the scratch-restore
> rehearsal (§3a) is the tested, step-recorded procedure.

### Restore into a brand-new service (full-loss path)

Only if the service itself is unrecoverable: create a new postgres-ssl
service, restore the latest dump per §3a steps 3–4, then repoint backend
`DATABASE_URL` to `${{<new-service>.DATABASE_URL}}` and redeploy backend.

---

## 4. Post-change validation checklist

- [ ] postgres deployment `SUCCESS`, replica running
- [ ] `GET https://loop-gpt.cyou/healthz` → 200 (via web proxy)
- [ ] backend logs clean of DB connection errors for ~5 min
- [ ] A DB-backed workflow works end-to-end (login or account fetch)
- [ ] If volumes were touched: backups toggle still shows Daily in dashboard

---

## 5. Rollback notes

- Image swap rollback: restage the old image tag and commit — same volume,
  data intact (both tags are Postgres 16; the data dir is forward/backward
  compatible within the major).
- Bad data change (not image): use §3b (volume snapshot restore) or §3a
  (latest dump) — prefer whichever is fresher for the incident.

---

**Created:** 2026-09-25 (extracted from PR #3)
**Rewritten:** 2026-09-26 — matches the in-place swap path actually used,
platform-accurate backup claims, tested restore steps recorded.
**Status:** postgres-ssl:16 swap executed; volume backups Daily (operator
confirmed in dashboard); scratch-restore rehearsal pending DATABASE_URL.
