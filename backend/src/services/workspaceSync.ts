/**
 * Durable workspace sync for the persistent bot box.
 *
 * The box is a real computer with a real filesystem, but the provider retires
 * it after the idle cap — and a box that dies takes /workspace with it. Files
 * are the product ("the files stay there"), so the workspace is tarred out to
 * the deployment's writable data dir on a schedule and restored into a fresh
 * box at boot. A dead box then costs a re-seed, never the user's files.
 *
 * Everything here is best-effort: sync failures never fail a task, a boot, or
 * a touch. The worst case of a missed sync is losing minutes of work, and the
 * worst case of a forced one is a dead feature — we choose the former.
 */
import fs from 'fs'
import path from 'path'

type Sandbox = any

const DATA_DIR = process.env.AGENT_DATA_DIR || path.join(__dirname, '../../data')
const STORE_DIR = process.env.BOT_WORKSPACE_STORE || path.join(DATA_DIR, 'box-workspaces')

/** A workspace past this size is a sign something heavy landed (a checkout, a
 *  node_modules). We skip the sync rather than stall the box connection. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/** Paths that are regenerable or huge; excluding them keeps archives small
 *  and restores fast. */
const TAR_EXCLUDES = ['node_modules', '.git', '__pycache__', '.cache', '.npm', 'dist']

/** The in-box archive is written here; /tmp survives the tar run but not a
 *  box death, which is exactly right. */
const BOX_ARCHIVE = '/tmp/.loop-workspace.tgz'

const lastSyncAt = new Map<string, number>()
/** Sync at most this often per user from automatic triggers. Manual calls
 *  (task completion, graceful shutdown) always run. */
const AUTO_SYNC_INTERVAL_MS = 15 * 60 * 1000

function archivePath(userId: string): string | null {
  const id = String(userId || '')
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? path.join(STORE_DIR, `${id}.tgz`) : null
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Read a box file as bytes across SDK shapes: files.read with a bytes format
 *  when the build supports it, else a base64 round-trip over commands. */
async function readBoxFileBytes(sandbox: Sandbox, boxPath: string): Promise<Buffer | null> {
  try {
    const files = sandbox.files
    if (files?.read) {
      try {
        const data = await files.read(boxPath, { format: 'bytes' })
        if (data) return Buffer.from(data)
      } catch {
        const data = await files.read(boxPath)
        if (typeof data === 'string') return Buffer.from(data, 'utf-8')
        if (data) return Buffer.from(data)
      }
    }
  } catch { /* fall through to the base64 path */ }
  try {
    const result = await sandbox.commands.run(`base64 -w0 ${quote(boxPath)}`, { timeoutMs: 60_000 })
    const b64 = String(result?.stdout || '').trim()
    return b64 ? Buffer.from(b64, 'base64') : null
  } catch {
    return null
  }
}

async function writeBoxFileBytes(sandbox: Sandbox, boxPath: string, data: Buffer): Promise<boolean> {
  try {
    const files = sandbox.files
    if (files?.write) {
      await files.write(boxPath, data)
      return true
    }
  } catch { /* fall through */ }
  try {
    // Chunked base64 append — commands.run payloads are happier below ~1MB.
    const b64 = data.toString('base64')
    await sandbox.commands.run(`rm -f ${quote(boxPath)}`, { timeoutMs: 15_000 })
    const CHUNK = 512 * 1024
    for (let i = 0; i < b64.length; i += CHUNK) {
      const piece = b64.slice(i, i + CHUNK)
      await sandbox.commands.run(`printf '%s' ${quote(piece)} >> ${quote(boxPath)}.b64`, { timeoutMs: 30_000 })
    }
    await sandbox.commands.run(`base64 -d ${quote(boxPath)}.b64 > ${quote(boxPath)} && rm -f ${quote(boxPath)}.b64`, { timeoutMs: 30_000 })
    return true
  } catch {
    return false
  }
}

/** Tar /workspace out of the box and store it durably. Returns the archived
 *  byte count, or null when there was nothing worth keeping. */
export async function syncWorkspaceOut(sandbox: Sandbox, userId: string): Promise<number | null> {
  const target = archivePath(userId)
  if (!target) return null
  try {
    const excludes = TAR_EXCLUDES.map((dir) => `--exclude='*/${dir}'`).join(' ')
    await sandbox.commands.run(
      `mkdir -p /workspace && tar czf ${quote(BOX_ARCHIVE)} ${excludes} -C / workspace`,
      { timeoutMs: 120_000 },
    )
    const sizeResult = await sandbox.commands.run(`stat -c %s ${quote(BOX_ARCHIVE)} 2>/dev/null || echo 0`, { timeoutMs: 15_000 })
    const size = Number(String(sizeResult?.stdout || '0').trim()) || 0
    if (size <= 0 || size > MAX_ARCHIVE_BYTES) return null
    const data = await readBoxFileBytes(sandbox, BOX_ARCHIVE)
    if (!data || data.length === 0 || data.length > MAX_ARCHIVE_BYTES) return null
    fs.mkdirSync(STORE_DIR, { recursive: true })
    fs.writeFileSync(target, data)
    lastSyncAt.set(userId, Date.now())
    return data.length
  } catch {
    return null
  }
}

/** Restore a previously synced workspace into a fresh box. Returns true when
 *  an archive was applied. */
export async function restoreWorkspaceIn(sandbox: Sandbox, userId: string): Promise<boolean> {
  const source = archivePath(userId)
  if (!source || !fs.existsSync(source)) return false
  try {
    const data = fs.readFileSync(source)
    if (!data.length || data.length > MAX_ARCHIVE_BYTES) return false
    const written = await writeBoxFileBytes(sandbox, BOX_ARCHIVE, data)
    if (!written) return false
    await sandbox.commands.run(
      `mkdir -p /workspace && tar xzf ${quote(BOX_ARCHIVE)} -C / && rm -f ${quote(BOX_ARCHIVE)}`,
      { timeoutMs: 120_000 },
    )
    return true
  } catch {
    return false
  }
}

/** Automatic-trigger gate: syncs at most every AUTO_SYNC_INTERVAL_MS per user. */
export function syncWorkspaceThrottled(sandbox: Sandbox, userId: string): void {
  const last = lastSyncAt.get(userId) || 0
  if (Date.now() - last < AUTO_SYNC_INTERVAL_MS) return
  lastSyncAt.set(userId, Date.now())
  void syncWorkspaceOut(sandbox, userId)
}

/** Test seam: forget throttling state. */
export function _resetWorkspaceSyncState(): void {
  lastSyncAt.clear()
}
