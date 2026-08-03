/**
 * One-time tokens for email verification and password reset.
 * No-op (returns null) without a database.
 */
import crypto from 'crypto'
import { prisma } from './prisma'

export const TTL = { verify: 24 * 60 * 60 * 1000, reset: 60 * 60 * 1000 }

export async function createToken(userId: string, type: 'verify' | 'reset'): Promise<string | null> {
  if (!prisma) return null
  const token = crypto.randomBytes(24).toString('hex')
  await prisma.token.create({ data: { token, type, userId, expiresAt: new Date(Date.now() + TTL[type]) } })
  return token
}

/** Validate + burn a token; returns the userId or null if invalid/expired/used. */
export async function consumeToken(token: string, type: 'verify' | 'reset'): Promise<string | null> {
  if (!prisma || !token) return null
  const row = await prisma.token.findUnique({ where: { token } })
  if (!row || row.type !== type || row.usedAt || row.expiresAt.getTime() < Date.now()) return null
  await prisma.token.update({ where: { id: row.id }, data: { usedAt: new Date() } })
  return row.userId
}
