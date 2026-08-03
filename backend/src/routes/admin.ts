/**
 * Admin backend portal API: realtime platform stats, user management, usage feed,
 * voucher management, and payments. All routes require an admin (see requireAdmin).
 */
import express from 'express'
import { authenticateToken, requireAdmin } from './auth'
import { prisma, hasDb } from '../services/prisma'

const router = express.Router()

// Everything here is admin-only.
router.use(authenticateToken, requireAdmin)

function noDb(res: express.Response) {
  return res.json({ hasDb: false, message: 'Admin analytics require a database (DATABASE_URL).' })
}

/** GET /api/admin/stats — headline counters + last-24h activity + token totals. */
router.get('/stats', async (_req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [users, admins, unlimited, pro, gold, tokenAgg, imagesAgg, events24, newUsers24, payAgg, recentEvents] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { role: 'admin' } }),
      prisma.user.count({ where: { unlimited: true } }),
      prisma.user.count({ where: { plan: 'pro' } }),
      prisma.user.count({ where: { plan: 'gold' } }),
      prisma.user.aggregate({ _sum: { tokensInTotal: true, tokensOutTotal: true, imagesTotal: true, messagesTotal: true } }),
      prisma.usageEvent.aggregate({ _sum: { tokensIn: true, tokensOut: true }, where: { createdAt: { gte: since } } }),
      prisma.usageEvent.count({ where: { createdAt: { gte: since } } }),
      prisma.user.count({ where: { createdAt: { gte: since } } }),
      prisma.payment.aggregate({ _sum: { amount: true }, _count: true, where: { status: 'succeeded' } }),
      prisma.usageEvent.groupBy({ by: ['kind'], _count: true, where: { createdAt: { gte: since } } }),
    ])

  res.json({
    hasDb: true,
    users: { total: users, admins, unlimited, pro, gold, free: Math.max(0, users - pro - gold), new24h: newUsers24 },
    tokens: {
      inTotal: Number(tokenAgg._sum.tokensInTotal || 0),
      outTotal: Number(tokenAgg._sum.tokensOutTotal || 0),
      in24h: Number(imagesAgg._sum.tokensIn || 0),
      out24h: Number(imagesAgg._sum.tokensOut || 0),
    },
    activity: {
      messagesTotal: tokenAgg._sum.messagesTotal || 0,
      imagesTotal: tokenAgg._sum.imagesTotal || 0,
      events24h: events24,
      byKind24h: recentEvents.map((r) => ({ kind: r.kind, count: r._count })),
    },
    revenue: { totalCents: payAgg._sum.amount || 0, payments: payAgg._count || 0 },
  })
})

