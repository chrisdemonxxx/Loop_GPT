import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';

// Security headers, CORS, and rate limiting — the perimeter controls that apply
// before any route logic runs.

export function securityHeaders(): RequestHandler {
  // helmet sets a conservative bundle: HSTS, no-sniff, frameguard, a strict
  // referrer policy, and (for API responses) disables the browser cache.
  return helmet();
}

// CORS with an explicit origin allowlist. Never "*" together with credentials —
// that combination is rejected by browsers and would defeat the point of the
// allowlist. A request from an origin not on the list is simply not granted CORS
// headers.
export function corsPolicy(allowedOrigins: string[]): RequestHandler {
  return cors({
    origin(origin, callback) {
      // Same-origin / non-browser requests send no Origin header.
      if (origin === undefined || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  });
}

// Rate limit for auth-sensitive endpoints. Bruteforcing tokens or session
// introspection should be expensive; general read traffic need not be.
export function authRateLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests' },
  });
}
