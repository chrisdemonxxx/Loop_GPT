import { randomUUID } from 'crypto'
import type { Server } from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Branch-version integration (audit §8-22): the <2/3> arrows need a real
// tree. Dispatch + JWT + PostgreSQL are real; the model call is mocked so
// the assertions are about WHICH context the runs see, not what a model says.
const remote = vi.hoisted(() => ({ turn: vi.fn(), complete: vi.fn(), client: vi.fn(() => ({})) }))
vi.mock('../../agent/llmClient', () => ({ createClient: remote.client, resolveModel: () => 'test-model',
  isOpenAICompatible: () => true, streamTurn: remote.turn, completeOnce: remote.complete }))
import { prisma } from '../prisma'
import { createWorkspace } from '../workspaces'
import { getHistory } from '../chatStore'
import { registerBuiltinTools } from '../../agent'
import { configStore } from '../../agent/configStore'
import agentRouter from '../../routes/agent'
import messagesRouter from '../../routes/messages'

const db = prisma!
const prefix = `branch-${randomUUID()}`
let alice: string, bob: string
let server: Server, base: string
const finalTurn = (content: string) => ({ content, toolCalls: [] })

async function conversation(userId = alice, title = 'Branch fixture') {
  const workspace = await createWorkspace(userId, `${prefix} workspace`)
  const row = await db.conversation.create({ data: { userId, workspaceId: workspace.id, title } })
  return { id: row.id, workspaceId: workspace.id }
}

