/**
 * Named bots: CRUD, the seeded roster, 1:1 threads, and group chats.
 * Mounted at /api/bots. Every row is owner-scoped.
 */
import express from 'express'
import { authenticateToken } from './auth'
import { asyncHandler } from '../middleware/errorLogger'
import { hasDb, prisma } from '../services/prisma'
import { BotError, createBot, createGroup, deleteBot, listBots, openBotThread, updateBot } from '../services/bots'

const router = express.Router()
router.use(authenticateToken)

function fail(res: express.Response, error: unknown) {
  if (error instanceof BotError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'forbidden' ? 403 : error.code === 'unavailable' ? 503 : 400
    return res.status(status).json({ error: error.message, code: error.code })
  }
  throw error
}

async function userName(userId: string): Promise<string | null> {
  if (!hasDb || !prisma) return null
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } })
  return user?.name ?? null
}

router.get('/', asyncHandler(async (req, res) => {
  try {
    res.json(await listBots((req as any).userId))
  } catch (error) { return fail(res, error) }
}))

router.post('/', asyncHandler(async (req, res) => {
  try {
    const userId = (req as any).userId as string
    const body = req.body || {}
    const created = await createBot(userId, {
      name: String(body.name || ''),
      label: body.label != null ? String(body.label) : undefined,
      avatarColor: body.avatarColor != null ? String(body.avatarColor) : undefined,
      persona: body.persona != null ? String(body.persona) : undefined,
      defaultTools: Array.isArray(body.defaultTools) ? body.defaultTools.map(String) : undefined,
      cloudComputer: body.cloudComputer === true,
    }, await userName(userId))
    res.status(201).json(created)
  } catch (error) { return fail(res, error) }
}))

router.patch('/:id', asyncHandler(async (req, res) => {
  try {
    const body = req.body || {}
    const bot = await updateBot((req as any).userId, req.params.id, {
      name: body.name != null ? String(body.name) : undefined,
      label: body.label != null ? String(body.label) : undefined,
      avatarColor: body.avatarColor != null ? String(body.avatarColor) : undefined,
      persona: body.persona != null ? String(body.persona) : undefined,
      defaultTools: Array.isArray(body.defaultTools) ? body.defaultTools.map(String) : undefined,
      cloudComputer: body.cloudComputer !== undefined ? body.cloudComputer === true : undefined,
    })
    res.json({ bot })
  } catch (error) { return fail(res, error) }
}))

router.delete('/:id', asyncHandler(async (req, res) => {
  try {
    res.json(await deleteBot((req as any).userId, req.params.id))
  } catch (error) { return fail(res, error) }
}))

/** Find or create the bot's own chat thread and land in it. */
router.post('/:id/thread', asyncHandler(async (req, res) => {
  try {
    const userId = (req as any).userId as string
    const conversation = await openBotThread(userId, req.params.id, await userName(userId))
    res.json({
      id: conversation.id,
      title: conversation.title,
      botId: conversation.botId,
      kind: conversation.kind,
    })
  } catch (error) { return fail(res, error) }
}))

router.post('/groups', asyncHandler(async (req, res) => {
  try {
    const body = req.body || {}
    const ids = Array.isArray(body.botIds) ? body.botIds.map(String) : []
    const conversation = await createGroup((req as any).userId, ids, body.name != null ? String(body.name) : undefined)
    res.status(201).json({
      id: conversation.id,
      title: conversation.title,
      kind: conversation.kind,
      botIds: conversation.botIds,
    })
  } catch (error) { return fail(res, error) }
}))

export default router
