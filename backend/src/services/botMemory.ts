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

/** Append one dated note, trimming the head when the file passes the cap. A
 *  memory write must never break a run, so every failure is a silent no-op. */
export function appendBotMemory(ownerId: string, botId: string, note: string): boolean {
  try {
    const file = memoryFile(ownerId, botId)
    if (!file) return false
    const text = String(note || '').replace(/\s+/g, ' ').trim()
    if (!text) return false
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    const existing = readBotMemory(ownerId, botId)
    let next = existing ? `${existing}\n- [${stamp}] ${text}` : `- [${stamp}] ${text}`
    if (next.length > BOT_MEMORY_CAP_CHARS) {
      const lines = next.split('\n')
      while (lines.length > 1 && next.length > BOT_MEMORY_CAP_CHARS) {
        lines.shift()
        next = lines.join('\n')
      }
    }
    fs.writeFileSync(file, next + '\n')
    return true
  } catch {
    return false
  }
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
