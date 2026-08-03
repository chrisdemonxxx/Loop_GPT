/**
 * Stripe billing — env-gated. Inert (all helpers report "not configured") until
 * STRIPE_SECRET_KEY is set, so the app runs fine without payments wired.
 *
 * Env:
 *   STRIPE_SECRET_KEY          sk_live_... / sk_test_...
 *   STRIPE_WEBHOOK_SECRET      whsec_... (for signature verification)
 *   STRIPE_PRICE_PRO           price_...  (recurring price for the Pro plan)
 *   STRIPE_PRICE_GOLD          price_...  (optional, T1 Gold plan)
 *   STRIPE_PUBLISHABLE_KEY     pk_...     (exposed to the frontend)
 */
import Stripe from 'stripe'

let client: Stripe | null = null

export function stripeEnabled(): boolean {
  return !!process.env.STRIPE_SECRET_KEY
}

export function stripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured (set STRIPE_SECRET_KEY).')
  if (!client) client = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2025-03-31.basil' as any })
  return client
}

/** Map a plan name to its configured Stripe price id. */
export function priceForPlan(plan: string): string | null {
  if (plan === 'pro') return process.env.STRIPE_PRICE_PRO || null
  if (plan === 'gold') return process.env.STRIPE_PRICE_GOLD || null
  return null
}

export function publicConfig() {
  return {
    enabled: stripeEnabled(),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    plans: {
      pro: !!process.env.STRIPE_PRICE_PRO,
      gold: !!process.env.STRIPE_PRICE_GOLD,
    },
  }
}
