# Backup Quick Reference

## Current Status (2026-09-26)

| Item | Status | Notes |
|------|--------|-------|
| **Dashboard backups** | ✅ ON (Daily) | Operator-confirmed in dashboard via browser agent: Daily, retained 6 days, next run ~10h at confirmation. Backup state is not API-visible — re-verify in dashboard after any volume change. |
| **postgres-ssl:16 image swap** | ✅ Executed | In-place swap (same service/volume/`DATABASE_URL`), not the separate-service cutover originally planned. See `docs/RUNBOOK.md` §2. |
| **Scratch-restore rehearsal** | ✅ EXECUTED | Temp TCP proxy → pg_dump (774 KB, SHA256 84D2669B…42470A) → pg_restore into scratch postgres:16 → 33/33 tables, 13 users, tokens + usage events intact. Evidence in `docs/RUNBOOK.md` §3a. |
| **Optional: `candidate-private-store` backups** | ⏳ Operator choice | backend service volume (chat/artifact bytes). Browser agent reported OFF; enable in dashboard if desired. |

## Where things live

- Runbook (swap + backup + restore + validation): `docs/RUNBOOK.md`
- Project: `loop-gpt-owned-staging-20260917` → env `production` → service `postgres`
- Volume: `candidate-postgres-data` (50 GB, `/var/lib/postgresql/data`)
- Backups toggle: dashboard → postgres service → Volumes → volume → Backups

## Fast paths

- **Restore from volume snapshot (disaster):** dashboard → volume → Backups → Restore; then run the `docs/RUNBOOK.md` §4 validation checklist.
- **Manual dump/restore (tested steps):** `docs/RUNBOOK.md` §3a.
- **Something broke after the swap:** rollback by restaging `postgres:16.10-bookworm` (same volume, data intact).
