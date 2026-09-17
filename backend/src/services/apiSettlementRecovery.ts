/** Prepaid confirmed-usage delivery only. Never invokes providers or releases holds. */
import { randomUUID } from 'crypto'
import { prisma, hasDb } from './prisma'
import { ApiBillingError, API_SETTLEMENT_MAX_ATTEMPTS, apiIntentMatchesCapture, captureApiSettlement, type ApiSettlementClaim } from './apiReservations'

export interface ApiSettlementWorkerOptions {
  batchSize?: number
  concurrency?: number
  leaseMs?: number
  pollMs?: number
}
export function apiSettlementWorkerOptions(options: ApiSettlementWorkerOptions = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => !['batchSize', 'concurrency', 'leaseMs', 'pollMs'].includes(key))) throw new ApiBillingError('invalid_request')
  const result = { batchSize: options.batchSize ?? 25, concurrency: options.concurrency ?? 4,
    leaseMs: options.leaseMs ?? 30000, pollMs: options.pollMs ?? 1000 }
  const bounds = { batchSize: [1, 100], concurrency: [1, 16], leaseMs: [1000, 300000], pollMs: [100, 60000] }
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    if ((key in options && options[key] === null) || !Number.isSafeInteger(result[key]) || result[key] < bounds[key][0] || result[key] > bounds[key][1]) {
      throw new ApiBillingError('invalid_request')
    }
  }
  return result
}
function database() {
  if (!hasDb || !prisma) throw new ApiBillingError('unavailable')
  return prisma
}

/** Claim only persisted evidence. Each caller must request at most its free slots. */
export async function claimApiSettlements(options: ApiSettlementWorkerOptions = {}): Promise<ApiSettlementClaim[]> {
  const { batchSize, leaseMs } = apiSettlementWorkerOptions(options)
  const token = randomUUID()
  return database().$queryRaw<ApiSettlementClaim[]>`
    WITH candidates AS (
      SELECT "reservationId" FROM "ApiSettlementIntent"
      WHERE ("status" = 'pending' AND "nextAttemptAt" <= clock_timestamp())
         OR ("status" = 'processing' AND "leaseExpiresAt" <= clock_timestamp())
      ORDER BY CASE WHEN "status" = 'processing' THEN "leaseExpiresAt" ELSE "nextAttemptAt" END, "reservationId"
      LIMIT ${batchSize} FOR UPDATE SKIP LOCKED
    )
    UPDATE "ApiSettlementIntent" AS intent
    SET "status" = 'processing', "leaseToken" = ${token},
        "leaseExpiresAt" = clock_timestamp() + (${leaseMs} * interval '1 millisecond'),
        "attempts" = LEAST(intent."attempts" + 1, ${API_SETTLEMENT_MAX_ATTEMPTS + 1}), "updatedAt" = clock_timestamp()
    FROM candidates WHERE intent."reservationId" = candidates."reservationId"
    RETURNING intent."reservationId", intent."leaseToken"`
}

// Fixed labels only; driver/provider messages never enter the intent or summary.
function failureCode(error: unknown) {
  if (error instanceof ApiBillingError) {
    if (error.code === 'lease_lost') return 'API_LEASE_LOST'
    if (error.code === 'settlement_exhausted') return 'API_SETTLEMENT_EXHAUSTED'
    if (['conflict', 'invalid_amount', 'invalid_owner', 'invalid_request'].includes(error.code)) return 'API_SETTLEMENT_CONFLICT'
  }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'P2002' || code === 'P2003' || code === 'P2004') return 'API_SETTLEMENT_CONFLICT'
  return 'API_CAPTURE_RETRY'
}
export type ApiSettlementOutcome = 'succeeded' | 'retry' | 'conflict' | 'dead_letter' | 'lease_lost'

