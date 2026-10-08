/**
 * OAuth sign-in (Google / GitHub / Apple) and inbound-mail webhook.
 * Mounted at /api/auth (alongside password auth) and /api/mail.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { prisma, hasDb } from '../services/prisma'
import { enabledProviders, providerEnabled, authorizeUrl, callbackUrl, exchangeCode, type OAuthProvider, type OAuthProfile } from '../services/oauth'
import { connectorStateExists, completeConnectorCallback } from './oauthConnector'
import { welcomeEmail, alertEmail, verifyEmail, resetPasswordEmail } from '../services/email'
import { createToken, consumeToken, peekToken, revokeToken } from '../services/tokens'
import { jwtSecret } from '../services/jwtSecret'
import { authenticateToken, checkTotp, issueBrowserSession } from './auth'

// FRONTEND_URL may be a comma-separated allow-list of origins (for CORS); the
// first entry is the canonical app origin used for redirects.
const FRONTEND = () => (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')[0].trim().replace(/\/+$/, '')

// ── Login-CSRF binding ───────────────────────────────────────────────────────
// The state JWT carries a hash of a random nonce that is also set as an
// httpOnly cookie on the browser that started the flow. A callback that
// arrives without the matching cookie (an attacker's own code/state pasted
// into a victim's browser) is refused.
const STATE_COOKIE = 'loop_oauth_nonce'
const STATE_TTL_SECONDS = 600

function stateCookieAttributes(maxAgeSeconds: number): string {
  const production = process.env.NODE_ENV === 'production'
  // Apple returns with a cross-site form POST, which only carries
  // SameSite=None cookies; those must be Secure.
  const parts = [`Path=/`, `Max-Age=${maxAgeSeconds}`, 'HttpOnly', production ? 'SameSite=None' : 'SameSite=Lax']
  if (production) parts.push('Secure')
  const domain = (process.env.OAUTH_STATE_COOKIE_DOMAIN || '').trim()
  if (/^\.?[a-z0-9.-]+$/i.test(domain)) parts.push(`Domain=${domain}`)
  return parts.join('; ')
}

function readCookie(req: express.Request, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

function nonceHash(nonce: string): string {
  return crypto.createHash('sha256').update(nonce).digest('base64url')
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

/** Error codes the login page may display. Never raw exception text. */
type LoginError = 'provider_unavailable' | 'db_required' | 'invalid_state' | 'oauth_failed' | 'email_unverified' | 'account_exists'

function loginRedirect(res: express.Response, params: Record<string, string>) {
  res.setHeader('Cache-Control', 'no-store')
  res.redirect(`${FRONTEND()}/login/?${new URLSearchParams(params).toString()}`)
}

class OAuthLoginError extends Error {
  constructor(public readonly code: LoginError) { super(code) }
}

/** Resolve the account for a provider identity. Links by provider subject id;
 *  falls back to email only when BOTH sides have verified that address. */
async function resolveOAuthUser(provider: OAuthProvider, profile: OAuthProfile) {
  const db = prisma!
  const providerUserId = String(profile.providerId || '')
  if (!providerUserId) throw new OAuthLoginError('oauth_failed')
  const email = String(profile.email || '').toLowerCase()

  const identity = await db.oAuthIdentity.findUnique({
    where: { provider_providerUserId: { provider, providerUserId } },
    include: { user: true },
  })
  if (identity?.user) return { user: identity.user, isNew: false }

  if (!profile.emailVerified || !email) throw new OAuthLoginError('email_unverified')

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    // An unverified local account could have been registered by anyone who
    // typed this address; do not hand it to whoever controls the provider
    // account (or vice versa) without proof on both sides.
    if (!existing.emailVerified) throw new OAuthLoginError('account_exists')
    await db.oAuthIdentity.create({ data: { userId: existing.id, provider, providerUserId, email } })
    return { user: existing, isNew: false }
  }

  const randomPw = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10)
  const user = await db.user.create({
    // Public OAuth signup never provisions platform administrators.
    data: { email, name: profile.name || email.split('@')[0], password: randomPw, role: 'user', emailVerified: true,
      oauthIdentities: { create: { provider, providerUserId, email } } },
  })
  welcomeEmail(email, user.name).catch(() => {})
  return { user, isNew: true }
}

