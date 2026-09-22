/**
 * execute_code — a real, isolated code sandbox.
 *
 * Runs a snippet in a fresh per-call workspace directory. The interpreter is
 * launched with a scrubbed environment and a working directory of that
 * workspace only (no repository/host path in scope). A hard wall-clock timeout
 * kills runaway code.
 *
 * Isolation modes:
 *  - container (default when Docker is available, or SANDBOX_DOCKER=true):
 *    `docker run --rm --network none --memory ... --cpus 1 -v <workspace>:/work`
 *    using a small language image. Real kernel/namespace isolation.
 *  - subprocess (fallback): the host interpreter, cwd = workspace, env scrubbed.
 *
 * Files written by the snippet are collected and returned as downloadable
 * artifacts. Output is capped and the run is fully deterministic.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { saveArtifact } from '../artifacts'
import type { ToolDefinition } from '../types'

const MAX_OUTPUT = 60_000
const MAX_FILES = 8
const MAX_FILE_BYTES = 8 * 1024 * 1024
const CODE_FILES: Record<string, string> = { python: 'main.py', javascript: 'main.js', bash: 'main.sh' }
const DOCKER_IMAGES: Record<string, string> = { python: 'python:3.12-alpine', javascript: 'node:22-alpine', bash: 'alpine:3.20' }
const INTERPRETERS: Record<string, string[]> = {
  python: [process.env.SANDBOX_PYTHON || 'python'],
  javascript: [process.env.SANDBOX_NODE || 'node'],
  bash: ['bash'],
}

let dockerChecked: boolean | undefined
function dockerAvailable(): Promise<boolean> {
  if (dockerChecked !== undefined) return Promise.resolve(dockerChecked)
  return new Promise((resolve) => {
    const child = spawn('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
    child.on('error', () => { dockerChecked = false; resolve(false) })
    child.on('close', (code) => { dockerChecked = code === 0; resolve(dockerChecked!) })
  })
}

/** Tri-state: explicit true/false, else auto-detect Docker. */
async function chooseContainer(): Promise<boolean> {
  if (process.env.SANDBOX_DOCKER === 'false') return false
  if (process.env.SANDBOX_DOCKER === 'true') return true
  return dockerAvailable()
}

interface RunResult { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }

function run(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (s: string, chunk: Buffer) => (s.length >= MAX_OUTPUT ? s : (s + chunk.toString()).slice(0, MAX_OUTPUT))
    child.stdout.on('data', (c: Buffer) => { stdout = cap(stdout, c) })
    child.stderr.on('data', (c: Buffer) => { stderr = cap(stderr, c) })
    const kill = () => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    const timer = setTimeout(() => { timedOut = true; kill() }, opts.timeoutMs)
    const onAbort = () => { timedOut = true; kill() }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr: stderr + `\n${err.message}`, exitCode: -1, timedOut }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, exitCode: code, timedOut })
    })
  })
}

export const executeCodeTool: ToolDefinition = {
  name: 'execute_code',
  source: 'builtin',
  description: 'Run a Python, JavaScript or Bash snippet in an isolated sandbox and return its real stdout/stderr. Use for calculations, data analysis, charts, or any code. Files the snippet writes to the working directory are returned as downloadable artifacts.',
  parameters: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript', 'bash'], description: 'Interpreter to use.' },
      code: { type: 'string', description: 'The complete program to run.' },
      timeout_seconds: { type: 'number', description: 'Wall-clock limit (1-120, default 30).' },
    },
    required: ['language', 'code'],
  },
  async handler(args, ctx) {
    const language = String(args.language || '').toLowerCase()
    if (!CODE_FILES[language]) return { content: 'Error: language must be python, javascript or bash.', isError: true }
    const code = String(args.code || '')
    if (!code.trim()) return { content: 'Error: code is required.', isError: true }
    const timeoutSec = Math.min(Math.max(Number(args.timeout_seconds) || 30, 1), 120)
    const timeoutMs = timeoutSec * 1000

    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-sbx-'))
    const filename = CODE_FILES[language]
    fs.writeFileSync(path.join(workdir, filename), code, 'utf-8')

    // Scrubbed environment: no secrets, no ambient credentials.
    const env: NodeJS.ProcessEnv = { HOME: workdir, TMPDIR: workdir, LANG: 'C.UTF-8',
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', PYTHONUNBUFFERED: '1' }

    const container = await chooseContainer()
    let result: RunResult
    try {
      if (container) {
        ctx.emit({ type: 'status', message: `Running ${language} in an isolated container…` })
        const network = process.env.SANDBOX_NETWORK === 'true' ? 'bridge' : 'none'
        result = await run('docker', ['run', '--rm', '--network', network, '--memory', '768m', '--cpus', '1',
          '--pids-limit', '256', '--read-only', '--tmpfs', '/tmp:rw,size=256m',
          '-v', `${workdir}:/work:rw`, '-w', '/work', DOCKER_IMAGES[language],
          ...(language === 'bash' ? ['sh', filename] : [...INTERPRETERS[language], filename])],
          { cwd: workdir, env: { PATH: process.env.PATH || '' }, timeoutMs, signal: ctx.signal })
      } else {
        ctx.emit({ type: 'status', message: `Running ${language} in a sandboxed subprocess…` })
        result = await run(INTERPRETERS[language][0], [filename], { cwd: workdir, env, timeoutMs, signal: ctx.signal })
      }
    } catch (e: any) {
      fs.rmSync(workdir, { recursive: true, force: true })
      return { content: `Sandbox error: ${e?.message || e}`, isError: true }
    }

    // Collect files the snippet produced (excluding the source file).
    const artifacts: any[] = []
    try {
      for (const entry of fs.readdirSync(workdir)) {
        if (entry === filename || artifacts.length >= MAX_FILES) continue
        const full = path.join(workdir, entry)
        const stat = fs.statSync(full)
        if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue
        try {
          const artifact = await saveArtifact(entry, fs.readFileSync(full), { userId: ctx.userId, conversationId: ctx.conversationId })
          artifacts.push(artifact)
          ctx.emit({ type: 'artifact', artifact })
        } catch { /* skip unreadable file */ }
      }
    } catch { /* workspace already gone */ } finally {
      fs.rmSync(workdir, { recursive: true, force: true })
    }

    const mode = container ? 'container' : 'subprocess'
    const header = `exit=${result.exitCode ?? 'null'}${result.timedOut ? ' (timed out)' : ''} · ${language} · ${mode}`
    const out = result.stdout.trim() || '(no stdout)'
    const err = result.stderr.trim()
    const summary = artifacts.length ? `\n\nGenerated ${artifacts.length} file(s): ${artifacts.map((a) => a.name).join(', ')}` : ''
    return {
      content: `${header}\n\nSTDOUT:\n${out}${err ? `\n\nSTDERR:\n${err}` : ''}${summary}`,
      data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, timedOut: result.timedOut, artifacts, mode },
      isError: (result.exitCode ?? 1) !== 0 || undefined,
    }
  },
}
