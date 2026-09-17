/**
 * One-time tokens for email verification and password reset.
 * No-op (returns null) without a database.
 */
import crypto from 'crypto'
import { prisma } from './prisma'

export const TTL = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 }

function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export async function createToken(userId: string, type: 'verify' | 'reset'): Promise<string | null> {
  if (!prisma) return null
  const token = crypto.randomBytes(24).toString('hex')
  await prisma.token.create({ data: { token: tokenDigest(token), type, userId, expiresAt: new Date(Date.now() + TTL[type]) } })
  return token
}

/** Validate + burn a token; returns the userId or null if invalid/expired/used. */
export async function consumeToken(token: string, type: 'verify' | 'reset'): Promise<string | null> {
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
