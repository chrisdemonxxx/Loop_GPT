import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../providerHttp', async original => ({ ...await original<typeof import('../providerHttp')>(), providerRequest: vi.fn() }))
import { providerRequest, type ProviderResponse } from '../providerHttp'
import { prisma } from '../prisma'
import { readOwnedFile } from '../privateFiles'
import * as privateFiles from '../privateFiles'
import { createTinyVideoMp4 } from './fixtures/tinyVideoMp4'
import { createTinyAudioMp4 } from './fixtures/tinyAudioMp4'
import { processVideoJob, resumeMediaJobs } from '../mediaJobs'
import { createAccountedVideoJob, cancelAccountedVideoJob } from '../accountedVideoJobs'
import { claimVideoJobs, dispatchVideoClaim, processVideoClaim, runVideoJobBatch } from '../videoJobWorker'
import { captureApiSettlement } from '../apiReservations'
import { runApiSettlementBatch } from '../apiSettlementRecovery'
import router from '../../routes/v1'
import mediaRouter from '../../routes/media'

const db = prisma!, network = vi.mocked(providerRequest)
const endpoint = 'https://video.provider.example.com/generate', statusUrl = 'https://video.provider.example.com/jobs/fixture/status'
const cdnUrl = 'https://cdn.example.com/fixture.mp4?signature=fixture-only', token = 'hf_fixture_only'
const video = createTinyVideoMp4()
let userId: string, apiKeyId: string, otherKey: string, otherId: string, root: string
const owner = () => ({ userId, apiKeyId })
const body = { prompt: 'Fixture video' }
function response(value: unknown, json = true): ProviderResponse {
  const buffer = json ? Buffer.from(JSON.stringify(value)) : value as Buffer
  return { status: 200, ok: true, url: endpoint, body: buffer, headers: new Headers({ 'content-type': json ? 'application/json' : 'video/mp4' }),
    async json() { return JSON.parse(buffer.toString()) }, async text() { return buffer.toString() }, async arrayBuffer() { return Uint8Array.from(buffer).buffer } }
}
async function record(id: string) {
  const row = await db.accountedVideoJob.findUniqueOrThrow({ where: { jobId: id }, include: { job: true, reservation: { include: { settlementIntent: true, usage: true } } } })
  if (!row.reservation || !row.reservationId) throw new Error('Expected prepaid fixture')
  return { ...row, reservation: row.reservation, reservationId: row.reservationId }
}
async function claim() {
  const claims = await claimVideoJobs({ batchSize: 1, concurrency: 1 })
  expect(claims).toHaveLength(1)
  return claims[0]
}
async function ready(id: string) { await db.$executeRaw`UPDATE "AccountedVideoJob" SET "nextAttemptAt" = clock_timestamp() - interval '1 second' WHERE "jobId" = ${id}` }
async function expire(id: string) { await db.$executeRaw`UPDATE "AccountedVideoJob" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second', "nextAttemptAt" = clock_timestamp() - interval '1 second' WHERE "jobId" = ${id}` }
async function polling() {
  const job = await createAccountedVideoJob(owner(), body)
  network.mockResolvedValueOnce(response({ job_id: 'provider-fixture', status_url: statusUrl, result_url: cdnUrl }))
  await processVideoClaim(await claim())
  await ready(job.id); network.mockClear()
  return job
}
async function staged() {
  const job = await createAccountedVideoJob(owner(), body)
  network.mockResolvedValueOnce(response(video, false))
  await processVideoClaim(await claim())
  expect((await record(job.id)).state).toBe('settling')
  return job
}
async function handle(target: any, routePath: string, method: 'get' | 'post', api: any, payload: unknown = {}, id?: string) {
  const route = target.stack.find((layer: any) => layer.route?.path === routePath && layer.route.methods[method]).route
  const req: any = { body: payload, api, userId: api.userId, params: { id }, headers: {} }
  const res: any = { statusCode: 200 }
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (value: unknown) => { res.body = value; return res }
  await route.stack.at(-1).handle(req, res)
  return res
}
beforeEach(async () => {
  network.mockReset().mockRejectedValue(new Error('Unexpected fixture network request'))
  vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true'); vi.stubEnv('HF_VIDEO_ENDPOINT', endpoint)
  vi.stubEnv('HF_TOKEN', token); vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '30000')
  vi.stubEnv('ACCOUNTED_VIDEO_POLL_MS', '1000'); vi.stubEnv('ACCOUNTED_VIDEO_REQUEST_MS', '5000')
  vi.stubEnv('ACCOUNTED_VIDEO_MAX_POLLS', '600')
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-accounted-video-')); vi.stubEnv('PRIVATE_FILES_DIR', root)
  userId = randomUUID(); otherId = randomUUID()
  await db.user.createMany({ data: [userId, otherId].map(id => ({ id, email: `${id}@example.test`, password: 'fixture', name: 'Video fixture', apiBalanceMicros: 10000000n })) })
  apiKeyId = (await db.apiKey.create({ data: { userId, keyHash: randomUUID(), prefix: 'fixture' } })).id
  otherKey = (await db.apiKey.create({ data: { userId, keyHash: randomUUID(), prefix: 'fixture2' } })).id
})
afterEach(async () => {
  vi.restoreAllMocks()
  const where = { userId: { in: [userId, otherId] } }
  await db.accountedVideoJob.deleteMany({ where: { job: where } })
  await db.mediaJob.deleteMany({ where }); await db.privateFile.deleteMany({ where })
  await db.apiSettlementIntent.deleteMany({ where }); await db.apiUsage.deleteMany({ where }); await db.apiReservation.deleteMany({ where })
  await db.apiKey.deleteMany({ where }); await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } })
  await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs()
})
afterAll(async () => { await db.$disconnect() })