/** GET /api/admin/timeseries — hourly usage buckets for the last 24h (charts). */
router.get('/timeseries', async (_req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const events = await prisma.usageEvent.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, tokensIn: true, tokensOut: true, kind: true },
  })
  const buckets: Record<string, { hour: string; tokensIn: number; tokensOut: number; events: number; images: number }> = {}
  for (let i = 23; i >= 0; i--) {
    const d = new Date(Date.now() - i * 60 * 60 * 1000)
    const key = `${d.getUTCHours()}`.padStart(2, '0') + ':00'
    buckets[`${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`] = {
      hour: key, tokensIn: 0, tokensOut: 0, events: 0, images: 0,
    }
  }
  for (const e of events) {
    const d = new Date(e.createdAt)
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`
    const b = buckets[k]
    if (!b) continue
    b.tokensIn += e.tokensIn
    b.tokensOut += e.tokensOut
    b.events += 1
    if (e.kind === 'image') b.images += 1
  }
  res.json({ hasDb: true, series: Object.values(buckets) })
})

/** GET /api/admin/users?query=&take=&skip= — paginated user list. */
router.get('/users', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const q = String(req.query.query || '').trim()
  const take = Math.min(Number(req.query.take) || 25, 100)
  const skip = Number(req.query.skip) || 0
  const where = q
    ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { name: { contains: q, mode: 'insensitive' as const } }] }
    : {}
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { lastActiveAt: 'desc' },
      take,
      skip,
      select: {
        id: true, email: true, name: true, role: true, plan: true, unlimited: true,
        credits: true, imageCredits: true, tokensInTotal: true, tokensOutTotal: true,
        imagesTotal: true, messagesTotal: true, createdAt: true, lastActiveAt: true,
      },
    }),
    prisma.user.count({ where }),
  ])
  res.json({
    hasDb: true,
    total,
    users: users.map((u) => ({ ...u, tokensInTotal: Number(u.tokensInTotal), tokensOutTotal: Number(u.tokensOutTotal) })),
  })
})

/** PATCH /api/admin/users/:id — update role/plan/unlimited/credits. */
router.patch('/users/:id', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { role, plan, unlimited, credits, imageCredits } = req.body || {}
  const data: any = {}
  if (role === 'admin' || role === 'user') data.role = role
  if (plan === 'free' || plan === 'pro') data.plan = plan
  if (typeof unlimited === 'boolean') data.unlimited = unlimited
  if (Number.isFinite(credits)) data.credits = Math.max(0, Math.floor(credits))
  if (Number.isFinite(imageCredits)) data.imageCredits = Math.max(0, Math.floor(imageCredits))
  if (!Object.keys(data).length) return res.status(400).json({ error: 'Nothing to update.' })
  const user = await prisma.user.update({ where: { id: req.params.id }, data })
  res.json({ ok: true, user: { ...user, tokensInTotal: Number(user.tokensInTotal), tokensOutTotal: Number(user.tokensOutTotal) } })
})

/** GET /api/admin/usage?take= — recent usage events across all users (live feed). */
router.get('/usage', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const take = Math.min(Number(req.query.take) || 50, 200)
  const events = await prisma.usageEvent.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: { user: { select: { email: true, name: true } } },
  })
  res.json({ hasDb: true, events })
})

// ---- Vouchers ---------------------------------------------------------------

/** GET /api/admin/vouchers — list all vouchers with redemption counts. */
router.get('/vouchers', async (_req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const vouchers = await prisma.voucher.findMany({ orderBy: { createdAt: 'desc' } })
  res.json({ hasDb: true, vouchers })
})

function genCode(prefix = 'LOOP'): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 10; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `${prefix}-${s.slice(0, 5)}-${s.slice(5)}`
}

/**
 * POST /api/admin/vouchers — create one or more vouchers.
 * type: 'gold' (T1 team, capped-max) | 'pro' | 'unlimited' (internal) | 'credits'.
 * Defaults to a T1 Gold team code (plan upgrade to capped-max limits).
 */
router.post('/vouchers', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { code, type = 'gold', plan, credits = 0, imageCredits = 0, maxRedemptions = 1, expiresAt, note, count = 1 } =
    req.body || {}
  const n = Math.min(Math.max(Number(count) || 1, 1), 100)

  // Map the voucher type to stored fields. Plan vouchers carry a `plan`; only the
  // explicit 'unlimited' type flips the true-unlimited flag on redeem.
  const t = ['gold', 'pro', 'unlimited', 'credits'].includes(type) ? type : 'gold'
  const storedType = t === 'unlimited' ? 'unlimited' : t === 'credits' ? 'credits' : 'plan'
  const storedPlan = plan || (t === 'gold' ? 'gold' : t === 'pro' ? 'pro' : t === 'unlimited' ? 'pro' : null)

  const base = {
    type: storedType,
    plan: storedPlan,
    credits: Math.max(0, Math.floor(credits)),
    imageCredits: Math.max(0, Math.floor(imageCredits)),
    maxRedemptions: Math.max(1, Math.floor(maxRedemptions)),
    expiresAt: expiresAt ? new Date(expiresAt) : null,
    note: note || (t === 'gold' ? 'T1 Gold team access' : null),
  }

  const created = []
  for (let i = 0; i < n; i++) {
    const finalCode = (n === 1 && code ? String(code) : genCode(t === 'gold' ? 'GOLD' : 'LOOP')).trim().toUpperCase()
    try {
      created.push(await prisma.voucher.create({ data: { ...base, code: finalCode } }))
    } catch {
      created.push(await prisma.voucher.create({ data: { ...base, code: genCode(t === 'gold' ? 'GOLD' : 'LOOP') } }))
    }
  }
  res.json({ ok: true, vouchers: created })
})

/** PATCH /api/admin/vouchers/:id — toggle active / edit note. */
router.patch('/vouchers/:id', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { active, note } = req.body || {}
  const data: any = {}
  if (typeof active === 'boolean') data.active = active
  if (typeof note === 'string') data.note = note
  const v = await prisma.voucher.update({ where: { id: req.params.id }, data })
  res.json({ ok: true, voucher: v })
})

/** DELETE /api/admin/vouchers/:id */
router.delete('/vouchers/:id', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  await prisma.voucher.delete({ where: { id: req.params.id } })
  res.json({ ok: true })
})

// ---- Payments ---------------------------------------------------------------

/** GET /api/admin/payments — recent payments. */
router.get('/payments', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const take = Math.min(Number(req.query.take) || 50, 200)
  const payments = await prisma.payment.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: { user: { select: { email: true, name: true } } },
  })
  res.json({ hasDb: true, payments })
})

/** POST /api/admin/payments — manually record a payment (e.g. offline/comp). */
router.post('/payments', async (req, res) => {
  if (!hasDb || !prisma) return noDb(res)
  const { userId, amount, currency = 'usd', status = 'succeeded', provider = 'manual', reference, note } = req.body || {}
  if (!userId || !Number.isFinite(amount)) return res.status(400).json({ error: 'userId and amount (cents) are required.' })
  const payment = await prisma.payment.create({
    data: { userId, amount: Math.floor(amount), currency, status, provider, reference: reference || null, note: note || null },
  })
  res.json({ ok: true, payment })
})

export default router
