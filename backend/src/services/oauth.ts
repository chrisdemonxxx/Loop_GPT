/**
 * Self-contained OAuth2 for Google, GitHub, and Apple — no passport dependency.
 * Each provider is enabled only when its client credentials are present, so the
 * sign-in buttons the frontend shows always reflect what actually works.
 *
 * Env:
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
 *   APPLE_CLIENT_ID (service id) / APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY (PEM)
 *   OAUTH_CALLBACK_BASE  (public backend URL, e.g. https://api.loop-gpt.cyou) — optional; derived from the request otherwise
 */
import jwt from 'jsonwebtoken'

export type OAuthProvider = 'google' | 'github' | 'apple'

export interface OAuthProfile {
  email: string
  name: string
  providerId: string
}

export function providerEnabled(p: OAuthProvider): boolean {
  if (p === 'google') return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  if (p === 'github') return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
  if (p === 'apple')
    return !!(process.env.APPLE_CLIENT_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY)
  return false
}

export function enabledProviders(): OAuthProvider[] {
  return (['google', 'github', 'apple'] as OAuthProvider[]).filter(providerEnabled)
}

export function callbackUrl(base: string, provider: OAuthProvider): string {
  const root = (process.env.OAUTH_CALLBACK_BASE || base).replace(/\/+$/, '')
  return `${root}/api/auth/oauth/${provider}/callback`
}

/** Apple requires a short-lived ES256-signed JWT as the client_secret. */
function appleClientSecret(): string {
  return jwt.sign({}, (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'), {
    algorithm: 'ES256',
    expiresIn: '5m',
    audience: 'https://appleid.apple.com',
    issuer: process.env.APPLE_TEAM_ID,
    subject: process.env.APPLE_CLIENT_ID,
    keyid: process.env.APPLE_KEY_ID,
  })
}

export function authorizeUrl(provider: OAuthProvider, redirectUri: string, state: string): string {
  if (provider === 'google') {
    const p = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
  }
  if (provider === 'github') {
    const p = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID!,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
    })
    return `https://github.com/login/oauth/authorize?${p}`
  }
  // apple
  const p = new URLSearchParams({
    client_id: process.env.APPLE_CLIENT_ID!,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'name email',
    response_mode: 'form_post',
    state,
  })
  return `https://appleid.apple.com/auth/authorize?${p}`
}

/** Exchange the auth code and fetch a normalized profile. Throws on failure. */
export async function exchangeCode(provider: OAuthProvider, code: string, redirectUri: string): Promise<OAuthProfile> {
  if (provider === 'google') {
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    })
    const info: any = await getJson('https://www.googleapis.com/oauth2/v3/userinfo', { Authorization: `Bearer ${tok.access_token}` })
    return { email: info.email, name: info.name || info.given_name || info.email?.split('@')[0], providerId: info.sub }
  }
  if (provider === 'github') {
    const tok = await postForm('https://github.com/login/oauth/access_token', {
      code,
      client_id: process.env.GITHUB_CLIENT_ID!,
      client_secret: process.env.GITHUB_CLIENT_SECRET!,
      redirect_uri: redirectUri,
    })
    const user: any = await getJson('https://api.github.com/user', {
      Authorization: `Bearer ${tok.access_token}`,
      'User-Agent': 'loop-gpt',
    })
    let email = user.email
    if (!email) {
      const emails: any = await getJson('https://api.github.com/user/emails', {
        Authorization: `Bearer ${tok.access_token}`,
        'User-Agent': 'loop-gpt',
      })
      const primary = Array.isArray(emails) ? emails.find((e: any) => e.primary && e.verified) || emails[0] : null
      email = primary?.email
    }
    if (!email) throw new Error('GitHub account has no accessible email')
    return { email, name: user.name || user.login, providerId: String(user.id) }
  }
  // apple: the token response contains an id_token (JWT) with email/sub.
  const tok = await postForm('https://appleid.apple.com/auth/token', {
    code,
    client_id: process.env.APPLE_CLIENT_ID!,
    client_secret: appleClientSecret(),
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  const claims: any = jwt.decode(tok.id_token) || {}
  if (!claims.email) throw new Error('Apple did not return an email')
  return { email: claims.email, name: claims.email.split('@')[0], providerId: claims.sub }
}

async function postForm(url: string, body: Record<string, string>): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.error) throw new Error(`token exchange failed: ${data.error_description || data.error || res.status}`)
  return data
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers } })
  if (!res.ok) throw new Error(`profile fetch failed: ${res.status}`)
  return res.json()
}
