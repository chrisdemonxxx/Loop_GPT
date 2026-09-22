// Empty string => same-origin (relative) requests, served by the platform proxy.
// Set NEXT_PUBLIC_API_URL to an absolute origin only for cross-origin API hosts.
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? ''

// Session token: kept in memory AND persisted to localStorage so a refresh does
// not sign the user out (chat history + memory then survive reloads). Auto-expires
// from the JWT `exp`.
const TOKEN_KEY = 'authToken'
let memoryToken: string | null = null

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
  return memoryToken || readStoredToken()
}

export function authHeaders(json = true): Record<string, string> {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  const token = getToken()
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

export type AgentMode = 'chat' | 'agent' | 'research'

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

export interface StoredUser {
  id: string
  email: string
  name: string
  role?: string
  plan?: string
}

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
  memoryToken = token || null
  if (token) localStorage.setItem(TOKEN_KEY, token)
  if (user) localStorage.setItem('user', JSON.stringify(user))
}

export function clearAuth() {
  memoryToken = null
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem('user')
}

/** Fetch JSON with auth headers; throws on non-2xx with the server error text. */
export async function apiFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...authHeaders(!(init.body instanceof FormData)), ...(init.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`)
  return data as T
}
