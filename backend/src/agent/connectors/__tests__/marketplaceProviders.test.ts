import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'http'
import express from 'express'

/**
 * Per-provider marketplace OAuth CI stubs (audit P8 / brief "connector tests
 * as real CI"): every one of the 8 user-OAuth-app providers (Outlook, OneDrive,
 * Dropbox, Linear, Asana, Salesforce, Figma, Zoom) is exercised against a
 * fixture fetch — registry shape, PKCE init route, the adapter's Bearer call
 * against that provider's apiBase, and probe semantics. No network, no DB:
 * a regression in any provider's URL/shape/auth contract fails here instead
 * of silently in production.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-marketplace-'))
process.env.AGENT_DATA_DIR = path.join(tmpRoot, 'data')
process.env.NODE_ENV = 'development'
process.env.ENABLE_DEV_MODE = 'true'
process.env.CONNECTOR_VALIDATE_ON_SAVE = 'false'
// NOTE: vitest injects BASE_URL='/' per test module; oauthRedirectUri() prefers
// BASE_URL, so pin both to an explicit origin.
process.env.BASE_URL = 'http://127.0.0.1:3999'
process.env.FRONTEND_URL = 'http://127.0.0.1:3999'
process.env.CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

import {
  MARKETPLACE_OAUTH_PROVIDERS,
} from '../../connectors/oauthProviders'
import { marketplaceConnectorTools, probeMarketplaceConnector, MARKETPLACE_CONNECTOR_TYPES, isMarketplaceConnector } from '../../connectors/marketplaceAdapters'
import { oauthConnectorRouter } from '../../../routes/oauthConnector'
import type { ToolContext } from '../../agent/types'

const ctx = { signal: undefined, emit: () => {} } as unknown as ToolContext

const ALL_MARKETPLACE_TYPES = ['outlook', 'onedrive', 'dropbox', 'linear', 'asana', 'salesforce', 'figma', 'zoom'] as const

/** Static apiBase per provider; Salesforce is instance-URL based. */
const EXPECTED_BASE: Record<string, string> = {
  outlook: 'https://graph.microsoft.com/v1.0',
  onedrive: 'https://graph.microsoft.com/v1.0/me',
  dropbox: 'https://api.dropboxapi.com/2',
  linear: 'https://api.linear.app',
  asana: 'https://app.asana.com/api/1.0',
  salesforce: 'https://mydomain.my.salesforce.com',
  figma: 'https://api.figma.com/v1',
  zoom: 'https://api.zoom.us/v2',
}

function providerCfg(type: string) {
  const config: Record<string, string> = { access_token: `tok-${type}` }
  if (type === 'salesforce') config.instanceUrl = EXPECTED_BASE.salesforce
  return { id: `mk-${type}`, type, name: MARKETPLACE_OAUTH_PROVIDERS[type].name, config, enabled: true }
}

// ---------------------------------------------------------------------------
// 1) Registry contract — no network
// ---------------------------------------------------------------------------

