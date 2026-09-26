# P0_KICKOFF — ops-release (NEW seat, verify you work)
TASK (bounded, do it now): the open-ops ledger, with the command that closes each item.
Sources to read: `docs/PROGRESS.md` ("Still open" + the Phase 0/1 notes), `AUDIT_REPORT.md` §6
P9/P10/P11 + §10, `docs/RUNBOOK.md`, `docs/STRIPE_LIVE_CHECKLIST.md`.
Write `team/RELEASE_BASELINE.md`: one line per open ops item — `item | source line | current state
(raw probe where possible, e.g. `curl -s -o /dev/null -w '%{http_code}' https://loop-gpt.cyou/healthz`)
| exact command/step to close it | blocked-on (e.g. needs `DATABASE_URL`)`.
Cover at minimum: DB restore rehearsal, Stripe go-live-or-freeze, marketplace OAuth live smoke (Figma),
observability confirmed by a deliberate test error, uptime probe, deploy read-back procedure.
Then post ONE line in the room: the open-item count and the one item you can close with no new input
from the user.