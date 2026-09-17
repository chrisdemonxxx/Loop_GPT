import { randomUUID } from 'crypto'
import type { Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
const remote = vi.hoisted(() => ({ request: vi.fn(), sent: vi.fn(), before: vi.fn(), after: vi.fn(), turn: vi.fn() }))
vi.mock('../publicHttp', async (original) => ({ ...await original<typeof import('../publicHttp')>(), publicRequest: remote.request }))
vi.mock('../../agent/llmClient', () => ({ createClient: () => ({}), resolveModel: () => 'test-model', isOpenAICompatible: () => true, streamTurn: remote.turn }))
import { prisma } from '../prisma'
import { createWorkspace } from '../workspaces'
import { saveConnection, deleteConnection } from '../workspaceConnections'
import { workspaceConnectionTools } from '../workspaceTools'
import { authorizeRunContext } from '../../agent/runAuthorization'
import { toolRegistry } from '../../agent/toolRegistry'
import { connectionToolName } from '../../agent/connectors/reviewedAdapters'
import type { ToolContext } from '../../agent/types'
import workspaceRouter from '../../routes/workspaces'
import agentRouter from '../../routes/agent'

const db = prisma!
const prefix = `adapters-${randomUUID()}`
const workspaceIds = new Set<string>()
let alice: string, bob: string, viewer: string
let previousKey: string | undefined, server: Server, base: string
let providerBody: unknown
const input = (type: string, token: string, enabled = true) => ({ type, name: 'Adapter fixture', config: { token }, enabled })

async function fixture(type = 'notion', role: 'owner' | 'editor' | 'viewer' = 'owner') {
  const workspace = await createWorkspace(alice, 'Connector fixture'); workspaceIds.add(workspace.id)
  const userId = role === 'owner' ? alice : role === 'editor' ? bob : viewer
  if (role !== 'owner') await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId, role } })
  const conversation = await db.conversation.create({ data: { userId, workspaceId: workspace.id, title: 'Adapter test' } })
  const token = `${prefix}-secret-${randomUUID()}`
  const connection = await saveConnection(alice, workspace.id, input(type, token))
  const events: any[] = []
  const ctx: ToolContext = { userId, conversationId: conversation.id, scratch: {}, emit: (event) => events.push(event) }
  return { workspaceId: workspace.id, conversationId: conversation.id, userId, connection, token, ctx, events }
}
async function granted(f: Awaited<ReturnType<typeof fixture>>) {
  const tools = await workspaceConnectionTools(f.userId, f.workspaceId, [f.connection.id])
  return { tools, ctx: await authorizeRunContext(f.ctx, f.workspaceId, tools) }
}
async function execute(f: Awaited<ReturnType<typeof fixture>>, ctx: ToolContext) {
  return toolRegistry.execute(connectionToolName(f.connection.id), { query: 'Roadmap' }, ctx)
}
async function request(path: string, userId: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) })
}

beforeAll(async () => {
  previousKey = process.env.CONNECTION_ENCRYPTION_KEY
  process.env.CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64')
  alice = `${prefix}-alice`; bob = `${prefix}-bob`; viewer = `${prefix}-viewer`
  await db.user.createMany({ data: [alice, bob, viewer].map((id) => ({ id, email: `${id}@example.test`, name: 'Fixture', password: 'fixture-only', credits: 500 })) })
  const app = express(); app.use(express.json())
  app.use('/api/workspaces', workspaceRouter)
  app.use('/api/agent', agentRouter); app.use('/api/conversations', agentRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(() => {
  providerBody = undefined
  remote.sent.mockReset(); remote.before.mockReset().mockResolvedValue(undefined); remote.after.mockReset().mockResolvedValue(undefined)
  remote.turn.mockReset().mockResolvedValue({ content: 'Completed', toolCalls: [] })
  remote.request.mockReset().mockImplementation(async (url, options) => {
    await remote.before()
    await options.beforeConnect()
    remote.sent(url, options)
    await remote.after()
    const body = providerBody ?? (url.startsWith('https://api.notion.com')
      ? { results: [{ id: 'page-id', object: 'page', properties: { Name: { type: 'title', title: [{ plain_text: 'Roadmap' }] } }, url: 'https://www.notion.so/page' }], has_more: false }
      : [{ id: 42, name: 'Roadmap', path_with_namespace: 'team/roadmap', web_url: 'https://gitlab.com/team/roadmap' }])
    return { body: Buffer.from(JSON.stringify(body)), headers: {}, status: 200, url }
  })
})
afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()) })
    await db.conversation.deleteMany({ where: { userId: { in: [alice, bob, viewer] } } })
    await db.workspace.deleteMany({ where: { id: { in: [...workspaceIds] } } })
    await db.user.deleteMany({ where: { id: { in: [alice, bob, viewer] } } })
  } finally {
    if (previousKey === undefined) delete process.env.CONNECTION_ENCRYPTION_KEY; else process.env.CONNECTION_ENCRYPTION_KEY = previousKey
    await db.$disconnect()
  }
})

