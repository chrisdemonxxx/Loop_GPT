import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../prisma'
import { chargeUsage } from '../apiBilling'
import { abandonApiReservation, apiFingerprint, captureApiReservation, captureApiSettlement, dispatchApiReservation,
  enqueueApiSettlement, reserveApiBalance, settleApiReservation, type ApiCaptureInput } from '../apiReservations'
import { claimApiSettlements, recoverApiSettlement, runApiSettlementBatch } from '../apiSettlementRecovery'

const db = prisma!
const prefix = `api-settlement-${randomUUID()}`
let userId: string, apiKeyId: string
const account = () => db.user.findUniqueOrThrow({ where: { id: userId } })
const intent = (id: string) => db.apiSettlementIntent.findUniqueOrThrow({ where: { reservationId: id } })
const reservation = (id: string) => db.apiReservation.findUniqueOrThrow({ where: { id } })
async function hold(enqueue = true): Promise<ApiCaptureInput> {
  const input = { id: randomUUID(), userId, apiKeyId, expectedKind: 'chat' as const, expectedModel: 'fixture', costMicros: 40, tokensIn: 10, tokensOut: 10 }
  await reserveApiBalance({ ...input, kind: input.expectedKind, model: input.expectedModel, amountMicros: 100, requestFingerprint: apiFingerprint(['server-fixture']) })
  await dispatchApiReservation(input)
  if (enqueue) await enqueueApiSettlement(input)
  return input
}
async function expire(id: string) {
  await db.$executeRaw`UPDATE "ApiSettlementIntent" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "reservationId" = ${id}`
}
async function due(id: string) {
  await db.$executeRaw`UPDATE "ApiSettlementIntent" SET "nextAttemptAt" = clock_timestamp() - interval '1 second' WHERE "reservationId" = ${id}`
}
async function failWrites(table: 'ApiUsage' | 'ApiSettlementIntent', phase: 'capture' | 'intent' | 'ack') {
  const conditional = phase === 'ack' ? `IF NEW."status" = 'succeeded' THEN RAISE EXCEPTION 'private fixture failure'; END IF; RETURN NEW;` : `RAISE EXCEPTION 'private fixture failure';`
  await db.$executeRawUnsafe(`CREATE FUNCTION api_test_${phase}_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${conditional} END $$`)
  await db.$executeRawUnsafe(`CREATE TRIGGER api_test_${phase}_failure BEFORE ${phase === 'ack' ? 'UPDATE' : 'INSERT'} ON "${table}" FOR EACH ROW EXECUTE FUNCTION api_test_${phase}_failure()`)
}
async function removeFailure(table: string, phase: string) {
  await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS api_test_${phase}_failure ON "${table}"`)
  await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS api_test_${phase}_failure()`)
}
beforeEach(async () => {
  userId = `${prefix}-${randomUUID()}`
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, name: 'Fixture', password: 'fixture', apiBalanceMicros: 10000n } })
  apiKeyId = (await db.apiKey.create({ data: { userId, keyHash: randomUUID(), prefix: 'fixture' } })).id
})
afterEach(async () => {
  vi.restoreAllMocks()
  await removeFailure('ApiUsage', 'capture')
  await removeFailure('ApiSettlementIntent', 'intent')
  await removeFailure('ApiSettlementIntent', 'ack')
  await db.apiSettlementIntent.deleteMany({ where: { userId } })
  await db.apiUsage.deleteMany({ where: { userId } })
  await db.apiReservation.deleteMany({ where: { userId } })
  await db.apiKey.deleteMany({ where: { userId } })
  await db.user.delete({ where: { id: userId } })
})
afterAll(async () => { await db.$disconnect() })

