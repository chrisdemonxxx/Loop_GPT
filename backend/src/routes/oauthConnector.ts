/**
 * OAuth 2.1 + PKCE flow for connectors.
 *
 * Init → authorize URL with PKCE → callback → code exchange → storage.
 *
 * Two tiers of providers (see agent/connectors/oauthProviders.ts):
 *  - Platform-managed (Google Drive/Gmail/Calendar/Sheets, GitHub): client
 *    credentials from env; users just click Connect.
 *  - Marketplace (Outlook, OneDrive, Dropbox, Linear, Asana, Salesforce,
 *    Figma, Zoom): connected with the USER'S OWN OAuth app credentials — the
 *    init call carries { clientId, clientSecret } created in the provider's
 *    developer console.
 *
 * On success the tokens are stored BOTH as an encrypted WorkspaceConnection
 * (existing flow) AND as a config-store connector entry, so the Settings →
 * Connectors tab shows the live connection and the agent tools register.
 *
 * Redirect URL to configure in OAuth provider apps:
 *   {FRONTEND_URL}/api/oauth-connector/callback
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import crypto from 'crypto'
import { encryptConnectionConfig } from '../services/credentialVault'
import { prisma } from '../services/prisma'
import { configStore } from '../agent/configStore'
import { connectorRegistry } from '../agent/connectors/connectorRegistry'
import { ALL_OAUTH_PROVIDERS, PLATFORM_OAUTH_PROVIDERS, MARKETPLACE_OAUTH_PROVIDERS } from '../agent/connectors/oauthProviders'

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
  /** Marketplace connectors: the user's own OAuth app credentials. */
  userClientId?: string
  userClientSecret?: string
}
const pkceStore = new Map<string, PkceStore>()

function generateState(): string { return crypto.randomBytes(32).toString('hex') }
function generateVerifier(): string { return crypto.randomBytes(32).toString('base64url') }
function sha256(input: string): string { return crypto.createHash('sha256').update(input).digest('base64url') }

function clientIdFor(type: string, pkce?: PkceStore): string | undefined {
  if (PLATFORM_OAUTH_PROVIDERS[type]) {
    if (type === 'github') return process.env.GITHUB_CLIENT_ID
    return process.env.GOOGLE_CLIENT_ID
  }
  return pkce?.userClientId
}

function clientSecretFor(type: string, pkce?: PkceStore): string | undefined {
  if (PLATFORM_OAUTH_PROVIDERS[type]) {
    if (type === 'github') return process.env.GITHUB_CLIENT_SECRET
    return process.env.GOOGLE_CLIENT_SECRET
  }
  return pkce?.userClientSecret
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

  const provider = ALL_OAUTH_PROVIDERS[connectorType]
  if (!provider) return res.status(400).json({ error: `Unknown connector: ${connectorType}` })

  // Marketplace providers connect with the user's own OAuth app credentials.
  let userClientId: string | undefined
  let userClientSecret: string | undefined
  if (MARKETPLACE_OAUTH_PROVIDERS[connectorType]) {
    userClientId = String(req.body?.clientId || '').trim()
    userClientSecret = String(req.body?.clientSecret || '').trim()
    if (!userClientId || !userClientSecret) {
      return res.status(400).json({ error: `Connect ${provider.name} with your own OAuth app: clientId and clientSecret are required (create them at ${provider.docs || 'the provider developer console'}).` })
    }
  } else if (!clientIdFor(connectorType)) {
    return res.status(503).json({ error: `OAuth client not configured for ${connectorType}.` })
  }

  const state = generateState()
  const codeVerifier = generateVerifier()
  const codeChallenge = sha256(codeVerifier)
  pkceStore.set(state, { state, codeVerifier, redirectTo: req.body?.redirectTo || '/chat', connectorType, userId, workspaceId,
    userClientId, userClientSecret, expiresAt: Date.now() + 600_000 })

  const params = new URLSearchParams({
    client_id: clientIdFor(connectorType, pkceStore.get(state))!, redirect_uri: oauthRedirectUri(),
    response_type: 'code', scope: provider.scopes.join(' '), state,
    code_challenge: codeChallenge, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent',
    ...(provider.extraAuthorizeParams || {}),
  })
  return res.json({ authorizeUrl: `${provider.authorizeUrl}?${params.toString()}` })
}))

