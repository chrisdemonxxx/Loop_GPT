/**
 * Owner-scoped bot CRUD, starter seeding, and per-bot / group threads.
 */
import { prisma, hasDb } from './prisma'
import { previewLine } from '../agent/agentRuntime'
import { STARTER_BOTS, greeting, botsForMessage, primaryDeleteRefusal, rosterAction, type MentionBot } from './botRoster'

export class BotError extends Error {
  constructor(public readonly code: 'unavailable' | 'not_found' | 'invalid' | 'forbidden', detail?: string) {
    super(detail || code)
  }
}

function db() {
  if (!hasDb || !prisma) throw new BotError('unavailable', 'Bots require a database.')
  return prisma
}

const COLORS = ['#c96442', '#7c6af7', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ec4899', '#14b8a6']

export interface BotRecord {
  id: string
  name: string
  label: string
  avatarColor: string
  persona: string
  defaultTools: string[]
  cloudComputer: boolean
  isPrimary: boolean
  createdAt: string
}

function asTools(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

function toRecord(row: {
  id: string
  name: string
  label: string
  avatarColor: string
  persona: string
  defaultTools: unknown
  cloudComputer: boolean
  isPrimary: boolean
  createdAt: Date
}): BotRecord {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    avatarColor: row.avatarColor,
    persona: row.persona,
    defaultTools: asTools(row.defaultTools),
    cloudComputer: row.cloudComputer,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Seed the roster once, when the owner has no bots. Idempotent. */
export async function ensureRoster(ownerId: string): Promise<void> {
  const database = db()
  const count = await database.bot.count({ where: { ownerId } })
  const primary = count > 0
    ? await database.bot.findFirst({ where: { ownerId, isPrimary: true }, select: { id: true } })
    : null
  const action = rosterAction(count, !!primary)
  if (action === 'keep') return
  if (action === 'repair-primary') {
    const loop = STARTER_BOTS[0]
    await database.bot.create({
      data: {
        ownerId,
        name: loop.name,
        label: loop.label,
        avatarColor: loop.avatarColor,
        persona: loop.persona,
        defaultTools: loop.defaultTools,
        cloudComputer: loop.cloudComputer,
        isPrimary: true,
      },
    })
    return
  }
  await database.bot.createMany({
    data: STARTER_BOTS.map((b) => ({
      ownerId,
      name: b.name,
      label: b.label,
      avatarColor: b.avatarColor,
      persona: b.persona,
      defaultTools: b.defaultTools,
      cloudComputer: b.cloudComputer,
      isPrimary: b.isPrimary,
    })),
  })
}

export async function primaryBotId(ownerId: string): Promise<string | null> {
  try {
    if (!hasDb || !prisma) return null
    await ensureRoster(ownerId)
    const row = await prisma.bot.findFirst({ where: { ownerId, isPrimary: true }, select: { id: true } })
    return row?.id ?? null
  } catch {
    return null
  }
}

export interface BotListItem extends BotRecord {
  conversationId: string | null
  preview: string
  updatedAt: string | null
  working: boolean
}

export interface GroupListItem {
  id: string
  title: string
  botIds: string[]
  preview: string
  updatedAt: string
}

export async function listBots(ownerId: string): Promise<{ bots: BotListItem[]; groups: GroupListItem[] }> {
  const database = db()
  await ensureRoster(ownerId)
  const [bots, threads, active] = await Promise.all([
    database.bot.findMany({ where: { ownerId }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }),
    database.conversation.findMany({
      where: { userId: ownerId, kind: { in: ['bot', 'group'] }, incognito: false },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, title: true, kind: true, botId: true, botIds: true, updatedAt: true,
        messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, role: true } },
      },
    }),
    database.agentTask.findMany({
      where: { userId: ownerId, status: { in: ['queued', 'processing'] }, botId: { not: null } },
      select: { botId: true },
    }),
  ])
  const working = new Set(active.map((t) => t.botId).filter((id): id is string => !!id))
  const byBot = new Map<string, typeof threads[number]>()
  for (const thread of threads) {
    if (thread.kind === 'bot' && thread.botId && !byBot.has(thread.botId)) byBot.set(thread.botId, thread)
  }
  return {
    bots: bots.map((bot) => {
      const thread = byBot.get(bot.id)
      const last = thread?.messages[0]
      return {
        ...toRecord(bot),
        conversationId: thread?.id ?? null,
        preview: last ? clip(last.content) : '',
        updatedAt: thread ? thread.updatedAt.toISOString() : null,
        working: working.has(bot.id),
      }
    }),
    groups: threads.filter((t) => t.kind === 'group').map((t) => ({
      id: t.id,
      title: t.title,
      botIds: asTools(t.botIds),
      preview: t.messages[0] ? clip(t.messages[0].content) : '',
      updatedAt: t.updatedAt.toISOString(),
    })),
  }
}

function clip(text: string): string {
  return previewLine(text)
}

