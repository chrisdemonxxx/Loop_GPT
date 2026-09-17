# Reservation accounting (checkpoint 03j)

**03k follow-up:** daily capture now persists immutable settlement evidence first.
A separate bounded worker retries it with distributed leases/fencing. Queuing is
not foreground success. See `DAILY_SETTLEMENT_RECOVERY.md` for execution, failure
semantics and limitations; prepaid/provider reconciliation is still pending.

**03l follow-up:** prepaid confirmed-usage intents and a separate recovery worker
are now implemented too; see `API_SETTLEMENT_RECOVERY.md`. Both workers require
committed evidence. Missing/partial provider usage, async dispatch and payment
reconciliation are still separate release work.

**03m follow-up:** prepaid reservation-linked video dispatch is implemented behind
an off-by-default feature flag, with bounded claims, at-most-once submit attempts,
confirmed settlement and atomic publication. JWT/daily jobs remain disabled.
See `ACCOUNTED_VIDEO_JOBS.md` for pause/cancellation and output-format restrictions.

**03n follow-up:** daily/JWT video jobs now share the accounted worker with an
exclusive daily ledger relation and additional off-by-default flag. Daily debit
identity/amounts/window are immutable in PostgreSQL to prevent edited refund
evidence. API keys cannot use daily job status/cancel endpoints. Both pools still
require live qualification and production storage/queue safeguards.

Two existing products still use separate balances: hosted JWT requests consume
daily allowances, while developer `/v1` requests consume prepaid micro-USD. This
checkpoint makes those deductions atomic before reviewed paid dispatch. It does
not merge the products or certify payment processing/production readiness.

## Daily allowances

`dailyReservations.ts` serializes balance/reset/reservation/settlement mutations
on the User row with a PostgreSQL row lock. A server-generated UUID identifies each
action. Missing database, missing user and database errors fail closed. Account
views are not authorization; callers must actually reserve before dispatch.

- Chat and agent actions reserve one message credit, research three, synchronous
  video tools ten; image tools reserve one image-allowance unit. Admin/unlimited
  exemptions remain explicit and are audited with zero-cost reservations.
- Agent base actions and each generated media tool action have separate holds.
  The route no longer charges generated artifacts a second time.
- Rolling 24-hour reset is serialized with debits. A refund can replenish only the
  reservation's original window, never a newer daily allowance.
- State: `reserved -> dispatched -> captured`, or `reserved -> released`.
  Uncertain dispatched work becomes `unknown`, retaining its deduction. Matching
  capture retries are idempotent; different metrics/identity/kind are conflicts.
  A unique UsageEvent reservation link protects against duplicate event insertion.
- Cancellation is observed before dispatch, including while waiting for a DB lock.
  Setup disconnects release undispatched holds. A crash/cancellation at the boundary
  after a committed dispatch marker is conservatively treated as uncertain.

Both `/api/agent` and `/api/conversations` streaming/CLI aliases, legacy messages,
and image/video tool handlers now use this contract. Agent terminal success and
CLI `[DONE]` follow capture. Successful inference is captured before assistant or
artifact persistence, so storage failure cannot silently skip usage accounting.

Daily token counters are estimates except where the CLI provider reports usage;
agent/research counters currently omit intermediate prompts/turns. These counters
are not exact provider cost accounting; the action allowance remains flat-rate.

## Prepaid developer API

`apiReservations.ts` uses serializable transactions with bounded whole-transaction
retries. Provider work never occurs inside a retried DB callback.

- Money is bounded nonnegative integer micro-USD; usage counts are bounded integers.
  Reserve atomically decrements sufficient available funds and verifies key ownership.
- The server supplies a UUID, normalized-request fingerprint, model/kind and pricing
  snapshot. Exact internal retries are idempotent; conflicting identities/payloads
  fail. Each HTTP invocation gets a new ID: client `Idempotency-Key` is not yet a
  provider-work deduplication mechanism.
- Dispatch is a one-time durable transition. Capture/refund and the unique usage
  row commit atomically. Capture cannot exceed the reservation. No unreserved
  `chargeUsage` path remains. State survives ambiguous network/DB outcomes.
- Known pre-invocation failure releases the hold; partial/uncertain invocation
  retains it. Available partial-unit evidence is recorded. Unknown settlement or
  release after dispatch requires a reconciliation reference; there is no automatic
  age-based refund of possibly billable work.
- Preview credit is atomically granted once. Top-ups with a nonempty reference are
  deduplicated by `(source, reference)`. Existing historical top-ups are checked,
  not deleted or destructively rewritten. Reference-free credits are not deduplicated.

Chat reserves the configured context budget and enforces output/context limits.
Provider-reported usage is required for settlement; absent/malformed usage remains
unknown rather than a zero-cost success. This is deliberately conservative and
can reserve much more than a short prompt ultimately consumes. Embedding metering
is disclosed as UTF-8 input bytes plus two special tokens per input, not a tokenizer
measurement. Images reserve the whole batch. Uncertain image POSTs are no longer
automatically retried for cold-start errors; retry behavior from 03i is superseded.

`X-Loop-Reservation-Id` exposes the correlation ID; a customer-facing reservation
history/reconciliation interface is still missing. Retained holds reduce available
funds, and operational resolution is required before offering this publicly.

## Asynchronous video is deliberately unavailable

Both prepaid and JWT async-video creation now return 503 until jobs have durable
reservation linkage, dispatch claims and settlement. Server startup no longer
automatically resumes legacy video jobs: disabling only creation left a startup
path that could submit unmetered persisted jobs. Legacy records remain intact for
review. The existing internal polling helper remains available to tests; it is not
bootstrapped by the server. Synchronous agent video tools use daily reservations.

## Additive database changes and rollout

Apply the existing runbook, including reconciliation/baselining for older deployed
databases. New migrations:

- `20260916030000_api_reservations`: prepaid reservation state/identity, unique
  settlement link, top-up credit identity.
- `20260916040000_daily_reservations`: daily reservation state and unique UsageEvent
  link. Existing nullable links remain compatible with historical usage records.

Never automatically delete historical balances/usage to make migrations pass.
Existing negative prepaid balances must be reconciled; new conditional reservations
do not manufacture funds or repair legacy accounting history.

## Remaining release requirements

1. Provider/missing-evidence reconciliation. Daily and prepaid confirmed-evidence
   recovery are implemented in 03k/03l, but failures before the intent write and unknown work
   without metrics still need reconciliation. Stale reserved holds require a safe claim/release
   protocol; do not simply refund while another worker could still dispatch.
2. Distributed worker leases, bounded concurrency, cancellation/fencing and
   job-linked accounting before re-enabling async video or other durable paid work.
3. Signed fail-closed payment webhook processing, event idempotency and lifecycle
   reconciliation. Stripe checkout/webhook code was not changed by this checkpoint;
   the earlier unsigned fallback and event-processing gaps remain launch blockers.
4. Provider-reported usage qualification, aggregate run budgets, pricing disclosure,
   customer hold visibility, alerts and operational refund/reconciliation policy.
5. Full workspace/session/file lifecycle, live provider/payment eligibility,
   deployment qualification and owned native clients.

Evidence: `validation/foundation-03j.md`. Passing local mocked-provider tests is not
permission to enable public paid execution with these release requirements open.
