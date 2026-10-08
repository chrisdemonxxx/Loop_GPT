import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintLoopitIdentityToken } from '../../services/loopitIdentity'

const config = {
  secret: 'context-test-identity-secret-at-least-32',
  kid: 'context-kid',
  issuer: 'loopit-gateway',
  audience: 'loopit-control-plane',
}

const searched = vi.hoisted(() => ({ projects: [] as string[] }))

const db = vi.hoisted(() => {
  const projects = [
    { id: 'proj-a', workspaceId: 'ws-a', updatedAt: new Date('2026-01-02T00:00:00Z') },
    { id: 'proj-b', workspaceId: 'ws-b', updatedAt: new Date('2026-01-03T00:00:00Z') },
  ]
  const files = [
    { id: 'file-a', name: 'a.txt', mimeType: 'text/plain', size: 4, purpose: 'upload', conversationId: 'conv-a', workspaceId: 'ws-a', deletedAt: null, createdAt: new Date('2026-01-02T00:00:00Z') },
    { id: 'file-b', name: 'b.txt', mimeType: 'text/plain', size: 4, purpose: 'upload', conversationId: 'conv-b', workspaceId: 'ws-b', deletedAt: null, createdAt: new Date('2026-01-03T00:00:00Z') },
    { id: 'file-gone', name: 'gone.txt', mimeType: 'text/plain', size: 1, purpose: 'upload', conversationId: 'conv-a', workspaceId: 'ws-a', deletedAt: new Date('2026-01-04T00:00:00Z'), createdAt: new Date('2026-01-01T00:00:00Z') },
  ]
  const memories = [
    { id: 'mem-a', projectId: 'proj-a', workspaceId: 'ws-a', kind: 'explicit', source: 'user', content: 'alpha memory', tags: ['a'], createdAt: new Date('2026-01-02T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z') },
    { id: 'mem-b', projectId: 'proj-b', workspaceId: 'ws-b', kind: 'explicit', source: 'user', content: 'beta memory', tags: ['b'], createdAt: new Date('2026-01-03T00:00:00Z'), updatedAt: new Date('2026-01-03T00:00:00Z') },
  ]
  const writes = vi.fn()
  const client = {
    project: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string; id?: string } }) =>
        projects.filter((project) => project.workspaceId === where.workspaceId && (!where.id || project.id === where.id))),
      create: vi.fn(() => { writes(); throw new Error('write') }),
      update: vi.fn(() => { writes(); throw new Error('write') }),
      delete: vi.fn(() => { writes(); throw new Error('write') }),
    },
    privateFile: {
      findMany: vi.fn(async ({ where }: { where?: { deletedAt?: null; conversation?: { workspaceId?: string } } }) => {
        const workspaceId = where?.conversation?.workspaceId
        return files.filter((file) => {
          if (where?.deletedAt === null && file.deletedAt) return false
          if (!workspaceId) return true
          return file.workspaceId === workspaceId
        })
      }),
      create: vi.fn(() => { writes(); throw new Error('write') }),
      update: vi.fn(() => { writes(); throw new Error('write') }),
      delete: vi.fn(() => { writes(); throw new Error('write') }),
    },
    memory: {
      findMany: vi.fn(async ({ where }: { where?: { project?: { workspaceId?: string; id?: string } } }) => {
        const workspaceId = where?.project?.workspaceId
        const projectId = where?.project?.id
        return memories.filter((memory) => {
          if (!workspaceId) return true
          return memory.workspaceId === workspaceId && (!projectId || memory.projectId === projectId)
        })
      }),
      create: vi.fn(() => { writes(); throw new Error('write') }),
      update: vi.fn(() => { writes(); throw new Error('write') }),
      delete: vi.fn(() => { writes(); throw new Error('write') }),
    },
    knowledgeChunk: {
      findMany: vi.fn(async () => []),
      create: vi.fn(() => { writes(); throw new Error('write') }),
      update: vi.fn(() => { writes(); throw new Error('write') }),
    },
  }
  return { client, writes }
})

vi.mock('../../services/prisma', () => ({
  get prisma() { return db.client },
  get hasDb() { return true },
}))

