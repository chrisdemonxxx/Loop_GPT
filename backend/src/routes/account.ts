/**
 * Per-user account + billing endpoints: profile/credits, recent usage, and
 * voucher redemption. All DB-backed; degrade to permissive/dev responses when
 * no database is configured.
 */
import express from 'express'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { generateSecret, generateURI, verifySync } from 'otplib'
import { asyncHandler } from '../middleware/errorLogger'
import { byUser, rateLimiter } from '../middleware/rateLimiter'
import { authenticateToken, revokeAndIssueSession } from './auth'
import { clearSessionCookie, clientUsedBearer } from '../services/auth'
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

// ---- Export and delete --------------------------------------------------------
// Password hashes and TOTP secrets are never selected. Conversations and
// messages leave with the user through onDelete: Cascade when the row is removed.

const exportProfileSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  plan: true,
  unlimited: true,
  emailVerified: true,
  createdAt: true,
  updatedAt: true,
  credits: true,
  imageCredits: true,
  creditsResetAt: true,
  memoryEnabled: true,
  consentTraining: true,
  totpEnabled: true,
  tokensInTotal: true,
  tokensOutTotal: true,
  imagesTotal: true,
  messagesTotal: true,
  lastActiveAt: true,
} satisfies Omit<Prisma.UserSelect, 'password' | 'totpSecret'>

const exportMessageSelect = {
  id: true,
  role: true,
  content: true,
  createdAt: true,
  messageType: true,
  imageUrl: true,
  toolUsed: true,
  metadata: true,
  parentId: true,
  authorBotId: true,
} satisfies Prisma.MessageSelect

const exportConversationSelect = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  incognito: true,
  pinned: true,
  kind: true,
  botId: true,
  botIds: true,
  activeLeafId: true,
  messages: { orderBy: { createdAt: 'asc' }, select: exportMessageSelect },
} satisfies Prisma.ConversationSelect

type ExportUser = Prisma.UserGetPayload<{ select: typeof exportProfileSelect }>
type ExportConversation = Prisma.ConversationGetPayload<{ select: typeof exportConversationSelect }>

function exportProfile(user: ExportUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    unlimited: user.unlimited,
    emailVerified: user.emailVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    credits: user.credits,
    imageCredits: user.imageCredits,
    creditsResetAt: user.creditsResetAt,
    memoryEnabled: user.memoryEnabled,
    consentTraining: user.consentTraining,
    totpEnabled: user.totpEnabled,
    lastActiveAt: user.lastActiveAt,
    usage: {
      tokensIn: user.tokensInTotal.toString(),
      tokensOut: user.tokensOutTotal.toString(),
      images: user.imagesTotal,
      messages: user.messagesTotal,
    },
  }
}

function exportConversation(conversation: ExportConversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    incognito: conversation.incognito,
    pinned: conversation.pinned,
    kind: conversation.kind,
    botId: conversation.botId,
    botIds: conversation.botIds,
    activeLeafId: conversation.activeLeafId,
    messages: conversation.messages.map(message => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      messageType: message.messageType,
      imageUrl: message.imageUrl,
      toolUsed: message.toolUsed,
      metadata: message.metadata,
      parentId: message.parentId,
      authorBotId: message.authorBotId,
    })),
  }
}

function missingRow(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2025'
}

/** GET /api/account/export — JSON download of the signed-in profile, chats, and messages. */
router.get('/export', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Account export requires a database.' })
  const user = await prisma.user.findUnique({ where: { id: userId }, select: exportProfileSelect })
  if (!user) return res.status(401).json({ error: 'Session is no longer valid.' })
  const conversations = await prisma.conversation.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: exportConversationSelect,
  })
  res.set('Cache-Control', 'no-store')
  res.set('Content-Disposition', 'attachment; filename="loop-gpt-export.json"')
  res.json({
    exportedAt: new Date().toISOString(),
    profile: exportProfile(user),
    conversations: conversations.map(exportConversation),
  })
}))

/** DELETE /api/account — remove the signed-in user. Related rows follow onDelete: Cascade. */
router.delete('/', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Account deletion requires a database.' })
  try {
    await prisma.user.delete({ where: { id: userId } })
  } catch (error) {
    if (!missingRow(error)) throw error
  }
  clearSessionCookie(res)
  res.set('Cache-Control', 'no-store')
  res.json({ ok: true })
}))

export default router