async function stream(conversationId: string, workspaceId: string, body: Record<string, unknown>, userId = alice) {
  const res = await fetch(`${base}/api/agent/${conversationId}/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId }, process.env.JWT_SECRET!)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ mode: 'agent', ...body, workspaceId }),
  })
  await res.text() // drain: the run must finish before assertions on dispatches
  return res
}

const rows = async (conversationId: string) =>
  db.message.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

beforeAll(async () => {
  alice = `${prefix}-alice`; bob = `${prefix}-bob`
  await db.user.createMany({ data: [alice, bob].map((id) => ({ id, email: `${id}@example.test`, name: 'Branch fixture', password: 'fixture-only', credits: 500 })) })
  registerBuiltinTools()
  const app = express(); app.use(express.json())
  app.use('/api/agent', agentRouter)
  app.use('/api/conversations', messagesRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  base = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  remote.turn.mockReset()
  remote.client.mockReset().mockReturnValue({})
  // Agent tool calls need no live tools here; text answers only.
  remote.turn.mockResolvedValue(finalTurn('answer'))
  configStore.saveConnectors([])
})

afterAll(async () => {
  try {
    if (server) await new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((err) => err ? reject(err) : resolve()) })
    await db.conversation.deleteMany({ where: { userId: { in: [alice, bob] } } })
    await db.workspace.deleteMany({ where: { name: { startsWith: `${prefix} workspace` } } })
    await db.user.deleteMany({ where: { id: { in: [alice, bob] } } })
  } finally { await db.$disconnect() }
})

describe('message branching (audit §8-22)', () => {
  it('retry (regenerateOf) creates a sibling answer; run context never sees the old attempt', async () => {
    const conv = await conversation()
    await stream(conv.id, conv.workspaceId, { content: 'What is 2+2?' })
    let all = await rows(conv.id)
    expect(all).toHaveLength(2)
    const [u1, a1] = all
    expect(u1.parentId).toBeNull() // migrated/root chain backfill for fresh rows: root
    expect(a1.parentId).toBe(u1.id) // normal save appends under the active leaf

    // Retry the turn: the stored prompt is the source of truth (the client
    // copy below is deliberately different and must be ignored).
    remote.turn.mockClear()
    remote.turn.mockResolvedValue(finalTurn('the answer is four'))
    const res = await stream(conv.id, conv.workspaceId, { content: 'client-sent junk', regenerateOf: u1.id })
    expect(res.status).toBe(200)

    // The regenerating run saw the STORED prompt and NOT the previous answer.
    const dispatched = remote.turn.mock.calls[0][0].messages as Array<{ role: string; content: string }>
    expect(dispatched.at(-1)).toMatchObject({ role: 'user', content: 'What is 2+2?' })
    expect(dispatched.some((m) => m.content === 'answer')).toBe(false)

    all = await rows(conv.id)
    expect(all).toHaveLength(3)
    const a2 = all.find((m) => m.content === 'the answer is four')!
    expect(a2.parentId).toBe(u1.id) // sibling of the first answer
    const active = await db.conversation.findUnique({ where: { id: conv.id }, select: { activeLeafId: true } })
    expect(active?.activeLeafId).toBe(a2.id)

    // getHistory walks the ACTIVE PATH: the new answer, not the old one.
    const history = await getHistory(conv.id, 10)
    expect(history.map((m) => m.content)).toEqual(['What is 2+2?', 'the answer is four'])
  })

  it('branch-select switches the active path; new runs follow the selected version', async () => {
    const conv = await conversation()
    await stream(conv.id, conv.workspaceId, { content: 'Draft me a haiku' })
    const first = await rows(conv.id)
    const u1 = first[0]
    const a1 = first.find((m) => m.role === 'assistant' && m.parentId === u1.id)!
    await stream(conv.id, conv.workspaceId, { content: 'Now explain it' })
    const second = await rows(conv.id)
    const u2 = second.find((m) => m.content === 'Now explain it')!
    const a1b = second.find((m) => m.role === 'assistant' && m.parentId === u2.id)!

    // Regenerate the first answer -> sibling answer becomes the active tip.
    remote.turn.mockResolvedValue(finalTurn('a better haiku'))
    await stream(conv.id, conv.workspaceId, { content: 'unused', regenerateOf: u1.id })
    const after = await rows(conv.id)
    const a2 = after.find((m) => m.content === 'a better haiku')!
    expect(a2.parentId).toBe(u1.id)

    // Switch back to the FIRST version of that answer. The tip must descend
    // to the branch as it was left: the follow-up answer under a1.
    const select = await fetch(`${base}/api/conversations/${conv.id}/branch-select`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt.sign({ userId: alice }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: a1.id }),
    })
    expect(select.status).toBe(200)
    expect((await select.json()).activeLeafId).toBe(a1b.id)

    // The active path now runs through the FIRST answer — the regenerated
    // version is off-path.
    const history = await getHistory(conv.id, 10)
    expect(history.at(-1)?.id).toBe(a1b.id)
    expect(history.some((m) => m.id === a2.id)).toBe(false)

    // A new run follows the selected branch: 'a better haiku' is absent.
    remote.turn.mockClear()
    await stream(conv.id, conv.workspaceId, { content: 'Thanks, continue' })
    const dispatched = remote.turn.mock.calls[0][0].messages as Array<{ role: string; content: string }>
    expect(dispatched.some((m) => m.content === 'a better haiku')).toBe(false)
    expect(dispatched.some((m) => m.role === 'assistant' && m.content === 'answer')).toBe(true)
    expect(dispatched.at(-1)).toMatchObject({ role: 'user', content: 'Thanks, continue' })
  })

  it('branch-select descends to the subtree tip along the newest children', async () => {
    const conv = await conversation()
    await stream(conv.id, conv.workspaceId, { content: 'First question' })
    const first = await rows(conv.id)
    const u1 = first[0]
    const a1 = first.find((m) => m.role === 'assistant')!
    await stream(conv.id, conv.workspaceId, { content: 'Follow-up on the first answer' })
    const second = await rows(conv.id)
    const u2 = second.find((m) => m.content === 'Follow-up on the first answer')!
    const followupAnswer = second.find((m) => m.role === 'assistant' && m.parentId === u2.id)!
    // Regenerate the first answer (parallel sibling), then SWITCH to the old
    // one: the active path must descend through the continuation that was
    // added under the old answer — "as you left it".
    remote.turn.mockResolvedValue(finalTurn('alternate answer'))
    await stream(conv.id, conv.workspaceId, { content: 'unused', regenerateOf: u1.id })

    const select = await fetch(`${base}/api/conversations/${conv.id}/branch-select`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt.sign({ userId: alice }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: a1.id }),
    })
    expect(select.status).toBe(200)
    // Tip = a1 -> u2 -> followupAnswer (deepest newest-descendant chain).
    expect((await select.json()).activeLeafId).toBe(followupAnswer.id)
  })

  it('edit (parentMessageId) creates a sibling prompt version at the anchor', async () => {
    const conv = await conversation()
    await stream(conv.id, conv.workspaceId, { content: 'Original first prompt' })
    const [u1] = await rows(conv.id)

    // Edit the FIRST turn: the predecessor is null -> explicit root sibling.
    remote.turn.mockClear()
    const res = await stream(conv.id, conv.workspaceId, { content: 'Edited first prompt', parentMessageId: null })
    expect(res.status).toBe(200)
    let all = await rows(conv.id)
    const u2 = all.find((m) => m.content === 'Edited first prompt')!
    expect(u2.parentId).toBeNull()
    expect(all.filter((m) => m.parentId === null && m.role === 'user')).toHaveLength(2) // both prompts are roots
    // The edited run saw ONLY its own prompt (the old turn is off-path).
    const dispatched = remote.turn.mock.calls[0][0].messages as Array<{ role: string; content: string }>
    const turnMessages = dispatched.filter((m) => m.role !== 'system')
    expect(turnMessages).toHaveLength(1)
    expect(turnMessages[0]).toMatchObject({ role: 'user', content: 'Edited first prompt' })

    // Edit the SECOND turn of a two-turn conversation: anchor = the first answer.
    await stream(conv.id, conv.workspaceId, { content: 'Second prompt (on edited branch)' })
    all = await rows(conv.id)
    const editedAnswer = all.find((m) => m.role === 'assistant' && m.parentId === u2.id)!
    remote.turn.mockClear()
    await stream(conv.id, conv.workspaceId, { content: 'Second prompt, edited', parentMessageId: editedAnswer.id })
    all = await rows(conv.id)
    const u3 = all.find((m) => m.content === 'Second prompt, edited')!
    expect(u3.parentId).toBe(editedAnswer.id)
    // Context for the edited second turn: the first edited turn only.
    const dispatched2 = remote.turn.mock.calls[0][0].messages as Array<{ role: string; content: string }>
    expect(dispatched2.some((m) => m.content === 'Edited first prompt')).toBe(true)
    expect(dispatched2.some((m) => m.content === 'Second prompt (on edited branch)')).toBe(false)
    expect(dispatched2.at(-1)).toMatchObject({ role: 'user', content: 'Second prompt, edited' })
  })

  it('serves the branch envelope (and keeps the legacy flat array)', async () => {
    const conv = await conversation()
    await stream(conv.id, conv.workspaceId, { content: 'Hello' })
    const [u1] = await rows(conv.id)
    await stream(conv.id, conv.workspaceId, { content: 'unused', regenerateOf: u1.id })

    const auth = { Authorization: `Bearer ${jwt.sign({ userId: alice }, process.env.JWT_SECRET!)}` }
    const envelopeRes = await fetch(`${base}/api/conversations/${conv.id}/messages?branch=1`, { headers: auth })
    expect(envelopeRes.status).toBe(200)
    const envelope = await envelopeRes.json()
    expect(typeof envelope.activeLeafId).toBe('string')
    expect(Array.isArray(envelope.messages)).toBe(true)
    // Every row carries its parentId so the client can group versions.
    for (const m of envelope.messages) expect('parentId' in m).toBe(true)

    const legacyRes = await fetch(`${base}/api/conversations/${conv.id}/messages`, { headers: auth })
    const legacy = await legacyRes.json()
    expect(Array.isArray(legacy)).toBe(true) // mobile/older clients: unchanged shape
    expect(legacy).toHaveLength(3)
  })

  it('rejects branch anchors that do not belong to the caller', async () => {
    const aliceConv = await conversation(alice)
    await stream(aliceConv.id, aliceConv.workspaceId, { content: 'Private prompt' })
    const [u1] = await rows(aliceConv.id)

    // bob probes alice's row through regenerateOf:
    const bobRetry = await stream(aliceConv.id, aliceConv.workspaceId, { content: 'x', regenerateOf: u1.id }, bob)
    expect(bobRetry.status).toBe(400)
    // ...and through parentMessageId:
    const bobEdit = await stream(aliceConv.id, aliceConv.workspaceId, { content: 'x', parentMessageId: u1.id }, bob)
    expect(bobEdit.status).toBe(400)
    // ...and through branch-select on alice's conversation:
    const bobSelect = await fetch(`${base}/api/conversations/${aliceConv.id}/branch-select`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt.sign({ userId: bob }, process.env.JWT_SECRET!)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: u1.id }),
    })
    expect(bobSelect.status).toBe(404)
    // alice's conversation was untouched by the probes.
    expect(await rows(aliceConv.id)).toHaveLength(2)
  })

  it('regenerateOf and parentMessageId are mutually exclusive; branching needs an existing conversation', async () => {
    const conv = await conversation()
    const both = await stream(conv.id, conv.workspaceId, { content: 'x', regenerateOf: 'whatever', parentMessageId: null })
    expect(both.status).toBe(400)
    const fresh = await stream('new', conv.workspaceId, { content: 'x', regenerateOf: 'whatever' })
    expect(fresh.status).toBe(400)
  })
})
