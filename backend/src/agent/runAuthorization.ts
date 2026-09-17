import type { ToolContext, ToolDefinition } from './types'
import { WorkspaceError, workspaceDb } from '../services/workspaces'

interface RunGrant {
  userId: string
  conversationId: string
  workspaceId: string
  signal?: AbortSignal
  tools: ReadonlyMap<string, ToolDefinition>
}

// Authority is server-private, not a field a request/model can manufacture.
// Spreading/serializing a context does not copy its grant.
const grants = new WeakMap<ToolContext, RunGrant>()

function grantFor(ctx: ToolContext): RunGrant {
  const grant = grants.get(ctx)
  if (!grant || ctx.userId !== grant.userId || ctx.conversationId !== grant.conversationId || ctx.workspaceId !== grant.workspaceId) {
    throw new WorkspaceError(403, 'Run context is not authorized')
  }
  return grant
}

async function checkAccess(grant: RunGrant) {
  if (grant.signal?.aborted) throw new WorkspaceError(409, 'Run cancelled')
  const conversation = await workspaceDb().conversation.findFirst({ where: {
    id: grant.conversationId, userId: grant.userId, workspaceId: grant.workspaceId,
    workspace: { members: { some: { userId: grant.userId, role: { in: ['owner', 'editor'] } } } },
  }, select: { id: true } })
  if (!conversation) throw new WorkspaceError(403, 'Run access was revoked or is unavailable')
  if (grant.signal?.aborted) throw new WorkspaceError(409, 'Run cancelled')
}

/** Internal issuance only: callers supply reviewed server-side definitions. */
export async function authorizeRunContext(ctx: ToolContext, workspaceId: string, tools: ToolDefinition[]): Promise<ToolContext> {
  if (!ctx.userId || !ctx.conversationId || !workspaceId) throw new WorkspaceError(403, 'Run identity is required')
  const grant: RunGrant = { userId: ctx.userId, conversationId: ctx.conversationId, workspaceId, signal: ctx.signal,
    tools: new Map(tools.map((tool) => [tool.name, Object.freeze({ ...tool,
      parameters: JSON.parse(JSON.stringify(tool.parameters)),
    })])),
  }
  await checkAccess(grant)
  const authorized = { ...ctx, workspaceId }
  grants.set(authorized, grant)
  return authorized
}

/** An execution may narrow an issued grant, never broaden it. Omitted = none. */
export function restrictRunContext(ctx: ToolContext, names: string[] = []): ToolContext {
  const grant = grantFor(ctx)
  const selected = new Map<string, ToolDefinition>()
  for (const name of names) {
    const tool = grant.tools.get(name)
    if (!tool) throw new WorkspaceError(403, 'Requested tool is not permitted for this run')
    selected.set(name, tool)
  }
  const restricted = { ...ctx }
  grants.set(restricted, { ...grant, tools: selected })
  return restricted
}

export async function assertRunAccess(ctx: ToolContext, toolName?: string): Promise<void> {
  const grant = grantFor(ctx)
  if (toolName !== undefined && !grant.tools.has(toolName)) throw new WorkspaceError(403, 'Tool is not permitted for this run')
  await checkAccess(grant)
}

export function grantedTools(ctx: ToolContext): ToolDefinition[] {
  return [...grantFor(ctx).tools.values()].map((tool) => ({ ...tool, parameters: JSON.parse(JSON.stringify(tool.parameters)) }))
}

export function grantedTool(ctx: ToolContext, name: string): ToolDefinition | undefined {
  return grantedTools(ctx).find((tool) => tool.name === name)
}
