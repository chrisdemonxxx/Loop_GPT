import { describe, expect, it } from 'vitest'
import { addBalance, chargeUsage, grantPreviewCredit, grossCostMicros, netCostMicros } from '../apiBilling'
import {
  apiAmount, apiCount, apiFingerprint, newApiReservationId, reserveApiBalance,
  dispatchApiReservation, settleApiReservation, markApiReservationUnknown,
} from '../apiReservations'

describe('prepaid arithmetic and fail-closed contract', () => {
  it.each([-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])('rejects invalid amount %s', value => {
    expect(() => apiAmount(value)).toThrow()
  })
  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648])('rejects invalid counter %s', value => {
    expect(() => apiCount(value)).toThrow()
    expect(() => grossCostMicros({ kind: 'chat', tokensIn: value })).toThrow()
    expect(() => grossCostMicros({ kind: 'image', units: value })).toThrow()
  })
  it('rounds fractional rates/discounts upward using exact integer arithmetic', () => {
    expect(grossCostMicros({ kind: 'chat', tokensIn: 1, cachedTokensIn: 1 })).toBe(1)
    expect(grossCostMicros({ kind: 'chat', tokensIn: 11, cachedTokensIn: 1, tokensOut: 3, tier: 'large' })).toBe(40)
    expect(grossCostMicros({ kind: 'image', units: 0 })).toBe(0)
    expect(grossCostMicros({ kind: 'image', units: 4 })).toBe(200_000)
    expect(netCostMicros(3, 'growth')).toBe(3)
    expect(netCostMicros(Number.MAX_SAFE_INTEGER, 'scale')).toBe(Number((BigInt(Number.MAX_SAFE_INTEGER) * 85n + 99n) / 100n))
    expect(() => grossCostMicros({ kind: 'chat', tokensIn: 1, cachedTokensIn: 2 })).toThrow()
    expect(() => netCostMicros(-1)).toThrow()
    expect(() => grossCostMicros({ kind: 'chat', tier: 'toString' })).toThrow()
  })
  it('never reports successful accounting without a database', async () => {
    const owner = { id: newApiReservationId(), userId: 'user', apiKeyId: 'key' }
    const calls = [
      () => reserveApiBalance({ ...owner, kind: 'chat', model: 'test', amountMicros: 1, requestFingerprint: apiFingerprint(['test']) }),
      () => dispatchApiReservation(owner),
      () => settleApiReservation({ ...owner, outcome: 'release', costMicros: 0 }),
      () => markApiReservationUnknown(owner),
      () => addBalance('user', 1, 'test', 'ref'),
      () => grantPreviewCredit('user'),
      () => chargeUsage({ reservationId: owner.id, userId: 'user', kind: 'chat', tokensIn: 1 }),
    ]
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'unavailable' })
  })
})
