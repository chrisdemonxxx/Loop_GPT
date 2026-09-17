import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../prisma'
import { recordUsage } from '../billing'
import { captureDailySettlement, cleanupDailyReservation, enqueueDailySettlement, finishDailyFailure, markDailyDispatched, reserveDailyCredits } from '../dailyReservations'
import { claimDailySettlements, recoverDailySettlement, runDailySettlementBatch } from '../dailySettlementRecovery'

const db = prisma!
const prefix = `settlement-${randomUUID()}`
let userId: string
const metrics = { tokensIn: 17, tokensOut: 23, model: 'fixture-model' }
const account = () => db.user.findUniqueOrThrow({ where: { id: userId } })
const intent = (id: string) => db.dailySettlementIntent.findUniqueOrThrow({ where: { reservationId: id } })
async function hold(enqueue = true) {
  const row = await reserveDailyCredits(userId, 'chat', metrics.model)
  await markDailyDispatched(row.id)
  if (enqueue) await enqueueDailySettlement(row.id, userId, 'chat', metrics)
  return row
}
async function expire(id: string) {
  await db.$executeRaw`UPDATE "DailySettlementIntent" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "reservationId" = ${id}`
}
async function due(id: string) {
  await db.$executeRaw`UPDATE "DailySettlementIntent" SET "nextAttemptAt" = clock_timestamp() - interval '1 second' WHERE "reservationId" = ${id}`
}
async function usageFailure() {
  await db.$executeRawUnsafe(`CREATE FUNCTION settlement_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private fixture exception'; END $$`)
  await db.$executeRawUnsafe(`CREATE TRIGGER settlement_test_failure BEFORE INSERT ON "UsageEvent" FOR EACH ROW EXECUTE FUNCTION settlement_test_failure()`)
}
async function removeUsageFailure() {
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS settlement_test_failure ON "UsageEvent"')
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS settlement_test_failure()')
}
beforeEach(async () => {
  userId = `${prefix}-${randomUUID()}`
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, password: 'fixture', name: 'Fixture', credits: 1000 } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await removeUsageFailure()
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS settlement_test_ack_failure ON "DailySettlementIntent"')
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS settlement_test_ack_failure()')
  await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS settlement_test_intent_failure ON "DailySettlementIntent"')
  await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS settlement_test_intent_failure()')
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
})
afterAll(async () => { await db.$disconnect() })

