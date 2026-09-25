import { describe, expect, it } from 'vitest'
import { indexEmbedding, vectorSearch } from '../vectorSearch'

// Unit env has no DATABASE_URL, so prisma is null and both helpers must
// degrade gracefully (the callers then use in-app cosine similarity).
describe('pgvector search (no database)', () => {
  it('returns null from ANN search instead of throwing', async () => {
    expect(await vectorSearch('project', [0.1, 0.2, 0.3], 5)).toBeNull()
  })

  it('returns false from indexing instead of throwing', async () => {
    expect(await indexEmbedding('chunk', [0.1, 0.2, 0.3])).toBe(false)
  })

  it('handles empty embeddings', async () => {
    expect(await vectorSearch('project', [], 5)).toBeNull()
    expect(await indexEmbedding('chunk', [])).toBe(false)
  })
})
