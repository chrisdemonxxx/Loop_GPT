import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The caller is a legitimate editor/owner of workspace ws-attacker and tries to
// act on project p-victim, which belongs to ws-victim.
const fx = vi.hoisted(() => {
  const projects = [{ id: 'p-victim', workspaceId: 'ws-victim' }, { id: 'p-own', workspaceId: 'ws-attacker' }]
  const match = (where: any) => projects.filter((p) => p.id === where.id && p.workspaceId === where.workspaceId)
  return {
    projects,
    db: {
      project: {
        findFirst: vi.fn(async ({ where }: any) => match(where)[0] ?? null),
        updateMany: vi.fn(async ({ where }: any) => ({ count: match(where).length })),
        deleteMany: vi.fn(async ({ where }: any) => ({ count: match(where).length })),
      },
      knowledgeChunk: { create: vi.fn(async () => ({ id: 'chunk' })), deleteMany: vi.fn(async () => ({ count: 0 })), findMany: vi.fn(async () => []) },
      workspaceAuditEvent: { create: vi.fn(async () => ({})) },
      projectBot: { findMany: vi.fn(async () => []) },
    },
    embed: vi.fn(async () => [0.1, 0.2]),
    vectorSearch: vi.fn(async () => null),
    setProjectBots: vi.fn(async () => []),
    openProjectRoom: vi.fn(async () => ({})),
  }
})

vi.mock('../../services/prisma', () => ({ prisma: fx.db, hasDb: true }))
vi.mock('../../services/workspaces', () => ({ requireMembership: vi.fn(async () => ({ role: 'owner' })) }))
vi.mock('../auth', () => ({ authenticateToken: (req: any, _res: any, next: any) => { req.userId = 'attacker'; next() } }))
vi.mock('../../services/embeddingStore', () => ({ generateEmbedding: fx.embed }))
vi.mock('../../services/vectorSearch', () => ({ indexEmbedding: vi.fn(async () => {}), vectorSearch: fx.vectorSearch }))
vi.mock('../../services/bots', () => ({
  BotError: class extends Error { code = 'invalid' },
  setProjectBots: fx.setProjectBots,
  openProjectRoom: fx.openProjectRoom,
}))

import { projectRouter, projectInWorkspace } from '../projects'

let server: Server, base: string
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/workspaces', projectRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { vi.clearAllMocks() })

function call(method: string, path: string, body?: unknown) {
  return fetch(`${base}/api/workspaces${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('projectInWorkspace', () => {
  it('matches only when the project belongs to the workspace', async () => {
    expect(await projectInWorkspace('p-victim', 'ws-victim')).toBe(true)
    expect(await projectInWorkspace('p-victim', 'ws-attacker')).toBe(false)
    expect(await projectInWorkspace('', 'ws-attacker')).toBe(false)
    expect(await projectInWorkspace(undefined as any, 'ws-attacker')).toBe(false)
  })
})

describe('cross-workspace project access (IDOR)', () => {
  it('cannot rename another workspace\'s project', async () => {
    const res = await call('PATCH', '/ws-attacker/projects/p-victim', { name: 'pwned' })
    expect(res.status).toBe(404)
    expect(fx.db.project.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p-victim', workspaceId: 'ws-attacker' } }))
  })
  it('cannot delete another workspace\'s project or its knowledge', async () => {
    expect((await call('DELETE', '/ws-attacker/projects/p-victim')).status).toBe(404)
    expect(fx.db.project.deleteMany).not.toHaveBeenCalled()
    expect(fx.db.knowledgeChunk.deleteMany).not.toHaveBeenCalled()
  })
  it('cannot ingest text into another workspace\'s project', async () => {
    expect((await call('POST', '/ws-attacker/projects/p-victim/ingest', { text: 'poisoned knowledge' })).status).toBe(404)
    expect(fx.db.knowledgeChunk.create).not.toHaveBeenCalled()
    expect(fx.embed).not.toHaveBeenCalled()
  })
  it('cannot upload a document into another workspace\'s project', async () => {
    const form = new FormData()
    form.append('file', new Blob(['hello']), 'note.txt')
    const res = await fetch(`${base}/api/workspaces/ws-attacker/projects/p-victim/ingest-file`, { method: 'POST', body: form })
    expect(res.status).toBe(404)
    expect(fx.db.knowledgeChunk.create).not.toHaveBeenCalled()
  })
  it('cannot search another workspace\'s knowledge', async () => {
    expect((await call('GET', '/ws-attacker/projects/p-victim/search?q=secret')).status).toBe(404)
    expect(fx.vectorSearch).not.toHaveBeenCalled()
    expect(fx.db.knowledgeChunk.findMany).not.toHaveBeenCalled()
  })
  it.each([['GET', '/bots'], ['PUT', '/bots'], ['POST', '/room']])('cannot reach %s %s on another workspace\'s project', async (method, suffix) => {
    const res = await call(method, `/ws-attacker/projects/p-victim${suffix}`, method === 'GET' ? undefined : { botIds: [] })
    expect(res.status).toBe(404)
    expect(fx.setProjectBots).not.toHaveBeenCalled()
    expect(fx.openProjectRoom).not.toHaveBeenCalled()
  })
  it('still serves the caller\'s own project', async () => {
    expect((await call('PATCH', '/ws-attacker/projects/p-own', { name: 'renamed' })).status).toBe(200)
    expect((await call('GET', '/ws-attacker/projects/p-own/search?q=hello')).status).toBe(200)
    expect(fx.vectorSearch).toHaveBeenCalledWith('p-own', expect.any(Array), 5)
  })
})
