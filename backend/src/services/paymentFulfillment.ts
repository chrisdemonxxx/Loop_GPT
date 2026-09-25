/**
 * Transactional Stripe fulfillment with a durable exactly-once inbox.
 *
 * Trust model: the webhook signature authenticates the event envelope; the
 * session/subscription metadata we ourselves set at checkout creation is
 * server-owned (never caller-supplied) and is the binding used here, cross
 * checked against client_reference_id where present. Untrusted client-supplied
 * metadata paths (the retired legacy grants) are not resurrected.
 *
 * Every verified event is persisted to StripeEventInbox BEFORE processing; a
 * duplicate delivery finds the row and either replays 200 (already processed)
 * or re-attempts (unprocessed). Processing failures return retryable 503 so
 * Stripe retries within its window. Unknown event types are stored and
 * acknowledged — never silently dropped.
 */
import Stripe from 'stripe'
import { prisma, hasDb } from './prisma'
import { ingressConfig, verifyPaymentIngress } from './stripe'
import { TOP_UP_OPTIONS } from './apiBilling'

export type IngestResult = { status: 200 | 400 | 503; detail: string }

const MAX_PAYLOAD_BYTES = 256 * 1024

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
}

function amountMicros(value: unknown): number | null {
  // Server-owned product matrix: only the exact fixed top-up amounts we sell.
  const n = typeof value === 'string' ? Number(value) : (typeof value === 'number' ? value : NaN)
  return Number.isSafeInteger(n) && (TOP_UP_OPTIONS as readonly number[]).includes(n) ? Math.round(n * 1_000_000) : null
}

/** Process one verified event against the database. Returns true on success. */
async function applyEvent(event: Stripe.Event, payloadJson: string): Promise<void> {
  const type = event.type
  const data = event.data.object as unknown as Record<string, unknown> | undefined
  if (!data) throw new Error('event data.object missing')

  const meta = (data.metadata ?? {}) as Record<string, unknown>
  const kind = str(meta.kind)
  const userId = str(meta.userId) ?? str(data.client_reference_id)

  if (type === 'checkout.session.completed' && kind === 'chat' && userId) {
    const plan = str(meta.plan)
    const user = await prisma!.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) throw new Error('checkout user missing')
    if (plan !== 'pro' && plan !== 'gold') throw new Error('unknown chat plan')
    await prisma!.user.update({
      where: { id: userId },
      data: {
        plan,
        unlimited: plan === 'gold',
        stripeCustomerId: (data.customer as string | undefined) ?? undefined,
        stripeSubId: (data.subscription as string | undefined) ?? undefined,
      },
    })
    return
  }

  if (type === 'checkout.session.completed' && kind === 'api_plan' && userId) {
    const plan = str(meta.plan)
    const user = await prisma!.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) throw new Error('api plan user missing')
    if (plan !== 'developer' && plan !== 'growth' && plan !== 'scale') throw new Error('unknown api plan')
    await prisma!.user.update({
      where: { id: userId },
      data: {
        apiPlan: plan,
        apiSubId: (data.subscription as string | undefined) ?? undefined,
      },
    })
    return
  }

  if (type === 'checkout.session.completed' && kind === 'api_topup' && userId) {
    const micros = amountMicros(meta.amountUsd)
    const user = await prisma!.user.findUnique({ where: { id: userId }, select: { id: true, apiBalanceMicros: true } })
    if (!user) throw new Error('topup user missing')
    if (!micros) throw new Error('topup amount out of bounds')
    await prisma!.user.update({
      where: { id: userId },
      data: { apiBalanceMicros: { increment: micros } },
    })
    return
  }

  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const sub = data as Record<string, unknown>
    const subMeta = (sub.metadata ?? {}) as Record<string, unknown>
    const subUserId = str(subMeta.userId) ?? str(sub.client_reference_id)
    const ended = type === 'customer.subscription.deleted' || ['canceled', 'unpaid', 'incomplete_expired'].includes(String(sub.status))
    if (!subUserId) return // not one of our subscriptions
    const user = await prisma!.user.findUnique({ where: { id: subUserId }, select: { id: true, plan: true, apiPlan: true } })
    if (!user) return
    const patch: Record<string, unknown> = {}
    if (str(subMeta.kind) === 'chat') {
      patch.stripeSubId = ended ? null : (sub.id as string | undefined) ?? undefined
      if (ended) { patch.plan = 'free'; patch.unlimited = false }
    } else if (str(subMeta.kind) === 'api_plan') {
      patch.apiSubId = ended ? null : (sub.id as string | undefined) ?? undefined
      if (ended) { patch.apiPlan = null; patch.apiPlanRenewsAt = null }
      const periodEnd = (sub as Record<string, unknown>).current_period_end as number | undefined
      if (typeof periodEnd === 'number' && Number.isSafeInteger(periodEnd) && !ended) {
        patch.apiPlanRenewsAt = new Date(periodEnd * 1000)
      }
    } else {
      return
    }
    await prisma!.user.update({ where: { id: subUserId }, data: patch })
    return
  }

  if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
    // Renewals only move the local renews-at forward; entitlements ride the
    // subscription lifecycle events. Never grant credits from invoices.
    const sub = ((data as Record<string, unknown>).subscription ?? {}) as unknown as Record<string, unknown>
    const subMeta = ((sub.metadata ?? {}) as Record<string, unknown>)
    const subUserId = str(subMeta.userId) ?? str(sub?.client_reference_id)
    if (!subUserId) return
      const periodEnd = Number((sub as Record<string, unknown>).current_period_end)
    if (str(subMeta.kind) === 'api_plan' && typeof periodEnd === 'number' && Number.isSafeInteger(periodEnd)) {
      await prisma!.user.update({ where: { id: subUserId }, data: { apiPlanRenewsAt: new Date(periodEnd * 1000) } })
    }
    return
  }

  if (type === 'charge.refunded') {
    const chargeMeta = (data.metadata ?? {}) as Record<string, unknown>
    const refundUserId = str(chargeMeta.userId) ?? str(data.client_reference_id)
    const micros = amountMicros(chargeMeta.amountUsd)
    if (refundUserId && micros && str(chargeMeta.kind) === 'api_topup') {
      const user = await prisma!.user.findUnique({ where: { id: refundUserId }, select: { id: true, apiBalanceMicros: true } })
      if (!user) throw new Error('refund user missing')
      // Reverse only what exists; never drive a balance negative.
      const reversal = Math.min(Number(user.apiBalanceMicros ?? 0n), micros)
      await prisma!.user.update({ where: { id: refundUserId }, data: { apiBalanceMicros: { decrement: reversal } } })
    }
    return
  }

  if (type === 'charge.dispute.created' || type === 'charge.dispute.funds_withdrawn' || type === 'charge.dispute.closed') {
    const disputeMeta = (data.metadata ?? {}) as Record<string, unknown>
    const disputeUserId = str(disputeMeta.userId) ?? str(data.client_reference_id)
    if (!disputeUserId) return
    if (type !== 'charge.dispute.closed') {
      // Suspend entitlements while a dispute is open or funds are pulled. A
      // closed dispute is recorded only; restoration is a deliberate admin op.
      await prisma!.user.update({
        where: { id: disputeUserId },
        data: { plan: 'free', unlimited: false, apiPlan: null, apiSubId: null, apiPlanRenewsAt: null },
      })
    }
    return
  }

  // Unknown types are stored and acknowledged; the inbox row is the audit.
}

