import { describe, expect, it, vi, beforeEach } from 'vitest'

/** Nightly memory synthesis (GAP-041/044): unit coverage with a mocked LLM
 * and a mocked prisma — verifies gating, dedupe, caps, and row shape. */

const created: any[] = []
const existingMemories: any[] = []
vi.mock('../prisma', () => ({
  prisma: {
    user: { findMany: async () => [{ id: 'u1' }] },
    conversation: { findMany: async () => [{ id: 'c1' }] },
    message: { findMany: async () => [
      { role: 'user', content: 'I work at Acme on the payments team. ' + 'We ship weekly and I prefer concise answers in British English. '.padEnd(120, 'x') },
      { role: 'assistant', content: 'Understood — concise answers it is. ' + 'Tell me more about the payments stack whenever you need help. '.padEnd(120, 'y') },
    ] },
    memory: {
      findMany: async () => existingMemories,
      create: async (args: any) => { created.push(args.data); return args.data },
      deleteMany: async () => ({ count: 0 }),
    },
  },
}))

const extractStub = vi.fn()
vi.mock('../../agent/llmClient', () => ({ createClient: () => ({}), completeOnce: (...a: any[]) => extractStub(...a) }))
vi.mock('../chatModels', () => ({ resolveChatTarget: () => ({ baseUrl: 'http://x', model: 'fast' }) }))

import { runMemorySynthesis, synthesisEnabled } from '../memorySynthesis'

beforeEach(() => { created.length = 0; existingMemories.length = 0; extractStub.mockReset() })

describe('runMemorySynthesis', () => {
  it('creates synthesized memories with source agent and kind synthesized', async () => {
    existingMemories.push({ content: 'something unrelated' })
    extractStub.mockResolvedValue('[{"content":"User works at Acme on the payments team","tags":["work"]}]')
    const r = await runMemorySynthesis()
    expect(r.usersConsidered).toBe(1)
    expect(created.length).toBe(1)
    expect(created[0]).toMatchObject({ userId: 'u1', kind: 'synthesized', source: 'agent', tags: ['work'] })
    expect(r.memoriesCreated).toBe(1)
  })

  it('dedupes candidates against existing memories', async () => {
    existingMemories.push({ content: 'User works at Acme on the payments team' })
    extractStub.mockResolvedValue('[{"content":"User works at Acme on the payments team"}]')
    const r = await runMemorySynthesis()
    expect(created.length).toBe(0)
    expect(r.memoriesCreated).toBe(0)
  })

  it('caps per-user nightly creation at 5', async () => {
    extractStub.mockResolvedValue(JSON.stringify(
      Array.from({ length: 9 }, (_, i) => ({ content: `Durable preference number ${i} about the user`, tags: ['p'] })),
    ))
    const r = await runMemorySynthesis()
    expect(created.length).toBeLessThanOrEqual(5)
    expect(r.memoriesCreated).toBeLessThanOrEqual(5)
  })

  it('tolerates non-JSON model output', async () => {
    extractStub.mockResolvedValue('I could not find any memories.')
    const r = await runMemorySynthesis()
    expect(created.length).toBe(0)
    expect(r.errors).toBe(0)
  })

  it('honors the MEMORY_SYNTHESIS_ENABLED kill-switch', () => {
    expect(synthesisEnabled()).toBe(true)
    process.env.MEMORY_SYNTHESIS_ENABLED = 'false'
    expect(synthesisEnabled()).toBe(false)
    delete process.env.MEMORY_SYNTHESIS_ENABLED
  })
})
