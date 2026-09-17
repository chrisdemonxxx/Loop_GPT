import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Prisma, VideoQueuePolicy } from '@prisma/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../providerHttp', async original => ({ ...await original<typeof import('../providerHttp')>(), providerRequest: vi.fn() }))
import { providerRequest, type ProviderResponse } from '../providerHttp'
import { prisma } from '../prisma'
import { createAccountedVideoJob, createDailyVideoJob, cancelAccountedVideoJob } from '../accountedVideoJobs'
import { claimVideoJobs, dispatchVideoClaim, processVideoClaim } from '../videoJobWorker'
import { createTinyVideoMp4 } from './fixtures/tinyVideoMp4'
import v1Router from '../../routes/v1'
import mediaRouter from '../../routes/media'

const db = prisma!, network = vi.mocked(providerRequest)
const endpoint = 'https://video.provider.example.com/generate', statusUrl = 'https://video.provider.example.com/jobs/queue/status'
const body = { prompt: 'Queue limits fixture' }
let users: string[], keys: string[], root: string, originalPolicy: VideoQueuePolicy
const owner = (i = 0) => ({ userId: users[i], apiKeyId: keys[i] })
const create = (pool: 'daily' | 'prepaid', i = 0) => pool === 'daily' ? createDailyVideoJob(users[i], body) : createAccountedVideoJob(owner(i), body)
const record = (jobId: string) => db.accountedVideoJob.findUniqueOrThrow({ where: { jobId }, include: { job: true, reservation: true, dailyReservation: true } })
const policy = (data: Partial<VideoQueuePolicy>) => db.videoQueuePolicy.update({ where: { id: 1 }, data: { ...data, revision: { increment: 1 } } })
const ready = (jobId: string) => db.$executeRaw`UPDATE "AccountedVideoJob" SET "nextAttemptAt" = clock_timestamp() - interval '1 second',
  "leaseExpiresAt" = CASE WHEN "leaseToken" IS NULL THEN NULL ELSE clock_timestamp() - interval '1 second' END WHERE "jobId" = ${jobId}`
