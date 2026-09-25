import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { randomUUID } from 'crypto'

export interface LoggedRequest {
  requestId: string
  timestamp: number
  method: string
  path: string
  status?: number
  durationMs?: number
  userId?: string
  finished: boolean
}

const RING_LIMIT = 1000
const ring: LoggedRequest[] = []

/** Test-only: reset the shared ring so unit tests are order-independent. */
export function _resetRingForTests(): void {
  ring.length = 0
}

/** Bounded tail of recent requests; admin-only projection, no bodies/headers. */
export function recentRequests(limit = 100): LoggedRequest[] {
  const bounded = Math.max(1, Math.min(Number(limit) || 100, RING_LIMIT))
  return ring.slice(-bounded)
}

export function activeStreamCount(): number {
  return ring.filter((entry) => !entry.finished).length
}

/**
 * Per-request structured logging. One JSON line per completed request
 * (SSE included: 'finish' fires at stream close, so agent-turn duration is
 * visible — the observability gap found in live testing). Never logs
 * headers, bodies, query strings, tokens, or exception details; paths are
 * bounded and query-stripped.
 */
export function requestLog(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const entry: LoggedRequest = {
      requestId: randomUUID(),
      timestamp: Date.now(),
      method: req.method,
      path: (req.originalUrl || req.url || '').split('?')[0].slice(0, 200),
      userId: (req as any).userId,
      finished: false,
    }
    ring.push(entry)
    if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT)
    const startedAt = entry.timestamp
    res.on('finish', () => {
      entry.finished = true
      entry.status = res.statusCode
      entry.durationMs = Date.now() - startedAt
      console.log(JSON.stringify({
        type: 'request',
        requestId: entry.requestId,
        timestamp: entry.timestamp,
        method: entry.method,
        path: entry.path,
        status: entry.status,
        durationMs: entry.durationMs,
        userId: entry.userId,
      }))
    })
    next()
  }
}

/** Percentile helper over completed durations in the ring. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

export interface MetricsSummary {
  windowSeconds: number
  sampleCount: number
  errorRate: number
  p50: number
  p95: number
  p99: number
  activeStreams: number
  slowestPaths: Array<{ path: string; count: number; maxMs: number }>
}

export function metricsSummary(windowSeconds = 3600): MetricsSummary {
  const bounded = Math.max(1, Math.min(Number(windowSeconds) || 3600, 86400))
  const cutoff = Date.now() - bounded * 1000
  const recent = ring.filter((entry) => entry.finished && entry.timestamp >= cutoff && Number.isFinite(entry.durationMs))
  const durations = recent.map((entry) => entry.durationMs!).sort((a, b) => a - b)
  const errors = recent.filter((entry) => (entry.status ?? 0) >= 400).length
  const byPath = new Map<string, { count: number; maxMs: number }>()
  for (const entry of recent) {
    const current = byPath.get(entry.path) ?? { count: 0, maxMs: 0 }
    current.count += 1
    current.maxMs = Math.max(current.maxMs, entry.durationMs!)
    byPath.set(entry.path, current)
  }
  const slowestPaths = [...byPath.entries()]
    .map(([path, { count, maxMs }]) => ({ path, count, maxMs }))
    .sort((a, b) => b.maxMs - a.maxMs)
    .slice(0, 10)
  return {
    windowSeconds: bounded,
    sampleCount: recent.length,
    errorRate: recent.length ? errors / recent.length : 0,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    activeStreams: activeStreamCount(),
    slowestPaths,
  }
}
