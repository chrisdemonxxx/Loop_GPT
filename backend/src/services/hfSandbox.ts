/**
 * Hugging Face Sandbox client (dedicated mode) — the managed-isolation backend
 * for the execute_code tool. One HF Job per sandbox: a real VM running
 * `sbx-server` on port 49983, reached through the authenticated Jobs proxy.
 *
 * Wire contract reverse-verified against huggingface_hub `_sandbox.py`
 * (SANDBOX_SERVER_VERSION 0.7.0, protocol 3) and huggingface/sandbox-server:
 *
 *   create:  POST {endpoint}/api/jobs/{namespace}   (dockerImage, command,
 *            environment, secrets, labels, volumes, expose)
 *            → job.status.exposeUrls: "https://<job_id>--49983.hf.jobs"
 *   auth:    nonce in job label "hf-sandbox-nonce";
 *            X-Sandbox-Token = HMAC-SHA256(hfToken, "hf-sandbox:" + nonce)
 *   ready:   GET {baseUrl}/health → 200 (+ protocol >= 3)
 *   exec:    POST {baseUrl}/v1/exec {cmd, shell, env, cwd, timeout, stdin}
 *            → NDJSON stream: start / stdout / stderr / ping / exit
 *   files:   PUT {baseUrl}/v1/files/write?path=     (raw body, parents created)
 *            GET {baseUrl}/v1/files/read?path=      (raw bytes)
 *            GET {baseUrl}/v1/files/list?path=
 *   kill:    DELETE {endpoint}/api/jobs/{namespace}/{jobId}
 *
 * Security posture: the HF token never enters the sandbox (no
 * forward_hf_token); only the derived SBX_TOKEN is placed in job secrets.
 * Requests go only to the hub endpoint and *.hf.jobs; redirects are never
 * followed (the proxy and the server issue none in this protocol, and
 * following one would leak both credentials).
 */
import crypto from 'crypto'
import type { Readable } from 'stream'

// ── Wire constants (pinned to the reviewed server build) ────────────────────
export const SANDBOX_SERVER_PORT = 49983
export const SANDBOX_SERVER_VERSION = '0.7.0'
export const SANDBOX_SERVER_SHA256 = 'eb2b04f79fbe765195300aaf1582be2a2a9ea698ff067d0cab428171d5584932'
export const SANDBOX_SERVER_PROTOCOL = 3
export const SANDBOX_SERVER_BUCKET = 'huggingface/sbx-server'
const SERVER_MOUNT_PATH = '/.hf-sbx-server'

/** Job bootstrap (verbatim from huggingface_hub _sandbox.py): download the
 *  digest-pinned server, verify it, exec it. Requires only /bin/sh. */
const BOOTSTRAP = `set -e
d=/tmp/.sbx-server
if command -v wget >/dev/null 2>&1; then wget -q -O "$d" "$SBX_SERVER_URL"
elif command -v curl >/dev/null 2>&1; then curl -fsSL -o "$d" "$SBX_SERVER_URL"
else cp "$SBX_SERVER_MOUNT/sbx-server-$SBX_SERVER_SHA256" "$d"; fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$d" | cut -d' ' -f1)
elif command -v openssl >/dev/null 2>&1; then
  actual=$(openssl dgst -sha256 -r "$d" | cut -d' ' -f1)
else
  echo "sbx: cannot verify the sandbox server digest: this image has neither sha256sum nor openssl." >&2
  exit 1
fi
if [ "$actual" != "$SBX_SERVER_SHA256" ]; then
  echo "sbx: sandbox server digest mismatch: got $actual, expected $SBX_SERVER_SHA256." >&2
  exit 1
fi
chmod +x "$d"
unset SBX_SERVER_URL SBX_SERVER_MOUNT SBX_SERVER_SHA256
exec "$d"
`

export type HfSandboxErrorCode = 'billing' | 'auth' | 'unavailable' | 'startup' | 'api' | 'not_found'