describe.sequential('accounted provider flows: real PostgreSQL, filesystem, mocked network only', () => {
  it('honors status-only cancellation under the dispatch lock before any submit marker', async () => {
    const job = await createAccountedVideoJob(owner(), body), pending = await claim()
    await db.mediaJob.update({ where: { id: job.id }, data: { status: 'cancelled' } })
    expect(await dispatchVideoClaim(pending)).toBeNull()
    expect(await record(job.id)).toMatchObject({ state: 'cancelled', submittedAt: null, reservation: { state: 'released' } })
    expect(network).not.toHaveBeenCalled()
  })
  it('reversibly pauses configuration disabled after claiming rather than releasing the hold', async () => {
    const job = await createAccountedVideoJob(owner(), body), pending = await claim()
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'false')
    expect(await processVideoClaim(pending)).toBe('paused')
    expect(await record(job.id)).toMatchObject({ state: 'queued', submittedAt: null, leaseToken: null, reservation: { state: 'reserved' } })
    expect(network).not.toHaveBeenCalled()
  })
  it('still settles committed evidence while disabled without claiming new provider work', async () => {
    const complete = await staged()
    const queued = await createAccountedVideoJob(owner(), body)
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'false')
    const before = network.mock.calls.length
    expect(await runVideoJobBatch()).toMatchObject({ claimed: 1, advanced: 1, dispatchEnabled: false })
    expect((await record(complete.id)).state).toBe('completed')
    expect(await record(queued.id)).toMatchObject({ state: 'queued', attempts: 0, reservation: { state: 'reserved' } })
    expect(network.mock.calls.length).toBe(before)
  })
  it('preserves status-only cancellation committed during final artifact verification', async () => {
    const job = await staged()
    const verify = privateFiles.verifyStagedArtifact
    vi.spyOn(privateFiles, 'verifyStagedArtifact').mockImplementationOnce(async value => {
      const artifact = await verify(value)
      await db.mediaJob.update({ where: { id: job.id }, data: { status: 'cancelled' } })
      return artifact
    })
    expect(await processVideoClaim(await claim())).toBe('advanced')
    expect(await record(job.id)).toMatchObject({ state: 'cancelled', cancelRequested: true,
      job: { status: 'cancelled', outputUrl: null }, reservation: { state: 'captured' } })
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it.each([
    ['fabricated header', () => Buffer.from('0000000c6674797069736f6d', 'hex')],
    ['ftyp-only', () => Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')],
    ['audio-only', createTinyAudioMp4],
    ['truncated clip', () => createTinyVideoMp4().subarray(0, 100)],
    ['oversized output', () => Buffer.alloc(50 * 1024 * 1024 + 1)],
  ] as const)('rejects %s without admitting confirmed usage or publishing an artifact', async (_name, bytes) => {
    const job = await createAccountedVideoJob(owner(), body)
    network.mockResolvedValueOnce(response(bytes(), false))
    expect(await processVideoClaim(await claim())).toBe('needs_reconciliation')
    expect(await record(job.id)).toMatchObject({ state: 'needs_reconciliation',
      reservation: { state: 'unknown', settlementIntent: null, usage: null }, job: { outputUrl: null } })
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
  })
  it('atomically reserves prepaid credit and creates a bounded server-normalized job without dispatch', async () => {
    const job = await createAccountedVideoJob(owner(), body), saved = await record(job.id)
    expect(job.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(saved.reservation).toMatchObject({ state: 'reserved', amountMicros: 400000n, userId, apiKeyId, kind: 'video', model: 'loop-video' })
    expect(job.metadata).toMatchObject({ width: 960, height: 544, fps: 24, numFrames: 96 })
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).apiBalanceMicros).toBe(9600000n)
    expect(network).not.toHaveBeenCalled()
    expect(JSON.stringify(saved, (_, v) => typeof v === 'bigint' ? String(v) : v)).not.toContain(token)
  })
  it('rolls back the hold when job insertion fails inside the real transaction', async () => {
    const original = db.$transaction.bind(db)
    vi.spyOn(db, '$transaction').mockImplementationOnce(((work: any, options: any) => original(async tx => {
      const create = tx.mediaJob.create
      tx.mediaJob.create = () => { throw new Error('Injected job insertion failure') }
      try { return await work(tx) } finally { tx.mediaJob.create = create }
    }, options)) as any)
    await expect(createAccountedVideoJob(owner(), body)).rejects.toThrow('insertion failure')
    expect(await db.apiReservation.count({ where: { userId } })).toBe(0)
    expect(await db.mediaJob.count({ where: { userId } })).toBe(0)
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).apiBalanceMicros).toBe(10000000n)
  })
  it('rejects cross-user/revoked keys and insufficient funds with no orphan jobs', async () => {
    await expect(createAccountedVideoJob({ userId: otherId, apiKeyId }, body)).rejects.toMatchObject({ code: 'invalid_owner' })
    await db.apiKey.update({ where: { id: apiKeyId }, data: { revoked: true } })
    await expect(createAccountedVideoJob(owner(), body)).rejects.toMatchObject({ code: 'invalid_owner' })
    await db.apiKey.update({ where: { id: apiKeyId }, data: { revoked: false } })
    await db.user.update({ where: { id: userId }, data: { apiBalanceMicros: 1n } })
    await expect(createAccountedVideoJob(owner(), body)).rejects.toMatchObject({ code: 'insufficient_quota' })
    expect(await db.mediaJob.count({ where: { userId } })).toBe(0)
  })
  it('claims concurrently with database locks, only free slots, and ignores legacy media', async () => {
    const policy = await db.videoQueuePolicy.findUniqueOrThrow({ where: { id: 1 } })
    await db.videoQueuePolicy.update({ where: { id: 1 }, data: { userActive: 4, revision: { increment: 1 } } })
    try {
      for (let i = 0; i < 5; i++) await createAccountedVideoJob(owner(), body)
      const legacy = await db.mediaJob.create({ data: { userId, prompt: 'Legacy unaccounted' } })
      const claims = (await Promise.all([claimVideoJobs({ concurrency: 2, batchSize: 100 }), claimVideoJobs({ concurrency: 2, batchSize: 100 })])).flat()
      expect(claims).toHaveLength(4); expect(new Set(claims.map(c => c.jobId)).size).toBe(4)
      expect(claims.some(c => c.jobId === legacy.id)).toBe(false)
      await processVideoJob(legacy.id); await resumeMediaJobs()
      expect(network).not.toHaveBeenCalled()
      expect(await db.mediaJob.findUnique({ where: { id: legacy.id } })).toEqual(legacy)
    } finally { await db.videoQueuePolicy.update({ where: { id: 1 }, data: policy }) }
  })
  it('queued cancellation releases exactly once and fences a previously claimed worker', async () => {
    const job = await createAccountedVideoJob(owner(), body), stale = await claim()
    await expect(cancelAccountedVideoJob(job.id, { userId: otherId })).rejects.toMatchObject({ code: 'not_found' })
    await expect(cancelAccountedVideoJob(job.id, { userId, apiKeyId: otherKey })).rejects.toMatchObject({ code: 'not_found' })
    await cancelAccountedVideoJob(job.id, owner()); await cancelAccountedVideoJob(job.id, owner())
    expect(await processVideoClaim(stale)).toBe('lease_lost')
    expect((await record(job.id)).reservation.state).toBe('released')
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).apiBalanceMicros).toBe(10000000n)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
    expect(network).not.toHaveBeenCalled()
  })
  it('reclaims a crash before dispatch and marks both durable markers before the single POST', async () => {
    const job = await createAccountedVideoJob(owner(), body), stale = await claim()
    await expire(job.id)
    const current = await claim()
    expect(await processVideoClaim(stale)).toBe('lease_lost')
    network.mockImplementationOnce(async (_url, options) => {
      expect(options?.method).toBe('POST')
      const saved = await record(job.id)
      expect(saved).toMatchObject({ state: 'submitting', reservation: { state: 'dispatched' } })
      expect(saved.submittedAt).toBeInstanceOf(Date); expect(saved.job.startedAt).toBeInstanceOf(Date)
      return response(video, false)
    })
    await processVideoClaim(current)
    expect(network).toHaveBeenCalledTimes(1)
  })
  it('crash after committed submit marker never repeats POST, even if it never reached the socket', async () => {
    const job = await createAccountedVideoJob(owner(), body), first = await claim()
    await dispatchVideoClaim(first); await expire(job.id)
    expect(await processVideoClaim(await claim())).toBe('needs_reconciliation')
    expect((await record(job.id)).reservation.state).toBe('unknown')
    expect(await claimVideoJobs()).toEqual([]); expect(network).not.toHaveBeenCalled()
  })
  it('ambiguous POST failure retains funds and never retries upstream', async () => {
    const job = await createAccountedVideoJob(owner(), body)
    network.mockRejectedValueOnce(new Error(`timeout Bearer ${token} ${cdnUrl}`))
    await processVideoClaim(await claim()); await runVideoJobBatch()
    const saved = await record(job.id)
    expect(saved).toMatchObject({ state: 'needs_reconciliation', reservation: { state: 'unknown' }, job: { outputUrl: null } })
    expect(saved.job.error).toBe('Video work requires reconciliation'); expect(network).toHaveBeenCalledTimes(1)
    expect(saved.reservation.usage).toBeNull()
  })
  it('expiry while waiting for the reservation lock rolls back dispatch and the ledger', async () => {
    const job = await createAccountedVideoJob(owner(), body), saved = await record(job.id)
    const [short] = await claimVideoJobs({ batchSize: 1, concurrency: 1, leaseMs: 1000 })
    let locked!: () => void, unlock!: () => void
    const acquired = new Promise<void>(resolve => { locked = resolve }), release = new Promise<void>(resolve => { unlock = resolve })
    const blocker = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${saved.reservationId} FOR UPDATE`
      locked(); await release
    })
    await acquired
    const result = dispatchVideoClaim(short).then(() => 'unexpected', error => error.code)
    try { await new Promise(resolve => setTimeout(resolve, 1150)) } finally { unlock(); await blocker }
    expect(await result).toBe('lease_lost')
    expect(await record(job.id)).toMatchObject({ state: 'queued', submittedAt: null, reservation: { state: 'reserved' } })
    expect(network).not.toHaveBeenCalled()
  })
  it('late POST result from an expired lease cannot publish evidence/artifacts/ledger or repeat POST', async () => {
    const job = await createAccountedVideoJob(owner(), body)
    network.mockImplementationOnce(async () => { await expire(job.id); return response(video, false) })
    expect(await processVideoClaim(await claim())).toBe('lease_lost')
    expect(await processVideoClaim(await claim())).toBe('needs_reconciliation')
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect((await record(job.id)).reservation.settlementIntent).toBeNull()
    expect(network).toHaveBeenCalledTimes(1)
  })
  it('resumes only safe authenticated GET and downloads signed external CDN anonymously', async () => {
    const job = await polling(), originalStart = (await record(job.id)).job.startedAt
    const stale = await claim(); await expire(job.id)
    network.mockResolvedValueOnce(response({ status: 'completed' })).mockResolvedValueOnce(response(video, false))
    expect(await processVideoClaim(stale)).toBe('lease_lost')
    await processVideoClaim(await claim())
    expect(network).toHaveBeenCalledTimes(2)
    const [poll, download] = network.mock.calls
    expect(poll[0]).toBe(statusUrl); expect(poll[1]?.method).toBe('GET')
    expect(poll[1]?.allowedOrigins).toEqual([new URL(endpoint).origin])
    expect(new Headers(poll[1]?.headers).get('authorization')).toBe(`Bearer ${token}`)
    expect(download[0]).toBe(cdnUrl); expect(new Headers(download[1]?.headers).get('authorization')).toBeNull()
    expect(download[1]?.allowedOrigins).toBeUndefined()
    for (const [, options] of network.mock.calls) expect(options?.timeoutMs).toBeLessThanOrEqual(5000)
    const saved = await record(job.id)
    expect(saved.job.startedAt).toEqual(originalStart)
    expect(saved.state).toBe('settling'); expect(saved.job.outputUrl).toBeNull()
    expect(saved.reservation.settlementIntent).toMatchObject({ status: 'pending', costMicros: 400000n, units: 1 })
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    await processVideoClaim(await claim())
    const completed = await record(job.id)
    expect(completed.job).toMatchObject({ status: 'completed', progress: 100, error: null })
    expect(completed.reservation.state).toBe('captured')
    const fileId = completed.job.outputUrl!.split('/')[3]
    expect((await readOwnedFile(userId, fileId)).buffer).toEqual(video)
    await expect(readOwnedFile(otherId, fileId)).rejects.toMatchObject({ status: 404 })
    await runVideoJobBatch()
    expect(network).toHaveBeenCalledTimes(2); expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it.each(['https://attacker.example.test/status', 'http://127.0.0.1/status',
    'https://fixture:secret@video.provider.example.test/status', `${statusUrl}#secret`])('blocks unsafe persisted poll URL %s', async unsafe => {
    const job = await polling()
    await db.mediaJob.update({ where: { id: job.id }, data: { statusUrl: unsafe } })
    await processVideoClaim(await claim())
    expect(network).not.toHaveBeenCalled(); expect((await record(job.id)).job.outputUrl).toBeNull()
  })
  it('rejects provider origin changes before credential delivery and freezes original budget/config', async () => {
    const job = await polling()
    vi.stubEnv('HF_VIDEO_ENDPOINT', 'https://replacement.example.com/generate')
    await processVideoClaim(await claim())
    expect(network).not.toHaveBeenCalled(); expect((await record(job.id)).state).toBe('needs_reconciliation')
  })
  it('rejects bad provider links before download and keeps errors sanitized', async () => {
    const job = await polling()
    network.mockResolvedValueOnce(response({ status: 'completed', result_url: 'http://127.0.0.1/secret' }))
    await processVideoClaim(await claim())
    expect(network).toHaveBeenCalledTimes(1); expect((await record(job.id)).job.outputUrl).toBeNull()
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
  })
  it('cancellation after submit aborts in-flight work and does not optimistically refund', async () => {
    const job = await createAccountedVideoJob(owner(), body)
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    network.mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }); started()
    }))
    const working = processVideoClaim(await claim())
    await start; await cancelAccountedVideoJob(job.id, owner())
    expect(await working).toBe('lease_lost')
    expect(network.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect((await record(job.id))).toMatchObject({ state: 'needs_reconciliation', cancelRequested: true, reservation: { state: 'unknown' } })
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
  })
  it('cancelled known provider work can GET-resume and capture evidence without publishing success', async () => {
    const job = await polling()
    await cancelAccountedVideoJob(job.id, owner())
    network.mockResolvedValueOnce(response({ status: 'completed' })).mockResolvedValueOnce(response(video, false))
    await processVideoClaim(await claim()); await processVideoClaim(await claim())
    expect(await record(job.id)).toMatchObject({ state: 'cancelled', job: { status: 'cancelled', outputUrl: null }, reservation: { state: 'captured' } })
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
  })
  it('honors manual status-only cancellation and promptly aborts the old lease', async () => {
    const job = await polling()
    let started!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    network.mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }); started()
    }))
    const working = processVideoClaim(await claim())
    await start; await db.mediaJob.update({ where: { id: job.id }, data: { status: 'cancelled' } })
    expect(await working).toBe('lease_lost')
    expect(await record(job.id)).toMatchObject({ state: 'polling', cancelRequested: true, job: { status: 'cancelled', outputUrl: null } })
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
  })
  it('shutdown aborts GET and leaves a safe bounded retry without another POST', async () => {
    const job = await polling(), stop = new AbortController()
    network.mockImplementationOnce(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('fixture shutdown')), { once: true }); stop.abort()
    }))
    expect(await processVideoClaim(await claim(), {}, stop.signal)).toBe('retry')
    expect(await record(job.id)).toMatchObject({ state: 'polling', leaseToken: null })
    expect((await runVideoJobBatch({}, stop.signal)).claimed).toBe(0)
    expect(network).toHaveBeenCalledTimes(1)
  })
  it('original startedAt deadline survives successful incremental polls and restarts', async () => {
    const job = await polling()
    await db.mediaJob.update({ where: { id: job.id }, data: { startedAt: new Date(Date.now() - 28000) } })
    network.mockResolvedValueOnce(response({ status: 'processing' }))
    await processVideoClaim(await claim())
    expect(network.mock.calls[0][1]?.timeoutMs).toBeLessThanOrEqual(2000)
    await ready(job.id)
    await db.mediaJob.update({ where: { id: job.id }, data: { startedAt: new Date(Date.now() - 31000) } })
    vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '1800000') // Raising env cannot extend the snapshot.
    await processVideoClaim(await claim())
    expect(network).toHaveBeenCalledTimes(1); expect((await record(job.id)).state).toBe('needs_reconciliation')
  })
  it('bounds failed GET retries and terminally retains the hold', async () => {
    const job = await polling()
    for (let i = 0; i < 10; i++) { await ready(job.id); await processVideoClaim(await claim()) }
    expect(network).toHaveBeenCalledTimes(10)
    expect(await record(job.id)).toMatchObject({ state: 'needs_reconciliation', reservation: { state: 'unknown' } })
    expect(await claimVideoJobs()).toEqual([])
  })
  it('limits total incremental polls even when each GET succeeds', async () => {
    vi.stubEnv('ACCOUNTED_VIDEO_MAX_POLLS', '1')
    const job = await polling()
    network.mockResolvedValue(response({ status: 'processing' }))
    await processVideoClaim(await claim()); await ready(job.id); await processVideoClaim(await claim())
    expect(network).toHaveBeenCalledTimes(1)
    expect((await record(job.id)).state).toBe('needs_reconciliation')
  })
  it('crash window between staging bytes and evidence exposes neither artifact nor success', async () => {
    const job = await createAccountedVideoJob(owner(), body), next = await claim(), original = db.$transaction.bind(db)
    const fault = vi.spyOn(db, '$transaction').mockImplementation(((work: any, options: any) => original(async tx => {
      const create = tx.apiSettlementIntent.create
      tx.apiSettlementIntent.create = () => { throw new Error('Injected evidence failure') }
      try { return await work(tx) } finally { tx.apiSettlementIntent.create = create }
    }, options)) as any)
    network.mockResolvedValueOnce(response(video, false))
    expect(await processVideoClaim(next)).toBe('needs_reconciliation')
    fault.mockRestore()
    expect(await fs.readdir(root)).toHaveLength(1) // Inaccessible byte orphan, deliberately not published.
    expect(await db.privateFile.count({ where: { userId } })).toBe(0)
    expect(await record(job.id)).toMatchObject({ state: 'needs_reconciliation', stagedArtifact: null,
      reservation: { state: 'unknown', settlementIntent: null, usage: null }, job: { outputUrl: null } })
    await runVideoJobBatch(); expect(network).toHaveBeenCalledTimes(1)
  })
  it('recovers confirmed evidence with existing settlement worker without resubmission', async () => {
    const job = await staged(), saved = await record(job.id)
    expect(saved.reservation.state).toBe('dispatched')
    expect(saved.reservation.settlementIntent?.units).toBe(1)
    const result = await runApiSettlementBatch({ batchSize: 1, concurrency: 1 })
    expect(result.succeeded).toBe(1)
    expect((await record(job.id)).job.status).not.toBe('completed')
    await processVideoClaim(await claim())
    expect((await record(job.id)).job.status).toBe('completed')
    expect(network).toHaveBeenCalledTimes(1); expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it('capture/publication failure rolls back final success; durable intent remains replayable', async () => {
    const job = await staged(), next = await claim(), original = db.$transaction.bind(db)
    const fault = vi.spyOn(db, '$transaction').mockImplementation(((work: any, options: any) => original(async tx => {
      const create = tx.privateFile.create
      tx.privateFile.create = () => { throw new Error('Injected publication failure') }
      try { return await work(tx) } finally { tx.privateFile.create = create }
    }, options)) as any)
    expect(await processVideoClaim(next)).toBe('retry')
    expect(await record(job.id)).toMatchObject({ state: 'settling', reservation: { state: 'dispatched' }, job: { outputUrl: null } })
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
    fault.mockRestore(); await ready(job.id)
    await processVideoClaim(await claim())
    expect((await record(job.id)).job.status).toBe('completed'); expect(network).toHaveBeenCalledTimes(1)
  })
  it('expired finalizer cannot publish or capture; another worker finishes exactly once', async () => {
    const job = await staged(), stale = await claim()
    await expire(job.id); const current = await claim()
    expect(await processVideoClaim(stale)).toBe('lease_lost')
    expect(await db.apiUsage.count({ where: { userId } })).toBe(0)
    await captureApiSettlement((await record(job.id)).reservationId) // Independent recovery wins.
    await processVideoClaim(current)
    expect(await db.privateFile.count({ where: { userId } })).toBe(1)
    expect(await db.apiUsage.count({ where: { userId } })).toBe(1)
  })
  it('missing staged bytes never yields success or a duplicate provider POST', async () => {
    const job = await staged(), saved = await record(job.id)
    await fs.unlink(path.join(root, (saved.stagedArtifact as any).id))
    await processVideoClaim(await claim())
    expect((await record(job.id)).job.outputUrl).toBeNull(); expect(network).toHaveBeenCalledTimes(1)
    expect((await record(job.id)).state).toBe('settling')
  })
  it('HTTP defaults disabled; opted-in prepaid creation is async, key-owned and redacted; JWT remains 503', async () => {
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', '')
    expect((await handle(router, '/videos/generations', 'post', owner(), body)).statusCode).toBe(503)
    expect((await handle(mediaRouter, '/video-jobs', 'post', owner(), body)).statusCode).toBe(503)
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true')
    const res = await handle(router, '/videos/generations', 'post', owner(), body)
    expect(res.statusCode).toBe(202); expect(res.body.status).toBe('queued'); expect(network).not.toHaveBeenCalled()
    const visible = await handle(router, '/videos/generations/:id', 'get', owner(), {}, res.body.id)
    expect(visible.statusCode).toBe(200)
    for (const secret of [token, endpoint, 'leaseToken', 'config', 'reservationId']) expect(JSON.stringify(visible.body)).not.toContain(secret)
    expect((await handle(router, '/videos/generations/:id', 'get', { userId, apiKeyId: otherKey }, {}, res.body.id)).statusCode).toBe(404)
    expect((await handle(router, '/videos/generations/:id/cancel', 'post', { userId, apiKeyId: otherKey }, {}, res.body.id)).statusCode).toBe(404)
    expect((await handle(router, '/videos/generations/:id/cancel', 'post', owner(), {}, res.body.id)).statusCode).toBe(200)
    expect((await record(res.body.id)).reservation.state).toBe('released')
  })
})
