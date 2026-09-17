import { Prisma } from '@prisma/client'
import { z } from 'zod'

/** Shared across ALL workers, API keys and billing pools. No environment override.
 * Lock order for every video transaction: policy -> AccountedVideoJob -> MediaJob
 * -> ledger (daily User -> reservation -> intent; prepaid reservation -> intent
 * -> User). Admission takes policy BEFORE any ledger lock; its job/reservation
 * inserts have fresh, transaction-private identities. Ledger-only recovery never
 * acquires policy/job locks. Never call these helpers while holding ledger locks.
 *
 * Counts are derived from durable rows, not process memory or counters that can
 * diverge on rollback. A live QUEUED lease earmarks dispatch capacity; expiration
 * only removes that unsubmitted earmark. upstreamSlot survives ALL lease changes.
 * DB administrators update singleton id=1, increment revision, and obey SQL
 * checks. Version is a schema contract (currently 1), revision an operator CAS.
 * Reducing limits below occupancy drains naturally; it never evicts work.
 */
export const videoQueuePolicySchema = z.object({
  id: z.literal(1), version: z.literal(1), revision: z.number().int().positive(),
  globalOutstanding: z.number().int().min(1).max(10000),
  userOutstanding: z.number().int().min(1).max(1000),
  globalActive: z.number().int().min(1).max(1000),
  userActive: z.number().int().min(1).max(100),
}).strict().refine(p => p.userOutstanding <= p.globalOutstanding && p.userActive <= p.globalActive &&
  p.globalActive <= p.globalOutstanding && p.userActive <= p.userOutstanding)
export type VideoQueuePolicy = z.infer<typeof videoQueuePolicySchema>
export class VideoQueueLimitError extends Error {
  constructor(public readonly code: 'video_user_limit' | 'video_global_limit' | 'video_queue_config') {
    super(code)
    this.name = 'VideoQueueLimitError'
  }
}
/** Fixed public projection: no counts, owners, SQL or configuration values. */
export function videoQueueLimitProjection(error: unknown) {
  if (!(error instanceof VideoQueueLimitError)) return null
  return { status: error.code === 'video_user_limit' ? 429 : 503, code: error.code,
    message: error.code === 'video_user_limit' ? 'Your video queue limit has been reached.' : 'Video queue temporarily unavailable.' }
}

export async function lockVideoQueue(tx: Prisma.TransactionClient) {
  // A real row write is intentional: at SERIALIZABLE a waiter must retry with a
  // fresh snapshot rather than count rows from before the previous lock holder.
  // Even malformed configuration can be locked so settlement can free capacity.
  const rows = await tx.$queryRaw<VideoQueuePolicy[]>`UPDATE "VideoQueuePolicy" SET "id" = "id" WHERE "id" = 1 RETURNING *`
  return rows[0]
}
export function requireVideoQueuePolicy(value: unknown): VideoQueuePolicy {
  const parsed = videoQueuePolicySchema.safeParse(value)
  if (!parsed.success) throw new VideoQueueLimitError('video_queue_config')
  return parsed.data
}

export async function admitVideoTx(tx: Prisma.TransactionClient, userId: string) {
  const policy = requireVideoQueuePolicy(await lockVideoQueue(tx))
  const [counts] = await tx.$queryRaw<{ global: bigint; user: bigint }[]>`SELECT count(*) AS global,
    count(*) FILTER (WHERE m."userId" = ${userId}) AS "user"
    FROM "AccountedVideoJob" v JOIN "MediaJob" m ON m.id = v."jobId"
    WHERE v."upstreamSlot" OR v.state NOT IN ('completed', 'cancelled')`
  if (counts.user >= BigInt(policy.userOutstanding)) throw new VideoQueueLimitError('video_user_limit')
  if (counts.global >= BigInt(policy.globalOutstanding)) throw new VideoQueueLimitError('video_global_limit')
}

/** Caller already owns policy/job locks. Atomic with ledger + dispatch markers. */
export async function acquireVideoSlotTx(tx: Prisma.TransactionClient, jobId: string, userId: string) {
  const policy = requireVideoQueuePolicy(await tx.videoQueuePolicy.findUnique({ where: { id: 1 } }))
  const [counts] = await tx.$queryRaw<{ global: bigint; user: bigint }[]>`SELECT count(*) AS global,
    count(*) FILTER (WHERE m."userId" = ${userId}) AS "user"
    FROM "AccountedVideoJob" v JOIN "MediaJob" m ON m.id = v."jobId" WHERE v."upstreamSlot"`
  if (counts.user >= BigInt(policy.userActive)) throw new VideoQueueLimitError('video_user_limit')
  if (counts.global >= BigInt(policy.globalActive)) throw new VideoQueueLimitError('video_global_limit')
  await tx.accountedVideoJob.update({ where: { jobId }, data: { upstreamSlot: true } })
}
