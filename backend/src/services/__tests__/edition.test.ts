import { afterEach, describe, expect, it } from 'vitest'
import { isAdultEdition, isMainstreamEdition } from '../edition'
import { getBaseSystemPrompt } from '../../controllers/agentStream'
import { priceForPlan } from '../stripe'
import { PLAN_LIMITS } from '../billing'

const saved = { edition: process.env.LOOP_EDITION, max: process.env.STRIPE_PRICE_MAX }

afterEach(() => {
  if (saved.edition === undefined) delete process.env.LOOP_EDITION
  else process.env.LOOP_EDITION = saved.edition
  if (saved.max === undefined) delete process.env.STRIPE_PRICE_MAX
  else process.env.STRIPE_PRICE_MAX = saved.max
})

describe('edition', () => {
  it('defaults to mainstream when unset (fail-safe)', () => {
    delete process.env.LOOP_EDITION
    expect(isAdultEdition()).toBe(false)
    expect(isMainstreamEdition()).toBe(true)
  })

  it('treats unrecognised values as mainstream', () => {
    process.env.LOOP_EDITION = 'ADULT '
    expect(isAdultEdition()).toBe(false)
  })

  it('is adult only when explicitly set to "adult"', () => {
    process.env.LOOP_EDITION = 'adult'
    expect(isAdultEdition()).toBe(true)
    expect(isMainstreamEdition()).toBe(false)
  })

  it('mainstream prompt forbids explicit content; adult prompt allows it', () => {
    delete process.env.LOOP_EDITION
    const mainstream = getBaseSystemPrompt()
    expect(mainstream).toContain('Do not generate explicitly pornographic')
    expect(mainstream).not.toContain('erotic fiction')

    process.env.LOOP_EDITION = 'adult'
    expect(getBaseSystemPrompt()).toContain('erotic fiction')
  })

  it('keeps the three absolute limits in both editions', () => {
    for (const edition of [undefined, 'adult']) {
      if (edition) process.env.LOOP_EDITION = edition
      else delete process.env.LOOP_EDITION
      const prompt = getBaseSystemPrompt()
      expect(prompt).toContain('real or fictional minors')
      expect(prompt).toContain('mass casualties')
      expect(prompt).toContain('named living person')
    }
  })
})

describe('max plan', () => {
  it('has limits at least equal to pro', () => {
    expect(PLAN_LIMITS.max.credits).toBeGreaterThan(PLAN_LIMITS.pro.credits)
    expect(PLAN_LIMITS.max.imageCredits).toBeGreaterThan(PLAN_LIMITS.pro.imageCredits)
  })

  it('resolves its Stripe price from STRIPE_PRICE_MAX', () => {
    delete process.env.STRIPE_PRICE_MAX
    expect(priceForPlan('max')).toBeNull()
    process.env.STRIPE_PRICE_MAX = 'price_max_123'
    expect(priceForPlan('max')).toBe('price_max_123')
  })
})
