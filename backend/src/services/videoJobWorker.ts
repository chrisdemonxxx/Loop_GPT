import { randomUUID } from 'crypto'
import { performance } from 'node:perf_hooks'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { providerRequest, ProviderHttpError } from './providerHttp'
import { checkedMedia, mediaAuth, mediaOperation, mediaUrl, VIDEO_RESPONSE_BYTES } from '../agent/httpClient'
import { decodeVideoResponse } from '../agent/tools/generateVideo'
import { stagePrivateArtifact, verifyStagedArtifact } from './privateFiles'
import { checkPrivateStorageReadiness, resolveRoot } from './privateStorage'
import { validateVideoMp4 } from './mp4Validation'
import { apiFingerprint, apiIntentMatchesCapture, apiTransaction, captureApiSettlementTx, enqueueApiSettlementTx } from './apiReservations'
import { apiSettlementWorkerOptions, type ApiSettlementWorkerOptions } from './apiSettlementRecovery'
import { cancelVideoTx, checkVideoFence, releaseQueuedVideoTx, videoConfigSchema, videoDatabase, videoDispatchEnabled, dailyVideoDispatchEnabled, requireVideoDispatch, validateDailyVideoBinding, videoInputSchema,
  videoOwner, videoUnknownTx, VideoJobError, withVideoFence, type VideoClaim, type LockedVideo } from './accountedVideoJobs'
import { markDailyDispatchedTx, enqueueDailySettlementTx, captureDailySettlementTx } from './dailyReservations'
import { acquireVideoSlotTx, lockVideoQueue, videoQueuePolicySchema, VideoQueueLimitError } from './videoQueuePolicy'

export const videoWorkerOptions = apiSettlementWorkerOptions
export type VideoWorkerOptions = ApiSettlementWorkerOptions

/** Only available slots are leased; never scan historical unaccounted media.
 * The internal claim mode is separate from the strictly validated worker options.
 */
