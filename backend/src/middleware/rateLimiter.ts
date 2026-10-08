import { Request, Response, NextFunction } from 'express'
import { createHash, timingSafeEqual } from 'crypto'

/**
 * Simple in-memory rate limiter.
 * Each limiter owns its own buckets, so traffic on one route group never
 * spends another group's allowance. For multi-instance deployments, consider
 * a shared (redis-based) store.
 */
interface Bucket {
  count: number
  resetTime: number
}

export interface RateLimitOptions {
  /** Bucket key for a request; return undefined to skip limiting it. Defaults
   *  to the authenticated user, else the client IP. */
  key?: (req: Request) => string | undefined
}

const stores = new Set<Map<string, Bucket>>()

function sameSecret(supplied: string, expected: string): boolean {
  const a = createHash('sha256').update(supplied).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * The caller's IP. Our own web proxy (nginx) authenticates itself with
 * PROXY_SHARED_SECRET and overwrites X-Forwarded-For with the address it saw,
 * so that value is trusted only on authenticated requests. Otherwise Express's
 * `trust proxy` hop count decides (req.ip), which ignores client-supplied
 * X-Forwarded-For entries beyond the trusted hops.
 */
export function clientIp(req: Request): string {
  const secret = process.env.PROXY_SHARED_SECRET
  const supplied = req.headers['x-loop-proxy-auth']
  if (secret && typeof supplied === 'string' && sameSecret(supplied, secret)) {
    const forwarded = req.headers['x-forwarded-for']
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    if (first && first.length <= 64) return first
  }
  return req.ip || req.socket?.remoteAddress || 'anonymous'
}

/**
 * Rate limiter middleware
 */
export const rateLimiter = (
  windowMs: number = 15 * 60 * 1000, // 15 minutes
  maxRequests: number = 100, // max requests per window
  options: RateLimitOptions = {},
) => {
  const store = new Map<string, Bucket>()
  stores.add(store)
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip rate limiting in development
    if (process.env.NODE_ENV === 'development' && process.env.ENABLE_RATE_LIMIT !== 'true') {
      return next()
    }

    const key = options.key ? options.key(req) : ((req as any).userId ? `user:${(req as any).userId}` : `ip:${clientIp(req)}`)
    if (key === undefined) return next()
    const now = Date.now()
    let record = store.get(key)
    if (record && now > record.resetTime) {
      store.delete(key)
      record = undefined
    }

    if (!record) {
      // First request in window
      store.set(key, { count: 1, resetTime: now + windowMs })
      return next()
    }

    if (record.count >= maxRequests) {
      // Rate limit exceeded
      const retryAfter = Math.ceil((record.resetTime - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({
        error: 'Too many requests',
        message: `Rate limit exceeded. Please try again after ${retryAfter} seconds.`,
        retryAfter,
      })
    }

    record.count++
    next()
  }
}

/** Key by client IP only (unauthenticated endpoints). */
export const byIp = (req: Request) => `ip:${clientIp(req)}`

/** Key by a normalized body field (e.g. the email being attacked); skipped when absent. */
export const byBodyField = (field: string) => (req: Request) => {
  const value = req.body?.[field]
  return typeof value === 'string' && value.trim() ? `${field}:${value.trim().toLowerCase().slice(0, 320)}` : undefined
}

/** Key by the authenticated user (mount after authenticateToken). */
export const byUser = (req: Request) => {
  const userId = (req as any).userId
  return userId ? `user:${userId}` : `ip:${clientIp(req)}`
}

/**
 * Clean up old rate limit records periodically
 */
setInterval(() => {
  const now = Date.now()
  for (const store of stores) {
    for (const [key, bucket] of store) {
      if (bucket.resetTime < now) store.delete(key)
    }
  }
}, 60 * 1000).unref() // Clean up every minute
