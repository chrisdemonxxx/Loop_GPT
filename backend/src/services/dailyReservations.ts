/**
 * Daily (not prepaid API) accounting. All mutations serialize on the user row.
 * A server UUID identifies one action; client request IDs never authorize replay.
 * reserved -> dispatched -> captured; reserved -> released; dispatched -> unknown.
 * Transport errors, cancellation after dispatch and crashes may have incurred cost:
 * retain those deductions. Never age-refund unknown/stale dispatched reservations.
 * Capture may be retried with the same metrics; uncertain work can be captured
 * after reconciliation. There is deliberately no automatic post-dispatch refund.
 */
import { createHash, randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma, hasDb } from './prisma'
import { CREDIT_COST, PLAN_LIMITS, type UsageKind } from './billing'
import { admitDailyReservationTx } from './spendBudgetPolicy'

const DAY_MS = 86_400_000
export class DailyCreditError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
function database() {
  if (!hasDb || !prisma) throw new DailyCreditError(503, 'DAILY_ACCOUNTING_UNAVAILABLE', 'Daily credit accounting unavailable')
  return prisma
}
async function lockedUser(tx: Prisma.TransactionClient, userId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`
  const user = await tx.user.findUnique({ where: { id: userId } })
  if (!user) throw new DailyCreditError(403, 'DAILY_ACCOUNT_NOT_FOUND', 'Credit account unavailable')
  return user
}
async function resetUser(tx: Prisma.TransactionClient, user: Awaited<ReturnType<typeof lockedUser>>) {
  // Read the clock AFTER acquiring the lock. A competing reset cannot replace a
  // newer window or deductions. The predicate also protects callers outside here.
  const now = new Date()
  if (now.getTime() - user.creditsResetAt.getTime() >= DAY_MS) {
    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.free
    await tx.user.updateMany({ where: { id: user.id, creditsResetAt: user.creditsResetAt },
      data: { ...limits, creditsResetAt: now } })
    return tx.user.findUniqueOrThrow({ where: { id: user.id } })
  }
  return user
}
export async function getDailyAccountUser(userId: string) {
  return database().$transaction(async tx => resetUser(tx, await lockedUser(tx, userId)))
}
export async function reserveDailyCredits(userId: string, kind: UsageKind, model = '') {
  if (!Object.prototype.hasOwnProperty.call(CREDIT_COST, kind)) throw new DailyCreditError(400, 'INVALID_DAILY_KIND', 'Invalid usage kind')
  return database().$transaction(tx => reserveDailyCreditsTx(tx, userId, kind, model))
}
export async function reserveDailyCreditsTx(tx: Prisma.TransactionClient, userId: string, kind: UsageKind, model = '') {
  if (!Object.prototype.hasOwnProperty.call(CREDIT_COST, kind)) throw new DailyCreditError(400, 'INVALID_DAILY_KIND', 'Invalid usage kind')
  // Spend budget admission is a policy-class lock: BEFORE the user-row ledger
  // lock, matching the documented policy -> ledger order. Callers that hold
  // ledger locks before calling here must not introduce a reverse path (see
  // spendBudgetPolicy.ts).
  const user = await resetUser(tx, await lockedUser(tx, userId))
  await admitDailyReservationTx(tx, userId, user.creditsResetAt)
  const bypass = user.role === 'admin' || user.unlimited
  // Preserve the daily image allowance contract: one image unit, not two chat credits.
  const credits = bypass || kind === 'image' ? 0 : CREDIT_COST[kind]
  const imageCredits = !bypass && kind === 'image' ? 1 : 0
  const debited = await tx.user.updateMany({ where: { id: userId, ...(bypass ? {} : { credits: { gte: credits }, imageCredits: { gte: imageCredits } }) },
    data: { credits: { decrement: credits }, imageCredits: { decrement: imageCredits } } })
  if (!debited.count) throw new DailyCreditError(402, 'OUT_OF_CREDITS', 'Out of daily credits')
  return tx.dailyReservation.create({ data: { id: randomUUID(), userId, kind, model, credits, imageCredits, bypass, windowStart: user.creditsResetAt } })
}

async function withDailyReservationTx<T>(tx: Prisma.TransactionClient, id: string, action: (tx: Prisma.TransactionClient, row: NonNullable<Awaited<ReturnType<Prisma.TransactionClient['dailyReservation']['findUnique']>>>) => Promise<T>) {
  const identity = await tx.dailyReservation.findUnique({ where: { id } })
  if (!identity) throw new DailyCreditError(409, 'DAILY_RESERVATION_NOT_FOUND', 'Daily reservation unavailable')
  // Same lock order for reserve, reset, capture and release; re-read after lock.
  await lockedUser(tx, identity.userId)
  const row = await tx.dailyReservation.findUniqueOrThrow({ where: { id } })
  return action(tx, row)
}
export async function markDailyDispatched(id: string, signal?: AbortSignal) {
  return database().$transaction(tx => markDailyDispatchedTx(tx, id, signal))
}
export async function markDailyDispatchedTx(tx: Prisma.TransactionClient, id: string, signal?: AbortSignal) {
  await withDailyReservationTx(tx, id, async (tx, row) => {
    const check = () => { if (signal?.aborted) throw new DailyCreditError(409, 'DAILY_CANCELLED', 'Request cancelled before dispatch') }
    check()
    if (row.state !== 'reserved') throw new DailyCreditError(409, 'DAILY_ALREADY_DISPATCHED', 'Daily reservation cannot be dispatched again')
    await tx.dailyReservation.update({ where: { id }, data: { state: 'dispatched' } })
    check()
  })
}
/** One callback per in-process run, shared by its model turns/provider attempts. */
export function dailyDispatch(id: string, signal?: AbortSignal) {
  let pending: Promise<void> | undefined
  return () => pending ??= markDailyDispatched(id, signal)
}
export interface DailyUsage { tokensIn?: number; tokensOut?: number; images?: number; model?: string }
function count(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw new DailyCreditError(400, 'INVALID_DAILY_USAGE', 'Invalid usage metrics')
  return value
}
export const DAILY_SETTLEMENT_MAX_ATTEMPTS = 10
export interface DailySettlementClaim { reservationId: string; leaseToken: string }
function intentFingerprint(id: string, userId: string, kind: string, model: string, tokensIn: number, tokensOut: number, images: number) {
  return createHash('sha256').update(JSON.stringify([1, id, userId, kind, model, tokensIn, tokensOut, images])).digest('hex')
}
function settlementFingerprint(tokensIn: number, tokensOut: number, images: number, model: string) {
  // Preserve the checkpoint03j representation for previously captured holds.
  return JSON.stringify({ tokensIn, tokensOut, images, model })
}
/** Commit validated evidence BEFORE any capture transaction. Exact retries are read-only. */
export async function enqueueDailySettlement(id: string, userId: string, kind: UsageKind, opts: DailyUsage = {}) {
  validateDailyUsage(id, userId, kind, opts)
  return database().$transaction(tx => enqueueDailySettlementTx(tx, id, userId, kind, opts))
}
function validateDailyUsage(id: string, userId: string, kind: UsageKind, opts: DailyUsage) {
  if (typeof id !== 'string' || !id || id.length > 256 || typeof userId !== 'string' || !userId || userId.length > 256 ||
      !Object.prototype.hasOwnProperty.call(CREDIT_COST, kind) ||
      (opts.model !== undefined && (typeof opts.model !== 'string' || opts.model.length > 1024))) {
    throw new DailyCreditError(400, 'INVALID_DAILY_USAGE', 'Invalid usage metrics')
  }
  return { tokensIn: count(opts.tokensIn), tokensOut: count(opts.tokensOut), images: count(opts.images) }
}
export async function enqueueDailySettlementTx(tx: Prisma.TransactionClient, id: string, userId: string, kind: UsageKind, opts: DailyUsage = {}) {
  const { tokensIn, tokensOut, images } = validateDailyUsage(id, userId, kind, opts)
  return withDailyReservationTx(tx, id, async (tx, row) => {
    if (row.userId !== userId || row.kind !== kind || (opts.model !== undefined && opts.model !== row.model) || images > (kind === 'image' ? 1 : 0)) {
      throw new DailyCreditError(409, 'DAILY_RESERVATION_MISMATCH', 'Usage does not match reservation')
    }
    if (row.model.length > 1024) throw new DailyCreditError(400, 'INVALID_DAILY_USAGE', 'Invalid usage metrics')
    const fingerprint = intentFingerprint(id, userId, kind, row.model, tokensIn, tokensOut, images)
    const existing = await tx.dailySettlementIntent.findUnique({ where: { reservationId: id } })
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new DailyCreditError(409, 'DAILY_INTENT_CONFLICT', 'Settlement intent does not match')
      return existing
    }
    const captured = row.state === 'captured' && row.settlementFingerprint === settlementFingerprint(tokensIn, tokensOut, images, row.model)
    if (!captured && !['dispatched', 'unknown'].includes(row.state)) {
      throw new DailyCreditError(409, 'DAILY_SETTLEMENT_CONFLICT', 'Daily reservation already settled or not dispatched')
    }
    return tx.dailySettlementIntent.create({ data: { reservationId: id, userId, kind, model: row.model,
      tokensIn, tokensOut, images, fingerprint, status: captured ? 'succeeded' : 'pending' } })
  })
}

/** Capture only persisted evidence. Lock order is always user -> intent.
 * Workers hold the intent lock through commit, so reclamation cannot overtake a
 * validated fence. An expired/replaced token cannot capture or acknowledge work.
 */
export async function captureDailySettlement(id: string, claim?: DailySettlementClaim) {
  return database().$transaction(tx => captureDailySettlementTx(tx, id, claim))
}
export async function captureDailySettlementTx(tx: Prisma.TransactionClient, id: string, claim?: DailySettlementClaim) {
  await withDailyReservationTx(tx, id, async (tx, row) => {
    await tx.$queryRaw`SELECT "reservationId" FROM "DailySettlementIntent" WHERE "reservationId" = ${id} FOR UPDATE`
    const intent = await tx.dailySettlementIntent.findUnique({ where: { reservationId: id } })
    if (!intent) throw new DailyCreditError(409, 'DAILY_INTENT_REQUIRED', 'Persisted settlement intent required')
    if (claim) {
      const valid = await tx.$queryRaw<{ reservationId: string }[]>`SELECT "reservationId" FROM "DailySettlementIntent"
        WHERE "reservationId" = ${claim.reservationId} AND "reservationId" = ${id} AND "status" = 'processing'
          AND "leaseToken" = ${claim.leaseToken} AND "leaseExpiresAt" > clock_timestamp()`
      if (!valid.length) throw new DailyCreditError(409, 'DAILY_LEASE_LOST', 'Settlement lease no longer owned')
    }
    const { userId, kind, model, tokensIn, tokensOut, images } = intent
    if (row.userId !== userId || row.kind !== kind || row.model !== model ||
        intent.fingerprint !== intentFingerprint(id, userId, kind, model, tokensIn, tokensOut, images)) {
      throw new DailyCreditError(409, 'DAILY_RESERVATION_MISMATCH', 'Usage does not match reservation')
    }
    const fingerprint = settlementFingerprint(tokensIn, tokensOut, images, model)
    const acknowledgeForeground = async () => {
      if (!claim && (intent.status === 'pending' || intent.status === 'processing')) {
        await tx.dailySettlementIntent.update({ where: { reservationId: id }, data: {
          status: 'succeeded', lastErrorCode: null, leaseToken: null, leaseExpiresAt: null,
        } })
      }
    }
    if (row.state === 'captured' && row.settlementFingerprint === fingerprint) {
      await acknowledgeForeground()
      return
    }
    if (intent.status === 'conflict' || intent.status === 'dead_letter' || intent.status === 'succeeded' ||
        !['dispatched', 'unknown'].includes(row.state)) {
      throw new DailyCreditError(409, 'DAILY_SETTLEMENT_CONFLICT', 'Daily reservation already settled or not dispatched')
    }
    if (claim && intent.attempts > DAILY_SETTLEMENT_MAX_ATTEMPTS) {
      throw new DailyCreditError(409, 'DAILY_SETTLEMENT_EXHAUSTED', 'Settlement retry limit reached')
    }
    await tx.user.update({ where: { id: userId }, data: {
      tokensInTotal: { increment: BigInt(tokensIn) }, tokensOutTotal: { increment: BigInt(tokensOut) },
      imagesTotal: { increment: images }, messagesTotal: { increment: kind === 'image' ? 0 : 1 }, lastActiveAt: new Date(),
    } })
    await tx.usageEvent.create({ data: { reservationId: id, userId, kind, tokensIn, tokensOut, credits: row.credits + row.imageCredits, model: row.model } })
    await tx.dailyReservation.update({ where: { id }, data: { state: 'captured', settlementFingerprint: fingerprint } })
    // Foreground success retires even a concurrent worker lease under the same
    // intent lock. That worker's later failure/ack cannot regress this success.
    // Workers acknowledge separately; capture-success/ack-failure is replayable.
    await acknowledgeForeground()
  })
}
export async function captureDailyReservation(id: string, userId: string, kind: UsageKind, opts: DailyUsage = {}) {
  await enqueueDailySettlement(id, userId, kind, opts)
  await captureDailySettlement(id)
}
/** Idempotent failure settlement. Refund only undispatched work in its own window. */
export async function finishDailyFailure(id: string) {
  return database().$transaction(tx => finishDailyFailureTx(tx, id))
}
export async function finishDailyFailureTx(tx: Prisma.TransactionClient, id: string) {
  await withDailyReservationTx(tx, id, async (tx, row) => {
    if (row.state === 'reserved') {
      await tx.user.updateMany({ where: { id: row.userId, creditsResetAt: row.windowStart },
        data: { credits: { increment: row.credits }, imageCredits: { increment: row.imageCredits } } })
      await tx.dailyReservation.update({ where: { id }, data: { state: 'released' } })
    } else if (row.state === 'dispatched') {
      await tx.dailyReservation.update({ where: { id }, data: { state: 'unknown' } })
    }
  })
}
/** Cleanup cannot undo dispatched work, even when settlement itself is unavailable. */
export async function cleanupDailyReservation(id: string | undefined) {
  if (id) await finishDailyFailure(id).catch(() => console.error('Daily reservation needs reconciliation:', id))
}
