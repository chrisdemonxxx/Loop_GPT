import type { ToolDefinition } from '../types'
import { prisma } from '../../services/prisma'

/** Remember an explicit fact about the user or project. */
export const rememberTool: ToolDefinition = {
  name: 'remember',
  source: 'builtin',
  description: 'Store a fact or preference the user wants remembered. Memories persist across conversations and are included in future interactions.',
  parameters: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'The fact, preference, or information to remember.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorising (e.g. ["preference", "user_info", "project"]).' },
    },
    required: ['fact'],
  },
  async handler(args, ctx) {
    const content = String(args.fact || '').trim()
    if (!content || content.length > 5000) {
      return { content: 'Memory content must be between 1 and 5000 characters.', isError: true }
    }

    const tags: string[] = Array.isArray(args.tags) ? args.tags.map(String).filter(Boolean) : []
    try {
      await prisma!.memory.create({
        data: {
          userId: ctx.userId,
          kind: 'explicit',
          source: 'agent',
          content,
          tags,
          projectId: ctx.workspaceId || undefined,
        },
      })
      return { content: `Remembered: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"` }
    } catch (e: any) {
      return { content: `Failed to save memory: ${e?.message || e}`, isError: true }
    }
  },
}

/** Retrieve memories relevant to the current context. Used internally.
 * Respects the user's global "use memory across conversations" toggle. */
export async function getMemories(userId: string, limit = 30): Promise<string[]> {
  if (!prisma) return []
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { memoryEnabled: true } })
  if (user && !user.memoryEnabled) return []
  const rows = await prisma.memory.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { content: true, tags: true, kind: true, createdAt: true },
  })
  return rows.map((r) => `[${r.kind}] ${r.content}`)
}
