/**
 * OAuth sign-in (Google / GitHub / Apple) and inbound-mail webhook.
 * Mounted at /api/auth (alongside password auth) and /api/mail.
 */
import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { prisma, hasDb } from '../services/prisma'
import { enabledProviders, providerEnabled, authorizeUrl, callbackUrl, exchangeCode, type OAuthProvider } from '../services/oauth'
import { welcomeEmail, alertEmail, verifyEmail, resetPasswordEmail } from '../services/email'
import { createToken, consumeToken } from '../services/tokens'
import { authenticateToken } from './auth'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'
const FRONTEND = () => (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')

export const oauthRouter = express.Router()
export const mailRouter = express.Router()

function reqBase(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol
  return `${proto}://${req.get('host')}`
}

/** GET /api/auth/providers — which sign-in methods the frontend should show. */
oauthRouter.get('/providers', (_req, res) => {
  const guest = process.env.ENABLE_DEV_MODE === 'true' || process.env.NODE_ENV === 'development'
  res.json({ providers: enabledProviders(), password: hasDb, guest })
})

/** GET /api/auth/oauth/:provider — start the OAuth flow. */
oauthRouter.get('/oauth/:provider', (req, res) => {
  const provider = req.params.provider as OAuthProvider
  if (!['google', 'github', 'apple'].includes(provider) || !providerEnabled(provider)) {
    return res.redirect(`${FRONTEND()}/login?error=provider_unavailable`)
  }
  if (!hasDb) return res.redirect(`${FRONTEND()}/login?error=db_required`)
  const state = jwt.sign({ provider }, JWT_SECRET, { expiresIn: '10m' })
  res.redirect(authorizeUrl(provider, callbackUrl(reqBase(req), provider), state))
})

async function handleCallback(req: express.Request, res: express.Response) {
  const provider = req.params.provider as OAuthProvider
  const code = (req.query.code || (req.body && req.body.code)) as string
  const state = (req.query.state || (req.body && req.body.state)) as string
  try {
    if (!hasDb || !prisma) throw new Error('database required')
    const decoded: any = jwt.verify(state, JWT_SECRET)
    if (decoded.provider !== provider) throw new Error('state mismatch')
    if (!code) throw new Error('missing code')

    const profile = await exchangeCode(provider, code, callbackUrl(reqBase(req), provider))
    const email = profile.email.toLowerCase()

    let user = await prisma.user.findUnique({ where: { email } })
    let isNew = false
    if (!user) {
      const userCount = await prisma.user.count()
      const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase()
      const isAdmin = userCount === 0 || (!!adminEmail && email === adminEmail)
      const randomPw = await bcrypt.hash(`oauth:${provider}:${profile.providerId}:${Date.now()}`, 10)
      user = await prisma.user.create({
        data: { email, name: profile.name || email.split('@')[0], password: randomPw, role: isAdmin ? 'admin' : 'user' },
      })
      isNew = true
      welcomeEmail(email, user.name).catch(() => {})
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' })
    const dest = new URLSearchParams({ token, name: user.name, email: user.email, role: user.role })
    if (isNew) dest.set('welcome', '1')
    res.redirect(`${FRONTEND()}/login?${dest.toString()}`)
  } catch (e: any) {
    console.error(`[oauth:${provider}] callback error:`, e?.message)
    res.redirect(`${FRONTEND()}/login?error=${encodeURIComponent(e?.message || 'oauth_failed')}`)
  }
}

// Google/GitHub return via GET; Apple posts a form (response_mode=form_post).
oauthRouter.get('/oauth/:provider/callback', handleCallback)
oauthRouter.post('/oauth/:provider/callback', express.urlencoded({ extended: true }), handleCallback)

// ---- Email verification -----------------------------------------------------

/** POST /api/auth/verify { token } — confirm an email address. */
oauthRouter.post('/verify', async (req, res) => {
  const userId = await consumeToken(String(req.body?.token || ''), 'verify')
  if (!userId || !prisma) return res.status(400).json({ error: 'Invalid or expired verification link.' })
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } })
  res.json({ ok: true })
})

/** POST /api/auth/resend-verification — re-send the verification email (auth). */
oauthRouter.post('/resend-verification', authenticateToken, async (req, res) => {
  const userId = (req as any).userId
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Requires a database.' })
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return res.status(404).json({ error: 'User not found.' })
  if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true })
  const token = await createToken(user.id, 'verify')
  if (token) verifyEmail(user.email, user.name, `${FRONTEND()}/verify?token=${token}`).catch(() => {})
  res.json({ ok: true })
})

// ---- Password reset ---------------------------------------------------------

/** POST /api/auth/forgot { email } — email a reset link. Always returns ok. */
oauthRouter.post('/forgot', async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim()
  if (prisma && email) {
    const user = await prisma.user.findUnique({ where: { email } })
    if (user) {
      const token = await createToken(user.id, 'reset')
      if (token) resetPasswordEmail(user.email, user.name, `${FRONTEND()}/reset?token=${token}`).catch(() => {})
    }
  }
  // Don't leak whether the email exists.
  res.json({ ok: true })
})

/** POST /api/auth/reset { token, password } — set a new password. */
oauthRouter.post('/reset', async (req, res) => {
  const { token, password } = req.body || {}
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  const userId = await consumeToken(String(token || ''), 'reset')
  if (!userId || !prisma) return res.status(400).json({ error: 'Invalid or expired reset link.' })
  const hashed = await bcrypt.hash(String(password), 10)
  await prisma.user.update({ where: { id: userId }, data: { password: hashed } })
  res.json({ ok: true })
})

/**
 * POST /api/mail/inbound — inbound email webhook. Point an inbound provider
 * (SES/Mailgun/Postmark inbound route, or your MX → webhook) here to receive
 * account-related replies/alerts. Secured with MAIL_INBOUND_SECRET when set.
 */
mailRouter.post('/inbound', express.json({ limit: '10mb' }), express.urlencoded({ extended: true }), async (req, res) => {
  const secret = process.env.MAIL_INBOUND_SECRET
  if (secret && req.query.secret !== secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const b: any = req.body || {}
  const from = b.from || b.sender || b.From || 'unknown'
  const subject = b.subject || b.Subject || '(no subject)'
  const text = b.text || b['body-plain'] || b.TextBody || ''
  console.log(`[mail:inbound] from=${from} subject="${subject}" len=${String(text).length}`)
  // Forward a copy to the support inbox if configured.
  const support = process.env.SUPPORT_EMAIL
  if (support) {
    alertEmail(support, `[Inbound] ${subject}`, `From: ${from}<br><br>${String(text).replace(/\n/g, '<br>').slice(0, 5000)}`).catch(() => {})
  }
  res.json({ ok: true })
})

export default oauthRouter