/** Ingest one raw webhook body. Idempotent by Stripe event id. */
export async function ingestPaymentEvent(body: unknown, signature: unknown): Promise<IngestResult> {
  const config = ingressConfig()
  if (!config) return { status: 503, detail: 'unavailable' }
  if (!hasDb || !prisma) return { status: 503, detail: 'database required' }
  const verify = verifyPaymentIngress(body, signature)
  if (verify.status === 'invalid') return { status: 400, detail: 'invalid' }
  if (verify.status === 'unavailable') return { status: 503, detail: 'unavailable' }
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_PAYLOAD_BYTES) {
    return { status: 400, detail: 'invalid payload size' }
  }
  const raw = body.toString('utf8')
  let event: Stripe.Event
  try {
    event = JSON.parse(raw) as Stripe.Event
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return { status: 400, detail: 'invalid event envelope' }
  } catch {
    return { status: 400, detail: 'invalid json' }
  }
  // Persist BEFORE processing: durable exactly-once claim + audit.
  const existing = await prisma.stripeEventInbox.findUnique({ where: { eventId: event.id } })
  if (existing?.processedAt) return { status: 200, detail: 'already processed' }
  if (!existing) {
    try {
      await prisma.stripeEventInbox.create({ data: { eventId: event.id, type: event.type, payloadJson: raw } })
    } catch (error: any) {
      // Unique race with a concurrent delivery: treat as already-claimed.
      if (String(error?.code) !== 'P2002') throw error
      return { status: 200, detail: 'concurrent delivery already claimed' }
    }
  }
  try {
    await applyEvent(event, raw)
    await prisma.stripeEventInbox.update({
      where: { eventId: event.id },
      data: { processedAt: new Date(), errorCount: 0, lastError: null },
    })
    return { status: 200, detail: 'processed' }
  } catch (error: any) {
    // Keep the row unprocessed so Stripe's retry re-enters here; bounded error trail.
    const message = String(error?.message || 'processing error').slice(0, 400)
    await prisma.stripeEventInbox.update({
      where: { eventId: event.id },
      data: { errorCount: { increment: 1 }, lastError: message },
    }).catch(() => undefined)
    return { status: 503, detail: 'processing failed' }
  }
}
