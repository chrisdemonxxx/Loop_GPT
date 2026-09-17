import { randomUUID } from 'crypto'
import { constants, promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { VideoQueuePolicy } from '@prisma/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../providerHttp', async original => ({ ...await original<typeof import('../providerHttp')>(), providerRequest: vi.fn() }))
import { providerRequest, type ProviderResponse } from '../providerHttp'
import { prisma } from '../prisma'
import { createAccountedVideoJob, createDailyVideoJob } from '../accountedVideoJobs'
import { claimVideoJobs, dispatchVideoClaim, processVideoClaim, runVideoJobBatch } from '../videoJobWorker'
import { readOwnedFile } from '../privateFiles'
import { initializePrivateStorage, PRIVATE_STORE_MARKER } from '../privateStorage'
import { createTinyVideoMp4 } from './fixtures/tinyVideoMp4'

const db = prisma!, network = vi.mocked(providerRequest)
const endpoint = 'https://video.provider.example.com/generate'
const pools = ['daily', 'prepaid'] as const
let userId: string, keyId: string, root: string, originalPolicy: VideoQueuePolicy
const record = (jobId: string) => db.accountedVideoJob.findUniqueOrThrow({ where: { jobId }, include: {
  job: true, reservation: { include: { settlementIntent: true, usage: true } },
  dailyReservation: { include: { settlementIntent: true, usage: true } },
} })
const create = (pool: typeof pools[number]) => pool === 'daily'
  ? createDailyVideoJob(userId, { prompt: 'Storage recovery fixture' })
  : createAccountedVideoJob({ userId, apiKeyId: keyId }, { prompt: 'Storage recovery fixture' })

