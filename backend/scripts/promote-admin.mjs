#!/usr/bin/env node
/**
 * Promote an existing account to `admin` (operator CLI).
 *
 * Registration always creates `role: user`; there is no in-app promotion path.
 * Run with a live DATABASE_URL, from the backend working directory, e.g.:
 *   DATABASE_URL=... node scripts/promote-admin.mjs owner@example.com
 *
 * Idempotent. Bounded output: never prints credentials, tokens or other users.
 * Exits nonzero if the address is missing or no such user exists.
 */
import { PrismaClient } from '@prisma/client'

const email = (process.argv[2] || '').trim().toLowerCase()
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('usage: node scripts/promote-admin.mjs <email>')
  process.exit(2)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set (this script does not read .env)')
  process.exit(2)
}

const prisma = new PrismaClient()
try {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } })
  if (!existing) {
    console.error(`no account for ${email}`)
    process.exit(3)
  }
  const updated = await prisma.user.update({ where: { email }, data: { role: 'admin' }, select: { id: true, role: true } })
  const admins = await prisma.user.count({ where: { role: 'admin' } })
  console.log(JSON.stringify({ email, userId: updated.id, previousRole: existing.role, role: updated.role, adminsTotal: admins }))
} catch (error) {
  console.error(`promotion failed: ${error?.message || 'unknown error'}`)
  process.exitCode = 1
} finally {
  await prisma.$disconnect()
}
