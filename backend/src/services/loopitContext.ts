/**
 * Read-only project context for Loop-IT's planner.
 * Every query is constrained to the workspace id from the LOOPIT-ID token.
 * This module does not create, update, or delete rows.
 */
import { prisma, hasDb } from './prisma'
import { generateEmbedding } from './embeddingStore'
import { vectorSearch, type VectorHit } from './vectorSearch'

export class LoopitContextError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'LoopitContextError'
  }
}

export interface LoopitKnowledgeHit {
  id: string
  projectId: string
  content: string
  score: number
}

export interface LoopitContext {
  workspaceId: string
  knowledge: { results: LoopitKnowledgeHit[]; engine: 'pgvector' | 'jsonb' | 'none' }
  files: Array<{ id: string; name: string; mimeType: string; size: number; purpose: string; conversationId: string | null; createdAt: string }>
  memories: Array<{ id: string; projectId: string | null; kind: string; source: string; content: string; tags: string[]; createdAt: string; updatedAt: string }>
}

const PROJECT_CAP = 25
const FILE_CAP = 200
const MEMORY_CAP = 200
const CHUNK_CAP = 200

function database() {
  if (!hasDb || !prisma) throw new LoopitContextError(503, 'Project context is temporarily unavailable')
  return prisma
}

function cosine(query: number[], vec: number[]): number {
  if (query.length !== vec.length || query.length === 0) return 0
  let dot = 0
  let left = 0
  let right = 0
  for (let i = 0; i < query.length; i++) {
    dot += query[i] * vec[i]
    left += query[i] * query[i]
    right += vec[i] * vec[i]
  }
  return left && right ? dot / (Math.sqrt(left) * Math.sqrt(right)) : 0
}

async function jsonbSearch(projectId: string, embedding: number[], limit: number): Promise<LoopitKnowledgeHit[]> {
  const chunks = await database().knowledgeChunk.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: CHUNK_CAP,
    select: { id: true, content: true, embedding: true },
  })
  return chunks.flatMap((chunk) => {
    if (!Array.isArray(chunk.embedding) || chunk.embedding.some((value) => typeof value !== 'number')) return []
    const score = cosine(embedding, chunk.embedding as number[])
    return score > 0.1 ? [{ id: chunk.id, projectId, content: chunk.content, score }] : []
  }).sort((a, b) => b.score - a.score).slice(0, limit)
}

async function searchKnowledge(workspaceId: string, query: string | undefined, projectId: string | undefined, limit: number): Promise<LoopitContext['knowledge']> {
  const projects = await database().project.findMany({
    where: { workspaceId, ...(projectId ? { id: projectId } : {}) },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: PROJECT_CAP,
  })
  if (projectId && projects.length === 0) throw new LoopitContextError(404, 'Project not found')
  if (!query || projects.length === 0) return { results: [], engine: 'none' }

  let embedding: number[]
  try {
    embedding = await generateEmbedding(query)
  } catch {
    throw new LoopitContextError(503, 'Knowledge search is temporarily unavailable')
  }

  const hits: LoopitKnowledgeHit[] = []
  let fellBack = false
  for (const project of projects) {
    let ann: VectorHit[] | null
    try {
      ann = await vectorSearch(project.id, embedding, limit)
    } catch {
      ann = null
    }
    if (ann) {
      for (const hit of ann) {
        if (hit.score > 0.1) hits.push({ id: hit.id, projectId: project.id, content: hit.content, score: hit.score })
      }
    } else {
      fellBack = true
      hits.push(...await jsonbSearch(project.id, embedding, limit))
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return { results: hits.slice(0, limit), engine: fellBack ? 'jsonb' : 'pgvector' }
}

export async function readLoopitContext(input: {
  workspaceId: string
  query?: string
  projectId?: string
  limit: number
}): Promise<LoopitContext> {
  const workspaceId = input.workspaceId
  const [knowledge, files, memories] = await Promise.all([
    searchKnowledge(workspaceId, input.query, input.projectId, input.limit),
    database().privateFile.findMany({
      where: { deletedAt: null, conversation: { workspaceId } },
      orderBy: { createdAt: 'desc' },
      take: FILE_CAP,
      select: { id: true, name: true, mimeType: true, size: true, purpose: true, conversationId: true, createdAt: true },
    }),
    database().memory.findMany({
      where: { project: { workspaceId, ...(input.projectId ? { id: input.projectId } : {}) } },
      orderBy: { updatedAt: 'desc' },
      take: MEMORY_CAP,
      select: { id: true, projectId: true, kind: true, source: true, content: true, tags: true, createdAt: true, updatedAt: true },
    }),
  ])
  return {
    workspaceId,
    knowledge,
    files: files.map((file) => ({ ...file, createdAt: file.createdAt.toISOString() })),
    memories: memories.map((memory) => ({
      ...memory,
      createdAt: memory.createdAt.toISOString(),
      updatedAt: memory.updatedAt.toISOString(),
    })),
  }
}
