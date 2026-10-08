import type { Request, Response } from 'express'
import { prisma } from './prisma'

/** httpOnly session cookie. Mobile and desktop keep sending Authorization: Bearer. */
export const SESSION_COOKIE = 'loop_session'
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export function clientUsedBearer(req: Request): boolean {
  return typeof req.headers.authorization === 'string' && /^Bearer \S/i.test(req.headers.authorization)
}

export function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string' || !header) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    if (part.slice(0, index).trim() !== SESSION_COOKIE) continue
    try { return decodeURIComponent(part.slice(index + 1).trim()) } catch { return undefined }
  }
  return undefined
}

function cookieAttributes(maxAgeSeconds: number): string {
  const parts = ['HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`]
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  return parts.join('; ')
}

export function setSessionCookie(res: Response, token: string): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(SESSION_MAX_AGE_SECONDS)}`)
}

export function clearSessionCookie(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; ${cookieAttributes(0)}`)
}

/**
 * Stamp strictly after the current second so every JWT already issued
 * (iat is whole seconds) fails tokenPredatesReset, while a replacement
 * token can use sessionIatAfter and stay valid.
 */
export function revocationStamp(now = Date.now()): Date {
  return new Date(now % 1000 === 0 ? now + 1 : now)
}

/** iat (seconds) that is not strictly before the revocation stamp. */
export function sessionIatAfter(invalidatedAt: Date): number {
  return Math.ceil(invalidatedAt.getTime() / 1000)
}

/** True when an administrator is being dropped to a normal user. */
export function shouldRevokeSessionsOnRoleChange(previousRole: string | null | undefined, nextRole: unknown): boolean {
  return previousRole === 'admin' && nextRole === 'user'
}

/**
 * Invalidate every session issued before now. Optional column updates
 * (2FA enable/disable) commit in the same write as the stamp.
 */
export async function revokeUserSessions(
  userId: string,
  extra: { totpEnabled?: boolean; totpSecret?: string | null } = {},
): Promise<Date> {
  if (!prisma) throw new Error('database unavailable')
  const sessionInvalidatedAt = revocationStamp()
  await prisma.user.update({
    where: { id: userId },
    data: { ...extra, sessionInvalidatedAt },
  })
  return sessionInvalidatedAt
}
