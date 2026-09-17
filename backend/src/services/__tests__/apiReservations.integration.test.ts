import { randomUUID } from 'crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../prisma'
import { addBalance, chargeUsage, grantPreviewCredit, PREVIEW_CREDIT_MICROS } from '../apiBilling'
import {
  abandonApiReservation, apiFingerprint, dispatchApiReservation, markApiReservationUnknown,
  MAX_API_MICROS, newApiReservationId, reserveApiBalance, settleApiReservation,
} from '../apiReservations'

const db = prisma!
afterAll(async () => { await db.$disconnect() })

async function account(balance = 1_000n) {
  const user = await db.user.create({ data: { email: `api-reservation-${randomUUID()}@example.test`, name: 'Fixture', password: 'not-a-secret', apiBalanceMicros: balance } })
  const key = await db.apiKey.create({ data: { userId: user.id, keyHash: randomUUID(), prefix: 'fixture' } })
  return { userId: user.id, apiKeyId: key.id }
}
async function balance(userId: string) {
  return (await db.user.findUniqueOrThrow({ where: { id: userId } })).apiBalanceMicros
}
function request(owner: Awaited<ReturnType<typeof account>>, amountMicros = 100) {
  return { ...owner, id: newApiReservationId(), kind: 'chat' as const, model: 'fixture', amountMicros, requestFingerprint: apiFingerprint(['normalized-server-request', 'pricing-v1']) }
}

