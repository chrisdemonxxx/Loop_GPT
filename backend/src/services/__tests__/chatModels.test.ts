import { afterEach, describe, expect, it, vi } from 'vitest'
import { availableChatModels, chatModelCatalog, tierFor, CHAT_MODELS } from '../chatModels'

afterEach(() => vi.unstubAllEnvs())

describe('chat model catalog', () => {
  it('lists exactly two Loopers', () => {
    const models = availableChatModels()
    expect(models).toHaveLength(2)
    expect(models.map((m) => m.label)).toEqual(['Large Looper', 'Small Looper'])
    expect(models.map((m) => m.id)).toEqual(['loop-large', 'loop-small'])
  })

  it('never exposes the vision tier in the picker', () => {
    expect(availableChatModels().some((m) => m.tier === 'vision')).toBe(false)
    expect(chatModelCatalog()).toHaveLength(2)
  })

  it('maps ids, aliases and the legacy "vision" value onto the two tiers', () => {
    expect(tierFor('loop-large')).toBe('large')
    expect(tierFor('large-looper')).toBe('large')
    expect(tierFor('vision')).toBe('large')
    expect(tierFor('loop-small')).toBe('standard')
    expect(tierFor('small-looper')).toBe('standard')
    expect(tierFor('unknown-value')).toBe('standard')
    expect(CHAT_MODELS.large.aliases).toContain('large-looper')
  })
})
