/** Daily accounting only. This worker never dispatches providers or refunds holds. */
import { randomUUID } from 'crypto'
import { prisma, hasDb } from './prisma'
import { captureDailySettlement, DailyCreditError, DAILY_SETTLEMENT_MAX_ATTEMPTS, type DailySettlementClaim } from './dailyReservations'

export interface DailySettlementWorkerOptions {
  batchSize?: number
  concurrency?: number
  leaseMs?: number
  pollMs?: number
}
export function dailySettlementWorkerOptions(options: DailySettlementWorkerOptions = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['batchSize', 'concurrency', 'leaseMs', 'pollMs'].includes(key))) {
    throw new DailyCreditError(400, 'INVALID_DAILY_WORKER_OPTIONS', 'Invalid daily settlement worker options')
  }
  const result = { batchSize: options.batchSize ?? 25, concurrency: options.concurrency ?? 4,
    leaseMs: options.leaseMs ?? 30000, pollMs: options.pollMs ?? 1000 }
  const bounds = { batchSize: [1, 100], concurrency: [1, 16], leaseMs: [1000, 300000], pollMs: [100, 60000] }
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    if ((key in options && options[key] === null) || !Number.isSafeInteger(result[key]) || result[key] < bounds[key][0] || result[key] > bounds[key][1]) {
      throw new DailyCreditError(400, 'INVALID_DAILY_WORKER_OPTIONS', 'Invalid daily settlement worker options')
    }
  }
  // A smaller batch simply starts fewer consumers.
  return result
}
function database() {
  if (!hasDb || !prisma) throw new DailyCreditError(503, 'DAILY_ACCOUNTING_UNAVAILABLE', 'Daily credit accounting unavailable')
  return prisma
}

/** One short atomic statement; other processes skip locked rows instead of waiting.
 * Only persisted evidence is scanned, never unknown reservations without metrics.
 */
export async function claimDailySettlements(options: DailySettlementWorkerOptions = {}): Promise<DailySettlementClaim[]> {
  const { batchSize, leaseMs } = dailySettlementWorkerOptions(options)
  const token = randomUUID()
  return database().$queryRaw<DailySettlementClaim[]>`
    WITH candidates AS (
      SELECT "reservationId" FROM "DailySettlementIntent"
      WHERE ("status" = 'pending' AND "nextAttemptAt" <= clock_timestamp())
         OR ("status" = 'processing' AND "leaseExpiresAt" <= clock_timestamp())
      ORDER BY CASE WHEN "status" = 'processing' THEN "leaseExpiresAt" ELSE "nextAttemptAt" END, "reservationId"
      LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    UPDATE "DailySettlementIntent" AS intent
    SET "status" = 'processing', "leaseToken" = ${token},
        "leaseExpiresAt" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
        "attempts" = LEAST(intent."attempts" + 1, ${DAILY_SETTLEMENT_MAX_ATTEMPTS + 1}), "updatedAt" = clock_timestamp()
    FROM candidates WHERE intent."reservationId" = candidates."reservationId"
    RETURNING intent."reservationId", intent."leaseToken"`
}

// Fixed, bounded labels only: never persist/log private exception messages.
function failureCode(error: unknown) {
  if (error instanceof DailyCreditError) {
    if (error.code === 'DAILY_LEASE_LOST') return 'DAILY_LEASE_LOST'
    if (error.code === 'DAILY_SETTLEMENT_EXHAUSTED') return 'DAILY_SETTLEMENT_EXHAUSTED'
    if (error.status === 409 || error.status === 400 || error.status === 403) return 'DAILY_SETTLEMENT_CONFLICT'
  }
  // A unique usage row already present or a violated ledger constraint cannot
  // be repaired by retrying the same immutable intent.
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'P2002' || code === 'P2003' || code === 'P2004') return 'DAILY_SETTLEMENT_CONFLICT'
  return 'DAILY_CAPTURE_RETRY'
}
export type DailySettlementOutcome = 'succeeded' | 'retry' | 'conflict' | 'dead_letter' | 'lease_lost'

