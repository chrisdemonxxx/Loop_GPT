import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { DailyCreditError } from './dailyReservations'

/**
 * Spend budget policy: a shared singleton row (mirrors VideoQueuePolicy)
 * bounding how many daily reservations a user — and the platform globally —
 * may start per rolling day. Protects runaway agent loops even on bypassed
 * (unlimited/admin) accounts, where credits alone impose no ceiling.
 *
 * Lock order: spend budget policy is a POLICY-class lock and is always
 * acquired BEFORE any ledger lock (user row). No path may take it while
 * holding ledger locks, and no reverse path may take it after a ledger
 * lock that another budget-enforced path takes first. The API prepaid
 * spend cap (future) must refactor its composite callers to policy-first
 * in the same change that introduces it.
 *
 * DB administrators update singleton id=1, increment revision, and obey
 * SQL checks. Counts derive from durable rows. 0 disables a cap.
 */
export const spendBudgetPolicySchema = z.object({
  id: z.literal(1), version: z.literal(1), revision: z.number().int().positive(),
  // BIGINT columns: raw queries return BigInt (SQL CHECK bounds the values).
  perUserDailyReservationCap: z.bigint().min(0n).max(10_000_000n),
  globalDailyReservationCap: z.bigint().min(0n).max(10_000_000n),
}).strict()
export type SpendBudgetPolicy = z.infer<typeof spendBudgetPolicySchema>

export const SPEND_BUDGET_DISABLED = 0n

export async function lockSpendBudget(tx: Prisma.TransactionClient) {
  // A real row write is intentional (see VideoQueuePolicy): at SERIALIZABLE a
  // waiter retries with a fresh snapshot rather than counting stale rows.
  const rows = await tx.$queryRaw<SpendBudgetPolicy[]>`UPDATE "SpendBudgetPolicy" SET "id" = "id" WHERE "id" = 1 RETURNING *`
  return rows[0]
}

export function requireSpendBudgetPolicy(value: unknown): SpendBudgetPolicy {
  const parsed = spendBudgetPolicySchema.safeParse(value)
  if (!parsed.success) throw new DailyCreditError(503, 'SPEND_BUDGET_CONFIG', 'Daily credit accounting temporarily unavailable')
  return parsed.data
}

/** Count-based admission inside the caller's transaction, after the policy
 * lock and BEFORE the user-row ledger lock. perUser is exact per the user's
 * rolling window; global is an honest sliding-24h approximation across the
 * platform's staggered user windows. Never discloses other users' counts. */
export async function admitDailyReservationTx(tx: Prisma.TransactionClient, userId: string, windowStart: Date) {
  const policy = requireSpendBudgetPolicy(await lockSpendBudget(tx))
  const [counts] = await tx.$queryRaw<{ user: bigint; global: bigint }[]>`
    SELECT count(*) FILTER (WHERE r."userId" = ${userId} AND r."windowStart" = ${windowStart}) AS "user",
      count(*) FILTER (WHERE r."windowStart" >= ${new Date(Date.now() - 86_400_000)}) AS "global"
    FROM "DailyReservation" r`
  if (policy.perUserDailyReservationCap !== SPEND_BUDGET_DISABLED && counts.user >= policy.perUserDailyReservationCap) {
    throw new DailyCreditError(429, 'USER_DAILY_BUDGET_REACHED', 'Your daily request budget has been reached. Try again tomorrow or upgrade your plan.')
  }
  if (policy.globalDailyReservationCap !== SPEND_BUDGET_DISABLED && counts.global >= policy.globalDailyReservationCap) {
    throw new DailyCreditError(503, 'GLOBAL_DAILY_BUDGET_REACHED', 'Daily request capacity is temporarily at its platform budget. Please retry shortly.')
  }
}
