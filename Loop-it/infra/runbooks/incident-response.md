# Runbook: incident response

**Owner:** platform / security
**Applies to:** P4-11, abuse response, production incidents
**Last verified:** 2026-09-03

Use this runbook for security, reliability, billing, and abuse incidents. Preserve audit logs
and checkpoints before making destructive changes.

---

## 0. Severity matrix

| Severity | Examples                                                                                        | Initial response target | Comms                                                                  |
| -------- | ----------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| SEV0     | Sandbox escape, cross-tenant data exposure, leaked model/provider key, audit hash-chain failure | 15 minutes              | Incident lead, security owner, founders, affected customers as advised |
| SEV1     | Production unavailable, runaway spend, red-team blocker discovered post-release                 | 30 minutes              | Incident lead, platform on-call, customer status update                |
| SEV2     | Partial outage, degraded eval pass rate, backup drill failed                                    | 2 hours                 | Platform channel and next business update                              |
| SEV3     | Non-urgent bug with workaround                                                                  | Next business day       | Ticket only                                                            |

---

## 1. Roles

- **Incident lead:** owns timeline, decisions, and handoff.
- **Comms lead:** prepares customer/internal updates and disclosure notices.
- **Scribe:** records UTC timeline, commands run, and evidence links.
- **Technical owner:** executes mitigations and rollback.

---

## 2. Immediate containment

1. Stop the bleeding: pause deploys, freeze risky feature flags, and scale down affected apps
   only when that is safer than serving traffic.
2. Preserve evidence: export relevant audit rows, traces, egress logs, and checkpoint IDs.
3. Use `apps/admin` for tenant/account actions when available: suspend abusive tenants,
   inspect run state, and disable risky capabilities.
4. Use abuse-engine kill switches before broad outages:
   - `LOOPIT_ABUSE_DRY_RUN=0` to enforce policy decisions.
   - Mint a short-lived platform operator token with
     `uv run python scripts/mint_operator_token.py --subject <operator-id>` and paste it into
     `apps/admin`. Operator tokens use `LOOPIT_OPERATOR_IDENTITY_ISSUER`,
     `LOOPIT_OPERATOR_IDENTITY_AUDIENCE`, and the separate
     `LOOPIT_OPERATOR_IDENTITY_SECRET`; customer signup/login tokens are never accepted for
     cross-tenant abuse actions, even for org owners.
   - Tenant suspension in `apps/admin` for confirmed abuse.
   - Disable or narrow model/router credentials with `fly secrets unset/set` if a provider key
     is suspected compromised.
   - Set sandbox provider capacity to zero or move scheduler to maintenance mode when the
     sandbox boundary is suspect.
5. If a release caused the incident, run the rollback workflow in `.github/workflows/rollback.yml`.

---

## 3. Security disclosure

Loop-it publishes `security.txt` at the repository root and should serve the same content from
`/.well-known/security.txt` in production. Triage inbound reports using `SECURITY.md`.

- Acknowledge valid reports within 3 business days.
- Do not request exploit amplification beyond what is necessary to reproduce.
- Keep reporter identity and report contents confidential unless disclosure is coordinated.
- For confirmed tenant-impacting issues, coordinate customer notification with legal/comms.

---

## 4. Investigation checklist

- Identify affected tenants, projects, runs, leases, and checkpoints.
- Compare audit hash-chain verification with WORM mirror verification.
- Pull traces using `infra/runbooks/observability.md`.
- Check release blocker results and whether a manual override was used.
- Confirm backup freshness and restore viability using `infra/runbooks/backup-restore.md`.

---

## 5. Recovery

1. Roll back or hotfix.
2. Re-run contracts, invariants, eval T0-T3, and full red-team before resuming deploys.
3. Rotate any credential that could have crossed a trust boundary.
   Rotate operator credentials by generating a new `LOOPIT_OPERATOR_IDENTITY_SECRET`, updating
   `LOOPIT_OPERATOR_IDENTITY_KID`, redeploying the API/admin and abuse-engine, and expiring all
   previously minted operator tokens.
4. Run a targeted backup/restore drill if database or checkpoint integrity was in scope.
5. File a post-incident review with timeline, root cause, impact, and prevention work.
