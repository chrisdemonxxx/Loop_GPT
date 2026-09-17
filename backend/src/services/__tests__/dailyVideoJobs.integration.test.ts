import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type { Server } from 'http'
import os from 'os'
import path from 'path'
import bcrypt from 'bcryptjs'
import express from 'express'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the provider transport is substituted. Database, auth, leases, filesystem,
// MP4 admission and settlement recovery all run their real implementations.
vi.mock('../providerHttp', async original => ({ ...await original<typeof import('../providerHttp')>(), providerRequest: vi.fn() }))
import { providerRequest, type ProviderResponse } from '../providerHttp'
import { prisma } from '../prisma'
import { createApiKey, type IssuedKey } from '../apiKeys'
import { createDailyVideoJob, createAccountedVideoJob, cancelAccountedVideoJob } from '../accountedVideoJobs'
import { claimVideoJobs, dispatchVideoClaim, processVideoClaim, runVideoJobBatch } from '../videoJobWorker'
import { getDailyAccountUser } from '../dailyReservations'
import { runDailySettlementBatch } from '../dailySettlementRecovery'
import { readOwnedFile } from '../privateFiles'
import authRouter from '../../routes/auth'
import mediaRouter from '../../routes/media'
import v1Router from '../../routes/v1'
import { filesRouter } from '../../routes/files'
import { createTinyVideoMp4 } from './fixtures/tinyVideoMp4'

const db = prisma!, network = vi.mocked(providerRequest)
const endpoint = 'https://video.provider.example.com/generate', statusUrl = 'https://video.provider.example.com/jobs/daily/status'
const body = { prompt: 'Daily video fixture' }, password = 'Daily-video-fixture-only-42'
let userId: string, otherId: string, key: IssuedKey, secondKey: IssuedKey, foreignKey: IssuedKey
let root: string, server: Server, base: string, passwordHash: string
const owner = () => ({ userId, apiKeyId: key.id })
const account = () => db.user.findUniqueOrThrow({ where: { id: userId } })
async function record(jobId: string) {
  const row = await db.accountedVideoJob.findUniqueOrThrow({ where: { jobId }, include: {
    job: true, dailyReservation: { include: { settlementIntent: true, usage: true } } } })
  if (!row.dailyReservation || !row.dailyReservationId) throw new Error('Expected daily fixture')
  return { ...row, dailyReservation: row.dailyReservation, dailyReservationId: row.dailyReservationId }
}
const ready = (jobId: string) => db.$executeRaw`UPDATE "AccountedVideoJob" SET "nextAttemptAt" = clock_timestamp() - interval '1 second' WHERE "jobId" = ${jobId}`
function response(value: unknown, json = true): ProviderResponse {
  const buffer = json ? Buffer.from(JSON.stringify(value)) : value as Buffer
  return { status: 200, ok: true, url: endpoint, body: buffer, headers: new Headers({ 'content-type': json ? 'application/json' : 'video/mp4' }),
    async json() { return JSON.parse(buffer.toString()) }, async text() { return buffer.toString() },
    async arrayBuffer() { return Uint8Array.from(buffer).buffer } }
}
async function claim(jobId: string, leaseMs = 30000) {
  const claims = await claimVideoJobs({ batchSize: 1, concurrency: 1, leaseMs })
  expect(claims).toHaveLength(1); expect(claims[0].jobId).toBe(jobId)
  return claims[0]
}
async function staged() {
  const job = await createDailyVideoJob(userId, body)
  network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
  expect(await processVideoClaim(await claim(job.id))).toBe('advanced')
  expect((await record(job.id)).state).toBe('settling')
  return job
}
async function polling() {
  const job = await createDailyVideoJob(userId, body)
  network.mockResolvedValueOnce(response({ job_id: 'daily-fixture', status_url: statusUrl }))
  await processVideoClaim(await claim(job.id)); await ready(job.id)
  expect((await record(job.id)).state).toBe('polling')
  return job
}
async function http(route: string, bearer?: string, method = 'GET', payload?: unknown) {
  return fetch(`${base}${route}`, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
}
async function login(id: string) {
  const result = await http('/api/auth/login', undefined, 'POST', { email: `${id}@example.test`, password })
  expect(result.status).toBe(200)
  return (await result.json() as { token: string }).token
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeAll(async () => {
  passwordHash = await bcrypt.hash(password, 4)
  const app = express(); app.use(express.json())
  app.use('/api/auth', authRouter); app.use('/api/media', mediaRouter); app.use('/v1', v1Router); app.use('/api/files', filesRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local fixture port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  network.mockReset().mockRejectedValue(new Error('Unexpected provider fixture request'))
  vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true'); vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'true')
  vi.stubEnv('HF_VIDEO_ENDPOINT', endpoint); vi.stubEnv('HF_TOKEN', 'hf_daily_fixture_only')
  vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '30000'); vi.stubEnv('ACCOUNTED_VIDEO_REQUEST_MS', '5000')
  vi.stubEnv('ACCOUNTED_VIDEO_POLL_MS', '1000'); vi.stubEnv('ACCOUNTED_VIDEO_MAX_POLLS', '600')
  vi.stubEnv('PUBLIC_API_URL', '')
  const localFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (new URL(input instanceof Request ? input.url : String(input)).origin !== base) throw new Error('Non-fixture HTTP forbidden')
    return localFetch(input, init)
  })
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-video-'))
  vi.stubEnv('PRIVATE_FILES_DIR', root)
  userId = `daily-video-${randomUUID()}`; otherId = `daily-video-${randomUUID()}`
  await db.user.createMany({ data: [userId, otherId].map(id => ({ id, email: `${id}@example.test`, password: passwordHash,
    name: 'Daily video fixture', credits: 30, apiBalanceMicros: 10000000n })) })
  key = await createApiKey(userId, 'Original'); secondKey = await createApiKey(userId, 'Same account'); foreignKey = await createApiKey(otherId, 'Other account')
})
afterEach(async () => {
  vi.restoreAllMocks()
  try {
    const owned = { userId: { in: [userId, otherId] } }
    await db.accountedVideoJob.deleteMany({ where: { job: owned } }); await db.mediaJob.deleteMany({ where: owned })
    await db.dailySettlementIntent.deleteMany({ where: owned }); await db.usageEvent.deleteMany({ where: owned }); await db.dailyReservation.deleteMany({ where: owned })
    await db.apiSettlementIntent.deleteMany({ where: owned }); await db.apiUsage.deleteMany({ where: owned }); await db.apiReservation.deleteMany({ where: owned })
    await db.privateFile.deleteMany({ where: owned }); await db.apiKey.deleteMany({ where: owned })
    await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } })
  } finally { await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() }
})
afterAll(async () => {
  try { await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) }) }
  finally { await db.$disconnect() }
})

