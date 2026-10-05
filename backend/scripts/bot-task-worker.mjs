#!/usr/bin/env node
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const help = `Usage: node scripts/bot-task-worker.mjs [--once] [options]
Claim and execute queued autonomous agent tasks ("bot computer") using the
compiled backend services. Requires DATABASE_URL, the bot_tasks migration,
and the model provider env (HF_ENDPOINT_URL + HF_TOKEN). Run npm run build first.

  --help                 Print help without opening a database connection
  --once                 Process one bounded batch and exit
  --batch-size N         1..25 (default 1)
  --lease-ms N           30000..3600000 (default 600000)
  --poll-ms N            100..60000 (default 2000)

Continuous mode polls until SIGINT/SIGTERM, then lets the in-flight task's
lease expire so the next worker replays it. Exit codes: 0 completed,
1 unavailable or incomplete batch, 2 invalid arguments, 3 one-shot batch
contains dead letters. Retries remain durable.`

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') { console.log(help); return }
  const flags = { '--batch-size': ['batchSize', 1, 25], '--lease-ms': ['leaseMs', 30000, 3600000], '--poll-ms': ['pollMs', 100, 60000] }
  const options = {}, seen = new Set()
  let once = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) { process.exitCode = 2; console.error('Invalid bot worker arguments. Use --help.'); return }
    seen.add(arg)
    if (arg === '--once') { once = true; continue }
    const spec = Object.hasOwn(flags, arg) ? flags[arg] : undefined, value = args[++i]
    if (!spec || !value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < spec[1] || Number(value) > spec[2]) {
      process.exitCode = 2; console.error('Invalid bot worker arguments. Use --help.'); return
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
    const service = require('../dist/services/botWorker.js')
    ;({ prisma } = require('../dist/services/prisma.js'))
    const normalized = service.botWorkerOptions(options)
    do {
      try {
        const result = await service.runBotTaskBatch(normalized, stop.signal)
        console.log(JSON.stringify({ event: 'bot_task_batch', ...result }))
        if (once) process.exitCode = service.botWorkerExitCode(result)
      } catch {
        console.error('Bot task worker unavailable; queued tasks remain durable.')
        if (once) process.exitCode = 1
      }
      if (once || stop.signal.aborted) break
      await delay(normalized.pollMs, undefined, { signal: stop.signal }).catch(() => {})
    } while (!stop.signal.aborted)
  } catch {
    process.exitCode = 1
    console.error('Bot task worker unavailable. Check the build and database configuration.')
  } finally {
    await prisma?.$disconnect().catch(() => { process.exitCode = 1 })
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
  }
}
await main()
