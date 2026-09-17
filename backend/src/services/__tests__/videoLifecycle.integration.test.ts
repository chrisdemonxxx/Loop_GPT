import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type { Server } from 'http'
import os from 'os'
import path from 'path'
import bcrypt from 'bcryptjs'
import express from 'express'
import type { Prisma } from '@prisma/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../providerHttp', async original => ({ ...await original<typeof import('../providerHttp')>(), providerRequest: vi.fn() }))
vi.mock('../email', () => ({ welcomeEmail: vi.fn(), verifyEmail: vi.fn() }))
import { providerRequest, type ProviderResponse } from '../providerHttp'
import { prisma } from '../prisma'
import { createApiKey, revokeApiKey, type IssuedKey } from '../apiKeys'
import { createAccountedVideoJob } from '../accountedVideoJobs'
import { claimVideoJobs, processVideoClaim, runVideoJobBatch } from '../videoJobWorker'
import { readOwnedFile } from '../privateFiles'
import authRouter from '../../routes/auth'
import v1Router from '../../routes/v1'
import mediaRouter from '../../routes/media'
import { filesRouter } from '../../routes/files'
import { createTinyVideoMp4 } from './fixtures/tinyVideoMp4'

const db = prisma!, network = vi.mocked(providerRequest)
const prefix = `video-lifecycle-${randomUUID()}`
const endpoint = 'https://video.provider.example.com/generate'
const statusUrl = 'https://video.provider.example.com/jobs/lifecycle/status'
const cdnUrl = 'https://cdn.example.com/lifecycle.mp4?signature=fixture-only'
const providerToken = 'hf_lifecycle_fixture_only', password = 'Lifecycle-fixture-password-42'
const initialBalance = 10_000_000n, clipPrice = 400_000n
const body = { prompt: 'Lifecycle fixture video' }
let userId: string, otherId: string, key: IssuedKey, secondKey: IssuedKey, foreignKey: IssuedKey
let root: string, server: Server, base: string, passwordHash: string
const owner = () => ({ userId, apiKeyId: key.id })
const balance = () => db.user.findUniqueOrThrow({ where: { id: userId } }).then(user => user.apiBalanceMicros)
const files = () => db.privateFile.findMany({ where: { userId } })
const usage = () => db.apiUsage.findMany({ where: { userId } })
const record = async (jobId: string) => {
  const row = await db.accountedVideoJob.findUniqueOrThrow({ where: { jobId },
    include: { job: true, reservation: { include: { settlementIntent: true, usage: true } } } })
  if (!row.reservation || !row.reservationId) throw new Error('Expected prepaid fixture')
  return { ...row, reservation: row.reservation, reservationId: row.reservationId }
}
const ready = (jobId: string) => db.$executeRaw`UPDATE "AccountedVideoJob" SET "nextAttemptAt" = clock_timestamp() - interval '1 second' WHERE "jobId" = ${jobId}`
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function response(value: unknown, json = true): ProviderResponse {
  const buffer = json ? Buffer.from(JSON.stringify(value)) : value as Buffer
  return { status: 200, ok: true, url: endpoint, body: buffer,
    headers: new Headers({ 'content-type': json ? 'application/json' : 'video/mp4' }),
    async json() { return JSON.parse(buffer.toString()) }, async text() { return buffer.toString() },
    async arrayBuffer() { return Uint8Array.from(buffer).buffer } }
}
async function claim(jobId: string, leaseMs = 30000) {
  const claims = await claimVideoJobs({ batchSize: 1, concurrency: 1, leaseMs })
  expect(claims).toHaveLength(1)
  expect(claims[0].jobId).toBe(jobId)
  return claims[0]
}
async function polling() {
  const job = await createAccountedVideoJob(owner(), body)
  network.mockResolvedValueOnce(response({ job_id: 'lifecycle-fixture', status_url: statusUrl, result_url: cdnUrl }))
  await processVideoClaim(await claim(job.id))
  expect((await record(job.id)).state).toBe('polling')
  await ready(job.id)
  return job
}
async function staged() {
  const job = await createAccountedVideoJob(owner(), body)
  network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
  await processVideoClaim(await claim(job.id))
  expect((await record(job.id)).state).toBe('settling')
  return job
}
function postCount() { return network.mock.calls.filter(([, options]) => options?.method === 'POST').length }
async function expectUnpublished(jobId: string) {
  const saved = await record(jobId)
  expect(saved.job.outputUrl).toBeNull()
  expect(saved.job.status).not.toBe('completed')
  expect(saved.reservation.capturedMicros).toBeNull()
  expect(await files()).toEqual([])
  expect(await usage()).toEqual([])
  expect(await balance()).toBe(initialBalance - clipPrice)
}
async function expectCompleted(jobId: string) {
  const saved = await record(jobId), published = await files(), charged = await usage()
  expect(saved).toMatchObject({ state: 'completed', leaseToken: null, job: { status: 'completed', progress: 100, error: null },
    reservation: { state: 'captured', capturedMicros: clipPrice, settlementIntent: { status: 'succeeded', units: 1 } } })
  expect(published).toHaveLength(1)
  expect(charged).toHaveLength(1)
  expect(charged[0]).toMatchObject({ reservationId: saved.reservationId, costMicros: clipPrice, units: 1 })
  expect(saved.job.outputUrl).toBe(`/api/files/${published[0].id}/content`)
  expect((await readOwnedFile(userId, published[0].id)).buffer).toEqual(createTinyVideoMp4())
  expect(await fs.readdir(root)).toEqual([published[0].id])
  expect(await balance()).toBe(initialBalance - clipPrice)
  expect(postCount()).toBe(1)
  return saved
}
async function http(route: string, bearer?: string, method = 'GET', payload?: unknown) {
  return fetch(`${base}${route}`, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
}
async function login(id: string) {
  const result = await http('/api/auth/login', undefined, 'POST', { email: `${id}@example.test`, password })
  expect(result.status).toBe(200)
  const data = await result.json() as { token: string }
  expect(data.token).toEqual(expect.any(String))
  return data.token // Issued by the real login route; no guessed signing configuration.
}

beforeAll(async () => {
  passwordHash = await bcrypt.hash(password, 4)
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  app.use('/v1', v1Router)
  app.use('/api/media', mediaRouter)
  app.use('/api/files', filesRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing lifecycle fixture port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(async () => {
  network.mockReset().mockRejectedValue(new Error('Unexpected fixture provider request'))
  vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true')
  vi.stubEnv('HF_VIDEO_ENDPOINT', endpoint); vi.stubEnv('HF_TOKEN', providerToken)
  vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '30000'); vi.stubEnv('ACCOUNTED_VIDEO_REQUEST_MS', '5000')
  vi.stubEnv('ACCOUNTED_VIDEO_POLL_MS', '1000'); vi.stubEnv('ACCOUNTED_VIDEO_MAX_POLLS', '600')
  vi.stubEnv('PUBLIC_API_URL', '')
  // Real HTTP is exclusively this suite's loopback Express server. Provider I/O
  // is mocked at its transport boundary; no external endpoint or key is used.
  const fetchLocal = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== base) throw new Error('Non-fixture HTTP is forbidden')
    return fetchLocal(input, init)
  })
  root = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  vi.stubEnv('PRIVATE_FILES_DIR', root)
  const caseId = randomUUID()
  userId = `${prefix}-${caseId}-owner`; otherId = `${prefix}-${caseId}-other`
  await db.user.createMany({ data: [userId, otherId].map(id => ({ id, email: `${id}@example.test`,
    password: passwordHash, name: 'Lifecycle fixture', apiBalanceMicros: initialBalance })) })
  key = await createApiKey(userId, 'Lifecycle original')
  secondKey = await createApiKey(userId, 'Lifecycle same account')
  foreignKey = await createApiKey(otherId, 'Lifecycle other account')
})
afterEach(async () => {
  vi.restoreAllMocks()
  try {
    const owned = { userId: { in: [userId, otherId] } }
    // Exact fixture IDs only. Durable job/intent/usage FKs restrict deletion of
    // reservations and users; remove dependents in that order, even after failure.
    await db.accountedVideoJob.deleteMany({ where: { job: owned } })
    await db.mediaJob.deleteMany({ where: owned })
    await db.apiSettlementIntent.deleteMany({ where: owned })
    await db.apiUsage.deleteMany({ where: owned })
    await db.apiReservation.deleteMany({ where: owned })
    await db.privateFile.deleteMany({ where: owned })
    await db.apiKey.deleteMany({ where: owned })
    await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } })
  } finally {
    if (root) await fs.rm(root, { recursive: true, force: true })
    vi.unstubAllEnvs()
  }
})
afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => {
      server.closeAllConnections(); server.close(error => error ? reject(error) : resolve())
    })
  } finally { await db.$disconnect() }
})

