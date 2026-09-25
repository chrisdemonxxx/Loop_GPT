import { describe, expect, it, vi } from 'vitest'
import { Api } from '../src/api'

const signal = () => new AbortController().signal
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
describe('HTTP integration with mocked backend contracts', () => {
  it('logs in with exact payload and keeps credentials off URLs/cookies/caches', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ token: 'test-jwt', user: { name: 'Test' } }))
    const result = await new Api('https://api.example.com', fetcher).login('user@example.com', 'test-password', signal())
    expect(result).toEqual({ token: 'test-jwt', name: 'Test' })
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe('https://api.example.com/api/auth/login')
    expect(JSON.parse(options!.body as string)).toEqual({ email: 'user@example.com', password: 'test-password' })
    expect(options).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
    expect(new Headers(options?.headers).has('Authorization')).toBe(false)
  })
  it('paginates memberships and sends bearer only in headers', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ workspaces: [{ id: 'a', name: 'Team', role: 'editor', personalOwnerId: null }], nextCursor: 'a' }))
      .mockResolvedValueOnce(json({ workspaces: [{ id: 'b', name: 'Personal', role: 'owner', personalOwnerId: 'user' }], nextCursor: null }))
    const rows = await new Api('', fetcher).workspaces('test-jwt', signal())
    expect(rows).toHaveLength(2)
    expect(rows[1].personal).toBe(true)
    expect(fetcher.mock.calls[1][0]).toBe('/api/workspaces?after=a')
    for (const [url, options] of fetcher.mock.calls) {
      expect(String(url)).not.toContain('test-jwt')
      expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer test-jwt')
      expect(options?.cache).toBe('no-store')
    }
  })
  it('rejects looping pagination and malformed membership roles', async () => {
    const repeat = vi.fn<typeof fetch>().mockImplementation(async () => json({ workspaces: [], nextCursor: 'same' }))
    await expect(new Api('', repeat).workspaces('jwt', signal())).rejects.toThrow('protocol')
    expect(repeat).toHaveBeenCalledTimes(2)
    const invalid = vi.fn<typeof fetch>().mockResolvedValue(json({ workspaces: [{ id: 'x', name: 'X', role: 'admin' }] }))
    await expect(new Api('', invalid).workspaces('jwt', signal())).rejects.toThrow('protocol')
  })
  it('provisions only through the personal endpoint', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ workspace: { id: 'personal' } }))
    await new Api('', fetcher).provisionPersonal('jwt', signal())
    expect(fetcher.mock.calls[0][0]).toBe('/api/workspaces/personal')
    expect(fetcher.mock.calls[0][1]?.body).toBe('{}')
  })
  it.each(['chat', 'agent', 'research'] as const)('posts hosted %s with exact workspace contract, no overrides', async (mode) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('data: {"type":"final","content":"OK"}\n\ndata: {"type":"done"}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const controller = new AbortController()
    await new Api('', fetcher).stream('jwt', 'new', 'team', 'Hi', mode, controller.signal, () => {})
    expect(fetcher.mock.calls[0][0]).toBe('/api/agent/new/stream')
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal)
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({ content: 'Hi', workspaceId: 'team', mode, connectionIds: [], ...(mode === 'chat' ? { toolNames: [] } : {}) })
  })
  it('downloads authenticated bytes by ID as inert octet-stream', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }))
    const id = '12345678-1234-1234-1234-123456789abc'
    const blob = await new Api('', fetcher).download('jwt', id, signal())
    expect(blob.type).toBe('application/octet-stream')
    expect(fetcher.mock.calls[0][0]).toBe(`/api/files/${id}/content`)
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer jwt')
  })
  it('projects developer overview without retaining key metadata', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ balanceUsd: 12.34, keys: ['private metadata'], usage: { requests: 5, spendUsd: 0.5, tokensIn: 10, tokensOut: 20 } }))
    expect(await new Api('', fetcher).overview('jwt', signal())).toEqual({ balance: 12.34, requests: 5, spend: 0.5, tokens: 30 })
  })
  it.each([401, 402, 403, 404, 409, 429, 503])('preserves status %s without reading/reflecting raw error details', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'private details' }, status))
    await expect(new Api('', fetcher).workspaces('jwt', signal())).rejects.toMatchObject({ code: 'http', status, message: 'http' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects HTML fallback and propagates abort without retry', async () => {
    const fallback = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>shell</html>', { headers: { 'content-type': 'text/html' } }))
    await expect(new Api('', fallback).workspaces('jwt', signal())).rejects.toThrow('protocol')
    const controller = new AbortController(); controller.abort()
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(controller.signal.reason)
    await expect(new Api('', aborted).workspaces('jwt', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(aborted).toHaveBeenCalledTimes(1)
  })
})
