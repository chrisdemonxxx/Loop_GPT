# Prepaid confirmed-usage recovery (03l)

## Scope and trust boundary

`captureApiReservation` persists an immutable confirmed-usage intent in its own
transaction before capture. `/v1` paid capture and `apiBilling.chargeUsage` use this
wrapper. Foreground success still requires settlement to finish; queued evidence
alone is not a successful API response.

Only trusted server code that has validated provider output or completed metered
work may create an intent. This is not an HTTP endpoint accepting client-reported
costs/usage. Checks bind reservation, account, key, kind/model, bounded integer
metrics and cost no greater than the original hold. The worker never recalculates
an amount from current pricing, fabricates provider evidence, or invokes providers.

An intent commits cost/metrics, a fingerprint and deterministic reconciliation
reference. A database trigger prevents later changes to evidence. Matching retries
converge; conflicting payloads fail. Exact historical captures with the original
null reconciliation reference retain their old rows/fingerprints without creating
new intents. Explicit manual settlement/release retains its separate semantics.

## Recovery and concurrency

- Only committed intents are scanned. Unknown reservations without complete
  confirmed evidence remain held for operator/provider reconciliation.
- PostgreSQL `SKIP LOCKED` claims use database-clock leases and fresh fencing tokens.
  Claims are limited to available consumer slots, not a large locally queued batch.
- Reservation and intent locks are held through fence validation and capture.
  Duplicate workers cannot duplicate balance changes or usage rows; stale workers
  cannot reset another worker's success or overwrite a manual refund.
- Capture, unused-reservation refund and unique usage insertion are atomic.
  Worker acknowledgement follows capture separately. If acknowledgement fails,
  replay recognizes the exact committed capture and only acknowledges it.
- Retry/backoff is bounded. Conflicting evidence/state becomes `conflict`; exhausted
  uncaptured work becomes `dead_letter`. Neither transition refunds a hold.
- At most ten leased capture deliveries execute; expired/crashed claims consume
  delivery attempts too. Already-captured work can still be acknowledged afterward.
- Backoff grows exponentially from one second, capped at five minutes. Lease
  duration should exceed expected capture contention; there is no lease heartbeat.

Revoking a key stops new authorized requests, but does not erase liability for
already-dispatched work. Matching confirmed usage can still settle; another key
cannot substitute for the reservation's bound identity.

## Worker operations

Apply `20260917010000_api_settlement_recovery` using the normal reviewed release
procedure. Compile the backend and configure its database through secret management.
The worker is included in the non-root production image and runs separately from
the API; no daemon is auto-launched by server startup.

```powershell
# From backend/
npm.cmd run worker:api-settlement -- --help
npm.cmd run worker:api-settlement -- --once
npm.cmd run worker:api-settlement -- --batch-size 25 --concurrency 4
```

Defaults/ranges match the daily worker: batch 25 (1–100), concurrency 4 (1–16),
lease 30,000 ms (1,000–300,000), poll 1,000 ms (100–60,000). Continuous mode stops
claiming on SIGINT/SIGTERM and drains active captures. Interrupted `--once` exits
nonzero even when its active capture finishes successfully. POSIX signals were
tested on Linux; Windows does not supply equivalent graceful child-kill semantics.

Exit codes: 0 completed sweep, 1 incomplete/retry/unavailable/cancelled,
2 invalid arguments, 3 conflict/dead-letter outcomes. Aggregate JSON counts report
claimed/succeeded/retry/conflict/dead-letter/lease-lost/unavailable/unprocessed and
aborted state, without raw private errors. An empty sweep does not prove the absence
of future-due, leased or terminal records.

Monitor queue age, retained funds, retries and terminal records. Terminal evidence
must be investigated, not edited or blindly reset. This implementation does not
provide a customer support/reconciliation UI or deployment supervision.

## Still intentionally unresolved

- Provider success followed by failure to commit an intent: missing evidence is
  not reconstructable by this worker.
- Partial image batches: known completed-unit counts are retained, but uncertain
  remaining work still requires provider reconciliation; no automatic resubmission.
- General durable runs/provider dispatch, job-linked async-video accounting and
  safe recovery of ambiguous submissions. Video creation remains disabled.
- Payment webhook authentication/idempotency, customer hold history/refunds,
  operational retention, native/product work and live qualification.
- Account/key deletion workflows must respect retained financial evidence and
  foreign keys. Do not delete production ledger records to bypass those constraints.

## Reproducible fixture smoke

`scripts/api-settlement-smoke.mjs` requires matching `DATABASE_URL` and
`TEST_DATABASE_URL` pointing to the dedicated local `loop_foundation_test` database.
It creates its own fixture account/hold, persists confirmed usage, invokes the real
compiled worker, retries capture, and verifies exactly one ledger entry and the
expected balance. It removes only its own rows. It cannot run against a differently
named/nonlocal database. This is a fixture tool, not an operator billing command.

Evidence: `validation/foundation-03l.md`. Full remaining build scope:
`PRODUCTION_CHECKLIST.md`.
