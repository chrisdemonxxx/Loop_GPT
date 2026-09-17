import express from 'express'
import { z } from 'zod'
import { authenticateToken } from './auth'
import { changeMembership, createWorkspace, ensurePersonalWorkspace, requireMembership, workspaceDb, WorkspaceError, workspaceName } from '../services/workspaces'
import { connectionCatalog, connectionInput, connectionSummary, connectionVersion, deleteConnection, saveConnection } from '../services/workspaceConnections'
import { workspaceConnectionTools } from '../services/workspaceTools'

const router = express.Router()
const pageQuery = z.object({ after: z.string().min(1).max(160).optional() }).strict()
const updateInput = connectionInput.extend({ expectedVersion: connectionVersion })

// Express 4 does not catch rejected async handlers. Also avoid passing vault or
// Prisma errors to general error logging, where request bodies could leak keys.
function handle(action: (req: express.Request, res: express.Response) => Promise<unknown>): express.RequestHandler {
  return (req, res) => { void action(req, res).catch((error) => {
    res.setHeader('Cache-Control', 'no-store')
    if (error instanceof z.ZodError) { res.status(400).json({ error: 'Invalid workspace request' }); return }
    if (error instanceof WorkspaceError) { res.status(error.status).json({ error: error.message }); return }
    res.status(500).json({ error: 'Workspace operation failed' })
  }) }
}
function actor(req: express.Request): string { return (req as any).userId }

router.use(authenticateToken)
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })
router.use(express.json({ limit: '64kb' }))

router.get('/', handle(async (req, res) => {
  const { after } = pageQuery.parse(req.query)
  const rows = await workspaceDb().workspaceMember.findMany({ where: { userId: actor(req), ...(after ? { workspaceId: { gt: after } } : {}) },
    orderBy: { workspaceId: 'asc' }, take: 101, select: { role: true, workspace: { select: { id: true, name: true, personalOwnerId: true, createdAt: true } } } })
  res.json({ workspaces: rows.slice(0, 100).map(({ role, workspace }) => ({ ...workspace, role })), nextCursor: rows.length > 100 ? rows[99].workspace.id : null })
}))

router.post('/personal', handle(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {})
  res.json({ workspace: await ensurePersonalWorkspace(actor(req)) })
}))

router.post('/', handle(async (req, res) => {
  const { name } = z.object({ name: workspaceName }).strict().parse(req.body)
  res.status(201).json({ workspace: await createWorkspace(actor(req), name) })
}))

router.get('/:workspaceId/connections/catalog', handle(async (req, res) => {
  await requireMembership(actor(req), req.params.workspaceId)
  res.json({ connectors: connectionCatalog() })
}))

router.get('/:workspaceId/connections', handle(async (req, res) => {
  await requireMembership(actor(req), req.params.workspaceId)
  const { after } = pageQuery.parse(req.query)
  // Do not even select ciphertext for management responses.
  const rows = await workspaceDb().workspaceConnection.findMany({ where: { workspaceId: req.params.workspaceId, ...(after ? { id: { gt: after } } : {}) },
    orderBy: { id: 'asc' }, take: 101, select: { id: true, workspaceId: true, type: true, name: true, enabled: true, version: true, configuredFields: true } })
  res.json({ connections: rows.slice(0, 100).map(connectionSummary), nextCursor: rows.length > 100 ? rows[99].id : null })
}))

router.post('/:workspaceId/connections', handle(async (req, res) => {
  const input = connectionInput.parse(req.body)
  res.status(201).json({ connection: await saveConnection(actor(req), req.params.workspaceId, input) })
}))

router.get('/:workspaceId/connections/:connectionId/tools', handle(async (req, res) => {
  const tools = await workspaceConnectionTools(actor(req), req.params.workspaceId, [req.params.connectionId])
  res.json({ tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters, readOnly: true })) })
}))

// Full credential replacement, never a merge with partially hidden fields.
router.put('/:workspaceId/connections/:connectionId', handle(async (req, res) => {
  const { expectedVersion, ...input } = updateInput.parse(req.body)
  res.json({ connection: await saveConnection(actor(req), req.params.workspaceId, input, req.params.connectionId, expectedVersion) })
}))

router.delete('/:workspaceId/connections/:connectionId', handle(async (req, res) => {
  await deleteConnection(actor(req), req.params.workspaceId, req.params.connectionId)
  res.status(204).end()
}))

router.get('/:workspaceId/members', handle(async (req, res) => {
  await requireMembership(actor(req), req.params.workspaceId)
  const { after } = pageQuery.parse(req.query)
  const rows = await workspaceDb().workspaceMember.findMany({ where: { workspaceId: req.params.workspaceId, ...(after ? { userId: { gt: after } } : {}) },
    orderBy: { userId: 'asc' }, take: 101, select: { userId: true, role: true, createdAt: true } })
  res.json({ members: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99].userId : null })
}))

router.patch('/:workspaceId/members/:userId', handle(async (req, res) => {
  const { role } = z.object({ role: z.enum(['editor', 'viewer']) }).strict().parse(req.body)
  await changeMembership(actor(req), req.params.workspaceId, req.params.userId, role)
  res.status(204).end()
}))

router.delete('/:workspaceId/members/:userId', handle(async (req, res) => {
  await changeMembership(actor(req), req.params.workspaceId, req.params.userId, null)
  res.status(204).end()
}))

router.get('/:workspaceId/audit', handle(async (req, res) => {
  await requireMembership(actor(req), req.params.workspaceId, 'owner')
  const { after } = pageQuery.parse(req.query)
  const rows = await workspaceDb().workspaceAuditEvent.findMany({ where: { workspaceId: req.params.workspaceId, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 101 })
  res.json({ events: rows.slice(0, 100), nextCursor: rows.length > 100 ? rows[99].id : null })
}))

router.use((_req, res) => { res.status(404).json({ error: 'Workspace endpoint not found' }) })
const parseErrorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
  res.setHeader('Cache-Control', 'no-store')
  const status = error?.type === 'entity.too.large' ? 413 : 400
  res.status(status).json({ error: status === 413 ? 'Workspace request too large' : 'Invalid workspace request' })
}
router.use(parseErrorHandler)

export default router
