/**
 * Nightly memory synthesis (brief §2.3 / GAP-044): a scheduled job reviews
 * each memory-enabled user's recent conversations and extracts durable
 * facts/preferences into Memory rows (kind 'synthesized', source 'agent') —
 * visually distinct in Settings → Memory via the existing source badges.
 *
 * Safety rails: per-user nightly cap, total synthesized cap with oldest-first
 * pruning, dedupe against existing memories, JSON-only model output, and an
 * env kill-switch (MEMORY_SYNTHESIS_ENABLED, default on in production).
 */
import { prisma } from './prisma'
import { createClient, completeOnce } from '../agent/llmClient'
import { resolveChatTarget } from './chatModels'

const PER_USER_NIGHTLY_CAP = 5
const PER_USER_TOTAL_CAP = 30
const MAX_USERS_PER_RUN = 200
const MAX_CONVERSATIONS_PER_USER = 12
const MAX_TRANSCRIPT_CHARS = 24_000

export interface SynthesisRunResult {
  usersConsidered: number
  usersProcessed: number
  memoriesCreated: number
  errors: number
  startedAt: string
  finishedAt: string
}

export function synthesisEnabled(): boolean {
  return process.env.MEMORY_SYNTHESIS_ENABLED !== 'false'
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
}

/** Is a candidate memory redundant with an existing one? */
function isDuplicate(candidate: string, existing: string[]): boolean {
  const c = normalize(candidate)
  if (c.length < 8) return true
  return existing.some((e) => {
    const n = normalize(e)
    return n === c || (c.length >= 24 && n.includes(c)) || (n.length >= 24 && c.includes(n))
  })
}

/** Call the fast tier to extract memories from a transcript. */
async function extractMemories(transcript: string, signal?: AbortSignal): Promise<Array<{ content: string; tags?: string[] }>> {
  const target = resolveChatTarget('standard')
  const client = createClient('huggingface', undefined, target.baseUrl)
  const prompt = [
    'You extract durable memories about a user from conversation transcripts.',
    'Return ONLY a JSON array (no prose, no code fences) of at most 5 objects:',
    '[{"content": "<one-sentence durable fact or preference about the USER>", "tags": ["<optional short tag>"]}]',
    'Rules: only clear, stable, useful facts about the user (preferences, role, projects, constraints).',
    'No transient chatter, no message content, no secrets/keys, nothing the user asked to be forgotten.',
    'If nothing qualifies, return [].',
    '',
    'Transcript:',
    '"""',
    transcript.slice(0, MAX_TRANSCRIPT_CHARS),
    '"""',
  ].join('\n')
  const raw = await completeOnce(client, target.model, [{ role: 'user', content: prompt }], 0.2, 800, signal)
  const match = raw.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0])
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((m: any) => ({ content: String(m?.content || '').trim().slice(0, 500), tags: Array.isArray(m?.tags) ? m.tags.map(String).slice(0, 3) : [] }))
      .filter((m) => m.content.length >= 8)
  } catch {
    return []
  }
}

/** Run one synthesis pass across memory-enabled users. */
export async function runMemorySynthesis(signal?: AbortSignal): Promise<SynthesisRunResult> {
  const startedAt = new Date().toISOString()
  const result: SynthesisRunResult = { usersConsidered: 0, usersProcessed: 0, memoriesCreated: 0, errors: 0, startedAt, finishedAt: '' }
  if (!prisma || !synthesisEnabled()) {
    result.finishedAt = new Date().toISOString()
    return result
  }

  const users = await prisma.user.findMany({
    where: { memoryEnabled: true },
    select: { id: true },
    take: MAX_USERS_PER_RUN,
    orderBy: { updatedAt: 'desc' },
  })
  result.usersConsidered = users.length

  const since = new Date(Date.now() - 36 * 3600 * 1000)
  for (const user of users) {
    try {
      const conversations = await prisma.conversation.findMany({
        where: { userId: user.id, updatedAt: { gte: since }, incognito: false },
        select: { id: true, activeLeafId: true },
        orderBy: { updatedAt: 'desc' },
        take: MAX_CONVERSATIONS_PER_USER,
      })
      if (!conversations.length) continue

      // Build a bounded transcript from recent messages — the ACTIVE PATH
      // (§8-22: what the user actually sees and continues), not a flat
      // chronological mix that would synthesize memories from stale branch
      // versions. Falls back to flat when the conversation has no active
      // leaf (pre-migration edge); the window takes the NEWEST turns of the
      // path (the old asc+take read the oldest 20 — fixed here).
      let transcript = ''
      for (const conv of conversations) {
        const rows = await prisma.message.findMany({
          where: { conversationId: conv.id, role: { in: ['user', 'assistant'] } },
          select: { id: true, role: true, content: true, parentId: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
        let msgs: Array<{ role: string; content: string }> = rows.map((r) => ({ role: r.role, content: r.content }))
        if (conv.activeLeafId) {
          const byId = new Map(rows.map((r) => [r.id, r]))
          const pathIds: string[] = []
          const seen = new Set<string>()
          let cursor: string | null | undefined = conv.activeLeafId
          while (cursor && !seen.has(cursor)) {
            seen.add(cursor)
            const row = byId.get(cursor)
            if (!row) break
            pathIds.push(row.id)
            cursor = row.parentId
          }
          pathIds.reverse()
          const onPath = new Set(pathIds)
          msgs = rows.filter((r) => onPath.has(r.id)).map((r) => ({ role: r.role, content: r.content }))
        }
        for (const m of msgs.slice(-20)) {
          const line = `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 1500)}`
          if (transcript.length + line.length > MAX_TRANSCRIPT_CHARS) break
          transcript += `${line}\n`
        }
        if (transcript.length >= MAX_TRANSCRIPT_CHARS) break
      }
      if (transcript.trim().length < 200) continue

      const existing = await prisma.memory.findMany({
        where: { userId: user.id },
        select: { content: true },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      })
      const candidates = await extractMemories(transcript, signal)
      let created = 0
      for (const c of candidates) {
        if (created >= PER_USER_NIGHTLY_CAP) break
        if (isDuplicate(c.content, existing.map((e) => e.content))) continue
        await prisma.memory.create({
          data: { userId: user.id, kind: 'synthesized', source: 'agent', content: c.content, tags: c.tags || [] },
        })
        existing.push({ content: c.content } as any)
        created++
        result.memoriesCreated++
      }
      if (created > 0) result.usersProcessed++

      // Prune oldest synthesized memories beyond the total cap.
      const synthesized = await prisma.memory.findMany({
        where: { userId: user.id, kind: 'synthesized' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      })
      if (synthesized.length > PER_USER_TOTAL_CAP) {
        await prisma.memory.deleteMany({
          where: { id: { in: synthesized.slice(0, synthesized.length - PER_USER_TOTAL_CAP).map((m) => m.id) } },
        })
      }
    } catch {
      result.errors++
    }
  }

  result.finishedAt = new Date().toISOString()
  return result
}
