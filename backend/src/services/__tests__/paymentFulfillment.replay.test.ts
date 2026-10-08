/**
 * Stripe webhook replay: duplicate delivery, out-of-order events, refunds and
 * disputes. The inbox compare-and-set is the exactly-once claim — two
 * in-flight copies of one event credit a top-up once.
 */
import Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type InboxRow = {
  eventId: string
  type: string
  payloadJson: string
  processedAt: Date | null
  errorCount: number
  lastError: string | null
}

const state = {
  inbox: new Map<string, InboxRow>(),
  balance: 0n,
  plan: 'free',
  unlimited: false,
  stripeSubId: null as string | null,
  apiSubId: 'sub_api' as string | null,
  apiPlan: 'developer' as string | null,
  apiPlanRenewsAt: null as Date | null,
}

function resetState() {
  state.inbox.clear()
  state.balance = 0n
  state.plan = 'free'
  state.unlimited = false
  state.stripeSubId = 'sub_new'
  state.apiSubId = 'sub_api'
  state.apiPlan = 'developer'
  state.apiPlanRenewsAt = null
}

function snapshot() {
  return {
    balance: state.balance,
    plan: state.plan,
    unlimited: state.unlimited,
    stripeSubId: state.stripeSubId,
    apiSubId: state.apiSubId,
    apiPlan: state.apiPlan,
    apiPlanRenewsAt: state.apiPlanRenewsAt?.toISOString() ?? null,
    inbox: [...state.inbox.entries()].map(([id, row]) => [id, { ...row, processedAt: row.processedAt?.toISOString() ?? null }] as const),
  }
}

function restore(saved: ReturnType<typeof snapshot>) {
  state.balance = saved.balance
  state.plan = saved.plan
  state.unlimited = saved.unlimited
  state.stripeSubId = saved.stripeSubId
  state.apiSubId = saved.apiSubId
  state.apiPlan = saved.apiPlan
  state.apiPlanRenewsAt = saved.apiPlanRenewsAt ? new Date(saved.apiPlanRenewsAt) : null
  state.inbox.clear()
  for (const [id, row] of saved.inbox) {
    state.inbox.set(id, { ...row, processedAt: row.processedAt ? new Date(row.processedAt) : null })
  }
}

const tx = {
  user: {
    findUnique: async () => ({
      id: 'user_replay',
      apiBalanceMicros: state.balance,
      plan: state.plan,
      unlimited: state.unlimited,
      stripeSubId: state.stripeSubId,
      apiSubId: state.apiSubId,
      apiPlan: state.apiPlan,
    }),
    findFirst: async ({ where }: any) => {
      const ors = where?.OR ?? []
      const hit = ors.some((clause: any) => clause.apiSubId === state.apiSubId || clause.stripeSubId === state.stripeSubId)
      return hit ? { id: 'user_replay', apiSubId: state.apiSubId, stripeSubId: state.stripeSubId } : null
    },
    update: async ({ data }: any) => {
      if (data.apiBalanceMicros?.increment) state.balance += BigInt(data.apiBalanceMicros.increment)
      if (data.apiBalanceMicros?.decrement) state.balance -= BigInt(data.apiBalanceMicros.decrement)
      if (data.plan !== undefined) state.plan = data.plan
      if (data.unlimited !== undefined) state.unlimited = data.unlimited
      if (data.stripeSubId !== undefined) state.stripeSubId = data.stripeSubId
      if (data.apiSubId !== undefined) state.apiSubId = data.apiSubId
      if (data.apiPlan !== undefined) state.apiPlan = data.apiPlan
      if (data.apiPlanRenewsAt !== undefined) state.apiPlanRenewsAt = data.apiPlanRenewsAt
      return {}
    },
  },
  stripeEventInbox: {
    updateMany: async ({ where, data }: any) => {
      const row = state.inbox.get(where.eventId)
      if (!row || row.processedAt !== null || where.processedAt !== null) return { count: 0 }
      row.processedAt = data.processedAt
      row.errorCount = data.errorCount ?? 0
      row.lastError = data.lastError ?? null
      return { count: 1 }
    },
  },
}

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    stripeEventInbox: {
      findUnique: async ({ where }: any) => state.inbox.get(where.eventId) ?? null,
      create: async ({ data }: any) => {
        if (state.inbox.has(data.eventId)) {
          const error: any = new Error('unique')
          error.code = 'P2002'
          throw error
        }
        const row: InboxRow = { ...data, processedAt: data.processedAt ?? null, errorCount: 0, lastError: null }
        state.inbox.set(data.eventId, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const row = state.inbox.get(where.eventId)
        if (!row) throw new Error('missing inbox row')
        if (data.errorCount?.increment) row.errorCount += data.errorCount.increment
        if (data.lastError !== undefined) row.lastError = data.lastError
        if (data.processedAt !== undefined) row.processedAt = data.processedAt
        return row
      },
    },
    $transaction: async (fn: any) => {
      const saved = snapshot()
      try {
        return await fn(tx)
      } catch (error) {
        restore(saved)
        throw error
      }
    },
  },
}))

import { ingestPaymentEvent } from '../paymentFulfillment'

const secret = 'whsec_replayFixtureOnlyNotARealSecret'

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

