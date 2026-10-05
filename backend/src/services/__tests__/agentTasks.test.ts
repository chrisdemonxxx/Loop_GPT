import { afterEach, describe, expect, it, vi } from 'vitest'
import { builtinToolNames } from '../../agent'
import {
  AgentTaskError,
  BOT_DEFAULT_TOOLS,
  BOT_PERMANENT_FAILURES,
  enqueueAgentTask,
  enqueueInput,
  parseScheduleMs,
} from '../../services/agentTasks'

describe('parseScheduleMs', () => {
  it('accepts bounded interval strings', () => {
    expect(parseScheduleMs('5m')).toBe(5 * 60_000)
    expect(parseScheduleMs('30m')).toBe(30 * 60_000)
    expect(parseScheduleMs('6h')).toBe(6 * 60 * 60_000)
    expect(parseScheduleMs('1d')).toBe(24 * 60 * 60_000)
    expect(parseScheduleMs('10080m')).toBe(10_080 * 60_000) // 7 days, upper bound
  })

  it('rejects out-of-bounds and malformed schedules', () => {
    for (const bad of ['4m', '10081m', '0h', '169h', '0d', '31d', '90s', '10x', 'm', '5 m', '5M', '']) {
      expect(() => parseScheduleMs(bad), bad).toThrow(AgentTaskError)
    }
  })
})

describe('enqueueInput schema', () => {
  const base = { goal: 'Check the Railway deploy status and write a one-paragraph summary.' }

  it('accepts a minimal ops task with defaults', () => {
    const parsed = enqueueInput.parse(base)
    expect(parsed.kind).toBe('ops')
    expect(parsed.priority).toBe(0)
  })

  it('accepts a fully specified scheduled task', () => {
    const parsed = enqueueInput.parse({
      ...base,
      kind: 'scheduled',
      schedule: '6h',
      model: 'qwen-vl-loop',
      thinking: 'medium',
      allowedTools: ['web_search', 'web_fetch'],
      maxSteps: 8,
      priority: 5,
    })
    expect(parsed.schedule).toBe('6h')
    expect(parsed.allowedTools).toEqual(['web_search', 'web_fetch'])
  })

  it('rejects empty/oversized goals and bad fields', () => {
    expect(() => enqueueInput.parse({ goal: '' })).toThrow()
    expect(() => enqueueInput.parse({ goal: 'x'.repeat(20_001) })).toThrow()
    expect(() => enqueueInput.parse({ ...base, kind: 'bogus' })).toThrow()
    expect(() => enqueueInput.parse({ ...base, schedule: '15 minutes' })).toThrow()
    expect(() => enqueueInput.parse({ ...base, thinking: 'extreme' })).toThrow()
    expect(() => enqueueInput.parse({ ...base, allowedTools: ['web search!'] })).toThrow()
    expect(() => enqueueInput.parse({ ...base, maxSteps: 0 })).toThrow()
    expect(() => enqueueInput.parse({ ...base, maxSteps: 65 })).toThrow()
    expect(() => enqueueInput.parse({ ...base, priority: 101 })).toThrow()
  })

  it('accepts a bounded dedicated-computer request and rejects bad TTLs', () => {
    const parsed = enqueueInput.parse({ ...base, computer: { enabled: true, ttlMinutes: 60 } })
    expect(parsed.computer).toEqual({ enabled: true, ttlMinutes: 60 })
    expect(enqueueInput.parse({ ...base, computer: { enabled: false } }).computer).toEqual({ enabled: false })
    expect(() => enqueueInput.parse({ ...base, computer: { enabled: true, ttlMinutes: 4 } })).toThrow()
    expect(() => enqueueInput.parse({ ...base, computer: { enabled: true, ttlMinutes: 241 } })).toThrow()
    expect(() => enqueueInput.parse({ ...base, computer: { ttlMinutes: 30 } })).toThrow()
  })
})

describe('BOT_DEFAULT_TOOLS', () => {
  it('is a subset of the reviewed built-in catalog', () => {
    const builtins = new Set(builtinToolNames())
    for (const name of BOT_DEFAULT_TOOLS) expect(builtins.has(name), name).toBe(true)
  })

  it('excludes media generation and mutation tools by default', () => {
    for (const excluded of ['generate_image', 'generate_video', 'speak_text', 'create_skill', 'create_custom_tool']) {
      expect(BOT_DEFAULT_TOOLS).not.toContain(excluded)
    }
  })
})

describe('computer enqueue gate (fail fast)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('rejects computer tasks when the provider is not configured, with an actionable message', async () => {
    vi.stubEnv('E2B_API_KEY', '')
    await expect(enqueueAgentTask({ goal: 'browse', computer: { enabled: true } }, 'tester'))
      .rejects.toMatchObject({ code: 'unavailable' })
    await expect(enqueueAgentTask({ goal: 'browse', computer: { enabled: true } }, 'tester'))
      .rejects.toThrow(/E2B_API_KEY/)
  })

  it('names the permanent failure codes (no pointless retries)', () => {
    expect(BOT_PERMANENT_FAILURES).toEqual(['BOT_TASK_INVALID', 'BOT_COMPUTER_UNCONFIGURED', 'BOT_OUT_OF_CREDITS'])
  })
})
