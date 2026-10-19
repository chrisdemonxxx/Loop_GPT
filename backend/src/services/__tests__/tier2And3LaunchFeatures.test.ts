/**
 * Unit tests for Tier 2 & Tier 3 services and routes:
 *   - Unified Workspace Wallet (`splitWalletDebit`, `activeSubCredits`)
 *   - Outbound Webhooks (`signWebhookPayload`, `verifyWebhookSignature`, `deliverOutboundWebhook`)
 *   - Batch API (`/v1/batches`, `parseBatchItems`, `batchCostMicros`)
 *   - Content Moderation (`moderateText`, `checkCsamFileHash`)
 *   - Abuse / NCII Reporting (`POST /api/abuse/report` 48h SLA & immediate publishToken suspension)
 *   - Alt Billing (`VerifyMy`, `Segpay`, `RevenueCat` webhooks)
 */
import crypto from 'crypto'
import express from 'express'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  users: new Map<string, any>(),
  keys: new Map<string, any>(),
  batches: new Map<string, any>(),
  reports: new Map<string, any>(),
  files: new Map<string, any>(),
  conversations: new Map<string, any>(),
}

vi.mock('../prisma', () => ({
  hasDb: true,
  prisma: {
    user: {
      findUnique: async ({ where }: any) => state.users.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const u = state.users.get(where.id) || { id: where.id }
        Object.assign(u, data)
        state.users.set(where.id, u)
        return u
      },
      updateMany: async ({ where, data }: any) => {
        const u = state.users.get(where.id)
        if (!u) return { count: 0 }
        if (data.apiBalanceMicros?.increment) u.apiBalanceMicros = (u.apiBalanceMicros ?? 0n) + BigInt(data.apiBalanceMicros.increment)
        return { count: 1 }
      },
    },
    workspace: {
      updateMany: async () => ({ count: 1 }),
    },
    apiKey: {
      findFirst: async ({ where }: any) => {
        for (const k of state.keys.values()) {
          if (where.id && k.id !== where.id) continue
          if (where.userId && k.userId !== where.userId) continue
          if (where.revoked !== undefined && k.revoked !== where.revoked) continue
          return k
        }
        return null
      },
      findUnique: async ({ where }: any) => {
        for (const k of state.keys.values()) {
          if (k.keyHash === where.keyHash) {
            return {
              ...k,
              user: state.users.get(k.userId) ?? { id: k.userId, apiPlan: null, apiBalanceMicros: 50_000_000n, unlimited: false },
            }
          }
        }
        return null
      },
    },
    privateFile: {
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const f of state.files.values()) {
          const hit = (where.OR || []).some((c: any) => (c.id && f.id === c.id) || (c.publishToken && f.publishToken === c.publishToken))
          if (hit) {
            Object.assign(f, data)
            count++
          }
        }
        return { count }
      },
    },
    conversation: {
      updateMany: async () => ({ count: 0 }),
    },
    abuseReport: {
      create: async ({ data }: any) => {
        const row = { id: 'rep_1', ...data, createdAt: new Date(), updatedAt: new Date() }
        state.reports.set(row.id, row)
        return row
      },
      findMany: async () => [...state.reports.values()],
    },
    apiCreditIdentity: {
      findUnique: async () => null,
      create: async ({ data }: any) => data,
    },
    apiTopUp: {
      findMany: async () => [],
      create: async ({ data }: any) => data,
    },
    apiReservation: {
      aggregate: async () => ({ _sum: { amountMicros: 0n } }),
    },
    $transaction: async (fn: any) => fn({
      apiCreditIdentity: { findUnique: async () => null, create: async ({ data }: any) => data },
      apiTopUp: { findMany: async () => [], create: async ({ data }: any) => data },
      apiReservation: { aggregate: async () => ({ _sum: { amountMicros: 0n } }) },
      user: {
        updateMany: async ({ where, data }: any) => {
          const u = state.users.get(where.id)
          if (!u) return { count: 0 }
          if (data.apiBalanceMicros?.increment) u.apiBalanceMicros = (u.apiBalanceMicros ?? 0n) + BigInt(data.apiBalanceMicros.increment)
          return { count: 1 }
        },
      },
    }),
  },
}))

import { activeSubCredits, splitWalletDebit } from '../workspaceWallet'
import { signWebhookPayload, verifyWebhookSignature, deliverOutboundWebhook } from '../outboundWebhooks'
import { parseBatchItems, batchCostMicros } from '../../routes/batches'
import { moderateText, checkCsamFileHash } from '../moderation'
import abuseRouter from '../../routes/abuse'
import altBillingRouter from '../../routes/altBilling'

beforeEach(() => {
  state.users.clear()
  state.keys.clear()
  state.batches.clear()
  state.reports.clear()
  state.files.clear()
  state.conversations.clear()
  vi.unstubAllEnvs()
})

