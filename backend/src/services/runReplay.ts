/**
 * Durable run replay store (audit §8-30: stream auto-resume on disconnect).
 *
 * Agent runs outlive their HTTP response: every emitted event is sequenced
 * and buffered per run, so a client whose SSE connection dropped mid-turn
 * can GET /api/agent/:cid/runs/:runId/events?after=<lastSeq> to replay the
 * missed events and re-attach to the live stream — instead of manually
 * re-sending the message (double model charge, duplicated turn).
 *
 * In-memory by design (same lifetime contract as the approval store): runs
 * are live process state; a server restart kills runs anyway, so a buffer
 * that lives with the process is exactly as durable as the runs it tracks.
 * Bounded: per-run event/byte caps (overflow degrades resumability, not the
 * run), a global entry cap with LRU eviction of finished runs, and a TTL
 * sweeper for finished runs.
 */
import type { AgentEvent } from '../agent/types'

export interface ReplayRun {
  runId: string
  userId: string
  conversationId: string
  createdAt: number
  /** Monotonic per-run event sequence (0-based). */
  seq: number
  events: Array<AgentEvent & { seq: number }>
  /** Byte budget guard against runaway delta streams. */
  bytes: number
  /** Set when the event/byte cap overflowed: the run continues, resume
   *  is refused (the client falls back to a transcript refresh). */
  truncated: boolean
  done: boolean
  signal: AbortController
  /** Live re-attached listeners (resumed clients). */
  listeners: Set<(event: AgentEvent & { seq: number }) => void>
}

const MAX_RUNS = 200
const MAX_EVENTS_PER_RUN = 5_000
const MAX_BYTES_PER_RUN = 2_000_000
/** Finished runs stay replayable for this long. */
const FINISHED_TTL_MS = 10 * 60_000
/** Safety ceiling for a single run's total lifetime (stuck runs). */
const MAX_RUN_LIFETIME_MS = 30 * 60_000
const SWEEP_INTERVAL_MS = 60_000

const runs = new Map<string, ReplayRun>()

if (process.env.NODE_ENV !== 'test') {
  const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS)
  // Don't hold the process open just for the sweeper.
  ;(sweeper as any).unref?.()
}

function sweep() {
  const now = Date.now()
  for (const [id, run] of runs) {
    const age = now - run.createdAt
    if ((run.done && age > FINISHED_TTL_MS) || age > MAX_RUN_LIFETIME_MS) {
      if (!run.done) run.signal.abort()
      runs.delete(id)
    }
  }
  // Global cap: evict the oldest FINISHED runs first.
  while (runs.size > MAX_RUNS) {
    let oldestDone: string | null = null
    let oldestDoneAt = Infinity
    for (const [id, run] of runs) {
      if (run.done && run.createdAt < oldestDoneAt) { oldestDoneAt = run.createdAt; oldestDone = id }
    }
    if (!oldestDone) break
    runs.delete(oldestDone)
  }
}

export function createRun(input: { runId: string; userId: string; conversationId: string; controller?: AbortController }): ReplayRun {
  const run: ReplayRun = {
    runId: input.runId,
    userId: input.userId,
    conversationId: input.conversationId,
    createdAt: Date.now(),
    seq: 0,
    events: [],
    bytes: 0,
    truncated: false,
    done: false,
    // Shared with the request lifecycle by default: an explicit cancel keeps
    // the run's user-stop semantics (the controller's disconnect checks all
    // observe the same signal).
    signal: input.controller ?? new AbortController(),
    listeners: new Set(),
  }
  runs.set(input.runId, run)
  return run
}

/** Append + sequence an event, broadcasting to attached listeners.
 *  Returns the sequenced event (also what listeners receive). */
export function appendEvent(run: ReplayRun, event: AgentEvent): AgentEvent & { seq: number } {
  const sequenced = { ...event, seq: run.seq } as AgentEvent & { seq: number }
  run.seq += 1
  if (!run.truncated) {
    if (run.events.length >= MAX_EVENTS_PER_RUN || run.bytes >= MAX_BYTES_PER_RUN) {
      // Overflow: keep the run alive, refuse further resume attempts.
      run.truncated = true
      run.events = []
    } else {
      run.events.push(sequenced)
      run.bytes += JSON.stringify(sequenced).length
    }
  }
  for (const listener of run.listeners) {
    try { listener(sequenced) } catch { /* a dead listener detaches via its own close handler */ }
  }
  return sequenced
}

/** Find a run for an ownership-checked replay/attach/cancel. */
export function findRun(runId: string, userId: string, conversationId: string): ReplayRun | null {
  const run = runs.get(runId)
  if (!run) return null
  if (run.userId !== userId || run.conversationId !== conversationId) return null
  return run
}

/** Replay buffered events after `afterSeq`, then attach live if unfinished.
 *  Returns the detach function (called from the response's close handler). */
export function attach(run: ReplayRun, afterSeq: number, onEvent: (event: AgentEvent & { seq: number }) => void): { replay: Array<AgentEvent & { seq: number }>; live: boolean; detach: () => void } {
  const replay = run.events.filter((e) => e.seq > afterSeq)
  if (run.truncated && afterSeq < 0) {
    // Cannot reconstruct from the start (buffer overflow dropped it); the
    // caller reports non-resumable.
    return { replay: [], live: false, detach: () => {} }
  }
  if (run.done) return { replay, live: false, detach: () => {} }
  run.listeners.add(onEvent)
  return { replay, live: true, detach: () => { run.listeners.delete(onEvent) } }
}

/** Mark the run finished: stop buffering and let attached listeners drain.
 *  The caller sends its own terminal event(s) through appendEvent first. */
export function finishRun(run: ReplayRun) {
  run.done = true
  run.listeners.clear()
}

/** Explicit cancel (the stop button): aborts the still-running durable run. */
export function cancelRun(run: ReplayRun): boolean {
  if (run.done) return false
  run.signal.abort()
  return true
}

/** Test hook: drop all state. */
export function resetRunsForTest() {
  runs.clear()
}
