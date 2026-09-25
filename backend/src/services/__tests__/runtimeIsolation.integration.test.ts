import { randomUUID } from 'crypto'
import type { Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No inference, search or remote fetch occurs. Dispatch, JWT, workspace checks,
// PostgreSQL and calculator execution are real.
const remote = vi.hoisted(() => ({ turn: vi.fn(), complete: vi.fn(), search: vi.fn(), fetch: vi.fn(), client: vi.fn(() => ({})) }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client, resolveModel: () => 'test-model',
  isOpenAICompatible: () => true, streamTurn: remote.turn, completeOnce: remote.complete }))
vi.mock('../../agent/tools/webSearch', async (original) => ({ ...await original<typeof import('../../agent/tools/webSearch')>(), searchWeb: remote.search }))
vi.mock('../../agent/tools/webFetch', async (original) => ({ ...await original<typeof import('../../agent/tools/webFetch')>(), fetchReadable: remote.fetch }))
import { prisma } from '../prisma'
import { createWorkspace, ensurePersonalWorkspace } from '../workspaces'
import { prepareRunConversation } from '../runWorkspace'
import { authorizeRunContext, assertRunAccess, restrictRunContext } from '../../agent/runAuthorization'
import { builtinTools, registerBuiltinTools } from '../../agent'
import { toolRegistry } from '../../agent/toolRegistry'
import { runAgent } from '../../agent/agentRuntime'
import { runDeepResearch } from '../../agent/research/deepResearch'
import type { ToolContext, ToolDefinition } from '../../agent/types'
import agentRouter from '../../routes/agent'
import settingsRouter from '../../routes/settings'
import * as billing from '../dailyReservations'

const db = prisma!
const prefix = `runtime-${randomUUID()}`
const workspaceIds = new Set<string>()
let alice: string, bob: string
let server: Server, base: string
const finalTurn = () => ({ content: 'Completed', toolCalls: [] })
const nativeCall = (name: string, args: unknown = {}) => ({ id: randomUUID(), name, arguments: JSON.stringify(args) })
const reviewed = (names: string[]) => builtinTools().filter((tool) => names.includes(tool.name))

async function fixture(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  const workspace = await createWorkspace(alice, 'Runtime fixture'); workspaceIds.add(workspace.id)
  const userId = role === 'owner' ? alice : bob
  if (role !== 'owner') await db.workspaceMember.create({ data: { workspaceId: workspace.id, userId, role } })
  const conversation = await db.conversation.create({ data: { userId, workspaceId: workspace.id, title: 'Run fixture' } })
  const events: any[] = []
  const ctx: ToolContext = { userId, conversationId: conversation.id, workspaceId: workspace.id, scratch: {}, emit: (event) => events.push(event) }
  return { workspaceId: workspace.id, conversationId: conversation.id, userId, ctx, events }
}
async function grant(f: Awaited<ReturnType<typeof fixture>>, names = ['calculator']) {
  return authorizeRunContext(f.ctx, f.workspaceId, reviewed(names))
}
function run(ctx: ToolContext, toolNames?: string[]) {
  return runAgent({ provider: 'huggingface', model: 'test-model', ctx, toolNames, messages: [{ role: 'user', content: 'Calculate' }] })
}
async function request(path: string, userId?: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, { method, headers: {
    ...(userId ? { Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET!)}` } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  }, body: body === undefined ? undefined : JSON.stringify(body) })
}

beforeAll(async () => {
  alice = `${prefix}-alice`; bob = `${prefix}-bob`
  await db.user.createMany({ data: [alice, bob].map((id) => ({ id, email: `${id}@example.test`, name: 'Runtime fixture', password: 'fixture-only', credits: 500 })) })
  registerBuiltinTools()
  const app = express(); app.use(express.json())
  app.use('/api/agent', agentRouter); app.use('/api/conversations', agentRouter); app.use('/api/settings', settingsRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  base = `http://127.0.0.1:${address.port}`
})
beforeEach(() => {
  remote.turn.mockReset().mockResolvedValue(finalTurn()); remote.client.mockReset().mockReturnValue({})
  remote.complete.mockReset().mockResolvedValue('[]')
  remote.search.mockReset().mockResolvedValue([]); remote.fetch.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  toolRegistry.unregisterSource('fixture')
  registerBuiltinTools()
})
afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((err) => err ? reject(err) : resolve()) })
    await db.conversation.deleteMany({ where: { userId: { in: [alice, bob] } } })
    await db.workspace.deleteMany({ where: { id: { in: [...workspaceIds] } } })
    await db.user.deleteMany({ where: { id: { in: [alice, bob] } } })
  } finally { await db.$disconnect() }
})

