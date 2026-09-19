/**
 * Hardened-backend API client. Same security posture as the web product UI:
 * the JWT lives ONLY in module memory (never AsyncStorage/device storage), so
 * app restarts require sign-in. 401 responses clear the session.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://web-production-20d369.up.railway.app'

let memoryToken: string | null = null
export function getToken(): string | null { return memoryToken }
export function setAuth(token: string): void { memoryToken = token || null }
export function clearAuth(): void { memoryToken = null }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (memoryToken) headers.Authorization = `Bearer ${memoryToken}`
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_URL}${path}`, { ...init, headers })
  if (res.status === 401) { clearAuth(); throw new ApiError(401, 'session_expired', 'Session expired. Sign in again.') }
  if (!res.ok) {
    let code = 'request_failed'
    try { const body = await res.json(); if (body?.error?.code) code = body.error.code } catch {}
    throw new ApiError(res.status, code, `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export interface User { id: string; email: string; name?: string; role: string; plan: string }
export interface Conversation { id: string; title: string; createdAt: string }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; createdAt: string }

export const auth = {
  async register(email: string, password: string, name: string): Promise<{ user: User }> {
    return api('/api/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) })
  },
  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    return api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  },
}

export const conversations = {
  list: () => api<Conversation[]>('/api/conversations'),
  messages: (id: string) => api<Message[]>(`/api/conversations/${id}/messages`),
  remove: (id: string) => api(`/api/conversations/${id}`, { method: 'DELETE' }),
}
