/**
 * Developer API pricing, plans and the prepaid USD balance ledger.
 *
 * Balances are stored as integer micro-USD (1_000_000 = $1) so per-token costs
 * stay exact — floating point dollars would drift over millions of requests.
 *
 * Rates deliberately undercut comparable gateways (abliteration.ai charges
 * $3/1M input and $3/1M output at time of writing).
 */
import { prisma, hasDb } from './prisma'
import { chatModelCatalog } from './chatModels'
import { ApiBillingError, apiAmount, apiCount, apiIdentifier, apiTransaction, MAX_API_MICROS, captureApiReservation } from './apiReservations'
import type { Prisma } from '@prisma/client'

/** 1 USD expressed in micro-USD. */
export const MICROS_PER_USD = 1_000_000

/** Per-million-token rates in micro-USD. */
export const RATE_CHAT_INPUT_PER_MTOK = 2 * MICROS_PER_USD // $2.00 / 1M tokens
export const RATE_CHAT_OUTPUT_PER_MTOK = 2 * MICROS_PER_USD // $2.00 / 1M tokens
/**
 * Large-tier rates. abliteration.ai charges $5/$5 per 1M for its large model,
 * so $3/$3 keeps the "cheaper on every axis" positioning.
 */
export const RATE_CHAT_LARGE_INPUT_PER_MTOK = 3 * MICROS_PER_USD // $3.00 / 1M tokens
export const RATE_CHAT_LARGE_OUTPUT_PER_MTOK = 3 * MICROS_PER_USD // $3.00 / 1M tokens
/** Cached input is billed at 10% of the standard input rate. */
export const CACHED_INPUT_DISCOUNT = 0.1

/** Per-tier chat rates, keyed by the tiers in `services/chatModels.ts`. */
export const CHAT_TIER_RATES: Record<string, { input: number; output: number }> = {
  standard: { input: RATE_CHAT_INPUT_PER_MTOK, output: RATE_CHAT_OUTPUT_PER_MTOK },
  large: { input: RATE_CHAT_LARGE_INPUT_PER_MTOK, output: RATE_CHAT_LARGE_OUTPUT_PER_MTOK },
}

export function chatRatesFor(tier?: string | null) {
  return CHAT_TIER_RATES[tier || 'standard'] || CHAT_TIER_RATES.standard
}

/** Flat per-unit rates in micro-USD. */
export const RATE_IMAGE = 50_000 // $0.05 per image
export const RATE_VIDEO = 400_000 // $0.40 per video

/** Free preview credit granted once, on first key creation (no card required). */
export const PREVIEW_CREDIT_MICROS = 1 * MICROS_PER_USD // $1.00

export interface ApiPlan {
  id: string
  name: string
  priceUsd: number
  /** Fractional discount applied to metered usage, e.g. 0.05 = 5% off. */
  discount: number
  /** Requests per minute allowed across all of the user's keys. */
  rateLimitPerMin: number
  /** Monthly credit included with the plan, in micro-USD. */
  includedCreditMicros: number
  highlights: string[]
}

/** `null` plan = pay-as-you-go on prepaid credit with no monthly fee. */
export const API_PLANS: Record<string, ApiPlan> = {
  developer: {
    id: 'developer',
    name: 'Developer',
    priceUsd: 15,
    discount: 0.05,
    rateLimitPerMin: 60,
    includedCreditMicros: 0,
    highlights: ['5% usage discount', '60 requests/min', 'Unlimited API keys', 'OpenAI-compatible /v1'],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceUsd: 40,
    discount: 0.1,
    rateLimitPerMin: 300,
    includedCreditMicros: 0,
    highlights: ['10% usage discount', '300 requests/min', 'Priority queue', 'Usage analytics'],
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    priceUsd: 150,
    discount: 0.15,
    rateLimitPerMin: 600,
    includedCreditMicros: 150 * MICROS_PER_USD,
    highlights: ['15% usage discount', '600 requests/min', '$150 credit included monthly', 'Priority support'],
  },
}

/** Rate limit for pay-as-you-go users with no monthly plan. */
export const FREE_RATE_LIMIT_PER_MIN = 20

/** Prepaid top-up options (Stripe payment-mode checkout). */
export const TOP_UP_OPTIONS = [10, 25, 100]

export function planFor(planId?: string | null): ApiPlan | null {
  if (!planId) return null
  return API_PLANS[planId] || null
}

export function discountFor(planId?: string | null): number {
  return planFor(planId)?.discount ?? 0
}