export async function claimVideoJobs(options: VideoWorkerOptions = {}, mode: 'all' | 'settling-only' = 'all'): Promise<VideoClaim[]> {
  const { batchSize, concurrency, leaseMs } = videoWorkerOptions(options)
  const dispatchEnabled = mode === 'all' && videoDispatchEnabled()
  const dailyEnabled = dailyVideoDispatchEnabled()
  videoDatabase()
  return apiTransaction(async tx => {
    const policy = videoQueuePolicySchema.safeParse(await lockVideoQueue(tx))
    const limit = Math.min(batchSize, concurrency)
    // Existing upstream work and settlement never need a NEW slot. Prioritize
    // settlement even at capacity or when policy is missing/malformed.
    const recovery = await tx.$queryRaw<VideoClaim[]>`WITH candidates AS (
    SELECT "jobId" FROM "AccountedVideoJob"
    WHERE ("state" = 'settling' OR (${dispatchEnabled} AND ("dailyReservationId" IS NULL OR ${dailyEnabled}) AND "state" IN ('submitting','polling'))) AND "nextAttemptAt" <= clock_timestamp()
      AND ("leaseToken" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
    ORDER BY CASE WHEN "state" = 'settling' THEN 0 ELSE 1 END, "nextAttemptAt", "jobId" LIMIT ${limit} FOR UPDATE SKIP LOCKED
  ) UPDATE "AccountedVideoJob" AS job SET "leaseToken" = ${randomUUID()},
    "leaseExpiresAt" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
    "attempts" = LEAST(job."attempts" + 1, 1001), "updatedAt" = clock_timestamp()
    FROM candidates WHERE job."jobId" = candidates."jobId" RETURNING job."jobId", job."leaseToken"`
    if (!policy.success) {
      if (recovery.length || !dispatchEnabled) return recovery
      throw new VideoQueueLimitError('video_queue_config')
    }
    if (recovery.length === limit || !dispatchEnabled) return recovery
    const p = policy.data
    // Ranking happens AFTER excluding saturated users. Only bounded candidate
    // IDs leave SQL; no unbounded JS row load or head-of-line scan window. Live
    // queued leases earmark slots across workers until dispatch or lease expiry.
    const queued = await tx.$queryRaw<VideoClaim[]>`WITH occupied AS MATERIALIZED (
      SELECT m."userId", count(*) AS used FROM "AccountedVideoJob" v
      JOIN "MediaJob" m ON m.id = v."jobId"
      WHERE v."upstreamSlot" OR (v.state = 'queued' AND v."leaseToken" IS NOT NULL AND v."leaseExpiresAt" > clock_timestamp())
      GROUP BY m."userId"
    ), ranked AS (
      SELECT v."jobId", v."nextAttemptAt", COALESCE(o.used, 0) AS used,
        row_number() OVER (PARTITION BY m."userId" ORDER BY v."nextAttemptAt", v."jobId") AS position
      FROM "AccountedVideoJob" v JOIN "MediaJob" m ON m.id = v."jobId"
      LEFT JOIN occupied o ON o."userId" = m."userId"
      WHERE v.state = 'queued' AND NOT v."upstreamSlot" AND v."submittedAt" IS NULL
        AND (v."dailyReservationId" IS NULL OR ${dailyEnabled}) AND v."nextAttemptAt" <= clock_timestamp()
        AND (v."leaseToken" IS NULL OR v."leaseExpiresAt" <= clock_timestamp())
        AND COALESCE(o.used, 0) < ${p.userActive}
    ), candidates AS (
      SELECT "jobId" FROM ranked WHERE position <= ${p.userActive} - used
      ORDER BY "nextAttemptAt", "jobId"
      LIMIT LEAST(${limit - recovery.length}, GREATEST(0, ${p.globalActive} - (SELECT COALESCE(sum(used), 0) FROM occupied)))
    ) UPDATE "AccountedVideoJob" v SET "leaseToken" = ${randomUUID()},
      "leaseExpiresAt" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
      attempts = LEAST(v.attempts + 1, 1001), "updatedAt" = clock_timestamp()
      FROM candidates c WHERE v."jobId" = c."jobId" RETURNING v."jobId", v."leaseToken"`
    return [...recovery, ...queued]
  })
}

async function remaining(tx: Prisma.TransactionClient, row: LockedVideo) {
  const config = videoConfigSchema.parse(row.config)
  const [clock] = await tx.$queryRaw<{ elapsed: number }[]>`SELECT EXTRACT(EPOCH FROM
    (clock_timestamp() - COALESCE("startedAt", clock_timestamp())))::double precision * 1000 AS elapsed
    FROM "MediaJob" WHERE "id" = ${row.jobId}`
  const ms = Math.floor(config.budgetMs - Math.max(0, clock.elapsed))
  if (ms <= 0 || row.attempts > config.maxPolls + 1) throw new VideoJobError('budget_exhausted')
  return { config, ms }
}
function validateBinding(row: LockedVideo) {
  if (row.dailyReservation) return validateDailyVideoBinding(row).input
  if (!row.reservation) throw new VideoJobError('invalid_provider')
  const input = videoInputSchema.parse(row.job.metadata), config = videoConfigSchema.parse(row.config)
  const pricing = row.reservation.pricingSnapshot as { version?: string; perUnitMicros?: number; units?: number } | null
  if (input.prompt !== row.job.prompt || input.model !== row.reservation.model ||
      pricing?.version !== 'accounted-video-v1' || pricing.units !== 1 ||
      !Number.isSafeInteger(pricing.perUnitMicros) || BigInt(pricing.perUnitMicros!) !== row.reservation.amountMicros ||
      row.reservation.requestFingerprint !== apiFingerprint([input, row.endpoint, config, row.reservation.pricingSnapshot])) throw new VideoJobError('invalid_provider')
  return input
}
async function retryTx(tx: Prisma.TransactionClient, row: LockedVideo, delay: number, failed: boolean) {
  await tx.accountedVideoJob.update({ where: { jobId: row.jobId }, data: { failures: failed ? row.failures + 1 : 0, leaseToken: null, leaseExpiresAt: null } })
  await tx.$executeRaw`UPDATE "AccountedVideoJob" SET "nextAttemptAt" = clock_timestamp() + (${delay} * interval '1 millisecond') WHERE "jobId" = ${row.jobId}`
}