export class HfSandboxError extends Error {
  constructor(message: string, public readonly code: HfSandboxErrorCode, public readonly status?: number) { super(message) }
}

/** Minimal fetch surface (node-fetch or a test double). */
export type FetchLike = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: any
  redirect?: 'manual' | 'follow'
  signal?: AbortSignal
}) => Promise<{
  status: number
  json: () => Promise<any>
  text: () => Promise<string>
  body: Readable | null
  buffer?: () => Promise<Buffer>
}>

export interface HfSandboxDeps {
  fetchImpl: FetchLike
  token?: string
  endpoint?: string
  namespace?: string
  sleep?: (ms: number) => Promise<void>
}

export interface HfSandboxHandle {
  jobId: string
  owner: string
  baseUrl: string
  token: string
}

export interface HfExecResult {
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stdout: string
  stderr: string
}

const TERMINAL_STAGES = new Set(['COMPLETED', 'ERROR', 'DELETED', 'CANCELED'])
const MAX_CAPTURE = 512 * 1024

export function hfEndpoint(override?: string): string {
  return (override || process.env.HF_HUB_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '')
}

export function deriveSandboxToken(hfToken: string, nonce: string): string {
  return crypto.createHmac('sha256', hfToken).update(`hf-sandbox:${nonce}`).digest('hex')
}

/** Job creation payload, mirroring huggingface_hub `_bootstrap_job_spec` +
 *  `_create_job_spec` exactly (field names verified against the Hub API). */
export function buildSandboxJobSpec(opts: {
  image: string
  flavor: string
  idleTimeoutSecs: number | null
  nonce: string
  token: string
  name: string
  endpoint: string
}) {
  const serverObject = `sbx-server-${SANDBOX_SERVER_SHA256}`
  return {
    dockerImage: opts.image,
    command: ['/bin/sh', '-c', BOOTSTRAP],
    arguments: [] as string[],
    environment: {
      SBX_PORT: String(SANDBOX_SERVER_PORT),
      ...(opts.idleTimeoutSecs != null ? { SBX_IDLE_TIMEOUT: String(opts.idleTimeoutSecs) } : {}),
      SBX_SERVER_URL: `${opts.endpoint}/buckets/${SANDBOX_SERVER_BUCKET}/resolve/${serverObject}`,
      SBX_SERVER_SHA256: SANDBOX_SERVER_SHA256,
      SBX_SERVER_MOUNT: SERVER_MOUNT_PATH,
    },
    secrets: { SBX_TOKEN: opts.token },
    flavor: opts.flavor,
    timeoutSeconds: 86400, // 24h hard cap; idle_timeout is the real keeper
    labels: {
      name: opts.name,
      'hf-sandbox': '1',
      'hf-sandbox-mode': 'dedicated',
      'hf-sandbox-nonce': opts.nonce,
    },
    volumes: [{ type: 'bucket', source: SANDBOX_SERVER_BUCKET, mountPath: SERVER_MOUNT_PATH, readOnly: true }],
    expose: { ports: [SANDBOX_SERVER_PORT], portsPublic: [] as number[] },
  }
}

// ── Transport ───────────────────────────────────────────────────────────────

function assertAllowedUrl(url: string, endpoint: string) {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { throw new HfSandboxError('Invalid sandbox URL', 'api') }
  const endpointHost = new URL(endpoint).hostname.toLowerCase()
  if (host !== endpointHost && !host.endsWith('.hf.jobs') && host !== 'hf.jobs') {
    throw new HfSandboxError(`Refusing sandbox request to unexpected host: ${host}`, 'api')
  }
}

