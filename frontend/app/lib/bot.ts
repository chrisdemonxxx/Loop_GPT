'use client'

import { API_URL, authHeaders } from './api'

/**
 * Loop Bot client — the user-facing API shipped in commit 740f171.
 * Every call is owner-scoped server-side; errors arrive as
 * { error, code } with codes: invalid_request(400) · forbidden(403, plan) ·
 * quota(402, VM-minutes) · not_found(404) · conflict(409) · unavailable(503).
 */

// ── Types (mirror backend agentTasks.ts / botRuns.ts / routes/bot.ts) ────────

export type BotTaskStatus = 'queued' | 'processing' | 'succeeded' | 'dead_letter' | 'cancelled'
export type BotRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface BotTask {
  id: string
  kind: 'ops' | 'scheduled'
  goal: string
  status: BotTaskStatus
  schedule: string | null
  model: string | null
  priority: number
  attempts: number
  failures: number
  nextAttemptAt: string
  cancelRequested: boolean
  lastErrorCode: string | null
  createdAt: string
  updatedAt: string
}

export interface BotTaskDetail extends BotTask {
  runs: Array<{ id: string; status: BotRunStatus; error: string | null; startedAt: string; completedAt: string | null }>
}

export interface BotRun {
  id: string
  taskId: string
  status: BotRunStatus
  events: BotEvent[]
  result?: string
  artifacts?: Array<{ id: string; kind: string; name: string }>
  usage?: { tokensIn: number; tokensOut: number; model?: string }
  error?: string
  startedAt: string
  completedAt?: string | null
}

export interface BotComputer {
  active: boolean
  sandboxId: string
  viewUrl: string | null
  interactiveUrl: string | null
  takeoverRequested: boolean
  minutes: number | null
  startedAt: string | null
  endedAt: string | null
}

export interface BotQuota {
  plan: string
  unlimited: boolean
  computerAllowed: boolean
  computerConfigured: boolean
  cap: number | null
  used: number
  remaining: number | null
  resetsAt: string
}

export interface BotEvent {
  type: string
  seq?: number
  message?: string
  step?: number
  text?: string
  name?: string
  args?: any
  chunk?: string
  stream?: 'stdout' | 'stderr'
  items?: Array<{ id: string; label: string; status: string }>
  content?: string
  isError?: boolean
  data?: any
  artifact?: { id: string; kind: string; name: string }
  runId?: string
}

export interface EnqueueBotInput {
  goal: string
  kind?: 'ops' | 'scheduled' | 'teach'
  schedule?: string
  model?: string
  thinking?: 'low' | 'medium' | 'high' | 'xhigh'
  allowedTools?: string[]
  maxSteps?: number
  computer?: { enabled: boolean; ttlMinutes?: number }
  skillId?: string
  priority?: number
}

export class BotApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new BotApiError(res.status, data?.code || 'error', data?.error || `Request failed (${res.status})`)
  return data as T
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export const enqueueBotTask = (input: EnqueueBotInput) =>
  req<{ ok: true; task: { id: string; kind: string; status: string; nextAttemptAt: string; computer?: { enabled: boolean; ttlMinutes?: number } } }>('POST', '/api/bot/tasks', input)

export const listBotTasks = (opts: { status?: string; limit?: number } = {}) => {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.limit) params.set('limit', String(opts.limit))
  return req<{ tasks: BotTask[] }>('GET', `/api/bot/tasks${params.size ? `?${params}` : ''}`)
}

export const getBotTask = (id: string) => req<BotTaskDetail>('GET', `/api/bot/tasks/${id}`)

export const cancelBotTask = (id: string) =>
  req<{ cancelled: true; immediate: boolean }>('POST', `/api/bot/tasks/${id}/cancel`, {})

// ── Runs ─────────────────────────────────────────────────────────────────────

export const getBotRun = (runId: string) => req<BotRun>('GET', `/api/bot/runs/${runId}`)

export const getBotComputer = (runId: string) => req<BotComputer>('GET', `/api/bot/runs/${runId}/computer`)

export const setBotTakeover = (runId: string, takeover: boolean) =>
  req<{ takeoverRequested: boolean; interactiveUrl: string | null }>('POST', `/api/bot/runs/${runId}/takeover`, { takeover })

export const getBotQuota = () => req<BotQuota>('GET', '/api/bot/quota')

export interface BotSkillRef {
  id: string
  name: string
  description: string
  triggers?: string[]
  tools?: string[]
}
export const listBotSkills = () => req<{ skills: BotSkillRef[] }>('GET', '/api/bot/skills')
export const deleteBotSkill = (id: string) => req<{ ok: true }>('DELETE', `/api/bot/skills/${id}`)

/**
 * Run event stream — replay buffered events then attach live (SSE). Uses
 * fetch+reader (NOT EventSource) because the endpoint needs the Authorization
 * header. Returns a stop function; onEvent fires per sequenced event,
 * onDone at the terminal event, onError on transport failure.
 */
export function streamBotRun(
  runId: string,
  onEvent: (event: BotEvent) => void,
  onDone?: () => void,
  onError?: (message: string) => void,
): () => void {
  const controller = new AbortController()
  ;(async () => {
    try {
      const res = await fetch(`${API_URL}/api/bot/runs/${runId}/events`, {
        headers: authHeaders(),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}))
        onError?.(data?.error || `Stream failed (${res.status})`)
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          const payload = line.slice(5).trim()
          if (!payload || payload.startsWith(':')) continue
          try {
            const event = JSON.parse(payload) as BotEvent
            onEvent(event)
            if (event.type === 'done') { onDone?.(); return }
          } catch { /* malformed frame */ }
        }
      }
      onDone?.()
    } catch (err: any) {
      if (err?.name !== 'AbortError') onError?.(err?.message || 'Stream failed')
    }
  })()
  return () => controller.abort()
}

/** Human labels for task statuses (used by the /agents page chips). */
export const BOT_STATUS_LABEL: Record<BotTaskStatus, string> = {
  queued: 'Queued', processing: 'Running', succeeded: 'Done', dead_letter: 'Failed', cancelled: 'Cancelled',
}
export const BOT_STATUS_TONE: Record<BotTaskStatus, 'accent' | 'green' | 'rose' | 'muted'> = {
  queued: 'muted', processing: 'accent', succeeded: 'green', dead_letter: 'rose', cancelled: 'muted',
}
