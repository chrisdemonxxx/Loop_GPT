import { createHash, randomUUID } from 'crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../prisma'
import { createToken, consumeToken } from '../tokens'
import { redeemVoucher } from '../billing'
import { getHistory } from '../chatStore'

const db = prisma!
const prefix = `foundation-${randomUUID()}`
let sequence = 0

async function user() {
  const id = `${prefix}-${++sequence}`
  return db.user.create({ data: { id, email: `${id}@example.test`, name: 'Integration fixture', password: 'not-an-auth-credential', credits: 0 } })
}

afterAll(async () => {
  try {
    // Remove only this run's fixtures, never truncate a database/table.
    await db.user.deleteMany({ where: { id: { startsWith: prefix } } })
    await db.voucher.deleteMany({ where: { code: { startsWith: prefix.toUpperCase() } } })
  } finally {
    await db.$disconnect()
  }
})

describe('foundation invariants on PostgreSQL', () => {
  it('allows exactly one consumer of a one-time token under concurrency', async () => {
    const owner = await user()
    const raw = await createToken(owner.id, 'reset')
    const stored = await db.token.findFirstOrThrow({ where: { userId: owner.id } })
    expect(stored.token).toBe(createHash('sha256').update(raw!).digest('hex'))
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeToken(raw!, 'reset')))
    expect(results.filter((result) => result === owner.id)).toHaveLength(1)
    expect(results.filter((result) => result === null)).toHaveLength(11)
  })

  it('rejects an expired token without marking it used', async () => {
    const owner = await user()
    const raw = await createToken(owner.id, 'reset')
    await db.token.updateMany({ where: { userId: owner.id }, data: { expiresAt: new Date(0) } })
    expect(await consumeToken(raw!, 'reset')).toBeNull()
    expect((await db.token.findFirstOrThrow({ where: { userId: owner.id } })).usedAt).toBeNull()
  })

  it('does not consume a token for the wrong purpose', async () => {
    const owner = await user()
    const raw = await createToken(owner.id, 'verify')
    expect(await consumeToken(raw!, 'reset')).toBeNull()
    expect(await consumeToken(raw!, 'verify')).toBe(owner.id)
  })

  it('grants a single-use voucher to exactly one of eight competing users', async () => {
    const owners = await Promise.all(Array.from({ length: 8 }, () => user()))
    const voucher = await db.voucher.create({ data: { code: `${prefix}-single`.toUpperCase(), credits: 13, maxRedemptions: 1 } })
    const results = await Promise.all(owners.map((owner) => redeemVoucher(owner.id, voucher.code)))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect((await db.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).redemptionCount).toBe(1)
    expect(await db.voucherRedemption.count({ where: { voucherId: voucher.id } })).toBe(1)
    const balances = await db.user.findMany({ where: { id: { in: owners.map((owner) => owner.id) } } })
    expect(balances.reduce((sum, owner) => sum + owner.credits, 0)).toBe(13)
  })

  it('grants only once when the same user redeems concurrently', async () => {
    const owner = await user()
    const voucher = await db.voucher.create({ data: { code: `${prefix}-duplicate`.toUpperCase(), credits: 7, maxRedemptions: 20 } })
    const results = await Promise.all(Array.from({ length: 8 }, () => redeemVoucher(owner.id, voucher.code)))
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect((await db.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).redemptionCount).toBe(1)
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).credits).toBe(7)
  })

  it('rolls back capacity and redemption if the grant cannot complete', async () => {
    const voucher = await db.voucher.create({ data: { code: `${prefix}-rollback`.toUpperCase(), credits: 9 } })
    expect((await redeemVoucher(`${prefix}-missing`, voucher.code)).ok).toBe(false)
    expect((await db.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).redemptionCount).toBe(0)
    expect(await db.voucherRedemption.count({ where: { voucherId: voucher.id } })).toBe(0)
  })

  it('retrieves the most recent messages of a long conversation chronologically', async () => {
    const owner = await user()
    const conversation = await db.conversation.create({ data: { userId: owner.id, title: 'Long conversation' } })
    await db.message.createMany({ data: Array.from({ length: 30 }, (_, index) => ({
      conversationId: conversation.id, role: 'user', content: `turn-${index}`, createdAt: new Date(index * 1000),
    })) })
    expect((await getHistory(conversation.id, 3)).map((message) => message.content)).toEqual(['turn-27', 'turn-28', 'turn-29'])
    expect(await getHistory(conversation.id, 0)).toEqual([])
  })
})