async function recordFailure(claim: ApiSettlementClaim, code: ReturnType<typeof failureCode>): Promise<ApiSettlementOutcome> {
  if (code === 'API_LEASE_LOST') return 'lease_lost'
  return database().$transaction(async tx => {
    // Same lock order as capture. Re-read after locking, so an ambiguous commit or
    // another worker's success can never be reset to pending/conflict/dead_letter.
    await tx.$queryRaw`SELECT "id" FROM "ApiReservation" WHERE "id" = ${claim.reservationId} FOR UPDATE`
    await tx.$queryRaw`SELECT "reservationId" FROM "ApiSettlementIntent" WHERE "reservationId" = ${claim.reservationId} FOR UPDATE`
    const intent = await tx.apiSettlementIntent.findUnique({ where: { reservationId: claim.reservationId }, include: { reservation: true } })
    if (intent && apiIntentMatchesCapture(intent.reservation, intent)) {
      const acknowledged = await tx.$executeRaw`UPDATE "ApiSettlementIntent" SET "status" = 'succeeded', "lastErrorCode" = NULL,
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
        WHERE "reservationId" = ${claim.reservationId} AND "status" = 'processing'
          AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
      return acknowledged === 1 ? 'succeeded' : 'lease_lost'
    }
    const rows = await tx.$queryRaw<{ status: string }[]>`
      UPDATE "ApiSettlementIntent"
      SET "status" = CASE
            WHEN ${code} = 'API_SETTLEMENT_CONFLICT' THEN 'conflict'::"ApiSettlementStatus"
            WHEN "attempts" >= ${API_SETTLEMENT_MAX_ATTEMPTS} THEN 'dead_letter'::"ApiSettlementStatus"
            ELSE 'pending'::"ApiSettlementStatus" END,
          "nextAttemptAt" = statement_timestamp() + (LEAST(300000, 1000 * power(2, LEAST("attempts" - 1, 9))) * interval '1 millisecond'),
          "lastErrorCode" = ${code}, "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = statement_timestamp()
      WHERE "reservationId" = ${claim.reservationId} AND "status" = 'processing'
        AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()
      RETURNING "status"`
    if (!rows.length) return 'lease_lost'
    return rows[0].status === 'pending' ? 'retry' : rows[0].status as 'conflict' | 'dead_letter'
  })
}

export async function recoverApiSettlement(claim: ApiSettlementClaim): Promise<ApiSettlementOutcome> {
  database()
  try { await captureApiSettlement(claim.reservationId, claim) }
  catch (error) { return recordFailure(claim, failureCode(error)) }
  // Separate acknowledgement: if unavailable, leave lease expiry to drive replay.
  const count = await database().$executeRaw`
    UPDATE "ApiSettlementIntent" SET "status" = 'succeeded', "lastErrorCode" = NULL,
      "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = clock_timestamp()
    WHERE "reservationId" = ${claim.reservationId} AND "status" = 'processing'
      AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
  return count === 1 ? 'succeeded' : 'lease_lost'
}

export interface ApiSettlementBatchResult {
  claimed: number; succeeded: number; retry: number; conflict: number; dead_letter: number
  lease_lost: number; unavailable: number; unprocessed: number; aborted: boolean
}
export function apiSettlementExitCode(result: ApiSettlementBatchResult): number {
  if (result.conflict || result.dead_letter) return 3
  return result.aborted || result.unprocessed || result.unavailable || result.retry || result.lease_lost ? 1 : 0
}
export async function runApiSettlementBatch(options: ApiSettlementWorkerOptions = {}, signal?: AbortSignal): Promise<ApiSettlementBatchResult> {
  const normalized = apiSettlementWorkerOptions(options)
  database()
  const summary: ApiSettlementBatchResult = { claimed: 0, succeeded: 0, retry: 0, conflict: 0, dead_letter: 0,
    lease_lost: 0, unavailable: 0, unprocessed: 0, aborted: false }
  // Claim only available concurrency slots. No locally queued leases burning time.
  while (!signal?.aborted && summary.claimed < normalized.batchSize) {
    const claims = await claimApiSettlements({ ...normalized,
      batchSize: Math.min(normalized.concurrency, normalized.batchSize - summary.claimed) })
    if (!claims.length) break
    summary.claimed += claims.length
    await Promise.all(claims.map(async claim => {
      if (signal?.aborted) return
      try { summary[await recoverApiSettlement(claim)]++ }
      catch { summary.unavailable++ }
    }))
  }
  summary.aborted = signal?.aborted ?? false
  summary.unprocessed = summary.claimed - summary.succeeded - summary.retry - summary.conflict -
    summary.dead_letter - summary.lease_lost - summary.unavailable
  return summary
}
