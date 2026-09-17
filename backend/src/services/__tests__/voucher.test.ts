import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  voucher: { findUnique: vi.fn(), updateMany: vi.fn() },
  voucherRedemption: { findUnique: vi.fn(), create: vi.fn() },
  user: { update: vi.fn() },
}))
vi.mock('../prisma', () => ({ prisma: db, hasDb: true }))
import { redeemVoucher } from '../billing'

describe('voucher transactions', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    db.$transaction.mockImplementation((fn) => fn(db))
    db.voucher.findUnique.mockResolvedValue({ id: 'v1', type: 'credits', active: true, expiresAt: null,
      maxRedemptions: 1, redemptionCount: 0, credits: 10, imageCredits: 0, plan: null })
    db.voucherRedemption.findUnique.mockResolvedValue(null)
    db.voucher.updateMany.mockResolvedValue({ count: 1 })
  })

  it('uses a serializable transaction for every read and grant', async () => {
    expect((await redeemVoucher('user-1', ' demo ')).ok).toBe(true)
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' })
    expect(db.voucher.findUnique).toHaveBeenCalledWith({ where: { code: 'DEMO' } })
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { credits: { increment: 10 } } })
  })

  it('does not grant credits when capacity cannot be claimed', async () => {
    db.voucher.updateMany.mockResolvedValue({ count: 0 })
    expect((await redeemVoucher('user-1', 'demo')).ok).toBe(false)
    expect(db.user.update).not.toHaveBeenCalled()
    expect(db.voucherRedemption.create).not.toHaveBeenCalled()
  })

  it('retries a serialization conflict using a fresh transaction', async () => {
    db.$transaction.mockRejectedValueOnce({ code: 'P2034' })
    expect((await redeemVoucher('user-1', 'demo')).ok).toBe(true)
    expect(db.$transaction).toHaveBeenCalledTimes(2)
  })

  it('bounds serialization retries', async () => {
    db.$transaction.mockRejectedValue({ code: 'P2034' })
    expect((await redeemVoucher('user-1', 'demo')).ok).toBe(false)
    expect(db.$transaction).toHaveBeenCalledTimes(3)
  })

  it('does not retry an unrelated database error', async () => {
    db.$transaction.mockRejectedValue(new Error('database unavailable'))
    expect((await redeemVoucher('user-1', 'demo')).ok).toBe(false)
    expect(db.$transaction).toHaveBeenCalledTimes(1)
  })

  it('rejects expired or already redeemed vouchers', async () => {
    db.voucher.findUnique.mockResolvedValue({ active: true, expiresAt: new Date(0) })
    expect((await redeemVoucher('user-1', 'demo')).ok).toBe(false)
    expect(db.voucher.updateMany).not.toHaveBeenCalled()
  })
})
