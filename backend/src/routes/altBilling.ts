/**
 * Alternative Payment & Age-Assurance Integrations (Tier 2-6 & Tier 3-1):
 *   1. **Segpay** (`/api/billing/segpay/*`) — Adult Edition merchant billing
 *      checkout and signed postback fulfillment.
 *   2. **VerifyMy** (`/api/billing/age-verify/*`) — Adult Edition 18+ age-assurance
 *      session creation and signed webhook callback (`User.ageVerifiedAt`).
 *   3. **RevenueCat** (`/api/billing/revenuecat/webhook`) — Apple App Store &
 *      Google Play in-app purchase / subscription webhook feeding the unified
 *      workspace wallet and user plan.
 */
import crypto from 'crypto'
import express from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { prisma, hasDb } from '../services/prisma'
import { isAdultEdition } from '../services/edition'
import { addBalance, MICROS_PER_USD } from '../services/apiBilling'
import { grantSubscriptionCredits } from '../services/workspaceWallet'

const router = express.Router()
router.use(express.json({ limit: '256kb' }))

function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

// ---------------------------------------------------------------------------
// 1. VerifyMy Age Assurance (Adult Edition 18+ Gate)
// ---------------------------------------------------------------------------

/** GET /api/billing/age-verify/status — check whether the signed-in user is 18+ verified. */
router.get('/age-verify/status', authenticateToken, asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Database unavailable.' })
  const userId = (req as any).userId as string
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ageVerifiedAt: true, ageVerificationProvider: true },
  })
  return res.json({
    edition: isAdultEdition() ? 'adult' : 'mainstream',
    required: isAdultEdition(),
    verified: Boolean(user?.ageVerifiedAt),
    verifiedAt: user?.ageVerifiedAt ? user.ageVerifiedAt.toISOString() : null,
    provider: user?.ageVerificationProvider ?? null,
  })
}))

/** POST /api/billing/age-verify/start — create a VerifyMy age-assurance redirect URL. */
router.post('/age-verify/start', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string
  const baseUrl = process.env.VERIFYMY_BASE_URL || 'https://age.verifymy.io/v1/verify'
  const clientId = process.env.VERIFYMY_CLIENT_ID
  const secret = process.env.VERIFYMY_WEBHOOK_SECRET
  if (!clientId || !secret) {
    return res.status(503).json({ error: 'VerifyMy age verification is not configured on this deployment.' })
  }
  const state = `${userId}.${Date.now()}`
  const sig = crypto.createHmac('sha256', secret).update(state, 'utf8').digest('hex')
  const redirectUrl = `${baseUrl}?client_id=${encodeURIComponent(clientId)}&external_user_id=${encodeURIComponent(userId)}&state=${encodeURIComponent(`${state}.${sig}`)}`
  return res.json({ url: redirectUrl, provider: 'verifymy' })
}))

const verifyMyWebhookSchema = z.object({
  eventId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  verified: z.boolean(),
  method: z.string().max(120).optional(),
})

/** POST /api/billing/age-verify/webhook — HMAC-authenticated VerifyMy callback. */
router.post('/age-verify/webhook', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Database unavailable.' })
  const secret = process.env.VERIFYMY_WEBHOOK_SECRET
  if (!secret) return res.status(503).json({ error: 'VerifyMy webhook secret not configured.' })

  const headerSig = String(req.headers['x-verifymy-signature'] || '').trim()
  const rawPayload = JSON.stringify(req.body || {})
  const expectedSig = crypto.createHmac('sha256', secret).update(rawPayload, 'utf8').digest('hex')
  if (!headerSig || !timingSafeCompare(headerSig, expectedSig)) {
    return res.status(400).json({ error: 'Invalid VerifyMy signature.' })
  }

  const parsed = verifyMyWebhookSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ error: 'Invalid VerifyMy payload.' })

  if (parsed.data.verified) {
    await prisma.user.update({
      where: { id: parsed.data.userId },
      data: {
        ageVerifiedAt: new Date(),
        ageVerificationProvider: `verifymy:${parsed.data.method || 'age_estimation'}`,
      },
    })
  }
  return res.json({ received: true, verified: parsed.data.verified })
}))

// ---------------------------------------------------------------------------
// 2. Segpay Checkout & Postback (Adult Edition Billing)
// ---------------------------------------------------------------------------

/** POST /api/billing/segpay/checkout — generate a Segpay hosted payment page URL. */
router.post('/segpay/checkout', authenticateToken, asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Database unavailable.' })
  const userId = (req as any).userId as string
  const plan = String(req.body?.plan || 'pro')
  if (plan !== 'pro' && plan !== 'max') {
    return res.status(400).json({ error: 'Segpay checkout supports pro or max plans.' })
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, ageVerifiedAt: true },
  })
  if (!user) return res.status(404).json({ error: 'User not found.' })

  if (isAdultEdition() && !user.ageVerifiedAt) {
    return res.status(403).json({
      error: 'Age verification (18+) is required before purchasing on the Adult Edition.',
      code: 'age_verification_required',
    })
  }

  const packageId = plan === 'max' ? process.env.SEGPAY_PACKAGE_MAX : process.env.SEGPAY_PACKAGE_PRO
  const pricePointId = plan === 'max' ? process.env.SEGPAY_PRICE_MAX : process.env.SEGPAY_PRICE_PRO
  if (!packageId || !pricePointId) {
    return res.status(503).json({ error: `Segpay package/price not configured for ${plan}.` })
  }

  const base = process.env.SEGPAY_CHECKOUT_URL || 'https://secure2.segpay.com/billing/poset.cgi'
  const url = `${base}?x-eticketid=${encodeURIComponent(`${packageId}:${pricePointId}`)}&x-bill-email=${encodeURIComponent(user.email)}&merchantpartnerid=${encodeURIComponent(user.id)}&plan=${encodeURIComponent(plan)}`
  return res.json({ url, provider: 'segpay' })
}))