async function recordFailure(claim: DailySettlementClaim, code: ReturnType<typeof failureCode>): Promise<DailySettlementOutcome> {
  if (code === 'DAILY_LEASE_LOST') return 'lease_lost'
  return database().$transaction(async tx => {
    // A duplicate consumer may have committed capture between our failed
    // attempt and this callback. Serialize with capture on the intent row and
    // read AFTER locking; never dead-letter or requeue that committed success.
    await tx.$queryRaw`SELECT "reservationId" FROM "DailySettlementIntent" WHERE "reservationId" = ${claim.reservationId} FOR UPDATE`
    const intent = await tx.dailySettlementIntent.findUnique({ where: { reservationId: claim.reservationId }, include: { reservation: true } })
    if (intent?.reservation.state === 'captured' && intent.userId === intent.reservation.userId &&
        intent.kind === intent.reservation.kind && intent.model === intent.reservation.model &&
        intent.reservation.settlementFingerprint === JSON.stringify({
      tokensIn: intent.tokensIn, tokensOut: intent.tokensOut, images: intent.images, model: intent.model,
    })) {
      const acknowledged = await tx.$executeRaw`UPDATE "DailySettlementIntent" SET "status" = 'succeeded', "lastErrorCode" = NULL,
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
        WHERE "reservationId" = ${claim.reservationId} AND "status" = 'processing'
          AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
      return acknowledged === 1 ? 'succeeded' : 'lease_lost'
    }
    const rows = await tx.$queryRaw<{ status: string }[]>`
    UPDATE "DailySettlementIntent"
    SET "status" = CASE
          WHEN ${code} = 'DAILY_SETTLEMENT_CONFLICT' THEN 'conflict'::"DailySettlementStatus"
          WHEN "attempts" >= ${DAILY_SETTLEMENT_MAX_ATTEMPTS} THEN 'dead_letter'::"DailySettlementStatus"
          ELSE 'pending'::"DailySettlementStatus" END,
        "nextAttemptAt" = statement_timestamp() + (LEAST(300000, 1000 * power(2, LEAST("attempts" - 1, 9))) * interval '1 millisecond'),
        "lastErrorCode" = ${code}, "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = statement_timestamp()
    WHERE "reservationId" = ${claim.reservationId} AND "status" = 'processing'
      AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()
    RETURNING "status"`
    if (!rows.length) return 'lease_lost'
    return rows[0].status === 'pending' ? 'retry' : rows[0].status as 'conflict' | 'dead_letter'
  })
}

export async function recoverDailySettlement(claim: DailySettlementClaim): Promise<DailySettlementOutcome> {
  database() // No-DB mode must fail closed, not report an empty/successful sweep.
  try {
    await captureDailySettlement(claim.reservationId, claim)
  } catch (error) {
    return recordFailure(claim, failureCode(error))
  }
  // Intentionally outside capture's transaction. If this statement fails, leave
  // the lease to expire: replay observes captured + exact fingerprint and only
  // acknowledges. Never count an acknowledgement failure as a capture failure.
  const count = await database().$executeRaw`
    UPDATE "DailySettlementIntent" SET "status" = 'succeeded', "lastErrorCode" = NULL,
      "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
    WHERE "reservationId" = ${claim.reservationId} AND "status" = 'processing'
      AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
  return count === 1 ? 'succeeded' : 'lease_lost'
}

export interface DailySettlementBatchResult {
  claimed: number; succeeded: number; retry: number; conflict: number; dead_letter: number
  lease_lost: number; unavailable: number; unprocessed: number; aborted: boolean
}

export function dailySettlementExitCode(result: DailySettlementBatchResult): number {
  if (result.conflict || result.dead_letter) return 3
  return result.aborted || result.unprocessed || result.unavailable || result.retry || result.lease_lost ? 1 : 0
}

export async function runDailySettlementBatch(options: DailySettlementWorkerOptions = {}, signal?: AbortSignal): Promise<DailySettlementBatchResult> {
  const normalized = dailySettlementWorkerOptions(options)
  database()
  const summary: DailySettlementBatchResult = { claimed: 0, succeeded: 0, retry: 0, conflict: 0, dead_letter: 0,
    lease_lost: 0, unavailable: 0, unprocessed: 0, aborted: false }
  // Lease only when a consumer slot is available. Locally queuing an entire
  // batch would burn lease time and retry attempts before capture even starts.
  while (!signal?.aborted && summary.claimed < normalized.batchSize) {
    const claims = await claimDailySettlements({ ...normalized,
      batchSize: Math.min(normalized.concurrency, normalized.batchSize - summary.claimed) })
    if (!claims.length) break
    summary.claimed += claims.length
    await Promise.all(claims.map(async claim => {
      if (signal?.aborted) return
      try { summary[await recoverDailySettlement(claim)]++ }
      catch { summary.unavailable++ } // Lease expiry handles DB/ack failures.
    }))
  }
  summary.aborted = signal?.aborted ?? false
  summary.unprocessed = summary.claimed - summary.succeeded - summary.retry - summary.conflict -
    summary.dead_letter - summary.lease_lost - summary.unavailable
  // No finally-based resets: stopped/unstarted work expires naturally, and stale
  // processes cannot regress another worker's terminal state.
  return summary
}
