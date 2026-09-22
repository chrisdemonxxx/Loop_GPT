import express from 'express'
import { z } from 'zod'
import { prisma } from '../services/prisma'
import { requireMembership } from '../services/workspaces'
import { authenticateToken } from './auth'
import { asyncHandler } from '../middleware/errorLogger'
import { generateEmbedding } from '../services/embeddingStore'
import { indexEmbedding, vectorSearch } from '../services/vectorSearch'

export const projectRouter = express.Router()
projectRouter.use(authenticateToken)

const projectInput = z.object({
  name: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(5000).default(''),
}).strict()

const projectUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  instructions: z.string().trim().max(5000).optional(),
}).strict()

/** List projects in a workspace. */
projectRouter.get('/:workspaceId/projects', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  await requireMembership(userId, workspaceId, 'viewer')
  const projects = await prisma!.project.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, role: true, instructions: true, createdAt: true, updatedAt: true,
      _count: { select: { knowledgeChunks: true, conversations: true } } },
  })
  res.json(projects)
}))

/** Create a project in a workspace. */
projectRouter.post('/:workspaceId/projects', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  await requireMembership(userId, workspaceId, 'owner')
  const input = projectInput.parse(req.body)
  const project = await prisma!.project.create({
    data: { workspaceId, name: input.name, instructions: input.instructions, role: 'owner' },
  })
  await prisma!.workspaceAuditEvent.create({ data: { workspaceId, actorId: userId, action: 'project.created', resourceId: project.id } })
  res.status(201).json(project)
}))

/** Update a project. */
projectRouter.patch('/:workspaceId/projects/:projectId', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  const projectId = req.params.projectId
  await requireMembership(userId, workspaceId, 'editor')
  const input = projectUpdateInput.parse(req.body)
  const project = await prisma!.project.update({ where: { id: projectId }, data: input })
  res.json(project)
}))

/** Delete a project and its knowledge base. */
projectRouter.delete('/:workspaceId/projects/:projectId', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  const projectId = req.params.projectId
  await requireMembership(userId, workspaceId, 'owner')
  await prisma!.knowledgeChunk.deleteMany({ where: { projectId } })
  await prisma!.project.delete({ where: { id: projectId } })
  await prisma!.workspaceAuditEvent.create({ data: { workspaceId, actorId: userId, action: 'project.deleted', resourceId: projectId } })
  res.status(204).end()
}))

/** Ingest text into the project knowledge base (chunks → embed → store). */
projectRouter.post('/:workspaceId/projects/:projectId/ingest', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  const projectId = req.params.projectId
  await requireMembership(userId, workspaceId, 'editor')

  const { text } = z.object({ text: z.string().min(1).max(500_000) }).parse(req.body)

  // Chunk the text into paragraphs or by character limit (5K per chunk).
  const CHUNK_SIZE = 5000
  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0)
  const chunks: string[] = []
  let current = ''
  for (const p of paragraphs) {
    if ((current + '\n\n' + p).length > CHUNK_SIZE && current) {
      chunks.push(current.trim())
      current = p
    } else {
      current = (current ? current + '\n\n' : '') + p
    }
  }
  if (current.trim()) chunks.push(current.trim())
  if (chunks.length === 0) return res.status(400).json({ error: 'No content to ingest.' })

  // Embed and store each chunk in sequence (parallel would be faster but
  // embedding API rate-limits generously; sequential is fine for the MVP).
  let inserted = 0
  for (const chunk of chunks) {
    try {
      const embedding = await generateEmbedding(chunk)
      const row = await prisma!.knowledgeChunk.create({
        data: { projectId, content: chunk, embedding },
      })
      // Mirror into the pgvector column when the extension is present.
      await indexEmbedding(row.id, embedding)
      inserted++
    } catch {
      // Skip chunks that fail embedding (individual failures leave the
      // rest of the ingest intact).
    }
  }

  res.json({ inserted, total: chunks.length, projectId })
}))

/** Search the project's knowledge base. Returns reranked chunks. */
projectRouter.get('/:workspaceId/projects/:projectId/search', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  const projectId = req.params.projectId
  await requireMembership(userId, workspaceId, 'viewer')

  const query = z.string().min(1).max(2000).parse(req.query.q)
  const topK = Math.min(Math.max(Number(req.query.limit) || 5, 1), 20)

  // Embed the query using the same embedding service.
  const queryEmbedding = await generateEmbedding(query)

  // Prefer the pgvector ANN index; fall back to in-app cosine when absent.
  const ann = await vectorSearch(projectId, queryEmbedding, topK)
  if (ann) {
    return res.json({ results: ann.filter((r) => r.score > 0.1), engine: 'pgvector' })
  }

  // Fetch all chunks for the project and compute cosine similarity in memory.
  // For production with pgvector, this would be a SQL ORDER BY with <=>
  // operator. With jsonb storage, we compute in the application layer.
  const chunks = await prisma!.knowledgeChunk.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take: 200, // max candidates
  })

  const scored = chunks
    .filter((c) => Array.isArray(c.embedding) && (c.embedding as number[]).length === queryEmbedding.length)
    .map((c) => {
      const vec = c.embedding as number[]
      // Cosine similarity
      let dot = 0, nA = 0, nB = 0
      for (let i = 0; i < queryEmbedding.length; i++) {
        dot += queryEmbedding[i] * vec[i]
        nA += queryEmbedding[i] * queryEmbedding[i]
        nB += vec[i] * vec[i]
      }
      const similarity = nA && nB ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0
      return { id: c.id, content: c.content, score: similarity }
    })
    .filter((r) => r.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  res.json({ results: scored, engine: 'jsonb' })
}))
