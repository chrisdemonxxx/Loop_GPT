/**
 * Unified persistence for conversations and messages, abstracting over Prisma
 * (Postgres) and the in-memory fallback store. Used by the streaming agent
 * route so it doesn't duplicate the branching logic in routes/messages.ts.
 */
import { PrismaClient } from '@prisma/client'
import { memoryStore } from './memoryStore'

let prisma: PrismaClient | null = null
try {
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('postgresql://user:password')) {
    prisma = new PrismaClient()
  }
} catch {
  prisma = null
}

export const USE_MEMORY_STORE = !prisma

export interface StoredMessage {
  id: string
  role: string
  content: string
  createdAt: string
  messageType?: string
  imageUrl?: string | null
  imagePath?: string | null
  toolUsed?: string | null
  metadata?: any
}

export interface SaveMessageInput {
  role: 'user' | 'assistant'
  content: string
  messageType?: string
  imageUrl?: string | null
  imagePath?: string | null
  toolUsed?: string | null
  metadata?: any
}

async function ensureDevUser(userId: string) {
  if (!prisma) return
  // The shared guest identity (used when ENABLE_DEV_MODE is on) must exist in the
  // User table before conversations can reference it — regardless of NODE_ENV.
  if (userId === 'dev-user-123') {
    const existing = await prisma.user.findUnique({ where: { id: userId } })
    if (!existing) {
      const bcrypt = require('bcryptjs')
      await prisma.user.create({
        data: { id: userId, email: 'guest@loop-gpt.local', password: await bcrypt.hash('guest', 10), name: 'Guest' },
      })
    }
  }
}

export async function getOrCreateConversation(
  userId: string,
  conversationId: string,
  title: string
): Promise<{ id: string; title: string; userId: string } | null> {
  if (USE_MEMORY_STORE) {
    memoryStore.ensureUser(userId)
    if (conversationId === 'new') return memoryStore.createConversation(userId, title.slice(0, 50) || 'New Chat')
    const conv = memoryStore.getConversation(conversationId)
    if (!conv || conv.userId !== userId) return null
    return conv
  }

  await ensureDevUser(userId)
  if (conversationId === 'new') {
    return prisma!.conversation.create({ data: { title: title.slice(0, 50) || 'New Chat', userId } })
  }
  const whereClause: any = { id: conversationId }
  if (process.env.NODE_ENV !== 'development' || userId !== 'dev-user-123') whereClause.userId = userId
  let conv = await prisma!.conversation.findFirst({ where: whereClause })
  if (!conv && process.env.NODE_ENV === 'development' && userId === 'dev-user-123') {
    conv = await prisma!.conversation.create({ data: { id: conversationId, title: title.slice(0, 50) || 'New Chat', userId } })
  }
  return conv
}

export async function getHistory(conversationId: string, take = 20): Promise<StoredMessage[]> {
  if (USE_MEMORY_STORE) {
    return memoryStore.getMessages(conversationId).slice(-take).map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    })) as StoredMessage[]
  }
  const rows = await prisma!.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take,
  })
  return rows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) as StoredMessage[]
}

export async function saveMessage(conversationId: string, input: SaveMessageInput): Promise<StoredMessage> {
  if (USE_MEMORY_STORE) {
    const m = memoryStore.addMessage(conversationId, {
      role: input.role,
      content: input.content,
      conversationId,
      messageType: input.messageType || 'text',
      imageUrl: input.imageUrl || undefined,
      imagePath: input.imagePath || undefined,
      toolUsed: input.toolUsed || undefined,
      metadata: input.metadata,
    })
    return { ...m, createdAt: m.createdAt.toISOString() } as StoredMessage
  }
  const m = await prisma!.message.create({
    data: {
      role: input.role,
      content: input.content,
      conversationId,
      messageType: input.messageType || 'text',
      imageUrl: input.imageUrl || null,
      imagePath: input.imagePath || null,
      toolUsed: input.toolUsed || null,
      metadata: input.metadata ?? undefined,
    },
  })
  await prisma!.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } })
  return { ...m, createdAt: m.createdAt.toISOString() } as StoredMessage
}