async function request(deps: HfSandboxDeps, url: string, init: { method?: string; headers?: Record<string, string>; body?: any; signal?: AbortSignal } = {}) {
  const endpoint = hfEndpoint(deps.endpoint)
  assertAllowedUrl(url, endpoint)
  const response = await deps.fetchImpl(url, { ...init, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    throw new HfSandboxError(`Unexpected redirect (${response.status}) from sandbox endpoint`, 'api', response.status)
  }
  return response
}

async function errorFrom(response: { status: number; text: () => Promise<string> }, fallback: string): Promise<HfSandboxError> {
  let message = fallback
  try {
    const body = await response.text()
    try {
      const parsed = JSON.parse(body)
      message = parsed.error || parsed.message || fallback
    } catch { message = body.slice(0, 300) || fallback }
  } catch { /* keep fallback */ }
  if (response.status === 402) return new HfSandboxError('HF Jobs billing: sandboxes need a positive HF credit balance (402)', 'billing', 402)
  if (response.status === 401 || response.status === 403) return new HfSandboxError(`HF auth rejected (${response.status}): ${message}`, 'auth', response.status)
  if (response.status === 404) return new HfSandboxError(message, 'not_found', 404)
  if (response.status >= 500) return new HfSandboxError(`HF sandbox upstream error (${response.status})`, 'unavailable', response.status)
  return new HfSandboxError(message, 'api', response.status)
}

function authHeaders(deps: HfSandboxDeps): Record<string, string> {
  const token = deps.token || process.env.HF_TOKEN
  if (!token) throw new HfSandboxError('HF_TOKEN is required for sandbox provisioning', 'auth')
  return { Authorization: `Bearer ${token}` }
}

let cachedNamespace: string | undefined

async function resolveNamespace(deps: HfSandboxDeps): Promise<string> {
  if (deps.namespace) return deps.namespace
  if (process.env.HF_SANDBOX_NAMESPACE) return process.env.HF_SANDBOX_NAMESPACE
  if (cachedNamespace) return cachedNamespace
  const endpoint = hfEndpoint(deps.endpoint)
  const response = await request(deps, `${endpoint}/api/whoami-v2`, { headers: authHeaders(deps) })
  if (response.status !== 200) throw await errorFrom(response, 'Could not resolve HF identity')
  const body = await response.json()
  if (!body?.name) throw new HfSandboxError('HF identity response had no name', 'api')
  cachedNamespace = String(body.name)
  return cachedNamespace
}

/** Test hook: drop the cached namespace. */
export function resetHfSandboxCache() { cachedNamespace = undefined }

// ── Lifecycle ───────────────────────────────────────────────────────────────

export interface CreateSandboxOptions {
  image?: string
  flavor?: string
  idleTimeoutSecs?: number | null
  startTimeoutSecs?: number
  name?: string
}

export async function createSandbox(deps: HfSandboxDeps, options: CreateSandboxOptions = {}): Promise<HfSandboxHandle> {
  const endpoint = hfEndpoint(deps.endpoint)
  const namespace = await resolveNamespace(deps)
  const hfToken = deps.token || process.env.HF_TOKEN!
  const nonce = crypto.randomBytes(16).toString('hex')
  const token = deriveSandboxToken(hfToken, nonce)
  const spec = buildSandboxJobSpec({
    image: options.image || 'python:3.12-alpine',
    flavor: options.flavor || 'cpu-basic',
    idleTimeoutSecs: options.idleTimeoutSecs === undefined
      ? Number(process.env.HF_SANDBOX_IDLE_TIMEOUT || 600)
      : options.idleTimeoutSecs,
    nonce,
    token,
    name: options.name || 'loop-code-sandbox',
    endpoint,
  })

  const created = await request(deps, `${endpoint}/api/jobs/${namespace}`, {
    method: 'POST',
    headers: { ...authHeaders(deps), 'Content-Type': 'application/json' },
    body: JSON.stringify(spec),
  })
  if (created.status !== 200 && created.status !== 201) throw await errorFrom(created, 'Sandbox job creation failed')
  const job = await created.json()
  const jobId: string = job.id || job._id
  const owner: string = job.owner?.name || namespace
  if (!jobId) throw new HfSandboxError('Job creation response had no id', 'api')

  const killQuietly = async () => {
    try { await killSandbox(deps, { jobId, owner }) } catch { /* best effort */ }
  }

  try {
    const baseUrl = findServerUrl(job)
    const handle: HfSandboxHandle = { jobId, owner, baseUrl, token }
    await waitReady(deps, handle)
    return handle
  } catch (error) {
    // run_job already started a billable job; never leave an orphan behind.
    await killQuietly()
    throw error
  }
}

/** The sandbox server URL is the job's exposed URL for port 49983. */
export function findServerUrl(job: any): string {
  const urls: string[] = job?.status?.exposeUrls || job?.status?.expose_urls || []
  const found = urls.find((url) => url.includes(`--${SANDBOX_SERVER_PORT}.`))
  if (!found) throw new HfSandboxError(`Job ${job?.id || '?'} does not expose the sandbox server port`, 'startup')
  return found.replace(/\/+$/, '')
}

async function inspectStage(deps: HfSandboxDeps, handle: { jobId: string; owner: string }): Promise<string> {
  const endpoint = hfEndpoint(deps.endpoint)
  const response = await request(deps, `${endpoint}/api/jobs/${handle.owner}/${handle.jobId}`, { headers: authHeaders(deps) })
  if (response.status !== 200) return 'UNKNOWN'
  const body = await response.json()
  return String(body?.status?.stage || 'UNKNOWN')
}

async function waitReady(deps: HfSandboxDeps, handle: HfSandboxHandle): Promise<void> {
  const startTimeoutSecs = Number(process.env.HF_SANDBOX_START_TIMEOUT || 120)
  const deadline = Date.now() + startTimeoutSecs * 1000
  const sleep = deps.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let lastStageCheck = 0
  while (Date.now() < deadline) {
    try {
      const health = await request(deps, `${handle.baseUrl}/health`, { headers: authHeaders(deps) })
      if (health.status === 200) {
        const body = await health.json().catch(() => ({}))
        const protocol = typeof body?.protocol === 'number' ? body.protocol : 1
        if (protocol < SANDBOX_SERVER_PROTOCOL) {
          throw new HfSandboxError(`sbx-server protocol ${protocol} is older than required ${SANDBOX_SERVER_PROTOCOL}; recycle the job`, 'startup')
        }
        return
      }
    } catch (error) {
      if (error instanceof HfSandboxError && error.code !== 'unavailable') throw error
    }
    if (Date.now() - lastStageCheck > 2000) {
      lastStageCheck = Date.now()
      const stage = await inspectStage(deps, handle)
      if (TERMINAL_STAGES.has(stage)) {
        throw new HfSandboxError(`Sandbox job terminated during startup (stage: ${stage})`, 'startup')
      }
    }
    await sleep(500)
  }
  throw new HfSandboxError(`Sandbox did not become ready within ${startTimeoutSecs}s`, 'startup')
}

export async function killSandbox(deps: HfSandboxDeps, handle: Pick<HfSandboxHandle, 'jobId' | 'owner'>): Promise<void> {
  const endpoint = hfEndpoint(deps.endpoint)
  const response = await request(deps, `${endpoint}/api/jobs/${handle.owner}/${handle.jobId}`, {
    method: 'DELETE',
    headers: authHeaders(deps),
  })
  if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
    throw await errorFrom(response, 'Sandbox job cancel failed')
  }
}

