import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../middleware/apiAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/apiAuth')>()
  return {
    ...actual,
    authenticateTokenOrApiKey: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      (req as express.Request & { userId?: string }).userId = 'user-1'
      next()
    },
  }
})

vi.mock('../../services/workspaces', () => ({
  ensurePersonalWorkspace: vi.fn(async () => ({ id: 'ws-personal' })),
  requireMembership: vi.fn(async () => ({ role: 'owner' })),
}))

import buildV1Routes from '../buildV1'

let gateway: Server
let engine: Server
let base: string
const seen: Array<{ method: string; path: string; body: unknown }> = []

function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
    })
  })
}

beforeAll(async () => {
  // Stands in for loopit-api: it serves runs under /api/runs only.
  const upstream = express()
  upstream.use(express.json())
  upstream.post('/api/runs', (req, res) => {
    seen.push({ method: 'POST', path: req.path, body: req.body })
    res.status(201).json({ run_id: 'run_1', status: 'queued' })
  })
  upstream.get('/api/runs/:id', (req, res) => {
    seen.push({ method: 'GET', path: req.path, body: null })
    res.json({ run_id: req.params.id, status: 'running' })
  })
  upstream.use((_req, res) => { res.status(404).json({ detail: 'Not Found' }) })
  const started = await listen(upstream)
  engine = started.server
  process.env.LOOPIT_API_URL = started.url

  const app = express()
  app.use('/v1/build', buildV1Routes)
  const front = await listen(app)
  gateway = front.server
  base = front.url
})

afterAll(async () => {
  await Promise.all([gateway, engine].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  delete process.env.LOOPIT_API_URL
})

beforeEach(() => {
  seen.length = 0
  process.env.LOOPIT_IDENTITY_SECRET = 'build-v1-test-identity-secret-at-least-32'
  process.env.LOOPIT_IDENTITY_KID = 'build-v1-kid'
})

describe('/v1/build', () => {
  it('starts a run on the engine /api/runs route', async () => {
    const res = await fetch(`${base}/v1/build/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a todo app', projectId: 'proj_1' }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ run_id: 'run_1', status: 'queued' })
    expect(seen).toEqual([
      expect.objectContaining({ method: 'POST', path: '/api/runs', body: expect.objectContaining({ prompt: 'a todo app', project_id: 'proj_1' }) }),
    ])
  })

  it('reads a run from the engine /api/runs/:id route', async () => {
    const res = await fetch(`${base}/v1/build/runs/run_9`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ run_id: 'run_9', status: 'running' })
    expect(seen).toEqual([expect.objectContaining({ method: 'GET', path: '/api/runs/run_9' })])
  })
})
