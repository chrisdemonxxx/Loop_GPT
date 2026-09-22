/**
 * Durable deep-research runs.
 *
 * The orchestrator (agent/research/deepResearch) emits AgentEvents. This module
 * keeps an in-process live view (for SSE relay) and persists progress + the final
 * cited report to Postgres, so a run survives a client reload and can be replayed
 * via the read API. The run is decoupled from the HTTP response: a disconnect
 * does not cancel it.
 */
import { randomUUID } from 'crypto'
import { prisma } from './prisma'
import type { AgentEvent } from '../agent/types'

export interface ResearchRunView {
  id: string
  conversationId: string
  query: string
  status: 'running' | 'completed' | 'failed'
  events: AgentEvent[]
  report?: string
  sources?: Array<{ index: number; title: string; url: string }>
  createdAt: string
}

interface Live {
  view: ResearchRunView
  userId: string
  listeners: Set<(event: AgentEvent) => void>
  controller: AbortController
  persistTimer?: ReturnType<typeof setTimeout>
}

const MAX_EVENTS = 800
const live = new Map<string, Live>()

async function persist(run: Live, final = false) {
  if (!prisma) return
  try {
    await prisma.researchRun.upsert({
      where: { id: run.view.id },
      create: {
        id: run.view.id, userId: run.userId, conversationId: run.view.conversationId,
        query: run.view.query, status: run.view.status,
        events: run.view.events as any, report: run.view.report ?? null,
        sources: (run.view.sources ?? null) as any,
      },
      update: {
        status: run.view.status, events: run.view.events as any,
        report: run.view.report ?? null, sources: (run.view.sources ?? null) as any,
      },
    })
  } catch { /* persistence is best-effort; the live view still serves */ }
  if (final && run.persistTimer) { clearTimeout(run.persistTimer); run.persistTimer = undefined }
}

function schedulePersist(run: Live) {
  if (run.persistTimer) return
  run.persistTimer = setTimeout(() => { run.persistTimer = undefined; void persist(run) }, 400)
}

export function startRun(opts: { userId: string; conversationId: string; query: string }): {
  runId: string
  emit: (event: AgentEvent) => void
  signal: AbortSignal
  complete: (result: { report: string; sources: Array<{ index: number; title: string; url: string }> }) => void
  fail: () => void
} {
  const id = randomUUID()
  const run: Live = {
    userId: opts.userId,
    listeners: new Set(),
    controller: new AbortController(),
    view: {
      id, conversationId: opts.conversationId, query: opts.query,
      status: 'running', events: [], createdAt: new Date().toISOString(),
    },
  }
  live.set(id, run)

  return {
    runId: id,
    signal: run.controller.signal,
    emit(event) {
      if (run.view.events.length >= MAX_EVENTS) run.view.events.shift()
      run.view.events.push(event)
      for (const listener of run.listeners) { try { listener(event) } catch { /* listener gone */ } }
      schedulePersist(run)
    },
    complete(result) {
      run.view.status = 'completed'
      run.view.report = result.report
      run.view.sources = result.sources
      for (const listener of run.listeners) { try { listener({ type: 'done' }) } catch { /* ignore */ } }
      void persist(run, true)
    },
    fail() {
      run.view.status = 'failed'
      void persist(run, true)
    },
  }
}

export function subscribe(runId: string, listener: (event: AgentEvent) => void): () => void {
  const run = live.get(runId)
  if (!run) return () => {}
  run.listeners.add(listener)
  // Replay what has already happened so a late/reconnecting client catches up.
  for (const event of run.view.events) { try { listener(event) } catch { /* ignore */ } }
  return () => run.listeners.delete(listener)
}

/** Live view first, then persisted. Scoped to the owner. */
export async function getRun(runId: string, userId: string): Promise<ResearchRunView | undefined> {
  const inMemory = live.get(runId)
  if (inMemory && inMemory.userId === userId) return inMemory.view
  if (!prisma) return undefined
  try {
    const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } })
    if (!row) return undefined
    return {
      id: row.id, conversationId: row.conversationId, query: row.query,
      status: row.status as ResearchRunView['status'], events: (row.events as any) || [],
      report: row.report ?? undefined, sources: (row.sources as any) ?? undefined,
      createdAt: row.createdAt.toISOString(),
    }
  } catch { return undefined }
}

export async function listRuns(userId: string, conversationId: string, limit = 10): Promise<ResearchRunView[]> {
  const merged = new Map<string, ResearchRunView>()
  for (const run of live.values()) if (run.userId === userId && run.view.conversationId === conversationId) merged.set(run.view.id, run.view)
  if (prisma) {
    try {
      const rows = await prisma.researchRun.findMany({ where: { userId, conversationId }, orderBy: { createdAt: 'desc' }, take: limit })
      for (const row of rows) if (!merged.has(row.id)) merged.set(row.id, {
        id: row.id, conversationId: row.conversationId, query: row.query,
        status: row.status as ResearchRunView['status'], events: (row.events as any) || [],
        report: row.report ?? undefined, sources: (row.sources as any) ?? undefined,
        createdAt: row.createdAt.toISOString(),
      })
    } catch { /* ignore */ }
  }
  return [...merged.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit)
}
