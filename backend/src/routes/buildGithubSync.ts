/**
 * Phase 2.3 — GitHub App / OAuth stub for Build Mode two-way sync.
 *
 * Reuses the Loop-GPT connector vault pattern (WorkspaceConnection + AES-GCM).
 * No live GitHub App secrets are required: when GITHUB_CLIENT_ID is unset the
 * endpoint returns a documented stub payload so the UI and engine can bind a
 * fake remote offline. When the platform GitHub OAuth app is configured, this
 * redirects into the existing /api/oauth-connector flow for type=github.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { PLATFORM_OAUTH_PROVIDERS } from '../agent/connectors/oauthProviders'

export const buildGithubSyncRouter = express.Router()

buildGithubSyncRouter.get(
  '/connect',
  authenticateToken,
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : ''
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : ''
    const clientId = process.env.GITHUB_CLIENT_ID?.trim()
    const hasGithub = Boolean(clientId && PLATFORM_OAUTH_PROVIDERS.github)

    if (!hasGithub) {
      res.json({
        mode: 'stub',
        message:
          'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET for live connect, ' +
          'or bind a fake remote via POST /api/loopit/projects/:id/git/bind (engine). ' +
          'For live pushes set LOOPIT_GITHUB_TOKEN on the Loop-IT API, or store a vault token via Connectors → GitHub.',
        projectId: projectId || null,
        workspaceId: workspaceId || null,
        authorizeUrl: null,
        docs: {
          env: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'LOOPIT_GITHUB_TOKEN', 'LOOPIT_GITSYNC_PROVIDER=github'],
          connector: 'Settings → Connectors → GitHub (workspace vault)',
          engineBind: 'POST /api/loopit/projects/{projectId}/git/bind',
        },
      })
      return
    }

    // Live path: send the browser into the existing connector OAuth init.
    const redirectTo =
      typeof req.query.redirectTo === 'string' && req.query.redirectTo.startsWith('/')
        ? req.query.redirectTo
        : `/build/projects/${projectId ? `?id=${encodeURIComponent(projectId)}` : ''}`
    const initUrl = new URL('/api/oauth-connector/init', `${req.protocol}://${req.get('host')}`)
    initUrl.searchParams.set('type', 'github')
    if (workspaceId) initUrl.searchParams.set('workspaceId', workspaceId)
    initUrl.searchParams.set('redirectTo', redirectTo)

    res.json({
      mode: 'live',
      message: 'Continue with GitHub OAuth to store a vault token for Build sync.',
      projectId: projectId || null,
      workspaceId: workspaceId || null,
      authorizeUrl: initUrl.pathname + initUrl.search,
      docs: {
        env: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'LOOPIT_GITHUB_TOKEN'],
        connector: 'Settings → Connectors → GitHub',
      },
    })
  }),
)