describe('workspace-scoped read-only adapters (mocked provider transport)', () => {
  it('discovers metadata without decrypting credentials', async () => {
    const f = await fixture(); const key = process.env.CONNECTION_ENCRYPTION_KEY
    delete process.env.CONNECTION_ENCRYPTION_KEY
    try {
      const response = await request(`/api/workspaces/${f.workspaceId}/connections/${f.connection.id}/tools`, alice)
      expect(response.status).toBe(200)
      const text = await response.text()
      expect(text).not.toContain(f.token)
      expect(text).not.toContain('encryptedConfig')
      expect(JSON.parse(text).tools[0]).toMatchObject({ name: connectionToolName(f.connection.id), readOnly: true })
      const { ctx } = await granted(f)
      expect((await execute(f, ctx)).isError).toBe(true)
      expect(remote.request).not.toHaveBeenCalled()
    } finally { process.env.CONNECTION_ENCRYPTION_KEY = key }
  })

  it('denies foreign workspace IDs, foreign connections, and viewers', async () => {
    const a = await fixture(); const b = await fixture(); const v = await fixture('notion', 'viewer')
    expect((await request(`/api/workspaces/${a.workspaceId}/connections/${a.connection.id}/tools`, bob)).status).toBe(404)
    await expect(workspaceConnectionTools(alice, a.workspaceId, [b.connection.id])).rejects.toMatchObject({ status: 404 })
    await expect(granted(v)).rejects.toMatchObject({ status: 403 })
    const tools = await workspaceConnectionTools(alice, a.workspaceId, [a.connection.id])
    const wrongContext = await authorizeRunContext(b.ctx, b.workspaceId, tools)
    expect((await execute(a, wrongContext)).isError).toBe(true)
    expect(remote.request).not.toHaveBeenCalled()
  })

  it.each(['notion', 'gitlab'])('uses only the selected %s connection credentials', async (type) => {
    const a = await fixture(type); const b = await fixture(type)
    const { ctx } = await granted(a)
    const result = await execute(a, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Roadmap')
    const options = remote.sent.mock.calls[0][1]
    expect(JSON.stringify(options.headers)).toContain(a.token)
    expect(JSON.stringify(options.headers)).not.toContain(b.token)
    expect(result.content).not.toContain(a.token)
    expect(options.redirects).toBe(0)
  })

  it('rejects argument/header/destination overrides and forged contexts', async () => {
    const f = await fixture(); const { tools, ctx } = await granted(f)
    expect((await tools[0].handler({ query: 'q' }, f.ctx)).isError).toBe(true)
    for (const extra of [{ token: 'override' }, { headers: { Authorization: 'override' } }, { url: 'http://127.0.0.1' }, { method: 'DELETE' }]) {
      expect((await toolRegistry.execute(tools[0].name, { query: 'q', ...extra }, ctx)).isError).toBe(true)
      expect((await tools[0].handler({ query: 'q', ...extra }, ctx)).isError).toBe(true)
    }
    expect(remote.request).not.toHaveBeenCalled()
  })

  it.each(['rotate', 'disable', 'delete', 'remove-member', 'downgrade', 'change-type'])('blocks a captured grant after %s', async (change) => {
    const f = await fixture('notion', 'editor'); const { ctx } = await granted(f)
    if (change === 'delete') await deleteConnection(alice, f.workspaceId, f.connection.id)
    else if (change === 'remove-member') await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: bob } } })
    else if (change === 'downgrade') await db.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: bob } }, data: { role: 'viewer' } })
    else if (change === 'change-type') await db.workspaceConnection.update({ where: { id: f.connection.id }, data: { type: 'gitlab' } })
    else await saveConnection(alice, f.workspaceId, input('notion', `${f.token}-new`, change !== 'disable'), f.connection.id, 1)
    expect((await execute(f, ctx)).isError).toBe(true)
    expect(remote.request).not.toHaveBeenCalled()
    if (change === 'rotate') {
      expect((await execute(f, (await granted(f)).ctx)).isError).toBeFalsy()
      expect(remote.sent.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${f.token}-new`)
    }
  })

  it('rechecks connection version after DNS but before sending credentials', async () => {
    const f = await fixture(); const { ctx } = await granted(f)
    remote.before.mockImplementationOnce(async () => { await saveConnection(alice, f.workspaceId, input('notion', `${f.token}-new`), f.connection.id, 1) })
    expect((await execute(f, ctx)).isError).toBe(true)
    expect(remote.request).toHaveBeenCalledTimes(1)
    expect(remote.sent).not.toHaveBeenCalled()
  })

  it('withholds results when membership is revoked during the provider request', async () => {
    const f = await fixture('notion', 'editor'); const { ctx } = await granted(f)
    remote.after.mockImplementationOnce(async () => { await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: bob } } }) })
    const result = await execute(f, ctx)
    expect(remote.sent).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('Roadmap')
  })

  it('withholds results when the connection is disabled during the provider request', async () => {
    const f = await fixture(); const { ctx } = await granted(f)
    remote.after.mockImplementationOnce(async () => { await saveConnection(alice, f.workspaceId, input('notion', f.token, false), f.connection.id, 1) })
    const result = await execute(f, ctx)
    expect(remote.sent).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('Roadmap')
  })

  it('allows explicit toolNames to narrow an opted-in connection out of the run', async () => {
    const f = await fixture(); const name = connectionToolName(f.connection.id)
    remote.turn.mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'call-one', name, arguments: '{"query":"Roadmap"}' }] })
    const response = await request(`/api/agent/${f.conversationId}/stream`, alice, 'POST', {
      content: 'Search', mode: 'agent', connectionIds: [f.connection.id], toolNames: ['web_fetch'],
    })
    expect(response.status).toBe(200); await response.text()
    expect(remote.request).not.toHaveBeenCalled()
  })

  it('does not expose credential echoes, extra properties, or exception payloads', async () => {
    const f = await fixture(); const { ctx } = await granted(f)
    providerBody = { results: [{ id: f.token, object: 'page', title: [{ plain_text: f.token }], url: `https://www.notion.so/${f.token}`, arbitrarySecret: f.token }] }
    const result = await execute(f, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).not.toContain(f.token)
    expect(result.content).not.toContain('arbitrarySecret')
    remote.request.mockRejectedValueOnce(new Error(`provider failed: ${f.token}`))
    const failed = await execute(f, ctx)
    expect(failed.isError).toBe(true)
    expect(failed.content).not.toContain(f.token)
  })

  it.each(['notion', 'gitlab'])('executes %s through the authenticated SSE route only with explicit opt-in', async (type) => {
    const f = await fixture(type); const name = connectionToolName(f.connection.id)
    const call = () => ({ content: '', toolCalls: [{ id: 'call-one', name, arguments: '{"query":"Roadmap"}' }] })
    remote.turn.mockResolvedValueOnce(call())
    const noOptIn = await request(`/api/agent/${f.conversationId}/stream`, alice, 'POST', { content: 'Search', mode: 'agent' })
    expect(noOptIn.status).toBe(200); await noOptIn.text()
    expect(remote.sent).not.toHaveBeenCalled()
    remote.turn.mockResolvedValueOnce(call())
    const optedIn = await request(`/api/conversations/${f.conversationId}/stream`, alice, 'POST', { content: 'Search', mode: 'agent', connectionIds: [f.connection.id], toolNames: [name] })
    expect(optedIn.status).toBe(200)
    const text = await optedIn.text()
    expect(text).toContain('Roadmap'); expect(text).not.toContain(f.token)
    expect(remote.sent).toHaveBeenCalledTimes(1)
    const messages = await db.message.findMany({ where: { conversationId: f.conversationId } })
    expect(JSON.stringify(messages)).not.toContain(f.token)
  })

  it('rejects invalid selections before creating conversations or contacting providers', async () => {
    const f = await fixture(); const other = await fixture(); const unsupported = await fixture('slack')
    const before = await db.conversation.count({ where: { userId: alice } })
    const cases: Array<[any, number]> = [
      [{ connectionIds: [f.connection.id, f.connection.id] }, 400],
      [{ mode: 'chat', connectionIds: [f.connection.id] }, 400],
      [{ mode: 'research', connectionIds: [f.connection.id] }, 400],
      [{ connectionIds: Array.from({ length: 9 }, () => randomUUID()) }, 400],
      [{ toolNames: [connectionToolName(f.connection.id)] }, 400],
      [{ connectionIds: [other.connection.id] }, 404],
      [{ connectionIds: [randomUUID()] }, 404],
    ]
    for (const [body, status] of cases) expect((await request('/api/agent/new/stream', alice, 'POST', { content: 'q', mode: 'agent', workspaceId: f.workspaceId, ...body })).status).toBe(status)
    expect((await request('/api/agent/new/stream', alice, 'POST', { content: 'q', workspaceId: unsupported.workspaceId, connectionIds: [unsupported.connection.id] })).status).toBe(422)
    expect(await db.conversation.count({ where: { userId: alice } })).toBe(before)
    expect(remote.request).not.toHaveBeenCalled()
  })
})
