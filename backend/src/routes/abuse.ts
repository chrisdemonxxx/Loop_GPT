/**
 * Abuse / NCII / CSAM Reporting & 48h SLA Takedown Queue (Tier 2-5).
 *
 * Endpoints:
 *   - `POST /api/abuse/report` — public/authenticated endpoint to report NCII,
 *     CSAM, impersonation, or non-consensual likeness abuse. Automatically
 *     sets a 48-hour SLA deadline (`slaDueAt`) and, for `csam` or `ncii` reports
 *     targeting a published `PrivateFile`, immediately revokes the public link
 *     (`publishToken = null`) pending review.
 *   - `GET /api/abuse/reports` — admin-only queue ordered by `slaDueAt ASC`.
 *   - `PATCH /api/abuse/reports/:id` — admin-only resolution/takedown action.
 */
import express from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { prisma, hasDb } from '../services/prisma'

const router = express.Router()
router.use(express.json({ limit: '256kb' }))

export const NCII_SLA_HOURS = 48

const reportSchema = z.object({
  category: z.enum(['ncii', 'csam', 'impersonation', 'violence', 'other']),
  targetType: z.enum(['file', 'conversation', 'share_link', 'url', 'user']),
  targetId: z.string().trim().min(1).max(1024),
  reason: z.string().trim().min(5).max(4000),
  reporterEmail: z.string().email().max(320).optional(),
}).strict()

/** POST /api/abuse/report — submit an abuse or NCII takedown report (48h SLA). */
router.post('/report', asyncHandler(async (req, res) => {
  if (!hasDb || !prisma) return res.status(503).json({ error: 'Reporting service requires a database.' })
  const parsed = reportSchema.safeParse(req.body || {})
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid report payload.' })
  }

  const reporterUserId = (req as any).userId ?? null
  const slaDueAt = new Date(Date.now() + NCII_SLA_HOURS * 60 * 60 * 1000)

  // Immediate precautionary takedown of public share/publish tokens on CSAM or NCII reports
  let autoSuspended = false
  if (parsed.data.category === 'csam' || parsed.data.category === 'ncii') {
    if (parsed.data.targetType === 'file') {
      const updated = await prisma.privateFile.updateMany({
        where: { OR: [{ id: parsed.data.targetId }, { publishToken: parsed.data.targetId }] },
        data: { publishToken: null, publishedAt: null },
      })
      autoSuspended = updated.count > 0
    } else if (parsed.data.targetType === 'share_link' || parsed.data.targetType === 'conversation') {
      const updated = await prisma.conversation.updateMany({
        where: { OR: [{ id: parsed.data.targetId }, { shareToken: parsed.data.targetId }] },
        data: { shareToken: null },
      })
      autoSuspended = updated.count > 0
    }
  }

  const report = await prisma.abuseReport.create({
    data: {
      reporterUserId,
      reporterEmail: parsed.data.reporterEmail ?? null,
      category: parsed.data.category,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      reason: parsed.data.reason,
      status: 'open',
      slaDueAt,
    },
  })

  return res.status(201).json({
    id: report.id,
    status: report.status,
    category: report.category,
    slaDueAt: report.slaDueAt.toISOString(),
    slaHours: NCII_SLA_HOURS,
    autoSuspended,
  })
}))

async function requireAdmin(req: express.Request, res: express.Response): Promise<boolean> {
  if (!hasDb || !prisma) {
    res.status(503).json({ error: 'Database unavailable.' })
    return false
  }
  const userId = (req as any).userId
  if (!userId) {
    res.status(401).json({ error: 'Authentication required.' })
    return false
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' })
    return false
  }
  return true
}

/** GET /api/abuse/reports — admin queue of open/resolved abuse reports ordered by SLA deadline. */
router.get('/reports', authenticateToken, asyncHandler(async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const reports = await prisma!.abuseReport.findMany({
    where: status ? { status } : undefined,
    orderBy: [{ slaDueAt: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  })
  return res.json({ reports })
}))

const resolveSchema = z.object({
  status: z.enum(['reviewing', 'actioned', 'dismissed']),
  resolutionNote: z.string().trim().max(4000).optional(),
  deleteTargetFile: z.boolean().optional(),
}).strict()

/** PATCH /api/abuse/reports/:id — admin action to resolve or takedown reported content. */
router.patch('/reports/:id', authenticateToken, asyncHandler(async (req, res) => {
  if (!(await requireAdmin(req, res))) return
  const parsed = resolveSchema.safeParse(req.body || {})
  if (!parsed.success) return res.status(400).json({ error: 'Invalid resolution payload.' })

  const existing = await prisma!.abuseReport.findUnique({ where: { id: req.params.id } })
  if (!existing) return res.status(404).json({ error: 'Report not found.' })

  if (parsed.data.deleteTargetFile && existing.targetType === 'file') {
    await prisma!.privateFile.updateMany({
      where: { id: existing.targetId },
      data: { publishToken: null, publishedAt: null, deletedAt: new Date() },
    })
  }

  const updated = await prisma!.abuseReport.update({
    where: { id: existing.id },
    data: {
      status: parsed.data.status,
      resolutionNote: parsed.data.resolutionNote ?? existing.resolutionNote,
      resolvedAt: parsed.data.status === 'actioned' || parsed.data.status === 'dismissed' ? new Date() : null,
    },
  })
  return res.json({ report: updated })
}))

export default router
