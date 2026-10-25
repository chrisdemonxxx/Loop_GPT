/**
 * Bidirectional file access to the user's persistent box.
 *
 * The bot writes into /workspace with computer tools; the operator reads and
 * writes the same tree from the web. Both sides see one filesystem, so "the
 * computer can be updated by the user as well as the bot" is literally true
 * rather than a sync protocol that can drift.
 *
 * Every path is jailed to /workspace: the jail is what makes an operator-
 * supplied path safe to hand to a shell and to the SDK's file calls.
 */
import { attachUserBoxFromDB, getLiveUserBox } from './botBox'

type Sandbox = any

export interface BoxFileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size: number
}

export class BoxFilesError extends Error {
  constructor(
    message: string,
    public readonly code: 'no_box' | 'bad_path' | 'too_large' | 'not_found' | 'io',
  ) {
    super(message)
  }
}

/** HTTP status for a box-file failure. Connect and IO problems are 503 with
 *  the real message; a missing path stays 404. Quota is not a file error. */
export function boxFileHttpStatus(code: string): number {
  if (code === 'no_box') return 409
  if (code === 'bad_path') return 400
  if (code === 'too_large') return 413
  if (code === 'io') return 503
  return 404
}

const WORKSPACE_ROOT = '/workspace'
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_WRITE_BYTES = 2 * 1024 * 1024

/** Resolve an operator path against the workspace root, or refuse it. */
export function jailWorkspacePath(input: string): string {
  const raw = String(input || '').trim()
  if (!raw) return WORKSPACE_ROOT
  if (raw.includes('\0')) throw new BoxFilesError('Invalid path', 'bad_path')
  let normalized = raw.replace(/\\/g, '/')
  // Operator paths arrive both ways — relative ("agents/bot/README.md") and
  // absolute ("/workspace/agents/..."), because the API itself returns the
  // absolute form. A leading workspace root is stripped, never doubled.
  if (normalized === WORKSPACE_ROOT) return WORKSPACE_ROOT
  if (normalized.startsWith(`${WORKSPACE_ROOT}/`)) normalized = normalized.slice(WORKSPACE_ROOT.length)
  const parts: string[] = []
  for (const piece of normalized.split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') throw new BoxFilesError('Paths stay inside the workspace', 'bad_path')
    parts.push(piece)
  }
  const joined = `${WORKSPACE_ROOT}/${parts.join('/')}`
  return joined.replace(/\/+$/, '') || WORKSPACE_ROOT
}

