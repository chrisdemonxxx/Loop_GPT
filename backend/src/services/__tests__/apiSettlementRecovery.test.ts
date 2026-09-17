import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enqueueApiSettlement, captureApiSettlement, captureApiReservation } from '../apiReservations'
import { apiSettlementExitCode, apiSettlementWorkerOptions, claimApiSettlements, recoverApiSettlement, runApiSettlementBatch } from '../apiSettlementRecovery'

const input = { id: 'fixture', userId: 'fixture', expectedKind: 'chat' as const, costMicros: 40 }
describe('prepaid recovery validates inputs and fails closed', () => {
  it('requires a database for every entry point', async () => {
    for (const call of [() => enqueueApiSettlement(input), () => captureApiReservation(input), () => captureApiSettlement(input.id),
      () => claimApiSettlements(), () => recoverApiSettlement({ reservationId: input.id, leaseToken: 'fixture' }), () => runApiSettlementBatch()]) {
      await expect(call()).rejects.toMatchObject({ code: 'unavailable' })
    }
  })
  it.each([{ tokensIn: -1 }, { tokensOut: 0.5 }, { units: NaN }, { tokensIn: 2147483648 }, { tokensOut: null },
    { costMicros: -1n }, { costMicros: Number.MAX_SAFE_INTEGER + 1 }, { costMicros: Infinity }, { costMicros: '1' },
    { expectedKind: 'agent' }, { expectedModel: '' }, { expectedModel: 'x'.repeat(257) }, { apiKeyId: '' }, { id: '' }, { userId: ' ' }])(
    'rejects invalid confirmed usage before persistence: %s', async patch => {
      await expect(enqueueApiSettlement({ ...input, ...patch } as any)).rejects.toMatchObject({ code: expect.stringMatching(/^invalid_/) })
    })
  it.each([{ batchSize: 0 }, { batchSize: 101 }, { concurrency: 17 }, { concurrency: -1 }, { leaseMs: 999 },
    { leaseMs: 300001 }, { pollMs: 99 }, { pollMs: 60001 }, { batchSize: NaN }, { pollMs: Infinity },
    { concurrency: 1.5 }, { batchSize: '2' }, { pollMs: null }, { unexpected: 1 }, null, []])('rejects invalid worker options: %j', async options => {
    expect(() => apiSettlementWorkerOptions(options as any)).toThrow()
    await expect(runApiSettlementBatch(options as any)).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

describe('standalone prepaid worker CLI', () => {
  const script = resolve('scripts/api-settlement-worker.mjs')
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'test' },
  })
  it('reports interrupted one-shot batches as incomplete', () => {
    const clean = { claimed: 1, succeeded: 1, retry: 0, conflict: 0, dead_letter: 0, lease_lost: 0, unavailable: 0, unprocessed: 0, aborted: false }
    expect(apiSettlementExitCode(clean)).toBe(0)
    for (const patch of [{ aborted: true }, { unprocessed: 1 }, { retry: 1 }, { lease_lost: 1 }, { unavailable: 1 }]) {
      expect(apiSettlementExitCode({ ...clean, ...patch })).toBe(1)
    }
    expect(apiSettlementExitCode({ ...clean, conflict: 1, aborted: true })).toBe(3)
    expect(apiSettlementExitCode({ ...clean, dead_letter: 1 })).toBe(3)
  })
  it('prints help without loading the DB or compiled backend', () => {
    const result = run('--help')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PREPAID')
    expect(result.stdout).toContain('SIGINT/SIGTERM')
    expect(result.stderr).toBe('')
  })
  it.each([['--wat'], ['--batch-size', '0'], ['--lease-ms', '999999'], ['--poll-ms'], ['--concurrency', '1.5'],
    ['--once', '--once'], ['--poll-ms', 'NaN'], ['--help', '--once'], ['constructor', '1'], ['__proto__', '1']])('rejects malformed CLI arguments %j', (...args) => {
    expect(run(...args).status).toBe(2)
  })
  it('exits nonzero and sanitized without a DB', () => {
    const result = run('--once')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unavailable')
    expect(result.stderr).not.toContain('Error:')
  })
})
