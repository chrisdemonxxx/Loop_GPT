/**
 * Live view + durable persistence for bot runs (the bot analogue of
 * researchRuns.ts). The bot worker emits AgentEvents; this module keeps an
 * in-process live view for the admin SSE relay and persists events + the
 * final result to the BotRun row, so a run is observable during execution
 * and replayable afterwards.
 */
import { randomUUID } from 'crypto'
import { prisma } from './prisma'
import type { AgentEvent } from '../agent/types'

export interface BotRunView {
  id: string
  taskId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  events: AgentEvent[]
  result?: string
  artifacts?: unknown[]
  usage?: { tokensIn: number; tokensOut: number; model?: string }
  error?: string
  startedAt: string
  completedAt?: string
}

interface Live {
  view: BotRunView
  listeners: Set<(event: AgentEvent) => void>
  persistTimer?: ReturnType<typeof setTimeout>
}

const MAX_EVENTS = 800
const live = new Map<string, Live>()

const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,/i

/** Persist a screenshot as an artifact reference, not the PNG bytes. */
function redactEvent(event: AgentEvent): AgentEvent {
  if (event.type !== 'tool_result' || !event.data || typeof event.data !== 'object') return event
  const data = event.data as Record<string, unknown>
  if (typeof data.imageDataUri !== 'string' || !DATA_IMAGE.test(data.imageDataUri)) return event
  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : []
  const first = artifacts[0] && typeof artifacts[0] === 'object' ? artifacts[0] as Record<string, unknown> : null
  const { imageDataUri: _image, ...rest } = data
  return {
    ...event,
    data: {
      ...rest,
      screenshotRef: first
        ? { id: first.id, name: first.name, url: first.url }
        : { omitted: true },
    },
  }
}

async function persist(run: Live, final = false) {
  if (!prisma) return
  try {
    await prisma.botRun.update({
      where: { id: run.view.id },
      data: {
        status: run.view.status,
        events: run.view.events as any,
        result: run.view.result ?? null,
        artifacts: (run.view.artifacts ?? null) as any,
        usage: (run.view.usage ?? null) as any,
        error: run.view.error ?? null,
        completedAt: run.view.completedAt ? new Date(run.view.completedAt) : null,
      },
    })
  } catch { /* persistence is best-effort; the live view still serves */ }
  if (final && run.persistTimer) { clearTimeout(run.persistTimer); run.persistTimer = undefined }
}

function schedulePersist(run: Live) {
  if (run.persistTimer) return
  run.persistTimer = setTimeout(() => { run.persistTimer = undefined; void persist(run) }, 400)
}

export async function startRun(taskId: string): Promise<{
  runId: string
  emit: (event: AgentEvent) => void
  /** Terminal persist is returned so the caller can await durable final state. */
  complete: (result: { content: string; artifacts: unknown[]; usage: BotRunView['usage'] }) => Promise<void>
  fail: (error: string, cancelled?: boolean) => Promise<void>
}> {
  const id = randomUUID()
  const run: Live = {
    listeners: new Set(),
    view: { id, taskId, status: 'running', events: [], startedAt: new Date().toISOString() },
  }
  live.set(id, run)
  if (prisma) {
    try {
      await prisma.botRun.create({ data: { id, taskId, status: 'running', events: [] } })
    } catch (error) {
      live.delete(id)
      throw error
    }
  }
  return {
    runId: id,
    emit(event) {
      const stored = redactEvent(event)
      if (run.view.events.length >= MAX_EVENTS) run.view.events.shift()
      run.view.events.push(stored)
      for (const listener of run.listeners) { try { listener(stored) } catch { /* listener gone */ } }
      schedulePersist(run)
    },
    complete(result) {
      run.view.status = 'completed'
      run.view.result = result.content
      run.view.artifacts = result.artifacts
      run.view.usage = result.usage
      run.view.completedAt = new Date().toISOString()
      for (const listener of run.listeners) { try { listener({ type: 'done' }) } catch { /* ignore */ } }
      return persist(run, true).finally(() => live.delete(id))
    },
    fail(error, cancelled = false) {
      run.view.status = cancelled ? 'cancelled' : 'failed'
      run.view.error = error.slice(0, 500)
      run.view.completedAt = new Date().toISOString()
      for (const listener of run.listeners) { try { listener({ type: 'done' }) } catch { /* ignore */ } }
      return persist(run, true).finally(() => live.delete(id))
    },
  }
}

