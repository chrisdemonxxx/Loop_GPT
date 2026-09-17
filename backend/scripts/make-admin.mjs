/**
 * Promote (or demote) a user account.
 *
 * Usage, run from the backend service so DATABASE_URL is available:
 *   railway run --service backend -- npm run make-admin -- you@example.com
 *   railway run --service backend -- npm run make-admin -- you@example.com user
 *
 * The account must already exist (sign up through the UI first).
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const email = process.argv[2]
  const role = (process.argv[3] || 'admin').toLowerCase()

  if (email === '--help') {
    console.log('Usage: npm run make-admin -- <email> [admin|user]\nRequires DATABASE_URL; account must already exist. Changes role only.')
    return
  }

  if (!email) {
    console.error('Usage: npm run make-admin -- <email> [admin|user]')
    process.exit(1)
  }
  if (role !== 'admin' && role !== 'user') {
    console.error(`Invalid role "${role}". Expected "admin" or "user".`)
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; no database is selected automatically.')

  const prisma = new PrismaClient()
  try {
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (!existing) {
      console.error(`No account found for ${email}. Sign up first, then re-run.`)
      process.exit(1)
    }

    const user = await prisma.user.update({
      where: { email },
      data: { role },
      select: { email: true, role: true },
    })
    console.log(`OK: ${user.email} is now "${user.role}".`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
