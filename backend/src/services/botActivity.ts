/** Last time this account used a bot surface. Away is measured from here. */
import fs from 'fs'
import path from 'path'

function activityFile(): string {
  const root = process.env.BOT_ACTIVITY_DIR || path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '../../data'), 'bot-activity')
  return path.join(root, 'last.json')
}

function readAll(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(activityFile(), 'utf8')) } catch { return {} }
}

export function touchBotActive(userId: string, now = new Date()): void {
  if (!userId) return
  const all = readAll()
  all[userId] = now.toISOString()
  fs.mkdirSync(path.dirname(activityFile()), { recursive: true })
  fs.writeFileSync(activityFile(), JSON.stringify(all))
}

export function readBotActive(userId: string): Date | null {
  const iso = readAll()[userId]
  if (!iso) return null
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}
