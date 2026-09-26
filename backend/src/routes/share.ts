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
        activeLeafId: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, role: true, content: true, createdAt: true, parentId: true },
        },
      },
    })
    if (!conversation) return res.status(404).json({ error: 'This share link is invalid or has been revoked' })
    // §8-22: share the ACTIVE PATH only — the branch the transcript
    // displays. Unbranched conversations (no active leaf, or a pre-migration
    // edge) keep the flat chronology, which is exactly their active path.
    const rows = conversation.messages
    let served = rows
    if (conversation.activeLeafId) {
      const byId = new Map(rows.map((m) => [m.id, m]))
      const pathIds: string[] = []
      const seen = new Set<string>()
      let cursor: string | null | undefined = conversation.activeLeafId
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor)
        const row = byId.get(cursor)
        if (!row) break
        pathIds.push(row.id)
        cursor = row.parentId
      }
      pathIds.reverse()
      const onPath = new Set(pathIds)
      served = rows.filter((m) => onPath.has(m.id))
    }
    res.setHeader('Cache-Control', 'public, max-age=60')
    res.json({
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      messages: served.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })),
    })
  } catch {
    res.status(503).json({ error: 'Sharing is temporarily unavailable' })
  }
})
