# PostgreSQL Migration Runbook: postgres → postgres-ssl

## Overview
Migrates the current PostgreSQL instance to the `postgres-ssl` Railway template, which includes:
- **Built-in backup scheduling** (daily/weekly/monthly)
- **SSL/TLS encryption** for client connections
- **Verified restore procedures** tested on fresh instances
- **Template-maintained best practices** (security, performance, reliability)

**Current Setup:**
- Service: `postgres` (image: `postgres:16.10-bookworm`)
- Volume: `candidate-postgres-data` (50 GB) at `/var/lib/postgresql/data`
- Region: `sfo` (US West)
- Replicas: 1
- Backup Status: Dashboard backups enabled (manual)

---

## Pre-Migration Checklist

- [ ] **Scheduled maintenance window** (15–30 min, notify users if applicable)
- [ ] **Full database dump** (backup before touching anything)
- [ ] **Backup of current `.env` / Railway variables** (for reference)
- [ ] **List all services connecting to postgres** (backend, etc.)
- [ ] **Notify team** of migration schedule

### Step 1: Capture Current Config

```bash
# List current postgres environment variables (from Railway dashboard)
# Record:
# - POSTGRES_USER
# - POSTGRES_PASSWORD
# - POSTGRES_DB
# - PGDATA (usually /var/lib/postgresql/data)
```

### Step 2: Dump Database (Safety Net)

```bash
# From a backend or dev machine with psql installed:
pg_dump -h <postgres-host> -U <POSTGRES_USER> -d <POSTGRES_DB> \
  --format=custom --file=/tmp/loop-gpt-backup-$(date +%s).dump

# Store this dump safely (e.g., in S3, team shared drive, or local)
```

---

## Migration Steps (Maintenance Window)

### Phase 1: Deploy postgres-ssl Template

1. **Open Railway dashboard** → Production environment
2. **New service** → Search templates for **"postgres"** or **"postgres-ssl"**
3. **Deploy postgres-ssl template**
   - Service name: `postgres-ssl` (or `postgres-new` — you'll rename later)
   - Region: `sfo` (match current)
   - Replicas: 1 (match current)
4. **Wait for deployment** to complete (~2–3 min)
5. **Note the generated credentials** (Railway auto-generates `POSTGRES_PASSWORD`, `DATABASE_URL`, etc.)

### Phase 2: Restore Data from Dump

Once `postgres-ssl` is deployed and healthy:

```bash
# Get connection details from postgres-ssl service panel (DATABASE_URL or host/user/pass)
psql -h <postgres-ssl-host> -U postgres -d postgres -c "CREATE DATABASE <POSTGRES_DB>;"

# Restore the dump into the new instance
pg_restore -h <postgres-ssl-host> -U postgres -d <POSTGRES_DB> \
  --no-owner --no-privileges /tmp/loop-gpt-backup-*.dump
```

### Phase 3: Verify Restore

```bash
# Connect to new postgres-ssl instance and spot-check:
psql -h <postgres-ssl-host> -U postgres -d <POSTGRES_DB>

# In psql:
\dt                    # List tables (should match original)
SELECT COUNT(*) FROM <table>;  # Spot-check row counts
\q
```

### Phase 4: Update Service References

**Update all services pointing to the old postgres:**

For each service (backend, etc.):
1. Open service settings
2. Go to **Variables**
3. Update `DATABASE_URL` (or `POSTGRES_HOST`, `POSTGRES_USER`, etc.) to point to `postgres-ssl`
   - Option A: Use **Reference Variable**: `${{ postgres-ssl.DATABASE_URL }}`
   - Option B: Manually copy the new connection string from postgres-ssl's dashboard panel
4. **Redeploy** the service

**Typical example:**
```
OLD: DATABASE_URL = postgresql://user:pass@postgres.railway.internal:5432/dbname
NEW: DATABASE_URL = postgresql://user:pass@postgres-ssl.railway.internal:5432/dbname
```

### Phase 5: Smoke Test

1. **Verify backend starts and connects** (check logs for no DB errors)
2. **Test a key workflow** (sign-in, query, etc.)
3. **Monitor logs** for 5–10 minutes for errors

### Phase 6: Cleanup (After Validation)

Once everything is running smoothly:

1. **Keep old `postgres` service running for 24–48 hours** as a fallback
2. **After 24 hours**, if no issues:
   - Delete old `postgres` service
   - Rename `postgres-ssl` → `postgres` (optional, for tidiness)
   - Update any documentation

---

## Rollback Plan (If Issues Occur)

If something goes wrong:

1. **Revert services to point back to old `postgres`** (undo Step 4)
2. **Redeploy affected services**
3. **Investigate** the issue
4. **Retry migration** after fixes

The old `postgres` service will still have the original data intact during the 24–48 hour window.

---

## Post-Migration Validation

- [ ] Backend service is online and healthy
- [ ] Web service connects to backend without errors
- [ ] Database queries are working (test sign-in, API calls, etc.)
- [ ] Backup schedules are set on postgres-ssl volume (check dashboard)
- [ ] All services' logs show no DB connection errors

---

## Backup Schedules (postgres-ssl Template)

The `postgres-ssl` template includes automatic backups. After migration, verify they're enabled:

1. Open `postgres-ssl` service in Railway dashboard
2. Click **Volumes** → `postgres-data` volume
3. Ensure **Backups** is enabled with a schedule (Daily, Weekly, or Monthly)
4. Record the schedule in your team docs

---

## References

- Railway postgres-ssl template docs: [Check Railway docs](https://docs.railway.com)
- PostgreSQL pg_dump/pg_restore: `man pg_dump` / `man pg_restore`
- SSL connection strings: `postgres://user:password@host:port/database?sslmode=require`

---

## Notes

- **Zero-downtime not possible** with single-replica postgres (apps will have ~1–2 min of DB unavailability during cutover)
- **Keep both databases running during the 24–48 hour window** for safety
- **Test restore into a scratch DB** before production (optional but recommended for mission-critical data)
- **Document any custom postgres config** (e.g., custom extensions, tuning) and apply to postgres-ssl if needed

---

**Created:** 2026-09-25  
**Status:** Ready for execution  
**Owner:** [Your Name/Team]

