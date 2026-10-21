import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../auth', () => ({
  authenticateToken: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    ;(req as express.Request & { user?: { id: string } }).user = { id: 'user-1' }
    next()
  },
}))

import { buildGithubSyncRouter } from '../buildGithubSync'

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use('/api/loopit/github-sync', buildGithubSyncRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
})

describe('buildGithubSync stub', () => {
  it('returns stub mode when GitHub OAuth is not configured', async () => {
    const res = await fetch(`${base}/api/loopit/github-sync/connect?projectId=proj_1`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.mode).toBe('stub')
    expect(body.authorizeUrl).toBeNull()
    expect((body.docs as { env: string[] }).env).toContain('LOOPIT_GITHUB_TOKEN')
    expect(body.projectId).toBe('proj_1')
  })

  it('returns live authorize URL when GITHUB_CLIENT_ID is set', async () => {
    process.env.GITHUB_CLIENT_ID = 'gh-client'
    const res = await fetch(`${base}/api/loopit/github-sync/connect?projectId=proj_1&workspaceId=ws_1`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.mode).toBe('live')
    expect(String(body.authorizeUrl)).toContain('/api/oauth-connector/init')
    expect(String(body.authorizeUrl)).toContain('type=github')
  })
})
