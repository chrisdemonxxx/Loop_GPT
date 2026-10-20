/** One-shot: roll creditsResetAt forward for a user so VM-minute burns stop counting. */
import { PrismaClient } from '@prisma/client'

const email = process.argv[2]
if (!email) {
  console.error('Usage: node scripts/reset-vm-quota.mjs <email>')
  process.exit(1)
}

const p = new PrismaClient()
try {
  const u = await p.user.findUnique({
    where: { email },
    select: { id: true, creditsResetAt: true, plan: true },
  })
  if (!u) {
    console.error('user not found:', email)
    process.exit(1)
  }
  const next = new Date()
  await p.user.update({ where: { id: u.id }, data: { creditsResetAt: next } })
  console.log(JSON.stringify({ email, plan: u.plan, creditsResetAt: next.toISOString() }))
} finally {
  await p.$disconnect()
}
