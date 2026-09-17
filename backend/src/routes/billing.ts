/**
 * Staging payment ingress: checkout and fulfillment fail closed. See the
 * separate opt-in flags and code readiness lock in services/stripe.ts.
 * The webhook is mounted with a raw parser before the app's JSON parser.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { prisma, hasDb } from '../services/prisma'
import { stripe, stripeEnabled, priceForPlan, priceForApiPlan, publicConfig, verifyPaymentIngress } from '../services/stripe'
import { API_PLANS, TOP_UP_OPTIONS } from '../services/apiBilling'

const router = express.Router()
const FRONTEND = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')

/** GET /api/billing/config — tells the frontend whether/what paid plans exist. */
router.get('/config', (_req, res) => res.json(publicConfig()))

/** POST /api/billing/checkout { plan } — start a Stripe Checkout session. */
router.post('/checkout', authenticateToken, asyncHandler(async (req, res) => {
  if (!stripeEnabled()) return res.status(503).json({ error: 'Payments are not enabled yet.' })
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Payments require a database.' })
  const userId = (req as any).userId
  const plan = String(req.body?.plan || 'pro')
  const price = priceForPlan(plan)
  if (!price) return res.status(400).json({ error: `No Stripe price configured for the ${plan} plan.` })

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return res.status(404).json({ error: 'User not found.' })

  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: userId,
      metadata: { userId, plan, kind: 'chat' },
      subscription_data: { metadata: { userId, plan, kind: 'chat' } },
      success_url: `${FRONTEND()}/account?upgraded=1`,
      cancel_url: `${FRONTEND()}/account?canceled=1`,
    })
    res.json({ url: session.url })
  } catch (e: any) {
    console.error('[stripe] checkout error:', e?.message)
    res.status(500).json({ error: 'Could not start checkout.' })
  }
}))

/**
 * POST /api/billing/api-checkout { plan } — subscribe to a developer API plan
 * (Developer / Growth / Scale). Separate product from the chat subscription.
 */
router.post('/api-checkout', authenticateToken, asyncHandler(async (req, res) => {
  if (!stripeEnabled()) return res.status(503).json({ error: 'Payments are not enabled yet.' })
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Payments require a database.' })
  const userId = (req as any).userId
  const plan = String(req.body?.plan || 'developer')
  if (!API_PLANS[plan]) return res.status(400).json({ error: `Unknown API plan "${plan}".` })
  const price = priceForApiPlan(plan)
  if (!price) return res.status(400).json({ error: `No Stripe price configured for the ${plan} API plan.` })

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return res.status(404).json({ error: 'User not found.' })

  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: userId,
      metadata: { userId, plan, kind: 'api_plan' },
      subscription_data: { metadata: { userId, plan, kind: 'api_plan' } },
      success_url: `${FRONTEND()}/developers?upgraded=1`,
      cancel_url: `${FRONTEND()}/developers?canceled=1`,
    })
    res.json({ url: session.url })
  } catch (e: any) {
    console.error('[stripe] api checkout error:', e?.message)
    res.status(500).json({ error: 'Could not start checkout.' })
  }
}))

/**
 * POST /api/billing/topup { amountUsd } — one-off prepaid API credit purchase.
 * Uses an ad-hoc price so no Stripe price IDs are needed.
 */
router.post('/topup', authenticateToken, asyncHandler(async (req, res) => {
  if (!stripeEnabled()) return res.status(503).json({ error: 'Payments are not enabled yet.' })
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Payments require a database.' })
  const userId = (req as any).userId
  const amountUsd = Number(req.body?.amountUsd)
  if (!TOP_UP_OPTIONS.includes(amountUsd)) {
    return res.status(400).json({ error: `Amount must be one of ${TOP_UP_OPTIONS.join(', ')} USD.` })
  }

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return res.status(404).json({ error: 'User not found.' })

  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(amountUsd * 100),
            product_data: {
              name: `LoopGPT API credit — $${amountUsd}`,
              description: 'Prepaid API credit. Never expires.',
            },
          },
        },
      ],
      customer_email: user.email,
      client_reference_id: userId,
      metadata: { userId, kind: 'api_topup', amountUsd: String(amountUsd) },
      success_url: `${FRONTEND()}/developers?topup=1`,
      cancel_url: `${FRONTEND()}/developers?canceled=1`,
    })
    res.json({ url: session.url })
  } catch (e: any) {
    console.error('[stripe] topup error:', e?.message)
    res.status(500).json({ error: 'Could not start checkout.' })
  }
}))

/** GET /api/billing/topup-options — the fixed top-up amounts we offer. */
router.get('/topup-options', (_req, res) => res.json({ options: TOP_UP_OPTIONS }))

/**
 * Raw-body webhook handler. Mounted in server.ts BEFORE express.json():
 *   app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook)
 * Contract: 400 for invalid payload/signature/mode/account; generic retryable
 * 503 for invalid configuration or verified-but-unfulfilled events. No 2xx,
 * no durable inbox claim, no payment/credit/plan mutation (including refunds).
 * Retry-After is advisory; operations must monitor retries and arrange replay
 * before Stripe's finite retention/retry window expires.
 */
export async function stripeWebhook(req: express.Request, res: express.Response) {
  const result = verifyPaymentIngress(req.body, req.headers['stripe-signature'])
  if (result.status === 'invalid') {
    return res.status(400).json({ error: 'Invalid payment webhook.' })
  }
  // Deliberately no fulfillment dispatch, even if both environment flags are
  // true. A future durable processor needs code review, not an operator toggle.
  return res.status(503).set('Retry-After', '60').json({ error: 'Payments are temporarily unavailable.' })
}

export default router