/** Dispatch fence and ledger marker are a single commit BEFORE the first POST.
 * A crash immediately after this commit is unknown, never a reason to repeat POST.
 */
export async function dispatchVideoClaim(claim: VideoClaim) {
  return withVideoFence(claim, async (tx, row) => {
    if (row.job.status === 'cancelled' && !row.cancelRequested) { await cancelVideoTx(tx, row); return null }
    if (row.state !== 'queued' || row.submittedAt || row.cancelRequested) throw new VideoJobError('lease_lost')
    const input = validateBinding(row)
    if (requireVideoDispatch(row) !== row.endpoint) throw new VideoJobError('invalid_provider')
    if (row.dailyReservationId) {
      // Serialize authorization with plan/admin changes, keeping it through dispatch.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${row.job.userId} FOR UPDATE`
      const user = await tx.user.findUnique({ where: { id: row.job.userId } })
      const { pricing } = validateDailyVideoBinding(row)
      if (!user || user.plan !== pricing.plan || user.role !== pricing.role || user.unlimited !== pricing.unlimited) throw new VideoJobError('invalid_provider')
    } else {
      if (!row.reservation) throw new VideoJobError('invalid_provider')
      const key = await tx.apiKey.findFirst({ where: { id: row.reservation.apiKeyId!, userId: row.job.userId, revoked: false } })
      if (!key) throw new VideoJobError('invalid_provider')
    }
    const budget = await remaining(tx, row)
    await acquireVideoSlotTx(tx, row.jobId, row.job.userId)
    if (row.dailyReservationId) await markDailyDispatchedTx(tx, row.dailyReservationId)
    else {
      await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${row.reservationId} FOR UPDATE`
      const changed = await tx.apiReservation.updateMany({ where: { id: videoOwner(row).id, state: 'reserved' }, data: { state: 'dispatched' } })
      if (changed.count !== 1) throw new VideoJobError('invalid_provider')
    }
    requireVideoDispatch(row)
    await checkVideoFence(tx, claim)
    await tx.$executeRaw`UPDATE "AccountedVideoJob" SET "state" = 'submitting', "submittedAt" = clock_timestamp(), "updatedAt" = clock_timestamp() WHERE "jobId" = ${row.jobId}`
    await tx.$executeRaw`UPDATE "MediaJob" SET "status" = 'processing', "startedAt" = COALESCE("startedAt", clock_timestamp()), "progress" = 1, "updatedAt" = clock_timestamp() WHERE "id" = ${row.jobId}`
    return { row, input, ...budget }
  })
}

async function renew(claim: VideoClaim, leaseMs: number) {
  const renewed = await withVideoFence(claim, async (tx, row) => {
    if (row.job.status === 'cancelled' && !row.cancelRequested) { await cancelVideoTx(tx, row); return false }
    requireVideoDispatch(row)
    await tx.$executeRaw`UPDATE "AccountedVideoJob" SET "leaseExpiresAt" = clock_timestamp() + (${leaseMs} * interval '1 millisecond') WHERE "jobId" = ${row.jobId}`
    return true
  })
  if (!renewed) throw new VideoJobError('lease_lost')
}

/** Evidence + prepared artifact identity commit together. No PrivateFile row yet. */
async function persistCompletion(claim: VideoClaim, buffer: Buffer) {
  checkedMedia(buffer)
  // Establish actual video tracks/samples before admitting billable completion.
  try { validateVideoMp4(buffer) } catch { throw new VideoJobError('invalid_provider') }
  await withVideoFence(claim, async () => {})
  const artifact = await stagePrivateArtifact(`loop-video-${claim.jobId}.mp4`, 'video/mp4', buffer)
  await withVideoFence(claim, async (tx, row) => {
    if (!['submitting', 'polling'].includes(row.state)) throw new VideoJobError('lease_lost')
    if (row.job.status === 'cancelled' && !row.cancelRequested) {
      await tx.accountedVideoJob.update({ where: { jobId: row.jobId }, data: { cancelRequested: true } })
      row.cancelRequested = true
    }
    validateBinding(row)
    // Flat server tariff: one validated completed clip, never provider/client cost.
    if (row.dailyReservationId) await enqueueDailySettlementTx(tx, row.dailyReservationId, row.job.userId, 'video', { model: row.dailyReservation!.model })
    else await enqueueApiSettlementTx(tx, { ...videoOwner(row), expectedKind: 'video', expectedModel: row.reservation!.model,
      costMicros: row.reservation!.amountMicros, units: 1 })
    await checkVideoFence(tx, claim)
    await tx.accountedVideoJob.update({ where: { jobId: row.jobId }, data: {
      state: 'settling', stagedArtifact: { ...artifact }, failures: 0, leaseToken: null, leaseExpiresAt: null } })
  })
}

/** Existing settlement worker may have captured already. This transaction only
 * publishes after exact intent/capture agreement; retries never charge twice.
 */
async function finalize(claim: VideoClaim, row: LockedVideo) {
  const artifact = await verifyStagedArtifact(row.stagedArtifact)
  await withVideoFence(claim, async (tx, current) => {
    if (current.state !== 'settling' || apiFingerprint(current.stagedArtifact) !== apiFingerprint(artifact)) throw new VideoJobError('lease_lost')
    // A legacy/manual writer may cancel during asynchronous byte verification.
    // Reconcile under the publication lock, retaining our fence through capture.
    if (current.job.status === 'cancelled' && !current.cancelRequested) {
      await tx.accountedVideoJob.update({ where: { jobId: current.jobId }, data: { cancelRequested: true } })
      current.cancelRequested = true
    }
    validateBinding(current)
    if (current.dailyReservationId) {
      // This validates immutable intent identity and exact capture fingerprint,
      // including an earlier capture by the independent daily recovery worker.
      await captureDailySettlementTx(tx, current.dailyReservationId)
    } else {
      const reservationId = videoOwner(current).id
      await captureApiSettlementTx(tx, reservationId)
      const reservation = await tx.apiReservation.findUniqueOrThrow({ where: { id: reservationId } })
      const intent = await tx.apiSettlementIntent.findUniqueOrThrow({ where: { reservationId } })
      if (!apiIntentMatchesCapture(reservation, intent)) throw new VideoJobError('invalid_provider')
    }
    await checkVideoFence(tx, claim)
    if (!current.cancelRequested) await tx.privateFile.create({ data: { ...artifact, userId: current.job.userId, purpose: 'artifact' } })
    await tx.mediaJob.update({ where: { id: current.jobId }, data: { status: current.cancelRequested ? 'cancelled' : 'completed',
      progress: current.cancelRequested ? current.job.progress : 100,
      outputUrl: current.cancelRequested ? null : `/api/files/${artifact.id}/content`, error: null } })
    await tx.$executeRaw`UPDATE "MediaJob" SET "completedAt" = clock_timestamp() WHERE "id" = ${current.jobId}`
    await tx.accountedVideoJob.update({ where: { jobId: current.jobId }, data: {
      state: current.cancelRequested ? 'cancelled' : 'completed', upstreamSlot: false, leaseToken: null, leaseExpiresAt: null } })
  })
}

export type VideoOutcome = 'advanced' | 'retry' | 'paused' | 'needs_reconciliation' | 'lease_lost'
export async function processVideoClaim(claim: VideoClaim, options: VideoWorkerOptions = {}, signal?: AbortSignal): Promise<VideoOutcome> {
  const { leaseMs } = videoWorkerOptions(options)
  let op: ReturnType<typeof mediaOperation> | undefined, watcher: ReturnType<typeof setInterval> | undefined
  try {
    if (signal?.aborted) throw new VideoJobError('lease_lost')
    const initial = await withVideoFence(claim, async (tx, value) => {
      if (value.job.status === 'cancelled' && !value.cancelRequested) { await cancelVideoTx(tx, value); return null }
      return value
    })
    if (!initial) return 'lease_lost'
    let row = initial
    if (row.state === 'settling') { await finalize(claim, row); return 'advanced' }
    requireVideoDispatch(row)
    if (row.state === 'submitting') {
      // Reclaimed dispatch: only previously persisted status permits safe GET.
      if (!row.job.statusUrl) {
        await withVideoFence(claim, videoUnknownTx)
        return 'needs_reconciliation'
      }
      await withVideoFence(claim, async (tx, value) => {
        await tx.accountedVideoJob.update({ where: { jobId: value.jobId }, data: { state: 'polling' } })
      })
      row.state = 'polling'
    }
    const submitting = row.state === 'queued'
    const prepared = submitting ? await dispatchVideoClaim(claim) : await withVideoFence(claim, async (tx, value) => {
      validateBinding(value)
      if (requireVideoDispatch(value) !== value.endpoint) throw new VideoJobError('invalid_provider')
      return { row: value, input: videoInputSchema.parse(value.job.metadata), ...await remaining(tx, value) }
    })
    if (!prepared) return 'lease_lost'
    row = prepared.row
    // Re-read DB time after dispatch's ledger lock waits. Subtract the complete
    // read round-trip conservatively so DB latency cannot extend the deadline.
    const budgetRead = performance.now()
    const freshBudget = await withVideoFence(claim, (tx, value) => remaining(tx, value))
    op = mediaOperation(Math.min(Math.floor(freshBudget.ms - (performance.now() - budgetRead)), prepared.config.requestMs), signal)
    const operation = op
    let checking = false
    watcher = setInterval(() => {
      if (checking) return
      checking = true
      void renew(claim, leaseMs).catch(() => operation.abort()).finally(() => { checking = false })
    }, Math.min(250, Math.floor(leaseMs / 3)))
    // Revalidate immediately before I/O. Cancellation can still race the actual
    // socket send: already accepted upstream work cannot be reliably recalled.
    await renew(claim, leaseMs)
    op.check()
    const endpoint = row.endpoint, auth = mediaAuth(endpoint)
    if (row.job.resultUrl) mediaUrl(row.job.resultUrl, endpoint)
    const url = submitting ? mediaUrl(endpoint) : mediaUrl(row.job.statusUrl!, endpoint, true)
    const input = prepared.input
    const response = await providerRequest(url, { ...auth, method: submitting ? 'POST' : 'GET',
      ...(submitting ? { headers: { ...auth.headers, 'Content-Type': 'application/json', Accept: 'application/json, video/mp4' },
        body: JSON.stringify({ inputs: input.prompt, parameters: { width: input.width, height: input.height, fps: input.fps, num_frames: input.numFrames } }) } : {}),
      signal: op.signal, timeoutMs: op.remaining(), maxBytes: VIDEO_RESPONSE_BYTES })
    op.check()
    if (!(response.headers.get('content-type') || '').includes('json')) {
      if (!submitting) throw new VideoJobError('invalid_provider')
      await persistCompletion(claim, response.body)
      return 'advanced'
    }
    const data = await response.json()
    op.check()
    if (submitting && data?.job_id && data?.status_url) {
      if (typeof data.job_id !== 'string' || data.job_id.length > 256) throw new VideoJobError('invalid_provider')
      const statusUrl = mediaUrl(data.status_url, endpoint, true)
      const resultUrl = data.result_url ? mediaUrl(data.result_url, endpoint) : null
      await withVideoFence(claim, async (tx, value) => {
        await tx.mediaJob.update({ where: { id: value.jobId }, data: { providerJobId: data.job_id, statusUrl, resultUrl, progress: 5 } })
        await tx.accountedVideoJob.update({ where: { jobId: value.jobId }, data: { state: 'polling' } })
        await retryTx(tx, value, prepared.config.pollMs, false)
      })
      return 'advanced'
    }
    const status = String(data?.status || '').toLowerCase()
    if (!submitting && ['queued', 'pending', 'processing', 'running'].includes(status)) {
      await withVideoFence(claim, (tx, value) => retryTx(tx, value, prepared.config.pollMs, false))
      return 'advanced'
    }
    if (!submitting && !['completed', 'succeeded'].includes(status)) throw new VideoJobError('invalid_provider')
    const buffer = await decodeVideoResponse({ ...data, result_url: data?.result_url || row.job.resultUrl }, endpoint, op)
    op.check()
    await persistCompletion(claim, buffer)
    return 'advanced'
  } catch (error) {
    if (error instanceof VideoJobError && error.code === 'lease_lost') return 'lease_lost'
    try {
      return await withVideoFence(claim, async (tx, row): Promise<VideoOutcome> => {
        // Policy reductions/races are reversible pauses, never refund evidence.
        if (error instanceof VideoQueueLimitError) {
          await retryTx(tx, row, 5000, false)
          return 'paused'
        }
        // A disabled feature or temporarily absent configuration is a reversible
        // pause, not evidence that queued/submitted work failed permanently.
        if (row.state !== 'settling' && ((!videoDispatchEnabled() || (row.dailyReservationId && !dailyVideoDispatchEnabled())) ||
            (error instanceof VideoJobError && error.code === 'unavailable'))) {
          await retryTx(tx, row, 5000, false)
          return 'paused'
        }
        // Ambiguous evidence commit: re-read authoritative state; never erase it.
        const fatal = error instanceof VideoJobError || error instanceof ZodError ||
          (error instanceof ProviderHttpError && ['blocked_destination', 'invalid_request', 'redirect_rejected'].includes(error.code))
        let exhausted = row.failures >= 9 || row.attempts >= 1000
        if (row.state !== 'settling') {
          try { await remaining(tx, row) } catch { exhausted = true }
        }
        if (row.state === 'queued' && (fatal || exhausted)) { await releaseQueuedVideoTx(tx, row); return 'advanced' }
        if (row.state === 'submitting' || exhausted || (fatal && row.state !== 'settling')) {
          await videoUnknownTx(tx, row)
          return 'needs_reconciliation'
        }
        await retryTx(tx, row, Math.min(60000, 1000 * 2 ** row.failures), true)
        return 'retry'
      })
    } catch (failure) {
      if (failure instanceof VideoJobError && failure.code === 'lease_lost') return 'lease_lost'
      throw failure // DB outage: expiry safely recovers the persisted stage.
    }
  } finally { if (watcher) clearInterval(watcher); op?.dispose() }
}

export async function runVideoJobBatch(options: VideoWorkerOptions = {}, signal?: AbortSignal) {
  const normalized = videoWorkerOptions(options)
  let mode: 'all' | 'settling-only' = 'all'
  if (process.env.NODE_ENV === 'production') {
    await resolveRoot()
    try { await checkPrivateStorageReadiness() } catch {
      // A failed write probe must not strand already-staged completions. Recheck
      // namespace identity/readability: a missing or replaced root still blocks
      // ALL claims, including recovery. Finalization verifies the bytes again.
      await resolveRoot()
      mode = 'settling-only'
    }
  }
  const result = { claimed: 0, advanced: 0, retry: 0, paused: 0, needs_reconciliation: 0, lease_lost: 0, unavailable: 0,
    aborted: false, dispatchEnabled: videoDispatchEnabled() }
  while (!signal?.aborted && result.claimed < normalized.batchSize) {
    const claims = await claimVideoJobs({ ...normalized, batchSize: Math.min(normalized.concurrency, normalized.batchSize - result.claimed) }, mode)
    if (!claims.length) break
    result.claimed += claims.length
    await Promise.all(claims.map(async claim => {
      try { result[await processVideoClaim(claim, normalized, signal)]++ } catch { result.unavailable++ }
    }))
  }
  result.aborted = !!signal?.aborted
  return result
}
