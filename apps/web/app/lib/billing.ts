import { API_URL, authHeaders } from './api'

/** Start a Stripe Checkout session for a paid plan. The billing service owns
 *  the session; this client only posts the plan and follows the returned URL.
 *  A missing route (404/405/501) is a graceful "not available yet", not a crash. */
export async function startPlanCheckout(plan: string): Promise<{ url?: string; error?: string }> {
  let res: Response
  try {
    res = await fetch(`${API_URL}/api/billing/checkout`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ plan }),
    })
  } catch {
    return { error: 'Could not reach checkout. Try again in a moment.' }
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { error: 'Checkout is not available yet. You can redeem a voucher in Settings → Billing.' }
  }
  const body = await res.json().catch(() => ({} as { error?: string; url?: string; checkoutUrl?: string; sessionUrl?: string }))
  if (!res.ok) return { error: body.error || 'Could not start checkout.' }
  const url = body.url || body.checkoutUrl || body.sessionUrl
  if (!url || typeof url !== 'string') return { error: 'Checkout did not return a payment link.' }
  return { url }
}
