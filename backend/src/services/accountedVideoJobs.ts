/** Ledger-linked durable video. HTTP creates only; the separate worker owns dispatch.
 * Server UUIDs are NOT HTTP idempotency keys: repeated POSTs create separate holds.
 * Lock order: queue policy -> accounted job -> media job -> ledger locks (prepaid reservation ->
 * intent -> balance; daily user -> reservation/intent).
 * Settlement-only recovery never locks a job, so it cannot invert that order.
 */
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, hasDb } from './prisma'
import { apiFingerprint, apiTransaction, ApiBillingError, reserveApiBalanceTx, settleApiReservationTx } from './apiReservations'
import { netCostMicros, RATE_VIDEO } from './apiBilling'
import { mediaUrl } from '../agent/httpClient'
import { validatePublicUrl } from './publicHttp'
import { reserveDailyCreditsTx, finishDailyFailureTx } from './dailyReservations'
import { CREDIT_COST, PLAN_LIMITS } from './billing'
import { admitVideoTx, lockVideoQueue } from './videoQueuePolicy'

export class VideoJobError extends Error {
  constructor(public readonly code: 'unavailable' | 'invalid_request' | 'not_found' | 'lease_lost' | 'invalid_provider' | 'budget_exhausted') {
    super(`Video job: ${code}`)
  }
}
export const videoInputSchema = z.object({
  model: z.literal('loop-video').default('loop-video'),
  prompt: z.string().trim().min(3).max(2000),
  width: z.number().int().min(256).max(960).multipleOf(16).default(960),
  height: z.number().int().min(256).max(960).multipleOf(16).default(544),
  fps: z.number().int().min(8).max(30).default(24),
  numFrames: z.number().int().min(16).max(120).default(96),
}).strict()
export const videoConfigSchema = z.object({
  version: z.literal(1),
  budgetMs: z.number().int().min(1000).max(1800000),
  requestMs: z.number().int().min(1000).max(30000),
  pollMs: z.number().int().min(1000).max(60000),
  maxPolls: z.number().int().min(1).max(600),
}).strict()
export function videoEndpoint(): string {
  try {
    if (process.env.ACCOUNTED_VIDEO_JOBS_ENABLED !== 'true' || !/^[\x21-\x7e]{1,8000}$/.test(process.env.HF_TOKEN || '')) throw new Error()
    const url = validatePublicUrl(mediaUrl(process.env.HF_VIDEO_ENDPOINT || ''))
    // Endpoint configuration cannot hide credentials in query strings/userinfo.
    if (url.search) throw new Error()
    return url.href
  } catch { throw new VideoJobError('unavailable') }
}
export function videoConfiguration() {
  const endpoint = videoEndpoint()
  const parsed = videoConfigSchema.safeParse({ version: 1,
    budgetMs: Number(process.env.HF_VIDEO_MAX_WAIT_MS ?? 1800000),
    requestMs: Number(process.env.ACCOUNTED_VIDEO_REQUEST_MS ?? 30000),
    pollMs: Number(process.env.ACCOUNTED_VIDEO_POLL_MS ?? 5000),
    maxPolls: Number(process.env.ACCOUNTED_VIDEO_MAX_POLLS ?? 600),
  })
  if (!parsed.success) throw new VideoJobError('unavailable')
  return { endpoint, config: parsed.data }
}
/** Operational pause: settled evidence can still be captured without provider I/O. */
export function videoDispatchEnabled() {
  try { videoEndpoint(); return true } catch { return false }
}
export function dailyVideoDispatchEnabled() {
  return process.env.ACCOUNTED_DAILY_VIDEO_JOBS_ENABLED === 'true' && videoDispatchEnabled()
}
export function requireVideoDispatch(row: { dailyReservationId: string | null }) {
  if (row.dailyReservationId && !dailyVideoDispatchEnabled()) throw new VideoJobError('unavailable')
  return videoEndpoint()
}
export function videoDatabase() {
  if (!hasDb || !prisma) throw new VideoJobError('unavailable')
  return prisma
}

export async function createAccountedVideoJob(owner: { userId: string; apiKeyId: string }, body: unknown) {
  const { endpoint, config } = videoConfiguration()
  videoDatabase()
  const parsed = videoInputSchema.safeParse(body)
  if (!parsed.success) throw new VideoJobError('invalid_request')
  if (!owner.userId || !owner.apiKeyId) throw new ApiBillingError('invalid_owner')
  const input = parsed.data, id = randomUUID(), reservationId = randomUUID()
  return apiTransaction(async tx => {
    await admitVideoTx(tx, owner.userId)
    // Plan is read from the server account, never the HTTP payload or job parameters.
    const user = await tx.user.findUnique({ where: { id: owner.userId } })
    if (!user) throw new ApiBillingError('invalid_owner')
    const amountMicros = netCostMicros(RATE_VIDEO, user.apiPlan)
    const pricingSnapshot = { version: 'accounted-video-v1', perUnitMicros: amountMicros, units: 1 }
    await reserveApiBalanceTx(tx, { ...owner, id: reservationId, kind: 'video', model: input.model,
      amountMicros, pricingSnapshot, requestFingerprint: apiFingerprint([input, endpoint, config, pricingSnapshot]) })
    return tx.mediaJob.create({ data: { id, userId: owner.userId, prompt: input.prompt, kind: 'video', metadata: input,
      accountedVideo: { create: { reservationId, endpoint, config } } } })
  })
}

