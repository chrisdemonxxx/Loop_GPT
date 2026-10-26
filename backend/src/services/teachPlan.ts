/**
 * Teach naming, discard, and learn-from-recording.
 * Discard deletes the recording. Cancel leaves it.
 * A saved recording skips the takeover wait.
 */
import fs from 'fs'
import path from 'path'

export function teachDistillPrompt(
  frameCount: number,
  stepLog: string,
  meta?: { name?: string; description?: string },
): string {
  return [
    'You are in TEACH MODE. The operator just demonstrated a task on the dedicated cloud desktop; the attached frames are the recorded screen timeline (in order, with timestamps).',
    `Write a reusable Skill that automates this task end-to-end: call create_skill with a clear name, a one-line description, trigger keywords a user might say, and complete step-by-step instructions derived from the demo (exact sites, exact text to type, keyboard-first shortcuts, what "done" looks like). ${frameCount} frames were recorded.`,
    meta?.name ? `Name the skill exactly "${meta.name}".` : '',
    meta?.description ? `When to use it: ${meta.description}` : '',
    'Operator input, in order (framebuffer pixels):',
    stepLog,
    'Then reply with: the skill name, its trigger keywords, and a 2-3 sentence summary of the procedure you distilled. Do not ask questions; make reasonable assumptions and state them.',
  ].filter(Boolean).join('\n')
}

export function teachEnd(action: 'discard' | 'cancel'): { deleteRecording: boolean; event: 'teach_discarded' | null } {
  if (action === 'discard') return { deleteRecording: true, event: 'teach_discarded' }
  return { deleteRecording: false, event: null }
}

export function teachNeedsTakeover(recordingId?: string): boolean {
  return !recordingId
}

export interface TeachMeta {
  name?: string
  description?: string
  recordingId?: string
}

export function readTeachMeta(computer: unknown): TeachMeta {
  const teach = computer && typeof computer === 'object' ? (computer as { teach?: TeachMeta }).teach : undefined
  if (!teach || typeof teach !== 'object') return {}
  return {
    ...(typeof teach.name === 'string' ? { name: teach.name } : {}),
    ...(typeof teach.description === 'string' ? { description: teach.description } : {}),
    ...(typeof teach.recordingId === 'string' ? { recordingId: teach.recordingId } : {}),
  }
}

export interface StoredTeachRecording {
  id: string
  stepLog: string
  frameCount: number
  steps: Array<Record<string, unknown>>
  pngBase64: string
}

function teachRoot(): string {
  return process.env.BOT_TEACH_DIR || path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '../../data'), 'teach-recordings')
}

function teachFile(ownerId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) return null
  return path.join(teachRoot(), `${ownerId}.json`)
}

function readAll(ownerId: string): StoredTeachRecording[] {
  const file = teachFile(ownerId)
  if (!file || !fs.existsSync(file)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function listTeachRecordings(ownerId: string): StoredTeachRecording[] {
  return readAll(ownerId)
}

export function readTeachRecording(ownerId: string, id: string): StoredTeachRecording | null {
  return readAll(ownerId).find((row) => row.id === id) || null
}

export function saveTeachRecording(ownerId: string, recording: StoredTeachRecording): void {
  const file = teachFile(ownerId)
  if (!file) return
  const rows = readAll(ownerId).filter((row) => row.id !== recording.id)
  rows.push(recording)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(rows))
}

export function deleteTeachRecording(ownerId: string, id: string): boolean {
  const file = teachFile(ownerId)
  if (!file) return false
  const rows = readAll(ownerId)
  const next = rows.filter((row) => row.id !== id)
  if (next.length === rows.length) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(next))
  return true
}