describe('real PostgreSQL reservation transactions', () => {
  it('concurrent requests can spend only the available balance', async () => {
    const owner = await account(500n)
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => reserveApiBalance(request(owner))))
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(5)
    expect(outcomes.filter(r => r.status === 'rejected').every(r => r.status === 'rejected' && r.reason.code === 'insufficient_quota')).toBe(true)
    expect(await balance(owner.userId)).toBe(0n)
    expect(await db.apiReservation.count({ where: { userId: owner.userId } })).toBe(5)
  })

  it('reserve exact retries converge; changed amount/payload/owner/key are conflicts', async () => {
    const owner = await account()
    const input = request(owner)
    await Promise.all(Array.from({ length: 8 }, () => reserveApiBalance(input)))
    expect(await balance(owner.userId)).toBe(900n)
    expect(await db.apiReservation.count({ where: { id: input.id } })).toBe(1)
    for (const patch of [{ amountMicros: 101 }, { requestFingerprint: apiFingerprint(['changed']) }, { userId: 'someone-else' }, { apiKeyId: null }, { model: 'changed' }]) {
      await expect(reserveApiBalance({ ...input, ...patch })).rejects.toMatchObject({ code: 'conflict' })
    }
  })

  it('only one dispatch claim succeeds; capture and ledger are exactly once', async () => {
    const input = request(await account())
    await reserveApiBalance(input)
    const claims = await Promise.allSettled([dispatchApiReservation(input), dispatchApiReservation(input)])
    expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const settlement = { ...input, outcome: 'capture' as const, costMicros: 40, tokensIn: 10, tokensOut: 10 }
    expect(await Promise.all(Array.from({ length: 8 }, () => settleApiReservation(settlement)))).toEqual(Array(8).fill(40))
    expect(await balance(input.userId)).toBe(960n)
    expect(await db.apiUsage.findMany({ where: { reservationId: input.id } })).toMatchObject([{ costMicros: 40n, tokensIn: 10, tokensOut: 10 }])
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: input.apiKeyId } })).lastUsedAt).not.toBeNull()
    await expect(settleApiReservation({ ...settlement, tokensOut: 11 })).rejects.toMatchObject({ code: 'conflict' })
    await expect(settleApiReservation({ ...input, outcome: 'release', costMicros: 0 })).rejects.toMatchObject({ code: 'conflict' })
    await reserveApiBalance(input) // even after capture: no second debit
    expect(await balance(input.userId)).toBe(960n)
  })

  it('pre-dispatch release is exact-once and records a zero-cost ledger event', async () => {
    const input = request(await account())
    await reserveApiBalance(input)
    await expect(settleApiReservation({ ...input, outcome: 'capture', costMicros: 1 })).rejects.toMatchObject({ code: 'conflict' })
    await Promise.all(Array.from({ length: 8 }, () => abandonApiReservation(input)))
    expect(await balance(input.userId)).toBe(1_000n)
    expect(await db.apiUsage.count({ where: { reservationId: input.id, costMicros: 0n } })).toBe(1)
    await expect(dispatchApiReservation(input)).rejects.toMatchObject({ code: 'conflict' })
  })

  it('uncertain work retains all funds and needs explicit reconciliation evidence', async () => {
    const input = request(await account())
    await reserveApiBalance(input)
    await dispatchApiReservation(input)
    await expect(settleApiReservation({ ...input, outcome: 'release', costMicros: 0 })).rejects.toMatchObject({ code: 'conflict' })
    await abandonApiReservation(input, 2)
    await markApiReservationUnknown(input, 1)
    expect(await db.apiReservation.findUniqueOrThrow({ where: { id: input.id } })).toMatchObject({ state: 'unknown', evidence: { completedUnits: 2 } })
    expect(await balance(input.userId)).toBe(900n)
    await expect(settleApiReservation({ ...input, outcome: 'capture', costMicros: 40 })).rejects.toMatchObject({ code: 'conflict' })
    await expect(settleApiReservation({ ...input, outcome: 'release', costMicros: 0 })).rejects.toMatchObject({ code: 'conflict' })
    await settleApiReservation({ ...input, outcome: 'capture', costMicros: 40, reconciliationReference: 'provider-audit:fixture-001' })
    await abandonApiReservation(input)
    expect(await balance(input.userId)).toBe(960n)
  })

  it('enforces ownership in both the service and the database', async () => {
    const owner = await account(), other = await account()
    await expect(reserveApiBalance(request({ ...owner, apiKeyId: other.apiKeyId }))).rejects.toMatchObject({ code: 'invalid_owner' })
    await db.apiKey.update({ where: { id: owner.apiKeyId }, data: { revoked: true } })
    await expect(reserveApiBalance(request(owner))).rejects.toMatchObject({ code: 'invalid_owner' })
    const input = request(other)
    await reserveApiBalance(input)
    await expect(dispatchApiReservation({ ...input, userId: owner.userId })).rejects.toMatchObject({ code: 'invalid_owner' })
    await expect(settleApiReservation({ ...input, apiKeyId: owner.apiKeyId, outcome: 'release', costMicros: 0 })).rejects.toMatchObject({ code: 'invalid_owner' })
    await expect(db.apiReservation.create({ data: { ...request(owner), apiKeyId: other.apiKeyId, amountMicros: 100n } })).rejects.toMatchObject({ code: 'P2003' })
    await expect(db.apiReservation.create({ data: { ...input, amountMicros: 100n } })).rejects.toMatchObject({ code: 'P2002' })
  })

  it('rejects oversized capture without reducing the hold or writing usage', async () => {
    const input = request(await account())
    await reserveApiBalance(input)
    await dispatchApiReservation(input)
    await expect(settleApiReservation({ ...input, outcome: 'capture', costMicros: 101 })).rejects.toMatchObject({ code: 'invalid_amount' })
    expect(await balance(input.userId)).toBe(900n)
    expect(await db.apiUsage.count({ where: { reservationId: input.id } })).toBe(0)
    await abandonApiReservation(input)
    expect((await db.apiReservation.findUniqueOrThrow({ where: { id: input.id } })).state).toBe('unknown')
  })

  it('ledger insertion failure rolls the balance refund and terminal state back', async () => {
    const input = request(await account())
    await reserveApiBalance(input)
    await dispatchApiReservation(input)
    // Inject a conflicting row to force the real unique constraint to fail
    // AFTER the refund update. This tests rollback, not a mocked transaction.
    await db.apiUsage.create({ data: { userId: input.userId, kind: 'chat', reservationId: input.id } })
    await expect(settleApiReservation({ ...input, outcome: 'capture', costMicros: 40 })).rejects.toMatchObject({ code: 'P2002' })
    expect(await balance(input.userId)).toBe(900n)
    expect((await db.apiReservation.findUniqueOrThrow({ where: { id: input.id } })).state).toBe('dispatched')
  })
})

