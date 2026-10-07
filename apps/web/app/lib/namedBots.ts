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

/** @mention routing. No mention → every member. A matching @name → only those. */
export function botsForMessage<T extends { id: string; name: string }>(text: string, members: T[]): T[] {
  if (!members.length) return []
  const mentions = [...String(text || '').matchAll(/(^|\s)@([A-Za-z0-9][A-Za-z0-9 .'_-]{0,40})/g)]
    .map((m) => m[2].trim().toLowerCase())
    .filter(Boolean)
  if (!mentions.length) return members
  const hit = members.filter((bot) => {
    const name = bot.name.toLowerCase()
    return mentions.some((n) => name === n || name.startsWith(n) || n.startsWith(name))
  })
  return hit.length ? hit : members
}
