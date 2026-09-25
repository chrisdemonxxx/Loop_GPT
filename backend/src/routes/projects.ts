import express from 'express'
import { z } from 'zod'
import multer from 'multer'
import { prisma } from '../services/prisma'
import { requireMembership } from '../services/workspaces'
import { authenticateToken } from './auth'
import { asyncHandler } from '../middleware/errorLogger'
import { generateEmbedding } from '../services/embeddingStore'
import { indexEmbedding, vectorSearch } from '../services/vectorSearch'
import { extractDocumentText, MAX_DOC_BYTES } from '../services/documentText'

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

/** Chunk → embed → store. Shared by the text and file ingest endpoints. */
async function ingestText(projectId: string, text: string) {
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
  if (chunks.length === 0) throw Object.assign(new Error('No content to ingest.'), { status: 400 })

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
  return { inserted, total: chunks.length }
}

/** Ingest text into the project knowledge base (chunks → embed → store). */
projectRouter.post('/:workspaceId/projects/:projectId/ingest', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  const projectId = req.params.projectId
  await requireMembership(userId, workspaceId, 'editor')

  const { text } = z.object({ text: z.string().min(1).max(500_000) }).parse(req.body)
  const result = await ingestText(projectId, text)
  res.json({ ...result, projectId })
}))

/** Ingest an uploaded document (PDF/DOCX/XLSX/CSV/TXT/MD) into project
 * knowledge — server-side extraction, same chunk → embed → store pipeline. */
const ingestUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1, fields: 0, parts: 1 } })
projectRouter.post('/:workspaceId/projects/:projectId/ingest-file', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.params.workspaceId
  const projectId = req.params.projectId
  await requireMembership(userId, workspaceId, 'editor')

  await new Promise<void>((resolve, reject) => {
    ingestUpload.single('file')(req as any, res as any, (err: any) => (err ? reject(Object.assign(new Error(err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds the 15MB limit.' : 'Invalid upload.'), { status: 413 })) : resolve()))
  })
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' })
  try {
    const extracted = await extractDocumentText(req.file.buffer, req.file.originalname)
    if (extracted.chars < 40) return res.status(422).json({ error: 'No extractable text found in this document (scanned PDFs without a text layer are not supported yet).' })
    const result = await ingestText(projectId, extracted.text)
    res.json({ ...result, kind: extracted.kind, truncated: extracted.truncated, name: req.file.originalname, projectId })
  } catch (e: any) {
    res.status(e?.status || 500).json({ error: e?.message || 'Extraction failed.' })
  }
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
