# Runbook: backup and restore

**Owner:** platform
**Applies to:** P4-15, control-plane Postgres, checkpoints, audit WORM mirror
**Last verified:** 2026-09-03

Backups are executable, not document-only. `.github/workflows/backup-restore.yml` runs a daily
logical backup and a weekly scratch restore drill.

---

## 0. Assets covered

| Asset                  | Mechanism                                                       | Verification                                      |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Control-plane Postgres | `pg_dump --format=custom` via `scripts/backup_control_plane.py` | Row counts and audit hash-chain after restore     |
| Checkpoint blobs       | Tar archive of `LOOPIT_CHECKPOINT_ROOT` when configured         | Archive extraction during restore drill           |
| Audit WORM mirror      | Tar archive of `LOOPIT_AUDIT_WORM_ROOT` when configured         | `loopit_telemetry.verify_audit_mirror` per tenant |

Cloud object stores can sync these artifacts after the workflow finishes. Keep the database dump
and matching checkpoint/WORM archives together; a partial restore is not a valid drill.

---

## 1. GitHub setup

Set these in the `staging` GitHub Environment used by the drill workflow:

| Type     | Name                         | Purpose                                                           |
| -------- | ---------------------------- | ----------------------------------------------------------------- |
| Secret   | `CONTROL_PLANE_DATABASE_URL` | Source Postgres DSN for backup.                                   |
| Secret   | `SCRATCH_DATABASE_URL`       | Empty scratch database for restore verification.                  |
| Variable | `LOOPIT_CHECKPOINT_ROOT`     | Local/mounted checkpoint blob root, if available to the runner.   |
| Variable | `LOOPIT_AUDIT_WORM_ROOT`     | Local/mounted audit WORM mirror root, if available to the runner. |

When DSNs are absent the scripts print a clear skip and exit 0 so repository CI can run without
production credentials. In the scheduled environment, missing DSNs should be treated as a
configuration incident.

---

## 2. Manual backup

```bash
uv sync --dev
uv run python scripts/backup_control_plane.py \
  --dsn "$CONTROL_PLANE_DATABASE_URL" \
  --out artifacts/control-plane-backup/manual-$(date -u +%Y%m%dT%H%M%SZ)
```

The output contains:

- `control-plane.dump`
- `manifest.json` with row counts and audit-chain status
- `checkpoints.tar.gz` when `LOOPIT_CHECKPOINT_ROOT` exists
- `audit-worm.tar.gz` when `LOOPIT_AUDIT_WORM_ROOT` exists

---

## 3. Restore drill

Restore only into a scratch database unless the incident lead explicitly authorizes production
recovery.

```bash
uv run python scripts/restore_control_plane.py \
  --backup-dir artifacts/control-plane-backup/<run-id> \
  --target-dsn "$SCRATCH_DATABASE_URL" \
  --reset-schema
```

The script fails if row counts differ, the restored audit hash chain is invalid, or the WORM
mirror verification reports missing/tampered objects.

---

## 4. Production restore outline

1. Declare an incident and stop writes to the affected environment.
2. Pick the newest backup whose weekly drill passed.
3. Restore the database into a new Postgres instance first; do not overwrite the live database.
4. Restore checkpoint blobs and WORM objects to new prefixes/buckets.
5. Run `scripts/restore_control_plane.py` against the restored DSN to verify integrity.
6. Point services at the restored DSN/prefixes with `fly secrets set`, then deploy or restart.
7. Preserve the damaged instance for forensics until the incident lead releases it.

---

## 5. Drill cadence

- Daily: backup artifact creation.
- Weekly: restore into scratch DB and verify row counts + audit hash chain + WORM mirror when present.
- Quarterly: full disaster-recovery game day including checkpoint recovery and credential rotation.
