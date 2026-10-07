import { API_URL, authHeaders } from './api'

export interface NamedBot {
  id: string
  name: string
  label: string
  avatarColor: string
  persona: string
  defaultTools: string[]
  cloudComputer: boolean
  isPrimary: boolean
  createdAt: string
  conversationId: string | null
  preview: string
  updatedAt: string | null
  working: boolean
}

export interface BotGroup {
  id: string
  title: string
  botIds: string[]
  preview: string
  updatedAt: string
}

export const AVATAR_COLORS = ['#c96442', '#7c6af7', '#3b82f6', '#22c55e', '#eab308', '#f97316', '#ec4899', '#14b8a6']

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data as T
}

export function listNamedBots() {
  return req<{ bots: NamedBot[]; groups: BotGroup[] }>('GET', '/api/bots')
}

export function createNamedBot(input: {
  name: string
  label?: string
  avatarColor?: string
  persona?: string
  defaultTools?: string[]
  cloudComputer?: boolean
}) {
  return req<{ bot: NamedBot; conversationId: string }>('POST', '/api/bots', input)
}

export function updateNamedBot(id: string, patch: Partial<{ name: string; label: string; avatarColor: string; persona: string; cloudComputer: boolean }>) {
  return req<{ bot: NamedBot }>('PATCH', `/api/bots/${id}`, patch)
}

export function deleteNamedBot(id: string) {
  return req<{ ok: boolean }>('DELETE', `/api/bots/${id}`)
}

export function openBotThread(id: string) {
  return req<{ id: string; title: string; botId: string; kind: string }>('POST', `/api/bots/${id}/thread`)
}

export function createBotGroup(botIds: string[], name?: string) {
  return req<{ id: string; title: string; kind: string; botIds: string[] }>('POST', '/api/bots/groups', { botIds, name })
}

/** One send, one user row. Later members answer without saving the prompt again. */
export function groupFanOut<T extends { id: string }>(targets: T[]): Array<T & { skipUserPersist: boolean }> {
  return targets.map((bot, i) => ({ ...bot, skipUserPersist: i > 0 }))
}

const ALL_TAGS = new Set(['all', 'everyone'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Keep aligned with parseMentions in backend/src/services/botRoster.ts. */
function parseMentions<T extends { id: string; name: string }>(text: string, members: T[]): { tagged: boolean; all: boolean; hits: T[] } {
  const raw = String(text || '')
  if (!members.length || !/(^|\s)@\S/.test(raw)) return { tagged: false, all: false, hits: [] }
  const ordered = [...members].sort((a, b) => b.name.trim().length - a.name.trim().length)
  const seen = new Set<string>()
  const hits: T[] = []
  let all = false
  const at = /(^|\s)@/g
  let match: RegExpExecArray | null
  while ((match = at.exec(raw))) {
    const rest = raw.slice(match.index + match[1].length + 1)
    const token = (rest.split(/\s/, 1)[0] || '').replace(/[,.!?;:]+$/g, '').toLowerCase()
    if (ALL_TAGS.has(token)) { all = true; continue }
    const found = ordered.find((bot) => {
      const name = bot.name.trim()
      if (!name) return false
      return new RegExp(`^${escapeRegExp(name)}(?=$|\\s|[,.!?;:])`, 'i').test(rest)
    })
    if (found && !seen.has(found.id)) {
      seen.add(found.id)
      hits.push(found)
    }
  }
  return { tagged: true, all, hits }
}

/** @mention routing. No @ → every member. @all → every member. A full name
 *  matches only that bot. An unknown @ addresses nobody. */
export function botsForMessage<T extends { id: string; name: string }>(text: string, members: T[]): T[] {
  if (!members.length) return []
  const parsed = parseMentions(text, members)
  if (!parsed.tagged || parsed.all) return members
  return parsed.hits
}

/** One follow-up wave. Specific @Name only, and only a member who has not
 *  spoken. @all inside a reply does not start another round. */
export function followUpTargets<T extends { id: string; name: string }>(reply: string, members: T[], alreadySpoken: string[]): T[] {
  const parsed = parseMentions(reply, members)
  if (!parsed.tagged) return []
  const spoken = new Set(alreadySpoken)
  return parsed.hits.filter((bot) => !spoken.has(bot.id))
}

/** The open @ the user is still typing, at the end of the draft. */
export function mentionDraft(text: string): { query: string; start: number } | null {
  const raw = String(text || '')
  const match = raw.match(/(^|\s)@([^\s@]*)$/)
  if (!match) return null
  const query = match[2]
  return { query, start: raw.length - query.length - 1 }
}

/** Replace the open @ with a finished tag. */
export function applyMention(text: string, name: string): string {
  const draft = mentionDraft(text)
  const tag = `@${name} `
  if (!draft) return `${text}${text && !text.endsWith(' ') ? ' ' : ''}${tag}`
  return text.slice(0, draft.start) + tag
}
