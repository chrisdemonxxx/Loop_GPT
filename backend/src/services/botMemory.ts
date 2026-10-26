/**
 * Per-bot memory: the "gets smarter over time" store, scoped to one named bot
 * rather than the whole account.
 *
 * The mirror lives in the writable data dir (same persistence story as user
 * skills) so a run can read it without waking the box; the same content is
 * seeded into the bot's box home as MEMORY.md, where the bot can read and
 * update it with computer tools. Appends go to the mirror first and are
 * replayed into the box home on the next seed, so neither side is ever the
 * only copy.
 */
import fs from 'fs'
import path from 'path'

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '../../../data')

/** Resolved lazily: tests point BOT_MEMORY_DIR at a temp dir after import. */
function memoryRoot(): string {
  return process.env.BOT_MEMORY_DIR || path.join(DATA_DIR, 'bot-memory')
}

/** ~400 tokens of memory is plenty for a prompt section; older notes are what
 *  the periodic tidy is for, and a run should never inherit an unbounded
 *  autobiography. */
export const BOT_MEMORY_CAP_CHARS = 1600

function segment(value: string): string | null {
  const v = String(value || '')
  return /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : null
}

function memoryFile(ownerId: string, botId: string): string | null {
  const owner = segment(ownerId)
  const bot = segment(botId)
  return owner && bot ? path.join(memoryRoot(), owner, `${bot}.md`) : null
}

/** The bot's remembered notes, oldest first, or '' when nothing is stored. */
export function readBotMemory(ownerId: string, botId: string): string {
  try {
    const file = memoryFile(ownerId, botId)
    if (!file || !fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf-8').trim()
  } catch {
    return ''
  }
}

export type BotMemoryVisibility = 'private' | 'team'

export interface BotMemoryEntry {
  id: string
  content: string
  visibility: BotMemoryVisibility
  createdAt: string
}

function entriesFile(ownerId: string, botId: string): string | null {
  const file = memoryFile(ownerId, botId)
  return file ? file.replace(/\.md$/, '.json') : null
}

function readEntries(ownerId: string, botId: string): BotMemoryEntry[] {
  try {
    const file = entriesFile(ownerId, botId)
    if (!file || !fs.existsSync(file)) return []
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function renderEntries(entries: BotMemoryEntry[]): string {
  return entries.map((entry) => `- [${entry.createdAt.slice(0, 10)}] ${entry.content}`).join('\n')
}

function writeEntries(ownerId: string, botId: string, entries: BotMemoryEntry[]): boolean {
  const file = memoryFile(ownerId, botId)
  const json = entriesFile(ownerId, botId)
  if (!file || !json) return false
  let kept = entries
  let md = renderEntries(kept)
  while (kept.length > 1 && md.length > BOT_MEMORY_CAP_CHARS) {
    kept = kept.slice(1)
    md = renderEntries(kept)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(json, JSON.stringify(kept))
  fs.writeFileSync(file, (md ? md + '\n' : ''))
  return true
}

function newMemoryId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Append one dated note, trimming the head when the file passes the cap. A
 *  memory write must never break a run, so every failure is a silent no-op. */
export function appendBotMemory(ownerId: string, botId: string, note: string): boolean {
  return addBotMemory(ownerId, botId, note, 'private') != null
}

/** Add one memory. Private unless the caller chooses team. */
export function addBotMemory(
  ownerId: string,
  botId: string,
  note: string,
  visibility: BotMemoryVisibility = 'private',
): BotMemoryEntry | null {
  try {
    const text = String(note || '').replace(/\s+/g, ' ').trim()
    if (!text || !memoryFile(ownerId, botId)) return null
    const entry: BotMemoryEntry = {
      id: newMemoryId(),
      content: text,
      visibility: visibility === 'team' ? 'team' : 'private',
      createdAt: new Date().toISOString(),
    }
    const ok = writeEntries(ownerId, botId, [...readEntries(ownerId, botId), entry])
    return ok ? entry : null
  } catch {
    return null
  }
}

export function listBotMemories(ownerId: string, botId: string): BotMemoryEntry[] {
  return readEntries(ownerId, botId)
}

export function deleteBotMemory(ownerId: string, botId: string, id: string): boolean {
  const entries = readEntries(ownerId, botId)
  if (!entries.some((entry) => entry.id === id)) return false
  return writeEntries(ownerId, botId, entries.filter((entry) => entry.id !== id))
}

/** Team rows are stored. Until a real membership exists, only the owner can read them. */
export function memoriesForViewer(
  ownerId: string,
  botId: string,
  viewerId: string,
): { status: 200 | 403; memories: BotMemoryEntry[] } {
  if (viewerId !== ownerId) return { status: 403, memories: [] }
  return { status: 200, memories: listBotMemories(ownerId, botId) }
}

/** A group task keeps this bot's notes. Other members' memories stay out. */
export function memoryForRun(ownerId: string, botId: string, _groupBotIds?: string[]): string {
  return botMemoryPromptSection(ownerId, botId)
}

/** The prompt section injected for runs of one named bot. */
export function botMemoryPromptSection(ownerId: string, botId: string): string {
  const memory = readBotMemory(ownerId, botId)
  if (!memory) return ''
  return [
    'BOT MEMORY — notes you kept from earlier sessions. Trust them over a',
    'generic guess; update them with remember_fact when you learn something',
    'that will matter next time.',
    '---',
    memory,
    '---',
  ].join('\n')
}
