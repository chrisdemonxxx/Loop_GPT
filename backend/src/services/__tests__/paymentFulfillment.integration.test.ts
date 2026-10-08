/**
 * Webhook replay against the local test database. Same cases as the unit
 * suite, with Postgres enforcing the inbox unique key and the compare-and-set.
 */
import { randomUUID } from 'crypto'
import Stripe from 'stripe'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../prisma'
import { ingestPaymentEvent } from '../paymentFulfillment'

const db = prisma!
const secret = 'whsec_integrationReplayFixtureOnly'
const userId = `pay-${randomUUID()}`
const eventTag = randomUUID().replace(/-/g, '')

function signed(value: unknown) {
  const payload = JSON.stringify(value)
  return {
    body: Buffer.from(payload),
    signature: Stripe.webhooks.generateTestHeaderString({ payload, secret }),
  }
}

function envelope(id: string, type: string, object: Record<string, unknown>) {
  return {
    id, object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object },
  }
}

beforeAll(async () => {
  await db.user.create({
    data: {
      id: userId, email: `${userId}@example.test`, password: 'fixture-only', name: 'Pay fixture',
      plan: 'pro', unlimited: true, stripeSubId: 'sub_new', apiSubId: 'sub_api', apiPlan: 'developer',
    },
  })
})

beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_intFixtureOnly')
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret)
  vi.stubEnv('STRIPE_MODE', 'test')
  vi.stubEnv('STRIPE_WEBHOOK_ACCOUNT', 'platform')
  vi.stubEnv('STRIPE_CHECKOUT_ENABLED', 'true')
  vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', 'true')
})

afterAll(async () => {
  await db.stripeEventInbox.deleteMany({ where: { eventId: { startsWith: `evt_${eventTag}` } } })
  await db.user.delete({ where: { id: userId } }).catch(() => undefined)
})

describe('stripe webhook replay against Postgres', () => {
  it('credits one concurrent duplicate top-up, then refunds and disputes without a second credit', async () => {
    const eventId = `evt_${eventTag}topup`
    const input = signed(envelope(eventId, 'checkout.session.completed', {
      id: 'cs_integration', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
      metadata: { userId, kind: 'api_topup', amountUsd: '25' },
      client_reference_id: userId,
    }))
    const [a, b] = await Promise.all([
      ingestPaymentEvent(input.body, input.signature),
      ingestPaymentEvent(input.body, input.signature),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 200])
    const credited = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(credited.apiBalanceMicros).toBe(25_000_000n)
    expect(await ingestPaymentEvent(input.body, input.signature)).toMatchObject({ status: 200 })
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).apiBalanceMicros).toBe(25_000_000n)

    const refund = signed(envelope(`evt_${eventTag}refund`, 'charge.refunded', {
      id: 'ch_integration', object: 'charge',
      metadata: { userId, kind: 'api_topup', amountUsd: '10' },
    }))
    expect(await ingestPaymentEvent(refund.body, refund.signature)).toMatchObject({ status: 200 })
    expect(await ingestPaymentEvent(refund.body, refund.signature)).toMatchObject({ status: 200 })
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).apiBalanceMicros).toBe(15_000_000n)

    const dispute = signed(envelope(`evt_${eventTag}dispute`, 'charge.dispute.created', {
      id: 'dp_integration', object: 'dispute', metadata: { userId },
    }))
    expect(await ingestPaymentEvent(dispute.body, dispute.signature)).toMatchObject({ status: 200 })
    const suspended = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(suspended.plan).toBe('free')
    expect(suspended.apiPlan).toBeNull()
  })

  it('ignores a stale subscription.deleted and still applies an out-of-order invoice renewal', async () => {
    await db.user.update({
      where: { id: userId },
      data: { plan: 'gold', unlimited: true, stripeSubId: 'sub_new', apiPlan: 'scale', apiSubId: 'sub_api', apiPlanRenewsAt: null },
    })
    const stale = signed(envelope(`evt_${eventTag}oldsub`, 'customer.subscription.deleted', {
      id: 'sub_old', object: 'subscription', status: 'canceled',
      metadata: { userId, kind: 'chat' },
    }))
    expect(await ingestPaymentEvent(stale.body, stale.signature)).toMatchObject({ status: 200 })
    const kept = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(kept.plan).toBe('gold')
    expect(kept.stripeSubId).toBe('sub_new')

    const periodEnd = 1_800_000_000
    const invoice = signed(envelope(`evt_${eventTag}invoice`, 'invoice.paid', {
      id: 'in_integration', object: 'invoice', subscription: 'sub_api',
      lines: { data: [{ period: { end: periodEnd } }] },
    }))
    expect(await ingestPaymentEvent(invoice.body, invoice.signature)).toMatchObject({ status: 200 })
    const renewed = await db.user.findUniqueOrThrow({ where: { id: userId } })
    expect(renewed.apiPlanRenewsAt?.toISOString()).toBe(new Date(periodEnd * 1000).toISOString())
  })
})
