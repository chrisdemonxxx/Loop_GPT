/**
 * Credit metering + voucher redemption for the freemium SaaS layer.
 *
 * All functions no-op / return permissive defaults when no database is
 * configured (in-memory / local dev), so the app keeps working without Postgres.
 * Admins and users flagged `unlimited` (e.g. via a team voucher) bypass limits.
 */
import { prisma, hasDb } from './prisma'
import { lowCreditEmail } from './email'

const LOW_CREDIT_THRESHOLD = 5

export type UsageKind = 'chat' | 'agent' | 'research' | 'image'

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
}

const DAY_MS = 24 * 60 * 60 * 1000

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
 * when there's no DB (caller should treat as unlimited/dev).
 */
export async function getAccount(userId: string): Promise<AccountView | null> {
  if (!hasDb || !prisma) return null
  let user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return null

  // Rolling daily reset.
  if (Date.now() - new Date(user.creditsResetAt).getTime() >= DAY_MS) {
    const lim = planLimits(user.plan)
    user = await prisma.user.update({
      where: { id: userId },
      data: { credits: lim.credits, imageCredits: lim.imageCredits, creditsResetAt: new Date() },
    })
  }

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
 * Permissive when there's no DB. Admin / unlimited always pass.
 */
export async function checkCredits(userId: string, kind: UsageKind): Promise<CreditCheck> {
  const acct = await getAccount(userId)
  if (!acct) return { ok: true, unlimited: true } // no DB → dev/unlimited
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
 * Record a completed action: deduct credits, bump lifetime counters, and write a
 * UsageEvent row. Safe to call after the run; no-op without a DB.
 */
export async function recordUsage(
  userId: string,
  kind: UsageKind,
  opts: { tokensIn?: number; tokensOut?: number; images?: number; model?: string } = {}
): Promise<void> {
  if (!hasDb || !prisma) return
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return

  const tokensIn = Math.max(0, Math.floor(opts.tokensIn || 0))
  const tokensOut = Math.max(0, Math.floor(opts.tokensOut || 0))
  const images = Math.max(0, Math.floor(opts.images || 0))
  const bypass = user.role === 'admin' || user.unlimited
  const cost = kind === 'image' ? 0 : CREDIT_COST[kind] || 1
  const imageCost = kind === 'image' ? images || 1 : 0

  const data: any = {
    tokensInTotal: { increment: BigInt(tokensIn) },
    tokensOutTotal: { increment: BigInt(tokensOut) },
    imagesTotal: { increment: images },
    messagesTotal: { increment: kind === 'image' ? 0 : 1 },
    lastActiveAt: new Date(),
  }
  if (!bypass) {
    if (cost) data.credits = { decrement: cost }
    if (imageCost) data.imageCredits = { decrement: imageCost }
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data }),
    prisma.usageEvent.create({
      data: { userId, kind, tokensIn, tokensOut, credits: bypass ? 0 : cost + imageCost, model: opts.model || null },
    }),
  ])

  // One-shot low-credit alert email the moment the user crosses the threshold.
  if (!bypass && cost) {
    const after = user.credits - cost
    if (user.credits > LOW_CREDIT_THRESHOLD && after <= LOW_CREDIT_THRESHOLD) {
      lowCreditEmail(user.email, user.name, Math.max(0, after)).catch(() => {})
    }
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

  if (!hasDb || !prisma) return { ok: false, error: 'Vouchers require a database.' }

  const voucher = await prisma.voucher.findUnique({ where: { code: clean } })
  if (!voucher || !voucher.active) return { ok: false, error: 'Invalid or inactive voucher.' }
  if (voucher.expiresAt && voucher.expiresAt.getTime() < Date.now()) return { ok: false, error: 'This voucher has expired.' }
  if (voucher.redemptionCount >= voucher.maxRedemptions) return { ok: false, error: 'This voucher has been fully redeemed.' }

  const already = await prisma.voucherRedemption.findUnique({
    where: { voucherId_userId: { voucherId: voucher.id, userId } },
  })
  if (already) return { ok: false, error: 'You have already redeemed this voucher.' }

  const userData: any = {}
  if (voucher.type === 'unlimited') userData.unlimited = true
  // Plan vouchers (e.g. T1 gold) upgrade the plan AND refill to that plan's daily
  // cap immediately, so team members start with the full (capped) allowance.
  if (voucher.plan) {
    userData.plan = voucher.plan
    const lim = planLimits(voucher.plan)
    userData.credits = lim.credits
    userData.imageCredits = lim.imageCredits
    userData.creditsResetAt = new Date()
  }
  // Explicit credit grants stack on top of any plan refill.
  if (voucher.credits) userData.credits = userData.credits ? userData.credits + voucher.credits : { increment: voucher.credits }
  if (voucher.imageCredits) userData.imageCredits = userData.imageCredits ? userData.imageCredits + voucher.imageCredits : { increment: voucher.imageCredits }

  try {
    await prisma.$transaction([
      prisma.voucherRedemption.create({ data: { voucherId: voucher.id, userId } }),
      prisma.voucher.update({ where: { id: voucher.id }, data: { redemptionCount: { increment: 1 } } }),
      ...(Object.keys(userData).length ? [prisma.user.update({ where: { id: userId }, data: userData })] : []),
    ])
  } catch (e: any) {
    return { ok: false, error: 'Could not redeem voucher (it may have just been used up).' }
  }

  return {
    ok: true,
    applied: {
      type: voucher.type,
      plan: voucher.plan || undefined,
      credits: voucher.credits || undefined,
      imageCredits: voucher.imageCredits || undefined,
      unlimited: voucher.type === 'unlimited' || undefined,
    },
  }
}
