/**
 * pgvector-backed nearest-neighbour search for project knowledge (GAP-028).
 *
 * The embedding is also stored as jsonb, so the app keeps working when the
 * `vector` extension is unavailable. Callers try this first and fall back to
 * in-application cosine similarity when it returns null.
 */
import { prisma } from './prisma'

export interface VectorHit { id: string; content: string; score: number }

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.map((n) => (Number.isFinite(n) ? n : 0)).join(',')}]`
}

/** Persist the embedding into the pgvector column (best-effort). */
export async function indexEmbedding(chunkId: string, embedding: number[]): Promise<boolean> {
  if (!prisma || !embedding?.length) return false
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "KnowledgeChunk" SET "embeddingVec" = $1::vector WHERE "id" = $2`,
      toVectorLiteral(embedding), chunkId,
    )
    return true
  } catch {
    // Extension absent (or column missing): the jsonb copy still serves.
    return false
  }
}

/** ANN search within a project. Returns null when pgvector is unavailable. */
export async function vectorSearch(projectId: string, embedding: number[], topK = 5): Promise<VectorHit[] | null> {
  if (!prisma || !embedding?.length) return null
  try {
    const literal = toVectorLiteral(embedding)
    const rows = await prisma.$queryRawUnsafe<VectorHit[]>(
      `SELECT "id", "content", 1 - ("embeddingVec" <=> $1::vector) AS score
         FROM "KnowledgeChunk"
        WHERE "projectId" = $2 AND "embeddingVec" IS NOT NULL
        ORDER BY "embeddingVec" <=> $1::vector
        LIMIT $3`,
      literal, projectId, Math.min(Math.max(topK, 1), 50),
    )
    return Array.isArray(rows) ? rows.map((r) => ({ id: r.id, content: r.content, score: Number(r.score) })) : null
  } catch {
    return null
  }
}