export interface CreateBotInput {
  name: string
  label?: string
  avatarColor?: string
  persona?: string
  defaultTools?: string[]
  cloudComputer?: boolean
}

export async function createBot(ownerId: string, input: CreateBotInput, userName?: string | null) {
  const name = input.name.trim().slice(0, 60)
  if (!name) throw new BotError('invalid', 'A bot needs a name.')
  const database = db()
  const bot = await database.bot.create({
    data: {
      ownerId,
      name,
      label: (input.label || '').trim().slice(0, 80),
      avatarColor: COLORS.includes(input.avatarColor || '') ? input.avatarColor! : COLORS[Math.floor(Math.random() * COLORS.length)],
      persona: (input.persona || `You are ${name}. Narrate progress in plain sentences. Never print raw tool JSON.`).slice(0, 8000),
      defaultTools: (input.defaultTools || []).filter((t) => typeof t === 'string').slice(0, 16),
      cloudComputer: input.cloudComputer === true,
      isPrimary: false,
    },
  })
  const thread = await openBotThread(ownerId, bot.id, userName)
  return { bot: toRecord(bot), conversationId: thread.id }
}

export async function updateBot(ownerId: string, id: string, patch: Partial<CreateBotInput>) {
  const database = db()
  const existing = await database.bot.findFirst({ where: { id, ownerId } })
  if (!existing) throw new BotError('not_found')
  const data: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 60)
    if (!name) throw new BotError('invalid', 'A bot needs a name.')
    data.name = name
  }
  if (patch.label !== undefined) data.label = patch.label.trim().slice(0, 80)
  if (patch.avatarColor && COLORS.includes(patch.avatarColor)) data.avatarColor = patch.avatarColor
  if (patch.persona !== undefined) data.persona = patch.persona.slice(0, 8000)
  if (patch.defaultTools) data.defaultTools = patch.defaultTools.filter((t) => typeof t === 'string').slice(0, 16)
  if (patch.cloudComputer !== undefined) data.cloudComputer = patch.cloudComputer === true
  const bot = await database.bot.update({ where: { id }, data })
  return toRecord(bot)
}

export async function deleteBot(ownerId: string, id: string) {
  const database = db()
  const existing = await database.bot.findFirst({ where: { id, ownerId } })
  if (!existing) throw new BotError('not_found')
  const refusal = primaryDeleteRefusal(existing.isPrimary)
  if (refusal) throw new BotError('forbidden', refusal)
  await database.bot.delete({ where: { id } })
  return { ok: true }
}

/** Find or create the 1:1 thread, and greet on the first open. */
export async function openBotThread(ownerId: string, botId: string, userName?: string | null) {
  const database = db()
  const bot = await database.bot.findFirst({ where: { id: botId, ownerId } })
  if (!bot) throw new BotError('not_found')
  const existing = await database.conversation.findFirst({
    where: { userId: ownerId, botId, kind: 'bot', incognito: false },
    orderBy: { updatedAt: 'desc' },
  })
  if (existing) return existing
  const conversation = await database.conversation.create({
    data: {
      userId: ownerId,
      title: bot.name,
      botId: bot.id,
      kind: 'bot',
      botIds: [bot.id],
    },
  })
  const hello = await database.message.create({
    data: {
      conversationId: conversation.id,
      role: 'assistant',
      content: greeting(userName, bot.name),
      authorBotId: bot.id,
    },
  })
  await database.conversation.update({ where: { id: conversation.id }, data: { activeLeafId: hello.id } })
  return conversation
}

export async function createGroup(ownerId: string, botIds: string[], name?: string) {
  const database = db()
  const unique = [...new Set(botIds.map((id) => String(id || '').trim()).filter(Boolean))]
  if (unique.length < 2) throw new BotError('invalid', 'A group needs at least two bots.')
  const members = await database.bot.findMany({ where: { ownerId, id: { in: unique } } })
  if (members.length < 2) throw new BotError('invalid', 'Pick bots from your roster.')
  const ids = members.map((m) => m.id)
  const title = (name || '').trim().slice(0, 80) || members.map((m) => m.name).join(', ')
  return database.conversation.create({
    data: { userId: ownerId, title, kind: 'group', botIds: ids },
  })
}

export async function groupMembers(ownerId: string, conversationId: string): Promise<MentionBot[]> {
  const database = db()
  const conversation = await database.conversation.findFirst({
    where: { id: conversationId, userId: ownerId, kind: 'group' },
    select: { botIds: true },
  })
  if (!conversation) throw new BotError('not_found')
  const ids = asTools(conversation.botIds)
  if (!ids.length) return []
  const bots = await database.bot.findMany({ where: { ownerId, id: { in: ids } }, select: { id: true, name: true } })
  return bots
}

export function routeGroupMessage<T extends MentionBot>(text: string, members: T[]): T[] {
  return botsForMessage(text, members)
}