beforeEach(async () => {
  originalPolicy = await db.videoQueuePolicy.findUniqueOrThrow({ where: { id: 1 } })
  await db.videoQueuePolicy.update({ where: { id: 1 }, data: {
    globalOutstanding: 12, userOutstanding: 12, globalActive: 6, userActive: 6, revision: { increment: 1 },
  } })
  userId = `video-storage-${randomUUID()}`
  await db.user.create({ data: { id: userId, email: `${userId}@example.test`, password: 'fixture', name: 'Storage fixture',
    credits: 100, apiBalanceMicros: 10000000n } })
  keyId = (await db.apiKey.create({ data: { userId, keyHash: randomUUID(), prefix: 'fixture' } })).id
  vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true'); vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'true')
  vi.stubEnv('HF_VIDEO_ENDPOINT', endpoint); vi.stubEnv('HF_TOKEN', 'hf_storage_fixture_only')
  vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '30000'); vi.stubEnv('ACCOUNTED_VIDEO_REQUEST_MS', '5000')
  vi.stubEnv('ACCOUNTED_VIDEO_POLL_MS', '1000'); vi.stubEnv('ACCOUNTED_VIDEO_MAX_POLLS', '600')
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'loop-video-storage-recovery-')))
  vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PRIVATE_FILES_STORAGE_MODE', 'shared-filesystem')
  vi.stubEnv('PRIVATE_FILES_DIR', root); vi.stubEnv('PRIVATE_FILES_STORE_ID', randomUUID())
  vi.stubEnv('PRIVATE_FILES_MIN_FREE_BYTES', '67108864')
  await initializePrivateStorage()
  network.mockReset().mockRejectedValue(new Error('Unexpected provider request'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  try {
    const where = { userId }
    await db.accountedVideoJob.deleteMany({ where: { job: where } }); await db.mediaJob.deleteMany({ where })
    await db.apiSettlementIntent.deleteMany({ where }); await db.apiUsage.deleteMany({ where }); await db.apiReservation.deleteMany({ where })
    await db.dailySettlementIntent.deleteMany({ where }); await db.usageEvent.deleteMany({ where }); await db.dailyReservation.deleteMany({ where })
    await db.privateFile.deleteMany({ where }); await db.apiKey.deleteMany({ where }); await db.user.deleteMany({ where: { id: userId } })
    await db.videoQueuePolicy.upsert({ where: { id: 1 }, create: originalPolicy, update: originalPolicy })
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})
afterAll(() => db.$disconnect())

async function prepared(pool: typeof pools[number], state: 'settling' | 'submitting' | 'polling') {
  const job = await create(pool)
  const claims = await claimVideoJobs({ batchSize: 1, concurrency: 1 })
  expect(claims.map(c => c.jobId)).toEqual([job.id])
  if (state === 'settling') {
    const buffer = createTinyVideoMp4()
    network.mockResolvedValueOnce({ status: 200, ok: true, url: endpoint, body: buffer,
      headers: new Headers({ 'content-type': 'video/mp4' }), async json() { throw new Error('Not JSON') },
      async text() { return buffer.toString() }, async arrayBuffer() { return Uint8Array.from(buffer).buffer },
    } satisfies ProviderResponse)
    expect(await processVideoClaim(claims[0])).toBe('advanced')
  } else {
    await dispatchVideoClaim(claims[0])
    if (state === 'polling') {
      await db.mediaJob.update({ where: { id: job.id }, data: { statusUrl: 'https://video.provider.example.com/jobs/fixture/status' } })
      await db.accountedVideoJob.update({ where: { jobId: job.id }, data: { state: 'polling' } })
    }
  }
  expect(await record(job.id)).toMatchObject({ state, upstreamSlot: true })
  // Park prepared work until all fixtures exist, then make every state due.
  await db.$executeRaw`UPDATE "AccountedVideoJob" SET "nextAttemptAt" = clock_timestamp() + interval '1 hour',
    "leaseToken" = NULL, "leaseExpiresAt" = NULL WHERE "jobId" = ${job.id}`
  return job.id
}

async function fixture() {
  const staged = [], untouched = []
  for (const pool of pools) staged.push(await prepared(pool, 'settling'))
  for (const pool of pools) for (const state of ['submitting', 'polling'] as const) untouched.push(await prepared(pool, state))
  for (const pool of pools) untouched.push((await create(pool)).id)
  await db.$executeRaw`UPDATE "AccountedVideoJob" SET "nextAttemptAt" = clock_timestamp() - interval '1 second'
    WHERE "jobId" IN (SELECT id FROM "MediaJob" WHERE "userId" = ${userId})`
  const before = await Promise.all(untouched.map(record))
  expect(before.filter(row => row.state === 'queued')).toHaveLength(2)
  expect(await db.accountedVideoJob.count({ where: { job: { userId }, upstreamSlot: true } })).toBe(6)
  expect(await db.privateFile.count({ where: { userId } })).toBe(0)
  network.mockClear()
  return { staged, untouched, before }
}

describe.sequential('production video recovery with real PostgreSQL and staged filesystem bytes', () => {
  it.each(['low space', 'read-only', 'dispatch disabled', 'daily disabled', 'missing policy'] as const)(
    'captures and publishes both pools under %s, freeing slots without claiming any upstream work', async scenario => {
      const { staged, untouched, before } = await fixture()
      const balance = await db.user.findUniqueOrThrow({ where: { id: userId } })
      if (scenario === 'read-only') {
        const open = fs.open.bind(fs)
        vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, mode) => {
          if (typeof flags === 'number' && (flags & (constants.O_CREAT | constants.O_WRONLY | constants.O_RDWR))) {
            throw Object.assign(new Error('read-only fixture'), { code: 'EROFS' })
          }
          return open(filename, flags, mode)
        })
      } else vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 4096n, bavail: 0n } as any)
      if (scenario === 'dispatch disabled') vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'false')
      if (scenario === 'daily disabled') vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'false')
      if (scenario === 'missing policy') await db.videoQueuePolicy.delete({ where: { id: 1 } })

      // Multiple claim rounds: after each publication there is free capacity,
      // but storage degradation must continue excluding queued/submitting/polling.
      expect(await runVideoJobBatch({ batchSize: 10, concurrency: 1 })).toMatchObject({
        claimed: 2, advanced: 2, retry: 0, paused: 0, needs_reconciliation: 0, lease_lost: 0, unavailable: 0,
      })
      expect(await Promise.all(untouched.map(record))).toEqual(before)
      expect(network).not.toHaveBeenCalled()
      for (const jobId of staged) {
        const row = await record(jobId)
        expect(row).toMatchObject({ state: 'completed', upstreamSlot: false, leaseToken: null, leaseExpiresAt: null,
          job: { status: 'completed', progress: 100, error: null } })
        const reservation = row.reservation ?? row.dailyReservation!
        expect(reservation).toMatchObject({ state: 'captured', settlementIntent: { status: 'succeeded' } })
        expect(reservation.usage).not.toBeNull()
        if (row.reservation) expect(row.reservation).toMatchObject({ capturedMicros: 400000n,
          usage: { costMicros: 400000n, units: 1 } })
        else expect(row.dailyReservation!.usage).toMatchObject({ kind: 'video', credits: 10 })
        const artifact = row.stagedArtifact as { id: string }
        expect(row.job.outputUrl).toBe(`/api/files/${artifact.id}/content`)
        expect((await readOwnedFile(userId, artifact.id)).buffer).toEqual(createTinyVideoMp4())
      }
      expect(await db.accountedVideoJob.count({ where: { job: { userId }, upstreamSlot: true } })).toBe(4)
      expect(await db.privateFile.count({ where: { userId } })).toBe(2)
      expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
      expect(await db.usageEvent.count({ where: { userId } })).toBe(1)
      expect(await db.user.findUniqueOrThrow({ where: { id: userId } })).toMatchObject({
        credits: balance.credits, apiBalanceMicros: balance.apiBalanceMicros,
      })
      expect((await runVideoJobBatch()).claimed).toBe(0)
      expect(await Promise.all(untouched.map(record))).toEqual(before)
      expect(network).not.toHaveBeenCalled()
    })

  it.each(['blank namespace', 'wrong identity', 'missing marker'] as const)('blocks even staged recovery for %s', async scenario => {
    const { staged, untouched } = await fixture()
    const before = await Promise.all([...staged, ...untouched].map(record))
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 4096n, bavail: 0n } as any)
    if (scenario === 'blank namespace') vi.stubEnv('PRIVATE_FILES_DIR', '')
    if (scenario === 'wrong identity') vi.stubEnv('PRIVATE_FILES_STORE_ID', randomUUID())
    if (scenario === 'missing marker') await fs.unlink(path.join(root, PRIVATE_STORE_MARKER))
    await expect(runVideoJobBatch()).rejects.toMatchObject({ status: 503 })
    expect(await Promise.all([...staged, ...untouched].map(record))).toEqual(before)
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
    expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
    expect(network).not.toHaveBeenCalled()
  })
})