// ── Exec ────────────────────────────────────────────────────────────────────

function sandboxHeaders(deps: HfSandboxDeps, handle: HfSandboxHandle): Record<string, string> {
  return { ...authHeaders(deps), 'X-Sandbox-Token': handle.token, 'Content-Type': 'application/json' }
}

export interface ExecOptions {
  cmd: string | string[]
  shell?: boolean
  env?: Record<string, string>
  cwd?: string
  timeoutSecs?: number
  stdin?: string
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  signal?: AbortSignal
}

export async function execInSandbox(deps: HfSandboxDeps, handle: HfSandboxHandle, options: ExecOptions): Promise<HfExecResult> {
  const payload: Record<string, any> = { cmd: options.cmd }
  if (options.shell !== undefined) payload.shell = options.shell
  if (options.env) payload.env = options.env
  if (options.cwd) payload.cwd = options.cwd
  if (options.timeoutSecs) payload.timeout = options.timeoutSecs
  if (options.stdin !== undefined) payload.stdin = options.stdin

  const response = await request(deps, `${handle.baseUrl}/v1/exec`, {
    method: 'POST',
    headers: sandboxHeaders(deps, handle),
    body: JSON.stringify(payload),
    signal: options.signal,
  })
  if (response.status !== 200) throw await errorFrom(response, 'Sandbox exec failed')
  if (!response.body) throw new HfSandboxError('Sandbox exec returned no stream', 'api')

  let stdout = ''
  let stderr = ''
  const cap = (s: string, chunk: string) => (s.length >= MAX_CAPTURE ? s : (s + chunk).slice(0, MAX_CAPTURE))
  const started = Date.now()

  return new Promise<HfExecResult>((resolve, reject) => {
    let buffer = ''
    let settled = false
    const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
    const fail = (error: unknown) => settle(() => reject(error))
    const onLine = (line: string) => {
      if (!line.trim()) return
      let event: any
      try { event = JSON.parse(line) } catch { return }
      switch (event.event) {
        case 'stdout': {
          const data = String(event.data ?? '')
          stdout = cap(stdout, data)
          options.onStdout?.(data)
          break
        }
        case 'stderr': {
          const data = String(event.data ?? '')
          stderr = cap(stderr, data)
          options.onStderr?.(data)
          break
        }
        case 'exit':
          settle(() => resolve({
            exitCode: typeof event.exit_code === 'number' ? event.exit_code : null,
            timedOut: event.timed_out === true,
            durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : Date.now() - started,
            stdout,
            stderr,
          }))
          break
        default: // start / ping / unknown: ignore
      }
    }
    response.body!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        onLine(line)
      }
    })
    response.body!.on('end', () => {
      if (buffer.trim()) onLine(buffer)
      fail(new HfSandboxError('Sandbox exec stream ended without an exit event', 'api'))
    })
    response.body!.on('error', fail)
    options.signal?.addEventListener('abort', () => fail(new HfSandboxError('Sandbox exec aborted', 'api')), { once: true })
  })
}