const topup = (id = 'evt_topup') => envelope(id, 'checkout.session.completed', {
  id: 'cs_topup', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
  metadata: { userId: 'user_replay', kind: 'api_topup', amountUsd: '25' },
  client_reference_id: 'user_replay',
})

beforeEach(() => {
  resetState()
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_replayFixtureOnly')
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret)
  vi.stubEnv('STRIPE_MODE', 'test')
  vi.stubEnv('STRIPE_WEBHOOK_ACCOUNT', 'platform')
  vi.stubEnv('STRIPE_CHECKOUT_ENABLED', 'true')
  vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', 'true')
})

describe('stripe webhook replay', () => {
  it('credits a paid top-up once when the same event is delivered twice, including concurrently', async () => {
    const input = signed(topup())
    const [first, second] = await Promise.all([
      ingestPaymentEvent(input.body, input.signature),
      ingestPaymentEvent(input.body, input.signature),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 200])
    expect(state.balance).toBe(25_000_000n)
    const again = await ingestPaymentEvent(input.body, input.signature)
    expect(again).toMatchObject({ status: 200 })
    expect(state.balance).toBe(25_000_000n)
  })

  it('does not credit an unpaid checkout session', async () => {
    const input = signed(envelope('evt_unpaid', 'checkout.session.completed', {
      id: 'cs_unpaid', object: 'checkout.session', payment_status: 'unpaid',
      metadata: { userId: 'user_replay', kind: 'api_topup', amountUsd: '25' },
    }))
    expect(await ingestPaymentEvent(input.body, input.signature)).toMatchObject({ status: 200 })
    expect(state.balance).toBe(0n)
  })

  it('applies an invoice renewal whose subscription is an id string, even before checkout', async () => {
    const periodEnd = 1_800_000_000
    const invoice = signed(envelope('evt_invoice', 'invoice.paid', {
      id: 'in_replay', object: 'invoice',
      subscription: 'sub_api',
      parent: { subscription_details: { subscription: 'sub_api', metadata: { userId: 'user_replay', kind: 'api_plan' } } },
      lines: { data: [{ period: { end: periodEnd } }] },
    }))
    expect(await ingestPaymentEvent(invoice.body, invoice.signature)).toMatchObject({ status: 200 })
    expect(state.apiPlanRenewsAt?.toISOString()).toBe(new Date(periodEnd * 1000).toISOString())
    const checkout = signed(envelope('evt_apicheckout', 'checkout.session.completed', {
      id: 'cs_api', object: 'checkout.session', mode: 'subscription', payment_status: 'paid',
      metadata: { userId: 'user_replay', kind: 'api_plan', plan: 'scale' },
      subscription: 'sub_api', client_reference_id: 'user_replay',
    }))
    expect(await ingestPaymentEvent(checkout.body, checkout.signature)).toMatchObject({ status: 200 })
    expect(state.apiPlan).toBe('scale')
  })

  it('reverses a refund once and ignores a duplicate, without going negative', async () => {
    expect((await ingestPaymentEvent(signed(topup()).body, signed(topup()).signature)).status).toBe(200)
    const refund = signed(envelope('evt_refund', 'charge.refunded', {
      id: 'ch_replay', object: 'charge',
      metadata: { userId: 'user_replay', kind: 'api_topup', amountUsd: '100' },
    }))
    expect(await ingestPaymentEvent(refund.body, refund.signature)).toMatchObject({ status: 200 })
    expect(state.balance).toBe(0n)
    expect(await ingestPaymentEvent(refund.body, refund.signature)).toMatchObject({ status: 200 })
    expect(state.balance).toBe(0n)
  })

  it('processes a refund that arrives before the credit without driving the balance negative', async () => {
    const refund = signed(envelope('evt_refundearly', 'charge.refunded', {
      id: 'ch_early', object: 'charge',
      metadata: { userId: 'user_replay', kind: 'api_topup', amountUsd: '25' },
    }))
    expect(await ingestPaymentEvent(refund.body, refund.signature)).toMatchObject({ status: 200 })
    expect(state.balance).toBe(0n)
    const late = signed(topup('evt_topuplate'))
    expect(await ingestPaymentEvent(late.body, late.signature)).toMatchObject({ status: 200 })
    expect(state.balance).toBe(25_000_000n)
  })

  it('suspends entitlements on a dispute and ignores a stale subscription.deleted', async () => {
    state.plan = 'pro'
    state.unlimited = false
    const dispute = signed(envelope('evt_dispute', 'charge.dispute.created', {
      id: 'dp_replay', object: 'dispute',
      metadata: { userId: 'user_replay', kind: 'api_topup' },
    }))
    expect(await ingestPaymentEvent(dispute.body, dispute.signature)).toMatchObject({ status: 200 })
    expect(state.plan).toBe('free')
    expect(state.apiPlan).toBeNull()

    state.plan = 'gold'
    state.unlimited = true
    state.stripeSubId = 'sub_new'
    const stale = signed(envelope('evt_oldcancel', 'customer.subscription.deleted', {
      id: 'sub_old', object: 'subscription', status: 'canceled',
      metadata: { userId: 'user_replay', kind: 'chat' },
    }))
    expect(await ingestPaymentEvent(stale.body, stale.signature)).toMatchObject({ status: 200 })
    expect(state.plan).toBe('gold')
    expect(state.stripeSubId).toBe('sub_new')
    expect(state.unlimited).toBe(true)
  })
})
