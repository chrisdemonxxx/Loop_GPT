import { randomUUID } from 'crypto'
import { constants, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ transaction: vi.fn(), database: vi.fn(), provider: vi.fn(),
  query: vi.fn(), dispatch: vi.fn(), daily: vi.fn() }))
vi.mock('../apiReservations', async importOriginal => ({ ...await importOriginal<any>(), apiTransaction: calls.transaction }))
vi.mock('../accountedVideoJobs', async importOriginal => ({ ...await importOriginal<any>(),
  videoDatabase: calls.database, videoDispatchEnabled: calls.dispatch, dailyVideoDispatchEnabled: calls.daily }))
vi.mock('../providerHttp', async importOriginal => ({ ...await importOriginal<any>(), providerRequest: calls.provider }))
import { claimVideoJobs, runVideoJobBatch, videoWorkerOptions } from '../videoJobWorker'
import { initializePrivateStorage, PRIVATE_STORE_MARKER } from '../privateStorage'

let root: string
beforeEach(async () => {
  vi.resetAllMocks()
  calls.dispatch.mockReturnValue(false); calls.daily.mockReturnValue(false)
  calls.transaction.mockImplementation(callback => callback({ $queryRaw: calls.query }))
  calls.query.mockImplementation(async (sql: TemplateStringsArray) => sql.join('').includes('UPDATE "VideoQueuePolicy"') ? [{
    id: 1, version: 1, revision: 1, globalOutstanding: 12, userOutstanding: 6, globalActive: 2, userActive: 1,
  }] : [])
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-worker-preflight-')))
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PRIVATE_FILES_STORAGE_MODE', 'shared-filesystem')
  vi.stubEnv('PRIVATE_FILES_DIR', root); vi.stubEnv('PRIVATE_FILES_STORE_ID', randomUUID())
  vi.stubEnv('PRIVATE_FILES_MIN_FREE_BYTES', '67108864')
})
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }) })

it('preflights production storage before DB claims or provider calls, including dispatch-disabled recovery', async () => {
  await expect(runVideoJobBatch()).rejects.toMatchObject({ status: 503 })
  expect(calls.database).not.toHaveBeenCalled(); expect(calls.transaction).not.toHaveBeenCalled(); expect(calls.provider).not.toHaveBeenCalled()
  await initializePrivateStorage()
  expect((await runVideoJobBatch()).claimed).toBe(0)
  expect(calls.transaction).toHaveBeenCalledTimes(1)
  await fs.unlink(path.join(root, PRIVATE_STORE_MARKER))
  await expect(runVideoJobBatch()).rejects.toMatchObject({ status: 503 })
  expect(calls.transaction).toHaveBeenCalledTimes(1); expect(calls.provider).not.toHaveBeenCalled()
})

it.each(['low space', 'statfs failure', 'read-only'] as const)('restricts claims to settlement after %s even with dispatch enabled', async failure => {
  await initializePrivateStorage()
  calls.dispatch.mockReturnValue(true); calls.daily.mockReturnValue(true)
  if (failure === 'low space') vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 4096n, bavail: 0n } as any)
  else if (failure === 'statfs failure') vi.spyOn(fs, 'statfs').mockRejectedValue(new Error('storage offline'))
  else {
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
      if (typeof flags === 'number' && (flags & constants.O_CREAT)) throw Object.assign(new Error('read-only'), { code: 'EROFS' })
      return open(filename, flags, mode)
    })
  }
  expect((await runVideoJobBatch()).claimed).toBe(0)
  expect(calls.database).toHaveBeenCalledTimes(1)
  expect(calls.query).toHaveBeenCalledTimes(2) // policy mutex, then recovery; never queued claims
  const [sql, dispatch, daily] = calls.query.mock.calls[1]
  expect(sql.join('')).toContain('"state" = \'settling\'')
  expect(sql.join('')).toContain("'submitting','polling'")
  expect(dispatch).toBe(false); expect(daily).toBe(true)
  expect(calls.provider).not.toHaveBeenCalled()
})

it.each(['missing marker', 'wrong identity', 'blank namespace', 'unreadable marker'] as const)('blocks every claim for %s', async failure => {
  await initializePrivateStorage()
  if (failure === 'missing marker') await fs.unlink(path.join(root, PRIVATE_STORE_MARKER))
  if (failure === 'wrong identity') vi.stubEnv('PRIVATE_FILES_STORE_ID', randomUUID())
  if (failure === 'blank namespace') vi.stubEnv('PRIVATE_FILES_DIR', '')
  if (failure === 'unreadable marker') vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
  await expect(runVideoJobBatch()).rejects.toMatchObject({ status: 503 })
  expect(calls.database).not.toHaveBeenCalled(); expect(calls.transaction).not.toHaveBeenCalled(); expect(calls.provider).not.toHaveBeenCalled()
})

it('rechecks namespace after a failed probe rather than treating a lost root as read-only', async () => {
  await initializePrivateStorage()
  vi.spyOn(fs, 'statfs').mockImplementation(async () => {
    await fs.unlink(path.join(root, PRIVATE_STORE_MARKER))
    throw new Error('lost namespace during probe')
  })
  await expect(runVideoJobBatch()).rejects.toMatchObject({ status: 503 })
  expect(calls.transaction).not.toHaveBeenCalled(); expect(calls.provider).not.toHaveBeenCalled()
})

it('keeps the recovery mode internal and still rejects unknown worker options', async () => {
  expect(() => videoWorkerOptions({ mode: 'settling-only' } as any)).toThrow()
  await expect(claimVideoJobs({ settlingOnly: true } as any)).rejects.toMatchObject({ code: 'invalid_request' })
  await expect(runVideoJobBatch({ recoveryOnly: true } as any)).rejects.toMatchObject({ code: 'invalid_request' })
  expect(calls.transaction).not.toHaveBeenCalled()
})

it('retains normal queued claims when writes and both dispatch flags are enabled', async () => {
  await initializePrivateStorage()
  calls.dispatch.mockReturnValue(true); calls.daily.mockReturnValue(true)
  await runVideoJobBatch()
  expect(calls.query).toHaveBeenCalledTimes(3)
  expect(calls.query.mock.calls[1][1]).toBe(true)
  expect(calls.query.mock.calls[2][0].join('')).toContain("v.state = 'queued'")
})
