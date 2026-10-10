import type { TaskKind } from '@loop/loopit-contracts'

import { ApiError } from './errors'
import { LOOPIT_API_BASE, createTokenStore, type TokenStore, type TokenStoreOptions } from './authToken'

export type RunStatus = 'running' | 'verified' | 'error' | string
export type NodeStatus = 'pending' | 'running' | 'verifying' | 'blocked' | 'merged' | 'failed'

export interface TaskNodeView {
  id: string
  kind?: TaskKind | string
  goal: string
  dag_parents: string[]
  fork_checkpoint_id?: string
  expected_verification: string[]
  destructive: boolean
  destructive_reason?: string
  status?: NodeStatus
}

export interface TaskDagView {
  plan_id: string
  goal: string
  base_checkpoint_id?: string
  nodes: TaskNodeView[]
}

export interface ApprovalGate {
  gate_id: string
  node_id?: string
  action: string
  reason: string
  args?: Record<string, unknown>
  args_hash?: string
  expires_at?: string | null
  destructive: boolean
  irreversible?: boolean
  status?: 'pending' | 'approved' | 'rejected'
}

export interface CheckpointView {
  checkpoint_id: string
  parent_id: string | null
  label?: string | null
  created_at: string
  verified: boolean
  live?: boolean
}

export interface RunCost {
  credits_spent?: number
  cost_usd?: number
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  iterations?: number
  cost_per_successful_deploy?: number
}

export interface RunSummary {
  run_id: string
  project_id: string
  prompt: string
  status: RunStatus
  started_at: string
  finished_at: string | null
  iterations: number
  summary: string
  credits_spent: number
  stack?: string
  dag?: TaskDagView | null
  task_dag?: TaskDagView | null
  gates?: ApprovalGate[]
  gate?: ApprovalGate | null
  checkpoints?: CheckpointView[]
  cost?: RunCost | null
}

export interface RunDetail extends RunSummary {
  files: string[]
}

export interface AuditStreamEvent {
  kind: 'audit'
  type: string
  outcome: string | null
  occurred_at: string
  detail: Record<string, unknown>
}

export interface RunStreamEvent extends RunDetail { kind: 'run' }
export interface DagStreamEvent { kind: 'dag'; dag: TaskDagView }
export interface GateStreamEvent { kind: 'gate'; gate: ApprovalGate }
export interface CheckpointsStreamEvent { kind: 'checkpoints'; checkpoints: CheckpointView[] }
export interface CostStreamEvent { kind: 'cost'; cost: RunCost }
export interface ErrorStreamEvent { kind: 'error'; message: string }

export type StreamEvent =
  | AuditStreamEvent
  | RunStreamEvent
  | DagStreamEvent
  | GateStreamEvent
  | CheckpointsStreamEvent
  | CostStreamEvent
  | ErrorStreamEvent

export interface Health {
  status: string
  offline: boolean
  exec_enabled: boolean
  projects_root: string
  auth_required?: boolean
  run_execution_mode?: string
}

export interface LoopitClientOptions extends TokenStoreOptions {
  baseUrl?: string
}

export interface LoopitClient {
  getToken: TokenStore['getToken']
  clearToken: TokenStore['clear']
  getHealth: () => Promise<Health>
  listRuns: () => Promise<RunSummary[]>
  getRun: (runId: string) => Promise<RunDetail>
  startRun: (prompt: string, options?: { projectId?: string | null; maxIterations?: number }) => Promise<RunSummary>
  deployProject: (projectId: string, checkpointId: string, reason: string) => Promise<{ production_url: string; status: string }>
  approveGate: (runId: string, gateId: string, reason: string) => Promise<void>
  rejectGate: (runId: string, gateId: string, reason: string) => Promise<void>
  rollbackCheckpoint: (projectId: string, checkpointId: string) => Promise<void>
  forkCheckpoint: (projectId: string, checkpointId: string) => Promise<{ project_id?: string }>
  createPreviewUrl: (projectId: string, path?: string) => Promise<string>
  getFile: (runId: string, path: string) => Promise<string>
  streamRunEvents: (runId: string, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) => Promise<void>
}

