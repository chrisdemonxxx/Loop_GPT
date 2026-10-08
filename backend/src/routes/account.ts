/**
 * Per-user account + billing endpoints: profile/credits, recent usage, and
 * voucher redemption. All DB-backed; degrade to permissive/dev responses when
 * no database is configured.
 */
import express from 'express'
import { z } from 'zod'
import { generateSecret, generateURI, verifySync } from 'otplib'
import { asyncHandler } from '../middleware/errorLogger'
import { byUser, rateLimiter } from '../middleware/rateLimiter'
import { authenticateToken, revokeAndIssueSession } from './auth'
import { clientUsedBearer } from '../services/auth'
import { prisma, hasDb } from '../services/prisma'
import { getAccount, redeemVoucher } from '../services/billing'
import { voucherRedeemedEmail } from '../services/email'

const router = express.Router()
// Guessable secrets (voucher codes, 6-digit TOTP) get small per-account budgets.
const redeemLimit = rateLimiter(15 * 60 * 1000, 10, { key: byUser })
const totpLimit = rateLimiter(15 * 60 * 1000, 10, { key: byUser })
const usageQuery = z.object({
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).refine(value => value <= 200).optional(),
}).strict()

/** GET /api/account/me — profile, plan, remaining credits, lifetime usage. */
router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
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
}))

/** GET /api/account/usage — recent usage events for the signed-in user. */
router.get('/usage', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const query = usageQuery.safeParse(req.query)
  if (!query.success) return res.status(400).json({ error: 'limit must be an integer from 1 to 200' })
  if (!hasDb || !prisma) return res.json({ events: [], hasDb: false })
  const take = query.data.limit ?? 50
  const events = await prisma.usageEvent.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
  })
  res.json({ events, hasDb: true })
}))

/** POST /api/account/redeem { code } — redeem a voucher. */
router.post('/redeem', authenticateToken, redeemLimit, asyncHandler(async (req, res) => {
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
}))

// ---- TOTP MFA (brief P2) ------------------------------------------------------

const totpBody = z.object({ token: z.string().regex(/^\d{6}$/) }).strict()

/** POST /api/account/totp/setup — generate a secret + otpauth URI (QR-encodable). */
router.post('/totp/setup', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  if (!hasDb || !prisma) return res.status(503).json({ error: 'MFA requires a database.' })
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, totpEnabled: true } })
  if (!user) return res.status(404).json({ error: 'User not found.' })
  if (user.totpEnabled) return res.status(400).json({ error: 'Two-factor is already enabled. Disable it first to re-enroll.' })
  const secret = generateSecret()
  await prisma.user.update({ where: { id: userId }, data: { totpSecret: secret, totpEnabled: false } })
  const uri = generateURI({ issuer: 'Loop GPT', label: user.email, secret })
  res.json({ secret, uri })
}))

/** POST /api/account/totp/verify { token } — confirm and enable. */
router.post('/totp/verify', authenticateToken, totpLimit, asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  if (!hasDb || !prisma) return res.status(503).json({ error: 'MFA requires a database.' })
  const parsed = totpBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'token must be a 6-digit code.' })
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecret: true, totpEnabled: true } })
  if (!user?.totpSecret) return res.status(400).json({ error: 'Run setup first.' })
  if (user.totpEnabled) return res.json({ ok: true, alreadyEnabled: true })
  if (!verifySync({ token: parsed.data.token, secret: user.totpSecret, epochTolerance: 30 }).valid) {
    return res.status(400).json({ error: 'That code is not valid. Try the next one.' })
  }
  const token = await revokeAndIssueSession(res, userId, { totpEnabled: true })
  res.json(clientUsedBearer(req) ? { ok: true, enabled: true, token } : { ok: true, enabled: true })
}))

/** POST /api/account/totp/disable { token } — disable (requires a valid code). */
router.post('/totp/disable', authenticateToken, totpLimit, asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  if (!hasDb || !prisma) return res.status(503).json({ error: 'MFA requires a database.' })
  const parsed = totpBody.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'token must be a 6-digit code.' })
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecret: true, totpEnabled: true } })
  if (!user?.totpEnabled || !user.totpSecret) return res.status(400).json({ error: 'Two-factor is not enabled.' })
  if (!verifySync({ token: parsed.data.token, secret: user.totpSecret, epochTolerance: 30 }).valid) {
    return res.status(400).json({ error: 'That code is not valid.' })
  }
  const token = await revokeAndIssueSession(res, userId, { totpEnabled: false, totpSecret: null })
  res.json(clientUsedBearer(req) ? { ok: true, enabled: false, token } : { ok: true, enabled: false })
}))

export default router