async function liveSandboxOrThrow(userId: string): Promise<Sandbox> {
  const live = getLiveUserBox(userId)
  if (live) return live
  const sandboxId = await attachUserBoxFromDB(userId)
  if (!sandboxId) throw new BoxFilesError('The computer is not running — open it first.', 'no_box')
  // A paused box resumes on connect. Refuse that before touching the provider
  // so a spent VM budget is a quota error, not a missing file.
  const { remainingVmMinutes } = await import('./agentTasks')
  await remainingVmMinutes(userId)
  try {
    const { Sandbox } = await import('@e2b/desktop')
    return await Sandbox.connect(sandboxId, { timeoutMs: 10 * 60 * 1000 })
  } catch (error) {
    const message = String((error as Error)?.message || error || 'Could not connect to the computer.')
    throw new BoxFilesError(message, 'io')
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** The E2B SDK throws CommandExitError on non-zero exits instead of returning
 *  { exitCode }. Treat exit 1 as a boolean "false"; other failures rethrow. */
async function runChecked(sandbox: Sandbox, cmd: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await sandbox.commands.run(cmd, { timeoutMs })
    return {
      stdout: String(result?.stdout || ''),
      stderr: String(result?.stderr || ''),
      exitCode: result?.exitCode ?? 0,
    }
  } catch (error: any) {
    const code = typeof error?.exitCode === 'number' ? error.exitCode : null
    if (code === 1) {
      return {
        stdout: String(error?.stdout || ''),
        stderr: String(error?.stderr || ''),
        exitCode: 1,
      }
    }
    if (code != null) {
      return {
        stdout: String(error?.stdout || ''),
        stderr: String(error?.stderr || error?.message || ''),
        exitCode: code,
      }
    }
    throw error
  }
}

async function runInBox(sandbox: Sandbox, cmd: string, timeoutMs = 30_000) {
  return runChecked(sandbox, cmd, timeoutMs)
}

/** Resolve a jailed path through realpath and refuse anything that escapes
 *  /workspace (symlink escape). Returns the real path under the workspace. */
async function resolveUnderWorkspace(sandbox: Sandbox, jailed: string): Promise<string> {
  if (jailed === WORKSPACE_ROOT) return WORKSPACE_ROOT
  const result = await runChecked(sandbox, `realpath -m -- ${quote(jailed)}`, 5_000)
  const real = String(result.stdout || '').trim().replace(/\/+$/, '') || WORKSPACE_ROOT
  if (real !== WORKSPACE_ROOT && !real.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new BoxFilesError('Paths stay inside the workspace', 'bad_path')
  }
  return real
}

async function pathExists(sandbox: Sandbox, target: string): Promise<boolean> {
  const result = await runChecked(sandbox, `test -e ${quote(target)}`, 5_000)
  return result.exitCode === 0
}

/** List one directory, sorted dirs-first then name (sorted in JS — the shell
 *  `sort -t '\\t'` pipeline mishandles the tab delimiter). */
export async function listBoxFiles(userId: string, dirPath: string): Promise<BoxFileEntry[]> {
  const sandbox = await liveSandboxOrThrow(userId)
  const dir = await resolveUnderWorkspace(sandbox, jailWorkspacePath(dirPath || WORKSPACE_ROOT))
  const result = await runInBox(
    sandbox,
    `find ${quote(dir)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%p\\n' 2>/dev/null`,
  )
  const out: BoxFileEntry[] = []
  for (const line of String(result?.stdout || '').split('\n')) {
    if (!line.trim()) continue
    const [typeChar, sizeRaw, ...pathParts] = line.split('\t')
    const full = pathParts.join('\t')
    const name = full.split('/').pop() || full
    out.push({
      name,
      path: full,
      type: typeChar === 'd' ? 'dir' : 'file',
      size: Number(sizeRaw) || 0,
    })
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

/** Read a text file (capped); larger files are reported, not truncated silently. */
export async function readBoxFile(userId: string, filePath: string): Promise<{ content: string; truncated: boolean; size: number }> {
  const sandbox = await liveSandboxOrThrow(userId)
  const file = await resolveUnderWorkspace(sandbox, jailWorkspacePath(filePath))
  if (!(await pathExists(sandbox, file))) throw new BoxFilesError('File not found', 'not_found')
  const sizeResult = await runInBox(sandbox, `stat -c %s ${quote(file)} 2>/dev/null || echo -1`)
  const size = Number(String(sizeResult?.stdout || '-1').trim())
  if (size < 0) throw new BoxFilesError('File not found', 'not_found')
  if (size > MAX_READ_BYTES) throw new BoxFilesError(`File is ${size} bytes — too large to view inline`, 'too_large')
  try {
    const files = sandbox.files
    if (files?.read) {
      const data = await files.read(file)
      const content = typeof data === 'string' ? data : Buffer.from(data as any).toString('utf-8')
      return { content, truncated: false, size }
    }
  } catch { /* fall through to cat */ }
  const result = await runInBox(sandbox, `cat ${quote(file)}`)
  return { content: String(result?.stdout || ''), truncated: false, size }
}

/** Write a text file (capped), creating parent directories. */
export async function writeBoxFile(userId: string, filePath: string, content: string): Promise<{ size: number }> {
  const sandbox = await liveSandboxOrThrow(userId)
  const file = await resolveUnderWorkspace(sandbox, jailWorkspacePath(filePath))
  const data = Buffer.from(String(content ?? ''), 'utf-8')
  if (data.length > MAX_WRITE_BYTES) throw new BoxFilesError(`Content is ${data.length} bytes — the inline editor caps at ${MAX_WRITE_BYTES}`, 'too_large')
  await runInBox(sandbox, `mkdir -p ${quote(file.split('/').slice(0, -1).join('/') || WORKSPACE_ROOT)}`)
  try {
    const files = sandbox.files
    if (files?.write) {
      await files.write(file, data)
      return { size: data.length }
    }
  } catch { /* fall through to base64 */ }
  const b64 = data.toString('base64')
  await runInBox(sandbox, `printf '%s' ${quote(b64)} | base64 -d > ${quote(file)}`, 60_000)
  return { size: data.length }
}

/** Delete a file or (recursively) a directory inside the workspace. */
export async function deleteBoxPath(userId: string, targetPath: string): Promise<void> {
  const sandbox = await liveSandboxOrThrow(userId)
  const target = await resolveUnderWorkspace(sandbox, jailWorkspacePath(targetPath))
  if (target === WORKSPACE_ROOT) throw new BoxFilesError('The workspace root cannot be deleted', 'bad_path')
  if (!(await pathExists(sandbox, target))) throw new BoxFilesError('Path not found', 'not_found')
  const result = await runInBox(sandbox, `rm -rf -- ${quote(target)} && echo gone || echo missing`)
  if (!String(result?.stdout || '').includes('gone')) throw new BoxFilesError('Path not found', 'not_found')
}
