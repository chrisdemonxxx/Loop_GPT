import { exec } from 'child_process'
import { promisify } from 'util'

const execP = promisify(exec)

const BLOCKED = [
  /rm\s+-rf\s+\/(?!\S)/,   // rm -rf /
  /mkfs/,
  /dd\s+if=\/dev\//,
  />\s*\/dev\/sd/,
]

export async function runBash(command: string, cwd?: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  for (const pat of BLOCKED) {
    if (pat.test(command)) return { stdout: '', stderr: 'Blocked: potentially destructive command.', exitCode: 1 }
  }
  try {
    const { stdout, stderr } = await execP(command, { cwd: cwd || process.cwd(), timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
    return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode: 0 }
  } catch (e: any) {
    return { stdout: (e.stdout || '').slice(0, 8000), stderr: (e.stderr || e.message || '').slice(0, 2000), exitCode: e.code || 1 }
  }
}