describe.sequential('video lifecycle: PostgreSQL fences, private bytes and real authenticated HTTP', () => {
  it.each(['reservation', 'balance'] as const)('expires while finalization waits on the %s lock; only a fresh claim captures and publishes', async lock => {
    const job = await staged(), before = await record(job.id), next = await claim(job.id, 3000)
    const acquired = deferred<number>(), release = deferred()
    const blocker = db.$transaction(async tx => {
      const [session] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      if (lock === 'reservation') await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${before.reservationId} FOR UPDATE`
      else await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`
      acquired.resolve(session.pid)
      await release.promise
    }, { timeout: 12000 })
    // Attach rejection handling immediately; always drain both tasks before cleanup.
    const blocking = blocker.then(() => undefined, error => error as Error)
    let working: ReturnType<typeof processVideoClaim> | undefined
    try {
      const pid = await Promise.race([acquired.promise, blocker.then(() => {
        throw new Error('Fixture blocker ended before acquiring the lock')
      })])
      working = processVideoClaim(next)
      await expect.poll(async () => {
        const [waiting] = await db.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`
        return waiting.blocked
      }, { timeout: 2000, interval: 20 }).toBe(true)
      await expectUnpublished(job.id)
      // Use the PostgreSQL clock, not fake timers or a lock-dependent UPDATE.
      await expect.poll(async () => {
        const [clock] = await db.$queryRaw<{ expired: boolean }[]>`SELECT "leaseExpiresAt" <= clock_timestamp() AS expired
          FROM "AccountedVideoJob" WHERE "jobId" = ${job.id}`
        return clock.expired
      }, { timeout: 5000, interval: 25 }).toBe(true)
    } finally {
      release.resolve()
      try { expect(await blocking).toBeUndefined() } finally { if (working) await working }
    }
    expect(await working).toBe('lease_lost')
    await expectUnpublished(job.id)
    expect(await record(job.id)).toMatchObject({ state: 'settling', stagedArtifact: before.stagedArtifact,
      reservation: { state: 'dispatched', settlementIntent: { status: 'pending' } } })
    await processVideoClaim(await claim(job.id))
    await expectCompleted(job.id)
  })

  it.each(['settling', 'completed'] as const)('lost commit acknowledgement after %s preserves authoritative status with no duplicate POST, charge or file', async target => {
    const job = target === 'settling' ? await createAccountedVideoJob(owner(), body) : await staged()
    if (target === 'settling') network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    const next = await claim(job.id), transaction = db.$transaction.bind(db)
    let acknowledgementsLost = 0
    // Execute the real callback AND real COMMIT, then lose only the caller's ack.
    // Mark the target transaction by its actual durable state update, not call order.
    const fault = vi.spyOn(db, '$transaction').mockImplementation((async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options: any) => {
      let targetWritten = false
      const value = await transaction(async tx => {
        const update = tx.accountedVideoJob.update
        tx.accountedVideoJob.update = (async (args: any) => {
          const saved = await update(args)
          if (args.where.jobId === job.id && args.data.state === target) targetWritten = true
          return saved
        }) as typeof update
        try { return await work(tx) } finally { tx.accountedVideoJob.update = update }
      }, options)
      if (targetWritten && acknowledgementsLost === 0) {
        acknowledgementsLost++
        throw new Error('Fixture lost COMMIT acknowledgement')
      }
      return value
    }) as any)
    try { await processVideoClaim(next) } finally { fault.mockRestore() }
    expect(acknowledgementsLost).toBe(1)
    const committed = await record(job.id), storedBytes = await fs.readdir(root)
    expect(committed.state).toBe(target)
    expect(storedBytes).toHaveLength(1)
    const visible = await http(`/v1/videos/generations/${job.id}`, key.key)
    expect(visible.status).toBe(200)
    expect((await visible.json() as { status: string }).status).toBe(committed.job.status)
    if (target === 'settling') {
      await expectUnpublished(job.id)
      expect(committed.reservation.settlementIntent).toMatchObject({ status: 'pending', costMicros: clipPrice, units: 1 })
      await processVideoClaim(await claim(job.id))
    }
    const completed = await expectCompleted(job.id)
    expect(completed.stagedArtifact).toEqual(committed.stagedArtifact)
    expect(await processVideoClaim(next)).toBe('lease_lost')
    await runVideoJobBatch(); await runVideoJobBatch()
    expect(await record(job.id)).toEqual(completed)
    expect(await fs.readdir(root)).toEqual(storedBytes)
    await expectCompleted(job.id)
  })

  it('revocation before dispatch refunds unstarted work exactly once and performs no POST', async () => {
    const job = await createAccountedVideoJob(owner(), body), next = await claim(job.id)
    expect(await revokeApiKey(userId, key.id)).toBe(true)
    await processVideoClaim(next); await processVideoClaim(next); await runVideoJobBatch()
    expect(await record(job.id)).toMatchObject({ state: 'cancelled', submittedAt: null,
      job: { status: 'cancelled', startedAt: null, outputUrl: null },
      reservation: { state: 'released', capturedMicros: 0n, settlementIntent: null } })
    expect(await balance()).toBe(initialBalance)
    expect(await usage()).toEqual([expect.objectContaining({ costMicros: 0n, units: 0 })])
    expect(await files()).toEqual([]); expect(await fs.readdir(root)).toEqual([])
    expect(network).not.toHaveBeenCalled()
  })

  it('revocation after committed dispatch permits confirmed evidence settlement exactly once', async () => {
    const job = await createAccountedVideoJob(owner(), body)
    network.mockImplementationOnce(async () => {
      expect(await record(job.id)).toMatchObject({ state: 'submitting', reservation: { state: 'dispatched' } })
      expect(await revokeApiKey(userId, key.id)).toBe(true)
      return response(createTinyVideoMp4(), false)
    })
    await processVideoClaim(await claim(job.id))
    await expectUnpublished(job.id)
    await processVideoClaim(await claim(job.id)); await runVideoJobBatch()
    await expectCompleted(job.id)
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: key.id } })).revoked).toBe(true)
  })

  it.each(['queued', 'polling'] as const)('feature-flag pause retains %s work and funds without consuming attempts', async state => {
    const job = state === 'queued' ? await createAccountedVideoJob(owner(), body) : await polling()
    const before = await record(job.id), calls = network.mock.calls.length
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'false')
    expect(await claimVideoJobs()).toEqual([])
    expect((await runVideoJobBatch()).claimed).toBe(0)
    expect((await runVideoJobBatch()).claimed).toBe(0)
    expect(await record(job.id)).toEqual(before)
    expect(network).toHaveBeenCalledTimes(calls)
    await expectUnpublished(job.id)
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true')
    const resumed = await claim(job.id)
    expect((await record(job.id)).attempts).toBe(before.attempts + 1)
    expect(resumed.jobId).toBe(job.id)
  })

  it.each(['http://127.0.0.1/secret', 'file:///fixture.mp4', 'https://fixture:secret@cdn.example.com/video.mp4',
    `${cdnUrl}#fragment`, 'data:video/mp4;base64,AAAA'])('rejects unsafe persisted result URL before any GET: %s', async unsafe => {
    const job = await polling()
    await db.mediaJob.update({ where: { id: job.id }, data: { resultUrl: unsafe } })
    const calls = network.mock.calls.length
    await processVideoClaim(await claim(job.id))
    expect(network).toHaveBeenCalledTimes(calls)
    await expectUnpublished(job.id)
    expect((await record(job.id)).reservation.settlementIntent).toBeNull()
    expect(await fs.readdir(root)).toEqual([])
  })

  it('nested result downloads share a shrinking deadline and signal; CDN never receives provider authorization', async () => {
    const job = await polling(), now = Date.now.bind(Date)
    let elapsed = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed)
    network.mockImplementationOnce(async () => { elapsed += 200; return response({ status: 'completed' }) })
      .mockImplementationOnce(async () => { elapsed += 200; return response({ result_url: 'https://cdn.example.com/nested.mp4' }) })
      .mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    try { await processVideoClaim(await claim(job.id)) } finally { clock.mockRestore() }
    const calls = network.mock.calls.slice(1)
    expect(calls.map(([url]) => url)).toEqual([statusUrl, cdnUrl, 'https://cdn.example.com/nested.mp4'])
    expect(new Headers(calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${providerToken}`)
    for (const [, options] of calls.slice(1)) {
      expect(new Headers(options?.headers).get('authorization')).toBeNull()
      expect(options?.allowedOrigins).toBeUndefined()
      expect(options?.signal).toBe(calls[0][1]?.signal)
    }
    expect(calls[1][1]!.timeoutMs).toBeLessThan(calls[0][1]!.timeoutMs!)
    expect(calls[2][1]!.timeoutMs).toBeLessThan(calls[1][1]!.timeoutMs!)
    await processVideoClaim(await claim(job.id))
    await expectCompleted(job.id)
  })

  it.each(['unsafe-link', 'exhausted-budget', 'excessive-depth'] as const)('nested result %s cannot stage evidence or publish bytes', async failure => {
    const job = await polling(), now = Date.now.bind(Date)
    let elapsed = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed)
    network.mockResolvedValueOnce(response({ status: 'completed' }))
    if (failure === 'unsafe-link') network.mockResolvedValueOnce(response({ result_url: 'http://127.0.0.1/secret' }))
    else if (failure === 'exhausted-budget') network.mockImplementationOnce(async (_url, options) => {
      elapsed += options!.timeoutMs! + 1
      return response({ result_url: 'https://cdn.example.com/late.mp4' })
    })
    else network.mockResolvedValue(response({ result_url: cdnUrl }))
    try { await processVideoClaim(await claim(job.id)) } finally { clock.mockRestore() }
    expect(network).toHaveBeenCalledTimes(failure === 'excessive-depth' ? 6 : 3) // POST, poll, bounded result chain.
    if (failure === 'exhausted-budget') expect(network.mock.calls[2][1]?.signal?.aborted).toBe(true)
    await expectUnpublished(job.id)
    expect((await record(job.id)).reservation.settlementIntent).toBeNull()
    expect(await fs.readdir(root)).toEqual([])
    expect(postCount()).toBe(1)
  })

  it('renewal database failure aborts the operation and discards a late successful provider response', async () => {
    const job = await createAccountedVideoJob(owner(), body), started = deferred<AbortSignal>(), late = deferred<ProviderResponse>()
    network.mockImplementationOnce(async (_url, options) => { started.resolve(options!.signal!); return late.promise })
    const working = processVideoClaim(await claim(job.id))
    let fault: { mockRestore(): void } | undefined, injected = false
    try {
      const signal = await started.promise
      // The immediate pre-I/O renewal already succeeded. Fail the next heartbeat
      // transaction, allowing the real recovery transaction to run normally.
      fault = vi.spyOn(db, '$transaction').mockImplementationOnce((async () => {
        injected = true; throw new Error('Fixture renewal database unavailable')
      }) as any)
      await expect.poll(() => signal.aborted, { timeout: 2000, interval: 20 }).toBe(true)
      expect(injected).toBe(true) // Not merely the 5-second request deadline.
    } finally {
      late.resolve(response(createTinyVideoMp4(), false))
      try { await working } finally { fault?.mockRestore() }
    }
    await expectUnpublished(job.id)
    expect(await record(job.id)).toMatchObject({ state: 'needs_reconciliation', stagedArtifact: null,
      reservation: { state: 'unknown', settlementIntent: null } })
    expect(await fs.readdir(root)).toEqual([])
    await runVideoJobBatch()
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('HTTP artifact policy is account-wide: second active key reads/deletes UUID, jobs stay original-key scoped; no cross-user access, revoked keys denied, JWT owner permitted', async () => {
    const ownerJwt = await login(userId), otherJwt = await login(otherId)
    const create = '/v1/videos/generations'
    expect((await http(create, undefined, 'POST', body)).status).toBe(401)
    expect((await http(create, ownerJwt, 'POST', body)).status).toBe(401)
    expect((await http('/api/media/video-jobs', ownerJwt, 'POST', body)).status).toBe(503)
    expect((await http(create, key.key, 'POST', { ...body, costMicros: 0 })).status).toBe(400)
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'false')
    expect((await http(create, key.key, 'POST', body)).status).toBe(503)
    expect(await db.apiReservation.count({ where: { userId } })).toBe(0)
    vi.stubEnv('ACCOUNTED_VIDEO_JOBS_ENABLED', 'true')
    const created = await http(create, key.key, 'POST', body)
    expect(created.status).toBe(202)
    const job = await created.json() as { id: string; status: string; url: string | null }
    expect(job).toMatchObject({ status: 'queued', url: null })
    expect(job.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(network).not.toHaveBeenCalled()
    const status = `${create}/${job.id}`
    for (const bearer of [secondKey.key, foreignKey.key]) {
      expect((await http(status, bearer)).status).toBe(404)
      expect((await http(`${status}/cancel`, bearer, 'POST')).status).toBe(404)
    }
    expect((await http(status, key.key)).status).toBe(200)
    expect((await http(`/api/media/jobs/${job.id}`, ownerJwt)).status).toBe(200)
    expect((await http(`/api/media/jobs/${job.id}`, otherJwt)).status).toBe(404)
    expect((await http(`/api/media/jobs/${job.id}/cancel`, otherJwt, 'POST')).status).toBe(404)
    expect(await db.mediaJob.count({ where: { userId } })).toBe(1)
    network.mockResolvedValueOnce(response(createTinyVideoMp4(), false))
    await processVideoClaim(await claim(job.id)); await processVideoClaim(await claim(job.id))
    const completed = await expectCompleted(job.id), fileUrl = completed.job.outputUrl!, filePath = fileUrl.replace(/\/content$/, '')
    const visible = await http(status, key.key), json = await visible.json()
    expect(json).toMatchObject({ status: 'completed', url: fileUrl })
    for (const secret of [providerToken, endpoint, root, 'leaseToken', 'reservationId', 'stagedArtifact', 'config']) {
      expect(JSON.stringify(json)).not.toContain(secret)
    }
    for (const bearer of [foreignKey.key, otherJwt]) {
      expect((await http(filePath, bearer)).status).toBe(404)
      expect((await http(fileUrl, bearer)).status).toBe(404)
      expect((await http(filePath, bearer, 'DELETE')).status).toBe(404)
    }
    expect((await http(fileUrl)).status).toBe(401)
    for (const bearer of [key.key, secondKey.key, ownerJwt]) {
      expect((await http(filePath, bearer)).status).toBe(200)
      const download = await http(fileUrl, bearer)
      expect(download.status).toBe(200)
      expect(download.headers.get('cache-control')).toContain('no-store')
      expect(download.headers.get('content-type')).toContain('video/mp4')
      expect(Buffer.from(await download.arrayBuffer())).toEqual(createTinyVideoMp4())
    }
    await revokeApiKey(userId, key.id)
    for (const [route, method] of [[create, 'POST'], [status, 'GET'], [`${status}/cancel`, 'POST'],
      [filePath, 'GET'], [fileUrl, 'GET'], [filePath, 'DELETE']]) {
      expect((await http(route, key.key, method, route === create ? body : undefined)).status).toBe(401)
    }
    expect((await http(fileUrl, ownerJwt)).status).toBe(200)
    expect((await http(fileUrl, secondKey.key)).status).toBe(200)
    expect((await http(status, secondKey.key)).status).toBe(404)
    expect((await http(`${status}/cancel`, secondKey.key, 'POST')).status).toBe(404)
    expect((await http(filePath, secondKey.key, 'DELETE')).status).toBe(204)
    expect((await http(fileUrl, ownerJwt)).status).toBe(404)
    expect(await fs.readdir(root)).toEqual([])
    expect(await balance()).toBe(initialBalance - clipPrice)
    expect(await usage()).toHaveLength(1)
    expect(network).toHaveBeenCalledTimes(1)
    const cancellable = await http(create, secondKey.key, 'POST', body)
    expect(cancellable.status).toBe(202)
    const queued = await cancellable.json() as { id: string }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await http(`${create}/${queued.id}/cancel`, secondKey.key, 'POST')).status).toBe(200)
    }
    expect((await record(queued.id)).reservation.state).toBe('released')
    expect(await usage()).toHaveLength(2) // One clip charge and one zero-cost release.
    expect(network).toHaveBeenCalledTimes(1)
    // JWT owner cancellation uses the account route, with a real reserved job.
    const cancelJob = await createAccountedVideoJob({ userId, apiKeyId: secondKey.id }, body)
    expect((await http(`/api/media/jobs/${cancelJob.id}/cancel`, ownerJwt, 'POST')).status).toBe(200)
    expect((await record(cancelJob.id)).reservation.state).toBe('released')
    expect(await balance()).toBe(initialBalance - clipPrice)
  })
})
