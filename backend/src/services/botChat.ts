/**
 * Reset hides the chat thread. Memory, skills, routines, files, and the
 * computer stay. Dropped files land in /workspace/inbox.
 */
import fs from 'fs'
import path from 'path'

function chatRoot(): string {
  return process.env.BOT_CHAT_DIR || path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '../../../data'), 'bot-chat')
}

function cursorFile(userId: string, botId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId) || !/^[A-Za-z0-9_-]{1,128}$/.test(botId)) return null
  return path.join(chatRoot(), userId, `${botId}.json`)
}

export function resetChatCursor(userId: string, botId: string, now = new Date()): string {
  const file = cursorFile(userId, botId)
  if (!file) throw new Error('bot')
  const iso = now.toISOString()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ resetAt: iso }))
  return iso
}

export function readChatCursor(userId: string, botId: string): string | null {
  const file = cursorFile(userId, botId)
  if (!file || !fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { resetAt?: string }
    return parsed.resetAt || null
  } catch {
    return null
  }
}

export function visibleChatTasks<T extends { id: string; kind?: string; createdAt: string | Date }>(
  tasks: T[],
  cursor: string | null,
): T[] {
  if (!cursor) return tasks
  const at = Date.parse(cursor)
  return tasks.filter((task) => {
    if (task.kind === 'scheduled') return true
    const created = task.createdAt instanceof Date ? task.createdAt.getTime() : Date.parse(task.createdAt)
    return created > at
  })
}

export function inboxPath(name: string): string {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error('inbox path')
  }
  return `/workspace/inbox/${name}`
}

export function attachmentPreface(files: Array<{ name: string; path: string }>): string {
  const lines = files.map((file) => `- ${file.name} (${file.path})`)
  return `Attached files:\n${lines.join('\n')}`
}