describe('preview, top-ups and priced capture', () => {
  it('preview grant has one atomic winner and ledger row', async () => {
    const owner = await account(0n)
    const granted = await Promise.all(Array.from({ length: 12 }, () => grantPreviewCredit(owner.userId)))
    expect(granted.filter(Boolean)).toHaveLength(1)
    expect(await balance(owner.userId)).toBe(BigInt(PREVIEW_CREDIT_MICROS))
    expect(await db.apiTopUp.count({ where: { userId: owner.userId, source: 'preview' } })).toBe(1)
    const full = await account(MAX_API_MICROS)
    await expect(grantPreviewCredit(full.userId)).rejects.toThrow()
    expect((await db.user.findUniqueOrThrow({ where: { id: full.userId } })).apiPreviewGranted).toBe(false)
  })

  it('top-up reference retries are atomic and reject conflicting owner or amount', async () => {
    const owner = await account(0n), other = await account(0n), ref = randomUUID()
    await Promise.all(Array.from({ length: 12 }, () => addBalance(owner.userId, 100, 'test', ref)))
    expect(await balance(owner.userId)).toBe(100n)
    expect(await db.apiTopUp.count({ where: { source: 'test', reference: ref } })).toBe(1)
    await expect(addBalance(owner.userId, 101, 'test', ref)).rejects.toMatchObject({ code: 'conflict' })
    await expect(addBalance(other.userId, 100, 'test', ref)).rejects.toMatchObject({ code: 'conflict' })
    await addBalance(owner.userId, 100, 'test')
    await addBalance(owner.userId, 100, 'test', '')
    expect(await balance(owner.userId)).toBe(300n)
  })

  it('adopts historical duplicate references without deleting or recrediting them', async () => {
    const owner = await account(200n), ref = randomUUID()
    await db.apiTopUp.createMany({ data: Array.from({ length: 2 }, () => ({ userId: owner.userId, amountMicros: 100n, source: 'legacy', reference: ref })) })
    const before = await db.apiTopUp.findMany({ where: { reference: ref }, orderBy: { id: 'asc' } })
    await addBalance(owner.userId, 100, 'legacy', ref)
    expect(await balance(owner.userId)).toBe(200n)
    expect(await db.apiTopUp.findMany({ where: { reference: ref }, orderBy: { id: 'asc' } })).toEqual(before)
    expect(await db.apiCreditIdentity.count({ where: { reference: ref } })).toBe(1)
  })

  it('top-ups preserve room for held funds to be returned at the numeric limit', async () => {
    const owner = await account(MAX_API_MICROS)
    const input = request(owner)
    await reserveApiBalance(input)
    await expect(addBalance(owner.userId, 1, 'test', randomUUID())).rejects.toMatchObject({ code: 'invalid_amount' })
    await abandonApiReservation(input)
    expect(await balance(owner.userId)).toBe(MAX_API_MICROS)
  })

  it('chargeUsage requires reserved dispatch and is idempotent under concurrent retries', async () => {
    const owner = await account(10n)
    const input = request(owner, 10)
    const usage = { ...owner, reservationId: input.id, kind: 'chat' as const, tokensIn: 1 }
    await expect(chargeUsage(usage)).rejects.toMatchObject({ code: 'invalid_owner' })
    await reserveApiBalance(input)
    await expect(chargeUsage(usage)).rejects.toMatchObject({ code: 'conflict' })
    await dispatchApiReservation(input)
    expect(await Promise.all(Array.from({ length: 12 }, () => chargeUsage(usage)))).toEqual(Array(12).fill(2))
    expect(await balance(owner.userId)).toBe(8n)
    expect(await db.apiUsage.count({ where: { userId: owner.userId } })).toBe(1)
    await expect(chargeUsage({ ...usage, tokensIn: 2 })).rejects.toMatchObject({ code: 'conflict' })
    await expect(chargeUsage({ ...usage, model: 'different' })).rejects.toMatchObject({ code: 'conflict' })
  })
})