export function createLoopitClient(options: LoopitClientOptions = {}): LoopitClient {
  const baseUrl = (options.baseUrl ?? LOOPIT_API_BASE).replace(/\/$/, '')
  const store = createTokenStore(options)

  async function apiFetch<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const token = await store.getToken(attempt > 0)
    const headers = new Headers(init.headers)
    if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json')
    headers.set('Authorization', `Bearer ${token}`)
    let response: Response
    try {
      response = await fetchImpl(options)(`${baseUrl}${path}`, { ...init, headers })
    } catch (cause) {
      if (isAbort(cause)) throw cause
      throw new ApiError(0, cause instanceof Error ? cause.message : 'Failed to fetch')
    }
    if (response.status === 401 && attempt === 0) {
      store.clear()
      return apiFetch<T>(path, init, 1)
    }
    return readJson<T>(response)
  }

  return {
    getToken: store.getToken,
    clearToken: store.clear,
    getHealth: () => apiFetch<Health>('/health'),
    listRuns: async () => {
      const body = await apiFetch<unknown>('/runs')
      if (!Array.isArray(body)) throw new ApiError(502, 'unexpected runs payload')
      return body as RunSummary[]
    },
    getRun: (runId) => apiFetch<RunDetail>(`/runs/${encodeURIComponent(runId)}`),
    startRun: (prompt, runOptions = {}) => apiFetch<RunSummary>('/runs', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        project_id: runOptions.projectId ?? null,
        max_iterations: runOptions.maxIterations ?? 12,
      }),
    }),
    deployProject: (projectId, checkpointId, reason) => apiFetch(`/projects/${encodeURIComponent(projectId)}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ checkpoint_id: checkpointId, confirmed: true, reason }),
    }),
    approveGate: async (runId, gateId, reason) => {
      await apiFetch(`/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
    },
    rejectGate: async (runId, gateId, reason) => {
      await apiFetch(`/runs/${encodeURIComponent(runId)}/gates/${encodeURIComponent(gateId)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      })
    },
    rollbackCheckpoint: async (projectId, checkpointId) => {
      await apiFetch(`/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true }),
      })
    },
    forkCheckpoint: (projectId, checkpointId) => apiFetch(`/projects/${encodeURIComponent(projectId)}/checkpoints/${encodeURIComponent(checkpointId)}/fork`, {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
    }),
    createPreviewUrl: async (projectId, path = 'index.html') => {
      const body = await apiFetch<{ url: string }>(`/projects/${encodeURIComponent(projectId)}/preview`, {
        method: 'POST',
        body: JSON.stringify({ path }),
      })
      return resolvePreviewUrl(body.url, baseUrl)
    },
    getFile: async (runId, path) => {
      const body = await apiFetch<{ content: string }>(`/runs/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(path)}`)
      return body.content
    },
    streamRunEvents: (runId, onEvent, signal) => streamEvents(store, baseUrl, options, runId, onEvent, signal),
  }
}

function fetchImpl(options: LoopitClientOptions): typeof fetch {
  return options.fetchImpl ?? fetch
}

export function resolvePreviewUrl(url: string, baseUrl = LOOPIT_API_BASE): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  if (url.startsWith('/')) return url
  return `${baseUrl.replace(/\/$/, '')}/${url.replace(/^\//, '')}`
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ApiError(response.status, await errorMessage(response))
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.text()
  let message = body || `${response.status} ${response.statusText}`
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown }
    if (typeof parsed.detail === 'string') message = parsed.detail
    else if (typeof parsed.error === 'string') message = parsed.error
  } catch { /* keep raw body */ }
  return message
}

async function streamEvents(
  store: TokenStore,
  baseUrl: string,
  options: LoopitClientOptions,
  runId: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
  attempt = 0,
): Promise<void> {
  const token = await store.getToken(attempt > 0)
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('Accept', 'text/event-stream')
  let response: Response
  try {
    response = await fetchImpl(options)(`${baseUrl}/runs/${encodeURIComponent(runId)}/events`, {
      headers,
      signal,
    })
  } catch (cause) {
    if (isAbort(cause)) throw cause
    throw new ApiError(0, cause instanceof Error ? cause.message : 'Failed to fetch')
  }
  if (response.status === 401 && attempt === 0) {
    store.clear()
    return streamEvents(store, baseUrl, options, runId, onEvent, signal, 1)
  }
  if (!response.ok) throw new ApiError(response.status, await response.text())
  if (!response.body) throw new Error('streaming is not supported by this browser')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const chunks = buffer.split(/\r?\n\r?\n/)
    buffer = chunks.pop() ?? ''
    for (const chunk of chunks) {
      const parsed = parseSseChunk(chunk)
      if (parsed === 'end') return
      if (parsed) onEvent(parsed)
    }
    if (done) break
  }
}

function parseSseChunk(chunk: string): StreamEvent | 'end' | null {
  const lines = chunk.split(/\r?\n/)
  if (lines.some((line) => line.trim() === 'event: end')) return 'end'
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
  return data ? JSON.parse(data) as StreamEvent : null
}

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}