/** Replay what has already happened, then attach live. Returns unsubscribe.
 *  When this process is not the worker, tail the persisted row so the API
 *  live viewer still receives events. */
export function subscribe(runId: string, listener: (event: AgentEvent) => void): () => void {
  const run = live.get(runId)
  if (run) {
    for (const event of run.view.events) { try { listener(event) } catch { /* ignore */ } }
    if (run.view.status !== 'running') {
      try { listener({ type: 'done' }) } catch { /* ignore */ }
      return () => {}
    }
    run.listeners.add(listener)
    return () => run.listeners.delete(listener)
  }
  let stopped = false
  let cursor = 0
  const poll: { timer?: ReturnType<typeof setInterval> } = {}
  const stop = () => {
    stopped = true
    if (poll.timer) clearInterval(poll.timer)
  }
  const tick = async () => {
    if (stopped || !prisma) return
    try {
      const row = await prisma.botRun.findUnique({ where: { id: runId }, select: { events: true, status: true } })
      if (!row || stopped) return
      const events = Array.isArray(row.events) ? row.events as AgentEvent[] : []
      for (let i = cursor; i < events.length; i++) {
        try { listener(events[i]) } catch { /* ignore */ }
      }
      cursor = events.length
      if (row.status !== 'running') {
        try { listener({ type: 'done' }) } catch { /* ignore */ }
        stop()
      }
    } catch { /* next tick */ }
  }
  void tick()
  poll.timer = setInterval(() => { void tick() }, 500)
  poll.timer.unref?.()
  return stop
}

/**
 * Ownership check for user-scoped reads (B1). Returns the owning userId of the
 * run's task — null for system tasks, undefined when the run doesn't exist.
 */
async function runOwnerId(runId: string): Promise<string | null | undefined> {
  if (!prisma) return undefined
  try {
    const row = await prisma.botRun.findUnique({ where: { id: runId }, select: { task: { select: { userId: true } } } })
    return row ? row.task.userId : undefined
  } catch {
    return undefined
  }
}

/** Undefined scope = admin (sees everything). A scoped caller only matches
 *  their own runs; system tasks (NULL owner) are never user-visible. */
async function ownedRun(runId: string, scopeUserId?: string): Promise<boolean> {
  if (!scopeUserId) return true
  return (await runOwnerId(runId)) === scopeUserId
}

/** Live view first, then the persisted row. */
export async function getRun(runId: string, scopeUserId?: string): Promise<BotRunView | undefined> {
  if (!await ownedRun(runId, scopeUserId)) return undefined
  const inMemory = live.get(runId)
  if (inMemory) return inMemory.view
  if (!prisma) return undefined
  try {
    const row = await prisma.botRun.findUnique({ where: { id: runId } })
    if (!row) return undefined
    return {
      id: row.id,
      taskId: row.taskId,
      status: row.status as BotRunView['status'],
      events: (row.events as any[]) || [],
      result: row.result ?? undefined,
      artifacts: (row.artifacts as any[]) ?? undefined,
      usage: (row.usage as BotRunView['usage']) ?? undefined,
      error: row.error ?? undefined,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString(),
    }
  } catch {
    return undefined
  }
}

