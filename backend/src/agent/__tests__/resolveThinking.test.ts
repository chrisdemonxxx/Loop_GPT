import { describe, it, expect } from 'vitest'
import { resolveThinking, thinkingFamily, THINKING_EFFORTS, type ThinkingFamily } from '../thinking'

/**
 * The §A table of `team/CONTRACT_P2_STREAM.md`, one case per (tier, env) row,
 * plus the family split. Every assertion here is the signed contract, not a
 * description of the code — a red test means the resolver drifted from it.
 */

const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { QWEN_THINKING: value })

describe('thinkingFamily', () => {
  it('classifies the live fleet and everything else', () => {
    expect(thinkingFamily('Qwen3-Coder-30B')).toBe('qwen')
    expect(thinkingFamily('hf-dsv41')).toBe('other')
    expect(thinkingFamily(undefined)).toBe('other')
    expect(thinkingFamily(null)).toBe('other')
  })
})

describe('resolveThinking — legacy path (omitted / auto)', () => {
  const qwen: ThinkingFamily = 'qwen'

  it('env unset → /no_think and enable_thinking:false (today, byte for byte)', () => {
    expect(resolveThinking(undefined, qwen, env())).toEqual({ suffix: '/no_think', enableThinking: false })
  })

  it('env "true" → /think and no transport override', () => {
    expect(resolveThinking(undefined, qwen, env('true'))).toEqual({ suffix: '/think', enableThinking: undefined })
  })

  it('env set to anything else → no suffix, enable_thinking:false', () => {
    for (const value of ['false', '0', 'yes']) {
      expect(resolveThinking(undefined, qwen, env(value))).toEqual({ suffix: '', enableThinking: false })
    }
  })

  it('the env value is not consulted for explicit tiers', () => {
    expect(resolveThinking('low', qwen, env('true')).suffix).toBe('/think')
    expect(resolveThinking(false, qwen, env('true')).suffix).toBe('/no_think')
  })
})

describe('resolveThinking — explicit tiers (§A table)', () => {
  const rows: Array<{ input: boolean | string; suffix: string; enableThinking?: boolean; cotCap?: number }> = [
    { input: false, suffix: '/no_think', enableThinking: false },
    { input: 'low', suffix: '/think', enableThinking: undefined },
    { input: 'medium', suffix: '/think', enableThinking: undefined },
    { input: true, suffix: '/think', enableThinking: undefined },
    { input: 'high', suffix: '/think', enableThinking: true, cotCap: 2000 },
    { input: 'xhigh', suffix: '/think', enableThinking: true, cotCap: 8000 },
  ]

  for (const row of rows) {
    it(`${JSON.stringify(row.input)} → suffix ${row.suffix}`, () => {
      expect(resolveThinking(row.input as any, 'qwen', env())).toEqual({
        suffix: row.suffix,
        enableThinking: row.enableThinking,
        ...(row.cotCap ? { cotCap: row.cotCap } : {}),
      })
    })
  }

  it('frozen alias: true ≡ medium exactly', () => {
    expect(resolveThinking(true, 'qwen', env())).toEqual(resolveThinking('medium', 'qwen', env()))
  })

  it('no fourth knob: a non-Qwen family never has enable_thinking forced on', () => {
    expect(resolveThinking('xhigh', 'other', env()).enableThinking).toBeUndefined()
    // …and the prompt-level cap is model-agnostic, so it survives.
    expect(resolveThinking('xhigh', 'other', env()).cotCap).toBe(8000)
  })

  it('every tier in THINKING_EFFORTS resolves; the env cannot 500 the path', () => {
    for (const effort of THINKING_EFFORTS) {
      expect(resolveThinking(effort, 'qwen', env()).suffix).toBe('/think')
    }
  })
})
