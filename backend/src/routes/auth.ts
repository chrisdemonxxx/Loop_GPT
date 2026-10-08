import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { asyncHandler } from '../middleware/errorLogger'
import { validate, validationSchemas } from '../middleware/validation'
import { prisma, hasDb } from '../services/prisma'
import { welcomeEmail, verifyEmail } from '../services/email'
import { createToken } from '../services/tokens'
import { jwtSecret } from '../services/jwtSecret'
import {
  clearSessionCookie, clientUsedBearer, readSessionCookie, revokeUserSessions, sessionIatAfter, setSessionCookie,
} from '../services/auth'

const router = express.Router()

/** Issue a session JWT for a user. `iatSeconds` is set when replacing a revoked session. */
export function signSession(userId: string, iatSeconds?: number): string {
  const payload: jwt.JwtPayload = { userId }
  if (iatSeconds !== undefined) payload.iat = iatSeconds
  return jwt.sign(payload, jwtSecret(), { expiresIn: '7d' })
}

/** Sign a session and set the httpOnly cookie. The token is still returned for bearer clients. */
export function issueBrowserSession(res: express.Response, userId: string, iatSeconds?: number): string {
  const token = signSession(userId, iatSeconds)
  setSessionCookie(res, token)
  return token
}

/** Stamp sessionInvalidatedAt, then issue a replacement cookie for this caller. */
export async function revokeAndIssueSession(
  res: express.Response,
  userId: string,
  extra?: { totpEnabled?: boolean; totpSecret?: string | null },
): Promise<string> {
  const invalidatedAt = await revokeUserSessions(userId, extra)
  return issueBrowserSession(res, userId, sessionIatAfter(invalidatedAt))
}

/** TOTP second factor. Returns null when satisfied, else the client-facing error. */
export async function checkTotp(user: { totpEnabled: boolean; totpSecret: string | null }, totp: unknown): Promise<string | null> {
  if (!user.totpEnabled || !user.totpSecret) return null
  if (!totp || !/^\d{6}$/.test(String(totp))) return 'Enter your 6-digit authenticator code.'
  const { verifySync } = await import('otplib')
  return verifySync({ token: String(totp), secret: user.totpSecret, epochTolerance: 30 }).valid ? null : 'That authenticator code is not valid.'
}

// Register
router.post('/register', validate(validationSchemas.register), async (req, res) => {
  try {
    if (!prisma) return res.status(503).json({ error: 'Account registration requires a database (set DATABASE_URL).' })
    const { email, password, name } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    })

    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' })
    }

    const hashedPassword = await bcrypt.hash(password, 10)

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || email.split('@')[0],
        // Administration is provisioned explicitly using the operator CLI.
        role: 'user',
      },
    })

    const token = issueBrowserSession(res, user.id)

    // Fire-and-forget welcome + email verification (no-op without SMTP).
    welcomeEmail(user.email, user.name).catch(() => {})
    createToken(user.id, 'verify')
      .then((t) => {
        if (t) return verifyEmail(user.email, user.name, `${(process.env.FRONTEND_URL || 'http://localhost:3000').split(',')[0].trim().replace(/\/+$/, '')}/verify/?token=${t}`)
      })
      .catch(() => {})

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    })
  } catch (error) {
    console.error('Register error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Login
router.post('/login', validate(validationSchemas.login), async (req, res) => {
  try {
    if (!prisma) return res.status(503).json({ error: 'Login requires a database (set DATABASE_URL).' })
    const { email, password, totp } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    const user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    const isValidPassword = await bcrypt.compare(password, user.password)

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' })
    }

    // TOTP MFA (brief P2): valid password alone is not enough when enabled.
    const totpError = await checkTotp(user, totp)
    if (totpError) return res.status(401).json({ error: totpError, totpRequired: true })

    const token = issueBrowserSession(res, user.id)

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    })
  } catch (error) {
    console.error('Login error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Middleware to verify JWT token
export const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization
  const bearer = typeof authHeader === 'string' ? /^Bearer ([^\s]+)$/i.exec(authHeader)?.[1] : undefined
  const cookieToken = readSessionCookie(req)
  const token = bearer || cookieToken
  const isDevMode = process.env.NODE_ENV === 'development' && process.env.ENABLE_DEV_MODE === 'true'

  if (isDevMode && authHeader === undefined && !cookieToken) {
    // Use a default test user ID for development
    (req as any).userId = 'dev-user-123'
    return next()
  }

  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }

  let secret: string
  try { secret = jwtSecret() } catch { return res.status(503).json({ error: 'Authentication is not configured' }) }
  jwt.verify(token, secret, { algorithms: ['HS256'] }, (err: any, decoded: any) => {
    if (err || !decoded || typeof decoded === 'string' || typeof decoded.userId !== 'string' ||
        decoded.userId.trim().length === 0 || decoded.userId.length > 128) {
      return res.status(401).json({ error: 'Invalid token' })
    }
    (req as any).userId = decoded.userId
    // No database configured (local/dev): the signature is the only check.
    if (!prisma) return next()
    // Tokens without iat cannot be revoked. Reject them whenever the DB is on.
    if (typeof decoded.iat !== 'number') return res.status(401).json({ error: 'Invalid token' })
    // Fail closed: a DB error must not accept a session we could not check.
    void (async () => {
      try {
        const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { sessionInvalidatedAt: true } })
        if (!user) return res.status(401).json({ error: 'Session is no longer valid.' })
        if (user.sessionInvalidatedAt && tokenPredatesReset(decoded.iat, user.sessionInvalidatedAt)) {
          return res.status(401).json({ error: 'Session expired. Please sign in again.' })
        }
        next()
      } catch {
        if (!res.headersSent) res.status(503).json({ error: 'Authentication is temporarily unavailable.' })
      }
    })()
  })
}

/** POST /api/auth/logout — revoke every session for this user and clear the cookie. */
router.post('/logout', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string
  clearSessionCookie(res)
  if (!prisma || userId === 'dev-user-123') return res.json({ ok: true })
  try {
    await revokeUserSessions(userId)
  } catch {
    return res.status(503).json({ error: 'Could not revoke this session. Sign in again once the database is back.' })
  }
  res.json({ ok: true })
}))

/** POST /api/auth/sessions/revoke — revoke every session, then sign this caller back in. */
router.post('/sessions/revoke', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string
  if (!prisma || userId === 'dev-user-123') return res.status(503).json({ error: 'Session revocation requires a database.' })
  try {
    const token = await revokeAndIssueSession(res, userId)
    res.json(clientUsedBearer(req) ? { ok: true, revoked: true, token } : { ok: true, revoked: true })
  } catch {
    res.status(503).json({ error: 'Could not revoke sessions.' })
  }
}))

/** True when a JWT's issued-at (seconds) predates the reset instant. */
export function tokenPredatesReset(iatSeconds: number, sessionInvalidatedAt: Date): boolean {
  return iatSeconds * 1000 < sessionInvalidatedAt.getTime()
}

/**
 * Gate a route to an explicitly provisioned administrator. No dev-role bypass.
 */
export const requireAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const userId = (req as any).userId
  if (!userId) return res.status(401).json({ error: 'Authentication required.' })
  if (!hasDb || !prisma) {
    return res.status(503).json({ error: 'Admin portal requires a database.' })
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } })
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' })
    ;(req as any).userRole = user.role
    next()
  } catch (e: any) {
    res.status(500).json({ error: 'Authorization check failed' })
  }
}

export default router