describe('immutable prepaid confirmed-usage intent on PostgreSQL', () => {
  it('converges concurrent exact intents; rejects changed owner/key/kind/model/metrics/cost', async () => {
    const input = await hold(false)
    const results = await Promise.all(Array.from({ length: 12 }, () => enqueueApiSettlement(input)))
    expect(new Set(results.map(r => r!.fingerprint)).size).toBe(1)
    const before = await intent(input.id)
    for (const patch of [{ userId: 'foreign' }, { apiKeyId: null }, { apiKeyId: 'foreign' }, { expectedKind: 'video' as const },
      { expectedModel: 'other' }, { costMicros: 41 }, { tokensIn: 11 }, { units: 1 }]) {
      await expect(enqueueApiSettlement({ ...input, ...patch })).rejects.toMatchObject({ code: expect.stringMatching(/conflict|invalid_owner/) })
    }
    expect(await intent(input.id)).toEqual(before)
    for (const data of [{ tokensIn: 99 }, { userId: 'foreign' }, { apiKeyId: null }, { costMicros: 41n }, { reconciliationReference: 'changed' }]) {
      await expect(db.apiSettlementIntent.update({ where: { reservationId: input.id }, data })).rejects.toThrow()
    }
    expect((await account()).apiBalanceMicros).toBe(9900n)
  })
  it('has one winner for conflicting concurrent confirmed usage', async () => {
    const input = await hold(false)
    const result = await Promise.allSettled([enqueueApiSettlement(input), enqueueApiSettlement({ ...input, costMicros: 41 })])
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter(r => r.status === 'rejected')).toHaveLength(1)
  })
  it('binds nullable keys and permits capture after key revocation without allowing another key', async () => {
    const input = await hold(false)
    const other = await db.apiKey.create({ data: { userId, keyHash: randomUUID(), prefix: 'fixture' } })
    await expect(enqueueApiSettlement({ ...input, apiKeyId: other.id })).rejects.toMatchObject({ code: 'invalid_owner' })
    await db.apiKey.update({ where: { id: apiKeyId }, data: { revoked: true } })
    expect(await captureApiReservation(input)).toBe(40)
    const noKey = { ...input, id: randomUUID(), apiKeyId: null }
    await reserveApiBalance({ ...noKey, kind: 'chat', model: 'fixture', amountMicros: 100, requestFingerprint: apiFingerprint('server') })
    await dispatchApiReservation(noKey)
    expect(await captureApiReservation(noKey)).toBe(40)
    expect((await intent(noKey.id)).apiKeyId).toBeNull()
  })
  it('rejects oversized/invalid costs and metrics without creating evidence', async () => {
    const input = await hold(false)
    for (const patch of [{ costMicros: 101 }, { costMicros: -1 }, { costMicros: NaN }, { tokensIn: 2147483648 }, { units: -1 }]) {
      await expect(captureApiReservation({ ...input, ...patch })).rejects.toMatchObject({ code: 'invalid_amount' })
    }
    expect(await db.apiSettlementIntent.count({ where: { reservationId: input.id } })).toBe(0)
    expect((await account()).apiBalanceMicros).toBe(9900n)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
  })
  it('never settles when the intent commit fails', async () => {
    const input = await hold(false)
    await failWrites('ApiSettlementIntent', 'intent')
    await expect(captureApiReservation(input)).rejects.toThrow()
    expect(await db.apiSettlementIntent.count({ where: { userId } })).toBe(0)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
    expect((await account()).apiBalanceMicros).toBe(9900n)
  })
  it('chargeUsage commits intent before failed capture and CLI recovers retained unknown work', async () => {
    const input = await hold(false)
    await failWrites('ApiUsage', 'capture')
    await expect(chargeUsage({ reservationId: input.id, userId, apiKeyId, kind: 'chat', model: 'fixture', tokensIn: 10, tokensOut: 10 })).rejects.toThrow()
    expect(await intent(input.id)).toMatchObject({ status: 'pending', costMicros: 40n, tokensIn: 10, tokensOut: 10 })
    expect((await account()).apiBalanceMicros).toBe(9900n)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
    await abandonApiReservation(input)
    await removeFailure('ApiUsage', 'capture')
    const result = await cli(['--once', '--batch-size', '2', '--concurrency', '1'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('"succeeded":1')
    expect(result.stdout).not.toContain(input.id)
    expect(await intent(input.id)).toMatchObject({ status: 'succeeded', attempts: 1 })
    expect((await account()).apiBalanceMicros).toBe(9960n)
    expect(await captureApiReservation(input)).toBe(40)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it('never scans unknown/dispatched holds without intents, or admits reserved/released work', async () => {
    const unknown = await hold(false), dispatched = await hold(false)
    await abandonApiReservation(unknown, 2)
    const reserved = { ...unknown, id: randomUUID() }
    await reserveApiBalance({ ...reserved, kind: 'chat', model: 'fixture', amountMicros: 100, requestFingerprint: apiFingerprint('server') })
    await expect(enqueueApiSettlement(reserved)).rejects.toMatchObject({ code: 'conflict' })
    await abandonApiReservation({ id: reserved.id, userId, apiKeyId })
    await expect(enqueueApiSettlement(reserved)).rejects.toMatchObject({ code: 'conflict' })
    expect((await runApiSettlementBatch()).claimed).toBe(0)
    expect((await reservation(unknown.id)).state).toBe('unknown')
    expect((await reservation(dispatched.id)).state).toBe('dispatched')
    expect((await account()).apiBalanceMicros).toBe(9800n)
  })
  it('preserves exact historical captures without adding intents or rewriting fingerprints/evidence', async () => {
    const input = await hold(false)
    await settleApiReservation({ ...input, outcome: 'capture' })
    const before = await reservation(input.id)
    expect(await captureApiReservation(input)).toBe(40)
    expect(await reservation(input.id)).toEqual(before)
    expect(await db.apiSettlementIntent.count({ where: { userId } })).toBe(0)
    await expect(captureApiReservation({ ...input, costMicros: 41 })).rejects.toMatchObject({ code: 'conflict' })
    const manual = await hold(false)
    await abandonApiReservation(manual)
    await settleApiReservation({ ...manual, outcome: 'capture', reconciliationReference: 'operator:fixture' })
    const reconciled = await reservation(manual.id)
    await expect(captureApiReservation(manual)).rejects.toMatchObject({ code: 'conflict' })
    expect(await reservation(manual.id)).toEqual(reconciled)
  })
})

describe('prepaid distributed recovery on PostgreSQL', () => {
  it('claims only free slots, bounds waves, and reports interruption during claims', async () => {
    for (let i = 0; i < 6; i++) await hold()
    const query = db.$queryRaw.bind(db), waves: number[] = []
    vi.spyOn(db, '$queryRaw').mockImplementation(async (...args: any[]) => {
      const result = await (query as any)(...args)
      if (String(args[0]).includes('WITH candidates')) waves.push(result.length)
      return result
    })
    expect(await runApiSettlementBatch({ batchSize: 6, concurrency: 1 })).toMatchObject({ claimed: 6, succeeded: 6, unprocessed: 0 })
    expect(waves).toEqual([1, 1, 1, 1, 1, 1])
    for (let i = 0; i < 3; i++) await hold()
    const controller = new AbortController()
    vi.spyOn(db, '$queryRaw').mockImplementationOnce(async (...args: any[]) => {
      const result = await (query as any)(...args); controller.abort(); return result
    })
    expect(await runApiSettlementBatch({ batchSize: 3, concurrency: 1 }, controller.signal)).toMatchObject({ claimed: 1, succeeded: 0, unprocessed: 1, aborted: true })
    expect(await db.apiSettlementIntent.count({ where: { userId, status: 'pending', attempts: 0 } })).toBe(2)
  })
  it('drains active capture on cancellation without leasing another wave', async () => {
    for (let i = 0; i < 3; i++) await hold()
    const controller = new AbortController(), transaction = db.$transaction.bind(db)
    vi.spyOn(db, '$transaction').mockImplementationOnce(async (...args: any[]) => {
      const result = await (transaction as any)(...args); controller.abort(); return result
    })
    expect(await runApiSettlementBatch({ batchSize: 3, concurrency: 1 }, controller.signal)).toMatchObject({ claimed: 1, succeeded: 1, aborted: true })
    expect(await db.apiSettlementIntent.count({ where: { userId, status: 'pending', attempts: 0 } })).toBe(2)
  })
  it('claims disjoint batches across workers and duplicate claims never duplicate money or usage', async () => {
    for (let i = 0; i < 8; i++) await hold()
    const batches = await Promise.all(Array.from({ length: 4 }, () => claimApiSettlements({ batchSize: 2 })))
    expect(batches.map(b => b.length)).toEqual([2, 2, 2, 2])
    const claims = batches.flat()
    expect(new Set(claims.map(c => c.reservationId)).size).toBe(8)
    await Promise.all(claims.flatMap(c => [recoverApiSettlement(c), recoverApiSettlement(c)]))
    expect(await db.apiUsage.count({ where: { userId } })).toBe(8)
    expect((await account()).apiBalanceMicros).toBe(9680n)
    expect(await db.apiSettlementIntent.count({ where: { userId, status: 'succeeded' } })).toBe(8)
  })
  it('SKIP LOCKED skips held intent rows', async () => {
    const first = await hold(), second = await hold()
    let locked!: () => void, release!: () => void
    const acquired = new Promise<void>(r => { locked = r }), released = new Promise<void>(r => { release = r })
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "reservationId" FROM "ApiSettlementIntent" WHERE "reservationId" = ${first.id} FOR UPDATE`
      locked(); await released
    })
    try { await acquired; expect((await claimApiSettlements()).map(c => c.reservationId)).toEqual([second.id]) }
    finally { release(); await blocker }
  })
  it('rechecks stale leases after waiting on the reservation lock', async () => {
    const input = await hold(), [stale] = await claimApiSettlements()
    let locked!: () => void, release!: () => void
    const acquired = new Promise<void>(r => { locked = r }), released = new Promise<void>(r => { release = r })
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${input.id} FOR UPDATE`
      locked(); await released
    })
    await acquired
    const staleWork = recoverApiSettlement(stale)
    let fresh
    try { await expire(input.id); [fresh] = await claimApiSettlements() }
    finally { release(); await blocker }
    expect(await staleWork).toBe('lease_lost')
    expect((await account()).apiBalanceMicros).toBe(9900n)
    expect(await recoverApiSettlement(fresh!)).toBe('succeeded')
    expect(await recoverApiSettlement(stale)).toBe('lease_lost')
    expect((await intent(input.id)).status).toBe('succeeded')
  })
  it('holds the fence lock through capture even when its clock lease expires mid-transaction', async () => {
    const input = await hold(), [claim] = await claimApiSettlements({ leaseMs: 1000 })
    let fenced!: () => void, release!: () => void
    const acquired = new Promise<void>(r => { fenced = r }), released = new Promise<void>(r => { release = r })
    const transaction = db.$transaction.bind(db)
    // Pause at the real usage insert, after fence validation. All DB operations
    // still execute against PostgreSQL in the original capture transaction.
    vi.spyOn(db, '$transaction').mockImplementationOnce(((work: any, options: any) => transaction(async tx => {
      const create = tx.apiUsage.create.bind(tx.apiUsage)
      tx.apiUsage.create = (async (args: any) => { fenced(); await released; return create(args) }) as any
      return work(tx)
    }, options)) as any)
    const work = recoverApiSettlement(claim)
    try {
      await acquired
      await new Promise(r => setTimeout(r, 1100))
      expect(await claimApiSettlements()).toEqual([])
    } finally { release() }
    expect(await work).toBe('lease_lost')
    expect((await reservation(input.id)).state).toBe('captured')
    expect((await runApiSettlementBatch()).succeeded).toBe(1)
    expect((await account()).apiBalanceMicros).toBe(9960n)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it('foreground retires a competing lease and stale callbacks cannot reset success', async () => {
    const input = await hold(), [claim] = await claimApiSettlements()
    await Promise.all([captureApiReservation(input), captureApiReservation(input), recoverApiSettlement(claim), abandonApiReservation(input)])
    expect((await intent(input.id)).status).toBe('succeeded')
    expect(await recoverApiSettlement(claim)).toBe('lease_lost')
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
    expect((await account()).apiBalanceMicros).toBe(9960n)
  })
  it('replays capture commit after actual acknowledgement failure exactly once', async () => {
    const input = await hold(), [claim] = await claimApiSettlements()
    await failWrites('ApiSettlementIntent', 'ack')
    await expect(recoverApiSettlement(claim)).rejects.toThrow()
    expect((await reservation(input.id)).state).toBe('captured')
    expect((await intent(input.id)).status).toBe('processing')
    await removeFailure('ApiSettlementIntent', 'ack'); await expire(input.id)
    expect((await runApiSettlementBatch()).succeeded).toBe(1)
    expect((await account()).apiBalanceMicros).toBe(9960n)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it('reconciles an ambiguous committed capture at the attempt limit before recording failure', async () => {
    const input = await hold()
    await db.apiSettlementIntent.update({ where: { reservationId: input.id }, data: { attempts: 9 } })
    const [claim] = await claimApiSettlements(), transaction = db.$transaction.bind(db)
    vi.spyOn(db, '$transaction').mockImplementationOnce(async (...args: any[]) => {
      await (transaction as any)(...args); throw new Error('private lost commit response')
    })
    expect(await recoverApiSettlement(claim)).toBe('succeeded')
    expect(await intent(input.id)).toMatchObject({ status: 'succeeded', attempts: 10, lastErrorCode: null })
    expect((await account()).apiBalanceMicros).toBe(9960n)
  })
  it('backs off using DB time and sanitized errors, then recovers', async () => {
    const input = await hold(); await failWrites('ApiUsage', 'capture')
    expect((await runApiSettlementBatch()).retry).toBe(1)
    const failed = await intent(input.id)
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastErrorCode: 'API_CAPTURE_RETRY', leaseToken: null })
    expect(failed.nextAttemptAt.getTime() - failed.updatedAt.getTime()).toBe(1000)
    expect(await claimApiSettlements()).toEqual([])
    await due(input.id)
    expect((await runApiSettlementBatch()).retry).toBe(1)
    const second = await intent(input.id)
    expect(second.nextAttemptAt.getTime() - second.updatedAt.getTime()).toBe(2000)
    await removeFailure('ApiUsage', 'capture'); await due(input.id)
    expect((await runApiSettlementBatch()).succeeded).toBe(1)
  })
  it('dead-letters exhausted work without refund, but acknowledges already captured exhausted work', async () => {
    const captured = await hold(), uncaptured = await hold()
    await db.apiSettlementIntent.updateMany({ where: { userId }, data: { attempts: 9 } })
    const claims = await claimApiSettlements()
    await captureApiSettlement(captured.id, claims.find(c => c.reservationId === captured.id)!)
    await expire(captured.id); await expire(uncaptured.id)
    expect(await runApiSettlementBatch()).toMatchObject({ succeeded: 1, dead_letter: 1 })
    await expect(captureApiReservation(uncaptured)).rejects.toMatchObject({ code: 'conflict' })
    expect((await account()).apiBalanceMicros).toBe(9860n)
    expect(await claimApiSettlements()).toEqual([])
  })
  it('dead-letters the final failed attempt and caps the DB-clock backoff', async () => {
    const input = await hold()
    await db.apiSettlementIntent.update({ where: { reservationId: input.id }, data: { attempts: 9 } })
    await failWrites('ApiUsage', 'capture')
    const result = await cli(['--once'])
    expect(result.code, result.stderr).toBe(3)
    expect(result.stdout).toContain('"dead_letter":1')
    expect(result.stdout + result.stderr).not.toContain('private fixture')
    const failed = await intent(input.id)
    expect(failed).toMatchObject({ status: 'dead_letter', attempts: 10, lastErrorCode: 'API_CAPTURE_RETRY' })
    expect(failed.nextAttemptAt.getTime() - failed.updatedAt.getTime()).toBe(300000)
    expect((await account()).apiBalanceMicros).toBe(9900n)
    await removeFailure('ApiUsage', 'capture')
    expect(await claimApiSettlements()).toEqual([])
  })
  it('two independent CLI workers share a queue without duplicating capture', async () => {
    for (let i = 0; i < 6; i++) await hold()
    const results = await Promise.all([cli(['--once', '--batch-size', '6', '--concurrency', '2']),
      cli(['--once', '--batch-size', '6', '--concurrency', '2'])])
    expect(results.map(r => r.code)).toEqual([0, 0])
    expect(await db.apiUsage.count({ where: { userId } })).toBe(6)
    expect((await account()).apiBalanceMicros).toBe(9760n)
    expect(await db.apiSettlementIntent.count({ where: { userId, status: 'succeeded' } })).toBe(6)
  })
  it.each(['release', 'capture', 'duplicate-usage', 'model'])('makes %s conflicts terminal without disturbing manual settlement', async cause => {
    const input = await hold()
    if (cause === 'release') await settleApiReservation({ ...input, outcome: 'release', costMicros: 0, tokensIn: 0, tokensOut: 0, reconciliationReference: 'operator:no-work' })
    else if (cause === 'capture') await settleApiReservation({ ...input, outcome: 'capture', reconciliationReference: 'operator:confirmed' })
    else if (cause === 'model') await db.apiReservation.update({ where: { id: input.id }, data: { model: 'changed' } })
    else await db.apiUsage.create({ data: { reservationId: input.id, userId, kind: 'chat' } })
    const before = await reservation(input.id), balance = (await account()).apiBalanceMicros
    expect((await runApiSettlementBatch()).conflict).toBe(1)
    expect(await reservation(input.id)).toEqual(before)
    expect((await account()).apiBalanceMicros).toBe(balance)
    expect(await intent(input.id)).toMatchObject({ status: 'conflict', lastErrorCode: 'API_SETTLEMENT_CONFLICT' })
    expect(await claimApiSettlements()).toEqual([])
  })
  it('manual refund and worker capture races settle only once', async () => {
    const input = await hold(), [claim] = await claimApiSettlements()
    await Promise.allSettled([recoverApiSettlement(claim), settleApiReservation({ ...input, outcome: 'release', costMicros: 0, tokensIn: 0, tokensOut: 0, reconciliationReference: 'operator:fixture' })])
    const row = await reservation(input.id)
    expect(['captured', 'released']).toContain(row.state)
    expect((await account()).apiBalanceMicros).toBe(row.state === 'captured' ? 9960n : 10000n)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it.each(['SIGTERM', 'SIGINT'] as const)('continuous CLI recovers real work and stops on %s', async signal => {
    await hold()
    const result = await cli(['--poll-ms', '100', '--batch-size', '1'], signal)
    if (process.platform === 'win32') expect(result.signal).toBe(signal)
    else expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('"succeeded":1')
    expect((await account()).apiBalanceMicros).toBe(9960n)
  })
  it.skipIf(process.platform === 'win32').each(['SIGTERM', 'SIGINT'] as const)('interrupted --once drains capture but exits incomplete on %s', async signal => {
    const input = await hold()
    let locked!: () => void, release!: () => void
    const acquired = new Promise<void>(r => { locked = r }), released = new Promise<void>(r => { release = r })
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${input.id} FOR UPDATE`
      locked(); await released
    }, { timeout: 10000 })
    try {
      await acquired
      const result = await cli(['--once', '--batch-size', '1'], signal, { id: input.id, release })
      expect(result.code, result.stderr).toBe(1)
      expect(result.stdout).toContain('"aborted":true')
      expect(result.stdout).toContain('"succeeded":1')
      expect((await account()).apiBalanceMicros).toBe(9960n)
    } finally { release(); await blocker }
  })
})

function cli(args: string[], stopAfterBatch?: 'SIGTERM' | 'SIGINT', stopOnClaim?: { id: string; release: () => void }): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/api-settlement-worker.mjs'), ...args], {
      env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', stopped = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture worker timed out')) }, 12000)
    const poll = stopOnClaim ? setInterval(async () => {
      if (!stopped && (await intent(stopOnClaim.id)).status === 'processing') {
        const [capture] = await db.$queryRaw<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%ApiReservation%FOR UPDATE%'
        ) AS waiting`
        if (!capture.waiting || stopped) return
        stopped = true
        child.kill(stopAfterBatch!)
        // Allow the signal handler to set the abort flag before releasing capture.
        setTimeout(stopOnClaim.release, 50)
      }
    }, 25) : undefined
    child.stdout.on('data', data => {
      stdout += data
      if (stopAfterBatch && !stopped && stdout.includes('"succeeded":1')) { stopped = true; child.kill(stopAfterBatch) }
    })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); clearInterval(poll); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); clearInterval(poll); resolveResult({ code, signal, stdout, stderr }) })
  })
}
