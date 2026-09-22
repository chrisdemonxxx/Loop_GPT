import express from 'express'
import { z } from 'zod'
import { prisma } from '../services/prisma'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { synthesizeStylePrompt } from '../agent/tools/generateStyle'

export const stylesRouter = express.Router()

// Styles are per-user; every verb requires an authenticated identity.
stylesRouter.use(authenticateToken)

const styleInput = z.object({
  name: z.string().trim().min(1).max(100),
  systemPrompt: z.string().trim().max(5000).default(''),
  temperature: z.number().min(0).max(2).nullable().optional(),
  isDefault: z.boolean().default(false),
}).strict()
const styleUpdateInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  systemPrompt: z.string().trim().max(5000).optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  isDefault: z.boolean().optional(),
}).strict()

/** List the authenticated user's styles. */
stylesRouter.get('/', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const styles = await prisma!.userStyle.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })
  res.json(styles)
}))

/** Create a style. */
stylesRouter.post('/', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const input = styleInput.parse(req.body)
  const style = await prisma!.userStyle.create({
    data: { userId, ...input, temperature: input.temperature ?? null },
  })
  res.status(201).json(style)
}))

/** Create a style from a writing sample: analyse the sample and return a
 * suggested system prompt (the caller reviews it, then saves via POST /). */
stylesRouter.post('/from-sample', asyncHandler(async (req, res) => {
  const sample = z.string().trim().min(100).max(10000).parse(req.body?.sample)
  try {
    const systemPrompt = await synthesizeStylePrompt(sample)
    res.json({ systemPrompt })
  } catch (e: any) {
    res.status(502).json({ error: `Style analysis failed: ${e?.message || e}` })
  }
}))

/** Update a style. */
stylesRouter.patch('/:styleId', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const input = styleUpdateInput.parse(req.body)
  const style = await prisma!.userStyle.findFirst({ where: { id: req.params.styleId, userId } })
  if (!style) return res.status(404).json({ error: 'Style not found.' })
  const updated = await prisma!.userStyle.update({
    where: { id: req.params.styleId },
    data: { ...input, temperature: input.temperature !== undefined ? (input.temperature ?? null) : undefined },
  })
  res.json(updated)
}))

/** Delete a style. */
stylesRouter.delete('/:styleId', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const style = await prisma!.userStyle.findFirst({ where: { id: req.params.styleId, userId } })
  if (!style) return res.status(404).json({ error: 'Style not found.' })
  await prisma!.userStyle.delete({ where: { id: req.params.styleId } })
  res.status(204).end()
}))

/** Resolve the active style for a user (by id or default). */
export async function resolveActiveStyle(userId: string, styleId?: string | null): Promise<{ name?: string; systemPrompt?: string; temperature?: number | null } | null> {
  if (styleId) {
    const style = await prisma!.userStyle.findFirst({ where: { id: styleId, userId } })
    if (style) return { name: style.name, systemPrompt: style.systemPrompt, temperature: style.temperature }
    return null
  }
  const defaultStyle = await prisma!.userStyle.findFirst({ where: { userId, isDefault: true } })
  if (defaultStyle) return { name: defaultStyle.name, systemPrompt: defaultStyle.systemPrompt, temperature: defaultStyle.temperature }
  return null
}
