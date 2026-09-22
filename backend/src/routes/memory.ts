/**
 * User memories (GAP-021). Explicit memories are written by the `remember`
 * tool and by the user here; the list is editable and can be paused, reset
 * and exported. A nightly synthesis pass can add `kind:'synthesized'` rows.
 */
import express from 'express'
import { z } from 'zod'
import { prisma } from '../services/prisma'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'

export const memoryRouter = express.Router()
memoryRouter.use(authenticateToken)

const createInput = z.object({
  content: z.string().trim().min(1).max(5000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  kind: z.enum(['explicit', 'synthesized']).default('explicit'),
  source: z.enum(['user', 'agent']).default('user'),
  projectId: z.string().max(160).nullable().optional(),
}).strict()

const updateInput = z.object({
  content: z.string().trim().min(1).max(5000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
}).strict()

function db() {
  if (!prisma) throw Object.assign(new Error('Memory requires a database'), { status: 503 })
  return prisma
}

memoryRouter.get('/', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const rows = await db().memory.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: 500 })
  const user = await db().user.findUnique({ where: { id: userId }, select: { memoryEnabled: true } })
  res.json({ memories: rows, enabled: user ? user.memoryEnabled : true })
}))

memoryRouter.post('/', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const input = createInput.parse(req.body)
  const row = await db().memory.create({ data: { userId, ...input, projectId: input.projectId ?? undefined } })
  res.status(201).json(row)
}))

/** Global toggle: use memory across conversations. */
memoryRouter.get('/enabled', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const user = await db().user.findUnique({ where: { id: userId }, select: { memoryEnabled: true } })
  res.json({ enabled: user ? user.memoryEnabled : true })
}))

memoryRouter.post('/enabled', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean.' })
  await db().user.update({ where: { id: userId }, data: { memoryEnabled: enabled } })
  res.json({ enabled })
}))

memoryRouter.patch('/:id', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const input = updateInput.parse(req.body)
  const existing = await db().memory.findFirst({ where: { id: req.params.id, userId } })
  if (!existing) return res.status(404).json({ error: 'Memory not found.' })
  const row = await db().memory.update({ where: { id: req.params.id }, data: input })
  res.json(row)
}))

memoryRouter.delete('/:id', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const existing = await db().memory.findFirst({ where: { id: req.params.id, userId } })
  if (!existing) return res.status(404).json({ error: 'Memory not found.' })
  await db().memory.delete({ where: { id: req.params.id } })
  res.status(204).end()
}))

/** Reset: delete every memory for the user. */
memoryRouter.post('/reset', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const result = await db().memory.deleteMany({ where: { userId } })
  res.json({ ok: true, deleted: result.count })
}))
