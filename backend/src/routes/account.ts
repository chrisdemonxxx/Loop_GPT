/**
 * Per-user account + billing endpoints: profile/credits, recent usage, and
 * voucher redemption. All DB-backed; degrade to permissive/dev responses when
 * no database is configured.
 */
import express from 'express'
import { authenticateToken } from './auth'
import { prisma, hasDb } from '../services/prisma'
import { getAccount, redeemVoucher } from '../services/billing'
import { voucherRedeemedEmail } from '../services/email'

const router = express.Router()

/** GET /api/account/me — profile, plan, remaining credits, lifetime usage. */
router.get('/me', authenticateToken, async (req, res) => {
  const userId = (req as any).userId
  const acct = await getAccount(userId)
  if (!acct) {
    // No DB (local/dev): report an unlimited guest so the UI renders cleanly.
    return res.json({
      id: userId,
      email: 'guest@loop-gpt.local',
      name: 'Guest',
      role: 'user',
      plan: 'free',
      unlimited: true,
      credits: Infinity as any,
      imageCredits: Infinity as any,
      limits: { credits: 0, imageCredits: 0 },
      usage: { tokensIn: 0, tokensOut: 0, images: 0, messages: 0 },
      hasDb: false,
    })
  }
  res.json(acct)
})

/** GET /api/account/usage — recent usage events for the signed-in user. */
router.get('/usage', authenticateToken, async (req, res) => {
  const userId = (req as any).userId
  if (!hasDb || !prisma) return res.json({ events: [], hasDb: false })
  const take = Math.min(Number(req.query.limit) || 50, 200)
  const events = await prisma.usageEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
  })
  res.json({ events, hasDb: true })
})

/** POST /api/account/redeem { code } — redeem a voucher. */
router.post('/redeem', authenticateToken, async (req, res) => {
  const userId = (req as any).userId
  const { code } = req.body || {}
  const result = await redeemVoucher(userId, code)
  if (!result.ok) return res.status(400).json(result)
  const acct = await getAccount(userId)
  if (acct?.email) {
    const a: any = result.applied || {}
    const summary = a.unlimited ? 'Unlimited access' : `${a.plan ? a.plan.toUpperCase() + ' plan' : ''}${a.credits ? ` +${a.credits} credits` : ''}${a.imageCredits ? ` +${a.imageCredits} images` : ''}`.trim() || 'credits'
    voucherRedeemedEmail(acct.email, acct.name, summary).catch(() => {})
  }
  res.json({ ...result, account: acct })
})

export default router
