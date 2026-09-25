/**
 * Public read-only share links (audit §8-15): GET /api/share/:token streams
 * the transcript (role/content/createdAt only — never private file URLs or
 * user ids) for a conversation whose owner minted a token. Revoking is
 * owner-side DELETE /api/conversations/:id/share.
 */
import express from 'express'
import { prisma } from '../services/prisma'

const TOKEN = /^[0-9a-f]{32}$/

export const shareRouter = express.Router()

shareRouter.get('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '')
    if (!TOKEN.test(token)) return res.status(404).json({ error: 'This share link is invalid or has been revoked' })
    if (!prisma) return res.status(503).json({ error: 'Sharing is temporarily unavailable' })
    const conversation = await prisma.conversation.findFirst({
      where: { shareToken: token },
      select: {
        title: true,
        createdAt: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { role: true, content: true, createdAt: true },
        },
      },
    })
    if (!conversation) return res.status(404).json({ error: 'This share link is invalid or has been revoked' })
    res.setHeader('Cache-Control', 'public, max-age=60')
    res.json({
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      messages: conversation.messages.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    })
  } catch {
    res.status(503).json({ error: 'Sharing is temporarily unavailable' })
  }
})
