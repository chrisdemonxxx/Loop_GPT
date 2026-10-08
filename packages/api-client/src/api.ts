'use client'

import type { AgentMode, StoredUser } from '@loop/shared'

// Empty string => same-origin (relative) requests, served by the platform proxy.
// Set NEXT_PUBLIC_API_URL to an absolute origin only for cross-origin API hosts.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

// The browser session is an httpOnly cookie set by the API. This module does
// not write that JWT to localStorage. A bearer is kept only for the desktop
// shell (different origin from the cookie) and for sessions saved before the
// cookie cutover, which are still honored until the next sign-in.
const TOKEN_KEY = 'authToken'
const SESSION_FLAG = 'loopSignedIn'
let memoryToken: string | null = null

function desktopShell(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { loopDesktop?: unknown }).loopDesktop
}

function readStoredToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY)
    if (!t) return null
    const payload = JSON.parse(atob((t.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/')))
    if (payload?.exp && payload.exp * 1000 <= Date.now()) { localStorage.removeItem(TOKEN_KEY); return null }
    return t
  } catch { return null }
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  // Desktop holds the bearer in memory because the gateway origin does not
  // share the website cookie. Browsers keep reading a pre-cookie localStorage
  // token until the next sign-in removes it, without copying it into memory
  // (that copy survives localStorage.clear() in tests and across sign-out).
  if (desktopShell() && memoryToken) return memoryToken
  return readStoredToken()
}

/** True when a cookie session, a desktop bearer, or a pre-cookie token is present. */
export function hasSession(): boolean {
  if (typeof window === 'undefined') return false
  if (getToken()) return true
  try { return localStorage.getItem(SESSION_FLAG) === '1' } catch { return false }
}

export function authHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

function isLoopApiUrl(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.startsWith('/api') || url.startsWith('/v1')) return true
  return !!API_URL && (url === API_URL || url.startsWith(`${API_URL}/`))
}

// Same-origin fetches already send cookies. Cross-origin dev (NEXT_PUBLIC_API_URL)
// needs credentials: 'include' on every call site; patch once so none are missed.
if (typeof window !== 'undefined' && !(window as unknown as { __loopApiFetch?: boolean }).__loopApiFetch) {
  ;(window as unknown as { __loopApiFetch?: boolean }).__loopApiFetch = true
  const originalFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.credentials || !isLoopApiUrl(input)) return originalFetch(input, init)
    return originalFetch(input, { ...init, credentials: 'include' })
  }
}

export type { AgentMode, StoredUser }

/** Hosted model tier id ('loop-chat', 'loop-chat-large', 'loop-vision') or ''
 * to let the server's smart router decide. */
export function getModelTier(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('aiModelTier') || ''
}
export function setModelTier(id: string) {
  if (typeof window === 'undefined') return
  if (id) localStorage.setItem('aiModelTier', id)
  else localStorage.removeItem('aiModelTier')
}

// ---- Auth / account helpers -------------------------------------------------

export function getStoredUser(): StoredUser | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem('user')
    return raw ? (JSON.parse(raw) as StoredUser) : null
  } catch {
    return null
  }
}

export function setAuth(token: string, user?: StoredUser) {
  if (typeof window === 'undefined') return
  try {
    if (desktopShell() && token) {
      memoryToken = token
      localStorage.setItem(TOKEN_KEY, token)
    } else {
      memoryToken = null
      localStorage.removeItem(TOKEN_KEY)
    }
    if (token || user) localStorage.setItem(SESSION_FLAG, '1')
    if (user) localStorage.setItem('user', JSON.stringify(user))
  } catch { /* private mode */ }
}

export function clearAuth() {
  memoryToken = null
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem('token')
    localStorage.removeItem(SESSION_FLAG)
    localStorage.removeItem('user')
  } catch { /* private mode */ }
}

/** Revoke the server session, clear the cookie, then drop local session state. */
export function logoutSession(): void {
  const token = getToken()
  clearAuth()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    void Promise.resolve(fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers,
      keepalive: true,
    })).catch(() => {})
  } catch { /* offline */ }
}

/** Fetch JSON with auth headers; throws on non-2xx with the server error text. */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: init.credentials ?? 'include',
    headers: { ...authHeaders(!(init.body instanceof FormData)), ...(init.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`)
  return data as T
}