import { apiOrigin, ClientError, filePath, readBounded, record, resourceId, text } from './security'
import { consumeStream, type StreamEvent } from './stream'

export interface Session { token: string; name: string }
export interface Workspace { id: string; name: string; role: 'owner' | 'editor' | 'viewer'; personal: boolean }
export interface Overview { balance: number; requests: number; spend: number; tokens: number }
export type Mode = 'chat' | 'agent' | 'research'

export class Api {
  readonly origin: string
  constructor(origin = '', private readonly fetcher: typeof fetch = (...args) => fetch(...args)) { this.origin = apiOrigin(origin) }

  private async request(path: string, token: string | undefined, signal: AbortSignal, body?: unknown, accept = 'application/json'): Promise<Response> {
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#')) throw new ClientError('config')
    const headers = new Headers({ Accept: accept })
    if (token) headers.set('Authorization', `Bearer ${token}`)
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    let response: Response
    try {
      response = await this.fetcher(this.origin + path, {
        method: body === undefined ? 'GET' : 'POST', headers, signal,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new ClientError('network')
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ClientError('http', response.status)
    }
    return response
  }

  private async json(path: string, token: string | undefined, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await this.request(path, token, signal, body)
    if (!response.headers.get('content-type')?.includes('application/json')) {
      await response.body?.cancel()
      throw new ClientError('protocol')
    }
    const bytes = await readBounded(response, 2 * 1024 * 1024)
    try { return JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new ClientError('protocol') }
  }

  async login(email: string, password: string, signal: AbortSignal): Promise<Session> {
    const result = record(await this.json('/api/auth/login', undefined, signal, { email, password }))
    const token = text(result.token, 16_384)
    if (!token || /\s/.test(token)) throw new ClientError('protocol')
    const user = record(result.user)
    return { token, name: text(user.name ?? user.email, 500) }
  }

  async workspaces(token: string, signal: AbortSignal): Promise<Workspace[]> {
    const result: Workspace[] = []
    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const page = record(await this.json(`/api/workspaces${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, token, signal))
      if (!Array.isArray(page.workspaces)) throw new ClientError('protocol')
      for (const row of page.workspaces) {
        const item = record(row)
        if (!['owner', 'editor', 'viewer'].includes(String(item.role))) throw new ClientError('protocol')
        const id = resourceId(item.id)
        if (!result.some((entry) => entry.id === id)) result.push({ id, name: text(item.name, 500), role: item.role as Workspace['role'], personal: typeof item.personalOwnerId === 'string' })
      }
      cursor = page.nextCursor == null ? null : resourceId(page.nextCursor)
      if (cursor && seen.has(cursor)) throw new ClientError('protocol')
      if (cursor) seen.add(cursor)
      if (seen.size > 100) throw new ClientError('tooLarge')
    } while (cursor)
    return result
  }

  async provisionPersonal(token: string, signal: AbortSignal): Promise<void> {
    await this.json('/api/workspaces/personal', token, signal, {})
  }

  async stream(token: string, conversation: string, workspace: string, content: string, mode: Mode,
    signal: AbortSignal, emit: (event: StreamEvent) => void) {
    const response = await this.request(`/api/agent/${resourceId(conversation)}/stream`, token, signal, {
      content, workspaceId: resourceId(workspace), mode, connectionIds: [],
      ...(mode === 'chat' ? { toolNames: [] } : {}),
    }, 'text/event-stream')
    await consumeStream(response, signal, emit)
  }

  async download(token: string, id: string, signal: AbortSignal): Promise<Blob> {
    const response = await this.request(filePath(id), token, signal, undefined, 'application/octet-stream')
    const bytes = await readBounded(response, 50 * 1024 * 1024)
    // Force download-only bytes. Never create same-origin active HTML/SVG previews.
    return new Blob([bytes as BlobPart], { type: 'application/octet-stream' })
  }

  async overview(token: string, signal: AbortSignal): Promise<Overview> {
    const result = record(await this.json('/api/developer/overview', token, signal))
    const usage = record(result.usage)
    const number = (value: unknown) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ClientError('protocol')
      return value
    }
    return { balance: number(result.balanceUsd), requests: number(usage.requests), spend: number(usage.spendUsd), tokens: number(usage.tokensIn) + number(usage.tokensOut) }
  }
}

export function defaultWorkspace(workspaces: Workspace[]): string {
  return (workspaces.find((w) => w.personal && w.role !== 'viewer') ?? workspaces.find((w) => w.role !== 'viewer') ?? workspaces[0])?.id ?? ''
}
