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
      if (run.view.events.length >= MAX_EVENTS) run.view.events.shift()
      run.view.events.push(event)
      for (const listener of run.listeners) { try { listener(event) } catch { /* listener gone */ } }
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

/** Replay what has already happened, then attach live. Returns unsubscribe. */
export function subscribe(runId: string, listener: (event: AgentEvent) => void): () => void {
  const run = live.get(runId)
  if (!run) return () => {}
  for (const event of run.view.events) { try { listener(event) } catch { /* ignore */ } }
  if (run.view.status !== 'running') {
    try { listener({ type: 'done' }) } catch { /* ignore */ }
    return () => {}
  }
  run.listeners.add(listener)
  return () => run.listeners.delete(listener)
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

/** Admin/user side: read session metadata (live view first, then the row).
 *  Scoped callers only see their own runs' computers. */
export async function getRunComputer(runId: string, scopeUserId?: string): Promise<RunComputerInfo | undefined> {
  if (!await ownedRun(runId, scopeUserId)) return undefined
  const inMemory = runComputers.get(runId)
  if (inMemory) return inMemory
  if (!prisma) return undefined
  try {
    const row = await prisma.botRun.findUnique({ where: { id: runId }, select: { computer: true, takeoverRequested: true } })
    if (!row) return undefined
    const info = { ...((row.computer as RunComputerInfo) || {}), takeoverRequested: row.takeoverRequested }
    runComputers.set(runId, info)
    return info
  } catch {
    return undefined
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
