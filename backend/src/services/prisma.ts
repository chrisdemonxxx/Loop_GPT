/**
 * Shared PrismaClient singleton. Only constructed when a real Postgres
 * DATABASE_URL is configured; otherwise the app runs on the in-memory store and
 * DB-backed features (auth, billing, admin) degrade gracefully.
 */
import { PrismaClient } from '@prisma/client'

let prisma: PrismaClient | null = null
try {
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('postgresql://user:password')) {
    // Reuse across hot reloads in dev to avoid exhausting connections.
    const g = global as any
    prisma = g.__loopPrisma || new PrismaClient()
    if (process.env.NODE_ENV !== 'production') g.__loopPrisma = prisma
  }
} catch {
  prisma = null
}

export { prisma }
export const hasDb = !!prisma
