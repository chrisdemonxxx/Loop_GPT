import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: {
    id: 'owner-a',
    plan: 'pro',
    role: 'user',
    unlimited: false,
    credits: 100,
    imageCredits: 10,
    creditsResetAt: new Date(),
  },
  reservation: null as null | Record<string, unknown>,
  intent: null as null | Record<string, unknown>,
  debits: 0,
}))

function sqlText(query: unknown): string {
  if (Array.isArray(query)) return query.join(' ')
  return String(query ?? '')
}

const tx = {
  $queryRaw: vi.fn(async (query: unknown) => {
    const text = sqlText(query)
    if (text.includes('SpendBudgetPolicy')) {
      return [{ id: 1, version: 1, revision: 1, perUserDailyReservationCap: 0n, globalDailyReservationCap: 0n }]
    }
    if (text.includes('DailyReservation')) return [{ user: 0n, global: 0n }]
    if (text.includes('User')) return [{ id: state.user.id }]
    return []
  }),
  user: {
    findUnique: vi.fn(async () => state.user),
    updateMany: vi.fn(async ({ data }: { data: { credits?: { decrement: number } } }) => {
      const decrement = data.credits?.decrement ?? 0
      if (state.user.credits < decrement) return { count: 0 }
      state.user.credits -= decrement
      state.debits += 1
      return { count: 1 }
    }),
    update: vi.fn(async () => state.user),
  },
  dailyReservation: {
    findFirst: vi.fn(async () => state.reservation),
    findUnique: vi.fn(async () => state.reservation),
    findUniqueOrThrow: vi.fn(async () => {
      if (!state.reservation) throw new Error('missing reservation')
      return state.reservation
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.reservation = { ...data }
      return state.reservation
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.reservation = { ...state.reservation, ...data }
      return state.reservation
    }),
  },
  dailySettlementIntent: {
    findUnique: vi.fn(async () => state.intent),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.intent = { ...data }
      return state.intent
    }),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.intent = { ...state.intent, ...data }
      return state.intent
    }),
  },
  usageEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data) },
}

vi.mock('../prisma', () => ({
  get prisma() { return { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) } },
  get hasDb() { return true },
}))

import { loopitMeterCredits, loopitUsageFingerprints, type LoopitUsageEvent } from '../loopitUsage'
import { recordLoopitMeteredUsage } from '../dailyReservations'

const event: LoopitUsageEvent = {
  idempotencyKey: 'meter-1',
  kind: 'inference',
  model: 'loopit/coder',
  inputTokens: 1500,
  outputTokens: 500,
  cachedInputTokens: 0,
  sandboxSeconds: 0,
  hostingSeconds: 0,
  storageGbMonths: 0,
  customDomainMonths: 0,
  runId: 'run-1',
}

describe('Loop-IT metered usage', () => {
  beforeEach(() => {
    state.user = { ...state.user, credits: 100, role: 'user', unlimited: false, creditsResetAt: new Date() }
    state.reservation = null
    state.intent = null
    state.debits = 0
  })

  it('prices meters and charges the owner once for a replayed key', async () => {
    expect(loopitMeterCredits(event)).toBe(2)
    expect(loopitMeterCredits({ ...event, kind: 'sandbox_seconds', sandboxSeconds: 61, inputTokens: 0, outputTokens: 0 })).toBe(2)
    const credits = loopitMeterCredits(event)
    const fingerprints = loopitUsageFingerprints('ws-a', event, credits)
    const first = await recordLoopitMeteredUsage({
      userId: 'owner-a',
      ...fingerprints,
      model: 'loopit/coder',
      tokensIn: 1500,
      tokensOut: 500,
      credits,
      pricingSnapshot: { source: 'loopit', workspaceId: 'ws-a', meterKind: 'inference' },
    })
    const second = await recordLoopitMeteredUsage({
      userId: 'owner-a',
      ...fingerprints,
      model: 'loopit/coder',
      tokensIn: 1500,
      tokensOut: 500,
      credits,
      pricingSnapshot: { source: 'loopit', workspaceId: 'ws-a', meterKind: 'inference' },
    })
    expect(first).toMatchObject({ credits: 2, duplicate: false })
    expect(second).toMatchObject({ reservationId: first.reservationId, credits: 2, duplicate: true })
    expect(state.debits).toBe(1)
    expect(state.user.credits).toBe(98)
    expect(tx.usageEvent.create).toHaveBeenCalledTimes(1)
  })

  it('does not debit a different workspace fingerprint as a replay', async () => {
    const credits = loopitMeterCredits(event)
    const alpha = loopitUsageFingerprints('ws-a', event, credits)
    const beta = loopitUsageFingerprints('ws-b', event, credits)
    expect(alpha.requestFingerprint).not.toBe(beta.requestFingerprint)
    await recordLoopitMeteredUsage({
      userId: 'owner-a', ...alpha, model: 'loopit/coder', tokensIn: 1500, tokensOut: 500, credits,
      pricingSnapshot: { source: 'loopit', workspaceId: 'ws-a', meterKind: 'inference' },
    })
    state.reservation = null
    state.intent = null
    await recordLoopitMeteredUsage({
      userId: 'owner-b', ...beta, model: 'loopit/coder', tokensIn: 1500, tokensOut: 500, credits,
      pricingSnapshot: { source: 'loopit', workspaceId: 'ws-b', meterKind: 'inference' },
    })
    expect(state.debits).toBe(2)
  })
})
