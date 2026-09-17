/**
 * Developer dashboard endpoints (JWT-authed) for managing API keys, prepaid
 * balance and usage. The public API itself lives in `routes/v1.ts`.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { z } from 'zod'
import { authenticateToken } from './auth'
import { prisma, hasDb } from '../services/prisma'
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys'
import {
  API_PLANS,
  MICROS_PER_USD,
  PREVIEW_CREDIT_MICROS,
  getApiAccount,
  grantPreviewCredit,
  pricingConfig,
  planFor,
} from '../services/apiBilling'

const router = express.Router()

function requireDb(res: express.Response): boolean {
  if (!hasDb || !prisma) {
    res.status(503).json({ error: 'The developer API requires a configured database.' })
    return false
  }
  return true
}

/** GET /api/developer/overview — balance, plan, keys and usage in one call. */
router.get('/overview', authenticateToken, asyncHandler(async (req, res) => {
  if (!requireDb(res)) return
  const userId = (req as any).userId
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [account, keys, agg, recent] = await Promise.all([
    getApiAccount(userId),
    listApiKeys(userId),
    prisma!.apiUsage.aggregate({
      where: { userId, createdAt: { gte: since } },
      _sum: { costMicros: true, tokensIn: true, tokensOut: true, units: true },
      _count: true,
    }),
    prisma!.apiUsage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        kind: true,
        model: true,
        tokensIn: true,
        tokensOut: true,
        units: true,
        costMicros: true,
        createdAt: true,
      },
    }),
  ])

  res.json({
    balanceUsd: Number(account?.balanceMicros ?? 0n) / MICROS_PER_USD,
    plan: account?.plan ?? null,
    planName: account?.planName ?? null,
    discountPercent: Math.round((account?.discount ?? 0) * 100),
    rateLimitPerMin: account?.rateLimitPerMin ?? 20,
    previewGranted: account?.previewGranted ?? false,
    previewCreditUsd: PREVIEW_CREDIT_MICROS / MICROS_PER_USD,
    keys,
    usage: {
      requests: agg._count,
      tokensIn: agg._sum.tokensIn || 0,
      tokensOut: agg._sum.tokensOut || 0,
      units: agg._sum.units || 0,
      spendUsd: Number(agg._sum.costMicros ?? 0n) / MICROS_PER_USD,
    },
    recent: recent.map((r) => ({
      id: r.id,
      kind: r.kind,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      units: r.units,
      costUsd: Number(r.costMicros) / MICROS_PER_USD,
      createdAt: r.createdAt,
    })),
    pricing: pricingConfig(),
  })
}))

const createSchema = z.object({ name: z.string().trim().min(1).max(60).optional() })

/**
 * POST /api/developer/keys — issue a key. The plaintext value is returned once
 * and never again. Grants the free preview credit on the first key.
 */
router.post('/keys', authenticateToken, asyncHandler(async (req, res) => {
  if (!requireDb(res)) return
  const parsed = createSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ error: 'Invalid key name.' })
  const userId = (req as any).userId

  const existing = await prisma!.apiKey.count({ where: { userId, revoked: false } })
  if (existing >= 20) {
    return res.status(400).json({ error: 'Key limit reached (20). Revoke an unused key first.' })
  }

  try {
    const issued = await createApiKey(userId, parsed.data.name)
    const grantedPreview = await grantPreviewCredit(userId)
    res.status(201).json({
      id: issued.id,
      name: issued.name,
      key: issued.key,
      prefix: issued.prefix,
      createdAt: issued.createdAt,
      grantedPreview,
      previewCreditUsd: grantedPreview ? PREVIEW_CREDIT_MICROS / MICROS_PER_USD : 0,
    })
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Could not create API key.' })
  }
}))

/** GET /api/developer/keys — masked list. */
router.get('/keys', authenticateToken, asyncHandler(async (req, res) => {
  if (!requireDb(res)) return
  res.json(await listApiKeys((req as any).userId))
}))

/** DELETE /api/developer/keys/:id — revoke. */
router.delete('/keys/:id', authenticateToken, asyncHandler(async (req, res) => {
  if (!requireDb(res)) return
  const ok = await revokeApiKey((req as any).userId, req.params.id)
  if (!ok) return res.status(404).json({ error: 'Key not found.' })
  res.json({ ok: true })
}))

/** GET /api/developer/pricing — public rate card for the docs UI. */
router.get('/pricing', (_req, res) => res.json(pricingConfig()))

/** GET /api/developer/plans — plan catalogue. */
router.get('/plans', (_req, res) =>
  res.json(
    Object.values(API_PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      priceUsd: p.priceUsd,
      discountPercent: Math.round(p.discount * 100),
      rateLimitPerMin: p.rateLimitPerMin,
      includedCreditUsd: p.includedCreditMicros / MICROS_PER_USD,
      highlights: p.highlights,
    }))
  )
)

export default router
export { planFor }