export function rateLimitFor(planId?: string | null): number {
  return planFor(planId)?.rateLimitPerMin ?? FREE_RATE_LIMIT_PER_MIN
}

/** Format micro-USD for display, e.g. 1234567 -> "$1.234567" trimmed to 4dp. */
export function formatMicros(micros: bigint | number): string {
  const n = Number(micros) / MICROS_PER_USD
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`
}

export interface CostInput {
  kind: 'chat' | 'embedding' | 'image' | 'video'
  tokensIn?: number
  tokensOut?: number
  cachedTokensIn?: number
  units?: number
  /** Chat model tier — selects the per-token rate. Defaults to `standard`. */
  tier?: string | null
}

/**
 * Compute the gross cost of a request in micro-USD, before any plan discount.
 */
export function grossCostMicros(input: CostInput): number {
  const tokensIn = apiCount(input.tokensIn), tokensOut = apiCount(input.tokensOut)
  const cached = apiCount(input.cachedTokensIn)
  const units = apiCount(input.units ?? (input.kind === 'image' || input.kind === 'video' ? 1 : 0))
  if (cached > tokensIn) throw new ApiBillingError('invalid_amount')
  if (input.tier && !Object.prototype.hasOwnProperty.call(CHAT_TIER_RATES, input.tier)) throw new ApiBillingError('invalid_request')
  if (input.kind === 'image' || input.kind === 'video') return Number(apiAmount(BigInt(units) * BigInt(input.kind === 'image' ? RATE_IMAGE : RATE_VIDEO)))
  if (input.kind !== 'chat' && input.kind !== 'embedding') throw new ApiBillingError('invalid_request')
  const rates = chatRatesFor(input.tier)
  const numerator = BigInt(tokensIn - cached) * BigInt(rates.input) * 10n +
    BigInt(cached) * BigInt(rates.input) + BigInt(tokensOut) * BigInt(rates.output) * 10n
  return Number(apiAmount((numerator + 9_999_999n) / 10_000_000n))
}

/** Apply the account's monthly-plan discount to a gross cost. */
export function netCostMicros(gross: number, planId?: string | null): number {
  const amount = apiAmount(gross)
  const percent = BigInt(100 - Math.round(discountFor(planId) * 100))
  return Number((amount * percent + 99n) / 100n)
}

export interface ApiAccount {
  balanceMicros: bigint
  plan: string | null
  planName: string | null
  discount: number
  rateLimitPerMin: number
  previewGranted: boolean
}

export async function getApiAccount(userId: string): Promise<ApiAccount | null> {
  if (!hasDb || !prisma) return null
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { apiBalanceMicros: true, apiPlan: true, apiPreviewGranted: true },
  })
  if (!user) return null
  return {
    balanceMicros: user.apiBalanceMicros,
    plan: user.apiPlan,
    planName: planFor(user.apiPlan)?.name ?? null,
    discount: discountFor(user.apiPlan),
    rateLimitPerMin: rateLimitFor(user.apiPlan),
    previewGranted: user.apiPreviewGranted,
  }
}

/** Bound total credit (available + outstanding holds), preserving refund room. */
async function creditBalance(tx: Prisma.TransactionClient, userId: string, amount: bigint) {
  const holds = await tx.apiReservation.aggregate({ where: { userId, state: { in: ['reserved', 'dispatched', 'unknown'] } }, _sum: { amountMicros: true } })
  const limit = MAX_API_MICROS - amount - (holds._sum.amountMicros ?? 0n)
  const changed = await tx.user.updateMany({ where: { id: userId, apiBalanceMicros: { gte: 0n, lte: limit } }, data: { apiBalanceMicros: { increment: amount } } })
  if (changed.count !== 1) throw new ApiBillingError('invalid_amount')
}

/** Credit + ledger + dedup identity commit together. Historical rows are only
 * read: an existing matching reference is adopted, never credited a second time.
 * Historical conflicting duplicate references require manual reconciliation. */
export async function addBalance(
  userId: string,
  amountMicros: number | bigint,
  source: string,
  reference?: string
): Promise<void> {
  const amount = apiAmount(amountMicros)
  apiIdentifier(userId)
  apiIdentifier(source)
  const ref = reference?.trim() ? apiIdentifier(reference) : null
  await apiTransaction(async tx => {
    if (ref) {
      const previous = await tx.apiCreditIdentity.findUnique({ where: { source_reference: { source, reference: ref } } })
      if (previous) {
        if (previous.userId !== userId || previous.amountMicros !== amount) throw new ApiBillingError('conflict')
        return
      }
      const historical = await tx.apiTopUp.findMany({ where: { source, reference: ref }, select: { userId: true, amountMicros: true } })
      if (historical.some(row => row.userId !== userId || row.amountMicros !== amount)) throw new ApiBillingError('conflict')
      await tx.apiCreditIdentity.create({ data: { source, reference: ref, userId, amountMicros: amount } })
      if (historical.length) return
    }
    await creditBalance(tx, userId, amount)
    await tx.apiTopUp.create({ data: { userId, amountMicros: amount, source, reference: ref } })
  })
}

/**
 * Grant the one-time free preview credit. Returns true when it was granted.
 */
export async function grantPreviewCredit(userId: string): Promise<boolean> {
  apiIdentifier(userId)
  return apiTransaction(async tx => {
    const changed = await tx.user.updateMany({ where: { id: userId, apiPreviewGranted: false }, data: { apiPreviewGranted: true } })
    if (!changed.count) return false
    await creditBalance(tx, userId, BigInt(PREVIEW_CREDIT_MICROS))
    await tx.apiTopUp.create({ data: { userId, amountMicros: BigInt(PREVIEW_CREDIT_MICROS), source: 'preview', reference: `preview:${userId}` } })
    return true
  })
}

/**
 * Price and capture an existing reservation. There is deliberately no unreserved
 * post-work debit path: callers must reserve and claim dispatch first. Repeating
 * this call with the same settlement is idempotent; conflicting replays fail.
 */
export async function chargeUsage(params: {
  reservationId: string
  userId: string
  apiKeyId?: string | null
  kind: 'chat' | 'embedding' | 'image' | 'video'
  model?: string
  tokensIn?: number
  tokensOut?: number
  cachedTokensIn?: number
  units?: number
  planId?: string | null
  /** Chat model tier — selects the per-token rate. Defaults to `standard`. */
  tier?: string | null
}): Promise<number> {
  const gross = grossCostMicros(params)
  const net = netCostMicros(gross, params.planId)
  return captureApiReservation({
    id: params.reservationId, userId: params.userId, apiKeyId: params.apiKeyId,
    costMicros: net, tokensIn: params.tokensIn,
    tokensOut: params.tokensOut, units: params.units ?? (params.kind === 'image' || params.kind === 'video' ? 1 : 0),
    expectedKind: params.kind, expectedModel: params.model,
  })
}

/** Public pricing document served to the frontend and docs page. */
export function pricingConfig() {
  const catalog = chatModelCatalog()
  return {
    currency: 'USD',
    metering: {
      chat: 'Reserve the configured context budget; capture reported prompt and completion tokens, including tool/reasoning output. Missing usage requires reconciliation.',
      embeddings: 'Estimated tokens: UTF-8 input bytes plus two special tokens per input; maximum 262144 estimated tokens per request.',
      uncertainWork: 'Interrupted or uncertain work retains a visible reservation pending reconciliation; it is not automatically refunded.',
    },
    rates: {
      chatInputPerMillionTokens: RATE_CHAT_INPUT_PER_MTOK / MICROS_PER_USD,
      chatOutputPerMillionTokens: RATE_CHAT_OUTPUT_PER_MTOK / MICROS_PER_USD,
      cachedInputMultiplier: CACHED_INPUT_DISCOUNT,
      perImage: RATE_IMAGE / MICROS_PER_USD,
      perVideo: RATE_VIDEO / MICROS_PER_USD,
    },
    /** Per-model rate card. `chat*PerMillionTokens` above mirrors the standard tier. */
    models: catalog.map((m) => {
      const r = chatRatesFor(m.tier)
      return {
        id: m.id,
        tier: m.tier,
        label: m.label,
        description: m.description,
        contextTokens: m.contextTokens,
        inputPerMillionTokens: r.input / MICROS_PER_USD,
        outputPerMillionTokens: r.output / MICROS_PER_USD,
      }
    }),
    plans: Object.values(API_PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      priceUsd: p.priceUsd,
      discountPercent: Math.round(p.discount * 100),
      rateLimitPerMin: p.rateLimitPerMin,
      includedCreditUsd: p.includedCreditMicros / MICROS_PER_USD,
      highlights: p.highlights,
    })),
    payAsYouGo: {
      rateLimitPerMin: FREE_RATE_LIMIT_PER_MIN,
      previewCreditUsd: PREVIEW_CREDIT_MICROS / MICROS_PER_USD,
    },
    topUps: TOP_UP_OPTIONS,
  }
}
