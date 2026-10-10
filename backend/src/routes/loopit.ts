import express from 'express'
import { z } from 'zod'
import { authenticateToken } from './auth'
import { prisma } from '../services/prisma'
import { DailyCreditError } from '../services/dailyReservations'
import { LoopitContextError, readLoopitContext } from '../services/loopitContext'
import {
  LOOPIT_METER_KINDS,
  LoopitUsageError,
  recordLoopitUsage,
  type LoopitUsageEvent,
} from '../services/loopitUsage'
import {
  LOOPIT_IDENTITY_TTL_SECONDS,
  LoopitIdentityConfigError,
  VerifiedLoopitIdentity,
  WorkspaceMemberRole,
  loopitRoleForWorkspace,
  mintLoopitIdentityToken,
  verifyLoopitIdentityToken,
} from '../services/loopitIdentity'

const router = express.Router()
const bodySchema = z.object({
  workspaceId: z.string().trim().min(1).max(200).optional(),
}).strict()

const WORKSPACE_ROLES = ['owner', 'editor', 'viewer'] as const

function isWorkspaceRole(role: string): role is WorkspaceMemberRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(role)
}

type ResolvedMembership = { workspaceId: string; role: WorkspaceMemberRole }

/**
 * Optional workspaceId selects that membership. Otherwise the personal
 * workspace is primary, then the oldest membership.
 * A missing membership is null (403). A missing database throws.
 */
async function resolveMembership(userId: string, workspaceId: string | undefined): Promise<ResolvedMembership | null> {
  if (!prisma) throw new LoopitIdentityConfigError('Loop-IT tokens require a database')
  if (workspaceId) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, workspaceId: true },
    })
    if (!member || !isWorkspaceRole(member.role)) return null
    return { workspaceId: member.workspaceId, role: member.role }
  }
  const personal = await prisma.workspace.findUnique({
    where: { personalOwnerId: userId },
    select: { id: true },
  })
  if (personal) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: personal.id, userId } },
      select: { role: true },
    })
    if (member && isWorkspaceRole(member.role)) return { workspaceId: personal.id, role: member.role }
  }
  const fallback = await prisma.workspaceMember.findFirst({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { workspaceId: 'asc' }],
    select: { workspaceId: true, role: true },
  })
  if (!fallback || !isWorkspaceRole(fallback.role)) return null
  return { workspaceId: fallback.workspaceId, role: fallback.role }
}

router.post('/token', authenticateToken, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const parsed = bodySchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid token request' })
    return
  }
  const userId = (req as express.Request & { userId?: string }).userId
  if (!userId) {
    res.status(401).json({ error: 'No token provided' })
    return
  }
  try {
    const membership = await resolveMembership(userId, parsed.data.workspaceId)
    if (!membership) {
      res.status(403).json({ error: 'Not a member of this workspace' })
      return
    }
    const role = loopitRoleForWorkspace(membership.role)
    const accessToken = mintLoopitIdentityToken({
      subject: userId,
      orgId: membership.workspaceId,
      role,
    })
    // Two vocabularies, one response: `access_token`/`expires_in` (OAuth style,
    // the original contract) and `token`/`expiresAt` (what the web client's
    // createTokenStore parses). Both must stay present — the seam test pins
    // them together so the browser mint can never drift from this route again.
    const expiresAt = new Date(Date.now() + LOOPIT_IDENTITY_TTL_SECONDS * 1000).toISOString()
    res.json({
      access_token: accessToken,
      token: accessToken,
      token_type: 'bearer',
      expires_in: LOOPIT_IDENTITY_TTL_SECONDS,
      expiresAt,
      org: membership.workspaceId,
      role,
    })
  } catch (error) {
    if (error instanceof LoopitIdentityConfigError) {
      res.status(503).json({ error: error.message })
      return
    }
    if (!res.headersSent) res.status(503).json({ error: 'Loop-IT token issuance is temporarily unavailable' })
  }
})

type IdentityRequest = express.Request & { loopitIdentity?: VerifiedLoopitIdentity }

