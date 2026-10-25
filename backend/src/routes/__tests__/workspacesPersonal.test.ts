import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Workspace rows carry BigInt wallet columns. res.json cannot serialize BigInt,
 * so the personal-workspace and create routes must answer with plain fields.
 */
const userId = 'workspace-route-user'
const row = {
  id: `personal-${userId}`, name: 'Personal', personalOwnerId: userId, loopitOrgId: null,
  walletMicros: 5n, subCreditsMicros: 7n, subCreditsExpireAt: null, plan: 'free',
  stripeCustomerId: 'cus_hidden', stripeSubId: null, createdAt: new Date('2026-01-02T03:04:05.000Z'),
}

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn(), create: vi.fn() },
}))

vi.mock('../../services/prisma', () => ({ prisma: db, hasDb: true }))
vi.mock('../auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.userId = userId; next() },
}))

let server: Server
let base: string

beforeAll(async () => {
  const workspaces = await import('../workspaces')
  const app = express()
  app.use('/api/workspaces', workspaces.default)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener')
  base = `http://127.0.0.1:${address.port}`
  db.user.findUnique.mockResolvedValue({ id: userId })
  db.workspace.findUnique.mockResolvedValue(row)
  db.workspace.create.mockResolvedValue({ ...row, id: 'team-1', name: 'Team', personalOwnerId: null })
})

afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

const post = (path: string, body: unknown) => fetch(`${base}/api/workspaces${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

describe('workspace routes with BigInt wallet columns', () => {
  it('returns the existing personal workspace', async () => {
    const res = await post('/personal', {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workspace: {
      id: row.id, name: 'Personal', personalOwnerId: userId, createdAt: row.createdAt.toISOString(),
    } })
  })

  it('returns a newly created workspace', async () => {
    const res = await post('/', { name: 'Team' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ workspace: {
      id: 'team-1', name: 'Team', personalOwnerId: null, createdAt: row.createdAt.toISOString(),
    } })
  })
})
