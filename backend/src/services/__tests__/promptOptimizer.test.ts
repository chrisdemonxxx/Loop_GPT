import { describe, expect, it } from 'vitest'
import { modalityOf, optimizePromptDetailed } from '../promptOptimizer'

describe('prompt optimizer', () => {
  it('maps run modes to the right modality', () => {
    expect(modalityOf('research')).toBe('research')
    expect(modalityOf('image')).toBe('image')
    expect(modalityOf('video')).toBe('video')
    expect(modalityOf('agent')).toBe('agent')
    expect(modalityOf(undefined)).toBe('chat')
    expect(modalityOf('chat')).toBe('chat')
  })

  it('is a deterministic no-op under test (never reaches the network)', async () => {
    const result = await optimizePromptDetailed('make a picture of a cat', 'image')
    expect(result.raw).toBe('make a picture of a cat')
    expect(result.enhanced).toBe('make a picture of a cat')
    expect(result.optimized).toBe(false)
  })

  it('trims whitespace and tolerates empty input', async () => {
    expect((await optimizePromptDetailed('  spaced  ', 'chat')).raw).toBe('spaced')
    expect((await optimizePromptDetailed('', 'chat')).enhanced).toBe('')
  })
})
