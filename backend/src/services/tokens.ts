/**
 * One-time tokens for email verification, password reset and the OAuth
 * sign-in hand-off code. No-op (returns null) without a database.
 */
import crypto from 'crypto'
import { prisma } from './prisma'

export type TokenType = 'verify' | 'reset' | 'oauth'

export const TTL: Record<TokenType, number> = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000, oauth: 5 * 60 * 1000 }

function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function createToken(userId: string, type: TokenType): Promise<string | null> {
  if (!prisma) return null
  const token = crypto.randomBytes(24).toString('hex')
  await prisma.token.create({ data: { token: tokenDigest(token), type, userId, expiresAt: new Date(Date.now() + TTL[type]) } })
  return token
}

/** Look up a live token without burning it. Returns its id and userId. */
export async function peekToken(token: string, type: TokenType): Promise<{ id: string; userId: string } | null> {
  if (!prisma || !token) return null
  const row = await prisma.token.findUnique({ where: { token: tokenDigest(token) } })
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() <= Date.now()) return null
  return { id: row.id, userId: row.userId }
}

/** Burn a token by id without redeeming it (e.g. too many failed attempts). */
export async function revokeToken(id: string): Promise<void> {
  if (!prisma) return
  await prisma.token.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } })
}

/** Validate + burn a token; returns the userId or null if invalid/expired/used. */
export async function consumeToken(token: string, type: TokenType): Promise<string | null> {
  if (!prisma || !token) return null
  const row = await prisma.token.findUnique({ where: { token: tokenDigest(token) } })
  if (!row || row.type !== type || row.usedAt) return null
  const now = new Date()
  // Compare-and-set: concurrent consumers can read the row, but only one can
  // claim it. Include expiry in the write predicate, not only in the read.
  const claimed = await prisma.token.updateMany({
    where: { id: row.id, type, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  })
  return claimed.count === 1 ? row.userId : null
}