describe('marketplace OAuth registry (all 8 providers)', () => {
  it('exposes exactly the 8 marketplace providers', () => {
    expect([...MARKETPLACE_CONNECTOR_TYPES].sort()).toEqual([...ALL_MARKETPLACE_TYPES].sort())
    for (const type of ALL_MARKETPLACE_TYPES) expect(isMarketplaceConnector(type)).toBe(true)
    expect(isMarketplaceConnector('google_drive')).toBe(false)
    expect(isMarketplaceConnector('github')).toBe(false)
  })

  for (const type of ALL_MARKETPLACE_TYPES) {
    it(`${type}: spec has valid OAuth endpoints, scopes and API base`, () => {
      const spec = MARKETPLACE_OAUTH_PROVIDERS[type]
      expect(spec).toBeTruthy()
      expect(spec.name).toBeTruthy()
      expect(spec.authorizeUrl).toMatch(/^https:\/\//)
      expect(spec.tokenUrl).toMatch(/^https:\/\//)
      expect(spec.scopes.length).toBeGreaterThan(0)
      expect(spec.scopes.every((s) => s.length > 0)).toBe(true)
      expect(spec.docs).toMatch(/^https?:\/\//)
      if (type === 'salesforce') {
        // Salesforce has no static apiBase: the token response carries the instance URL.
        expect(spec.hasInstanceUrl).toBe(true)
        expect(spec.apiBase).toBe('{instanceUrl}')
      } else {
        expect(spec.apiBase).toBe(EXPECTED_BASE[type])
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 2) PKCE init route per provider — authorize URL contract
// ---------------------------------------------------------------------------

describe('marketplace PKCE init route (per provider)', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/oauth-connector', oauthConnectorRouter)
    await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
    base = `http://127.0.0.1:${(server.address() as any).port}`
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  for (const type of ALL_MARKETPLACE_TYPES) {
    it(`${type}: init with user app credentials returns a S256 authorize URL`, async () => {
      const res = await fetch(`${base}/api/oauth-connector/init/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'w-test', clientId: `user-client-${type}`, clientSecret: 'user-secret' }),
      })
      expect(res.status).toBe(200)
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string }
      const spec = MARKETPLACE_OAUTH_PROVIDERS[type]
      expect(authorizeUrl.startsWith(`${spec.authorizeUrl}?`)).toBe(true)
      const params = new URLSearchParams(authorizeUrl.split('?')[1])
      expect(params.get('client_id')).toBe(`user-client-${type}`)
      expect(params.get('code_challenge_method')).toBe('S256')
      expect(params.get('response_type')).toBe('code')
      expect(params.get('redirect_uri')).toBe('http://127.0.0.1:3999/api/oauth-connector/callback')
      expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{40,}$/)
      expect(params.get('state')).toMatch(/^[a-f0-9]{64}$/)
      for (const scope of spec.scopes) expect(params.get('scope')).toContain(scope)
    })
  }

  it('rejects marketplace init without user OAuth app credentials (400 + docs hint)', async () => {
    const res = await fetch(`${base}/api/oauth-connector/init/figma`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'w-test' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('clientId and clientSecret')
  })

  it('rejects unknown connector types', async () => {
    const res = await fetch(`${base}/api/oauth-connector/init/nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'w-test', clientId: 'x', clientSecret: 'y' }),
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 3) Adapter + probe per provider — Bearer call against the right base
// ---------------------------------------------------------------------------

describe('marketplace adapter + probe (per provider, stub fetch)', () => {
  const fetchMock = vi.fn()
  beforeEach(() => { vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset() })

  for (const type of ALL_MARKETPLACE_TYPES) {
    it(`${type}: adapter calls the provider base with Bearer auth`, async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"ok":true}' })
      const tools = marketplaceConnectorTools(providerCfg(type) as any)
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe(`connector__mk-${type}__api_request`)
      const res = await tools[0].handler({ path: '/probe-test' }, ctx)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`${EXPECTED_BASE[type]}/probe-test`)
      expect(init.headers.Authorization).toBe(`Bearer tok-${type}`)
      expect((res as any).isError).toBeFalsy()
      expect((res as any).content).toContain('ok')
    })

    it(`${type}: probe marks 401/403 as invalid credentials, other statuses pass`, async () => {
      fetchMock.mockResolvedValueOnce({ status: 401, ok: false, text: async () => 'unauthorized' })
      const bad = await probeMarketplaceConnector(providerCfg(type) as any)
      expect(bad.ok).toBe(false)
      expect(bad.invalidCredentials).toBe(true)
      fetchMock.mockResolvedValueOnce({ status: 404, ok: false, text: async () => 'not found' })
      const odd = await probeMarketplaceConnector(providerCfg(type) as any)
      // Any non-401/403 response means the token itself was accepted.
      expect(odd.ok).toBe(true)
      expect(odd.invalidCredentials).toBe(false)
    })

    it(`${type}: probe reports not-connected when no token stored`, async () => {
      const res = await probeMarketplaceConnector({ ...providerCfg(type), config: {} } as any)
      expect(res.ok).toBe(false)
      expect(res.message).toContain('Not connected')
    })
  }

  it('adapter surfaces provider HTTP failures as isError with bounded content', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, headers: { get: () => 'text/plain' }, text: async () => 'denied'.repeat(200) })
    const tools = marketplaceConnectorTools(providerCfg('figma') as any)
    const res = await tools[0].handler({ path: '/files/x' }, ctx)
    expect((res as any).isError).toBe(true)
    expect((res as any).content).toContain('403')
    expect(((res as any).content as string).length).toBeLessThan(700)
  })
})
