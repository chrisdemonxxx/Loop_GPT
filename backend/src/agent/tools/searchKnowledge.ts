import type { ToolDefinition } from '../types'
import { prisma } from '../../services/prisma'
import { requireMembership } from '../../services/workspaces'
import { generateEmbedding, rerank } from '../../services/embeddingStore'
import { vectorSearch } from '../../services/vectorSearch'

/** Search the user's project knowledge base. If no projectId is provided,
 * searches all projects the user has access to in the active workspace. */
export const searchKnowledgeTool: ToolDefinition = {
  name: 'search_knowledge',
  source: 'builtin',
  description: 'Search the workspace/project knowledge base for relevant context. Returns cited text chunks.',
  parameters: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Search query.' },
      projectId: { type: 'string', description: 'Optional. Scope to a single project.' },
      limit: { type: 'number', description: 'Max results (1-20, default 5).', default: 5 },
    },
    required: ['q'],
  },
  async handler(args, ctx) {
    const query = String(args.q || '').trim()
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
    // Default to the conversation's project when the model doesn't specify one.
    let projectId = String(args.projectId || '')
    if (!projectId && ctx.conversationId) {
      try {
        const conv = await prisma!.conversation.findUnique({ where: { id: ctx.conversationId }, select: { projectId: true } })
        projectId = conv?.projectId || ''
      } catch { /* fall through to workspace-wide search */ }
    }

    if (!query) return { content: 'A search query is required.', isError: true }

    try {
      const queryVec = await generateEmbedding(query)

      // Single-project scopes use the pgvector ANN index when available.
      if (projectId) {
        const ann = await vectorSearch(projectId, queryVec, limit)
        if (ann && ann.length) {
          const result = ann.filter((r) => r.score > 0.08)
            .map((r) => `(${(r.score * 100).toFixed(0)}% match)\n${r.content.slice(0, 2000)}`).join('\n\n---\n\n')
          if (result) return { content: `Knowledge base results:\n\n${result}`, data: { results: ann, engine: 'pgvector' } }
        }
      }

      const memberships = await prisma!.workspaceMember.findMany({
        where: { userId: ctx.userId, role: { in: ['owner', 'editor', 'viewer'] } },
        select: { workspaceId: true },
      })
      const workspaceIds = memberships.map((m) => m.workspaceId)

      let chunks = await prisma!.knowledgeChunk.findMany({
        where: projectId
          ? { projectId, project: { workspaceId: { in: workspaceIds } } }
          : { project: { workspaceId: { in: workspaceIds } } },
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, content: true, projectId: true, embedding: true, project: { select: { name: true } } },
      })

      // Cosine similarity scoring
      const scored = chunks
        .filter((c) => Array.isArray(c.embedding))
        .map((c) => {
          const vec = c.embedding as number[]
          let dot = 0, nA = 0, nB = 0
          for (let i = 0; i < queryVec.length; i++) {
            dot += queryVec[i] * vec[i]
            nA += queryVec[i] * queryVec[i]
            nB += vec[i] * vec[i]
          }
          const score = nA && nB ? dot / (Math.sqrt(nA) * Math.sqrt(nB)) : 0
          return { id: c.id, content: c.content.slice(0, 2000), score, project: c.project.name }
        })
        .filter((r) => r.score > 0.08)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)

      if (scored.length === 0) return { content: 'No relevant knowledge found in the knowledge base.' }

      const result = scored.map((r) => `[${r.project}] (${(r.score * 100).toFixed(0)}% match)\n${r.content}`).join('\n\n---\n\n')
      return { content: `Knowledge base results:\n\n${result}`, data: { results: scored } }
    } catch (e: any) {
      return { content: `Knowledge search failed: ${e?.message || e}`, isError: true }
    }
  },
}
