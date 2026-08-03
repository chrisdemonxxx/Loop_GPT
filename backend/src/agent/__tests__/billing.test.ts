import { describe, it, expect } from 'vitest'
import { estimateTokens, PLAN_LIMITS, CREDIT_COST, checkCredits } from '../../services/billing'

describe('billing metering', () => {
  it('estimates tokens from text length (~4 chars/token)', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('defines a capped-but-generous gold tier above free', () => {
    expect(PLAN_LIMITS.free.credits).toBeLessThan(PLAN_LIMITS.gold.credits)
    expect(PLAN_LIMITS.gold.credits).toBeGreaterThan(PLAN_LIMITS.pro.credits)
    // Gold is finite — a real cap, not unlimited.
    expect(Number.isFinite(PLAN_LIMITS.gold.credits)).toBe(true)
    expect(Number.isFinite(PLAN_LIMITS.gold.imageCredits)).toBe(true)
  })

  it('charges research more than a plain chat turn', () => {
    expect(CREDIT_COST.research).toBeGreaterThan(CREDIT_COST.chat)
  })

  it('is permissive when no database is configured (local/dev)', async () => {
    // No DATABASE_URL in the test env → getAccount returns null → unlimited pass.
    const res = await checkCredits('anyone', 'chat')
    expect(res.ok).toBe(true)
    expect(res.unlimited).toBe(true)
  })
})
