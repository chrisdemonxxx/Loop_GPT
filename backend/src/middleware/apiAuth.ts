/**
 * Bearer-token auth + rate limiting for the public `/v1` developer API.
 *
 * Errors follow the OpenAI error envelope so existing SDKs surface them
 * correctly: `{ error: { message, type, code } }`.
 */
import type { NextFunction, Request, Response } from 'express'
import { resolveApiKey, looksLikeApiKey } from '../services/apiKeys'
import { rateLimitFor } from '../services/apiBilling'
import { asyncHandler } from './errorLogger'

export interface ApiRequest extends Request {
  api?: {
    apiKeyId: string
    userId: string
    plan: string | null
    balanceMicros: bigint
    unlimited: boolean
  }
}

export function apiError(
  res: Response,
  status: number,
  message: string,
  type: string,
  code: string
): Response {
  return res.status(status).json({ error: { message, type, code, param: null } })
}

/** Sliding-window request counters, keyed by API key id. */
const windows = new Map<string, { count: number; resetAt: number }>()

setInterval(() => {
  const now = Date.now()
  for (const [key, win] of windows) if (win.resetAt <= now) windows.delete(key)
}, 60_000).unref?.()

export const authenticateApiKey = asyncHandler(async (req: ApiRequest, res: Response, next: NextFunction) => {
  const header = req.headers.authorization || ''
  const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  if (!raw) {
    return apiError(
      res,
      401,
      'Missing API key. Pass it as an Authorization header: "Authorization: Bearer sk-loop-…".',
      'invalid_request_error',
      'missing_api_key'
    )
  }
  if (!looksLikeApiKey(raw)) {
    return apiError(res, 401, 'Invalid API key format.', 'invalid_request_error', 'invalid_api_key')
  }

  const resolved = await resolveApiKey(raw)
  if (!resolved) {
    return apiError(
      res,
      401,
      'Incorrect API key provided, or the key has been revoked.',
      'invalid_request_error',
      'invalid_api_key'
    )
  }

  // Per-key sliding window keyed to the account's plan.
  const limit = resolved.unlimited ? Number.MAX_SAFE_INTEGER : rateLimitFor(resolved.plan)
  const now = Date.now()
  const win = windows.get(resolved.apiKeyId)
  if (!win || win.resetAt <= now) {
    windows.set(resolved.apiKeyId, { count: 1, resetAt: now + 60_000 })
  } else {
    win.count++
    if (win.count > limit) {
      const retry = Math.max(1, Math.ceil((win.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retry))
      res.setHeader('X-RateLimit-Limit', String(limit))
      res.setHeader('X-RateLimit-Remaining', '0')
      return apiError(
        res,
        429,
        `Rate limit reached for your plan (${limit} requests/min). Retry in ${retry}s or upgrade at /developers.`,
        'rate_limit_error',
        'rate_limit_exceeded'
      )
    }
    res.setHeader('X-RateLimit-Limit', String(limit))
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - win.count)))
  }

  req.api = resolved
  next()
})

/** Reject the request when the prepaid balance is exhausted. */
export function requireBalance(req: ApiRequest, res: Response, next: NextFunction) {
  if (!req.api) {
    return apiError(res, 401, 'Missing API key.', 'invalid_request_error', 'missing_api_key')
  }
  if (req.api.unlimited) return next()
  if (req.api.balanceMicros <= 0n) {
    return apiError(
      res,
      402,
      'Insufficient credit. Add prepaid credit at /developers to continue using the API.',
      'insufficient_quota',
      'insufficient_quota'
    )
  }
  next()
}
