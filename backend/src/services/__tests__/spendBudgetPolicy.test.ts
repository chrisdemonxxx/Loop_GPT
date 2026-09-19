import { describe, expect, it } from 'vitest'
import { spendBudgetPolicySchema, SPEND_BUDGET_DISABLED, requireSpendBudgetPolicy } from '../spendBudgetPolicy'
import { DailyCreditError } from '../dailyReservations'

describe('spendBudgetPolicy', () => {
  it('validates the singleton schema (BigInt caps from raw queries) and rejects malformed configuration', () => {
    expect(spendBudgetPolicySchema.safeParse({
      id: 1, version: 1, revision: 1,
      perUserDailyReservationCap: 1000n, globalDailyReservationCap: 50000n,
    }).success).toBe(true)
    for (const bad of [
      { id: 2, version: 1, revision: 1, perUserDailyReservationCap: 1n, globalDailyReservationCap: 1n },
      { id: 1, version: 2, revision: 1, perUserDailyReservationCap: 1n, globalDailyReservationCap: 1n },
      { id: 1, version: 1, revision: 0, perUserDailyReservationCap: 1n, globalDailyReservationCap: 1n },
      { id: 1, version: 1, revision: 1, perUserDailyReservationCap: -1n, globalDailyReservationCap: 1n },
      { id: 1, version: 1, revision: 1, perUserDailyReservationCap: 10_000_001n, globalDailyReservationCap: 1n },
      { id: 1, version: 1, revision: 1, perUserDailyReservationCap: 1, globalDailyReservationCap: 1n },
    ]) expect(spendBudgetPolicySchema.safeParse(bad).success).toBe(false)
    expect(() => requireSpendBudgetPolicy({ id: 1, version: 1, revision: 1, perUserDailyReservationCap: 'x', globalDailyReservationCap: 1n }))
      .toThrow(DailyCreditError)
  })

  it('treats zero as the explicit disabled sentinel for each cap', () => {
    expect(spendBudgetPolicySchema.safeParse({
      id: 1, version: 1, revision: 1,
      perUserDailyReservationCap: 0n, globalDailyReservationCap: 0n,
    }).success).toBe(true)
    expect(SPEND_BUDGET_DISABLED).toBe(0n)
  })
})
