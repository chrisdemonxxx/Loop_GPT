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
 * Only a workspace owner can start or finish a flow. On success the tokens
 * are stored as an encrypted WorkspaceConnection AND as a config-store
 * connector entry owned by the connecting user, so their Settings →
 * Connectors tab shows the live connection and their runs get the tools.
 *
 * Redirect URIs (2026-10-05, the redirect_uri_mismatch fix):
 *  - Platform connectors ride the sign-in flow's registered callback:
 *    {OAUTH_CALLBACK_BASE}/api/auth/oauth/{google|github}/callback — the
 *    login-callback handler delegates connector states here. No separate
 *    console registration exists to drift.
 *  - Marketplace connectors (user-owned OAuth apps) register:
 *    {FRONTEND_URL}/api/oauth-connector/callback
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import crypto from 'crypto'
import { encryptConnectionConfig } from '../services/credentialVault'
import { prisma } from '../services/prisma'
import { configStore } from '../agent/configStore'
import { requireMembership, WorkspaceError } from '../services/workspaces'
import { ALL_OAUTH_PROVIDERS, PLATFORM_OAUTH_PROVIDERS, MARKETPLACE_OAUTH_PROVIDERS, loginProviderForConnector, requestedScopes } from '../agent/connectors/oauthProviders'
import { publicCallbackBase } from '../services/oauth'

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
  /** Frontend opened the flow in a popup: the callback answers with a
   *  postMessage-and-close page instead of a redirect. */
  viaPopup?: boolean
}
const pkceStore = new Map<string, PkceStore>()

/** True when the state belongs to a connector flow (vs the login JWT state). */
export function connectorStateExists(state: string | undefined | null): boolean {
  if (!state) return false
  const pkce = pkceStore.get(state)
  return !!pkce && pkce.expiresAt >= Date.now()
}

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

/**
 * The redirect_uri each connector flow sends. PLATFORM connectors (Google
 * Drive/Gmail/Calendar/Sheets, GitHub) ride the SIGN-IN flow's registered
 * callback — `{OAUTH_CALLBACK_BASE}/api/auth/oauth/{google|github}/callback`
 * — the same string the provider console already trusts (this is the
 * redirect_uri_mismatch fix, 2026-10-05: the old dedicated
 * /api/oauth-connector/callback was never registered in Google's console,
 * so every Gmail/Drive connect died with Error 400 before consent).
 * MARKETPLACE connectors run on the user's own OAuth app and keep the
 * dedicated callback documented in CONNECTOR_SETUP.md.
 *
 * The string MUST be identical at authorize and at token exchange — both
 * call sites use this function.
 */
export function oauthRedirectUri(type: string): string {
  const loginProvider = loginProviderForConnector(type)
  if (loginProvider) return `${publicCallbackBase('')}/api/auth/oauth/${loginProvider}/callback`
  return `${baseUrl()}/api/oauth-connector/callback`
}

/** Origin allowed to receive the popup result (the app that opened it). */
function frontendOrigin(): string {
  const app = process.env.FRONTEND_URL?.split(',')?.[0]?.trim() || baseUrl()
  try { return new URL(app).origin } catch { return 'null' }
}

/** Error codes the client may display; anything else collapses to oauth_failed. */
const FLOW_ERRORS = new Set(['invalid_state', 'unknown_provider', 'token_exchange_failed', 'access_denied', 'forbidden', 'oauth_failed'])
function flowError(code: string | undefined): string {
  return code && FLOW_ERRORS.has(code) ? code : 'oauth_failed'
}

