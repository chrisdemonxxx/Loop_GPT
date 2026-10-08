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
 * or re-attempts (unprocessed). The credit (or other mutation) and the
 * processedAt stamp commit in one transaction, claimed with a compare-and-set
 * on processedAt IS NULL, so two deliveries cannot both apply. Processing
 * failures roll that claim back and return retryable 503 so Stripe retries
 * within its window. Unknown event types are stored and acknowledged — never
 * silently dropped.
 */
import Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { prisma, hasDb } from './prisma'
import { ingressConfig, paymentGates, verifyPaymentIngress } from './stripe'
import { TOP_UP_OPTIONS } from './apiBilling'

export type IngestResult = { status: 200 | 400 | 503; detail: string }

const MAX_PAYLOAD_BYTES = 256 * 1024

type Tx = Prisma.TransactionClient

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null
}

function amountMicros(value: unknown): number | null {
  // Server-owned product matrix: only the exact fixed top-up amounts we sell.
  const n = typeof value === 'string' ? Number(value) : (typeof value === 'number' ? value : NaN)
  return Number.isSafeInteger(n) && (TOP_UP_OPTIONS as readonly number[]).includes(n) ? Math.round(n * 1_000_000) : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Invoice renewals often carry the subscription as an id string, not an object. */
function invoiceRenewal(data: Record<string, unknown>): {
  subscriptionId: string | null
  metadata: Record<string, unknown>
  periodEnd: number | null
} {
  const metadata: Record<string, unknown> = {}
  let subscriptionId: string | null = null
  let periodEnd: number | null = null

  const assignMeta = (value: unknown) => {
    const meta = asRecord(value)
    if (meta) Object.assign(metadata, meta)
  }
  const takeSub = (value: unknown) => {
    if (!subscriptionId) subscriptionId = str(value)
  }
  const takePeriodEnd = (value: unknown) => {
    if (periodEnd == null && typeof value === 'number' && Number.isSafeInteger(value)) periodEnd = value
  }

  const sub = data.subscription
  if (typeof sub === 'string') takeSub(sub)
  else {
    const obj = asRecord(sub)
    if (obj) {
      takeSub(obj.id)
      assignMeta(obj.metadata)
      takePeriodEnd(obj.current_period_end)
    }
  }

  for (const details of [asRecord(asRecord(data.parent)?.subscription_details), asRecord(data.subscription_details)]) {
    if (!details) continue
    takeSub(details.subscription)
    assignMeta(details.metadata)
  }

  const lines = asRecord(data.lines)
  const rows = Array.isArray(lines?.data) ? lines.data : []
  for (const row of rows) {
    takePeriodEnd(asRecord(asRecord(row)?.period)?.end)
  }
  return { subscriptionId, metadata, periodEnd }
}

/** Charge metadata (copied from payment_intent_data) wins when the event object has none. */
async function reversalMetadata(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const direct = asRecord(data.metadata) ?? {}
  if (str(direct.userId)) return direct
  const charge = data.charge
  const expanded = asRecord(charge)
  if (expanded) {
    const meta = asRecord(expanded.metadata) ?? {}
    if (str(meta.userId)) return meta
  }
  const chargeId = typeof charge === 'string' ? charge : null
  const key = process.env.STRIPE_SECRET_KEY
  if (!chargeId || !key) return direct
  try {
    const client = new Stripe(key, { apiVersion: '2025-03-31.basil' as any })
    const loaded = await client.charges.retrieve(chargeId)
    return asRecord(loaded.metadata) ?? direct
  } catch {
    return direct
  }
}

/** Process one verified event against the caller's transaction. */
async function applyEvent(tx: Tx, event: Stripe.Event): Promise<void> {
  const type = event.type
  const data = event.data.object as unknown as Record<string, unknown> | undefined
  if (!data) throw new Error('event data.object missing')

  const meta = asRecord(data.metadata) ?? {}
  const kind = str(meta.kind)
  const userId = str(meta.userId) ?? str(data.client_reference_id)
  const paidCheckout = (type === 'checkout.session.completed' && data.payment_status === 'paid')
    || type === 'checkout.session.async_payment_succeeded'

  if (paidCheckout && kind === 'chat' && userId) {
    const plan = str(meta.plan)
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) throw new Error('checkout user missing')
    if (plan !== 'pro' && plan !== 'gold') throw new Error('unknown chat plan')
    await tx.user.update({
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

  if (paidCheckout && kind === 'api_plan' && userId) {
    const plan = str(meta.plan)
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!user) throw new Error('api plan user missing')
    if (plan !== 'developer' && plan !== 'growth' && plan !== 'scale') throw new Error('unknown api plan')
    await tx.user.update({
      where: { id: userId },
      data: {
        apiPlan: plan,
        apiSubId: (data.subscription as string | undefined) ?? undefined,
      },
    })
    return
  }

  if (paidCheckout && kind === 'api_topup' && userId) {
    const micros = amountMicros(meta.amountUsd)
    const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, apiBalanceMicros: true } })
    if (!user) throw new Error('topup user missing')
    if (!micros) throw new Error('topup amount out of bounds')
    await tx.user.update({
      where: { id: userId },
      data: { apiBalanceMicros: { increment: micros } },
    })
    return
  }

  if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const sub = data
    const subMeta = asRecord(sub.metadata) ?? {}
    const subUserId = str(subMeta.userId) ?? str(sub.client_reference_id)
    const subId = str(sub.id)
    const ended = type === 'customer.subscription.deleted' || ['canceled', 'unpaid', 'incomplete_expired'].includes(String(sub.status))
    if (!subUserId) return // not one of our subscriptions
    const user = await tx.user.findUnique({
      where: { id: subUserId },
      select: { id: true, plan: true, apiPlan: true, stripeSubId: true, apiSubId: true },
    })
    if (!user) return
    const subKind = str(subMeta.kind)
    const patch: Record<string, unknown> = {}
    if (subKind === 'chat') {
      // An old subscription.deleted must not downgrade a user who already
      // re-subscribed onto a different sub id.
      if (ended && type === 'customer.subscription.deleted' && user.stripeSubId && subId && user.stripeSubId !== subId) return
      patch.stripeSubId = ended ? null : subId ?? undefined
      if (ended) { patch.plan = 'free'; patch.unlimited = false }
    } else if (subKind === 'api_plan') {
      if (ended && type === 'customer.subscription.deleted' && user.apiSubId && subId && user.apiSubId !== subId) return
      patch.apiSubId = ended ? null : subId ?? undefined
      if (ended) { patch.apiPlan = null; patch.apiPlanRenewsAt = null }
      const periodEnd = sub.current_period_end
      if (typeof periodEnd === 'number' && Number.isSafeInteger(periodEnd) && !ended) {
        patch.apiPlanRenewsAt = new Date(periodEnd * 1000)
      }
    } else {
      return
    }
    await tx.user.update({ where: { id: subUserId }, data: patch })
    return
  }

  if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
    // Renewals only move the local renews-at forward; entitlements ride the
    // subscription lifecycle events. Never grant credits from invoices.
    // The subscription field is an id string on webhook payloads (the old
    // object-only read never matched, so this branch was dead).
    const info = invoiceRenewal(data)
    let renewUserId = str(info.metadata.userId)
    let renewKind = str(info.metadata.kind)
    if (info.subscriptionId && (!renewUserId || renewKind !== 'api_plan')) {
      const owner = await tx.user.findFirst({
        where: { OR: [{ apiSubId: info.subscriptionId }, { stripeSubId: info.subscriptionId }] },
        select: { id: true, apiSubId: true, stripeSubId: true },
      })
      if (owner) {
        if (!renewUserId) renewUserId = owner.id
        if (!renewKind) renewKind = owner.apiSubId === info.subscriptionId ? 'api_plan' : 'chat'
      }
    }
    if (renewUserId && renewKind === 'api_plan' && info.periodEnd != null) {
      await tx.user.update({
        where: { id: renewUserId },
        data: { apiPlanRenewsAt: new Date(info.periodEnd * 1000) },
      })
    }
    return
  }

  if (type === 'charge.refunded') {
    const chargeMeta = await reversalMetadata(data)
    const refundUserId = str(chargeMeta.userId) ?? str(data.client_reference_id)
    const micros = amountMicros(chargeMeta.amountUsd)
    if (refundUserId && micros && str(chargeMeta.kind) === 'api_topup') {
      const user = await tx.user.findUnique({ where: { id: refundUserId }, select: { id: true, apiBalanceMicros: true } })
      if (!user) throw new Error('refund user missing')
      // Reverse only what exists; never drive a balance negative.
      const reversal = Math.min(Number(user.apiBalanceMicros ?? 0n), micros)
      if (reversal > 0) {
        await tx.user.update({ where: { id: refundUserId }, data: { apiBalanceMicros: { decrement: reversal } } })
      }
    }
    return
  }

  if (type === 'charge.dispute.created' || type === 'charge.dispute.funds_withdrawn' || type === 'charge.dispute.closed') {
    const disputeMeta = await reversalMetadata(data)
    const disputeUserId = str(disputeMeta.userId) ?? str(data.client_reference_id)
    if (!disputeUserId) return
    if (type !== 'charge.dispute.closed') {
      // Suspend entitlements while a dispute is open or funds are pulled. A
      // closed dispute is recorded only; restoration is a deliberate admin op.
      await tx.user.update({
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
  // Fulfillment is a separate opt-in. A verified event is not claimed or
  // applied until the flag is on; Stripe retries on 503.
  if (!paymentGates().fulfillmentEnabled) return { status: 503, detail: 'unavailable' }

  // Persist BEFORE processing: durable exactly-once claim + audit.
  let existing = await prisma.stripeEventInbox.findUnique({ where: { eventId: event.id } })
  if (existing?.processedAt) return { status: 200, detail: 'already processed' }
  if (!existing) {
    try {
      existing = await prisma.stripeEventInbox.create({ data: { eventId: event.id, type: event.type, payloadJson: raw } })
    } catch (error: any) {
      // Unique race with a concurrent delivery: the winner's transaction applies.
      if (String(error?.code) !== 'P2002') throw error
      existing = await prisma.stripeEventInbox.findUnique({ where: { eventId: event.id } })
      if (existing?.processedAt) return { status: 200, detail: 'already processed' }
      if (!existing) return { status: 200, detail: 'concurrent delivery already claimed' }
    }
  }
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      // Compare-and-set: only the delivery that flips processedAt from null applies.
      const claimed = await tx.stripeEventInbox.updateMany({
        where: { eventId: event.id, processedAt: null },
        data: { processedAt: new Date(), errorCount: 0, lastError: null },
      })
      if (claimed.count !== 1) return 'skipped' as const
      await applyEvent(tx, event)
      return 'applied' as const
    })
    if (outcome === 'skipped') return { status: 200, detail: 'already processed' }
    return { status: 200, detail: 'processed' }
  } catch (error: any) {
    // The transaction rolled the claim back. Keep the row unprocessed so
    // Stripe's retry re-enters here; bounded error trail.
    const message = String(error?.message || 'processing error').slice(0, 400)
    await prisma.stripeEventInbox.update({
      where: { eventId: event.id },
      data: { errorCount: { increment: 1 }, lastError: message },
    }).catch(() => undefined)
    return { status: 503, detail: 'processing failed' }
  }
}
