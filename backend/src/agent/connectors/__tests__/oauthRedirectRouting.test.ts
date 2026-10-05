import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { oauthRedirectUri, connectorStateExists, completeConnectorCallback } from '../../../routes/oauthConnector'
import { loginProviderForConnector, PLATFORM_OAUTH_PROVIDERS, requestedScopes, googleFullReadScopesEnabled } from '../oauthProviders'
import { gmailConnectorTools, googleDriveConnectorTools } from '../googleAdapters'

/** Env fixture: the production shapes (OAUTH_CALLBACK_BASE wins for the
 *  platform URI; FRONTEND_URL carries the marketplace base). */
beforeEach(() => {
  vi.stubEnv('OAUTH_CALLBACK_BASE', 'https://api.loop-gpt.cyou')
  vi.stubEnv('PUBLIC_API_URL', 'https://api.loop-gpt.cyou')
  vi.stubEnv('FRONTEND_URL', 'https://loop-gpt.cyou')
  vi.stubEnv('BASE_URL', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('connector redirect_uri routing (the redirect_uri_mismatch fix, 2026-10-05)', () => {
  it('platform connectors ride the SIGN-IN callback — the registered URI', () => {
    for (const type of Object.keys(PLATFORM_OAUTH_PROVIDERS)) {
      const uri = oauthRedirectUri(type)
      const provider = loginProviderForConnector(type)
      expect(provider, `platform connector ${type} must map to a login provider`).toBeTruthy()
      expect(uri).toBe(`https://api.loop-gpt.cyou/api/auth/oauth/${provider}/callback`)
    }
  })

  it('marketplace connectors keep the dedicated callback (user-owned apps)', () => {
    expect(oauthRedirectUri('figma')).toBe('https://loop-gpt.cyou/api/oauth-connector/callback')
    expect(oauthRedirectUri('dropbox')).toBe('https://loop-gpt.cyou/api/oauth-connector/callback')
  })

  it('the URI is provider-correct: gmail → google, github → github', () => {
    expect(oauthRedirectUri('gmail')).toContain('/api/auth/oauth/google/callback')
    expect(oauthRedirectUri('github')).toContain('/api/auth/oauth/github/callback')
  })

  it('loginProviderForConnector returns null for non-platform connectors', () => {
    expect(loginProviderForConnector('figma')).toBeNull()
    expect(loginProviderForConnector('nope')).toBeNull()
  })
})

describe('connector state routing (login-callback delegation)', () => {
  it('connectorStateExists is false for login JWT states and unknown handles', () => {
    const loginState = ['eyJhbGciOiJIUzI1NiJ9.eyJwcm92aWRlciI6Imdvb2dsZSJ9.x'].join('.')
    expect(connectorStateExists(loginState)).toBe(false)
    expect(connectorStateExists(undefined)).toBe(false)
    expect(connectorStateExists('deadbeef'.repeat(8))).toBe(false)
  })

  it('completeConnectorCallback rejects an unknown state with invalid_state (no crash)', async () => {
    const res: any = { redirect: vi.fn(), send: vi.fn(), set: vi.fn() }
    await completeConnectorCallback('code', 'nosuchstate', res)
    // Legacy redirect path for an un-started flow (no popup flag known).
    expect(res.redirect).toHaveBeenCalled()
    expect(String(res.redirect.mock.calls[0][0])).toContain('oauth_error=invalid_state')
  })
})

describe('sensitive-only scope default (the restricted-scope wall fix, 2026-10-05)', () => {
  beforeEach(() => { vi.stubEnv('GOOGLE_FULL_READ_SCOPES', '') })
  afterEach(() => vi.unstubAllEnvs())

  it('the default requests NO restricted scopes for Gmail/Drive', () => {
    expect(googleFullReadScopesEnabled()).toBe(false)
    expect(requestedScopes('gmail')).toEqual(['https://www.googleapis.com/auth/gmail.send'])
    expect(requestedScopes('google_drive')).toEqual(['https://www.googleapis.com/auth/drive.file'])
    // Calendar/Sheets were always sensitive — unchanged
    expect(requestedScopes('google_calendar')).toContain('https://www.googleapis.com/auth/calendar.events')
  })

  it('the flag restores the full read scopes', () => {
    vi.stubEnv('GOOGLE_FULL_READ_SCOPES', 'true')
    expect(googleFullReadScopesEnabled()).toBe(true)
    expect(requestedScopes('gmail')).toContain('https://www.googleapis.com/auth/gmail.readonly')
    expect(requestedScopes('google_drive')).toContain('https://www.googleapis.com/auth/drive.readonly')
  })

  it('default Gmail tools are send-only; Drive tools are create-only', () => {
    const gmail = gmailConnectorTools({ id: 't1', type: 'gmail', name: 'Gmail', enabled: true, config: {} } as any)
    expect(gmail.map((t) => t.name)).toEqual(['connector__t1__gmail_send'])
    const drive = googleDriveConnectorTools({ id: 't2', type: 'google_drive', name: 'Drive', enabled: true, config: {} } as any)
    expect(drive.map((t) => t.name)).toEqual(['connector__t2__drive_create_file'])
  })

  it('the flag restores the read tools', () => {
    vi.stubEnv('GOOGLE_FULL_READ_SCOPES', 'true')
    const gmail = gmailConnectorTools({ id: 't1', type: 'gmail', name: 'Gmail', enabled: true, config: {} } as any)
    expect(gmail.map((t) => t.name)).toEqual(['connector__t1__gmail_search', 'connector__t1__gmail_read', 'connector__t1__gmail_send'])
    const drive = googleDriveConnectorTools({ id: 't2', type: 'google_drive', name: 'Drive', enabled: true, config: {} } as any)
    expect(drive.map((t) => t.name)).toEqual(['connector__t2__drive_list_files', 'connector__t2__drive_read_file'])
  })
})