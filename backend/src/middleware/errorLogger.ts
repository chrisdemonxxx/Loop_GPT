import { Request, Response, NextFunction, RequestHandler } from 'express'

/**
 * Enhanced error logging middleware
 */
export const errorLogger = (err: any, req: Request, res: Response, next: NextFunction) => {
  // Request bodies, query strings and exception details can contain credentials.
  const candidate = err?.statusCode ?? err?.status
  const statusCode = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500
  console.error('request_failed', { method: req.method, statusCode })
  if (res.destroyed || res.writableEnded) return
  // Express's final handler closes a partially written response; never append
  // JSON to SSE/download output or throw ERR_HTTP_HEADERS_SENT here.
  if (res.headersSent) return next(new Error('Request failed'))
  const message = statusCode === 413 ? 'Request too large' : statusCode < 500 ? 'Invalid request' : 'Internal server error'
  const apiPath = req.originalUrl.split('?')[0]
  res.status(statusCode).set('Cache-Control', 'no-store').json({
    error: apiPath === '/v1' || apiPath.startsWith('/v1/')
      ? { message, type: 'api_error', code: 'request_failed', param: null }
      : message,
  })
}

/**
 * Async error handler wrapper
 */
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler => {
  return async (req, res, next) => {
    try { await fn(req, res, next) }
    catch {
      // Route-specific handlers retain their existing expected-error contracts.
      // Unexpected failures go through Express, never process-level rejection
      // handling. Do not forward raw provider/DB errors to logging or Sentry.
      next(new Error('Request operation failed'))
    }
  }
}

