/**
 * Credit metering + voucher redemption for the freemium SaaS layer.
 *
 * Daily accounting fails closed and reserves before dispatch. Explicit admin /
 * unlimited exemptions are persisted in the reservation audit trail.
 */
import { prisma, hasDb } from './prisma'
import { enqueueDailySettlement, captureDailySettlement, DailyCreditError, getDailyAccountUser } from './dailyReservations'

export type UsageKind = 'chat' | 'agent' | 'research' | 'image' | 'video'

/**
 * Daily allowances per plan (rolling 24h reset per user).
 *  - free:  entry tier
 *  - pro:   paid individual
 *  - gold:  T1 team members — MAX usage vs free, but still capped (not unlimited)
 * True unlimited is a separate per-user flag (`unlimited`), reserved for admins /
 * special internal accounts, never a normal team tier.
 */
export const PLAN_LIMITS: Record<string, { credits: number; imageCredits: number }> = {
  free: { credits: 30, imageCredits: 5 },
  pro: { credits: 1000, imageCredits: 100 },
  gold: { credits: 5000, imageCredits: 500 },
}

/** Credits charged per action kind. */
export const CREDIT_COST: Record<UsageKind, number> = {
  chat: 1,
  agent: 1,
  research: 3,
  image: 2,
  video: 10,
}

function planLimits(plan: string) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.free
}

/** Estimate token count from text (≈4 chars/token) when the model gives none. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

export interface AccountView {
  id: string
  email: string
  name: string
  role: string
  plan: string
  unlimited: boolean
  credits: number
  imageCredits: number
  creditsResetAt: string
  limits: { credits: number; imageCredits: number }
  usage: { tokensIn: number; tokensOut: number; images: number; messages: number }
  hasDb: boolean
}

/**
 * Load the user, resetting daily credits if the 24h window elapsed. Returns null
 * when there's no DB. This is an account view, never permission to dispatch.
 */
export async function getAccount(userId: string): Promise<AccountView | null> {
  if (!hasDb || !prisma) return null
  const user = await getDailyAccountUser(userId)

  const lim = planLimits(user.plan)
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    unlimited: user.unlimited,
    credits: user.credits,
    imageCredits: user.imageCredits,
    creditsResetAt: user.creditsResetAt.toISOString(),
    limits: lim,
    usage: {
      tokensIn: Number(user.tokensInTotal),
      tokensOut: Number(user.tokensOutTotal),
      images: user.imagesTotal,
      messages: user.messagesTotal,
    },
    hasDb: true,
  }
}

export interface CreditCheck {
  ok: boolean
  reason?: string
  credits?: number
  imageCredits?: number
  unlimited?: boolean
}

/**
 * Check (without deducting) whether the user can afford an action of `kind`.
 * Informational only: callers must reserveDailyCredits before dispatch.
 */
export async function checkCredits(userId: string, kind: UsageKind): Promise<CreditCheck> {
  const acct = await getAccount(userId)
  if (!acct) throw new DailyCreditError(503, 'DAILY_ACCOUNTING_UNAVAILABLE', 'Daily credit accounting unavailable')
  if (acct.role === 'admin' || acct.unlimited) return { ok: true, unlimited: true }
  if (kind === 'image') {
    if (acct.imageCredits <= 0) {
      return { ok: false, reason: 'Out of image credits for today. Upgrade or redeem a voucher.', imageCredits: 0 }
    }
    return { ok: true, imageCredits: acct.imageCredits }
  }
  const cost = CREDIT_COST[kind] || 1
  if (acct.credits < cost) {
    return { ok: false, reason: 'Out of message credits for today. Upgrade or redeem a voucher.', credits: acct.credits }
  }
  return { ok: true, credits: acct.credits }
}

/**
 * Capture an existing reservation once. Deduction already happened at reserve.
 * The persisted server ID is mandatory; missing IDs cannot create free usage.
 */
