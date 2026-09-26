# Reservation-linked prepaid and daily video jobs (through 03o)

> **Historical checkpoint record (audit §8-47):** the default-off reservation
> semantics and accounting evidence rules described here remain the reference
> for daily settlement. The live deployment notes and current feature state
> live in `docs/PROGRESS.md` + `docs/ACCOUNTING.md`; treat this as the 03o
> snapshot. (The stray `backend/backend` migration tree referenced during
> this checkpoint was moved into the real migrations directory on 2026-09-22.)


**Default off; live provider qualification is not complete.** The developer API uses
prepaid credit; the authenticated app API uses daily credits under an additional
flag. Synchronous media tools remain separate. This is not a general durable task
or sandbox engine. Checkpoint 03n adds the daily path without replacing historical
prepaid jobs.

## Daily/JWT API and accounting (03n)

`POST /api/media/video-jobs` accepts the same bounded input described below and
returns 202 after atomically reserving **10 daily credits** and creating the job.
It requires an authenticated account plus both `ACCOUNTED_VIDEO_JOBS_ENABLED=true`
and `ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED=true`. Missing flags keep creation unavailable.

The server supplies owner, kind, model, debit, window, bypass and a request/config
fingerprint. Clients cannot choose a billing pool, impersonate another account,
provide cost/bypass fields or substitute a reservation. Admin/unlimited exemptions
are explicit zero-credit audited reservations. Account plan/role/unlimited changes
before dispatch invalidate the queued binding; already accepted work remains
settleable with its original accounting.

The shared queue enforces exactly one daily or prepaid ledger relation per job in
PostgreSQL. Daily jobs have no API-key reservation. All developer keys—including
the same account's keys—are excluded from daily-job v1 status/cancel endpoints.
Owner JWTs use `/api/media/jobs`, `/api/media/jobs/:id`, and
`/api/media/jobs/:id/cancel`. Existing account-wide file access still applies to
published artifacts; job access and file access are separate documented boundaries.

Daily dispatch marker and job marker commit together. Daily settlement evidence
and staged artifact identity commit together. Final daily capture/publication uses
the existing daily recovery contract under the job fence; the independent daily
worker may capture first without causing a duplicate charge or publication.

Queued cancellation refunds only the original allowance window. Old-window refunds
cannot replenish a refreshed allowance. The new migration makes reservation id,
owner, original message/image debit, bypass and window immutable at the DB level,
so an internal writer cannot inflate refunds by rewriting those fields. Legitimate
request corruption can still cancel/refund the trustworthy original debit. Existing
financial corruption predating this migration is not automatically repaired.

Turning off only the daily flag pauses daily network claims without consuming
attempts; prepaid claims continue. Turning off the common flag pauses both pools.
Known settlement evidence can still finish with both flags off. Neither pause
extends original deadlines. Creation is not HTTP-idempotent for either pool.

## API and ownership

When explicitly configured, `POST /v1/videos/generations` creates an accounted job
and prepaid reservation in one serializable transaction and returns **202**. No
provider work starts in the HTTP request. Failed job insertion rolls back the hold.
The flat price/discount is selected from the server account and snapshotted.

Input accepts only model `loop-video` (default), prompt 3–2,000 characters, width
and height 256–960 in multiples of 16, fps 8–30, and numFrames 16–120. Defaults are
960×544, 24 fps, 96 frames. Unknown fields fail validation. These are provider
parameters, not a guarantee that returned pixels precisely match those parameters.

- GET `/v1/videos/generations/:id` returns job status/progress/output, not credentials,
  provider endpoint or raw provider errors. New jobs are bound to the creating key
  and its account; another key cannot poll/cancel that job. Revoked keys fail auth.
- POST `/v1/videos/generations/:id/cancel` requests cancellation.
- Existing owner-JWT routes may inspect/cancel owned jobs in either pool. Daily
  creation uses the separate JWT route and additional flag above.
- **Artifacts are account-owned**, following the existing files contract: another
  active API key of the same user can read/delete a known artifact UUID even though
  it cannot poll the source job. Cross-user access is denied. This is deliberately
  not per-key artifact isolation and is tested through real authentication.
- HTTP creation is **not idempotent**. Repeating the request creates another job and
  reservation. Do not retry POST automatically after an ambiguous client response.

## Submission, recovery and cancellation

Stages: `queued -> submitting -> polling -> settling -> completed`, with cancellation
and `needs_reconciliation` exits. Direct valid video responses can skip polling.

Workers claim only new `AccountedVideoJob` rows using database-clock leases,
SKIP LOCKED and fencing tokens. Historical unaccounted MediaJob rows are never
backfilled, submitted or automatically resumed. Process concurrency limits each
worker; the shared database policy below additionally caps all workers and pools.

### Shared queue limits (03o)

`VideoQueuePolicy` singleton id=1/version=1 defaults to outstanding limits of
64 global / 8 per user, and active upstream limits of 8 global / 2 per user.
Admission locks policy before atomically creating the reservation/job; rejection
does not debit credit. User admission exhaustion returns 429; global exhaustion
or invalid policy returns 503 without exposing another user's counts.

Live queued leases earmark capacity. Dispatch persists `upstreamSlot` together
with its accounting markers. Polling, expired submitted leases and uncertain
cancelled work retain that slot. Confirmed settlement releases it transactionally;
neither lease expiry nor a settled reservation alone proves upstream termination.
Unknown work requires evidence-based operator reconciliation, never guessed slot
clearing, age-based refund or repeated POST. Bounded claims skip saturated users.

Operators change the SQL-validated limits together and increment revision with a
compare-and-swap predicate; no worker environment override exists. Lowered limits
drain occupancy rather than evict jobs. Missing/invalid policy blocks new work,
not already-confirmed settlement. Lock order is policy -> accounted job -> media
job -> ledger (daily User first; prepaid reservation -> intent -> User).
Ledger-only recovery never locks queue policy/job rows.

