/**
 * GET /ready — deploy readiness: the database answers and private file storage
 * accepts writes. /health stays a pure liveness probe. Failures report which
 * dependency is down, never why.
 */
import type { Request, Response } from 'express'
import { prisma } from '../services/prisma'
import { checkPrivateStorageReadiness } from '../services/privateStorage'

export interface ReadinessDeps {
  database: () => Promise<unknown>
  storage: () => Promise<unknown>
  timeoutMs?: number
}

const defaultDeps: ReadinessDeps = {
  database: async () => {
    if (!prisma) throw new Error('no database')
    await prisma.$queryRaw`SELECT 1`
  },
  storage: () => checkPrivateStorageReadiness(),
}

function withTimeout(check: () => Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    check().then(() => resolve(true), () => resolve(false)).finally(() => clearTimeout(timer))
  })
}

export function readinessHandler(deps: ReadinessDeps = defaultDeps) {
  return async (_req: Request, res: Response) => {
    const ms = deps.timeoutMs ?? 5000
    const [database, storage] = await Promise.all([withTimeout(deps.database, ms), withTimeout(deps.storage, ms)])
    res.setHeader('Cache-Control', 'no-store')
    res.status(database && storage ? 200 : 503).json({
      status: database && storage ? 'ready' : 'unavailable',
      checks: { database: database ? 'ok' : 'fail', storage: storage ? 'ok' : 'fail' },
    })
  }
}