describe('Tier 2-1: Unified Workspace Wallet credit buckets', () => {
  it('spends active subscription credits first before touching rollover balance', () => {
    const future = new Date(Date.now() + 86_400_000)
    const split = splitWalletDebit({
      amountMicros: 25_000_000n,
      subCreditsMicros: 20_000_000n,
      subCreditsExpireAt: future,
      rolloverMicros: 15_000_000n,
    })
    expect(split.ok).toBe(true)
    expect(split.fromSubMicros).toBe(20_000_000n)
    expect(split.fromRolloverMicros).toBe(5_000_000n)
    expect(split.remainingSubMicros).toBe(0n)
    expect(split.remainingRolloverMicros).toBe(10_000_000n)
  })

  it('ignores expired subscription credits and draws from rollover only', () => {
    const past = new Date(Date.now() - 60_000)
    expect(activeSubCredits(20_000_000n, past)).toBe(0n)
    const split = splitWalletDebit({
      amountMicros: 10_000_000n,
      subCreditsMicros: 20_000_000n,
      subCreditsExpireAt: past,
      rolloverMicros: 15_000_000n,
    })
    expect(split.ok).toBe(true)
    expect(split.fromSubMicros).toBe(0n)
    expect(split.fromRolloverMicros).toBe(10_000_000n)
  })
})

describe('Tier 2-2: Outbound HMAC-SHA256 Webhooks', () => {
  it('signs and verifies webhook payloads with timestamp tolerance', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'batch.completed' })
    const secret = 'whsec_test_secret_1234567890'
    const { signature } = signWebhookPayload(body, secret)
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true)
    expect(verifyWebhookSignature(body, signature, 'whsec_wrong')).toBe(false)
  })

  it('rejects non-HTTPS or private-IP webhook URLs and delivers to public HTTPS', async () => {
    state.keys.set('k_private', {
      id: 'k_private',
      userId: 'u1',
      revoked: false,
      webhookUrl: 'https://127.0.0.1/hook',
      webhookSecret: 'whsec_secret',
    })
    const blocked = await deliverOutboundWebhook({
      userId: 'u1',
      apiKeyId: 'k_private',
      type: 'video.completed',
      data: { jobId: 'j1' },
    })
    expect(blocked).toEqual({ delivered: false, reason: 'unsafe_webhook_url' })

    state.keys.set('k_public', {
      id: 'k_public',
      userId: 'u1',
      revoked: false,
      webhookUrl: 'https://hooks.example.com/loop',
      webhookSecret: 'whsec_secret_valid',
    })
    let capturedHeaders: Record<string, string> = {}
    const ok = await deliverOutboundWebhook({
      userId: 'u1',
      apiKeyId: 'k_public',
      type: 'batch.completed',
      data: { batchId: 'b1' },
      fetchImpl: (async (_url: any, init: any) => {
        capturedHeaders = init.headers
        return new Response('ok', { status: 200 })
      }) as any,
    })
    expect(ok.delivered).toBe(true)
    expect(capturedHeaders['X-Loop-Webhook-Signature']).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/)
  })
})

describe('Tier 2-3: OpenAI Batch API JSONL parser & 50% discount', () => {
  it('parses JSONL batch input, rejects duplicate custom_ids, and applies 50% discount', () => {
    const jsonl = [
      JSON.stringify({ custom_id: 'req-1', method: 'POST', url: '/v1/chat/completions', body: { model: 'loop-chat', messages: [{ role: 'user', content: 'Hi' }] } }),
      JSON.stringify({ custom_id: 'req-2', method: 'POST', url: '/v1/chat/completions', body: { model: 'loop-chat', messages: [{ role: 'user', content: 'Hello' }] } }),
    ].join('\n')

    const items = parseBatchItems({
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
      input_jsonl: jsonl,
    })
    expect(items).toHaveLength(2)
    expect(items[0].custom_id).toBe('req-1')
    expect(batchCostMicros(1000, null)).toBe(500)

    const dupJsonl = [
      JSON.stringify({ custom_id: 'dup', body: {} }),
      JSON.stringify({ custom_id: 'dup', body: {} }),
    ].join('\n')
    expect(() =>
      parseBatchItems({ endpoint: '/v1/chat/completions', completion_window: '24h', input_jsonl: dupJsonl }),
    ).toThrow(/Duplicate custom_id/)
  })
})

