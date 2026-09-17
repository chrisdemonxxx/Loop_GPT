#!/usr/bin/env node
// Usage: after build/migrations, set DATABASE_URL=TEST_DATABASE_URL to the local
// loop_foundation_test database, then node scripts/api-settlement-smoke.mjs.
// Safe fixture-only check. No provider requests, payment accounts or real keys.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/api-settlement-smoke.mjs\nRequires matching DATABASE_URL and TEST_DATABASE_URL for local loop_foundation_test, compiled backend and applied migrations.')
    return
  }
  const raw = process.env.TEST_DATABASE_URL
  const url = new URL(raw || 'about:blank')
  assert.ok(raw && raw === process.env.DATABASE_URL && ['postgres:', 'postgresql:'].includes(url.protocol) &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/loop_foundation_test' &&
    [...url.searchParams.keys()].every(key => key === 'schema') &&
    (!url.searchParams.has('schema') || url.searchParams.get('schema') === 'public'), 'Dedicated local fixture database required')
  const require = createRequire(import.meta.url)
  const { prisma: db } = require('../dist/services/prisma.js')
  const ledger = require('../dist/services/apiReservations.js')
  const userId = `api-smoke-${randomUUID()}`, id = randomUUID()
  const input = { id, userId, costMicros: 40, tokensIn: 10, tokensOut: 10, expectedKind: 'chat', expectedModel: 'smoke-model' }
  try {
    await db.user.create({ data: { id: userId, email: `${userId}@example.test`, password: 'non-login-fixture', name: 'Smoke fixture', apiBalanceMicros: 10000n } })
    await ledger.reserveApiBalance({ id, userId, kind: 'chat', model: input.expectedModel, amountMicros: 100,
      requestFingerprint: ledger.apiFingerprint(['fixture', id]) })
    await ledger.dispatchApiReservation({ id, userId })
    await ledger.enqueueApiSettlement(input)
    await ledger.markApiReservationUnknown({ id, userId })
    const worker = () => spawnSync(process.execPath, [fileURLToPath(new URL('./api-settlement-worker.mjs', import.meta.url)), '--once'],
      { env: process.env, encoding: 'utf8', timeout: 20000 })
    const first = worker()
    assert.equal(first.status, 0, first.stderr)
    assert.equal((await db.apiSettlementIntent.findUniqueOrThrow({ where: { reservationId: id } })).status, 'succeeded')
    assert.equal(await ledger.captureApiReservation(input), 40)
    const second = worker()
    assert.equal(second.status, 0, second.stderr)
    const account = await db.user.findUniqueOrThrow({ where: { id: userId } })
    assert.equal(account.apiBalanceMicros, 9960n)
    assert.equal(await db.apiUsage.count({ where: { reservationId: id } }), 1)
    console.log(`capture recovered exactly once; uid=${process.getuid?.() ?? 'windows'}; balance=9960; usage=1`)
  } finally {
    try {
      await db.$transaction([
        db.apiSettlementIntent.deleteMany({ where: { reservationId: id, userId } }),
        db.apiUsage.deleteMany({ where: { reservationId: id, userId } }),
        db.apiReservation.deleteMany({ where: { id, userId } }),
        db.user.deleteMany({ where: { id: userId } }),
      ])
    } finally { await db.$disconnect() }
  }
}
main().catch(() => { console.error('Prepaid fixture smoke failed; check the dedicated database and build.'); process.exitCode = 1 })