export async function listRunsForTask(taskId: string, limit = 10): Promise<BotRunView[]> {
  if (!prisma) return []
  const rows = await prisma.botRun.findMany({
    where: { taskId },
    orderBy: { startedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 50),
  })
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    status: row.status as BotRunView['status'],
    events: (row.events as any[]) || [],
    result: row.result ?? undefined,
    artifacts: (row.artifacts as any[]) ?? undefined,
    usage: (row.usage as BotRunView['usage']) ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString(),
  }))
}

// ── Dedicated-computer session metadata + takeover (cross-process) ─────────
// The worker process writes session info; the admin process reads it and
// flips the takeover flag. The DB row is the rendezvous — the in-memory live
// view only exists in the worker.

export interface RunComputerInfo {
  sandboxId?: string
  streamAuthKey?: string
  viewUrl?: string
  interactiveUrl?: string
  startedAt?: string
  endedAt?: string
  minutes?: number
  takeoverRequested?: boolean
  /** Run status as of the DB read (the worker owns lifecycle transitions). */
  runStatus?: string
}

const runComputers = new Map<string, RunComputerInfo>()

/** Worker side: merge session metadata into the live view + the row. */
export async function setRunComputer(runId: string, patch: RunComputerInfo): Promise<void> {
  const merged = { ...(runComputers.get(runId) || {}), ...patch }
  runComputers.set(runId, merged)
  if (!prisma) return
  try {
    await prisma.botRun.update({ where: { id: runId }, data: { computer: merged as any } })
  } catch { /* best effort; the run still serves */ }
}

/** Worker side (ComputerSession): poll the cross-process takeover flag. */
export async function isRunTakeoverRequested(runId: string): Promise<boolean> {
  if (!prisma) return false
  const row = await prisma.botRun.findUnique({ where: { id: runId }, select: { takeoverRequested: true, status: true } })
  return !!row && row.status === 'running' && row.takeoverRequested
}

/** Admin/user side: read session metadata. Scoped callers only see their own
 *  runs' computers.
 *
 *  The DB row is the ONLY cross-process truth: the worker process writes both
 *  the session start (URLs) and the end-of-run marker (endedAt, minutes),
 *  while this process (the API) mostly READS. An in-memory hit here can
 *  therefore predate the worker's final write — the old bug returned
 *  "active" plus URLs for a sandbox that was already destroyed, and the UI
 *  framed a dead host (black screen). Always re-read the row; the in-memory
 *  map is only a fallback for when the DB is unavailable. */
export async function getRunComputer(runId: string, scopeUserId?: string): Promise<RunComputerInfo | undefined> {
  if (!await ownedRun(runId, scopeUserId)) return undefined
  const inMemory = runComputers.get(runId)
  if (!prisma) return inMemory
  try {
    const row = await prisma.botRun.findUnique({ where: { id: runId }, select: { computer: true, takeoverRequested: true, status: true } })
    if (!row) return inMemory
    const persisted = ((row.computer as RunComputerInfo) || {})
    // Merge with the persisted row winning on every field it carries — the
    // worker's writes land there last (session start AND end-of-run), so it
    // is strictly fresher than anything this process cached.
    const info: RunComputerInfo = {
      ...inMemory,
      ...persisted,
      takeoverRequested: row.takeoverRequested && row.status === 'running',
      runStatus: row.status,
    }
    runComputers.set(runId, info)
    return info
  } catch {
    return inMemory
  }
}

/** Seize/release the VM. The worker's session guard polls this flag. Scoped
 *  callers can only drive their own running VMs (relation filter in the
 *  guarded update — no separate read to race). */
export async function setRunTakeover(runId: string, requested: boolean, scopeUserId?: string): Promise<boolean> {
  if (!prisma) return false
  try {
    const updated = await prisma.botRun.updateMany({
      where: { id: runId, status: 'running', ...(scopeUserId ? { task: { userId: scopeUserId } } : {}) },
      data: { takeoverRequested: requested },
    })
    const info = runComputers.get(runId)
    if (info) runComputers.set(runId, { ...info, takeoverRequested: requested })
    return updated.count === 1
  } catch {
    return false
  }
}
