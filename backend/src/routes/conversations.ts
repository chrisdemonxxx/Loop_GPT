import express from 'express'
import { randomBytes } from 'crypto'
import { prisma } from '../services/prisma'
import { getOrCreateConversation } from '../services/chatStore'
import { authenticateToken } from './auth'
import { memoryStore } from '../services/memoryStore'
import { validate, validationSchemas } from '../middleware/validation'

const router = express.Router()
const USE_MEMORY_STORE = !prisma

// Get all conversations for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).userId

    if (USE_MEMORY_STORE) {
      const conversations = memoryStore.getConversations(userId)
      return res.json(conversations.map(conv => ({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt.toISOString(),
        updatedAt: conv.updatedAt.toISOString(),
      })))
    }

    const conversations = await prisma!.conversation.findMany({
      // Incognito conversations stay out of the sidebar (brief A2.5); they
      // remain reachable by id while active.
      where: { userId, incognito: false },
      // Pinned first (audit §8-13), then recency — the client groups by
      // date bucket from this order.
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        pinned: true,
      },
    })

    res.json(conversations)
  } catch (error) {
    console.error('Get conversations error:', error)
    // In development, return empty array instead of error
    if (process.env.NODE_ENV === 'development') {
      return res.json([])
    }
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Search conversation MESSAGE BODIES (audit §8-16: sidebar search previously
 * matched titles only). Returns the newest match per conversation with a
 * snippet. Incognito conversations are excluded from results. Registered
 * before GET /:id so "search" is never mistaken for an id.
 */
router.get('/search', authenticateToken, async (req, res) => {
  try {
    if (USE_MEMORY_STORE) return res.status(503).json({ error: 'Message search requires the database' })
    const userId = (req as any).userId
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.json([])
    const messages = await prisma!.message.findMany({
      where: {
        conversation: { userId, incognito: false },
        content: { contains: q, mode: 'insensitive' },
      },
      select: {
        content: true,
        createdAt: true,
        conversation: { select: { id: true, title: true, updatedAt: true, pinned: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
    })
    // Newest match per conversation wins; snippet from that match.
    const byConversation = new Map<string, { conversationId: string; title: string; updatedAt: string; pinned: boolean; snippet: string; matches: number }>()
    for (const m of messages) {
      const c = m.conversation
      const existing = byConversation.get(c.id)
      if (existing) { existing.matches += 1; continue }
      const idx = m.content.toLowerCase().indexOf(q.toLowerCase())
      const start = Math.max(0, idx - 40)
      byConversation.set(c.id, {
        conversationId: c.id,
        title: c.title,
        updatedAt: c.updatedAt.toISOString(),
        pinned: c.pinned,
        snippet: `${start > 0 ? '…' : ''}${m.content.slice(start, start + 120).replace(/\s+/g, ' ')}${m.content.length > start + 120 ? '…' : ''}`,
        matches: 1,
      })
    }
    res.json([...byConversation.values()])
  } catch (error) {
    console.error('Conversation search error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get single conversation
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = (req as any).userId
    const { id } = req.params

    if (USE_MEMORY_STORE) {
      const conversation = memoryStore.getConversation(id)
      if (!conversation || conversation.userId !== userId) {
        return res.status(404).json({ error: 'Conversation not found' })
      }
      const messages = memoryStore.getMessages(id)
      return res.json({
        ...conversation,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
        messages: messages.map(msg => ({
            ...msg, imagePath: null,
          createdAt: msg.createdAt.toISOString(),
        })),
      })
    }

    const conversation = await prisma!.conversation.findFirst({
      where: {
        id,
        userId,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
        },
      },
    })

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    res.json({ ...conversation, messages: conversation.messages.map((message) => ({ ...message, imagePath: null })) })
  } catch (error) {
    console.error('Get conversation error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create new conversation
router.post('/', authenticateToken, validate(validationSchemas.createConversation), async (req, res) => {
  try {
    const userId = (req as any).userId
    const { title } = req.body

    if (USE_MEMORY_STORE) {
      memoryStore.ensureUser(userId)
      const conversation = memoryStore.createConversation(userId, title || 'New Chat')
      return res.json({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      })
    }

    const conversation = await getOrCreateConversation(userId, 'new', title || 'New Chat')

    res.json(conversation)
  } catch (error) {
    console.error('Create conversation error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update conversation (title and/or pinned)
router.patch('/:id', authenticateToken, validate(validationSchemas.updateConversation), async (req, res) => {
  try {
    const userId = (req as any).userId
    const { id } = req.params
    const { title, pinned } = req.body

    if (USE_MEMORY_STORE) {
      const conversation = memoryStore.getConversation(id)
      if (!conversation || conversation.userId !== userId) {
        return res.status(404).json({ error: 'Conversation not found' })
      }
      memoryStore.updateConversation(id, { title, updatedAt: new Date() })
      return res.json({ success: true })
    }

    // Pinning never bumps updatedAt — the sidebar's date groups stay stable.
    // Prisma's @updatedAt rewrites the column on every update, so a pin-only
    // PATCH carries the existing timestamp forward explicitly.
    const data: { title?: string; pinned?: boolean; updatedAt?: Date } = {}
    if (title !== undefined) { data.title = title; data.updatedAt = new Date() }
    if (pinned !== undefined) {
      data.pinned = pinned
      if (title === undefined) {
        const current = await prisma!.conversation.findFirst({ where: { id, userId }, select: { updatedAt: true } })
        if (!current) return res.status(404).json({ error: 'Conversation not found' })
        data.updatedAt = current.updatedAt
      }
    }
    const conversation = await prisma!.conversation.updateMany({
      where: {
        id,
        userId,
      },
      data,
    })

    if (conversation.count === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Update conversation error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create (or return) a public read-only share token for a conversation
// (audit §8-15: per-chat Share).
router.post('/:id/share', authenticateToken, async (req, res) => {
  try {
    if (USE_MEMORY_STORE) return res.status(503).json({ error: 'Sharing requires the database' })
    const userId = (req as any).userId
    const { id } = req.params
    const existing = await prisma!.conversation.findFirst({
      where: { id, userId },
      select: { shareToken: true },
    })
    if (!existing) return res.status(404).json({ error: 'Conversation not found' })
    if (existing.shareToken) return res.json({ url: `/share/${existing.shareToken}`, token: existing.shareToken })
    const token = randomBytes(16).toString('hex')
    await prisma!.conversation.update({ where: { id }, data: { shareToken: token } })
    res.json({ url: `/share/${token}`, token })
  } catch (error) {
    console.error('Share conversation error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Revoke a share link.
router.delete('/:id/share', authenticateToken, async (req, res) => {
  try {
    if (USE_MEMORY_STORE) return res.status(503).json({ error: 'Sharing requires the database' })
    const userId = (req as any).userId
    const revoked = await prisma!.conversation.updateMany({
      where: { id: req.params.id, userId, shareToken: { not: null } },
      data: { shareToken: null },
    })
    if (revoked.count === 0) return res.status(404).json({ error: 'Conversation not found' })
    res.json({ success: true })
  } catch (error) {
    console.error('Unshare conversation error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Delete conversation
router.delete('/:id', authenticateToken, validate(validationSchemas.deleteConversation), async (req, res) => {
  try {
    const userId = (req as any).userId
    const { id } = req.params

    if (USE_MEMORY_STORE) {
      const conversation = memoryStore.getConversation(id)
      if (!conversation || conversation.userId !== userId) {
        return res.status(404).json({ error: 'Conversation not found' })
      }
      memoryStore.deleteConversation(id)
      return res.json({ success: true })
    }

    const conversation = await prisma!.conversation.deleteMany({
      where: {
        id,
        userId,
      },
    })

    if (conversation.count === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Delete conversation error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router