export async function createDailyVideoJob(userId: string, body: unknown) {
  if (!dailyVideoDispatchEnabled()) throw new VideoJobError('unavailable')
  const { endpoint, config } = videoConfiguration(), parsed = videoInputSchema.safeParse(body)
  if (!parsed.success) throw new VideoJobError('invalid_request')
  const input = parsed.data, id = randomUUID()
  return apiTransaction(async tx => {
    await admitVideoTx(tx, userId)
    // This helper locks the account, resets its window and debits in this transaction.
    const reservation = await reserveDailyCreditsTx(tx, userId, 'video', input.model)
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } })
    if (!Object.prototype.hasOwnProperty.call(PLAN_LIMITS, user.plan) || !['user', 'admin'].includes(user.role)) throw new VideoJobError('invalid_request')
    const pricingSnapshot = { version: 'daily-video-v1', plan: user.plan, role: user.role, unlimited: user.unlimited,
      credits: reservation.credits, imageCredits: reservation.imageCredits, bypass: reservation.bypass }
    await tx.dailyReservation.update({ where: { id: reservation.id }, data: { pricingSnapshot,
      requestFingerprint: apiFingerprint([id, userId, reservation.id, reservation.windowStart.toISOString(), input, endpoint, config, pricingSnapshot]) } })
    return tx.mediaJob.create({ data: { id, userId, kind: 'video', prompt: input.prompt, metadata: input,
      accountedVideo: { create: { dailyReservationId: reservation.id, endpoint, config } } } })
  })
}

export interface VideoClaim { jobId: string; leaseToken: string }
export async function lockVideo(tx: Prisma.TransactionClient, id: string) {
  await lockVideoQueue(tx)
  await tx.$queryRaw`SELECT "jobId" FROM "AccountedVideoJob" WHERE "jobId" = ${id} FOR UPDATE`
  await tx.$queryRaw`SELECT "id" FROM "MediaJob" WHERE "id" = ${id} FOR UPDATE`
  const row = await tx.accountedVideoJob.findUnique({ where: { jobId: id }, include: { job: true, reservation: true, dailyReservation: true } })
  if (!row) throw new VideoJobError('not_found')
  const ledger = row.reservation ?? row.dailyReservation
  if (!ledger || !!row.reservation === !!row.dailyReservation || row.job.kind !== 'video' ||
      row.job.userId !== ledger.userId || ledger.kind !== 'video' || (row.reservation && !row.reservation.apiKeyId)) throw new ApiBillingError('invalid_owner')
  return row
}
export type LockedVideo = Awaited<ReturnType<typeof lockVideo>>
export async function checkVideoFence(tx: Prisma.TransactionClient, claim: VideoClaim) {
  const valid = await tx.$queryRaw<{ jobId: string }[]>`SELECT "jobId" FROM "AccountedVideoJob"
    WHERE "jobId" = ${claim.jobId} AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()
      AND "state" IN ('queued','submitting','polling','settling')`
  if (!valid.length) throw new VideoJobError('lease_lost')
}
export async function withVideoFence<T>(claim: VideoClaim, action: (tx: Prisma.TransactionClient, row: LockedVideo) => Promise<T>) {
  return apiTransaction(async tx => {
    const row = await lockVideo(tx, claim.jobId)
    await checkVideoFence(tx, claim)
    const result = await action(tx, row)
    // Recheck time AFTER all dependent locks/I/O, even if action retired its own
    // token. Expiry while waiting for a ledger lock rolls the entire action back.
    // The job lock prevents another claimant from changing the captured token.
    const [clock] = await tx.$queryRaw<{ valid: boolean }[]>`SELECT clock_timestamp() < ${row.leaseExpiresAt} AS valid`
    if (!clock.valid) throw new VideoJobError('lease_lost')
    return result
  })
}
export const videoOwner = (row: LockedVideo) => {
  if (!row.reservation || !row.reservationId) throw new ApiBillingError('invalid_owner')
  return { id: row.reservationId, userId: row.job.userId, apiKeyId: row.reservation.apiKeyId }
}

