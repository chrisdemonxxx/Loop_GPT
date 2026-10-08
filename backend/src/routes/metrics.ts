import type { Request, Response } from 'express'
import { timingSafeEqual } from 'crypto'
import { prisma } from '../services/prisma'
import { renderPrometheus, type OpsGauges } from '../middleware/opsMetrics'

const STALE_AFTER_MS = 10 * 60 * 1000

function tokenMatches(supplied: string | undefined, expected: string): boolean {
  if (!supplied) return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function metricsAuthorized(req: Request): boolean {
  const expected = process.env.METRICS_TOKEN
  if (!expected) return process.env.NODE_ENV !== 'production'
  const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
  const bearer = /^Bearer (.+)$/i.exec(header)?.[1]
  const alt = req.headers['x-metrics-token']
  const presented = bearer || (typeof alt === 'string' ? alt : undefined)
  return tokenMatches(presented, expected)
}

async function settlementCounts(table: 'DailySettlementIntent' | 'ApiSettlementIntent', staleBefore: Date): Promise<{ pending: number; stale: number }> {
  if (!prisma) return { pending: 0, stale: 0 }
  const rows = await prisma.$queryRawUnsafe<Array<{ pending: number; stale: number }>>(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS pending,
       COUNT(*) FILTER (WHERE status IN ('pending', 'processing') AND "updatedAt" < $1)::int AS stale
     FROM "${table}"`,
    staleBefore,
  )
  const row = rows[0]
  return { pending: Number(row?.pending) || 0, stale: Number(row?.stale) || 0 }
}

async function gauges(): Promise<OpsGauges> {
  const empty: OpsGauges = { dbUp: 0, dailyPending: 0, apiPending: 0, dailyStale: 0, apiStale: 0 }
  if (!prisma) return empty
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    return empty
  }
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS)
  const next = { ...empty, dbUp: 1 }
  try {
    const daily = await settlementCounts('DailySettlementIntent', staleBefore)
    next.dailyPending = daily.pending
    next.dailyStale = daily.stale
  } catch { /* schema not ready; db_up still reports the connection */ }
  try {
    const api = await settlementCounts('ApiSettlementIntent', staleBefore)
    next.apiPending = api.pending
    next.apiStale = api.stale
  } catch { /* same as daily */ }
  return next
}

/** GET /metrics — Prometheus text. Production requires METRICS_TOKEN. */
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  if (!metricsAuthorized(req)) {
    const status = process.env.METRICS_TOKEN || process.env.NODE_ENV === 'production' ? 401 : 404
    res.status(status).json({ error: status === 401 ? 'Unauthorized' : 'Not found' })
    return
  }
  const body = renderPrometheus(await gauges())
  res.status(200).set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').set('Cache-Control', 'no-store').send(body)
}