// ── Files ───────────────────────────────────────────────────────────────────

export async function writeSandboxFile(deps: HfSandboxDeps, handle: HfSandboxHandle, path: string, data: string | Buffer): Promise<void> {
  const response = await request(deps, `${handle.baseUrl}/v1/files/write?path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers: { ...sandboxHeaders(deps, handle), 'Content-Type': 'application/octet-stream' },
    body: data,
  })
  if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
    throw await errorFrom(response, 'Sandbox file write failed')
  }
}

export async function readSandboxFile(deps: HfSandboxDeps, handle: HfSandboxHandle, path: string): Promise<Buffer> {
  const response = await request(deps, `${handle.baseUrl}/v1/files/read?path=${encodeURIComponent(path)}`, {
    headers: sandboxHeaders(deps, handle),
  })
  if (response.status !== 200) throw await errorFrom(response, 'Sandbox file read failed')
  if (response.buffer) return response.buffer()
  const text = await response.text()
  return Buffer.from(text, 'utf-8')
}

export interface SandboxFileEntry { name: string; path: string; type: string; size: number }

export async function listSandboxFiles(deps: HfSandboxDeps, handle: HfSandboxHandle, path: string): Promise<SandboxFileEntry[]> {
  const response = await request(deps, `${handle.baseUrl}/v1/files/list?path=${encodeURIComponent(path)}`, {
    headers: sandboxHeaders(deps, handle),
  })
  if (response.status !== 200) throw await errorFrom(response, 'Sandbox file list failed')
  const body = await response.json()
  return Array.isArray(body?.entries) ? body.entries : []
}
