import jwt from 'jsonwebtoken';
import type { Algorithm } from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { RequestIdentity } from './db.js';

// The middleware verifies the JWT *signature* on every request. It never trusts
// a decoded payload without verification, and it never falls back to reading
// claims from an unverified token. The algorithm allowlist is the load-bearing
// control: passing `algorithms` to jwt.verify is what rejects `alg: none` and
// algorithm-confusion attacks (a token that asks to be verified with a weaker or
// different algorithm than the one we actually trust). Without it, a forged
// `{"alg":"none"}` token would be accepted as valid.

export class AuthError extends Error {}

export interface VerifyOptions {
  readonly secret: string;
  readonly algorithms: string[];
}

const KNOWN_ALGORITHMS = new Set<Algorithm>([
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
]);

function toAlgorithms(values: string[]): Algorithm[] {
  const algorithms = values.filter((value): value is Algorithm =>
    KNOWN_ALGORITHMS.has(value as Algorithm),
  );
  if (algorithms.length === 0) {
    throw new AuthError('no valid JWT algorithms configured');
  }
  // `none` can never enter the allowlist: it is not in KNOWN_ALGORITHMS, so a
  // misconfiguration cannot accidentally permit unsigned tokens.
  return algorithms;
}

function bearerToken(header: string | undefined): string {
  if (header === undefined) {
    throw new AuthError('missing Authorization header');
  }
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || token === undefined || token === '') {
    throw new AuthError('Authorization header must be a Bearer token');
  }
  return token;
}

// Verifies a raw Authorization header value and returns the caller identity.
// Throws AuthError on anything unverifiable: missing/malformed header, bad
// signature, expired token, disallowed algorithm, or a token without a subject.
export function verifyBearer(header: string | undefined, options: VerifyOptions): RequestIdentity {
  const token = bearerToken(header);
  let payload: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(token, options.secret, {
      algorithms: toAlgorithms(options.algorithms),
    });
    if (typeof decoded === 'string') {
      throw new AuthError('token payload is not an object');
    }
    payload = decoded;
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }
    throw new AuthError('invalid token');
  }

  const userId = payload.sub;
  if (typeof userId !== 'string' || userId === '') {
    throw new AuthError('token has no subject claim');
  }
  const orgId = typeof payload.org_id === 'string' ? payload.org_id : null;
  return { userId, orgId };
}

declare module 'express-serve-static-core' {
  interface Request {
    identity?: RequestIdentity;
  }
}

export function requireAuth(options: VerifyOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      req.identity = verifyBearer(req.header('authorization'), options);
      next();
    } catch (error) {
      // Log server-side for diagnosis; return an opaque 401 to the client so we
      // never disclose *why* a token failed (that helps an attacker tune forgeries).
      console.error('auth rejected:', error instanceof Error ? error.message : error);
      res.status(401).json({ error: 'unauthorized' });
    }
  };
}