describe.sequential('daily video: PostgreSQL accounting and shared durable worker', () => {
  it.each(['owner cancellation', 'worker rejection'])('immutable debit evidence prevents inflated refunds during %s', async action => {
    const job = await createDailyVideoJob(userId, body), original = (await record(job.id)).dailyReservation
    for (const data of [{ credits: 100 }, { imageCredits: 100 }, { windowStart: new Date(0) }, { bypass: true }, { userId: otherId }]) {
      await expect(db.dailyReservation.update({ where: { id: original.id }, data })).rejects.toThrow()
      expect((await record(job.id)).dailyReservation).toEqual(original)
    }
    if (action === 'owner cancellation') await cancelAccountedVideoJob(job.id, { userId })
    else {
      // Request corruption does not prevent refunding the trustworthy original debit.
      await db.mediaJob.update({ where: { id: job.id }, data: { prompt: 'Changed fixture' } })
      await processVideoClaim(await claim(job.id))
    }
    expect(await account()).toMatchObject({ credits: 30, imageCredits: 5 })
    expect((await record(job.id)).dailyReservation.state).toBe('released')
    expect(network).not.toHaveBeenCalled()
  })
  it('cannot rewrite an old reservation into the current refund window', async () => {
    const job = await createDailyVideoJob(userId, body), saved = await record(job.id)
    const nextWindow = new Date(saved.dailyReservation.windowStart.getTime() + 86400000)
    await db.user.update({ where: { id: userId }, data: { credits: 30, creditsResetAt: nextWindow } })
    await expect(db.dailyReservation.update({ where: { id: saved.dailyReservationId }, data: { windowStart: nextWindow } })).rejects.toThrow()
    await cancelAccountedVideoJob(job.id, { userId })
    expect((await account()).credits).toBe(30)
    expect(network).not.toHaveBeenCalled()
  })
  it('daily disable after claim preserves the hold and makes no provider call', async () => {
    const job = await createDailyVideoJob(userId, body), current = await claim(job.id)
    vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'false')
    expect(await processVideoClaim(current)).toBe('paused')
    expect(await record(job.id)).toMatchObject({ state: 'queued', leaseToken: null, submittedAt: null,
      dailyReservation: { state: 'reserved' } })
    expect((await account()).credits).toBe(20)
    expect(network).not.toHaveBeenCalled()
  })
  it('daily disable between waves leaves later daily jobs untouched but continues prepaid and known settlement', async () => {
    const first = await createDailyVideoJob(userId, body)
    const second = await createDailyVideoJob(userId, body)
    const prepaid = await createAccountedVideoJob(owner(), body)
    network.mockImplementation(async () => {
      vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'false')
      return response(createTinyVideoMp4(), false)
    })
    await runVideoJobBatch({ batchSize: 6, concurrency: 1 })
    expect(network).toHaveBeenCalledTimes(2)
    expect((await record(first.id)).state).toBe('completed')
    expect(await record(second.id)).toMatchObject({ state: 'queued', attempts: 0, dailyReservation: { state: 'reserved' } })
    expect((await db.accountedVideoJob.findUniqueOrThrow({ where: { jobId: prepaid.id } })).state).toBe('completed')
    expect(await db.usageEvent.count({ where: { userId, kind: 'video' } })).toBe(1)
    expect(await db.apiUsage.count({ where: { userId, kind: 'video' } })).toBe(1)
  })
  it('rolls back a real daily debit when job insertion fails; insufficient and concurrent requests cannot overspend', async () => {
    await db.$executeRawUnsafe(`ALTER TABLE "MediaJob" ADD CONSTRAINT daily_video_fixture_insert CHECK ("prompt" <> 'Daily video fixture')`)
    try { await expect(createDailyVideoJob(userId, body)).rejects.toThrow() }
    finally { await db.$executeRawUnsafe('ALTER TABLE "MediaJob" DROP CONSTRAINT daily_video_fixture_insert') }
    expect((await account()).credits).toBe(30)
    expect(await db.dailyReservation.count({ where: { userId } })).toBe(0)
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createDailyVideoJob(userId, body)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'OUT_OF_CREDITS' })
    expect((await account()).credits).toBe(0)
    expect(await db.dailyReservation.count({ where: { userId } })).toBe(3)
    expect(await db.mediaJob.count({ where: { userId } })).toBe(3)
    expect(await db.apiReservation.count({ where: { userId } })).toBe(0)
    expect(network).not.toHaveBeenCalled()
  })

  it('enforces exactly one ledger and one job per hold in PostgreSQL; mixed claimers never double-lease or claim legacy work', async () => {
    const daily = await createDailyVideoJob(userId, body), prepaid = await createAccountedVideoJob(owner(), body)
    const saved = await record(daily.id)
    const api = await db.accountedVideoJob.findUniqueOrThrow({ where: { jobId: prepaid.id } })
    await expect(db.$executeRaw`UPDATE "AccountedVideoJob" SET "dailyReservationId" = NULL WHERE "jobId" = ${daily.id}`)
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    await expect(db.$executeRaw`UPDATE "AccountedVideoJob" SET "reservationId" = ${api.reservationId} WHERE "jobId" = ${daily.id}`)
      .rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } })
    const legacy = await db.mediaJob.create({ data: { userId, prompt: 'Unaccounted fixture' } })
    await expect(db.accountedVideoJob.create({ data: { jobId: legacy.id, dailyReservationId: saved.dailyReservationId, endpoint, config: {} } })).rejects.toThrow()
    const claims = (await Promise.all([claimVideoJobs({ concurrency: 1 }), claimVideoJobs({ concurrency: 1 }), claimVideoJobs({ concurrency: 1 })])).flat()
    expect(new Set(claims.map(value => value.jobId))).toEqual(new Set([daily.id, prepaid.id]))
    expect(claims).toHaveLength(2)
    expect(await claimVideoJobs()).toEqual([])
  })

  it.each(['', 'false'])('daily flag %j defaults off even for admin; prepaid remains eligible', async flag => {
    await db.user.update({ where: { id: userId }, data: { role: 'admin', credits: 0 } })
    vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', flag)
    await expect(createDailyVideoJob(userId, body)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await db.dailyReservation.count({ where: { userId } })).toBe(0)
    const api = await createAccountedVideoJob(owner(), body)
    expect((await claimVideoJobs()).map(value => value.jobId)).toEqual([api.id])
    expect((await account()).credits).toBe(0)
  })

  it.each(['queued', 'submitting', 'polling'] as const)('daily-only pause preserves %s jobs byte-for-byte without attempts; common pause gates prepaid too', async state => {
    const job = state === 'polling' ? await polling() : await createDailyVideoJob(userId, body)
    if (state === 'submitting') {
      await dispatchVideoClaim(await claim(job.id))
      await db.$executeRaw`UPDATE "AccountedVideoJob" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "jobId" = ${job.id}`
    }
    const before = await record(job.id), calls = network.mock.calls.length
    vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'false')
    const api = await createAccountedVideoJob(owner(), body)
    expect((await claimVideoJobs()).map(value => value.jobId)).toEqual([api.id])
    expect((await runVideoJobBatch()).claimed).toBe(0)
    expect(await record(job.id)).toEqual(before)
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'false'); vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'true')
    await expect(createDailyVideoJob(userId, body)).rejects.toMatchObject({ code: 'unavailable' })
    expect(await claimVideoJobs()).toEqual([])
    expect(await record(job.id)).toEqual(before)
    expect(network).toHaveBeenCalledTimes(calls)
  })

  it.each([{ role: 'admin', unlimited: false }, { role: 'user', unlimited: true }])('records server bypass and zero-charge completion for %j', async access => {
    await db.user.update({ where: { id: userId }, data: { ...access, credits: 0, imageCredits: 0 } })
    const job = await staged()
    expect((await record(job.id)).dailyReservation).toMatchObject({ bypass: true, credits: 0, imageCredits: 0 })
    await processVideoClaim(await claim(job.id))
    expect((await record(job.id)).dailyReservation.usage).toMatchObject({ kind: 'video', credits: 0 })
    expect((await account()).credits).toBe(0)
  })

  it.each(['role', 'unlimited', 'plan'] as const)('fails closed when server %s authorization changes before dispatch, but settles accepted work after changes', async field => {
    const initial = { role: 'admin', unlimited: true, plan: 'pro' }
    await db.user.update({ where: { id: userId }, data: initial })
    const job = await createDailyVideoJob(userId, body)
    await db.user.update({ where: { id: userId }, data: { [field]: field === 'unlimited' ? false : field === 'role' ? 'user' : 'free' } })
    await processVideoClaim(await claim(job.id))
    expect((await record(job.id)).dailyReservation.state).toBe('released')
    expect(network).not.toHaveBeenCalled()
    await db.user.update({ where: { id: userId }, data: initial })
    const accepted = await staged()
    await db.user.update({ where: { id: userId }, data: { role: 'user', unlimited: false, plan: 'free' } })
    await processVideoClaim(await claim(accepted.id))
    expect((await record(accepted.id)).dailyReservation.state).toBe('captured')
  })

  it('rejects a deleted account and binds actor, cost, kind, model, request and configuration server-side', async () => {
    const missing = `daily-video-${randomUUID()}`
    await db.user.create({ data: { id: missing, email: `${missing}@example.test`, name: 'Deleted fixture', password: passwordHash } })
    await db.user.delete({ where: { id: missing } })
    await expect(createDailyVideoJob(missing, body)).rejects.toMatchObject({ code: 'DAILY_ACCOUNT_NOT_FOUND' })
    for (const data of [{ userId: otherId }, { credits: 0 }, { bypass: true }, { kind: 'image' }, { model: 'other' }, { config: {} }]) {
      await expect(createDailyVideoJob(userId, { ...body, ...data })).rejects.toMatchObject({ code: 'invalid_request' })
    }
    const job = await createDailyVideoJob(userId, body), saved = await record(job.id)
    expect(saved.dailyReservation).toMatchObject({ userId, kind: 'video', model: 'loop-video', credits: 10, bypass: false })
    expect(saved.dailyReservation.requestFingerprint).toMatch(/^[a-f0-9]{64}$/)
    // Real persisted tampering must fail before transport.
    await db.mediaJob.update({ where: { id: job.id }, data: { prompt: 'Changed request' } })
    await processVideoClaim(await claim(job.id))
    expect((await record(job.id)).dailyReservation.state).toBe('released')
    expect(network).not.toHaveBeenCalled()
  })

  it.each([false, true])('queued cancellation refunds only the original daily window (reset=%j)', async reset => {
    const job = await createDailyVideoJob(userId, body)
    const stale = await claim(job.id)
    if (reset) {
      await db.user.update({ where: { id: userId }, data: { creditsResetAt: new Date(Date.now() - 2 * 86400000) } })
      await getDailyAccountUser(userId)
      // Spend in the new window; releasing the old hold cannot inflate it.
      await createDailyVideoJob(userId, body)
    }
    await Promise.all([cancelAccountedVideoJob(job.id, { userId }), cancelAccountedVideoJob(job.id, { userId })])
    expect((await account()).credits).toBe(reset ? 20 : 30)
    expect((await record(job.id)).dailyReservation.state).toBe('released')
    expect(await processVideoClaim(stale)).toBe('lease_lost')
    expect(network).not.toHaveBeenCalled()
  })

  it.each(['endpoint', 'config', 'model'] as const)('rejects changed daily %s binding before sending credentials', async changed => {
    const job = await createDailyVideoJob(userId, body)
    if (changed === 'endpoint') vi.stubEnv('HF_VIDEO_ENDPOINT', 'https://other.provider.example.com/generate')
    else if (changed === 'config') {
      const row = await record(job.id)
      await db.accountedVideoJob.update({ where: { jobId: job.id }, data: { config: { ...(row.config as Record<string, number>), budgetMs: 60000 } } })
    } else await db.dailyReservation.update({ where: { id: (await record(job.id)).dailyReservationId }, data: { model: 'other-video' } })
    await processVideoClaim(await claim(job.id))
    expect((await record(job.id)).dailyReservation.state).toBe('released')
    expect(network).not.toHaveBeenCalled()
    expect((await account()).credits).toBe(30)
  })

  it('dispatch marker and daily state roll back together if the job transition fails', async () => {
    const job = await createDailyVideoJob(userId, body), next = await claim(job.id)
    await db.$executeRawUnsafe(`ALTER TABLE "AccountedVideoJob" ADD CONSTRAINT daily_video_fixture_dispatch CHECK ("state" <> 'submitting')`)
    try { await expect(dispatchVideoClaim(next)).rejects.toThrow() }
    finally { await db.$executeRawUnsafe('ALTER TABLE "AccountedVideoJob" DROP CONSTRAINT daily_video_fixture_dispatch') }
    expect(await record(job.id)).toMatchObject({ state: 'queued', submittedAt: null, dailyReservation: { state: 'reserved' }, job: { startedAt: null } })
    network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    await processVideoClaim(next)
    expect((await record(job.id)).state).toBe('settling')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('cancel after submit with no status retains unknown cost; a reclaimed submit never repeats POST', async () => {
    const job = await createDailyVideoJob(userId, body)
    await dispatchVideoClaim(await claim(job.id))
    await cancelAccountedVideoJob(job.id, { userId })
    expect(await record(job.id)).toMatchObject({ state: 'needs_reconciliation', dailyReservation: { state: 'unknown' } })
    expect((await account()).credits).toBe(20)
    expect((await runVideoJobBatch()).claimed).toBe(0)
    const second = await createDailyVideoJob(userId, body)
    await dispatchVideoClaim(await claim(second.id))
    await db.$executeRaw`UPDATE "AccountedVideoJob" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second' WHERE "jobId" = ${second.id}`
    expect(await processVideoClaim(await claim(second.id))).toBe('needs_reconciliation')
    expect((await record(second.id)).dailyReservation.state).toBe('unknown')
    expect(network).not.toHaveBeenCalled()
  })

  it.each(['polling', 'settling'] as const)('cancel %s work captures confirmed cost once without publishing', async state => {
    const job = state === 'polling' ? await polling() : await staged()
    await cancelAccountedVideoJob(job.id, { userId })
    if (state === 'polling') {
      expect((await record(job.id)).dailyReservation.state).toBe('unknown')
      network.mockResolvedValueOnce(response({ status: 'completed', video: createTinyVideoMp4().toString('base64') }))
      await processVideoClaim(await claim(job.id))
    }
    await processVideoClaim(await claim(job.id)); await runVideoJobBatch()
    expect(await record(job.id)).toMatchObject({ state: 'cancelled', job: { outputUrl: null }, dailyReservation: { state: 'captured' } })
    expect(await db.usageEvent.count({ where: { userId } })).toBe(1)
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect((await account()).credits).toBe(20)
    expect(network.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1)
  })

  it('completion evidence and staged identity roll back together on a real database constraint failure', async () => {
    const job = await createDailyVideoJob(userId, body)
    await db.$executeRawUnsafe(`ALTER TABLE "AccountedVideoJob" ADD CONSTRAINT daily_video_fixture_evidence CHECK ("state" <> 'settling')`)
    network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    try { await processVideoClaim(await claim(job.id)) }
    finally { await db.$executeRawUnsafe('ALTER TABLE "AccountedVideoJob" DROP CONSTRAINT daily_video_fixture_evidence') }
    expect(await record(job.id)).toMatchObject({ stagedArtifact: null, dailyReservation: { state: 'unknown', settlementIntent: null } })
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect((await account()).credits).toBe(20)
  })

  it('daily in-flight cancellation aborts the lease and rejects late genuine MP4 evidence', async () => {
    const job = await createDailyVideoJob(userId, body), started = deferred<AbortSignal>(), late = deferred<ProviderResponse>()
    network.mockImplementationOnce(async (_url, options) => { started.resolve(options!.signal!); return late.promise })
    const working = processVideoClaim(await claim(job.id))
    try {
      const signal = await started.promise
      await cancelAccountedVideoJob(job.id, { userId })
      await expect.poll(() => signal.aborted, { timeout: 2000, interval: 20 }).toBe(true)
    } finally { late.resolve(response(createTinyVideoMp4(), false)); await working }
    expect(await working).toBe('lease_lost')
    expect(await record(job.id)).toMatchObject({ state: 'needs_reconciliation', stagedArtifact: null, dailyReservation: { state: 'unknown', settlementIntent: null } })
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect((await account()).credits).toBe(20)
    await runVideoJobBatch(); expect(network).toHaveBeenCalledTimes(1)
  })

  it('publication failure rolls back capture; daily recovery can capture before idempotent publication with both flags off', async () => {
    const job = await staged(), saved = await record(job.id)
    expect(saved.dailyReservation.settlementIntent).toMatchObject({ userId, kind: 'video', model: 'loop-video', tokensIn: 0, tokensOut: 0, images: 0, status: 'pending' })
    await expect(db.dailySettlementIntent.update({ where: { reservationId: saved.dailyReservationId }, data: { tokensIn: 1 } })).rejects.toThrow()
    await db.$executeRawUnsafe(`ALTER TABLE "PrivateFile" ADD CONSTRAINT daily_video_fixture_publication CHECK ("purpose" <> 'artifact')`)
    try { expect(await processVideoClaim(await claim(job.id))).toBe('retry') }
    finally { await db.$executeRawUnsafe('ALTER TABLE "PrivateFile" DROP CONSTRAINT daily_video_fixture_publication') }
    expect((await record(job.id)).dailyReservation.state).toBe('dispatched')
    expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'false'); vi.stubEnv('ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED', 'false')
    await runDailySettlementBatch(); await runDailySettlementBatch()
    expect((await record(job.id)).dailyReservation.state).toBe('captured')
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    await ready(job.id); await processVideoClaim(await claim(job.id)); await runVideoJobBatch()
    const completed = await record(job.id), files = await db.privateFile.findMany({ where: { userId } })
    expect(completed.state).toBe('completed'); expect(files).toHaveLength(1)
    expect((await readOwnedFile(userId, files[0].id)).buffer).toEqual(createTinyVideoMp4())
    expect(await db.usageEvent.count({ where: { userId } })).toBe(1)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
    expect((await account()).credits).toBe(20); expect((await account()).apiBalanceMicros).toBe(10000000n)
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('lease expiry while waiting for the daily account lock rolls back capture and publication', async () => {
    const job = await staged(), next = await claim(job.id, 3000), acquired = deferred<number>(), release = deferred()
    const blocker = db.$transaction(async tx => {
      const [session] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`
      acquired.resolve(session.pid); await release.promise
    }, { timeout: 12000 })
    const blocking = blocker.then(() => undefined, error => error as Error)
    let working: ReturnType<typeof processVideoClaim> | undefined
    try {
      const pid = await Promise.race([acquired.promise, blocker.then(() => { throw new Error('Blocker exited') })])
      working = processVideoClaim(next)
      await expect.poll(async () => {
        const [row] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`
        return row.blocked
      }, { timeout: 2000, interval: 20 }).toBe(true)
      await expect.poll(async () => {
        const [row] = await db.$queryRaw<{ expired: boolean }[]>`SELECT "leaseExpiresAt" <= clock_timestamp() AS expired FROM "AccountedVideoJob" WHERE "jobId" = ${job.id}`
        return row.expired
      }, { timeout: 5000, interval: 25 }).toBe(true)
    } finally { release.resolve(); try { expect(await blocking).toBeUndefined() } finally { if (working) await working } }
    expect(await working).toBe('lease_lost')
    expect((await record(job.id)).dailyReservation.state).toBe('dispatched')
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect(await db.usageEvent.count({ where: { userId } })).toBe(0)
    await processVideoClaim(await claim(job.id))
    expect((await record(job.id)).state).toBe('completed')
  })

  it('real JWT routes enforce account ownership; all developer keys are excluded from daily jobs while files stay account-wide', async () => {
    const jwt = await login(userId), otherJwt = await login(otherId), route = '/api/media/video-jobs'
    for (const token of [undefined, key.key]) expect((await http(route, token, 'POST', body)).status).toBe(401)
    expect((await http(route, jwt, 'POST', { ...body, credits: 0 })).status).toBe(400)
    const created = await http(route, jwt, 'POST', body)
    expect(created.status).toBe(202)
    const job = await created.json() as { id: string }
    for (const token of [key.key, secondKey.key, foreignKey.key]) {
      expect((await http(`/v1/videos/generations/${job.id}`, token)).status).toBe(404)
      expect((await http(`/v1/videos/generations/${job.id}/cancel`, token, 'POST')).status).toBe(404)
    }
    expect((await http(`/api/media/jobs/${job.id}`, jwt)).status).toBe(200)
    expect((await http(`/api/media/jobs/${job.id}`, otherJwt)).status).toBe(404)
    expect((await http(`/api/media/jobs/${job.id}/cancel`, otherJwt, 'POST')).status).toBe(404)
    network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    await processVideoClaim(await claim(job.id)); await processVideoClaim(await claim(job.id))
    const completed = await record(job.id), url = completed.job.outputUrl!
    for (const token of [jwt, key.key, secondKey.key]) expect((await http(url, token)).status).toBe(200)
    for (const token of [otherJwt, foreignKey.key]) expect((await http(url, token)).status).toBe(404)
    const status = await (await http(`/api/media/jobs/${job.id}`, jwt)).json()
    for (const hidden of ['hf_daily_fixture_only', endpoint, root, 'dailyReservationId', 'pricingSnapshot', 'leaseToken', 'config']) expect(JSON.stringify(status)).not.toContain(hidden)
    // Repeated POSTs are distinct purchases, never claims of HTTP idempotency.
    const second = await (await http(route, jwt, 'POST', body)).json() as { id: string }
    expect(second.id).not.toBe(job.id)
    const third = await http(route, jwt, 'POST', body)
    expect(third.status).toBe(202)
    const insufficient = await http(route, jwt, 'POST', body)
    expect(insufficient.status).toBe(402)
    expect(await insufficient.json()).toMatchObject({ code: 'OUT_OF_CREDITS' })
    expect((await http(`/api/media/jobs/${second.id}/cancel`, jwt, 'POST')).status).toBe(200)
    expect((await record(second.id)).dailyReservation.state).toBe('released')
    expect((await account()).credits).toBe(10)
  })
})
