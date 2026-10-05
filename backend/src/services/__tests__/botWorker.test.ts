import { describe, expect, it } from 'vitest'
import { AgentTaskError } from '../../services/agentTasks'
import { botWorkerExitCode, botWorkerOptions, type BotBatchResult } from '../../services/botWorker'

describe('botWorkerOptions', () => {
  it('applies safe defaults', () => {
    expect(botWorkerOptions()).toEqual({ batchSize: 1, leaseMs: 600_000, pollMs: 2000 })
  })

  it('accepts bounded overrides', () => {
    expect(botWorkerOptions({ batchSize: 5, leaseMs: 30_000, pollMs: 500 }))
      .toEqual({ batchSize: 5, leaseMs: 30_000, pollMs: 500 })
  })

  it('rejects out-of-bounds, nulls and unknown keys', () => {
    for (const bad of [
      { batchSize: 0 }, { batchSize: 26 }, { batchSize: 1.5 },
      { leaseMs: 29_999 }, { leaseMs: 3_600_001 },
      { pollMs: 99 }, { pollMs: 60_001 },
      { batchSize: null }, { unknown: 1 }, null, [], 'x',
    ]) {
      expect(() => botWorkerOptions(bad as any), JSON.stringify(bad)).toThrow(AgentTaskError)
    }
  })
})

describe('botWorkerExitCode', () => {
  const clean: BotBatchResult = {
    claimed: 2, succeeded: 2, retry: 0, cancelled: 0, dead_letter: 0,
    lease_lost: 0, unavailable: 0, unprocessed: 0, aborted: false,
  }

  it('maps batch outcomes to CLI exit codes like the settlement workers', () => {
    expect(botWorkerExitCode(clean)).toBe(0)
    expect(botWorkerExitCode({ ...clean, cancelled: 1, succeeded: 1 })).toBe(0) // operator cancels are clean
    expect(botWorkerExitCode({ ...clean, dead_letter: 1 })).toBe(3)
    expect(botWorkerExitCode({ ...clean, retry: 1 })).toBe(1)
    expect(botWorkerExitCode({ ...clean, lease_lost: 1 })).toBe(1)
    expect(botWorkerExitCode({ ...clean, unavailable: 1 })).toBe(1)
    expect(botWorkerExitCode({ ...clean, aborted: true })).toBe(1)
    expect(botWorkerExitCode({ ...clean, unprocessed: 1 })).toBe(1)
  })
})