describe('durable daily settlement evidence on PostgreSQL', () => {
  it('serializes exact concurrent enqueue and rejects conflicting actor, kind, metrics and model', async () => {
    const row = await hold(false)
    const results = await Promise.all(Array.from({ length: 12 }, () => enqueueDailySettlement(row.id, userId, 'chat', metrics)))
    expect(new Set(results.map(r => r.fingerprint)).size).toBe(1)
    expect(await db.dailySettlementIntent.count({ where: { reservationId: row.id } })).toBe(1)
    for (const call of [() => enqueueDailySettlement(row.id, userId, 'chat', { ...metrics, tokensIn: 18 }),
      () => enqueueDailySettlement(row.id, 'foreign', 'chat', metrics), () => enqueueDailySettlement(row.id, userId, 'video', metrics),
      () => enqueueDailySettlement(row.id, userId, 'chat', { ...metrics, model: 'foreign' })]) {
      await expect(call()).rejects.toMatchObject({ status: 409 })
    }
    expect(await intent(row.id)).toEqual(results[0])
    await expect(db.dailySettlementIntent.update({ where: { reservationId: row.id }, data: { tokensIn: 99 } })).rejects.toThrow()
    expect((await intent(row.id)).tokensIn).toBe(17)
  })
  it('allows only one of two conflicting concurrent payloads to become immutable evidence', async () => {
    const row = await hold(false)
    const results = await Promise.allSettled([enqueueDailySettlement(row.id, userId, 'chat', metrics),
      enqueueDailySettlement(row.id, userId, 'chat', { ...metrics, tokensOut: 24 })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  })
  it('does not capture if intent persistence fails', async () => {
    const row = await hold(false)
    await db.$executeRawUnsafe(`CREATE FUNCTION settlement_test_intent_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private intent write failure'; END $$`)
    await db.$executeRawUnsafe(`CREATE TRIGGER settlement_test_intent_failure BEFORE INSERT ON "DailySettlementIntent" FOR EACH ROW EXECUTE FUNCTION settlement_test_intent_failure()`)
    await expect(recordUsage(userId, 'chat', { reservationId: row.id, ...metrics })).rejects.toMatchObject({ status: 503 })
    expect(await db.dailySettlementIntent.count({ where: { reservationId: row.id } })).toBe(0)
    expect(await db.usageEvent.count({ where: { reservationId: row.id } })).toBe(0)
    expect(await account()).toMatchObject({ messagesTotal: 0, tokensInTotal: 0n, credits: 999 })
    await cleanupDailyReservation(row.id)
    expect((await runDailySettlementBatch()).claimed).toBe(0)
  })
  it('refuses undispatched/released intents and never cleans up unknown holds lacking metrics', async () => {
    const reserved = await reserveDailyCredits(userId, 'chat', metrics.model)
    await expect(enqueueDailySettlement(reserved.id, userId, 'chat', metrics)).rejects.toMatchObject({ status: 409 })
    await finishDailyFailure(reserved.id)
    await expect(enqueueDailySettlement(reserved.id, userId, 'chat', metrics)).rejects.toMatchObject({ status: 409 })
    const unknown = await hold(false); await finishDailyFailure(unknown.id)
    expect((await runDailySettlementBatch()).claimed).toBe(0)
    expect(await db.dailyReservation.findUnique({ where: { id: unknown.id } })).toMatchObject({ state: 'unknown' })
    expect(await account()).toMatchObject({ credits: 999, messagesTotal: 0 })
  })
  it('persists metrics before failed capture, fails the response, then recovers unknown work after a restart boundary', async () => {
    const row = await hold(false)
    await usageFailure()
    await expect(recordUsage(userId, 'chat', { reservationId: row.id, ...metrics })).rejects.toMatchObject({ status: 503, message: 'Daily credit accounting unavailable' })
    expect(await intent(row.id)).toMatchObject({ status: 'pending', ...metrics })
    expect(await account()).toMatchObject({ tokensInTotal: 0n, messagesTotal: 0, credits: 999 })
    await cleanupDailyReservation(row.id)
    await removeUsageFailure()
    // Actual separate Node process, compiled service, real PostgreSQL. No mocks.
    const result = await cli(['--once', '--batch-size', '2', '--concurrency', '1'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('"succeeded":1')
    expect(await intent(row.id)).toMatchObject({ status: 'succeeded', attempts: 1 })
    expect(await account()).toMatchObject({ tokensInTotal: 17n, tokensOutTotal: 23n, messagesTotal: 1, credits: 999 })
    await cleanupDailyReservation(row.id)
    expect(await db.dailyReservation.findUnique({ where: { id: row.id } })).toMatchObject({ state: 'captured' })
  })
})

describe('distributed leases and idempotent recovery on PostgreSQL', () => {
  it('claims only free consumer slots, not an entire locally queued batch', async () => {
    for (let i = 0; i < 6; i++) await hold()
    const query = db.$queryRaw.bind(db)
    const waveSizes: number[] = []
    vi.spyOn(db, '$queryRaw').mockImplementation(async (...args: any[]) => {
      const result = await (query as any)(...args)
      if (String(args[0]).includes('WITH candidates')) waveSizes.push(result.length)
      return result
    })
    expect(await runDailySettlementBatch({ batchSize: 6, concurrency: 1, leaseMs: 1000 })).toMatchObject({
      claimed: 6, succeeded: 6, unprocessed: 0, aborted: false,
    })
    expect(waveSizes).toEqual([1, 1, 1, 1, 1, 1])
    expect(await db.dailySettlementIntent.count({ where: { userId, attempts: 1, status: 'succeeded' } })).toBe(6)
    expect((await account()).messagesTotal).toBe(6)
  })
  it('reports cancellation during claim and leaves only that wave for lease recovery', async () => {
    for (let i = 0; i < 3; i++) await hold()
    const controller = new AbortController()
    const query = db.$queryRaw.bind(db)
    vi.spyOn(db, '$queryRaw').mockImplementationOnce(async (...args: any[]) => {
      const result = await (query as any)(...args)
      controller.abort()
      return result
    })
    expect(await runDailySettlementBatch({ batchSize: 3, concurrency: 1 }, controller.signal)).toMatchObject({
      claimed: 1, succeeded: 0, unprocessed: 1, aborted: true,
    })
    expect(await db.dailySettlementIntent.count({ where: { userId, status: 'pending', attempts: 0 } })).toBe(2)
    expect((await account()).messagesTotal).toBe(0)
  })
  it('does not claim more work after an in-flight capture completes during cancellation', async () => {
    for (let i = 0; i < 3; i++) await hold()
    const controller = new AbortController()
    const transaction = db.$transaction.bind(db)
    vi.spyOn(db, '$transaction').mockImplementationOnce(async (...args: any[]) => {
      const result = await (transaction as any)(...args)
      controller.abort()
      return result
    })
    expect(await runDailySettlementBatch({ batchSize: 3, concurrency: 1 }, controller.signal)).toMatchObject({
      claimed: 1, succeeded: 1, unprocessed: 0, aborted: true,
    })
    expect(await db.dailySettlementIntent.count({ where: { userId, status: 'pending', attempts: 0 } })).toBe(2)
    expect((await account()).messagesTotal).toBe(1)
  })
  it('claims disjoint bounded batches concurrently', async () => {
    await Promise.all(Array.from({ length: 12 }, () => hold()))
    const batches = await Promise.all(Array.from({ length: 4 }, () => claimDailySettlements({ batchSize: 3 })))
    expect(batches.map(b => b.length)).toEqual([3, 3, 3, 3])
    const claims = batches.flat()
    expect(new Set(claims.map(c => c.reservationId)).size).toBe(12)
    expect(await claimDailySettlements()).toEqual([])
    await Promise.all(claims.map(c => recoverDailySettlement(c)))
    expect(await account()).toMatchObject({ messagesTotal: 12, tokensInTotal: 204n })
    expect(await db.usageEvent.count({ where: { userId } })).toBe(12)
  })
  it('SKIP LOCKED skips a row held by another transaction', async () => {
    const first = await hold(), second = await hold()
    let locked!: () => void, release!: () => void
    const acquired = new Promise<void>(resolve => { locked = resolve })
    const released = new Promise<void>(resolve => { release = resolve })
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "reservationId" FROM "DailySettlementIntent" WHERE "reservationId" = ${first.id} FOR UPDATE`
      locked(); await released
    })
    try {
      await acquired
      const claims = await claimDailySettlements({ batchSize: 2 })
      expect(claims.map(c => c.reservationId)).toEqual([second.id])
    } finally { release(); await blocker }
  })
  it('rejects expired and reclaimed fencing tokens, including stale acknowledgement/cleanup', async () => {
    const row = await hold()
    const [stale] = await claimDailySettlements({ leaseMs: 1000 })
    await expire(row.id)
    expect(await recoverDailySettlement(stale)).toBe('lease_lost')
    expect((await account()).messagesTotal).toBe(0)
    const [fresh] = await claimDailySettlements()
    expect(fresh.leaseToken).not.toBe(stale.leaseToken)
    expect(await recoverDailySettlement(stale)).toBe('lease_lost')
    expect(await recoverDailySettlement(fresh)).toBe('succeeded')
    expect(await recoverDailySettlement(stale)).toBe('lease_lost')
    await cleanupDailyReservation(row.id)
    expect(await intent(row.id)).toMatchObject({ status: 'succeeded', attempts: 2, leaseToken: null })
    expect((await account()).messagesTotal).toBe(1)
  })
  it('duplicate same-claim workers and foreground retries never duplicate usage', async () => {
    const row = await hold()
    const [claim] = await claimDailySettlements()
    await Promise.all([recoverDailySettlement(claim), recoverDailySettlement(claim),
      recordUsage(userId, 'chat', { reservationId: row.id, ...metrics }), cleanupDailyReservation(row.id)])
    expect(await db.usageEvent.count({ where: { reservationId: row.id } })).toBe(1)
    expect(await account()).toMatchObject({ messagesTotal: 1, tokensInTotal: 17n, credits: 999 })
    expect((await intent(row.id)).status).toBe('succeeded')
  })
  it('foreground capture retires a competing lease so stale work cannot regress success', async () => {
    const row = await hold()
    const [claim] = await claimDailySettlements()
    await recordUsage(userId, 'chat', { reservationId: row.id, ...metrics })
    expect(await intent(row.id)).toMatchObject({ status: 'succeeded', leaseToken: null })
    expect(await recoverDailySettlement(claim)).toBe('lease_lost')
    expect((await intent(row.id)).status).toBe('succeeded')
    expect((await account()).messagesTotal).toBe(1)
  })
  it('survives actual capture commit followed by database acknowledgement failure', async () => {
    const row = await hold()
    const [claim] = await claimDailySettlements()
    await db.$executeRawUnsafe(`CREATE FUNCTION settlement_test_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."status" = 'succeeded' THEN RAISE EXCEPTION 'private acknowledgement failure'; END IF; RETURN NEW; END $$`)
    await db.$executeRawUnsafe(`CREATE TRIGGER settlement_test_ack_failure BEFORE UPDATE ON "DailySettlementIntent" FOR EACH ROW EXECUTE FUNCTION settlement_test_ack_failure()`)
    await expect(recoverDailySettlement(claim)).rejects.toThrow()
    expect(await db.dailyReservation.findUnique({ where: { id: row.id } })).toMatchObject({ state: 'captured' })
    expect((await intent(row.id)).status).toBe('processing')
    await db.$executeRawUnsafe('DROP TRIGGER settlement_test_ack_failure ON "DailySettlementIntent"')
    await expire(row.id)
    expect((await runDailySettlementBatch()).succeeded).toBe(1)
    expect((await account()).messagesTotal).toBe(1)
    expect(await db.usageEvent.count({ where: { reservationId: row.id } })).toBe(1)
  })
  it('reconciles an ambiguous committed capture without dead-letter regression at the attempt limit', async () => {
    const row = await hold()
    await db.dailySettlementIntent.update({ where: { reservationId: row.id }, data: { attempts: 9 } })
    const [claim] = await claimDailySettlements()
    // Commit on real PG, then simulate losing the driver's commit response.
    // All subsequent recovery reads/locks/acknowledgements still use real PG.
    const transaction = db.$transaction.bind(db)
    vi.spyOn(db, '$transaction').mockImplementationOnce(async (...args: any[]) => {
      await (transaction as any)(...args)
      throw new Error('private ambiguous commit response')
    })
    expect(await recoverDailySettlement(claim)).toBe('succeeded')
    expect(await intent(row.id)).toMatchObject({ status: 'succeeded', attempts: 10, lastErrorCode: null })
    expect((await account()).messagesTotal).toBe(1)
    expect(await db.usageEvent.count({ where: { reservationId: row.id } })).toBe(1)
  })
  it('schedules deterministic DB-clock backoff with sanitized codes, then recovers', async () => {
    const row = await hold(); await usageFailure()
    expect((await runDailySettlementBatch()).retry).toBe(1)
    const failed = await intent(row.id)
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastErrorCode: 'DAILY_CAPTURE_RETRY', leaseToken: null })
    expect(failed.nextAttemptAt.getTime() - failed.updatedAt.getTime()).toBe(1000)
    expect(await claimDailySettlements()).toEqual([])
    await due(row.id)
    expect((await runDailySettlementBatch()).retry).toBe(1)
    const second = await intent(row.id)
    expect(second.nextAttemptAt.getTime() - second.updatedAt.getTime()).toBe(2000)
    await removeUsageFailure(); await due(row.id)
    expect((await runDailySettlementBatch()).succeeded).toBe(1)
  })
  it('dead-letters exhausted captures without a refund or resetting terminal state', async () => {
    const row = await hold(); await usageFailure()
    await db.dailySettlementIntent.update({ where: { reservationId: row.id }, data: { attempts: 9 } })
    expect((await runDailySettlementBatch()).dead_letter).toBe(1)
    await removeUsageFailure(); await due(row.id)
    expect(await claimDailySettlements()).toEqual([])
    await expect(recordUsage(userId, 'chat', { reservationId: row.id, ...metrics })).rejects.toMatchObject({ status: 409 })
    expect(await account()).toMatchObject({ messagesTotal: 0, credits: 999 })
  })
  it('acknowledges a capture even after the final lease was lost; never recaptures exhausted uncaptured work', async () => {
    const captured = await hold(), uncaptured = await hold()
    await db.dailySettlementIntent.updateMany({ where: { userId }, data: { attempts: 9 } })
    const claims = await claimDailySettlements()
    await captureDailySettlement(captured.id, claims.find(c => c.reservationId === captured.id)!)
    await expire(captured.id); await expire(uncaptured.id)
    const summary = await runDailySettlementBatch()
    expect(summary).toMatchObject({ succeeded: 1, dead_letter: 1 })
    expect((await account()).messagesTotal).toBe(1)
  })
  it.each(['released', 'captured', 'model', 'duplicate-event'])('marks permanent %s conflicts terminal and retains deductions', async cause => {
    const row = await hold()
    if (cause === 'model') await db.dailyReservation.update({ where: { id: row.id }, data: { model: 'changed' } })
    else if (cause === 'duplicate-event') await db.usageEvent.create({ data: { reservationId: row.id, userId, kind: 'chat', tokensIn: 99 } })
    else await db.dailyReservation.update({ where: { id: row.id }, data: { state: cause as 'released' | 'captured', settlementFingerprint: 'different' } })
    expect((await runDailySettlementBatch()).conflict).toBe(1)
    expect(await intent(row.id)).toMatchObject({ status: 'conflict', lastErrorCode: 'DAILY_SETTLEMENT_CONFLICT' })
    expect(await claimDailySettlements()).toEqual([])
    expect(await account()).toMatchObject({ credits: 999, messagesTotal: 0 })
  })
  it.each(['SIGTERM', 'SIGINT'] as const)('continuous CLI polls real work and drains on %s', async signal => {
    await hold()
    const result = await cli(['--poll-ms', '100', '--batch-size', '1'], signal)
    // Windows child.kill is forceful; only POSIX can assert graceful shutdown.
    if (process.platform === 'win32') expect(result.signal).toBe(signal)
    else expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('"succeeded":1')
    expect((await account()).messagesTotal).toBe(1)
  })
})

function cli(args: string[], stopAfterBatch?: 'SIGTERM' | 'SIGINT'): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/daily-settlement-worker.mjs'), ...args], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', stopped = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture worker timed out')) }, 12000)
    child.stdout.on('data', data => {
      stdout += data
      if (stopAfterBatch && !stopped && stdout.includes('"succeeded":1')) {
        stopped = true
        child.kill(stopAfterBatch)
      }
    })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ code, signal, stdout, stderr })
    })
  })
}
