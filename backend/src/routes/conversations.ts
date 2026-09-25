import express from 'express'
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
      // Incognito conversations stay out of the sidebar (brief §2.5); they
      // remain reachable by id while active.
      where: { userId, incognito: false },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
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

// Update conversation
router.patch('/:id', authenticateToken, validate(validationSchemas.updateConversation), async (req, res) => {
  try {
    const userId = (req as any).userId
    const { id } = req.params
    const { title } = req.body

    if (USE_MEMORY_STORE) {
      const conversation = memoryStore.getConversation(id)
      if (!conversation || conversation.userId !== userId) {
        return res.status(404).json({ error: 'Conversation not found' })
      }
      memoryStore.updateConversation(id, { title, updatedAt: new Date() })
      return res.json({ success: true })
    }

    const conversation = await prisma!.conversation.updateMany({
      where: {
        id,
        userId,
      },
      data: {
        title,
        updatedAt: new Date(),
      },
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

