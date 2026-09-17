/**
 * Staging payment ingress only. Checkout and fulfillment are separate opt-ins,
 * both OFF by default. Neither flag can revive the retired fulfillment handler.
 *
 * Env:
 *   STRIPE_CHECKOUT_ENABLED    exact "true" to request checkout (default false)
 *   STRIPE_FULFILLMENT_ENABLED exact "true" to request fulfillment (default false)
 *     Unset/empty/"false" disable; other flag values invalidate configuration.
 *     Checkout also requires implemented, enabled fulfillment: never collect
 *     money when this deployment cannot safely fulfill it.
 *   STRIPE_SECRET_KEY          sk_live_... / sk_test_...
 *   STRIPE_WEBHOOK_SECRET      whsec_... (for signature verification)
 *   STRIPE_MODE                explicit "test" or "live", matching key and event
 *   STRIPE_WEBHOOK_ACCOUNT     "platform" (event.account must be absent), or the
 *                             exact acct_... for connected-account events
 *     Platform origin is trusted through the endpoint-specific signing secret;
 *     its owning account must be configured operationally, not inferred from
 *     metadata or a request header. No account/network lookup happens here.
 *   STRIPE_PRICE_PRO           price_...  (recurring price for the Pro plan)
 *   STRIPE_PRICE_GOLD          price_...  (optional, T1 Gold plan)
 *   STRIPE_PUBLISHABLE_KEY     pk_...     (exposed to the frontend)
 */
import Stripe from 'stripe'

let client: Stripe | null = null

// A code readiness lock, NOT an environment switch. Before changing this,
// implement a durable idempotent inbox + transactional validated fulfillment,
// server-owned customer/order/price bindings, renewal and refund reconciliation.
// The old metadata grants/reset-credits handler has been removed, not gated.
const FULFILLMENT_IMPLEMENTED = false

function validFlag(value: string | undefined): boolean {
  return value === undefined || value === '' || value === 'false' || value === 'true'
}

function ingressConfig() {
  const key = process.env.STRIPE_SECRET_KEY || ''
  const secret = process.env.STRIPE_WEBHOOK_SECRET || ''
  const mode = process.env.STRIPE_MODE
  const account = process.env.STRIPE_WEBHOOK_ACCOUNT
  if (mode !== 'test' && mode !== 'live') return null
  if (!new RegExp(`^sk_${mode}_[A-Za-z0-9]+$`).test(key)) return null
  if (!/^whsec_[A-Za-z0-9]+$/.test(secret)) return null
  if (account !== 'platform' && !/^acct_[A-Za-z0-9]+$/.test(account || '')) return null
  if (!validFlag(process.env.STRIPE_CHECKOUT_ENABLED) || !validFlag(process.env.STRIPE_FULFILLMENT_ENABLED)) return null
  return { secret, livemode: mode === 'live', account }
}

/** Effective gates, not just requested flags. They remain false in this release. */
export function paymentGates() {
  const configured = ingressConfig() !== null
  const fulfillmentEnabled = configured && process.env.STRIPE_FULFILLMENT_ENABLED === 'true' && FULFILLMENT_IMPLEMENTED
  const checkoutEnabled = configured && process.env.STRIPE_CHECKOUT_ENABLED === 'true' && fulfillmentEnabled
  return { checkoutEnabled, fulfillmentEnabled, fulfillmentImplemented: FULFILLMENT_IMPLEMENTED }
}

/** Compatibility helper: means checkout is operational, NOT that a key exists. */
export function stripeEnabled(): boolean {
  return paymentGates().checkoutEnabled
}

export function stripe(): Stripe {
  if (!stripeEnabled()) throw new Error('Payments are temporarily unavailable.')
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2025-03-31.basil' as any })
  return client
}

export type PaymentIngressResult = { status: 'unavailable' | 'invalid' | 'verified' }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Offline verification only; never returns financial instructions or touches DB.
 * unavailable => HTTP 503 (configuration); invalid => generic HTTP 400.
 * verified => authentic envelope/mode/account ONLY, NOT accepted/persisted/paid.
 * The route MUST return retryable 503 until durable fulfillment is implemented.
 */
export function verifyPaymentIngress(body: unknown, signature: unknown): PaymentIngressResult {
  const config = ingressConfig()
  if (!config) return { status: 'unavailable' }
  if (!Buffer.isBuffer(body) || body.length === 0 || typeof signature !== 'string' || !signature.trim()) {
    return { status: 'invalid' }
  }
  let event: unknown
  try {
    // Static SDK utility: HMAC + JSON parsing locally, no client/API calls.
    event = Stripe.webhooks.constructEvent(body, signature, config.secret, 300)
  } catch {
    return { status: 'invalid' }
  }
  if (!record(event) || event.object !== 'event' || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id)
    || typeof event.type !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(event.type)
    || typeof event.created !== 'number' || !Number.isSafeInteger(event.created) || event.created < 0
    || !record(event.data) || !record(event.data.object) || event.livemode !== config.livemode) {
    return { status: 'invalid' }
  }
  // Thin/organization contexts are unsupported. Never trust Stripe-Account or
  // user metadata as an alternative to the signed event's account binding.
  if (event.context !== undefined || (config.account === 'platform' ? event.account !== undefined : event.account !== config.account)) {
    return { status: 'invalid' }
  }
  return { status: 'verified' }
}

/** Map a plan name to its configured Stripe price id. */
export function priceForPlan(plan: string): string | null {
  if (plan === 'pro') return process.env.STRIPE_PRICE_PRO || null
  if (plan === 'gold') return process.env.STRIPE_PRICE_GOLD || null
  return null
}

/** Map a developer-API plan id to its configured Stripe price id. */
export function priceForApiPlan(plan: string): string | null {
  if (plan === 'developer') return process.env.STRIPE_PRICE_API_DEVELOPER || null
  if (plan === 'growth') return process.env.STRIPE_PRICE_API_GROWTH || null
  if (plan === 'scale') return process.env.STRIPE_PRICE_API_SCALE || null
  return null
}

export function publicConfig() {
  const gates = paymentGates()
  const enabled = gates.checkoutEnabled
  return {
    enabled,
    ...gates,
    publishableKey: enabled ? process.env.STRIPE_PUBLISHABLE_KEY || null : null,
    plans: {
      pro: enabled && !!process.env.STRIPE_PRICE_PRO,
      gold: enabled && !!process.env.STRIPE_PRICE_GOLD,
    },
    apiPlans: {
      developer: enabled && !!process.env.STRIPE_PRICE_API_DEVELOPER,
      growth: enabled && !!process.env.STRIPE_PRICE_API_GROWTH,
      scale: enabled && !!process.env.STRIPE_PRICE_API_SCALE,
    },
    topUps: enabled,
  }
}