The reservation dispatch marker and submit marker commit atomically before the
first provider POST. A timeout or crash afterward is uncertain, even if the request
may not have reached the socket. There is **no automatic POST retry**. This gives
at-most-once dispatch attempt per durable job, not guaranteed exactly-once delivery.

A previously persisted status URL permits bounded GET recovery. Status URLs must
match the configured endpoint origin. Result URLs are revalidated; cross-origin
CDN requests omit provider credentials. Configuration is snapshotted and endpoint
binding is checked before delivery. Tokens remain in operator configuration, never
job metadata. Existing public HTTP DNS/TLS/redirect/byte limits still apply.

Queued cancellation atomically releases only undispatched funds and fences an old
worker. Cancellation after submission cannot recall accepted provider work and does
not optimistically refund it. Known status URLs can still be polled to settle actual
completion, but cancelled output is not published. Both the cancellation API and
older status-only writers are checked under dispatch/publication locks.

## Completion and artifact publication

Output must pass bounded video-container admission before becoming confirmed usage.
Bytes are staged under fresh private UUIDs and synced, without an accessible file
metadata row. Settlement intent and staged identity commit together. Capture and
publication of the private metadata/output URL then commit together, subject to the
current job fence and cancellation state. The prepaid recovery worker may already
have captured the same intent; finalization recognizes that exact capture.

Lease expiry while waiting on a ledger/balance lock rolls back the complete fenced
action. Lost responses after evidence/publication commit are resolved from persisted
state, not by another POST or another charge. Separate private-file verification
checks UUID, size, hash and symlink constraints before publication.

Crash-created, unreferenced staged files are inaccessible but are **not automatically
garbage-collected**. Workers need the same durable `PRIVATE_FILES_DIR` storage. Local
unshared container disks are not a production multi-replica storage solution.

### Accepted MP4 profile

The zero-dependency validator requires self-contained, non-fragmented MP4 containing
AVC `avc1` progressive 8-bit 4:2:0 video tracks. It checks positive dimensions and
clocks/durations, track/sample/chunk tables, offsets wholly inside mdat, configuration
and parameter-set references, and basic NAL/slice framing. Header-only, fabricated,
audio-only, truncated and oversized output cannot establish billable completion.

Limits include 50 MiB input, 4,096 boxes, 8 tracks, 400,000 table entries, 200,000
samples and 400,000 NAL units. Audio-containing files, fragments, encryption, external
references and other codecs/unsupported structural extensions are rejected.
**This is not a full decoder or content/quality assessment.** The narrow contract
must be qualified against the actual provider output before enabling dispatch.

## Worker configuration and pause behavior

Required for new provider work:

- `ACCOUNTED_VIDEO_JOBS_ENABLED=true` (otherwise off)
- `HF_VIDEO_ENDPOINT`: public HTTPS, no query/userinfo
- `HF_TOKEN`: operator credential
- Applied migrations/database and shared durable private storage

Production also requires the explicit mode/root/UUID namespace contract in
`PRIVATE_FILES.md`. Before claiming, the worker checks storage. A failed write
probe with a still-valid readable namespace permits only staged settlement;
queued/submitting/polling work remains unclaimed. Missing/replaced/invalid storage
blocks even recovery. This prevents low-space/read-only conditions from stranding
confirmed captures while still forbidding fresh upstream work.

```powershell
# From backend/, after applying migrations and building:
npm.cmd run worker:video -- --help
npm.cmd run worker:video -- --once
npm.cmd run worker:video -- --batch-size 25 --concurrency 4
```

The API does not auto-launch this worker. Runtime image packaging includes the CLI.
Batch/concurrency/lease/poll flags match the settlement-worker ranges. A renewal
watcher best-effort aborts network operations on cancellation, lost leases or DB
failure; fencing still controls publication even when a provider ignores abort.

Persisted budgets: `HF_VIDEO_MAX_WAIT_MS` 1,000–1,800,000 ms (default 1,800,000),
`ACCOUNTED_VIDEO_REQUEST_MS` 1,000–30,000 (30,000), provider poll delay
`ACCOUNTED_VIDEO_POLL_MS` 1,000–60,000 (5,000), and
`ACCOUNTED_VIDEO_MAX_POLLS` 1–600 (600). The original startedAt anchors the budget
across restarts. GET retries are bounded; exhausted/ambiguous work retains its hold
for reconciliation rather than receiving an assumed refund.

Disabling the feature or removing valid provider configuration **pauses new claims
for queued/submitting/polling work without consuming attempts**. Committed settling
evidence can still capture/publish without provider I/O. Mid-claim configuration
unavailability releases the lease for a reversible pause, not the monetary hold.
This does not freeze original deadlines. Changing to a different valid endpoint
is a binding mismatch, not a migration of existing jobs to a new provider.

Summary logs contain aggregate outcomes and `dispatchEnabled`. Idle while disabled
is not proof that the queue is empty or complete. `--once` exits 0 for advancement/
idle, 1 for retry/pause/unavailable/interrupted work, 2 for invalid arguments and 3
when work needs reconciliation. SIGINT/SIGTERM stops claims and best-effort aborts
network I/O; already accepted provider work remains subject to reconciliation.

## Remaining release requirements

HTTP creation idempotency, deployed capacity qualification, operator
reconciliation, staged-file garbage collection, durable object storage, live provider
qualification, complete payment fulfillment and the rest of `PRODUCTION_CHECKLIST.md` remain.
No production configuration was enabled or environment changed by this checkpoint.
Evidence: `validation/foundation-03m.md` through `validation/foundation-03o.md`.
