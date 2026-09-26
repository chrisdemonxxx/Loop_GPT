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
  /** Branch tree (§8-22): the row this message follows in its branch. */
  parentId?: string | null
}

export interface SaveMessageInput {
  role: 'user' | 'assistant'
  content: string
  messageType?: string
  imageUrl?: string | null
  imagePath?: string | null
  toolUsed?: string | null
  metadata?: any
  /** Branch parent (§8-22). `undefined` = append under the conversation's
   * active leaf (the default send path); an explicit value (including null
   * for a new root sibling) creates a branch version instead. */
  parentId?: string | null
}

/** Branch transcript envelope (§8-22): every row plus the active leaf so the
 * client can derive the visible path and the <2/3> version groups locally. */
export interface BranchEnvelope {
  activeLeafId: string | null
  messages: StoredMessage[]
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
  // Branch-aware context (§8-22): the newest window of the ACTIVE PATH —
  // the branch the transcript displays — never a flat chronological mix
  // that would leak other versions into the model's context. A
  // conversation without an active leaf (empty, or a pre-migration edge)
  // keeps the flat read, which is exactly the old behavior.
  const conversation = await prisma!.conversation.findUnique({ where: { id: conversationId }, select: { activeLeafId: true } })
  if (!conversation?.activeLeafId) {
    const rows = await prisma!.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    })
    // Fetch the newest window, then present it in conversational order.
    return rows.reverse().map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) as StoredMessage[]
  }
  return getHistoryFromLeaf(conversation.activeLeafId, take)
}

/**
 * The newest `take` window of the branch path ending at `leafId` (root →
 * leaf order). Used by run assembly (§8-22): retry runs walk from the user
 * row being re-answered, normal runs from the conversation's active leaf.
 */
export async function getHistoryFromLeaf(leafId: string, take = 20): Promise<StoredMessage[]> {
  if (!Number.isSafeInteger(take) || take < 0 || take > 500) {
    throw new RangeError('History size must be an integer between 0 and 500')
  }
  if (take === 0) return []
  if (USE_MEMORY_STORE) {
    // The memory store has no tree; branching is DB-only (§8-22, same as
    // /fork). Nothing routes here in practice — regenerate/branch sends are
    // rejected on the memory store at the route layer.
    return []
  }
  const leaf = await prisma!.message.findUnique({ where: { id: leafId }, select: { conversationId: true } })
  if (!leaf) return []
  // Light pass first: ids + parents only, then the full rows of the window.
  const skel = await prisma!.message.findMany({
    where: { conversationId: leaf.conversationId },
    select: { id: true, parentId: true },
  })
  const byId = new Map(skel.map((s) => [s.id, s]))
  const pathIds: string[] = []
  const seen = new Set<string>()
  let cursor: string | undefined = leafId
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor)
    pathIds.push(cursor)
    cursor = byId.get(cursor)?.parentId ?? undefined
  }
  const windowIds = pathIds.slice(0, take).reverse()
  if (!windowIds.length) return []
  const rows = await prisma!.message.findMany({ where: { id: { in: windowIds } } })
  const rowsById = new Map(rows.map((r) => [r.id, r]))
  return windowIds
    .map((id) => rowsById.get(id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) as StoredMessage[]
}

/**
 * Every row of a conversation plus its active leaf (§8-22) — the client
 * derives the visible path and the <2/3> version groups from this envelope.
 */
export async function listBranchMessages(conversationId: string): Promise<BranchEnvelope> {
  if (USE_MEMORY_STORE) {
    return {
      activeLeafId: null,
      messages: memoryStore.getMessages(conversationId).map((m) => ({
        ...m, createdAt: m.createdAt.toISOString(),
      })) as StoredMessage[],
    }
  }
  const [conversation, rows] = await Promise.all([
    prisma!.conversation.findUnique({ where: { id: conversationId }, select: { activeLeafId: true } }),
    prisma!.message.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ])
  return {
    activeLeafId: conversation?.activeLeafId ?? null,
    messages: rows.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })) as StoredMessage[],
  }
}

/**
 * Switch the conversation's active path to the version anchored at
 * `messageId` (§8-22 arrows): the new tip is the deepest descendant of the
 * selected row, taking the newest child at each internal fork. The recency
 * rule reconstructs "the branch as you left it" — a branch is only ever
 * left by adding to another one, so its newest descendants ARE its last
 * state. Returns the resolved tip (the conversation's new active leaf).
 */
export async function selectBranch(conversationId: string, messageId: string): Promise<string> {
  const target = await prisma!.message.findFirst({ where: { id: messageId, conversationId }, select: { id: true } })
  if (!target) throw new Error('Message not found')
  const skel = await prisma!.message.findMany({
    where: { conversationId },
    select: { id: true, parentId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  // Children of each row, newest first — the walk picks index 0.
  const children = new Map<string, string[]>()
  for (const s of skel) {
    if (!s.parentId) continue
    const bucket = children.get(s.parentId)
    if (bucket) bucket.push(s.id)
    else children.set(s.parentId, [s.id])
  }
  let tip = messageId
  const seen = new Set<string>([messageId])
  for (;;) {
    const next = children.get(tip)?.[0]
    if (!next || seen.has(next)) break
    seen.add(next)
    tip = next
  }
  await prisma!.conversation.update({ where: { id: conversationId }, data: { activeLeafId: tip } })
  return tip
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
  // Branch parenting (§8-22): an explicit parentId (a string, or null for a
  // new root sibling — editing the first prompt) creates a version; only a
  // truly absent field appends, under the conversation's active leaf so a
  // branched conversation stays one connected path.
  let parentId: string | null
  if (input.parentId !== undefined) parentId = input.parentId
  else {
    const conversation = await prisma!.conversation.findUnique({ where: { id: conversationId }, select: { activeLeafId: true } })
    parentId = conversation?.activeLeafId ?? null
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
      parentId,
    },
  })
  // Each save extends the active path: the new row becomes the leaf (the
  // conversation update below rides the existing updatedAt write).
  await prisma!.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date(), activeLeafId: m.id } })
  return { ...m, createdAt: m.createdAt.toISOString() } as StoredMessage
}
