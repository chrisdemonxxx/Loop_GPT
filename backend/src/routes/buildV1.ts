/**
 * Public Build Mode API (`/v1/build`, Tier 2-4).
 *
 * Exposes Loop-IT app-building runs under the main `/v1` API surface so external
 * developers can authenticate with `sk-loop-…` API keys or session tokens,
 * mint a short-lived workspace-scoped `LOOPIT-ID` token automatically, and
 * create or inspect Build runs via `loopit-api`.
 */
import express from 'express'
import { z } from 'zod'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateTokenOrApiKey, apiError } from '../middleware/apiAuth'
import { ensurePersonalWorkspace, requireMembership } from '../services/workspaces'
import { loopitRoleForWorkspace, mintLoopitIdentityToken, LoopitIdentityConfigError } from '../services/loopitIdentity'

const router = express.Router()
const buildJson = express.json({ limit: '4mb' })

function loopitApiBaseUrl(): string {
  return (process.env.LOOPIT_API_URL || 'http://loopit-api.railway.internal:8000').replace(/\/+$/, '')
}

const createRunSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  projectId: z.string().trim().min(1).max(200).optional(),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(120).optional(),
})

async function mintCallerLoopitToken(userId: string, workspaceId?: string): Promise<{ token: string; workspaceId: string }> {
  if (workspaceId) {
    const member = await requireMembership(userId, workspaceId, 'editor')
    const role = loopitRoleForWorkspace(member.role)
    const token = mintLoopitIdentityToken({ subject: userId, orgId: workspaceId, role })
    return { token, workspaceId }
  }
  const ws = await ensurePersonalWorkspace(userId)
  const token = mintLoopitIdentityToken({ subject: userId, orgId: ws.id, role: 'owner' })
  return { token, workspaceId: ws.id }
}

/** POST /v1/build/runs — start a new Loop-IT Build run. */
router.post('/runs', authenticateTokenOrApiKey, buildJson, asyncHandler(async (req, res) => {
  const parsed = createRunSchema.safeParse(req.body || {})
  if (!parsed.success) {
    return apiError(res, 400, parsed.error.issues[0]?.message || 'Invalid build run request.', 'invalid_request_error', 'invalid_body')
  }
  const userId = (req as any).userId as string

  let auth: { token: string; workspaceId: string }
  try {
    auth = await mintCallerLoopitToken(userId, parsed.data.workspaceId)
  } catch (err: any) {
    if (err instanceof LoopitIdentityConfigError) {
      return apiError(res, 503, err.message, 'api_error', 'loopit_unconfigured')
    }
    return apiError(res, err?.status || 403, err?.message || 'Workspace access denied.', 'invalid_request_error', 'forbidden')
  }

  try {
    const upstream = await fetch(`${loopitApiBaseUrl()}/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({
        prompt: parsed.data.prompt,
        project_id: parsed.data.projectId,
        model: parsed.data.model,
        org_id: auth.workspaceId,
      }),
    })
    const text = await upstream.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
    return res.status(upstream.status).json(data)
  } catch {
    return apiError(res, 502, 'Build service (loopit-api) is temporarily unreachable.', 'api_error', 'upstream_unreachable')
  }
}))

/** GET /v1/build/runs/:id — inspect a Loop-IT Build run. */
router.get('/runs/:id', authenticateTokenOrApiKey, asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined

  let auth: { token: string; workspaceId: string }
  try {
    auth = await mintCallerLoopitToken(userId, workspaceId)
  } catch (err: any) {
    if (err instanceof LoopitIdentityConfigError) {
      return apiError(res, 503, err.message, 'api_error', 'loopit_unconfigured')
    }
    return apiError(res, err?.status || 403, err?.message || 'Workspace access denied.', 'invalid_request_error', 'forbidden')
  }

  try {
    const upstream = await fetch(`${loopitApiBaseUrl()}/v1/runs/${encodeURIComponent(req.params.id)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
    })
    const text = await upstream.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
    return res.status(upstream.status).json(data)
  } catch {
    return apiError(res, 502, 'Build service (loopit-api) is temporarily unreachable.', 'api_error', 'upstream_unreachable')
  }
}))

export default router