describe('workspace runtime authorization', () => {
  it.each(['planning', 'verification'])('cancels an in-flight research %s model call without fallback', async phase => {
    const f = await fixture()
    const controller = new AbortController()
    const ctx = await authorizeRunContext({ ...f.ctx, signal: controller.signal }, f.workspaceId, reviewed(['web_search', 'web_fetch']))
    let calls = 0
    remote.complete.mockImplementation(async (...args: any[]) => {
      expect(args[5]).toBe(controller.signal)
      calls++
      if (phase === 'planning' || calls === 2) { controller.abort(); throw new Error('cancel fixture') }
      return '["query"]'
    })
    remote.search.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ title: 'Source', url: `https://example.test/${i}`, snippet: 'Evidence' })))
    remote.fetch.mockResolvedValue({ title: 'Source', text: 'Evidence '.repeat(100) })
    await expect(runDeepResearch({ ctx, query: 'Topic', provider: 'huggingface', model: '', maxSources: 2 })).rejects.toThrow('Research cancelled')
    expect(remote.turn).not.toHaveBeenCalled()
    if (phase === 'planning') expect(remote.search).not.toHaveBeenCalled()
    else expect(calls).toBe(2)
    expect(f.events.some(event => event.type === 'final')).toBe(false)
  })
  it('rejects fabricated, copied and serialized grants before model contact', async () => {
    const f = await fixture()
    await expect(run(f.ctx, ['calculator'])).rejects.toMatchObject({ status: 403 })
    const ctx = await grant(f)
    await expect(run({ ...ctx }, ['calculator'])).rejects.toMatchObject({ status: 403 })
    await expect(assertRunAccess(JSON.parse(JSON.stringify(ctx)))).rejects.toMatchObject({ status: 403 })
    expect(remote.client).not.toHaveBeenCalled()
  })

  it('denies broadening a grant and tampering with its identity', async () => {
    const f = await fixture(); const ctx = await grant(f)
    expect(() => restrictRunContext(ctx, ['get_current_time'])).toThrow('not permitted')
    ctx.userId = bob
    expect((await toolRegistry.execute('calculator', { expression: '6*7' }, ctx)).isError).toBe(true)
  })

  it('executes a reviewed selected tool but not another registered tool', async () => {
    const f = await fixture(); const ctx = await grant(f)
    expect((await toolRegistry.execute('calculator', { expression: '6*7' }, ctx)).content).toContain('42')
    expect((await toolRegistry.execute('get_current_time', {}, ctx)).isError).toBe(true)
  })

  it('does not retarget a grant when the global registry handler is replaced', async () => {
    const f = await fixture(); const ctx = await grant(f)
    const handler = vi.fn(async () => ({ content: 'foreign credential' }))
    toolRegistry.register({ ...reviewed(['calculator'])[0], source: 'fixture', handler })
    expect((await toolRegistry.execute('calculator', { expression: '6*7' }, ctx)).content).toContain('42')
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([[], null, { expression: 42 }, { expression: '6*7', workspaceId: 'other' }])('rejects invalid/extra arguments %j', async (args) => {
    const f = await fixture(); const ctx = await grant(f)
    const result = await toolRegistry.execute('calculator', args as any, ctx)
    expect(result).toMatchObject({ isError: true, content: 'Invalid tool arguments.' })
  })

  it.each(['native', 'inline'])('blocks unselected global tools through %s calls', async (format) => {
    const f = await fixture(); const ctx = await grant(f)
    const handler = vi.fn(async () => ({ content: 'shared credential' }))
    toolRegistry.register({ name: 'shared_connector', source: 'fixture', description: 'Private global connector', parameters: { type: 'object' }, handler })
    remote.turn.mockResolvedValueOnce(format === 'native'
      ? { content: '', toolCalls: [nativeCall('shared_connector'), nativeCall('calculator', { expression: '6*7' })] }
      : { content: '{"tool":"shared_connector","arguments":{}} {"tool":"calculator","arguments":{"expression":"6*7"}}', toolCalls: [] })
    const result = await run(ctx, ['calculator'])
    expect(handler).not.toHaveBeenCalled()
    expect(result.toolsUsed).toEqual(['calculator'])
    expect(f.events.some((event) => event.type === 'tool_result' && event.name === 'shared_connector' && event.isError)).toBe(true)
    expect(JSON.stringify(remote.turn.mock.calls[0][0].tools)).not.toContain('shared_connector')
  })

  it('treats omitted tool selection as plain chat even if native calls arrive', async () => {
    const f = await fixture(); const ctx = await grant(f)
    remote.turn.mockResolvedValueOnce({ content: '', toolCalls: [nativeCall('calculator', { expression: '6*7' })] })
    const result = await run(ctx)
    expect(result.toolsUsed).toEqual([])
    expect(remote.turn.mock.calls[0][0].tools).toBeUndefined()
    expect(f.events.find((event) => event.type === 'tool_result').isError).toBe(true)
  })

  it('rejects malformed native arguments instead of substituting empty arguments', async () => {
    const f = await fixture(); const ctx = await grant(f, ['get_current_time'])
    remote.turn.mockResolvedValueOnce({ content: '', toolCalls: [{ id: 'bad-json', name: 'get_current_time', arguments: '{bad' }] })
    expect((await run(ctx, ['get_current_time'])).toolsUsed).toEqual([])
    expect(f.events.find((event) => event.type === 'tool_result').content).toBe('Invalid tool arguments.')
  })

  it('preserves invalid falsy inline arguments for validation instead of defaulting them', async () => {
    for (const args of [null, false, 0, '']) {
      const f = await fixture(); const ctx = await grant(f, ['get_current_time'])
      remote.turn.mockResolvedValueOnce({ content: JSON.stringify({ tool: 'get_current_time', arguments: args }), toolCalls: [] })
      expect((await run(ctx, ['get_current_time'])).toolsUsed).toEqual([])
      expect(f.events.find((event) => event.type === 'tool_result').content).toBe('Invalid tool arguments.')
    }
  })

  it('rechecks revocation between two calls in the same model turn', async () => {
    const f = await fixture('editor')
    const second = vi.fn(async () => ({ content: 'must not run' }))
    const first: ToolDefinition = { name: 'first', source: 'fixture', description: 'Test revocation', parameters: { type: 'object' }, handler: async () => {
      await db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: bob } } })
      return { content: 'revoked' }
    } }
    const ctx = await authorizeRunContext(f.ctx, f.workspaceId, [first, { ...first, name: 'second', handler: second }])
    remote.turn.mockResolvedValueOnce({ content: '', toolCalls: [nativeCall('first'), nativeCall('second')] })
    await expect(run(ctx, ['first', 'second'])).rejects.toMatchObject({ status: 403 })
    expect(second).not.toHaveBeenCalled()
    expect(remote.turn).toHaveBeenCalledTimes(1)
  })

  it('rejects viewers, deleted conversations, and cancelled runs', async () => {
    const viewer = await fixture('viewer')
    await expect(grant(viewer)).rejects.toMatchObject({ status: 403 })
    const f = await fixture(); const ctx = await grant(f)
    await db.conversation.delete({ where: { id: f.conversationId } })
    await expect(run(ctx, ['calculator'])).rejects.toMatchObject({ status: 403 })
    const active = await fixture(); const abort = new AbortController(); active.ctx.signal = abort.signal
    const cancelled = await grant(active); abort.abort()
    await expect(run(cancelled, ['calculator'])).rejects.toMatchObject({ status: 409 })
  })

  it('binds legacy conversations to personal workspaces, never arbitrary shared workspaces', async () => {
    const legacy = await db.conversation.create({ data: { userId: alice, title: 'Legacy fixture' } })
    const f = await fixture()
    await expect(prepareRunConversation(alice, legacy.id, 'Legacy', f.workspaceId)).rejects.toMatchObject({ status: 409 })
    const prepared = await prepareRunConversation(alice, legacy.id, 'Legacy')
    expect(prepared.workspaceId).toBe((await ensurePersonalWorkspace(alice)).id)
    await expect(prepareRunConversation(alice, legacy.id, 'Move', f.workspaceId)).rejects.toMatchObject({ status: 409 })
  })

  it('enforces both stream aliases and keeps chat tool-free despite skill triggers', async () => {
    const f = await fixture()
    for (const mount of ['/api/agent', '/api/conversations']) {
      const denied = await request(`${mount}/${f.conversationId}/stream`, bob, 'POST', { content: 'Hi' })
      expect(denied.status).toBe(404)
      const allowed = await request(`${mount}/${f.conversationId}/stream`, alice, 'POST', { content: 'PDF report', mode: 'chat' })
      expect(allowed.status).toBe(200)
      expect(await allowed.text()).toContain('Completed')
    }
    expect(remote.turn).toHaveBeenCalledTimes(2)
    expect(remote.turn.mock.calls.every(([options]) => options.tools === undefined)).toBe(true)
  })

  it('does not start models for foreign workspace selection or viewer-owned conversations', async () => {
    const f = await fixture('viewer')
    expect((await request(`/api/agent/${f.conversationId}/stream`, bob, 'POST', { content: 'Hi' })).status).toBe(403)
    expect((await request('/api/agent/new/stream', bob, 'POST', { content: 'Hi', workspaceId: (await fixture()).workspaceId })).status).toBe(404)
    expect(remote.client).not.toHaveBeenCalled()
  })

  it('runs a selected calculator through the actual authenticated SSE route', async () => {
    const f = await fixture()
    remote.turn.mockResolvedValueOnce({ content: '', toolCalls: [nativeCall('calculator', { expression: '6*7' })] })
    const response = await request(`/api/agent/${f.conversationId}/stream`, alice, 'POST', { content: 'Calculate', mode: 'agent', workspaceId: f.workspaceId, toolNames: ['calculator'] })
    expect(response.status).toBe(200)
    const events = await response.text()
    expect(events).toContain('42')
    expect(events).toContain('Completed')
    expect(remote.turn).toHaveBeenCalledTimes(2)
    const saved = await db.message.findFirstOrThrow({ where: { conversationId: f.conversationId, role: 'assistant' } })
    expect(saved.content).toBe('Completed')
  })

  it('webSearch=false strips web tools even from the default selection (audit §8-25)', async () => {
    const f = await fixture()
    const response = await request(`/api/agent/${f.conversationId}/stream`, alice, 'POST', { content: 'Hi', mode: 'agent', workspaceId: f.workspaceId, webSearch: false })
    expect(response.status).toBe(200)
    // Drain the SSE stream: the run is still in flight when headers arrive.
    await response.text()
    const tools = JSON.stringify(remote.turn.mock.calls[0][0].tools)
    expect(tools).not.toContain('web_search')
    expect(tools).not.toContain('web_fetch')
  })

  it('webSearch=true forces web tools past an excluding tool selection (audit §8-25)', async () => {
    const f = await fixture()
    const response = await request(`/api/agent/${f.conversationId}/stream`, alice, 'POST', { content: 'Hi', mode: 'agent', workspaceId: f.workspaceId, toolNames: ['calculator'], webSearch: true })
    expect(response.status).toBe(200)
    // Drain before asserting on the dispatched model call.
    await response.text()
    const tools = JSON.stringify(remote.turn.mock.calls[0][0].tools)
    expect(tools).toContain('web_search')
    expect(tools).toContain('web_fetch')
    expect(tools).toContain('calculator')
  })

  it('applies the per-run thinking override to the model prompt (audit §8-26)', async () => {
    const f = await fixture(); const ctx = await grant(f, ['calculator'])
    const systemOf = (call: number) => String(remote.turn.mock.calls[call][0].messages[0].content)
    // Default (env unset in tests): /no_think.
    await runAgent({ provider: 'huggingface', model: 'test-model', ctx, toolNames: ['calculator'], messages: [{ role: 'user', content: 'Hi' }] })
    expect(systemOf(0)).toContain('/no_think')
    // Explicit on wins over the env default.
    await runAgent({ provider: 'huggingface', model: 'test-model', ctx, toolNames: ['calculator'], messages: [{ role: 'user', content: 'Hi' }], thinking: true })
    expect(systemOf(1)).toContain('/think')
    expect(systemOf(1)).not.toContain('/no_think')
    // Explicit off wins even when the env default is on.
    vi.stubEnv('QWEN_THINKING', 'true')
    try {
      await runAgent({ provider: 'huggingface', model: 'test-model', ctx, toolNames: ['calculator'], messages: [{ role: 'user', content: 'Hi' }], thinking: false })
      expect(systemOf(2)).toContain('/no_think')
    } finally { vi.unstubAllEnvs() }
  })

  it('rejects unavailable tool requests and credit-check failures before starting a run', async () => {
    const before = await db.conversation.count({ where: { userId: alice } })
    expect((await request('/api/agent/new/stream', alice, 'POST', { content: 'Hi', toolNames: ['fixture_not_a_tool'] })).status).toBe(400)
    expect((await request('/api/agent/new/stream', alice, 'POST', { content: 'Hi', mode: 'research', toolNames: [] })).status).toBe(400)
    const check = vi.spyOn(billing, 'reserveDailyCredits').mockRejectedValueOnce(new Error('Do not expose internal details'))
    try {
      const response = await request('/api/agent/new/stream', alice, 'POST', { content: 'Hi' })
      expect(response.status).toBe(503)
      expect(await response.text()).not.toContain('internal details')
    } finally { check.mockRestore() }
    expect(await db.conversation.count({ where: { userId: alice } })).toBe(before)
    expect(remote.client).not.toHaveBeenCalled()
  })

  it('serves configuration verbs as live, auth-gated routes (config-store revival)', async () => {
    // The config groups retired to 410 in an earlier hardening pass; the
    // account-scoped config-store features revived them as live routes.
    // They are auth-gated on both historical mounts (the agent router is
    // intentionally reachable from /api/conversations for compatibility).
    for (const mount of ['/api/agent', '/api/conversations']) {
      for (const group of ['mcp-servers', 'connectors', 'skills', 'custom-tools', 'plugins']) {
        expect((await request(`${mount}/${group}`, alice)).status).toBe(200)
        expect((await fetch(`${base}${mount}/${group}`)).status).toBe(401)
      }
    }
  })

  it('exposes only reviewed catalog entries, excluding extension/creator tools', async () => {
    toolRegistry.register({ name: 'shared_connector', source: 'fixture', description: 'Private', parameters: { type: 'object' }, handler: async () => ({ content: '' }) })
    const catalog = await (await request('/api/agent/tools', alice)).json() as any[]
    expect(catalog.map((entry) => entry.name)).not.toContain('shared_connector')
    // Shipped creator tools (skills + custom-tools features) are reviewed
    // catalog entries now; they must be present for agent runs.
    expect(catalog.map((entry) => entry.name)).toContain('create_skill')
    expect(catalog.map((entry) => entry.name)).toContain('create_custom_tool')
  })

  it('requires an administrator for process-global provider settings', async () => {
    expect((await request('/api/settings/providers')).status).toBe(401)
    expect((await request('/api/settings/providers', alice)).status).toBe(403)
    expect((await request('/api/settings/provider', alice, 'POST', { provider: 'huggingface', apiKey: 'fixture' })).status).toBe(403)
    const nodeEnv = process.env.NODE_ENV, dev = process.env.ENABLE_DEV_MODE
    process.env.NODE_ENV = 'development'; process.env.ENABLE_DEV_MODE = 'true'
    try { expect((await request('/api/settings/providers')).status).toBe(403) }
    finally { process.env.NODE_ENV = nodeEnv; process.env.ENABLE_DEV_MODE = dev }
  })

  it('requires both research permissions before contacting a model', async () => {
    const f = await fixture(); const ctx = await grant(f, ['web_search'])
    await expect(runDeepResearch({ ctx, query: 'Topic', provider: 'huggingface', model: '' })).rejects.toMatchObject({ status: 403 })
    expect(remote.client).not.toHaveBeenCalled()
  })

  it.each(['search', 'fetch'])('rechecks research permission before %s without hiding denial in fallbacks', async (phase) => {
    const f = await fixture('editor'); const ctx = await grant(f, ['web_search', 'web_fetch'])
    const revoke = () => db.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: f.workspaceId, userId: bob } } })
    remote.complete.mockImplementationOnce(async () => { if (phase === 'search') await revoke(); return '["query"]' })
    remote.search.mockImplementation(async () => { if (phase === 'fetch') await revoke(); return Array.from({ length: 6 }, (_, i) => ({ title: 'Source', url: `https://example.test/${i}`, snippet: 'Evidence' })) })
    await expect(runDeepResearch({ ctx, query: 'Topic', provider: 'huggingface', model: '' })).rejects.toMatchObject({ status: 403 })
    expect(remote.fetch).not.toHaveBeenCalled()
    if (phase === 'search') expect(remote.search).not.toHaveBeenCalled()
  })
})

