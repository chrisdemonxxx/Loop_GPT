import { describe, expect, it, vi } from 'vitest'
import { apiFingerprint, newApiReservationId, reserveApiBalanceTx, ApiBillingError } from '../apiReservations'

type KeyRow = { id: string; spendCapMicros?: bigint | null; concurrencyLimit?: number | null }

/** Minimal fake transaction: just the calls reserveApiBalanceTx makes. */
function fakeTx(key: KeyRow, opts: { inFlight?: number; captured?: bigint; held?: bigint } = {}) {
  const queryRaw = vi.fn().mockResolvedValue([])
  const create = vi.fn().mockImplementation(async ({ data }) => data)
  const tx: any = {
    $queryRaw: queryRaw,
    apiReservation: {
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(opts.inFlight ?? 0),
      aggregate: vi.fn().mockImplementation(async ({ where }: any) =>
        where.state === 'captured'
          ? { _sum: { capturedMicros: opts.captured ?? null } }
          : { _sum: { amountMicros: opts.held ?? null } }),
      create,
    },
    apiKey: { findFirst: vi.fn().mockResolvedValue(key) },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  }
  return { tx, queryRaw, create }
}

function input(amountMicros: number) {
  return {
    id: newApiReservationId(), userId: 'user-1', apiKeyId: 'key-1',
    kind: 'chat' as const, model: 'test', amountMicros,
    requestFingerprint: apiFingerprint(['limits-test', amountMicros]),
  }
}

describe('per-key limits', () => {
  it('takes no lock and runs no limit queries for keys without limits', async () => {
    const { tx, queryRaw } = fakeTx({ id: 'key-1', spendCapMicros: null, concurrencyLimit: null })
    await reserveApiBalanceTx(tx, input(1_000))
    expect(queryRaw).not.toHaveBeenCalled()
    expect(tx.apiReservation.count).not.toHaveBeenCalled()
    expect(tx.apiReservation.aggregate).not.toHaveBeenCalled()
  })

  it('treats rows missing the new columns as unlimited', async () => {
    const { tx, queryRaw } = fakeTx({ id: 'key-1' })
    await expect(reserveApiBalanceTx(tx, input(1_000))).resolves.toBeTruthy()
    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('rejects when the key is at its concurrency limit', async () => {
    const { tx, create } = fakeTx({ id: 'key-1', concurrencyLimit: 2 }, { inFlight: 2 })
    await expect(reserveApiBalanceTx(tx, input(1_000))).rejects.toMatchObject({ code: 'key_concurrency_exceeded' })
    expect(create).not.toHaveBeenCalled()
    expect(tx.user.updateMany).not.toHaveBeenCalled()
  })

  it('allows a request below the concurrency limit and serialises it with a lock', async () => {
    const { tx, queryRaw, create } = fakeTx({ id: 'key-1', concurrencyLimit: 2 }, { inFlight: 1 })
    await reserveApiBalanceTx(tx, input(1_000))
    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('rejects when captured plus in-flight spend plus this request exceeds the cap', async () => {
    const { tx, create } = fakeTx(
      { id: 'key-1', spendCapMicros: 10_000n },
      { captured: 6_000n, held: 3_000n },
    )
    await expect(reserveApiBalanceTx(tx, input(1_001))).rejects.toMatchObject({ code: 'key_spend_cap_exceeded' })
    expect(create).not.toHaveBeenCalled()
    expect(tx.user.updateMany).not.toHaveBeenCalled()
  })

  it('allows a request that lands exactly on the cap', async () => {
    const { tx, create } = fakeTx(
      { id: 'key-1', spendCapMicros: 10_000n },
      { captured: 6_000n, held: 3_000n },
    )
    await reserveApiBalanceTx(tx, input(1_000))
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('throws a typed ApiBillingError so routes can map it to 429', async () => {
    const { tx } = fakeTx({ id: 'key-1', concurrencyLimit: 1 }, { inFlight: 1 })
    await expect(reserveApiBalanceTx(tx, input(1))).rejects.toBeInstanceOf(ApiBillingError)
  })
})
