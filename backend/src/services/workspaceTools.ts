import { z } from 'zod'
import type { ToolDefinition } from '../agent/types'
import { assertRunAccess } from '../agent/runAuthorization'
import { connectionToolName, reviewedAdapter } from '../agent/connectors/reviewedAdapters'
import { loadConnectionForExecution } from './workspaceConnections'
import { requireMembership, workspaceDb, WorkspaceError } from './workspaces'
import { publicRequest } from './publicHttp'

export const selectedConnectionIds = z.array(z.string().uuid()).max(8).refine((ids) => new Set(ids).size === ids.length, 'Duplicate connections')

/** Metadata-only construction: credentials are not read until actual dispatch. */
export async function workspaceConnectionTools(userId: string, workspaceId: string, selected: string[]): Promise<ToolDefinition[]> {
  const ids = selectedConnectionIds.parse(selected)
  await requireMembership(userId, workspaceId, 'editor')
  if (!ids.length) return []
  const rows = await workspaceDb().workspaceConnection.findMany({ where: { id: { in: ids }, workspaceId, enabled: true },
    select: { id: true, workspaceId: true, version: true, type: true } })
  if (rows.length !== ids.length) throw new WorkspaceError(404, 'Selected connection is unavailable')
  return ids.map((id) => {
    const row = rows.find((entry) => entry.id === id)!
    const adapter = reviewedAdapter(row.type)
    if (!adapter) throw new WorkspaceError(422, 'Selected connection has no reviewed execution adapter')
    const name = connectionToolName(row.id)
    return {
      name, source: `connection:${row.id}`, description: adapter.description,
      parameters: JSON.parse(JSON.stringify(adapter.parameters)),
      async handler(args, ctx) {
        try {
          const check = async (expectedToken?: string) => {
            await assertRunAccess(ctx, name)
            if (ctx.workspaceId !== row.workspaceId) throw new WorkspaceError(403, 'Connection workspace mismatch')
            const fresh = await loadConnectionForExecution(ctx.userId, row.workspaceId, row.id, row.version)
            if (fresh.row.type !== row.type) throw new WorkspaceError(403, 'Connection type changed')
            if (expectedToken !== undefined && fresh.config.token !== expectedToken) throw new WorkspaceError(403, 'Connection credential changed')
            return fresh.config.token
          }
          const token = await check()
          const request = adapter.build(args, token)
          const response = await publicRequest(request.url, { ...request.options, signal: ctx.signal,
            // DNS can take time: check again just before credentials leave.
            beforeConnect: async () => { await check(request.token) },
          })
          // Withhold results if permission/version changed during the request.
          await check(request.token)
          return { content: adapter.summarize(response, request.token, request.limit) }
        } catch {
          return { content: 'Connection unavailable, access changed, or provider request failed.', isError: true }
        }
      },
    }
  })
}
