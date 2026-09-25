/**
 * Unified persistence for conversations and messages, abstracting over Prisma
 * (Postgres) and the in-memory fallback store. Used by the streaming agent
 * route so it doesn't duplicate the branching logic in routes/messages.ts.
 */
import { prisma } from './prisma'
import { memoryStore } from './memoryStore'
import { randomBytes } from 'crypto'

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
  if (userId === 'dev-user-123' && process.env.NODE_ENV === 'development' && process.env.ENABLE_DEV_MODE === 'true') {
    const existing = await prisma.user.findUnique({ where: { id: userId } })
    if (!existing) {
      // Lazy-load bcrypt (dev-mode guest bootstrap only); keeps the module out of the hot path.
      const bcrypt = (await import('bcryptjs')).default
      await prisma.user.upsert({
        where: { id: userId }, update: {},
        create: { id: userId, email: 'guest@loop-gpt.local', password: await bcrypt.hash(randomBytes(32).toString('hex'), 10), name: 'Local Developer' },
      })
    }
  }
}

export async function getOrCreateConversation(
  userId: string,
  conversationId: string,
  title: string
): Promise<{ id: string; title: string; userId: string } | null> {
  if (typeof userId !== 'string' || !userId.trim()) return null
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
  return prisma!.conversation.findFirst({ where: { id: conversationId, userId } })
}

export async function getHistory(conversationId: string, take = 20): Promise<StoredMessage[]> {
  if (!Number.isSafeInteger(take) || take < 0 || take > 500) {
    throw new RangeError('History size must be an integer between 0 and 500')
  }
  if (take === 0) return []
  if (USE_MEMORY_STORE) {
    return memoryStore.getMessages(conversationId).slice(-take).map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    })) as StoredMessage[]
  }
  const rows = await prisma!.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take,
  })
  // Fetch the newest window, then present it in conversational order.
  return rows.reverse().map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) as StoredMessage[]
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
