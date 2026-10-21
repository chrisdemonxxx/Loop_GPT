# loopit-abuse

Infrastructure-abuse engine for P4-6/P4-7. It ingests operational signals, scores them in sliding windows, and applies the T0-T3 response ladder: log/warn, throttle, kill sandbox, suspend tenant.

This service is intentionally separate from `loopit_policy` model-content enforcement (I11). It only handles infrastructure abuse such as mining, scanning, fan-out, GPU misuse, and auth brute force.

## Run

```powershell
python -m loopit_abuse.server
```

Environment:

- `PORT` / `LOOPIT_ABUSE_HOST`
- `LOOPIT_ABUSE_DRY_RUN=1` to audit without enforcing
- `LOOPIT_SERVICE_TOKEN` for `/v1/signals`
- `LOOPIT_IDENTITY_SECRET` for gateway identity verification
- `LOOPIT_OPERATOR_IDENTITY_SECRET` for platform operator verification
- `LOOPIT_SCHEDULER_URL`, `LOOPIT_AUTH_ADMIN_URL`, `LOOPIT_RATE_LIMIT_URL` for enforcement adapters

All operator and automated actions emit append-only audit events (I10). Destructive operator actions require admin identity and explicit confirmation in callers (I7).