export function validateDailyVideoBinding(row: LockedVideo) {
  const reservation = row.dailyReservation!
  const input = videoInputSchema.parse(row.job.metadata), config = videoConfigSchema.parse(row.config)
  const pricing = reservation.pricingSnapshot as { version?: string; plan?: string; role?: string; unlimited?: boolean; credits?: number; imageCredits?: number; bypass?: boolean } | null
  if (!pricing || pricing.version !== 'daily-video-v1' || !Object.prototype.hasOwnProperty.call(PLAN_LIMITS, pricing.plan || '') ||
      !['user', 'admin'].includes(pricing.role || '') || typeof pricing.unlimited !== 'boolean' ||
      pricing.bypass !== (pricing.role === 'admin' || pricing.unlimited) || reservation.bypass !== pricing.bypass ||
      reservation.credits !== pricing.credits || reservation.credits !== (pricing.bypass ? 0 : CREDIT_COST.video) ||
      reservation.imageCredits !== 0 || pricing.imageCredits !== 0 || input.model !== reservation.model || input.prompt !== row.job.prompt ||
      reservation.requestFingerprint !== apiFingerprint([row.jobId, row.job.userId, reservation.id, reservation.windowStart.toISOString(), input, row.endpoint, config, pricing])) {
    throw new VideoJobError('invalid_provider')
  }
  return { input, pricing }
}

/** Unknown is a retained hold, including cancellation after possibly accepted work. */
export async function videoUnknownTx(tx: Prisma.TransactionClient, row: LockedVideo) {
  if (row.dailyReservationId) await finishDailyFailureTx(tx, row.dailyReservationId)
  else {
    await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${row.reservationId} FOR UPDATE`
    await tx.apiReservation.updateMany({ where: { id: videoOwner(row).id, state: 'dispatched' }, data: { state: 'unknown' } })
  }
  await tx.accountedVideoJob.update({ where: { jobId: row.jobId }, data: {
    state: 'needs_reconciliation', leaseToken: null, leaseExpiresAt: null } })
  await tx.mediaJob.update({ where: { id: row.jobId }, data: {
    status: row.cancelRequested ? 'cancelled' : 'needs_reconciliation', error: 'Video work requires reconciliation', outputUrl: null } })
}
export async function releaseQueuedVideoTx(tx: Prisma.TransactionClient, row: LockedVideo) {
  if (row.upstreamSlot || row.submittedAt || row.state !== 'queued') throw new ApiBillingError('conflict')
  if (row.dailyReservationId) await finishDailyFailureTx(tx, row.dailyReservationId)
  else await settleApiReservationTx(tx, { ...videoOwner(row), outcome: 'release', costMicros: 0 })
  await tx.accountedVideoJob.update({ where: { jobId: row.jobId }, data: { state: 'cancelled', cancelRequested: true, leaseToken: null, leaseExpiresAt: null } })
  await tx.$executeRaw`UPDATE "MediaJob" SET "status" = 'cancelled', "completedAt" = clock_timestamp(), "updatedAt" = clock_timestamp() WHERE "id" = ${row.jobId}`
}
export async function cancelAccountedVideoJob(id: string, owner: { userId: string; apiKeyId?: string }) {
  return apiTransaction(async tx => {
    const row = await lockVideo(tx, id)
    if (row.job.userId !== owner.userId || (owner.apiKeyId !== undefined && (!row.reservation || row.reservation.apiKeyId !== owner.apiKeyId))) throw new VideoJobError('not_found')
    await cancelVideoTx(tx, row)
  })
}

/** Also honors manual/older cancellation writers that only set MediaJob.status. */
export async function cancelVideoTx(tx: Prisma.TransactionClient, row: LockedVideo) {
    const id = row.jobId
    if (['completed', 'cancelled'].includes(row.state)) return
    if (row.state === 'queued') return releaseQueuedVideoTx(tx, row)
    await tx.accountedVideoJob.update({ where: { jobId: id }, data: { cancelRequested: true, leaseToken: null, leaseExpiresAt: null } })
    row.cancelRequested = true
    // Confirmed usage must still be captured. Otherwise only a known status URL
    // permits safe GET recovery after cancellation; no new POST is possible.
    if (row.state === 'settling' || (row.job.statusUrl && row.state !== 'needs_reconciliation')) {
      if (row.dailyReservationId && row.state !== 'settling') await finishDailyFailureTx(tx, row.dailyReservationId)
      await tx.accountedVideoJob.update({ where: { jobId: id }, data: { state: row.state === 'settling' ? 'settling' : 'polling' } })
      await tx.mediaJob.update({ where: { id }, data: { status: 'cancelled', error: 'Cancellation requested; upstream work may already be accepted' } })
    } else await videoUnknownTx(tx, row)
}