function response(value: unknown, json = true): ProviderResponse {
  const buffer = json ? Buffer.from(JSON.stringify(value)) : value as Buffer
  return { status: 200, ok: true, url: endpoint, body: buffer, headers: new Headers({ 'content-type': json ? 'application/json' : 'video/mp4' }),
    async json() { return JSON.parse(buffer.toString()) }, async text() { return buffer.toString() }, async arrayBuffer() { return Uint8Array.from(buffer).buffer } }
}
async function claim(jobId: string) {
  const claims = await claimVideoJobs({ concurrency: 1, batchSize: 1 })
  expect(claims.map(c => c.jobId)).toEqual([jobId])
  return claims[0]
}
async function handle(pool: 'daily' | 'prepaid', i = 0) {
  const router = pool === 'daily' ? mediaRouter : v1Router
  const routePath = pool === 'daily' ? '/video-jobs' : '/videos/generations'
  const route = (router as any).stack.find((layer: any) => layer.route?.path === routePath && layer.route.methods.post).route
  const res: any = { statusCode: 200, status(code: number) { this.statusCode = code; return this }, json(value: unknown) { this.body = value; return this } }
  await route.stack.at(-1).handle({ api: owner(i), userId: users[i], body }, res)
  return res
}
beforeEach(async () => {
  originalPolicy = await db.videoQueuePolicy.findUniqueOrThrow({ where: { id: 1 } })
  await policy({ globalOutstanding: 12, userOutstanding: 6, globalActive: 2, userActive: 1 })
  users = Array.from({ length: 3 }, () => `queue-${randomUUID()}`)
  await db.user.createMany({ data: users.map(id => ({ id, email: `${id}@example.test`, password: 'fixture', name: 'Queue fixture',
    credits: 100, apiBalanceMicros: 10000000n })) })
  keys = await Promise.all(users.map(userId => db.apiKey.create({ data: { userId, keyHash: randomUUID(), prefix: 'fixture' } }).then(k => k.id)))
  vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true'); vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'true')
  vi.stubEnv('HF_VIDEO_ENDPOINT', endpoint); vi.stubEnv('HF_TOKEN', 'hf_queue_fixture_only')
  vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '30000'); vi.stubEnv('ACCOUNTED_VIDEO_REQUEST_MS', '5000')
  vi.stubEnv('ACCOUNTED_VIDEO_POLL_MS', '1000'); vi.stubEnv('ACCOUNTED_VIDEO_MAX_POLLS', '600')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-video-queue-')); vi.stubEnv('PRIVATE_FILES_DIR', root)
  network.mockReset().mockRejectedValue(new Error('Unexpected provider request'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  try {
    const where = { userId: { in: users } }
    await db.accountedVideoJob.deleteMany({ where: { job: where } }); await db.mediaJob.deleteMany({ where })
    await db.apiSettlementIntent.deleteMany({ where }); await db.apiUsage.deleteMany({ where }); await db.apiReservation.deleteMany({ where })
    await db.dailySettlementIntent.deleteMany({ where }); await db.usageEvent.deleteMany({ where }); await db.dailyReservation.deleteMany({ where })
    await db.privateFile.deleteMany({ where }); await db.apiKey.deleteMany({ where }); await db.user.deleteMany({ where: { id: { in: users } } })
    await db.videoQueuePolicy.upsert({ where: { id: 1 }, create: originalPolicy, update: originalPolicy })
  } finally { await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() }
})
afterAll(() => db.$disconnect())

describe.sequential('shared video queue: real PostgreSQL, mocked providers', () => {
  it.each(['prepaid', 'daily', 'mixed'] as const)('serializes concurrent %s admission at the per-user cap before debit', async pool => {
    await policy({ userOutstanding: 2 })
    const result = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => create(pool === 'mixed' ? i % 2 ? 'daily' : 'prepaid' : pool)))
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(2)
    for (const r of result) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'video_user_limit' })
    const daily = await db.dailyReservation.count({ where: { userId: users[0] } }), api = await db.apiReservation.count({ where: { userId: users[0] } })
    expect(daily + api).toBe(2)
    expect(await db.mediaJob.count({ where: { userId: users[0] } })).toBe(2)
    expect(await db.user.findUniqueOrThrow({ where: { id: users[0] } })).toMatchObject({ credits: 100 - daily * 10, apiBalanceMicros: 10000000n - BigInt(api) * 400000n })
    expect(network).not.toHaveBeenCalled()
  })
  it('serializes mixed pools and owners at the global admission cap', async () => {
    await policy({ globalOutstanding: 3, userOutstanding: 3 })
    const result = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => create(i % 2 ? 'daily' : 'prepaid', i % 3)))
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(3)
    for (const r of result) if (r.status === 'rejected') expect(['video_user_limit', 'video_global_limit']).toContain(r.reason.code)
    const where = { userId: { in: users } }
    expect(await db.mediaJob.count({ where })).toBe(3)
    expect(await db.apiReservation.count({ where }) + await db.dailyReservation.count({ where })).toBe(3)
    for (const id of users) {
      const daily = await db.dailyReservation.count({ where: { userId: id } }), api = await db.apiReservation.count({ where: { userId: id } })
      expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ credits: 100 - daily * 10, apiBalanceMicros: 10000000n - BigInt(api) * 400000n })
    }
  })
  it('counts all keys and both pools; duplicate POSTs remain separate jobs', async () => {
    await policy({ userOutstanding: 2 })
    const second = await db.apiKey.create({ data: { userId: users[0], keyHash: randomUUID(), prefix: 'fixture2' } })
    const a = await create('prepaid'), b = await createAccountedVideoJob({ userId: users[0], apiKeyId: second.id }, body)
    expect(a.id).not.toBe(b.id)
    await expect(create('daily')).rejects.toMatchObject({ code: 'video_user_limit' })
  })
  it.each(['daily', 'prepaid'] as const)('rolls back %s admission/hold/job together on SQL insertion failure', async pool => {
    await policy({ globalOutstanding: 2, userOutstanding: 2 })
    await db.$executeRawUnsafe(`ALTER TABLE "MediaJob" ADD CONSTRAINT queue_fixture_insert CHECK ("prompt" <> 'Queue limits fixture')`)
    try { await expect(create(pool)).rejects.toThrow() }
    finally { await db.$executeRawUnsafe('ALTER TABLE "MediaJob" DROP CONSTRAINT queue_fixture_insert') }
    expect(await db.user.findUniqueOrThrow({ where: { id: users[0] } })).toMatchObject({ credits: 100, apiBalanceMicros: 10000000n })
    expect(await db.dailyReservation.count({ where: { userId: users[0] } })).toBe(0)
    expect(await db.apiReservation.count({ where: { userId: users[0] } })).toBe(0)
    await create(pool); await create(pool)
    await expect(create(pool)).rejects.toMatchObject({ code: 'video_user_limit' })
  })
  it('concurrent claims earmark only shared free slots, skip saturated owners and dispatch atomically', async () => {
    const a = await create('prepaid'), a2 = await create('daily'), a3 = await create('prepaid')
    const b = await create('daily', 1), c = await create('prepaid', 2)
    const claims = (await Promise.all(Array.from({ length: 4 }, () => claimVideoJobs({ concurrency: 16, batchSize: 100 })))).flat()
    expect(new Set(claims.map(x => x.jobId))).toEqual(new Set([a.id, b.id]))
    expect(claims).toHaveLength(2)
    const dispatch = await Promise.allSettled([...claims, claims[0]].map(dispatchVideoClaim))
    expect(dispatch.filter(r => r.status === 'fulfilled')).toHaveLength(2)
    expect(dispatch.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(await db.accountedVideoJob.count({ where: { upstreamSlot: true } })).toBe(2)
    for (const id of [a.id, b.id]) {
      const row = await record(id)
      expect(row).toMatchObject({ state: 'submitting', upstreamSlot: true })
      expect((row.reservation ?? row.dailyReservation)?.state).toBe('dispatched')
    }
    for (const id of [a2.id, a3.id, c.id]) expect(await record(id)).toMatchObject({ state: 'queued', attempts: 0 })
    expect(await claimVideoJobs()).toEqual([])
  })
  it('expired queued earmarks can be reclaimed, stale workers cannot acquire slots', async () => {
    const job = await create('daily'), stale = await claim(job.id)
    await ready(job.id)
    const fresh = await claim(job.id)
    await expect(dispatchVideoClaim(stale)).rejects.toMatchObject({ code: 'lease_lost' })
    expect((await record(job.id)).upstreamSlot).toBe(false)
    await dispatchVideoClaim(fresh)
    expect((await record(job.id)).upstreamSlot).toBe(true)
  })
  it('a saturated owner cannot head-of-line block another owner even beyond a full batch of older jobs', async () => {
    await policy({ globalOutstanding: 120, userOutstanding: 110 })
    await db.user.update({ where: { id: users[0] }, data: { unlimited: true } })
    const first = await create('daily'), pending = await claim(first.id)
    await dispatchVideoClaim(pending)
    for (let i = 0; i < 101; i++) await create('daily')
    const other = await create('prepaid', 1)
    const claims = await claimVideoJobs({ concurrency: 16, batchSize: 100 })
    expect(claims.map(c => c.jobId)).toEqual([other.id])
    expect(await db.accountedVideoJob.count({ where: { job: { userId: users[0] }, attempts: 0 } })).toBe(101)
    await dispatchVideoClaim(claims[0])
    expect(await db.accountedVideoJob.count({ where: { upstreamSlot: true } })).toBe(2)
  })
  it('claim SQL failure rolls back earmarks and attempts without losing admission holds', async () => {
    const job = await create('prepaid'), before = await record(job.id)
    await db.$executeRawUnsafe('ALTER TABLE "AccountedVideoJob" ADD CONSTRAINT queue_fixture_claim CHECK (attempts = 0)')
    try { await expect(claimVideoJobs()).rejects.toThrow() }
    finally { await db.$executeRawUnsafe('ALTER TABLE "AccountedVideoJob" DROP CONSTRAINT queue_fixture_claim') }
    expect(await record(job.id)).toEqual(before)
    await claim(job.id)
  })
  it.each(['daily', 'prepaid'] as const)('retains %s upstream slots through waiting, cancellation, expiry and unknown', async pool => {
    await policy({ globalActive: 1 })
    const job = await create(pool)
    network.mockResolvedValueOnce(response({ job_id: 'fixture', status_url: statusUrl }))
    await processVideoClaim(await claim(job.id))
    const other = await create('prepaid', 1)
    expect(await claimVideoJobs()).toEqual([]) // waiting poll with no local promise/lease
    await ready(job.id)
    network.mockResolvedValueOnce(response({ status: 'running' }))
    await processVideoClaim(await claim(job.id))
    await cancelAccountedVideoJob(job.id, { userId: users[0] })
    expect((await record(job.id)).upstreamSlot).toBe(true)
    await ready(job.id)
    const expired = await claim(job.id); await ready(job.id)
    expect(await processVideoClaim(expired)).toBe('lease_lost')
    network.mockResolvedValueOnce(response({ status: 'unrecognized' }))
    await processVideoClaim(await claim(job.id))
    expect(await record(job.id)).toMatchObject({ state: 'needs_reconciliation', upstreamSlot: true, job: { status: 'cancelled' } })
    await expect(db.accountedVideoJob.update({ where: { jobId: job.id }, data: { upstreamSlot: false } })).rejects.toThrow()
    expect(await claimVideoJobs()).toEqual([])
    expect((await record(other.id)).attempts).toBe(0)
    expect(network.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1)
  })
  it('ambiguous submitting expiry and cancellation retain capacity and funds without resubmission', async () => {
    await policy({ globalActive: 1, globalOutstanding: 2, userOutstanding: 2 })
    const job = await create('prepaid'); await dispatchVideoClaim(await claim(job.id))
    await create('daily', 1)
    await ready(job.id)
    expect(await processVideoClaim(await claim(job.id))).toBe('needs_reconciliation')
    await cancelAccountedVideoJob(job.id, owner())
    await expect(create('prepaid', 2)).rejects.toMatchObject({ code: 'video_global_limit' })
    expect(await claimVideoJobs()).toEqual([])
    expect(await record(job.id)).toMatchObject({ upstreamSlot: true, reservation: { state: 'unknown' } })
    expect(network).not.toHaveBeenCalled()
  })
  it.each([
    ['daily', false], ['daily', true], ['prepaid', false], ['prepaid', true],
  ] as const)('confirmed %s settlement frees capacity (cancelled=%s)', async (pool, cancelled) => {
    await policy({ globalActive: 1, globalOutstanding: 2, userOutstanding: 2 })
    const job = await create(pool)
    network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    await processVideoClaim(await claim(job.id))
    expect(await record(job.id)).toMatchObject({ state: 'settling', upstreamSlot: true })
    const next = await create('prepaid', 1)
    if (cancelled) await cancelAccountedVideoJob(job.id, { userId: users[0] })
    await processVideoClaim(await claim(job.id))
    expect(await record(job.id)).toMatchObject({ state: cancelled ? 'cancelled' : 'completed', upstreamSlot: false })
    await create('daily', 2)
    expect((await claimVideoJobs()).map(c => c.jobId)).toEqual([next.id])
  })
  it('SQL rollback after slot acquisition/dispatch markers restores slot, ledger and lease', async () => {
    const job = await create('daily'), pending = await claim(job.id)
    const before = await record(job.id)
    await db.$executeRawUnsafe(`ALTER TABLE "MediaJob" ADD CONSTRAINT queue_fixture_dispatch CHECK ("status" <> 'processing')`)
    try { await expect(dispatchVideoClaim(pending)).rejects.toThrow() }
    finally { await db.$executeRawUnsafe('ALTER TABLE "MediaJob" DROP CONSTRAINT queue_fixture_dispatch') }
    expect(await record(job.id)).toEqual(before)
    await dispatchVideoClaim(pending)
    expect((await record(job.id)).upstreamSlot).toBe(true)
  })
  it('policy reduction between claim and dispatch pauses excess work without release; all workers see DB limits', async () => {
    const a = await create('daily'), b = await create('prepaid', 1)
    const claims = await claimVideoJobs({ concurrency: 2 })
    expect(claims).toHaveLength(2)
    await policy({ globalActive: 1 })
    await dispatchVideoClaim(claims.find(c => c.jobId === a.id)!)
    expect(await processVideoClaim(claims.find(c => c.jobId === b.id)!)).toBe('paused')
    expect(await record(b.id)).toMatchObject({ upstreamSlot: false, submittedAt: null, leaseToken: null, reservation: { state: 'reserved' } })
    expect(network).not.toHaveBeenCalled()
  })
  it('missing policy fails closed but settlement bypasses config and capacity gates', async () => {
    const job = await create('prepaid')
    network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    await processVideoClaim(await claim(job.id))
    await db.videoQueuePolicy.delete({ where: { id: 1 } })
    for (const pool of ['daily', 'prepaid'] as const) await expect(create(pool)).rejects.toMatchObject({ code: 'video_queue_config' })
    await processVideoClaim(await claim(job.id))
    expect(await record(job.id)).toMatchObject({ state: 'completed', upstreamSlot: false })
    await expect(claimVideoJobs()).rejects.toMatchObject({ code: 'video_queue_config' })
  })
  it('DB check constraints reject bad administrator configuration', async () => {
    for (const data of [{ userActive: 3 }, { globalActive: 0 }, { userOutstanding: 13 }, { version: 2 }, { revision: 0 }]) {
      await expect(db.videoQueuePolicy.update({ where: { id: 1 }, data })).rejects.toThrow()
    }
  })
  it.each(['daily', 'prepaid'] as const)('projects %s user/global/config caps and driver errors without cross-user counts', async pool => {
    await policy({ globalOutstanding: 2, userOutstanding: 1 })
    await create(pool)
    let res = await handle(pool)
    expect(res.statusCode).toBe(429); expect(JSON.stringify(res.body)).toContain('video_user_limit')
    await create(pool, 1)
    res = await handle(pool, 2)
    expect(res.statusCode).toBe(503); expect(JSON.stringify(res.body)).toContain('video_global_limit')
    await db.videoQueuePolicy.delete({ where: { id: 1 } })
    res = await handle(pool, 2)
    expect(res.statusCode).toBe(503); expect(JSON.stringify(res.body)).toContain('video_queue_config')
    const fault = vi.spyOn(db, '$transaction').mockRejectedValueOnce(new Error('SQL secret other-user capacity 12345'))
    try { res = await handle(pool, 2) } finally { fault.mockRestore() }
    expect(res.statusCode).toBe(503)
    expect(JSON.stringify(res.body)).not.toMatch(/12345|SQL|other-user|globalOutstanding|userActive/)
  })
  it('a lost dispatch commit acknowledgement retains the durable slot and cannot cause a duplicate POST', async () => {
    await policy({ globalActive: 1 })
    const job = await create('prepaid'), pending = await claim(job.id)
    const transaction = db.$transaction.bind(db)
    const fault = vi.spyOn(db, '$transaction').mockImplementationOnce((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: any) => {
      await transaction(work, options)
      throw new Error('Lost COMMIT acknowledgement')
    }) as any)
    try { await expect(dispatchVideoClaim(pending)).rejects.toThrow('acknowledgement') } finally { fault.mockRestore() }
    expect((await record(job.id)).upstreamSlot).toBe(true)
    await ready(job.id)
    await processVideoClaim(await claim(job.id))
    await create('daily', 1)
    expect(await claimVideoJobs()).toEqual([])
    expect(network).not.toHaveBeenCalled()
  })
  it('separate Node worker processes share claim earmarks and upstream capacity across both pools', async () => {
    for (let i = 0; i < 3; i++) { await create('daily', i); await create('prepaid', i) }
    // Each process has its own Prisma pool and module memory. Provider transport
    // is explicitly replaced; only claim and dispatch markers are exercised.
    const script = `
      const transport = require('./src/services/providerHttp.ts');
      transport.providerRequest = async () => { throw new Error('Fixture forbids provider I/O'); };
      const { claimVideoJobs, dispatchVideoClaim } = require('./src/services/videoJobWorker.ts');
      const { prisma } = require('./src/services/prisma.ts');
      (async () => {
        try {
          const claims = await claimVideoJobs({ concurrency: 16, batchSize: 100 });
          await Promise.all(claims.map(dispatchVideoClaim));
          console.log(JSON.stringify(claims));
        } finally { await prisma.$disconnect(); }
      })().catch(() => { process.exitCode = 1; });`
    const exec = promisify(execFile)
    const results = await Promise.all(Array.from({ length: 3 }, () => exec(process.execPath, ['-r', 'tsx/cjs', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, timeout: 15000,
    })))
    const claims = results.flatMap(r => JSON.parse(r.stdout))
    expect(claims).toHaveLength(2)
    expect(new Set(claims.map(c => c.jobId)).size).toBe(2)
    expect(await db.accountedVideoJob.count({ where: { upstreamSlot: true } })).toBe(2)
    expect(await claimVideoJobs()).toEqual([])
  })
  it('failed completion transaction retains the slot and capture can safely retry', async () => {
    await policy({ globalActive: 1 })
    const job = await create('daily')
    network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    await processVideoClaim(await claim(job.id))
    const pending = await claim(job.id), transaction = db.$transaction.bind(db)
    let failed = false
    const fault = vi.spyOn(db, '$transaction').mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: any) => {
      return transaction(async tx => {
        const update = tx.accountedVideoJob.update
        tx.accountedVideoJob.update = (async (args: any) => {
          const result = await update(args)
          if (args.data.state === 'completed' && !failed) { failed = true; throw new Error('Fixture rollback after slot release') }
          return result
        }) as typeof update
        try { return await work(tx) } finally { tx.accountedVideoJob.update = update }
      }, options)
    }) as any)
    try { expect(await processVideoClaim(pending)).toBe('retry') } finally { fault.mockRestore() }
    expect(failed).toBe(true)
    expect(await record(job.id)).toMatchObject({ state: 'settling', upstreamSlot: true, dailyReservation: { state: 'dispatched' } })
    expect(await db.usageEvent.count({ where: { userId: users[0] } })).toBe(0)
    const next = await create('prepaid', 1)
    expect(await claimVideoJobs()).toEqual([])
    await ready(job.id)
    await processVideoClaim(await claim(job.id))
    expect((await record(job.id)).upstreamSlot).toBe(false)
    expect((await claimVideoJobs()).map(c => c.jobId)).toEqual([next.id])
  })
})
