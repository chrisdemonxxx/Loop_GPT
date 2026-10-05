import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  availableChatModels,
  chatModelCatalog,
  resolveChatTarget,
  resolveVisionTarget,
  tierFor,
  CHAT_MODELS,
} from '../chatModels'

afterEach(() => vi.unstubAllEnvs())

/** Empty string = absent: deterministic regardless of the developer's shell. */
const ABSENT = ''

describe('chat model catalog', () => {
  it('lists exactly two Loopers when no dedicated VLM endpoint is configured', () => {
    vi.stubEnv('HF_VISION_ENDPOINT_URL', ABSENT)
    const models = availableChatModels()
    expect(models).toHaveLength(2)
    expect(models.map((m) => m.label)).toEqual(['Large Looper', 'Small Looper'])
    expect(models.map((m) => m.id)).toEqual(['loop-large', 'loop-small'])
    expect(models.some((m) => m.tier === 'vision')).toBe(false)
    expect(chatModelCatalog()).toHaveLength(2)
  })

  it('adds the vision row when a dedicated VLM endpoint is configured (A6 / GAP-029 row 3)', () => {
    vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://large.example.test')
    vi.stubEnv('HF_LARGE_MODEL', 'large-upstream')
    vi.stubEnv('HF_VISION_ENDPOINT_URL', 'https://vlm.example.test/')
    vi.stubEnv('HF_VISION_MODEL', 'vlm-upstream')

    // The row is emitted between the flagship and the fast tier, with the
    // canonical id — never the bare alias string 'vision'.
    expect(availableChatModels().map((m) => m.id)).toEqual(['loop-large', 'loop-vision', 'loop-small'])
    expect(availableChatModels()[1]).toMatchObject({
      id: 'loop-vision',
      tier: 'vision',
      label: 'Large Looper (Vision)',
    })
    // The catalog projection (/v1/models + picker) carries the same row.
    expect(chatModelCatalog().map((m) => m.id)).toEqual(['loop-large', 'loop-vision', 'loop-small'])
    // And the row is selectable end-to-end: id -> vision tier -> VLM target.
    expect(resolveChatTarget(CHAT_MODELS.vision.id)).toMatchObject({
      tier: 'vision',
      model: 'vlm-upstream',
      baseUrl: 'https://vlm.example.test/v1',
    })
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

describe('vision routing — the dedicated endpoint is optional', () => {
  const caller = { provider: 'huggingface', model: '', baseUrl: '' }

  it('falls through to the large tier for a vision request when only HF_LARGE_ENDPOINT_URL is set', () => {
    vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://large.example.test/')
    vi.stubEnv('HF_LARGE_MODEL', 'large-upstream')
    vi.stubEnv('HF_VISION_ENDPOINT_URL', ABSENT)
    vi.stubEnv('HF_VISION_MODEL', ABSENT)

    expect(tierFor(CHAT_MODELS.vision.id)).toBe('vision')
    // Regression: this used to throw (toV1 on an undefined endpoint URL).
    expect(resolveChatTarget(CHAT_MODELS.vision.id)).toMatchObject({
      tier: 'large',
      model: 'large-upstream',
      baseUrl: 'https://large.example.test/v1',
    })
  })

  it('uses the dedicated VLM endpoint when it is configured alongside the large tier', () => {
    vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://large.example.test')
    vi.stubEnv('HF_VISION_ENDPOINT_URL', 'https://vlm.example.test/')
    vi.stubEnv('HF_VISION_MODEL', 'vlm-upstream')

    // Regression: 'vision' is shadowed to the large tier by CHAT_MODELS.large.aliases.
    expect(resolveVisionTarget(caller)).toMatchObject({
      model: 'vlm-upstream',
      baseUrl: 'https://vlm.example.test/v1',
    })
  })

  it('uses the dedicated VLM endpoint when it is the only endpoint configured', () => {
    vi.stubEnv('HF_LARGE_ENDPOINT_URL', ABSENT)
    vi.stubEnv('HF_VISION_ENDPOINT_URL', 'https://vlm.example.test')
    vi.stubEnv('HF_VISION_MODEL', 'vlm-upstream')

    expect(resolveVisionTarget(caller)).toMatchObject({
      model: 'vlm-upstream',
      baseUrl: 'https://vlm.example.test/v1',
    })
  })

  it('falls back to the large tier when no dedicated VLM endpoint is configured', () => {
    vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://large.example.test')
    vi.stubEnv('HF_LARGE_MODEL', 'large-upstream')
    vi.stubEnv('HF_VISION_ENDPOINT_URL', ABSENT)

    expect(resolveVisionTarget(caller)).toMatchObject({
      model: 'large-upstream',
      baseUrl: 'https://large.example.test/v1',
    })
  })

  it('returns null when no vision-capable endpoint is configured at all', () => {
    vi.stubEnv('HF_LARGE_ENDPOINT_URL', ABSENT)
    vi.stubEnv('HF_VISION_ENDPOINT_URL', ABSENT)

    expect(resolveVisionTarget(caller)).toBeNull()
  })
})
