import { describe, it, expect } from 'vitest'
import { streamInput } from '../agentStream'
import { THINKING_EFFORTS } from '../../agent/thinking'

/**
 * Wire proof for contract §A: the server must accept the widened `thinking`
 * union *and* every legacy boolean body, because `ui-visual` ships the selector
 * only after this lands — a bool-only schema 400s a string body, and a
 * union-only schema would 400 every stale client.
 */
describe('streamInput — thinking widening (contract §A)', () => {
  const base = { content: 'hi' }

  it('accepts every effort tier', () => {
    for (const effort of THINKING_EFFORTS) {
      const parsed = streamInput.safeParse({ ...base, thinking: effort })
      expect(parsed.success, `${effort} should parse`).toBe(true)
      if (parsed.success) expect(parsed.data.thinking).toBe(effort)
    }
  })

  it('still accepts the legacy booleans, unchanged', () => {
    expect(streamInput.safeParse({ ...base, thinking: true }).success).toBe(true)
    expect(streamInput.safeParse({ ...base, thinking: false }).success).toBe(true)
    expect(streamInput.safeParse(base).success).toBe(true)
  })

  it('rejects an unknown tier and a non-string/boolean', () => {
    expect(streamInput.safeParse({ ...base, thinking: 'ultra' }).success).toBe(false)
    expect(streamInput.safeParse({ ...base, thinking: 3 }).success).toBe(false)
  })

  it('leaves the rest of the body alone', () => {
    const parsed = streamInput.safeParse({ ...base, mode: 'agent', thinking: 'xhigh' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mode).toBe('agent')
  })
})
