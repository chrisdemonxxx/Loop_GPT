/**
 * Pages, files, and apps the bot wrote, plus a revocable share link.
 * Paths stay inside /workspace. Docx files are download-only.
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

export type LibraryKind = 'page' | 'file' | 'app' | 'skill'

export interface LibraryItem {
  id: string
  botId: string
  kind: LibraryKind
  name: string
  path: string
  shareToken?: string | null
  shareExpiresAt?: string | null
}

function libraryRoot(): string {
  return process.env.BOT_LIBRARY_DIR || path.join(process.env.AGENT_DATA_DIR || path.join(__dirname, '../../data'), 'bot-library')
}

function libraryFile(userId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return null
  return path.join(libraryRoot(), `${userId}.json`)
}

export function assertLibraryPath(filePath: string): string {
  const norm = path.posix.normalize(filePath)
  if (!norm.startsWith('/workspace/') || norm.includes('..')) throw new Error('Library paths stay inside /workspace')
  return norm
}

function readItems(userId: string): LibraryItem[] {
  const file = libraryFile(userId)
  if (!file || !fs.existsSync(file)) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeItems(userId: string, items: LibraryItem[]): void {
  const file = libraryFile(userId)
  if (!file) throw new Error('owner')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(items))
}

export function catalogLibraryItem(
  userId: string,
  input: { botId: string; kind: LibraryKind; name: string; path: string },
): LibraryItem {
  const safe = assertLibraryPath(input.path)
  const items = readItems(userId)
  const existing = items.find((item) => item.botId === input.botId && item.path === safe)
  if (existing) return existing
  const item: LibraryItem = {
    id: `lib_${randomUUID().slice(0, 8)}`,
    botId: input.botId,
    kind: input.kind,
    name: input.name,
    path: safe,
    shareToken: null,
    shareExpiresAt: null,
  }
  items.push(item)
  writeItems(userId, items)
  return item
}

export function listLibrary(userId: string, botId?: string, kind?: LibraryKind): LibraryItem[] {
  return readItems(userId).filter((item) => (!botId || item.botId === botId) && (!kind || item.kind === kind))
}

export function mintShare(userId: string, id: string, now = new Date()): { token: string; url: string; expiresAt: string } {
  const items = readItems(userId)
  const item = items.find((row) => row.id === id)
  if (!item) throw new Error('not found')
  const token = randomUUID().replace(/-/g, '')
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
  item.shareToken = token
  item.shareExpiresAt = expiresAt
  writeItems(userId, items)
  return { token, url: `/api/bot/share/${token}`, expiresAt }
}

export function readShare(token: string, now = new Date()): LibraryItem | null {
  const root = libraryRoot()
  if (!fs.existsSync(root)) return null
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith('.json')) continue
    const userId = name.replace(/\.json$/, '')
    const item = readItems(userId).find((row) => row.shareToken === token)
    if (!item) continue
    if (item.shareExpiresAt && Date.parse(item.shareExpiresAt) <= now.getTime()) return null
    return item
  }
  return null
}

export function revokeShare(userId: string, id: string): boolean {
  const items = readItems(userId)
  const item = items.find((row) => row.id === id)
  if (!item || !item.shareToken) return false
  item.shareToken = null
  item.shareExpiresAt = null
  writeItems(userId, items)
  return true
}

export function artifactAction(name: string): 'download' | 'view' {
  return /\.docx$/i.test(name) ? 'download' : 'view'
}

export function catalogRunOutputs(
  text: string,
  artifacts: Array<{ name: string; kind: string }> = [],
): Array<{ kind: LibraryKind; name: string; path: string }> {
  const found: Array<{ kind: LibraryKind; name: string; path: string }> = []
  const seen = new Set<string>()
  const re = /\/workspace\/(?:sites|exports)\/[A-Za-z0-9_./-]+/g
  for (const match of String(text || '').match(re) || []) {
    try {
      const safe = assertLibraryPath(match)
      if (seen.has(safe)) continue
      seen.add(safe)
      const kind: LibraryKind = safe.includes('/workspace/sites/') && safe.endsWith('/index.html')
        ? (safe.includes('/app') ? 'app' : 'page')
        : 'file'
      found.push({ kind, name: path.posix.basename(path.posix.dirname(safe)) || path.posix.basename(safe), path: safe })
    } catch { /* skip */ }
  }
  for (const artifact of artifacts) {
    if (artifactAction(artifact.name) === 'download') continue
    const guessed = `/workspace/exports/${path.posix.basename(artifact.name)}`
    if (seen.has(guessed)) continue
    try {
      assertLibraryPath(guessed)
      seen.add(guessed)
      found.push({ kind: 'file', name: artifact.name, path: guessed })
    } catch { /* skip */ }
  }
  return found
}
