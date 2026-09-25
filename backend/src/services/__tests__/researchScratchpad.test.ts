import { describe, expect, it, vi, beforeEach } from 'vitest'

/** Research scratchpad (GAP-046): save/load merge semantics with a mocked DB. */

const upsert = vi.fn()
const findUnique = vi.fn()
vi.mock('../prisma', () => ({
  prisma: {
    researchScratchpad: {
      findUnique: (...a: any[]) => findUnique(...a),
      upsert: (...a: any[]) => upsert(...a),
      deleteMany: async () => ({ count: 0 }),
    },
  },
}))

import { loadScratchpad, saveScratchpad, queryHash } from '../researchScratchpad'

beforeEach(() => { upsert.mockReset(); findUnique.mockReset() })

describe('researchScratchpad', () => {
  it('hashes queries case/whitespace-insensitively', () => {
    expect(queryHash('DeepSeek  R1 Review')).toBe(queryHash('deepseek r1 review'))
    expect(queryHash('a')).not.toBe(queryHash('b'))
  })

  it('returns null when nothing is saved', async () => {
    findUnique.mockResolvedValue(null)
    expect(await loadScratchpad('u1', 'q')).toBeNull()
  })

  it('loads each saved phase', async () => {
    findUnique.mockResolvedValue({
      queries: ['q1', 'q2'],
      hits: [{ title: 't', url: 'https://x', snippet: 's' }],
      sources: [{ index: 1, title: 't', url: 'https://x', text: 'body' }],
    })
    const s = await loadScratchpad('u1', 'deepseek r1')
    expect(s?.queries).toEqual(['q1', 'q2'])
    expect(s?.hits?.length).toBe(1)
    expect(s?.sources?.[0].text).toBe('body')
  })

  it('upserts phase data keyed by (userId, queryHash)', async () => {
    await saveScratchpad('u1', 'DeepSeek R1', 'hits', [{ title: 't', url: 'https://x', snippet: '' }])
    expect(upsert).toHaveBeenCalledTimes(1)
    const arg = upsert.mock.calls[0][0]
    expect(arg.where.userId_queryHash.queryHash).toBe(queryHash('deepseek r1'))
    expect(arg.create.hits.length).toBe(1)
    expect(arg.create.queries).toBeUndefined()
  })

  it('fails open when the DB errors', async () => {
    upsert.mockRejectedValue(new Error('down'))
    findUnique.mockRejectedValue(new Error('down'))
    await expect(saveScratchpad('u1', 'q', 'hits', [])).resolves.toBeUndefined()
    expect(await loadScratchpad('u1', 'q')).toBeNull()
  })
})