/** Best-effort display name for the connected account (shown on the card). */
async function fetchAccountLabel(type: string, accessToken: string): Promise<string | null> {
  try {
    if (type.startsWith('google_') || type === 'gmail') {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.ok) { const d: any = await res.json(); return d.email || d.name || null }
    } else if (type === 'github') {
      const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json' } })
      if (res.ok) { const d: any = await res.json(); return d.login || null }
    } else if (type === 'outlook' || type === 'onedrive') {
      const res = await fetch('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.ok) { const d: any = await res.json(); return d.userPrincipalName || d.displayName || null }
    } else if (type === 'figma') {
      const res = await fetch('https://api.figma.com/v1/me', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.ok) { const d: any = await res.json(); return d.email || d.handle || null }
    } else if (type === 'dropbox') {
      const res = await fetch('https://api.dropboxapi.com/2/users/get_current_account', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.ok) { const d: any = await res.json(); return d.email?.email || null }
    } else if (type === 'salesforce') {
      // identity comes with the token response (instance_url + id).
      return null
    } else if (type === 'zoom') {
      const res = await fetch('https://api.zoom.us/v2/users/me', { headers: { Authorization: `Bearer ${accessToken}` } })
      if (res.ok) { const d: any = await res.json(); return d.email || null }
    } else if (type === 'linear' || type === 'asana') {
      return null
    }
  } catch { /* label is decorative — never fail the connection for it */ }
  return null
}

// ---------------------------------------------------------------------------
// GET /api/oauth-connector/callback — OAuth provider redirects here
// ---------------------------------------------------------------------------
oauthConnectorRouter.get('/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>
  if (error) return res.redirect(`/chat/?oauth_error=${encodeURIComponent(error)}`)
  if (!code || !state) return res.status(400).send('Missing code or state.')

  const pkce = pkceStore.get(state)
  if (!pkce || pkce.expiresAt < Date.now()) { pkceStore.delete(state || ''); return res.status(400).send('Invalid or expired state.') }
  pkceStore.delete(state)

  const provider = ALL_OAUTH_PROVIDERS[pkce.connectorType]
  if (!provider) return res.status(500).send('Unknown provider.')

  try {
    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientIdFor(pkce.connectorType, pkce) || '', client_secret: clientSecretFor(pkce.connectorType, pkce) || '',
        code, code_verifier: pkce.codeVerifier, grant_type: 'authorization_code', redirect_uri: oauthRedirectUri(),
      }).toString(),
    })
    const tokens = await tokenRes.json()
    if (!tokens.access_token) return res.status(502).send(`Token exchange failed: ${tokens.error || tokens.error_description || 'unknown'}`)

    const config: Record<string, string> = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_at: String(Date.now() + (tokens.expires_in || 3600) * 1000),
      scope: tokens.scope || '',
    }
    if (tokens.instance_url) config.instanceUrl = String(tokens.instance_url)
    const encrypted = encryptConnectionConfig(pkce.workspaceId, crypto.randomUUID(), config)

    const existing = await prisma?.workspaceConnection.findFirst({ where: { workspaceId: pkce.workspaceId, type: pkce.connectorType } })
    if (existing) {
      await prisma!.workspaceConnection.update({ where: { id: existing.id }, data: { enabled: true, encryptedConfig: encrypted, configuredFields: Object.keys(config).sort() } })
    } else {
      await prisma!.workspaceConnection.create({ data: { workspaceId: pkce.workspaceId, type: pkce.connectorType, name: provider.name, enabled: true, encryptedConfig: encrypted, configuredFields: Object.keys(config).sort() } })
    }

    // Dual-write: also upsert a config-store connector so Settings → Connectors
    // shows the live connection and the adapter tools register immediately.
    const account = await fetchAccountLabel(pkce.connectorType, tokens.access_token)
    const storeConfig = { ...config }
    if (pkce.connectorType === 'github') storeConfig.token = tokens.access_token
    const list = configStore.listConnectors()
    const existingEntry = list.find((c) => c.type === pkce.connectorType)
    const entry = {
      id: existingEntry?.id || `oauth-${crypto.randomUUID().slice(0, 8)}`,
      type: pkce.connectorType,
      name: provider.name,
      config: storeConfig,
      enabled: true,
      account: account || undefined,
      lastTestedAt: new Date().toISOString(),
      lastTestOk: true,
      lastTestMessage: 'Authorized via provider sign-in.',
    }
    configStore.saveConnectors(existingEntry ? list.map((c) => (c.id === entry.id ? entry : c)) : [...list, entry])
    connectorRegistry.activate(entry as any)

    return res.redirect(`/chat/?oauth=connected&type=${pkce.connectorType}`)
  } catch (e: any) {
    return res.status(502).send(`Token exchange failed: ${e.message}`)
  }
}))