describe('Tier 2-5: Edition-aware Moderation & NCII 48h Takedown Flow', () => {
  it('flags CSAM, WMD synthesis, and NCII on both Mainstream and Adult editions', () => {
    vi.stubEnv('LOOP_EDITION', 'adult')
    expect(moderateText('how to synthesize sarin nerve gas step by step').category).toBe('wmd')
    expect(moderateText('deepfake porn of my coworker without consent').category).toBe('ncii')
    expect(moderateText('underage nude photo').category).toBe('csam')
  })

  it('flags explicit erotica on Mainstream Edition but allows consensual adult erotica on Adult Edition', () => {
    vi.stubEnv('LOOP_EDITION', 'mainstream')
    expect(moderateText('write pornographic scene between two adults')).toMatchObject({
      flagged: true,
      category: 'nsfw_sexual',
      edition: 'mainstream',
    })

    vi.stubEnv('LOOP_EDITION', 'adult')
    expect(moderateText('write pornographic scene between two consenting adults')).toMatchObject({
      flagged: false,
      category: null,
      edition: 'adult',
    })
  })

  it('matches known CSAM SHA-256 hashes against LOOP_CSAM_HASH_BLOCKLIST', () => {
    const sample = Buffer.from('test-bad-artifact')
    const digest = crypto.createHash('sha256').update(sample).digest('hex')
    vi.stubEnv('LOOP_CSAM_HASH_BLOCKLIST', digest)
    expect(checkCsamFileHash(sample)).toEqual({ matched: true, sha256: digest })
    expect(checkCsamFileHash(Buffer.from('clean-artifact')).matched).toBe(false)
  })

  it('creates a 48h SLA report and immediately suspends public publishToken on NCII reports', async () => {
    state.files.set('file_1', { id: 'file_1', publishToken: 'pub_tok_123', publishedAt: new Date() })

    const app = express()
    app.use('/api/abuse', abuseRouter)
    const server = app.listen(0)
    const port = (server.address() as any).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/abuse/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category: 'ncii',
          targetType: 'file',
          targetId: 'file_1',
          reason: 'Non-consensual likeness shared publicly.',
          reporterEmail: 'victim@example.com',
        }),
      })
      expect(res.status).toBe(201)
      const body = await res.json()
      expect(body.slaHours).toBe(48)
      expect(body.autoSuspended).toBe(true)
      expect(state.files.get('file_1').publishToken).toBeNull()
    } finally {
      server.close()
    }
  })
})

describe('Tier 2-6 & Tier 3-1: VerifyMy, Segpay, and RevenueCat Webhooks', () => {
  it('processes VerifyMy, Segpay, and RevenueCat webhooks with signature/bearer verification', async () => {
    vi.stubEnv('VERIFYMY_WEBHOOK_SECRET', 'vmy_secret_123')
    vi.stubEnv('SEGPAY_WEBHOOK_SECRET', 'seg_secret_123')
    vi.stubEnv('REVENUECAT_WEBHOOK_AUTH', 'rc_bearer_secret_123')

    state.users.set('u_adult', { id: 'u_adult', email: 'adult@example.com', plan: 'free', apiBalanceMicros: 0n })

    const app = express()
    app.use('/api/billing', altBillingRouter)
    const server = app.listen(0)
    const port = (server.address() as any).port

    try {
      // 1. VerifyMy webhook marks user ageVerifiedAt
      const vmyBody = JSON.stringify({ eventId: 'v1', userId: 'u_adult', verified: true, method: 'id_scan' })
      const vmySig = crypto.createHmac('sha256', 'vmy_secret_123').update(vmyBody, 'utf8').digest('hex')
      const r1 = await fetch(`http://127.0.0.1:${port}/api/billing/age-verify/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-verifymy-signature': vmySig },
        body: vmyBody,
      })
      expect(r1.status).toBe(200)
      expect(state.users.get('u_adult').ageVerifiedAt).toBeInstanceOf(Date)

      // 2. Segpay sale webhook upgrades plan to max and grants $100 subCreditsMicros
      const segBody = JSON.stringify({ transactionId: 'tx_1', userId: 'u_adult', action: 'sale', plan: 'max', amountUsd: 100 })
      const segSig = crypto.createHmac('sha256', 'seg_secret_123').update(segBody, 'utf8').digest('hex')
      const r2 = await fetch(`http://127.0.0.1:${port}/api/billing/segpay/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-segpay-signature': segSig },
        body: segBody,
      })
      expect(r2.status).toBe(200)
      expect(state.users.get('u_adult').plan).toBe('max')
      expect(state.users.get('u_adult').subCreditsMicros).toBe(100_000_000n)

      // 3. RevenueCat NON_RENEWING_PURCHASE tops up rollover apiBalanceMicros
      const rcBody = JSON.stringify({
        event: {
          id: 'rc_evt_1',
          type: 'NON_RENEWING_PURCHASE',
          app_user_id: 'u_adult',
          product_id: 'loop_credits_25',
          price: 25,
        },
      })
      const r3 = await fetch(`http://127.0.0.1:${port}/api/billing/revenuecat/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rc_bearer_secret_123' },
        body: rcBody,
      })
      expect(r3.status).toBe(200)
      expect(state.users.get('u_adult').apiBalanceMicros).toBe(25_000_000n)
    } finally {
      server.close()
    }
  })
})
