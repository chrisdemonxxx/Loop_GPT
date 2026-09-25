import express from 'express'
import { randomBytes } from 'crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { validate, validationSchemas } from '../middleware/validation'
import { prisma, hasDb } from '../services/prisma'
import { welcomeEmail, verifyEmail } from '../services/email'
import { createToken } from '../services/tokens'

const router = express.Router()

const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex')

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

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' })

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
    if (user.totpEnabled && user.totpSecret) {
      const { verifySync } = await import('otplib')
      if (!totp || !/^\d{6}$/.test(String(totp))) {
        return res.status(401).json({ error: 'Enter your 6-digit authenticator code.', totpRequired: true })
      }
      if (!verifySync({ token: String(totp), secret: user.totpSecret, epochTolerance: 30 }).valid) {
        return res.status(401).json({ error: 'That authenticator code is not valid.', totpRequired: true })
      }
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' })

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
  const token = typeof authHeader === 'string' ? /^Bearer ([^\s]+)$/i.exec(authHeader)?.[1] : undefined
  const isDevMode = process.env.NODE_ENV === 'development' && process.env.ENABLE_DEV_MODE === 'true'

  if (isDevMode && authHeader === undefined) {
    // Use a default test user ID for development
    (req as any).userId = 'dev-user-123'
    return next()
  }

  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, async (err: any, decoded: any) => {
    if (err || !decoded || typeof decoded === 'string' || typeof decoded.userId !== 'string' ||
        decoded.userId.trim().length === 0 || decoded.userId.length > 128) {
      return res.status(401).json({ error: 'Invalid token' })
    }
    (req as any).userId = decoded.userId
    // Password-reset invalidation: reject tokens issued before the user's
    // last reset. One indexed read; fail-open on DB errors (the signature is
    // already verified) so a transient DB blip doesn't lock users out.
    if (prisma && typeof decoded.iat === 'number') {
      try {
        const user = await prisma.user.findUnique({ where: { id: decoded.userId }, select: { sessionInvalidatedAt: true } })
        if (user?.sessionInvalidatedAt && tokenPredatesReset(decoded.iat, user.sessionInvalidatedAt)) {
          return res.status(401).json({ error: 'Session expired after a password reset. Please sign in again.' })
        }
      } catch { /* fail open */ }
    }
    next()
  })
}

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

