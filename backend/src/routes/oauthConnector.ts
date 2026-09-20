/**
 * OAuth 2.1 + PKCE flow for workspace connectors.
 *
 * Init → authorize URL with PKCE → callback → code exchange → vault storage.
 *
 * Redirect URL to configure in OAuth provider apps:
 *   {FRONTEND_URL}/api/oauth-connector/callback
 *
 * For the local dev server:
 *   http://127.0.0.1:3000/api/oauth-connector/callback
 *
 * For the live candidate:
 *   https://web-production-20d369.up.railway.app/api/oauth-connector/callback
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import crypto from 'crypto'
import { encryptConnectionConfig } from '../services/credentialVault'
import { prisma } from '../services/prisma'

export const oauthConnectorRouter = express.Router()

// ---------------------------------------------------------------------------
// PKCE state store
// ---------------------------------------------------------------------------
interface PkceStore {
  state: string
  codeVerifier: string
  redirectTo: string
  connectorType: string
  userId: string
  workspaceId: string
  expiresAt: number
}
const pkceStore = new Map<string, PkceStore>()

function generateState(): string { return crypto.randomBytes(32).toString('hex') }
function generateVerifier(): string { return crypto.randomBytes(32).toString('base64url') }
function sha256(input: string): string { return crypto.createHash('sha256').update(input).digest('base64url') }

// ---------------------------------------------------------------------------
// OAuth provider registry — client IDs/secrets come from env vars (DN)
// ---------------------------------------------------------------------------
const OAUTH_PROVIDERS: Record<string, {
  authorizeUrl: string
  tokenUrl: string
  scopes: string[]
  clientId: () => string | undefined
  clientSecret: () => string | undefined
}> = {
  google_drive: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  gmail: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
  },
  // Apple uses a JWT client secret — added when credentials arrive.
}

function baseUrl(): string {
  return process.env.BASE_URL || process.env.FRONTEND_URL?.split(',')?.[0]?.trim() || 'http://127.0.0.1:3000'
}

/** The exact redirect URL to register in each OAuth provider app settings. */
export function oauthRedirectUri(): string {
  return `${baseUrl()}/api/oauth-connector/callback`
}

// ---------------------------------------------------------------------------
// POST /api/oauth-connector/init/:connectorType — start the OAuth flow
// ---------------------------------------------------------------------------
oauthConnectorRouter.post('/init/:connectorType', asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.body?.workspaceId
  const connectorType = req.params.connectorType
  if (!userId || !workspaceId) return res.status(400).json({ error: 'Authentication and workspaceId required.' })

  const provider = OAUTH_PROVIDERS[connectorType]
  if (!provider) return res.status(400).json({ error: `Unknown connector: ${connectorType}` })
  if (!provider.clientId()) return res.status(503).json({ error: `OAuth client not configured for ${connectorType}.` })

  const state = generateState()
  const codeVerifier = generateVerifier()
  const codeChallenge = sha256(codeVerifier)
  pkceStore.set(state, { state, codeVerifier, redirectTo: req.body?.redirectTo || '/', connectorType, userId, workspaceId, expiresAt: Date.now() + 600_000 })

  const params = new URLSearchParams({
    client_id: provider.clientId()!, redirect_uri: oauthRedirectUri(),
    response_type: 'code', scope: provider.scopes.join(' '), state,
    code_challenge: codeChallenge, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent',
  })
  return res.json({ authorizeUrl: `${provider.authorizeUrl}?${params.toString()}` })
}))

// ---------------------------------------------------------------------------
// GET /api/oauth-connector/callback — OAuth provider redirects here
// ---------------------------------------------------------------------------
oauthConnectorRouter.get('/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>
  if (error) return res.redirect(`/?oauth_error=${encodeURIComponent(error)}`)
  if (!code || !state) return res.status(400).send('Missing code or state.')

  const pkce = pkceStore.get(state)
  if (!pkce || pkce.expiresAt < Date.now()) { pkceStore.delete(state || ''); return res.status(400).send('Invalid or expired state.') }
  pkceStore.delete(state)

  const provider = OAUTH_PROVIDERS[pkce.connectorType]
  if (!provider) return res.status(500).send('Unknown provider.')

  try {
    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: provider.clientId() || '', client_secret: provider.clientSecret() || '',
        code, code_verifier: pkce.codeVerifier, grant_type: 'authorization_code', redirect_uri: oauthRedirectUri(),
      }).toString(),
    })
    const tokens = await tokenRes.json()
    if (!tokens.access_token) return res.status(502).send(`Token exchange failed: ${tokens.error || tokens.error_description || 'unknown'}`)

    const config = { access_token: tokens.access_token, refresh_token: tokens.refresh_token || '', expires_at: String(Date.now() + (tokens.expires_in || 3600) * 1000), scope: tokens.scope || '' }
    const encrypted = encryptConnectionConfig(pkce.workspaceId, crypto.randomUUID(), config)

    const existing = await prisma?.workspaceConnection.findFirst({ where: { workspaceId: pkce.workspaceId, type: pkce.connectorType } })
    if (existing) {
      await prisma!.workspaceConnection.update({ where: { id: existing.id }, data: { enabled: true, encryptedConfig: encrypted, configuredFields: Object.keys(config).sort() } })
    } else {
      await prisma!.workspaceConnection.create({ data: { workspaceId: pkce.workspaceId, type: pkce.connectorType, name: pkce.connectorType, enabled: true, encryptedConfig: encrypted, configuredFields: Object.keys(config).sort() } })
    }

    return res.redirect(`/?oauth=connected&type=${pkce.connectorType}`)
  } catch (e: any) {
    return res.status(502).send(`Token exchange failed: ${e.message}`)
  }
}))
