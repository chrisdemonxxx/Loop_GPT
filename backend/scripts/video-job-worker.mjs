#!/usr/bin/env node
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const help = `Usage: node scripts/video-job-worker.mjs [--once] [options]
Process reservation-linked PREPAID and DAILY video jobs. No server startup auto-launch.
Requires compiled backend, migrations, DATABASE_URL. In production set
PRIVATE_FILES_STORAGE_MODE=shared-filesystem, absolute PRIVATE_FILES_DIR, and
canonical UUID PRIVATE_FILES_STORE_ID. Initialize with private-storage.mjs --init;
private-storage.mjs --check verifies readiness without DB/provider calls.
Each production batch checks storage before leases or provider I/O. Shared storage
is an operator attestation, not proof of replicas, backups, or physical durability.
Provider dispatch requires ACCOUNTED_VIDEO_JOBS_ENABLED=true, HF_VIDEO_ENDPOINT
(public HTTPS, no query/userinfo), HF_TOKEN. Live provider qualification is pending.
JWT creation and daily network dispatch ALSO require ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED=true.
Both flags default off. HTTP creation is NOT idempotent.

  --help            Print help without database/provider access
  --once            Process one bounded batch
  --batch-size N    1..100 (default 25)
  --concurrency N   1..16 (default 4; per worker process)
  --lease-ms N      1000..300000 (default 30000)
  --poll-ms N       100..60000 (default 1000; queue sweep delay)

Shared DB policy: VideoQueuePolicy id=1, version=1; no environment cap overrides.
Defaults: globalOutstanding=64, userOutstanding=8, globalActive=8, userActive=2.
Both billing pools and all API keys share these account/global limits.
DB admins change limits together in one UPDATE, incrementing revision (CAS with
WHERE revision=<previous>). SQL checks require positive bounded integers,
user<=global and active<=outstanding. Missing/invalid policy blocks new work.
Lowering limits drains occupancy; it does not cancel existing jobs.
Local concurrency only limits claimed work. Live queued leases earmark slots;
dispatch commits a durable upstreamSlot together with ledger/dispatch markers.
Polling, waiting, expired submitted leases and unknown/cancelled upstream work
retain that slot. Only confirmed settlement/completion frees it automatically.
Unknown work requires explicit DB-admin reconciliation against provider evidence
and settled ledger, never an age-based refund, slot clear, or repeat POST.
Lock order: policy -> accounted job -> media job -> ledger (daily User first;
prepaid reservation -> intent -> User). Ledger-only recovery never locks queue.
For operator reconciliation, confirm upstream termination AND linked ledger
settlement under that lock order, then atomically set the terminal job state and
clear upstreamSlot. A settled reservation alone does not prove upstream stopped.
Settlement/recovery claims bypass new-slot limits, including malformed policy.

HF_VIDEO_MAX_WAIT_MS: 1000..1800000 (default 1800000, original startedAt budget).
ACCOUNTED_VIDEO_REQUEST_MS: 1000..30000 (default 30000, per claim I/O budget).
ACCOUNTED_VIDEO_POLL_MS: 1000..60000 (default 5000, persisted provider poll delay).
ACCOUNTED_VIDEO_MAX_POLLS: 1..600 (default 600, includes failed/reclaimed attempts).
Only model loop-video, one MP4 clip; prepaid tariff or daily credits bound server-side.
No automatic POST retries. Unknown work retains funds for operator reconciliation.
Disabled/missing provider configuration pauses network jobs without claiming them.
The daily flag alone pauses daily network jobs; prepaid jobs continue normally.
Confirmed settling jobs may still capture/publish; original deadlines do not pause.
SIGINT/SIGTERM stops claims and best-effort aborts active network I/O.
Already accepted provider work cannot be recalled; persisted status allows GET recovery.
Inaccessible staged byte orphans can remain after crashes; no automatic GC is provided.
Exit: 0 advanced/idle, 1 retry/unavailable/interrupted, 2 arguments, 3 reconciliation.`

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') { console.log(help); return }
  const flags = { '--batch-size': ['batchSize', 1, 100], '--concurrency': ['concurrency', 1, 16],
    '--lease-ms': ['leaseMs', 1000, 300000], '--poll-ms': ['pollMs', 100, 60000] }
  const options = {}, seen = new Set()
  let once = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) { process.exitCode = 2; console.error('Invalid video worker arguments. Use --help.'); return }
    seen.add(arg)
    if (arg === '--once') { once = true; continue }
    const spec = Object.hasOwn(flags, arg) ? flags[arg] : undefined, value = args[++i]
    if (!spec || !value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < spec[1] || Number(value) > spec[2]) {
      process.exitCode = 2; console.error('Invalid video worker arguments. Use --help.'); return
    }
    options[spec[0]] = Number(value)
  }
  const require = createRequire(import.meta.url), stop = new AbortController()
  const shutdown = () => stop.abort()
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
  let prisma
  try {
    const service = require('../dist/services/videoJobWorker.js')
    ;({ prisma } = require('../dist/services/prisma.js'))
    const normalized = service.videoWorkerOptions(options)
    do {
      try {
        const result = await service.runVideoJobBatch(normalized, stop.signal)
        console.log(JSON.stringify({ event: 'video_job_batch', ...result }))
        if (once) process.exitCode = result.needs_reconciliation ? 3 : result.retry || result.paused || result.unavailable || result.lease_lost || result.aborted ? 1 : 0
      } catch { console.error('Video job storage unavailable. Durable work remains queued.'); if (once) process.exitCode = 1 }
      if (once || stop.signal.aborted) break
      await delay(normalized.pollMs, undefined, { signal: stop.signal }).catch(() => {})
    } while (!stop.signal.aborted)
  } catch { process.exitCode = 1; console.error('Video worker unavailable. Check build and database configuration.') }
  finally {
    await prisma?.$disconnect().catch(() => { process.exitCode = 1 })
    process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown)
  }
}
await main()