describe('hosted selection on streaming and CLI routes', () => {
  const overrides = [{ provider: 'local' }, { provider: 'openai', baseUrl: 'https://attacker.example.test' },
    { provider: 'huggingface', baseUrl: 'http://169.254.169.254', apiKey: 'caller-key' },
    { apiKey: null }, { baseURL: '' }, { models: [{ provider: 'nvidia', baseUrl: 'http://127.0.0.1' }] }]

  it.each(['/api/agent', '/api/conversations'])('rejects overrides at %s streaming before writes/client creation', async (mount) => {
    const before = await db.conversation.count({ where: { userId: alice } })
    for (const body of overrides) {
      const res = await request(`${mount}/new/stream`, alice, 'POST', { content: 'q', ...body })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'HOSTED_MODEL_REQUIRED' })
    }
    expect(await db.conversation.count({ where: { userId: alice } })).toBe(before)
    expect(remote.client).not.toHaveBeenCalled()
    expect(remote.turn).not.toHaveBeenCalled()
  })

  it.each(['/api/agent', '/api/conversations'])('rejects overrides and malformed completion bodies at %s', async (mount) => {
    for (const body of overrides) expect((await request(`${mount}/completions`, alice, 'POST', { messages: [{ role: 'user', content: 'q' }], ...body })).status).toBe(400)
    for (const body of [{}, { messages: [] }, { messages: [null] }, { messages: [{ role: 'invalid' }] },
      { messages: [{ role: 'user', content: 'q' }], stream: 'false' }, { messages: Array.from({ length: 201 }, () => ({ role: 'user', content: 'q' })) }]) {
      expect((await request(`${mount}/completions`, alice, 'POST', body)).status).toBe(400)
    }
    expect(remote.client).not.toHaveBeenCalled()
  })

  it.each(['/api/agent', '/api/conversations'])('uses only hosted target configuration on %s streaming', async (mount) => {
    vi.stubEnv('DEFAULT_PROVIDER', 'nvidia')
    vi.stubEnv('HF_LARGE_ENDPOINT_URL', 'https://hosted-large.example.test')
    vi.stubEnv('HF_LARGE_MODEL', 'operator-model')
    const f = await fixture()
    const res = await request(`${mount}/${f.conversationId}/stream`, alice, 'POST', { content: 'q', model: 'loop-chat-large', mode: 'chat' })
    expect(res.status).toBe(200); await res.text()
    expect(remote.client).toHaveBeenCalledWith('huggingface', undefined, 'https://hosted-large.example.test/v1')
  })

  it('preserves nonstreaming CLI responses while selecting only the hosted target', async () => {
    vi.stubEnv('HF_ENDPOINT_URL', 'https://hosted-standard.example.test')
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'Hosted response' } }] })
    remote.client.mockReturnValueOnce({ chat: { completions: { create } } })
    const res = await request('/api/agent/completions', alice, 'POST', { messages: [{ role: 'user', content: 'q' }], stream: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ choices: [{ message: { content: 'Hosted response' } }] })
    expect(remote.client).toHaveBeenCalledWith('huggingface', undefined, 'https://hosted-standard.example.test/v1')
    expect(create.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('preserves successful CLI SSE framing and passes cancellation upstream', async () => {
    const create = vi.fn().mockImplementation(async () => (async function* () { yield { choices: [{ delta: { content: 'Hosted response' } }] } })())
    remote.client.mockReturnValueOnce({ chat: { completions: { create } } })
    const res = await request('/api/conversations/completions', alice, 'POST', { messages: [{ role: 'user', content: 'q' }] })
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(body).toContain('Hosted response')
    expect(body).toContain('data: [DONE]')
    expect(create.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it.each([true, false])('sanitizes upstream CLI startup failures with stream=%s', async (stream) => {
    const create = vi.fn().mockRejectedValue(new Error('fixture-secret upstream body https://private.example.test'))
    remote.client.mockReturnValueOnce({ chat: { completions: { create } } })
    const res = await request('/api/agent/completions', alice, 'POST', { messages: [{ role: 'user', content: 'q' }], stream })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Model request failed' })
  })

  it('catches SDK construction errors before opening SSE', async () => {
    remote.client.mockImplementationOnce(() => { throw new Error('fixture-secret invalid endpoint') })
    const res = await request('/api/agent/completions', alice, 'POST', { messages: [{ role: 'user', content: 'q' }] })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Model request failed' })
  })

  it('sanitizes a CLI stream failure after output has started', async () => {
    const create = vi.fn().mockImplementation(async () => (async function* () {
      yield { choices: [{ delta: { content: 'Partial response' } }] }
      throw new Error('fixture-secret in upstream failure')
    })())
    remote.client.mockReturnValueOnce({ chat: { completions: { create } } })
    const res = await request('/api/agent/completions', alice, 'POST', { messages: [{ role: 'user', content: 'q' }] })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).toContain('Partial response')
    expect(text).toContain('Model request failed')
    expect(text).not.toContain('fixture-secret')
    expect(text).not.toContain('[DONE]')
  })

  it('aborts the upstream CLI request when its HTTP client disconnects', async () => {
    let markCancelled!: () => void
    const cancelled = new Promise<void>((resolve) => { markCancelled = resolve })
    const create = vi.fn().mockImplementation(async (_params, { signal }) => (async function* () {
      yield { choices: [{ delta: { content: 'Started' } }] }
      await new Promise<void>((resolve) => {
        if (signal.aborted) { markCancelled(); resolve(); return }
        signal.addEventListener('abort', () => { markCancelled(); resolve() }, { once: true })
      })
    })())
    remote.client.mockReturnValueOnce({ chat: { completions: { create } } })
    const abort = new AbortController()
    try {
      const res = await fetch(`${base}/api/agent/completions`, { method: 'POST', signal: abort.signal,
        headers: { Authorization: `Bearer ${jwt.sign({ userId: alice }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }) })
      await res.body!.getReader().read()
      abort.abort()
      await cancelled
      expect(create.mock.calls[0][1].signal.aborted).toBe(true)
    } finally { abort.abort() }
  })
})
