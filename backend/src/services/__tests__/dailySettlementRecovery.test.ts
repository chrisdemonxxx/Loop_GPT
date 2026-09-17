import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { enqueueDailySettlement, captureDailySettlement } from '../dailyReservations'
import { claimDailySettlements, dailySettlementExitCode, dailySettlementWorkerOptions, recoverDailySettlement, runDailySettlementBatch } from '../dailySettlementRecovery'

describe('daily settlement recovery fails closed', () => {
  it('requires PostgreSQL for every entry point', async () => {
    for (const call of [() => enqueueDailySettlement('fixture', 'fixture', 'chat'),
      () => captureDailySettlement('fixture'), () => claimDailySettlements(),
      () => recoverDailySettlement({ reservationId: 'fixture', leaseToken: 'fixture' }), () => runDailySettlementBatch()]) {
      await expect(call()).rejects.toMatchObject({ code: 'DAILY_ACCOUNTING_UNAVAILABLE', status: 503 })
    }
  })
  it.each([
    { batchSize: 0 }, { batchSize: 101 }, { concurrency: 17 }, { concurrency: -1 },
    { leaseMs: 999 }, { leaseMs: 300001 }, { pollMs: 99 }, { pollMs: 60001 },
    { batchSize: NaN }, { pollMs: Infinity }, { concurrency: 1.5 }, { batchSize: '2' },
    { pollMs: null }, { unexpected: 1 }, null, [],
  ])('rejects invalid options before accessing the database: %j', async options => {
    expect(() => dailySettlementWorkerOptions(options as any)).toThrow('Invalid daily settlement worker options')
    await expect(runDailySettlementBatch(options as any)).rejects.toMatchObject({ code: 'INVALID_DAILY_WORKER_OPTIONS' })
  })
  it.each([{ tokensIn: -1 }, { tokensOut: 0.5 }, { images: NaN }, { tokensIn: 2147483648 },
    { tokensOut: null }, { model: 3 }, { model: 'x'.repeat(1025) }])('rejects invalid intent metrics: %j', async opts => {
    await expect(enqueueDailySettlement('fixture', 'fixture', 'chat', opts as any)).rejects.toMatchObject({ code: 'INVALID_DAILY_USAGE' })
  })
})

describe('standalone daily settlement CLI', () => {
  it('does not report interrupted or unprocessed one-shot work as successful', () => {
    const clean = { claimed: 1, succeeded: 1, retry: 0, conflict: 0, dead_letter: 0, lease_lost: 0, unavailable: 0, unprocessed: 0, aborted: false }
    expect(dailySettlementExitCode(clean)).toBe(0)
    expect(dailySettlementExitCode({ ...clean, claimed: 3, unprocessed: 2 })).toBe(1)
    expect(dailySettlementExitCode({ ...clean, claimed: 0, succeeded: 0, aborted: true })).toBe(1)
    expect(dailySettlementExitCode({ ...clean, conflict: 1, aborted: true })).toBe(3)
  })
  const script = resolve('scripts/daily-settlement-worker.mjs')
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'test' },
  })
  it('prints help without a database or loading the compiled service', () => {
    const result = run('--help')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--once')
    expect(result.stdout).toContain('SIGINT/SIGTERM')
    expect(result.stderr).toBe('')
  })
  it.each([['--wat'], ['--batch-size', '0'], ['--lease-ms', '999999'], ['--poll-ms'],
    ['--concurrency', '1.5'], ['--once', '--once'], ['--poll-ms', 'NaN'], ['--help', '--once'], ['constructor', '1'], ['__proto__', '1']])('rejects invalid CLI arguments %j', (...args) => {
    const result = run(...args)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Invalid daily settlement worker arguments')
  })
  it('exits nonzero without a database', () => {
    const result = run('--once')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unavailable')
    expect(result.stderr).not.toContain('Error:')
  })
})
