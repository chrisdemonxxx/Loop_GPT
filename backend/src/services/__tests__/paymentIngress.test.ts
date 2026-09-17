import { readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'
import express from 'express'
import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import router, { stripeWebhook } from '../../routes/billing'
import * as payments from '../stripe'

// Every external effect is a tripwire. DB is deliberately "available" so the
// tests cannot pass just because an old grant path skips a missing database.
const effects = vi.hoisted(() => ({
  findUser: vi.fn(), updateUser: vi.fn(), payment: vi.fn(), transaction: vi.fn(),
  addBalance: vi.fn(), email: vi.fn(),
}))
vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    user: { findUnique: effects.findUser, findFirst: effects.findUser, update: effects.updateUser },
    payment: { create: effects.payment }, $transaction: effects.transaction,
  },
}))
vi.mock('../apiBilling', () => ({
  API_PLANS: { developer: { id: 'developer' }, scale: { id: 'scale', includedCreditMicros: 100000000 } },
  TOP_UP_OPTIONS: [5, 10, 25, 50, 100], MICROS_PER_USD: 1000000, addBalance: effects.addBalance,
}))
vi.mock('../email', () => ({ alertEmail: effects.email }))
vi.mock('../../routes/auth', () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => { req.userId = 'localFixtureUser'; next() },
}))

// Synthetic fixtures only; the SDK is used for local HMAC, never API traffic.
const secret = 'whsec_localFixtureOnlyNotARealSecret'
const unavailable = { error: 'Payments are temporarily unavailable.' }
const invalid = { error: 'Invalid payment webhook.' }
const fixtureEnv = {
  STRIPE_SECRET_KEY: 'sk_test_localFixtureOnly', STRIPE_WEBHOOK_SECRET: secret,
  STRIPE_MODE: 'test', STRIPE_WEBHOOK_ACCOUNT: 'platform',
  STRIPE_CHECKOUT_ENABLED: '', STRIPE_FULFILLMENT_ENABLED: '',
  STRIPE_PRICE_PRO: 'price_localPro', STRIPE_PRICE_GOLD: 'price_localGold',
  STRIPE_PRICE_API_DEVELOPER: 'price_localDeveloper', STRIPE_PRICE_API_GROWTH: 'price_localGrowth',
  STRIPE_PRICE_API_SCALE: 'price_localScale', STRIPE_PUBLISHABLE_KEY: 'pk_test_localFixtureOnly',
  SUPPORT_EMAIL: 'fixture@example.invalid',
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const [name, value] of Object.entries(fixtureEnv)) vi.stubEnv(name, value)
  for (const effect of Object.values(effects)) effect.mockImplementation(() => { throw new Error('Unexpected payment effect') })
  vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('Network forbidden') })
  vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('Network forbidden') })
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network forbidden') })
})
afterEach(() => {
  try {
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled()
    expect(http.request).not.toHaveBeenCalled()
    expect(https.request).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
})

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_localFixture', object: 'event', type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: {
      id: 'cs_localFixture', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
      amount_total: 10000, currency: 'usd', metadata: { userId: 'victim', kind: 'api_topup', amountUsd: '999999' },
    } }, ...overrides,
  }
}

function signed(value: unknown = event(), timestamp = Math.floor(Date.now() / 1000), signingSecret = secret) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value)
  return {
    body: Buffer.from(payload),
    signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret, timestamp }),
  }
}

function response() {
  const res: any = { status: vi.fn(), json: vi.fn(), set: vi.fn() }
  for (const method of Object.values(res) as ReturnType<typeof vi.fn>[]) method.mockReturnValue(res)
  return res
}

async function deliver(body: unknown, signature: unknown, expected: number, extraHeaders = {}) {
  const res = response()
  await stripeWebhook({ body, headers: { 'stripe-signature': signature, ...extraHeaders } } as any, res)
  expect(res.status).toHaveBeenCalledTimes(1)
  expect(res.status).toHaveBeenCalledWith(expected)
  expect(res.json).toHaveBeenCalledTimes(1)
  expect(res.json).toHaveBeenCalledWith(expected === 400 ? invalid : unavailable)
  if (expected === 503) expect(res.set).toHaveBeenCalledWith('Retry-After', '60')
  return res
}