vi.mock('../../services/embeddingStore', () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3]),
}))

vi.mock('../../services/vectorSearch', () => ({
  vectorSearch: vi.fn(async (projectId: string) => {
    searched.projects.push(projectId)
    if (projectId === 'proj-a') return [{ id: 'chunk-a', content: 'alpha knowledge', score: 0.91 }]
    if (projectId === 'proj-b') return [{ id: 'chunk-b', content: 'beta knowledge', score: 0.88 }]
    return []
  }),
}))

import loopitRoutes from '../loopit'

let server: Server
let base: string

beforeAll(async () => {
  process.env.LOOPIT_IDENTITY_SECRET = config.secret
  process.env.LOOPIT_IDENTITY_KID = config.kid
  delete process.env.LOOPIT_IDENTITY_ISSUER
  delete process.env.LOOPIT_IDENTITY_AUDIENCE
  const app = express()
  app.use(express.json())
  app.use('/api/loopit', loopitRoutes)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  searched.projects.length = 0
  db.writes.mockClear()
})

function token(org: string, now = Math.floor(Date.now() / 1000)): string {
  return mintLoopitIdentityToken({ subject: 'user-1', orgId: org, role: 'member', now, config })
}

function context(org: string, query = ''): Promise<Response> {
  return fetch(`${base}/api/loopit/context${query}`, { headers: { authorization: `Bearer ${token(org)}` } })
}

describe('GET /api/loopit/context', () => {
  it('returns only the token workspace knowledge, files, and memories', async () => {
    const res = await context('ws-a', '?q=alpha')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workspaceId).toBe('ws-a')
    expect(body.knowledge.results.map((hit: { id: string }) => hit.id)).toEqual(['chunk-a'])
    expect(body.knowledge.results[0].content).toBe('alpha knowledge')
    expect(body.files.map((file: { id: string }) => file.id)).toEqual(['file-a'])
    expect(body.memories.map((memory: { id: string }) => memory.id)).toEqual(['mem-a'])
    expect(JSON.stringify(body)).not.toContain('beta')
    expect(JSON.stringify(body)).not.toContain('file-b')
    expect(JSON.stringify(body)).not.toContain('mem-b')
    expect(searched.projects).toEqual(['proj-a'])
    expect(db.writes).not.toHaveBeenCalled()
  })

  it('a token for workspace A never reads workspace B', async () => {
    const other = await context('ws-b', '?q=beta')
    expect(other.status).toBe(200)
    const body = await other.json()
    expect(body.workspaceId).toBe('ws-b')
    expect(body.knowledge.results.map((hit: { content: string }) => hit.content)).toEqual(['beta knowledge'])
    expect(body.files.map((file: { id: string }) => file.id)).toEqual(['file-b'])
    expect(body.memories.map((memory: { content: string }) => memory.content)).toEqual(['beta memory'])
    expect(JSON.stringify(body)).not.toContain('alpha')
    expect(searched.projects).toEqual(['proj-b'])

    searched.projects.length = 0
    const crossed = await context('ws-a', '?q=beta&projectId=proj-b')
    expect(crossed.status).toBe(404)
    expect(searched.projects).toEqual([])
    expect(db.writes).not.toHaveBeenCalled()
  })

  it('rejects a missing, expired, or resigned token and has no write route', async () => {
    expect((await fetch(`${base}/api/loopit/context`)).status).toBe(401)
    const expired = await fetch(`${base}/api/loopit/context?q=alpha`, {
      headers: { authorization: `Bearer ${token('ws-a', 1_600_000_000)}` },
    })
    expect(expired.status).toBe(401)
    const [header, payload] = token('ws-a').split('.')
    const forged = await fetch(`${base}/api/loopit/context?q=alpha`, {
      headers: { authorization: `Bearer ${header}.${payload}.not-a-signature` },
    })
    expect(forged.status).toBe(401)
    expect((await fetch(`${base}/api/loopit/context`, { method: 'POST', headers: { authorization: `Bearer ${token('ws-a')}` } })).status).toBe(404)
    expect(searched.projects).toEqual([])
  })
})
