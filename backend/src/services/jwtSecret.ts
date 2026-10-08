import { randomBytes } from 'crypto'

let ephemeral: string | undefined

/** The session-signing secret. Read lazily so every module agrees on it.
 *  Production refuses to run without JWT_SECRET; elsewhere a per-process
 *  random secret is used (sessions die on restart, never forgeable). */
export function jwtSecret(): string {
  const configured = process.env.JWT_SECRET
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET is required in production')
  ephemeral ||= randomBytes(32).toString('hex')
  return ephemeral
}