describe('payment ingress authentication and fail-closed configuration', () => {
  it.each([
    ['STRIPE_SECRET_KEY', ''], ['STRIPE_SECRET_KEY', 'sk_live_wrongMode'],
    ['STRIPE_SECRET_KEY', 'garbage'], ['STRIPE_WEBHOOK_SECRET', ''],
    ['STRIPE_WEBHOOK_SECRET', 'whsec_'], ['STRIPE_WEBHOOK_SECRET', ' malformed '],
    ['STRIPE_MODE', ''], ['STRIPE_MODE', 'production'],
    ['STRIPE_WEBHOOK_ACCOUNT', ''], ['STRIPE_WEBHOOK_ACCOUNT', '*'],
    ['STRIPE_WEBHOOK_ACCOUNT', 'acct_'], ['STRIPE_CHECKOUT_ENABLED', '1'],
    ['STRIPE_FULFILLMENT_ENABLED', 'TRUE'],
  ])('rejects invalid %s configuration (%s) without effects', async (name, value) => {
    vi.stubEnv(name, value)
    const input = signed()
    expect(payments.verifyPaymentIngress(input.body, input.signature).status).toBe('unavailable')
    await deliver(input.body, input.signature, 503)
    expect(payments.stripeEnabled()).toBe(false)
  })

  it('does not parse or fulfill unsigned JSON when only the API key is set', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', undefined)
    vi.stubEnv('STRIPE_CHECKOUT_ENABLED', 'true')
    vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', 'true')
    await deliver(Buffer.from(JSON.stringify(event())), undefined, 503)
  })

  it.each([undefined, '', [], ['t=1,v1=forged'], 'v1=forged', 't=abc,v1=forged'])('rejects missing/malformed signature %#', async signature => {
    await deliver(signed().body, signature, 400)
  })

  it.each([undefined, null, {}, event(), JSON.stringify(event()), new Uint8Array([1, 2]), Buffer.alloc(0)])('requires the original nonempty raw Buffer %#', async body => {
    await deliver(body, signed().signature, 400)
  })

  it('rejects incorrect signing secrets', async () => {
    const input = signed(event(), undefined, 'whsec_wrongLocalFixture')
    await deliver(input.body, input.signature, 400)
  })

  it('rejects tampering and byte-level reserialization', async () => {
    const input = signed()
    await deliver(Buffer.from(input.body.toString().replace('10000', '99999')), input.signature, 400)
    await deliver(Buffer.from(JSON.stringify(JSON.parse(input.body.toString()), null, 2)), input.signature, 400)
  })

  it('enforces signature age even when both feature flags are requested', async () => {
    vi.stubEnv('STRIPE_CHECKOUT_ENABLED', 'true'); vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', 'true')
    const input = signed(event(), Math.floor(Date.now() / 1000) - 301)
    await deliver(input.body, input.signature, 400)
    await deliver(input.body, undefined, 400)
  })

  it.each(['{broken', 'null', '[]', '1', '{}', JSON.stringify({ type: 'invoice.paid' })])('rejects signed malformed JSON/envelopes %#', async payload => {
    const input = signed(payload)
    await deliver(input.body, input.signature, 400)
  })

  it.each([
    { object: 'invoice' }, { id: '' }, { type: '' }, { created: -1 }, { created: 1.5 },
    { data: null }, { data: { object: [] } }, { livemode: true }, { livemode: 'false' },
    { livemode: null }, { account: 'acct_other' }, { account: null }, { context: 'acct_other' },
  ])('rejects signed envelope/mode/account mismatch %#', async overrides => {
    const input = signed(event(overrides))
    await deliver(input.body, input.signature, 400)
  })

  it('binds connected-account events to configured signed account, never request headers', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_ACCOUNT', 'acct_expected')
    for (const account of [undefined, 'acct_other']) {
      const input = signed(event({ account }))
      await deliver(input.body, input.signature, 400, { 'stripe-account': 'acct_expected' })
    }
    const input = signed(event({ account: 'acct_expected' }))
    expect(payments.verifyPaymentIngress(input.body, input.signature).status).toBe('verified')
    await deliver(input.body, input.signature, 503)
  })

  it('checks both directions of livemode using synthetic offline keys', async () => {
    vi.stubEnv('STRIPE_MODE', 'live'); vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_localFixtureOnly')
    const wrong = signed(event({ livemode: false }))
    await deliver(wrong.body, wrong.signature, 400)
    const right = signed(event({ livemode: true }))
    expect(payments.verifyPaymentIngress(right.body, right.signature).status).toBe('verified')
    await deliver(right.body, right.signature, 503)
  })
})

