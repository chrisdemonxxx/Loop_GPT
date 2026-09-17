import { randomUUID } from 'crypto'
import { z } from 'zod'
import { CONNECTOR_CATALOG } from '../agent/connectors/catalog'
import { isReviewedConnector } from '../agent/connectors/reviewedAdapters'
import { encryptConnectionConfig, decryptConnectionConfig } from './credentialVault'
import { requireMembership, workspaceDb, workspaceTransaction, WorkspaceError } from './workspaces'

// Customer-selected destinations and OAuth are not routed through the legacy
// generic HTTP factory. Only fixed-origin catalog adapters are enabled here.
export function connectionCatalog() {
  return CONNECTOR_CATALOG.map((entry) => ({ type: entry.type, name: entry.name,
    description: entry.description, category: entry.category, fields: entry.fields || [],
    configurationSupported: !entry.oauth && !!entry.tools?.length && !!entry.baseUrl?.startsWith('https://') && !entry.baseUrl.includes('{'),
    executionEnabled: isReviewedConnector(entry.type),
    requiresOAuth: !!entry.oauth,
  }))
}

export const connectionInput = z.object({
  type: z.string().min(1).max(80), name: z.string().trim().min(1).max(100),
  config: z.record(z.string().max(8000)), enabled: z.boolean().default(true),
}).strict()

export const connectionIdSchema = z.string().uuid()
export const connectionVersion = z.number().int().min(1).max(2147483646)

function validateConfig(type: string, config: Record<string, string>) {
  const def = connectionCatalog().find((entry) => entry.type === type)
  if (!def?.configurationSupported) throw new WorkspaceError(422, 'Connector configuration is not supported yet')
  const fields = new Set(def.fields.map((field) => field.key))
  if (Object.keys(config).some((key) => !fields.has(key))) throw new WorkspaceError(400, 'Unknown connector configuration field')
  for (const field of def.fields) {
    if (field.required && !config[field.key]?.trim()) throw new WorkspaceError(400, `Missing connector field: ${field.key}`)
  }
}

export function connectionSummary(row: { id: string; workspaceId: string; type: string; name: string; enabled: boolean; version: number; configuredFields: string[] }) {
  return { id: row.id, workspaceId: row.workspaceId, type: row.type, name: row.name,
    enabled: row.enabled, version: row.version, configuredFields: row.configuredFields }
}

export async function saveConnection(actorId: string, workspaceId: string, input: z.infer<typeof connectionInput>, id?: string, expectedVersion?: number) {
  await requireMembership(actorId, workspaceId, 'owner')
  input = connectionInput.parse(input)
  // Prisma omits undefined predicates: never let a missing version bypass CAS.
  if (id !== undefined) {
    connectionIdSchema.parse(id)
    connectionVersion.parse(expectedVersion)
  } else if (expectedVersion !== undefined) throw new WorkspaceError(400, 'Version is only valid for updates')
  validateConfig(input.type, input.config)
  const connectionId = id || randomUUID()
  const encryptedConfig = encryptConnectionConfig(workspaceId, connectionId, input.config)
  return workspaceTransaction(async (tx) => {
    const actor = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: actorId } } })
    if (actor?.role !== 'owner') throw new WorkspaceError(403, 'Workspace owner required')
    let row
    const data = { type: input.type, name: input.name, enabled: input.enabled, encryptedConfig, configuredFields: Object.keys(input.config).sort() }
    if (id) {
      const result = await tx.workspaceConnection.updateMany({ where: { id, workspaceId, version: expectedVersion }, data: { ...data, version: { increment: 1 } } })
      if (result.count !== 1) throw new WorkspaceError(409, 'Connection changed or is unavailable; reload before updating')
      row = await tx.workspaceConnection.findUniqueOrThrow({ where: { id } })
    } else row = await tx.workspaceConnection.create({ data: { id: connectionId, workspaceId, ...data } })
    await tx.workspaceAuditEvent.create({ data: { workspaceId, actorId, action: id ? 'connection.updated' : 'connection.created', resourceId: connectionId } })
    return connectionSummary(row)
  })
}

export async function deleteConnection(actorId: string, workspaceId: string, id: string) {
  await requireMembership(actorId, workspaceId, 'owner')
  connectionIdSchema.parse(id)
  await workspaceTransaction(async (tx) => {
    const actor = await tx.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId: actorId } } })
    if (actor?.role !== 'owner') throw new WorkspaceError(403, 'Workspace owner required')
    const deleted = await tx.workspaceConnection.deleteMany({ where: { id, workspaceId } })
    if (!deleted.count) throw new WorkspaceError(404, 'Connection not found')
    await tx.workspaceAuditEvent.create({ data: { workspaceId, actorId, action: 'connection.deleted', resourceId: id } })
  })
}

export async function loadConnectionForExecution(userId: string, workspaceId: string, id: string, version: number) {
  await requireMembership(userId, workspaceId, 'editor')
  connectionIdSchema.parse(id)
  // The last supported update may increment to PostgreSQL's maximum Int value.
  // It remains readable even though no further version increment is possible.
  z.number().int().min(1).max(2147483647).parse(version)
  const row = await workspaceDb().workspaceConnection.findFirst({ where: { id, workspaceId, version, enabled: true,
    workspace: { members: { some: { userId, role: { in: ['owner', 'editor'] } } } },
  } })
  if (!row) throw new WorkspaceError(403, 'Connection has been disabled, rotated, or removed')
  return { row, config: decryptConnectionConfig(workspaceId, id, row.encryptedConfig) }
}
