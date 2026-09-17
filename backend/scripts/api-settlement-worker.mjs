#!/usr/bin/env node
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const help = `Usage: node scripts/api-settlement-worker.mjs [--once] [options]
Recover persisted PREPAID confirmed-usage intents using the compiled backend service.
Requires DATABASE_URL and an applied migration; run npm run build first.

  --help                 Print help without opening a database connection
  --once                 Process one bounded batch and exit
  --batch-size N         1..100 (default 25)
  --concurrency N        1..16 (default 4)
  --lease-ms N           1000..300000 (default 30000)
  --poll-ms N            100..60000 (default 1000)

Continuous mode polls until SIGINT/SIGTERM, then drains active captures.
Exit codes: 0 completed, 1 unavailable or incomplete batch, 2 invalid arguments,
3 one-shot batch contains conflicts or dead letters. Retries remain durable.`

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') { console.log(help); return }
  const flags = { '--batch-size': ['batchSize', 1, 100], '--concurrency': ['concurrency', 1, 16],
    '--lease-ms': ['leaseMs', 1000, 300000], '--poll-ms': ['pollMs', 100, 60000] }
  const options = {}, seen = new Set()
  let once = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) { process.exitCode = 2; console.error('Invalid API settlement worker arguments. Use --help.'); return }
    seen.add(arg)
    if (arg === '--once') { once = true; continue }
    const spec = Object.hasOwn(flags, arg) ? flags[arg] : undefined, value = args[++i]
    if (!spec || !value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < spec[1] || Number(value) > spec[2]) {
      process.exitCode = 2; console.error('Invalid API settlement worker arguments. Use --help.'); return
    }
    options[spec[0]] = Number(value)
  }
  const require = createRequire(import.meta.url)
  const stop = new AbortController()
  const shutdown = () => stop.abort()
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  let prisma
  try {
    const service = require('../dist/services/apiSettlementRecovery.js')
    ;({ prisma } = require('../dist/services/prisma.js'))
    const normalized = service.apiSettlementWorkerOptions(options)
    do {
      try {
        const result = await service.runApiSettlementBatch(normalized, stop.signal)
        console.log(JSON.stringify({ event: 'api_settlement_batch', ...result }))
        if (once) process.exitCode = service.apiSettlementExitCode(result)
      } catch {
        console.error('API settlement worker unavailable; persisted work remains recoverable.')
        if (once) process.exitCode = 1
      }
      if (once || stop.signal.aborted) break
      await delay(normalized.pollMs, undefined, { signal: stop.signal }).catch(() => {})
    } while (!stop.signal.aborted)
  } catch {
    process.exitCode = 1
    console.error('API settlement worker unavailable. Check the build and database configuration.')
  } finally {
    await prisma?.$disconnect().catch(() => { process.exitCode = 1 })
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
  }
}
await main()