/** LOOPIT-ID bearer auth. Session JWTs are not accepted on these routes. */
function requireLoopitIdentity(req: express.Request, res: express.Response, next: express.NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' })
    return
  }
  try {
    (req as IdentityRequest).loopitIdentity = verifyLoopitIdentityToken(header.slice('Bearer '.length).trim())
    next()
  } catch (error) {
    if (error instanceof LoopitIdentityConfigError) {
      res.status(503).json({ error: error.message })
      return
    }
    res.status(401).json({ error: 'Invalid identity token' })
  }
}

function queryValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

const contextQuery = z.object({
  q: z.string().trim().min(1).max(2000).optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
})

const usageBody = z.object({
  idempotencyKey: z.string().trim().min(1).max(200),
  kind: z.enum(LOOPIT_METER_KINDS),
  model: z.string().trim().min(1).max(200).optional(),
  inputTokens: z.number().int().min(0).max(2_000_000_000).optional(),
  outputTokens: z.number().int().min(0).max(2_000_000_000).optional(),
  cachedInputTokens: z.number().int().min(0).max(2_000_000_000).optional(),
  sandboxSeconds: z.number().int().min(0).max(2_000_000_000).optional(),
  hostingSeconds: z.number().int().min(0).max(2_000_000_000).optional(),
  storageGbMonths: z.number().finite().min(0).max(1_000_000).optional(),
  customDomainMonths: z.number().finite().min(0).max(1_000_000).optional(),
  runId: z.string().trim().min(1).max(200).optional(),
  tenantId: z.string().trim().min(1).max(200).optional(),
}).strict()

/** Read-only planner context. Org scope is the token's workspace, never the query. */
router.get('/context', requireLoopitIdentity, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const identity = (req as IdentityRequest).loopitIdentity
  if (!identity) {
    res.status(401).json({ error: 'No token provided' })
    return
  }
  const parsed = contextQuery.safeParse({
    q: queryValue(req.query.q),
    projectId: queryValue(req.query.projectId),
    limit: queryValue(req.query.limit),
  })
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid context request' })
    return
  }
  try {
    const context = await readLoopitContext({
      workspaceId: identity.org,
      query: parsed.data.q,
      projectId: parsed.data.projectId,
      limit: parsed.data.limit ?? 5,
    })
    res.json(context)
  } catch (error) {
    if (error instanceof LoopitContextError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    if (!res.headersSent) res.status(503).json({ error: 'Project context is temporarily unavailable' })
  }
})

/** Meter a Loop-IT usage event against the token workspace's owner. No other org. */
router.post('/usage', requireLoopitIdentity, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  const identity = (req as IdentityRequest).loopitIdentity
  if (!identity) {
    res.status(401).json({ error: 'No token provided' })
    return
  }
  const parsed = usageBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid usage event' })
    return
  }
  if (parsed.data.tenantId && parsed.data.tenantId !== identity.org) {
    res.status(403).json({ error: 'Workspace mismatch' })
    return
  }
  const event: LoopitUsageEvent = {
    idempotencyKey: parsed.data.idempotencyKey,
    kind: parsed.data.kind,
    model: parsed.data.model,
    inputTokens: parsed.data.inputTokens ?? 0,
    outputTokens: parsed.data.outputTokens ?? 0,
    cachedInputTokens: parsed.data.cachedInputTokens ?? 0,
    sandboxSeconds: parsed.data.sandboxSeconds ?? 0,
    hostingSeconds: parsed.data.hostingSeconds ?? 0,
    storageGbMonths: parsed.data.storageGbMonths ?? 0,
    customDomainMonths: parsed.data.customDomainMonths ?? 0,
    runId: parsed.data.runId,
  }
  try {
    const recorded = await recordLoopitUsage(identity.org, event)
    res.json({
      workspaceId: identity.org,
      ownerId: recorded.ownerId,
      reservationId: recorded.reservationId,
      credits: recorded.credits,
      duplicate: recorded.duplicate,
    })
  } catch (error) {
    if (error instanceof LoopitUsageError || error instanceof DailyCreditError) {
      res.status(error.status).json({ error: error.message })
      return
    }
    if (!res.headersSent) res.status(503).json({ error: 'Usage recording is temporarily unavailable' })
  }
})

export default router
