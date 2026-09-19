import { describe, expect, it } from 'vitest'
import { spendBudgetPolicySchema, SPEND_BUDGET_DISABLED, requireSpendBudgetPolicy } from '../spendBudgetPolicy'
import { DailyCreditError } from '../dailyReservations'

describe('spendBudgetPolicy', () => {
  it('validates the singleton schema and rejects malformed configuration', () => {
    expect(spendBudgetPolicySchema.safeParse({
      id: 1, version: 1, revision: 1,
      perUserDailyReservationCap: 1000, globalDailyReservationCap: 50000,
    }).success).toBe(true)
    for (const bad of [
      { id: 2, version: 1, revision: 1, perUserDailyReservationCap: 1, globalDailyReservationCap: 1 },
      { id: 1, version: 2, revision: 1, perUserDailyReservationCap: 1, globalDailyReservationCap: 1 },
      { id: 1, version: 1, revision: 0, perUserDailyReservationCap: 1, globalDailyReservationCap: 1 },
      { id: 1, version: 1, revision: 1, perUserDailyReservationCap: -1, globalDailyReservationCap: 1 },
      { id: 1, version: 1, revision: 1, perUserDailyReservationCap: 10_000_001, globalDailyReservationCap: 1 },
      { id: 1, version: 1, revision: 1, perUserDailyReservationCap: 1, globalDailyReservationCap: 'x' },
    ]) expect(spendBudgetPolicySchema.safeParse(bad).success).toBe(false)
    expect(() => requireSpendBudgetPolicy({ id: 1, version: 1, revision: 1, perUserDailyReservationCap: 'x', globalDailyReservationCap: 1 }))
      .toThrow(DailyCreditError)
  })

  it('treats zero as the explicit disabled sentinel for each cap', () => {
    expect(spendBudgetPolicySchema.safeParse({
      id: 1, version: 1, revision: 1,
      perUserDailyReservationCap: 0, globalDailyReservationCap: 0,
    }).success).toBe(true)
    expect(SPEND_BUDGET_DISABLED).toBe(0n)
  })
})
