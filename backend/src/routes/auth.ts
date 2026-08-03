import express from 'express'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { validate, validationSchemas } from '../middleware/validation'
import { prisma as sharedPrisma, hasDb } from '../services/prisma'
import { welcomeEmail, verifyEmail } from '../services/email'
import { createToken } from '../services/tokens'

const router = express.Router()

// Only construct Prisma when a real database is configured; otherwise the app
// runs on the in-memory store and auth endpoints return 503. Constructing it
// unconditionally crashes boot when no DB (or engine) is present.
let prisma: PrismaClient | null = null
try {
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('postgresql://user:password')) {
    prisma = new PrismaClient()
  }
} catch {
  prisma = null
}

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'

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

    // Bootstrap: the very first account (or one matching ADMIN_EMAIL) is an admin.
    const userCount = await prisma.user.count()
    const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase()
    const isAdmin = userCount === 0 || (!!adminEmail && email.toLowerCase() === adminEmail)

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || email.split('@')[0],
        role: isAdmin ? 'admin' : 'user',
      },
    })

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' })

    // Fire-and-forget welcome + email verification (no-op without SMTP).
    welcomeEmail(user.email, user.name).catch(() => {})
    createToken(user.id, 'verify')
      .then((t) => {
        if (t) verifyEmail(user.email, user.name, `${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/verify?token=${t}`)
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
    const { email, password } = req.body

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
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  // Development mode: Auto-create/use a default user if no token provided
  // Allow dev mode if NODE_ENV is development OR if ENABLE_DEV_MODE is set
  const isDevMode = process.env.NODE_ENV === 'development' || process.env.ENABLE_DEV_MODE === 'true'
  
  if (isDevMode && !token) {
    // Use a default test user ID for development
    ;(req as any).userId = 'dev-user-123'
    return next()
  }

  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }

  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' })
    }
    ;(req as any).userId = decoded.userId
    next()
  })
}

/**
 * Gate a route to admins. Must run after authenticateToken. Without a DB, allows
 * access only in dev mode (so the local build stays usable).
 */
export const requireAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const userId = (req as any).userId
  if (!hasDb || !sharedPrisma) {
    const isDevMode = process.env.NODE_ENV === 'development' || process.env.ENABLE_DEV_MODE === 'true'
    if (isDevMode) return next()
    return res.status(503).json({ error: 'Admin portal requires a database.' })
  }
  try {
    const user = await sharedPrisma.user.findUnique({ where: { id: userId } })
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' })
    ;(req as any).userRole = user.role
    next()
  } catch (e: any) {
    res.status(500).json({ error: 'Authorization check failed' })
  }
}

export default router

