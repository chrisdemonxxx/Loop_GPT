'use client'

import type {
  BotBoxTaskType, BotComputer, BotEvent, BotQuota, BotRun, BotSkillRef, BotTask, BotTaskDetail,
  BotTaskStatus, EnqueueBotInput, EnqueueBotResult,
} from '@loop/shared'
import { API_URL, authHeaders } from './api'

/**
 * Loop Bot client — the user-facing API.
 * Every call is owner-scoped server-side; errors arrive as
 * { error, code } with codes: invalid_request(400) · forbidden(403, plan) ·
 * quota(402, VM-minutes) · not_found(404) · conflict(409) · unavailable(503).
 */

export class BotApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    const { clearAuth } = await import('./api')
    clearAuth()
    if (typeof window !== 'undefined') window.location.href = '/login'
    throw new BotApiError(401, 'expired', 'Session expired.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new BotApiError(res.status, data?.code || 'error', data?.error || `Request failed (${res.status})`)
  return data as T
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export const enqueueBotTask = (input: EnqueueBotInput) =>
  req<EnqueueBotResult>('POST', '/api/bot/tasks', input)

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

/** The caller's PERSISTENT box (Grok parity) — the always-on computer that
 *  exists independent of any task. GET is status-only (no boot side effect);
 *  POST /computer/wake boots or resumes and returns the live stream. */
export interface BotBox {
  alive: boolean
  sandboxId: string
  viewUrl: string | null
  interactiveUrl: string | null
  resumed: boolean
  ageMinutes: number
  taskType: BotBoxTaskType
  workspaceDir: string
}

/** Status probe — must not boot the VM (backend Phase 1B). */
export const getBotBox = (taskType: BotBoxTaskType = 'default') =>
  req<BotBox>('GET', `/api/bot/computer?taskType=${encodeURIComponent(taskType)}`)

/** Boot / resume the persistent box. Call when the user opens Computer or needs files. */
export const wakeBotComputer = (taskType: BotBoxTaskType = 'default') =>
  req<BotBox>('POST', '/api/bot/computer/wake', { taskType })

export const setBotTakeover = (runId: string, takeover: boolean) =>
  req<{ takeoverRequested: boolean; interactiveUrl: string | null }>('POST', `/api/bot/runs/${runId}/takeover`, { takeover })

export const getBotQuota = () => req<BotQuota>('GET', '/api/bot/quota')

// ── Box files — the operator and the bot share one filesystem ───────────────

export interface BoxFileEntry { name: string; path: string; type: 'file' | 'dir'; size: number }

export const listBoxFiles = (path = '/workspace') =>
  req<{ entries: BoxFileEntry[] }>('GET', `/api/bot/computer/files?path=${encodeURIComponent(path)}`)

export const readBoxFile = (path: string) =>
  req<{ content: string; truncated: boolean; size: number }>('GET', `/api/bot/computer/file?path=${encodeURIComponent(path)}`)

export const writeBoxFile = (path: string, content: string) =>
  req<{ size: number }>('PUT', '/api/bot/computer/file', { path, content })

export const deleteBoxFile = (path: string) =>
  req<{ ok: boolean }>('DELETE', `/api/bot/computer/file?path=${encodeURIComponent(path)}`)

/**
 * Mint a short-lived signed token for noVNC websocket auth (desktop / Bearer
 * sessions that cannot send cookies on the upgrade).
 *
 * POST /api/bot/computer/ws-token { sandboxId }
 * → { token, expiresIn, queryParam: "token" }
 * Connect websockify with `?token=<token>` (or `&token=` if the path already
 * has a query string).
 */
export const mintNovncWsToken = (sandboxId: string) =>
  req<{ token: string; expiresIn: number; queryParam: string }>(
    'POST',
    '/api/bot/computer/ws-token',
    { sandboxId },
  )

// ── Routines — recurring jobs (bot + skill + schedule) ──────────────────────

export interface RoutineRun { id: string; status: string; error: string | null; startedAt: string | null; completedAt: string | null }

export interface BotRoutine {
  id: string
  goal: string
  schedule: string
  skillId: string | null
  botId: string | null
  status: string
  paused: boolean
  nextRunAt: string | null
  createdAt: string
  runs: RoutineRun[]
}

export const getBotMemory = (botId: string) => req<{ memory: string }>('GET', `/api/bot/memory?botId=${encodeURIComponent(botId)}`)

export const listBotRoutines = () => req<{ routines: BotRoutine[] }>('GET', '/api/bot/routines')

export const createBotRoutine = (input: { goal: string; schedule: string; skillId?: string; botId?: string }) =>
  req<{ routine: BotRoutine }>('POST', '/api/bot/routines', input)

export const setBotRoutinePaused = (id: string, paused: boolean) =>
  req<{ routine: BotRoutine }>('PATCH', `/api/bot/routines/${id}`, { paused })

export const deleteBotRoutine = (id: string) => req<{ ok: boolean }>('DELETE', `/api/bot/routines/${id}`)

export const listBotSkills = (botId?: string) =>
  req<{ skills: BotSkillRef[] }>('GET', `/api/bot/skills${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`)
export const deleteBotSkill = (id: string) => req<{ ok: true }>('DELETE', `/api/bot/skills/${id}`)

/**
 * Run event stream — replay buffered events then attach live (SSE). Uses
 * fetch+reader (NOT EventSource) because the endpoint needs the Authorization
 * header. Bounded reconnect on transport failure; returns a stop function.
 *
 * Only `done` ends the stream early — `final` is still delivered to onEvent
 * (teach emits `skill_saved` after `final` in some paths).
 */
export function streamBotRun(
  runId: string,
  onEvent: (event: BotEvent) => void,
  onDone?: () => void,
  onError?: (message: string) => void,
  opts?: { maxRetries?: number },
): () => void {
  const controller = new AbortController()
  const maxRetries = opts?.maxRetries ?? 3
  ;(async () => {
    let attempt = 0
    /** Last monotonic event seq — resume via ?after= so reconnects survive the 800-event ring. */
    let lastSeq = 0
    while (!controller.signal.aborted) {
      try {
        const afterQs = lastSeq > 0 ? `?after=${lastSeq}` : ''
        const res = await fetch(`${API_URL}/api/bot/runs/${runId}/events${afterQs}`, {
          headers: authHeaders(),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}))
          // 404 while the worker is still claiming — let the caller retry via
          // reconnect; surface after retries are exhausted.
          if (res.status === 404 && attempt < maxRetries) {
            attempt += 1
            await new Promise((r) => setTimeout(r, 1000 * attempt))
            continue
          }
          onError?.(data?.error || `Stream failed (${res.status})`)
          return
        }
        attempt = 0
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
              if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
              onEvent(event)
              if (event.type === 'done') { onDone?.(); return }
            } catch { /* malformed frame */ }
          }
        }
        // Transport closed without a terminal `done` — reconnect with the cursor.
        attempt += 1
        if (attempt > maxRetries) {
          onDone?.()
          return
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      } catch (err: any) {
        if (err?.name === 'AbortError' || controller.signal.aborted) return
        attempt += 1
        if (attempt > maxRetries) {
          onError?.(err?.message || 'Stream failed')
          return
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
  })()
  return () => controller.abort()
}

export type {
  BotBoxTaskType, BotComputer, BotEvent, BotQuota, BotRun, BotSkillRef, BotTask, BotTaskDetail,
  BotTaskStatus, EnqueueBotInput, EnqueueBotResult,
}
export type { BotTaskType } from '@loop/shared'