export async function recordUsage(
  userId: string,
  kind: UsageKind,
  opts: { reservationId?: string; tokensIn?: number; tokensOut?: number; images?: number; model?: string } = {}
): Promise<void> {
  if (!opts.reservationId) throw new DailyCreditError(409, 'DAILY_RESERVATION_REQUIRED', 'Usage requires a daily reservation')
  try {
    await enqueueDailySettlement(opts.reservationId, userId, kind, opts)
    // A queued intent is not successful billing: callers still observe capture
    // failures, while the independent worker can recover the committed metrics.
    await captureDailySettlement(opts.reservationId)
  } catch (error) {
    if (error instanceof DailyCreditError) throw error
    throw new DailyCreditError(503, 'DAILY_ACCOUNTING_UNAVAILABLE', 'Daily credit accounting unavailable')
  }
}

export interface RedeemResult {
  ok: boolean
  error?: string
  applied?: { type: string; plan?: string; credits?: number; imageCredits?: number; unlimited?: boolean }
}

/** Redeem a voucher code for a user. Atomic against concurrent redemptions. */
export async function redeemVoucher(userId: string, code: string): Promise<RedeemResult> {
  const clean = String(code || '').trim().toUpperCase()
  if (!clean) return { ok: false, error: 'Voucher code is required.' }
  if (!hasDb || !prisma) return { ok: false, error: 'Vouchers require a database.' }

  // Env-var team invite code: set ADMIN_INVITE_CODE in your deployment to give
  // any team member unlimited access without a per-code database voucher.
  const teamCode = process.env.ADMIN_INVITE_CODE?.trim().toUpperCase()
  if (teamCode && clean === teamCode) {
    if (hasDb && prisma) {
      await prisma.user.update({
        where: { id: userId },
        data: { unlimited: true, plan: 'pro', credits: 999999, imageCredits: 999999 },
      })
    }
    return { ok: true, applied: { type: 'unlimited', unlimited: true, plan: 'pro' } }
  }

  // Capacity checks, the unique redemption, and the grant must share one
  // serializable transaction. Retry serialization conflicts with fresh reads.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async (tx): Promise<RedeemResult> => {
        const voucher = await tx.voucher.findUnique({ where: { code: clean } })
        if (!voucher || !voucher.active) return { ok: false, error: 'Invalid or inactive voucher.' }
        const now = new Date()
        if (voucher.expiresAt && voucher.expiresAt <= now) return { ok: false, error: 'This voucher has expired.' }
        if (voucher.redemptionCount >= voucher.maxRedemptions) return { ok: false, error: 'This voucher has been fully redeemed.' }
        const already = await tx.voucherRedemption.findUnique({
          where: { voucherId_userId: { voucherId: voucher.id, userId } },
        })
        if (already) return { ok: false, error: 'You have already redeemed this voucher.' }

        const userData: any = {}
        if (voucher.type === 'unlimited') userData.unlimited = true
        if (voucher.plan) {
          userData.plan = voucher.plan
          const lim = planLimits(voucher.plan)
          userData.credits = lim.credits
          userData.imageCredits = lim.imageCredits
          userData.creditsResetAt = now
        }
        if (voucher.credits) userData.credits = typeof userData.credits === 'number' ? userData.credits + voucher.credits : { increment: voucher.credits }
        if (voucher.imageCredits) userData.imageCredits = typeof userData.imageCredits === 'number' ? userData.imageCredits + voucher.imageCredits : { increment: voucher.imageCredits }

        const claimed = await tx.voucher.updateMany({
          where: { id: voucher.id, active: true, redemptionCount: { lt: voucher.maxRedemptions },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          data: { redemptionCount: { increment: 1 } },
        })
        if (claimed.count !== 1) return { ok: false, error: 'This voucher is no longer available.' }
        await tx.voucherRedemption.create({ data: { voucherId: voucher.id, userId } })
        if (Object.keys(userData).length) await tx.user.update({ where: { id: userId }, data: userData })
        return {
          ok: true,
          applied: {
            type: voucher.type, plan: voucher.plan || undefined,
            credits: voucher.credits || undefined, imageCredits: voucher.imageCredits || undefined,
            unlimited: voucher.type === 'unlimited' || undefined,
          },
        }
      }, { isolationLevel: 'Serializable' })
    } catch (error: any) {
      if (error?.code === 'P2034' && attempt < 2) continue
      if (error?.code === 'P2002') return { ok: false, error: 'You have already redeemed this voucher.' }
      return { ok: false, error: 'Could not redeem voucher. Please try again.' }
    }
  }
  return { ok: false, error: 'Could not redeem voucher. Please try again.' }
}