const segpayWebhookSchema = z.object({
  transactionId: z.string().min(1).max(256),
  userId: z.string().min(1).max(256),
  action: z.enum(['sale', 'rebill', 'cancel', 'refund', 'chargeback']),
  plan: z.enum(['pro', 'max']).optional(),
  amountUsd: z.number().min(0).max(10_000).optional(),
})

/** POST /api/billing/segpay/webhook — HMAC-authenticated Segpay postback handler. */
router.post('/segpay/webhook', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Database unavailable.' })
  const secret = process.env.SEGPAY_WEBHOOK_SECRET
  if (!secret) return res.status(503).json({ error: 'Segpay webhook secret not configured.' })

  const headerSig = String(req.headers['x-segpay-signature'] || '').trim()
  const rawPayload = JSON.stringify(req.body || {})
  const expectedSig = crypto.createHmac('sha256', secret).update(rawPayload, 'utf8').digest('hex')
  if (!headerSig || !timingSafeCompare(headerSig, expectedSig)) {
    return res.status(400).json({ error: 'Invalid Segpay signature.' })
  }

  const parsed = segpayWebhookSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ error: 'Invalid Segpay payload.' })

  const { userId, action, plan = 'pro' } = parsed.data
  if (action === 'sale' || action === 'rebill') {
    await prisma.user.update({
      where: { id: userId },
      data: { plan },
    })
    await grantSubscriptionCredits(userId, plan)
  } else if (action === 'cancel' || action === 'refund' || action === 'chargeback') {
    await prisma.user.update({
      where: { id: userId },
      data: { plan: 'free', subCreditsMicros: 0n, subCreditsExpireAt: null },
    })
  }
  return res.json({ received: true, action })
}))

// ---------------------------------------------------------------------------
// 3. RevenueCat IAP Webhook (iOS App Store & Google Play Billing — Tier 3-1)
// ---------------------------------------------------------------------------

const revenueCatSchema = z.object({
  event: z.object({
    id: z.string().min(1).max(256),
    type: z.enum([
      'INITIAL_PURCHASE',
      'RENEWAL',
      'NON_RENEWING_PURCHASE',
      'CANCELLATION',
      'EXPIRATION',
    ]),
    app_user_id: z.string().min(1).max(256),
    product_id: z.string().min(1).max(256),
    price: z.number().optional(),
    expiration_at_ms: z.number().optional(),
  }),
})

/** POST /api/billing/revenuecat/webhook — bearer-authenticated RevenueCat webhook. */
router.post('/revenuecat/webhook', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Database unavailable.' })
  const expectedAuth = process.env.REVENUECAT_WEBHOOK_AUTH
  if (!expectedAuth) return res.status(503).json({ error: 'RevenueCat webhook auth not configured.' })

  const authHeader = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!authHeader || !timingSafeCompare(authHeader, expectedAuth)) {
    return res.status(401).json({ error: 'Unauthorized RevenueCat webhook.' })
  }

  const parsed = revenueCatSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ error: 'Invalid RevenueCat event payload.' })

  const ev = parsed.data.event
  const userId = ev.app_user_id
  const productId = ev.product_id.toLowerCase()

  if (ev.type === 'INITIAL_PURCHASE' || ev.type === 'RENEWAL') {
    const plan = productId.includes('max') ? 'max' : 'pro'
    const expireAt = ev.expiration_at_ms
      ? new Date(ev.expiration_at_ms)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await prisma.user.update({ where: { id: userId }, data: { plan } })
    await grantSubscriptionCredits(userId, plan, expireAt)
  } else if (ev.type === 'NON_RENEWING_PURCHASE') {
    // Credit pack top-up via IAP (e.g. loop_credits_10, loop_credits_25, loop_credits_100)
    const usdMatch = productId.match(/(\d+)/)
    const usd = usdMatch ? Number(usdMatch[1]) : Math.max(0, Math.round(ev.price || 10))
    if (usd > 0) {
      await addBalance(userId, usd * MICROS_PER_USD, 'revenuecat', `rc:${ev.id}`)
    }
  } else if (ev.type === 'EXPIRATION') {
    await prisma.user.update({
      where: { id: userId },
      data: { plan: 'free', subCreditsMicros: 0n, subCreditsExpireAt: null },
    })
  }

  return res.json({ received: true, eventId: ev.id, type: ev.type })
}))

export default router
