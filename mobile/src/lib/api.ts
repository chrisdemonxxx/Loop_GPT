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

// ── Workspaces + projects (parity with the web IA) ────────────────────────────
export interface Workspace { id: string; personalOwnerId?: string }
export interface Project {
  id: string
  name: string
  instructions: string
  _count?: { knowledgeChunks: number; conversations: number }
}

export const workspaces = {
  personal: () => api<{ workspace: Workspace }>('/api/workspaces/personal', { method: 'POST', body: '{}' }),
  list: () => api<{ workspaces: Workspace[] }>('/api/workspaces'),
}

export const projects = {
  list: (workspaceId: string) => api<Project[]>(`/api/workspaces/${workspaceId}/projects`),
  create: (workspaceId: string, name: string, instructions: string) =>
    api<Project>(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', body: JSON.stringify({ name, instructions }) }),
  remove: (workspaceId: string, id: string) =>
    api(`/api/workspaces/${workspaceId}/projects/${id}`, { method: 'DELETE' }),
}

// ── Settings surfaces (parity: memory, personalization, skills, connectors) ──
export interface MemoryRow { id: string; content: string; source?: string; tags: string[]; updatedAt: string }
export const memory = {
  list: () => api<{ memories: MemoryRow[]; enabled: boolean }>('/api/memory'),
  add: (content: string) => api('/api/memory', { method: 'POST', body: JSON.stringify({ content }) }),
  remove: (id: string) => api(`/api/memory/${id}`, { method: 'DELETE' }),
  setEnabled: (enabled: boolean) => api('/api/memory/enabled', { method: 'POST', body: JSON.stringify({ enabled }) }),
}

export interface StyleRow { id: string; name: string; isDefault: boolean }
export const stylesApi = {
  list: () => api<StyleRow[]>('/api/styles'),
  makeDefault: (id: string) => api(`/api/styles/${id}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) }),
}

export interface SkillRow { id: string; name: string; description: string; enabled: boolean; builtin?: boolean }
export const skills = {
  list: () => api<SkillRow[]>('/api/agent/skills'),
  toggle: (id: string, enabled: boolean) => api(`/api/agent/skills/${id}`, { method: 'POST', body: JSON.stringify({ enabled }) }),
}

export interface ConnectorRow { id: string; type: string; name: string; enabled: boolean; lastTestOk?: boolean | null }
export const connectors = {
  list: () => api<{ types: Array<{ type: string; name: string; oauth: boolean }>; configured: ConnectorRow[]; marketplace: Array<{ type: string; name: string }> }>('/api/agent/connectors'),
}
