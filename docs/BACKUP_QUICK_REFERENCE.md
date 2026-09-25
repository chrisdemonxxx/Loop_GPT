# Backup Quick Reference

## Current Status (2026-09-25)

| Item | Status | Action |
|------|--------|--------|
| **Dashboard Backups** | ⏳ Pending | Toggle ON in Railway dashboard (postgres volume) |
| **postgres-ssl Migration** | 📋 Planned | Execute per RUNBOOK.md in maintenance window |
| **Data Safety** | ✅ Secure | Current postgres service will remain for 24–48 hours post-migration |

---

## Immediate Actions (Today)

### 1. Enable Dashboard Backups
**Location:** Railway Dashboard → Production → postgres service → Volumes → candidate-postgres-data

```
1. Click volume "candidate-postgres-data"
2. Find "Backups" section
3. Toggle to ON
4. Select schedule: Daily (recommended)
5. Save
```

**Repeat for:** backend service → `candidate-private-store` (if needed)

---

## Migration Timeline (This Week)

| Phase | Duration | Owner | Status |
|-------|----------|-------|--------|
| **Pre-migration** | 30 min | DevOps | Dump DB, prep configs |
| **Maintenance Window** | 15–30 min | DevOps | Deploy, restore, cutover |
| **Validation** | 24–48 hours | All | Monitor, verify, cleanup |

---

## Key Variables (For Reference)

**Current postgres service:**
- Image: `postgres:16.10-bookworm`
- Volume: `candidate-postgres-data` (50 GB)
- Mount path: `/var/lib/postgresql/data`
- Region: `sfo`
- Replicas: 1

**Services connecting to postgres:**
- `backend` (via `DATABASE_URL`)
- Other services: [check RUNBOOK.md Step 4]

---

## Backup Retention (After Migration)

**postgres-ssl template defaults:**
- Daily backups: 7 days
- Weekly backups: 4 weeks
- Monthly backups: 12 months

*(Adjust in Railway dashboard as needed)*

---

## Support Contacts

- **Runbook:** `docs/RUNBOOK.md` (detailed steps)
- **Migration PR:** [Link to PR with full context](https://github.com/chrisdemonxxx/Loop_GPT/pull/3)
- **Railway Docs:** https://docs.railway.com/

---

## Checklist Before Migration

- [ ] Database dump taken and stored safely
- [ ] Team notified of maintenance window
- [ ] postgres-ssl service deployed and tested (scratch DB)
- [ ] All service variables captured
- [ ] Rollback plan reviewed with team
- [ ] 24–48 hour post-migration monitoring plan in place