/** The response when the flow runs in a popup: postMessage the opener, close. */
function popupCloser(res: express.Response, payload: { ok: boolean; connectorType: string; error?: string }): void {
  // JSON in a <script> block: escape "<" so no value can close the tag.
  const data = JSON.stringify({ source: 'loop-oauth', ...payload }).replace(/</g, '\\u003c')
  const target = JSON.stringify(frontendOrigin()).replace(/</g, '\\u003c')
  res.set('Cache-Control', 'no-store')
  res.set('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connected</title></head>
<body><script>
(function(){try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${data},${target})}}catch(e){}}try{window.close()}catch(e){}})();
</script>
<p style="font-family:system-ui,sans-serif;color:#666">You can close this window.</p>
</body></html>`)
}

// ---------------------------------------------------------------------------
// POST /api/oauth-connector/init/:connectorType — start the OAuth flow
// ---------------------------------------------------------------------------
oauthConnectorRouter.post('/init/:connectorType', authenticateToken, asyncHandler(async (req, res) => {
  const userId = (req as any).userId
  const workspaceId = req.body?.workspaceId
  const connectorType = req.params.connectorType
  if (!userId || typeof workspaceId !== 'string' || !workspaceId) return res.status(400).json({ error: 'Authentication and workspaceId required.' })

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
  // Connection writes are owner-only, same as the workspace connections API.
  try { await requireMembership(userId, workspaceId, 'owner') }
  catch (error) {
    if (error instanceof WorkspaceError) return res.status(error.status).json({ error: error.message })
    throw error
  }

  const state = generateState()
  const codeVerifier = generateVerifier()
  const codeChallenge = sha256(codeVerifier)
  const redirectTo = typeof req.body?.redirectTo === 'string' && /^\/(?![/\\])/.test(req.body.redirectTo) ? req.body.redirectTo : '/chat'
  pkceStore.set(state, { state, codeVerifier, redirectTo, connectorType, userId, workspaceId,
    userClientId, userClientSecret, viaPopup: req.body?.via === 'popup', expiresAt: Date.now() + 600_000 })

  const params = new URLSearchParams({
    client_id: clientIdFor(connectorType, pkceStore.get(state))!, redirect_uri: oauthRedirectUri(connectorType),
    response_type: 'code', scope: requestedScopes(connectorType).join(' '), state,
    code_challenge: codeChallenge, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent',
    ...(provider.extraAuthorizeParams || {}),
  })
  return res.json({ authorizeUrl: `${provider.authorizeUrl}?${params.toString()}`, redirectUri: oauthRedirectUri(connectorType) })
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
// Shared completion — called from BOTH callback paths:
//   GET /api/oauth-connector/callback          (marketplace connectors)
//   GET /api/auth/oauth/{provider}/callback    (platform connectors; the
//     login-callback handler delegates when the state is a connector state)
// ---------------------------------------------------------------------------

/** Respond for a completed/failed flow: popup closer or legacy redirect. */
function flowDone(pkce: PkceStore, res: express.Response, payload: { ok: boolean; error?: string }): void {
  const error = payload.ok ? undefined : flowError(payload.error)
  const type = encodeURIComponent(pkce.connectorType || '')
  if (pkce.viaPopup) {
    popupCloser(res, { ok: payload.ok, connectorType: pkce.connectorType, error })
    return
  }
  if (payload.ok) return res.redirect(`/chat/?oauth=connected&type=${type}`)
  res.redirect(`/chat/?oauth_error=${encodeURIComponent(error!)}&type=${type}`)
}

export async function completeConnectorCallback(code: string | undefined, state: string | undefined, res: express.Response): Promise<void> {
  const pkce = state ? pkceStore.get(state) : undefined
  if (!pkce || pkce.expiresAt < Date.now()) { if (state) pkceStore.delete(state); return flowDone({ redirectTo: '/chat', viaPopup: false } as PkceStore, res, { ok: false, error: 'invalid_state' }) }
  if (state) pkceStore.delete(state)

  const provider = ALL_OAUTH_PROVIDERS[pkce.connectorType]
  if (!provider) return flowDone(pkce, res, { ok: false, error: 'unknown_provider' })

  try {
    // Membership may have changed while the user was at the provider.
    try { await requireMembership(pkce.userId, pkce.workspaceId, 'owner') }
    catch { return flowDone(pkce, res, { ok: false, error: 'forbidden' }) }

    const tokenRes = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: clientIdFor(pkce.connectorType, pkce) || '', client_secret: clientSecretFor(pkce.connectorType, pkce) || '',
        code: code || '', code_verifier: pkce.codeVerifier, grant_type: 'authorization_code', redirect_uri: oauthRedirectUri(pkce.connectorType),
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    })
    const tokens = await tokenRes.json()
    if (!tokens.access_token) return flowDone(pkce, res, { ok: false, error: 'token_exchange_failed' })

    const config: Record<string, string> = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || '',
      expires_at: String(Date.now() + (tokens.expires_in || 3600) * 1000),
      scope: tokens.scope || '',
    }
    if (tokens.instance_url) config.instanceUrl = String(tokens.instance_url)
    // The AAD binds the ciphertext to the row id, so encrypt with the id the
    // row actually has (or will have) — never a throwaway one.
    const configuredFields = Object.keys(config).sort()
    const existing = await prisma?.workspaceConnection.findFirst({ where: { workspaceId: pkce.workspaceId, type: pkce.connectorType } })
    if (existing) {
      await prisma!.workspaceConnection.update({ where: { id: existing.id }, data: { enabled: true,
        encryptedConfig: encryptConnectionConfig(pkce.workspaceId, existing.id, config), configuredFields, version: { increment: 1 } } })
    } else {
      const id = crypto.randomUUID()
      await prisma!.workspaceConnection.create({ data: { id, workspaceId: pkce.workspaceId, type: pkce.connectorType, name: provider.name, enabled: true,
        encryptedConfig: encryptConnectionConfig(pkce.workspaceId, id, config), configuredFields } })
    }

    // The agent's adapter tools read the connecting user's own config-store
    // entry (Settings → Connectors). It is owner-scoped: no other account's
    // runs can see or use these tokens.
    const account = await fetchAccountLabel(pkce.connectorType, tokens.access_token)
    const storeConfig = { ...config }
    if (pkce.connectorType === 'github') storeConfig.token = tokens.access_token
    const list = configStore.listConnectors(pkce.userId)
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
      ownerId: pkce.userId,
    }
    configStore.saveConnectors(pkce.userId, existingEntry ? list.map((c) => (c.id === entry.id ? entry : c)) : [...list, entry])

    return flowDone(pkce, res, { ok: true })
  } catch {
    return flowDone(pkce, res, { ok: false, error: 'token_exchange_failed' })
  }
}

// ---------------------------------------------------------------------------
// GET /api/oauth-connector/callback — marketplace connectors land here
// ---------------------------------------------------------------------------
oauthConnectorRouter.get('/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query as Record<string, string | undefined>
  if (error) {
    // A provider error arrives without a state lookup — answer in the same
    // shape the flow started in (popup vs redirect) when we can.
    const pkce = state ? pkceStore.get(state) : undefined
    if (pkce) { pkceStore.delete(state || ''); return flowDone(pkce, res, { ok: false, error }) }
    return res.redirect(`/chat/?oauth_error=${encodeURIComponent(flowError(error))}`)
  }
  if (!code || !state) return res.status(400).send('Missing code or state.')
  return completeConnectorCallback(code, state, res)
}))
