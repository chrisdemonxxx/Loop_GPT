'use client'

import type {
  BotBoxTaskType, BotComputer, BotDiskStatus, BotEvent, BotQuota, BotRun, BotSkillRef, BotTask, BotTaskDetail,
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

export const listBotTasks = (opts: { status?: string; limit?: number; conversationId?: string; botId?: string } = {}) => {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.limit) params.set('limit', String(opts.limit))
  if (opts.conversationId) params.set('conversationId', opts.conversationId)
  if (opts.botId) params.set('botId', opts.botId)
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
  /** True only when a live probe connected. A stored sandbox id is not enough. */
  alive: boolean
  /** Sandbox row exists, but the probe did not find a live machine. */
  paused?: boolean
  sandboxId: string
  /** Null unless alive. */
  viewUrl: string | null
  /** Null unless alive and takeover is on. */
  interactiveUrl: string | null
  takeoverRequested?: boolean
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

/**
 * Take or release the persistent desktop. Does not boot — wake first.
 * 409 when the box is not connected.
 */
export const setBotBoxTakeover = (takeover: boolean) =>
  req<{ takeoverRequested: boolean; interactiveUrl: string | null }>('POST', '/api/bot/computer/takeover', { takeover })

/** Bill minutes the Computer tab has been open. Safe to call on an interval and once on close. */
export const settleBotComputer = () =>
  req<{ ok: true; minutes: number }>('POST', '/api/bot/computer/settle', {})

/** Pause the persistent desktop. Wake resumes the same sandbox. */
export const sleepBotComputer = () =>
  req<{ alive: false; sandboxId: string; paused: true }>('POST', '/api/bot/computer/sleep', {})

/** Replace a wedged desktop. Mirrored files are copied onto the new machine. */
export const recoverBotComputer = (taskType: BotBoxTaskType = 'default') =>
  req<BotBox>('POST', '/api/bot/computer/recover', { taskType })

/** Roll the desktop back to its baseline snapshot. confirm is required. */
export const resetBotComputer = (taskType: BotBoxTaskType = 'default') =>
  req<BotBox>('POST', '/api/bot/computer/reset', { confirm: true, taskType })

/** Free space on the live desktop. Does not wake an asleep computer. */
export const getBotComputerDisk = () =>
  req<BotDiskStatus>('GET', '/api/bot/computer/disk')

export const setBotTakeover = (runId: string, takeover: boolean) =>
  req<{ takeoverRequested: boolean; interactiveUrl: string | null }>('POST', `/api/bot/runs/${runId}/takeover`, { takeover })

/** One operator input during a teach recording. Coordinates are framebuffer pixels (1366×768), not CSS pixels. */
export interface BotTeachStep {
  at: number
  kind: 'click' | 'key' | 'type'
  x?: number
  y?: number
  key?: string
  text?: string
}

/** Append a click, key, or typed run to the teach timeline. The runner distills these after Stop.
 *  stored is true only when the server kept the step on a live teach run. */
export const appendBotTeachStep = (runId: string, step: BotTeachStep) =>
  req<{ ok: true; stored: boolean }>('POST', `/api/bot/runs/${runId}/teach-steps`, step)

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

export interface RoutineRun {
  id: string
  status: string
  error: string | null
  result?: string | null
  startedAt: string | null
  completedAt: string | null
}

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
  /** Latest run result, when the list payload includes one. */
  result?: string | null
  runs: RoutineRun[]
  timezone?: string
  autoPauseWhenAway?: boolean
  pausedReason?: 'user' | 'away' | null
}

export const getBotMemory = (botId: string) => req<{ memory: string; memories?: Array<{ id: string; content: string; visibility: 'private' | 'team'; createdAt: string }> }>('GET', `/api/bot/memory?botId=${encodeURIComponent(botId)}`)

export const listBotRoutines = () => req<{ routines: BotRoutine[] }>('GET', '/api/bot/routines')

export const createBotRoutine = (input: {
  goal: string
  schedule: string
  skillId?: string
  botId?: string
  allowedTools?: string[]
  computer?: { enabled: boolean; ttlMinutes?: number }
  conversationId?: string
}) =>
  req<{ routine: BotRoutine }>('POST', '/api/bot/routines', input)

export const setBotRoutinePaused = (id: string, paused: boolean) =>
  req<{ routine: BotRoutine }>('PATCH', `/api/bot/routines/${id}`, { paused })

export const deleteBotRoutine = (id: string) => req<{ ok: boolean }>('DELETE', `/api/bot/routines/${id}`)

export const listBotSkills = (botId?: string) =>
  req<{ skills: BotSkillRef[] }>('GET', `/api/bot/skills${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`)
export const deleteBotSkill = (id: string) => req<{ ok: true }>('DELETE', `/api/bot/skills/${id}`)

export const createBotSkill = (input: { name: string; description: string; instructions: string; triggers?: string[]; botId?: string }) =>
  req<{ id: string; name: string; description: string; instructions: string }>('POST', '/api/bot/skills', input)

export const updateBotSkill = (id: string, input: { name: string; description: string; instructions: string; triggers?: string[] }) =>
  req<{ id: string; name: string; description: string; instructions: string }>('PUT', `/api/bot/skills/${id}`, input)

export const getBotSkill = (id: string) =>
  req<{ id: string; name: string; description: string; instructions: string; triggers?: string[] }>('GET', `/api/bot/skills/${id}`)

export const resetBotConversation = (botId: string) =>
  req<{ ok: true; resetAt: string }>('POST', '/api/bot/conversation/reset', { botId })

export const addBotMemory = (input: { botId: string; content: string; visibility?: 'private' | 'team' }) =>
  req<{ memory: { id: string; content: string; visibility: 'private' | 'team'; createdAt: string } }>('POST', '/api/bot/memory', input)

export const deleteBotMemory = (id: string, botId: string) =>
  req<{ ok: true }>('DELETE', `/api/bot/memory/${id}?botId=${encodeURIComponent(botId)}`)

export const discardBotTeach = (runId: string, recordingId?: string) =>
  req<{ ok: true; discarded: true }>('POST', `/api/bot/runs/${runId}/teach/discard`, recordingId ? { recordingId } : {})

export const listTeachRecordings = () =>
  req<{ recordings: Array<{ id: string; frameCount: number; stepLog: string }> }>('GET', '/api/bot/teach/recordings')

export const listBotLibrary = (botId?: string) =>
  req<{ items: Array<{ id: string; kind: string; name: string; path: string; shareToken?: string | null }> }>('GET', `/api/bot/library${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`)

export const shareBotLibraryItem = (id: string) =>
  req<{ token: string; url: string; expiresAt: string }>('POST', `/api/bot/library/${id}/share`, {})

export const revokeBotLibraryItem = (id: string) =>
  req<{ ok: true }>('DELETE', `/api/bot/library/${id}/share`)

export const getBotApprovalMode = () => req<{ mode: 'ask' | 'safe' | 'accept' }>('GET', '/api/bot/settings/approvals')

export const setBotApprovalMode = (mode: 'ask' | 'safe' | 'accept') =>
  req<{ mode: 'ask' | 'safe' | 'accept' }>('PUT', '/api/bot/settings/approvals', { mode })

export const approveBotRun = (runId: string, approvalId: string, approved: boolean) =>
  req<{ ok: true; approved: boolean }>('POST', `/api/bot/runs/${runId}/approve`, { approvalId, approved })

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
          onError?.('The trace stream ended before it finished.')
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
