/**
 * Payments: Stripe Checkout + webhook. Env-gated — endpoints return 503 when
 * Stripe isn't configured. The webhook handler is exported and mounted on the
 * app with a raw body parser (signature verification needs the raw payload).
 */
import express from 'express'
import { authenticateToken } from './auth'
import { prisma, hasDb } from '../services/prisma'
import { stripe, stripeEnabled, priceForPlan, publicConfig } from '../services/stripe'
import { PLAN_LIMITS } from '../services/billing'
import { alertEmail } from '../services/email'

const router = express.Router()
const FRONTEND = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')

/** GET /api/billing/config — tells the frontend whether/what paid plans exist. */
router.get('/config', (_req, res) => res.json(publicConfig()))

/** POST /api/billing/checkout { plan } — start a Stripe Checkout session. */
router.post('/checkout', authenticateToken, async (req, res) => {
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
      metadata: { userId, plan },
      subscription_data: { metadata: { userId, plan } },
      success_url: `${FRONTEND()}/account?upgraded=1`,
      cancel_url: `${FRONTEND()}/account?canceled=1`,
    })
    res.json({ url: session.url })
  } catch (e: any) {
    console.error('[stripe] checkout error:', e?.message)
    res.status(500).json({ error: 'Could not start checkout.' })
  }
})

/**
 * Raw-body webhook handler. Mounted in server.ts BEFORE express.json():
 *   app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook)
 */
export async function stripeWebhook(req: express.Request, res: express.Response) {
  if (!stripeEnabled()) return res.status(503).end()
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  const sig = req.headers['stripe-signature'] as string
  let event: any
  try {
    event = secret
      ? stripe().webhooks.constructEvent(req.body, sig, secret)
      : JSON.parse(req.body.toString('utf8')) // dev without a signing secret
  } catch (e: any) {
    console.error('[stripe] webhook signature error:', e?.message)
    return res.status(400).send(`Webhook Error: ${e?.message}`)
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.paid') {
      // --- Upgrade / payment ---
      const obj = event.data.object
      const userId = obj.metadata?.userId || obj.client_reference_id || obj.subscription_details?.metadata?.userId
      const plan = obj.metadata?.plan || 'pro'
      const amount = obj.amount_total ?? obj.amount_paid ?? 0
      const currency = obj.currency || 'usd'

      if (userId && hasDb && prisma) {
        const lim = PLAN_LIMITS[plan] || PLAN_LIMITS.pro
        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data: {
              plan,
              credits: lim.credits,
              imageCredits: lim.imageCredits,
              creditsResetAt: new Date(),
              stripeCustomerId: (obj.customer as string) || undefined,
              stripeSubId: (obj.subscription as string) || undefined,
            },
          }),
          prisma.payment.create({
            data: { userId, amount: Math.floor(amount), currency, status: 'succeeded', provider: 'stripe', reference: obj.id, note: `${plan} plan` },
          }),
        ])
        const support = process.env.SUPPORT_EMAIL
        if (support) alertEmail(support, `💰 New ${plan} payment`, `User ${userId} paid ${(amount / 100).toFixed(2)} ${currency.toUpperCase()}.`).catch(() => {})
      }
    } else if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      // --- Cancel / downgrade: when a sub ends or lapses, revert to free ---
      const sub = event.data.object
      const status = sub.status // active | past_due | canceled | unpaid | ...
      const ended = event.type === 'customer.subscription.deleted' || ['canceled', 'unpaid', 'incomplete_expired'].includes(status)
      if (ended && hasDb && prisma) {
        const userId = sub.metadata?.userId
        const free = PLAN_LIMITS.free
        const user = userId
          ? await prisma.user.findUnique({ where: { id: userId } })
          : await prisma.user.findFirst({ where: { stripeSubId: sub.id } })
        if (user && user.plan !== 'free') {
          await prisma.user.update({
            where: { id: user.id },
            data: { plan: 'free', credits: Math.min(user.credits, free.credits), imageCredits: Math.min(user.imageCredits, free.imageCredits), stripeSubId: null },
          })
          alertEmail(user.email, 'Your subscription ended', 'Your plan has reverted to Free. Resubscribe any time from your account to restore full access.').catch(() => {})
        }
      }
    }
  } catch (e: any) {
    console.error('[stripe] webhook handling error:', e?.message)
  }
  res.json({ received: true })
}

export default router
