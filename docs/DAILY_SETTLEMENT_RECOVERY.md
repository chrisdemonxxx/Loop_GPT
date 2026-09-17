# Daily settlement recovery worker (03k)

## What this implements

`recordUsage` now commits an immutable `DailySettlementIntent` before attempting
capture. Evidence includes reservation/user/kind/model, bounded metrics and a
fingerprint. Exact repeated submissions are idempotent; different payloads fail.
A database trigger rejects evidence updates, while delivery status remains mutable.

Foreground success still requires capture to commit. An intent being queued is
not a successful charge/capture response. If capture fails, persisted evidence can
be retried separately without invoking a model, generating media, or refunding a
hold. Unknown/dispatched reservations without evidence are not scanned or guessed.

Capture, counters, the unique UsageEvent and reservation state commit together.
Recovery checks identity/fingerprint/state; it cannot turn an undispatched or
released reservation into billed work. Cleanup cannot revert captured success.

## Distributed delivery

- PostgreSQL `FOR UPDATE SKIP LOCKED` claims due intents atomically.
- Lease expiry uses the database clock, not a worker's local time. Each claim has
  a fresh fencing token checked under the intent lock before capture/acknowledgement.
- Workers claim waves no larger than available concurrency. `batchSize` bounds total
  deliveries per sweep; it does not pre-lease a local queue behind busy consumers.
- Capture uses user-then-intent locking. Stale workers cannot acknowledge or reset
  another worker's lease. Exact repeated captures cannot duplicate usage/counters.
- Retry delay is deterministic exponential backoff capped at five minutes. Up to
  ten delivery attempts may execute capture; crashes/expired leases also consume
  delivery attempts. Exhausted uncaptured work is dead-lettered, not refunded.
- Already-committed capture can be acknowledged after lease/acknowledgement failure,
  including at the retry limit. It must not regress into a retry/dead-letter state.
- Permanent identity/state/ledger conflicts become terminal `conflict`. Error labels
  are bounded/sanitized; private exception messages are not stored in the queue.

Intent states: `pending`, `processing`, `succeeded`, `conflict`, `dead_letter`.
Conflict/dead-letter rows require operator investigation, not blind requeueing or
editing their immutable evidence. No operator reconciliation UI is supplied yet.

## Run the worker

Apply `20260917000000_daily_settlement_recovery` using the reviewed migration
procedure. Provide the same database as the API through secret management. Build
the backend or use the packaged production image; no dev-only runner is required.

From `backend/`:

```powershell
npm.cmd run worker:daily-settlement -- --help
npm.cmd run worker:daily-settlement -- --once
npm.cmd run worker:daily-settlement -- --batch-size 25 --concurrency 4
```

Options: batch size 1–100 (default 25), concurrency 1–16 (4), lease 1,000–300,000 ms
(30,000), poll 100–60,000 ms (1,000). Lease duration must cover real capture latency;
there is no heartbeat. Increase it for expected contention rather than allowing
repeated expiration to exhaust useful evidence. Choose concurrency consistent with
DB connection capacity and observe the outcome counters.

The server **does not auto-launch** this worker. Deploy it as a separately supervised
process. Continuous mode handles SIGINT/SIGTERM, stops claiming and drains active
captures. POSIX graceful shutdown was tested; Windows process termination semantics
differ. Unstarted claims expire for another worker. No running daemon was left by
local validation.

Each sweep logs bounded aggregate counts including `claimed`, `succeeded`, `retry`,
`conflict`, `dead_letter`, `lease_lost`, `unavailable`, `unprocessed`, and `aborted`.
For `--once`: exit 0 means the sweep completed without a reported error; 1 indicates
unavailable/retry/lost/incomplete/cancelled work; 2 invalid arguments; 3 conflicts
or dead letters. An empty sweep does not prove no future-due or terminal work exists.

## Scope limitations

- This is daily allowance settlement only, not prepaid micro-USD reconciliation.
- It cannot recover metrics lost before the evidence write or repair an unavailable
  DB by itself. Such reservations still need external evidence/reconciliation.
- It does not reconstruct lost assistant/artifact output after accounting succeeds.
- It does not dispatch providers, implement scheduled user tasks, or re-enable video.
- It preserves existing daily metrics; it does not make estimated token counts exact.
- Deployment supervision, customer hold visibility, alerting, operator reconciliation,
  retention and broader payment/provider/job recovery remain release requirements.

Verification: `validation/foundation-03k.md`. The current complete remaining scope
is tracked in `PRODUCTION_CHECKLIST.md`.