describe('retired fulfillment and separate feature gates', () => {
  it.each([
    [undefined, undefined], ['false', 'false'], ['true', 'false'], ['false', 'true'], ['true', 'true'],
  ])('cannot activate old fulfillment with checkout=%s fulfillment=%s', async (checkout, fulfillment) => {
    vi.stubEnv('STRIPE_CHECKOUT_ENABLED', checkout); vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', fulfillment)
    const input = signed()
    expect(payments.verifyPaymentIngress(input.body, input.signature).status).toBe('verified')
    expect(payments.paymentGates()).toEqual({ checkoutEnabled: false, fulfillmentEnabled: false, fulfillmentImplemented: false })
    await deliver(input.body, input.signature, 503)
    // Retrying the same event must not get a silent 2xx or be marked processed.
    await deliver(input.body, input.signature, 503)
    expect(() => payments.stripe()).toThrow('Payments are temporarily unavailable.')
  })

  it.each(['checkout.session.completed', 'invoice.paid', 'customer.subscription.updated',
    'customer.subscription.deleted', 'charge.refunded', 'refund.updated', 'charge.dispute.created', 'unhandled.event'])('never acknowledges or mutates from %s metadata', async type => {
    vi.stubEnv('STRIPE_CHECKOUT_ENABLED', 'true'); vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', 'true')
    for (const metadata of [undefined, { userId: 'victim' }, { userId: 'victim', kind: 'chat', plan: 'gold' },
      { userId: 'victim', kind: 'api_plan', plan: 'scale' }, { userId: 'victim', kind: 'api_topup', amountUsd: '999999' }]) {
      const input = signed(event({ type, data: { object: {
        id: 'in_localFixture', metadata, client_reference_id: 'victim',
        subscription_details: { metadata: { userId: 'victim', kind: 'api_plan', plan: 'scale' } },
        amount_total: 999999, amount_paid: -10000, currency: 'usd', status: 'canceled',
        customer: 'cus_localFixture', subscription: 'sub_localFixture',
      } } }))
      await deliver(input.body, input.signature, 503)
    }
  })

  it.each(['/checkout', '/api-checkout', '/topup'])('blocks %s before DB or Stripe client/API access', async path => {
    const client = vi.spyOn(payments, 'stripe').mockImplementation(() => { throw new Error('Stripe client forbidden') })
    const layer = (router as any).stack.find((entry: any) => entry.route?.path === path)
    expect(layer).toBeDefined()
    for (const [checkout, fulfillment] of [['', ''], ['true', 'false'], ['false', 'true'], ['true', 'true']]) {
      vi.stubEnv('STRIPE_CHECKOUT_ENABLED', checkout); vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', fulfillment)
      const req: any = { body: { plan: 'scale', amountUsd: 100, metadata: { userId: 'victim' } } }
      const res = response()
      const handlers = layer.route.stack
      for (let i = 0; i < handlers.length; i++) {
        const next = vi.fn()
        await handlers[i].handle(req, res, next)
        if (!next.mock.calls.length) break
      }
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith({ error: 'Payments are not enabled yet.' })
    }
    expect(client).not.toHaveBeenCalled()
  })

  it('advertises no purchasable plans or topups with keys/prices and both flags set', () => {
    vi.stubEnv('STRIPE_CHECKOUT_ENABLED', 'true'); vi.stubEnv('STRIPE_FULFILLMENT_ENABLED', 'true')
    expect(payments.publicConfig()).toEqual({
      enabled: false, checkoutEnabled: false, fulfillmentEnabled: false, fulfillmentImplemented: false,
      publishableKey: null, plans: { pro: false, gold: false },
      apiPlans: { developer: false, growth: false, scale: false }, topUps: false,
    })
  })
})

describe('raw-body mounting contract without a listening server', () => {
  it('preserves original bytes through the actual raw middleware; parsed JSON is rejected', async () => {
    const input = signed(JSON.stringify(event(), null, 2))
    for (const raw of [true, false]) {
      const req: any = Readable.from([input.body])
      req.headers = { 'content-type': 'application/json', 'content-length': String(input.body.length) }
      req.method = 'POST'
      const parser = raw ? express.raw({ type: 'application/json' }) : express.json()
      await new Promise<void>((resolve, reject) => parser(req, response(), err => err ? reject(err) : resolve()))
      expect(Buffer.isBuffer(req.body)).toBe(raw)
      if (raw) expect(req.body).toEqual(input.body)
      await deliver(req.body, input.signature, raw ? 503 : 400)
    }
  })

  it('keeps the production raw webhook mount before the global JSON parser', () => {
    const server = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8')
    const mount = server.indexOf("app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), asyncHandler(stripeWebhook))")
    expect(mount).toBeGreaterThan(-1)
    expect(server.indexOf('app.use(express.json(')).toBeGreaterThan(mount)
  })
})