export const oauthRouter = express.Router()
export const mailRouter = express.Router()

/**
 * Root-level OAuth initiation relay. LibreChat builds its social-login button
 * hrefs from DOMAIN_SERVER (this api host), so /oauth/<provider> must exist
 * here: it 302s the browser to the live app's initiation endpoint, which then
 * runs the real flow (state cookie on the app domain, whitelisted callback).
 */
export const oauthRelayRouter = express.Router()
oauthRelayRouter.get('/oauth/:provider', (req, res) => {
  const target = (process.env.OAUTH_BRIDGE_TARGET || '').replace(/\/+$/, '')
  if (!target) return res.status(404).json({ error: 'oauth relay disabled' })
  const provider = req.params.provider
  if (!['google', 'github', 'apple'].includes(provider)) {
    return res.status(404).json({ error: 'unknown provider' })
  }
  res.redirect(`${target}/oauth/${provider}`)
})

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
    return res.redirect(`${FRONTEND()}/login/?error=provider_unavailable`)
  }
  if (!hasDb) return res.redirect(`${FRONTEND()}/login/?error=db_required`)
  const nonce = crypto.randomBytes(32).toString('base64url')
  const state = jwt.sign({ provider, nh: nonceHash(nonce) }, jwtSecret(), { expiresIn: STATE_TTL_SECONDS })
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=${nonce}; ${stateCookieAttributes(STATE_TTL_SECONDS)}`)
  res.setHeader('Cache-Control', 'no-store')
  res.redirect(authorizeUrl(provider, callbackUrl(reqBase(req), provider), state))
})

async function handleCallback(req: express.Request, res: express.Response) {
  const provider = req.params.provider as OAuthProvider
  const code = (req.query.code || (req.body && req.body.code)) as string
  const state = (req.query.state || (req.body && req.body.state)) as string
  // Connector OAuth rides this same registered callback (the
  // redirect_uri_mismatch fix, 2026-10-05): connector states are hex PKCE
  // handles, login states are JWTs — check the connector store FIRST and
  // BEFORE the bridge relay below, or a bridge target (if ever configured)
  // would swallow every connector completion into a login-app hop.
  if (state && connectorStateExists(state)) {
    return completeConnectorCallback(code, state, res)
  }  // OAuth bridge relay: when OAUTH_BRIDGE_TARGET is set, this callback acts as a
  // transparent passthrough for the Google-registered redirect_uri
  // (https://api.loop-gpt.cyou/api/auth/oauth/<provider>/callback). It 302s the
  // browser — carrying code/state verbatim — to the active app's callback
  // (<target>/oauth/<provider>/callback), which performs the actual code
  // exchange with the identical redirect_uri string. Token exchange validates
  // redirect_uri as a string, so the relay is fully protocol-legal.
  // Note: Apple's form_post variant loses its body across the hop (unused).
  const bridgeTarget = (process.env.OAUTH_BRIDGE_TARGET || '').replace(/\/+$/, '')
  if (bridgeTarget) {
    const merged: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.query)) {
      merged[k] = Array.isArray(v) ? String(v[0]) : String(v)
    }
    if (req.body && typeof req.body === 'object') {
      for (const [k, v] of Object.entries(req.body)) {
        if (merged[k] === undefined && typeof v === 'string') merged[k] = v
      }
    }
    const fwd = new URLSearchParams(merged)
    return res.redirect(`${bridgeTarget}/oauth/${provider}/callback?${fwd.toString()}`)
  }

  // The nonce cookie is single-use whatever the outcome.
  const nonce = readCookie(req, STATE_COOKIE)
  res.setHeader('Set-Cookie', `${STATE_COOKIE}=; ${stateCookieAttributes(0)}`)
  if (!hasDb || !prisma) return loginRedirect(res, { error: 'db_required' })
  let decoded: any
  try { decoded = jwt.verify(String(state || ''), jwtSecret(), { algorithms: ['HS256'] }) } catch { decoded = null }
  if (!decoded || decoded.provider !== provider || typeof decoded.nh !== 'string' || !nonce || !sameHash(decoded.nh, nonceHash(nonce))) {
    return loginRedirect(res, { error: 'invalid_state' })
  }
  if (!code) return loginRedirect(res, { error: 'oauth_failed' })

  try {
    const profile = await exchangeCode(provider, code, callbackUrl(reqBase(req), provider))
    const { user, isNew } = await resolveOAuthUser(provider, profile)
    // The browser gets a short-lived one-time code, never the session JWT:
    // URLs leak into history, logs and Referer headers. The app swaps it at
    // POST /api/auth/oauth/exchange (which also enforces TOTP).
    const handoff = await createToken(user.id, 'oauth')
    if (!handoff) return loginRedirect(res, { error: 'db_required' })
    const dest: Record<string, string> = { oauth_code: handoff }
    if (isNew) dest.welcome = '1'
    if (process.env.OAUTH_LEGACY_TOKEN_REDIRECT === 'true' && !user.totpEnabled) {
      // Temporary rollback switch for clients that predate the exchange step.
      Object.assign(dest, { token: issueBrowserSession(res, user.id), name: user.name, email: user.email, role: user.role })
    }
    loginRedirect(res, dest)
  } catch (e: any) {
    if (e instanceof OAuthLoginError) return loginRedirect(res, { error: e.code })
    console.error(`[oauth:${provider}] callback failed`)
    loginRedirect(res, { error: 'oauth_failed' })
  }
}

/** POST /api/auth/oauth/exchange { code, totp? } — swap the one-time sign-in
 *  code for a session. Accounts with TOTP get 401 { totpRequired: true }
 *  until a valid code is supplied; five bad codes burn the hand-off. */
const handoffFailures = new Map<string, number>()
const MAX_HANDOFF_FAILURES = 5
oauthRouter.post('/oauth/exchange', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Sign-in requires a database.' })
  const code = typeof req.body?.code === 'string' ? req.body.code : ''
  if (!/^[a-f0-9]{48}$/.test(code)) return res.status(400).json({ error: 'Invalid or expired sign-in code.' })
  const live = await peekToken(code, 'oauth')
  if (!live) return res.status(400).json({ error: 'Invalid or expired sign-in code.' })
  const user = await prisma.user.findUnique({ where: { id: live.userId } })
  if (!user) return res.status(400).json({ error: 'Invalid or expired sign-in code.' })
  const totpError = await checkTotp(user, req.body?.totp)
  if (totpError) {
    if (req.body?.totp !== undefined) {
      const failures = (handoffFailures.get(live.id) || 0) + 1
      handoffFailures.set(live.id, failures)
      if (failures >= MAX_HANDOFF_FAILURES) { handoffFailures.delete(live.id); await revokeToken(live.id) }
    }
    return res.status(401).json({ error: totpError, totpRequired: true })
  }
  const userId = await consumeToken(code, 'oauth')
  handoffFailures.delete(live.id)
  if (userId !== user.id) return res.status(400).json({ error: 'Invalid or expired sign-in code.' })
  const token = issueBrowserSession(res, user.id)
  res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } })
}))

// Google/GitHub return via GET; Apple posts a form (response_mode=form_post).
oauthRouter.get('/oauth/:provider/callback', asyncHandler(handleCallback))
oauthRouter.post('/oauth/:provider/callback', express.urlencoded({ extended: true }), asyncHandler(handleCallback))

// ---- Email verification -----------------------------------------------------

/** POST /api/auth/verify { token } — confirm an email address. */
oauthRouter.post('/verify', asyncHandler(async (req, res) => {
  const userId = await consumeToken(String(req.body?.token || ''), 'verify')
  if (!userId || !prisma) return res.status(400).json({ error: 'Invalid or expired verification link.' })
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } })
  res.json({ ok: true })
}))

/** POST /api/auth/resend-verification — re-send the verification email (auth). */
oauthRouter.post('/resend-verification', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Requires a database.' })
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user) return res.status(404).json({ error: 'User not found.' })
  if (user.emailVerified) return res.json({ ok: true, alreadyVerified: true })
  const token = await createToken(user.id, 'verify')
  if (token) verifyEmail(user.email, user.name, `${FRONTEND()}/verify/?token=${token}`).catch(() => {})
  res.json({ ok: true })
}))

// ---- Password reset ---------------------------------------------------------

/** POST /api/auth/forgot { email } — email a reset link. Always returns ok. */
oauthRouter.post('/forgot', asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim()
  if (prisma && email) {
    const user = await prisma.user.findUnique({ where: { email } })
    if (user) {
      const token = await createToken(user.id, 'reset')
      if (token) resetPasswordEmail(user.email, user.name, `${FRONTEND()}/reset/?token=${token}`).catch(() => {})
    }
  }
  // Don't leak whether the email exists.
  res.json({ ok: true })
}))

/** POST /api/auth/reset { token, password } — set a new password. */
oauthRouter.post('/reset', asyncHandler(async (req, res) => {
  const { token, password } = req.body || {}
  if (!password || String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  const userId = await consumeToken(String(token || ''), 'reset')
  if (!userId || !prisma) return res.status(400).json({ error: 'Invalid or expired reset link.' })
  const hashed = await bcrypt.hash(String(password), 10)
  // Stamp the invalidation instant: every JWT issued before now is rejected.
  await prisma.user.update({ where: { id: userId }, data: { password: hashed, sessionInvalidatedAt: new Date() } })
  res.json({ ok: true })
}))

/**
 * POST /api/mail/inbound — inbound email webhook. Point an inbound provider
 * (SES/Mailgun/Postmark inbound route, or your MX → webhook) here to receive
 * account-related replies/alerts. Requires MAIL_INBOUND_SECRET, sent in the
 * `x-webhook-secret` header (never the query string, which ends up in logs).
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
function oneLine(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex -- deliberate: strip control characters from log/header fields
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max)
}

mailRouter.post('/inbound', express.json({ limit: '2mb' }), express.urlencoded({ extended: true, limit: '2mb' }), asyncHandler(async (req, res) => {
  const secret = process.env.MAIL_INBOUND_SECRET
  if (!secret) return res.status(503).json({ error: 'inbound mail is not configured' })
  const supplied = req.headers['x-webhook-secret']
  const expected = crypto.createHash('sha256').update(secret).digest()
  const actual = crypto.createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest()
  if (typeof supplied !== 'string' || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const b: any = req.body || {}
  const from = oneLine(b.from || b.sender || b.From || 'unknown', 320)
  const subject = oneLine(b.subject || b.Subject || '(no subject)', 300)
  const text = String(b.text || b['body-plain'] || b.TextBody || '')
  console.log(`[mail:inbound] from=${JSON.stringify(from)} subject=${JSON.stringify(subject)} len=${text.length}`)
  // Forward a copy to the support inbox if configured.
  const support = process.env.SUPPORT_EMAIL
  if (support) {
    alertEmail(support, `[Inbound] ${subject}`, `From: ${escapeHtml(from)}<br><br>${escapeHtml(text.slice(0, 5000)).replace(/\n/g, '<br>')}`).catch(() => {})
  }
  res.json({ ok: true })
}))

export default oauthRouter
