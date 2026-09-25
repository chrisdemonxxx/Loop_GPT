import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { buildWorker, iconPng } from '../build/pwa'

const shell = ['/index.html', '/assets/main-123.js', '/assets/main-123.css', '/manifest.webmanifest']
function worker() {
  const handlers: Record<string, (event: any) => void> = {}
  const cache = { put: vi.fn(), match: vi.fn().mockResolvedValue('cached-shell') }
  const caches = { open: vi.fn().mockResolvedValue(cache), keys: vi.fn().mockResolvedValue(['other-app-cache', 'loop-owned-shell-old']), delete: vi.fn() }
  const fetcher = vi.fn().mockResolvedValue({ ok: true, type: 'basic' })
  class InstallRequest {
    constructor(public url: string, public options: RequestInit) {}
  }
  const self = { location: { origin: 'https://web.example.com' }, clients: { claim: vi.fn() }, addEventListener: (name: string, callback: (event: any) => void) => { handlers[name] = callback } }
  runInNewContext(buildWorker(shell, 'test'), { self, caches, fetch: fetcher, URL, Request: InstallRequest })
  return { handlers, cache, caches, fetcher }
}
describe('app-shell-only service worker', () => {
  it('install fetches only build allowlist with credentials omitted; no authenticated responses', async () => {
    const { handlers, cache, fetcher } = worker()
    let task: Promise<void> | undefined
    handlers.install({ waitUntil: (promise: Promise<void>) => { task = promise } })
    await task
    expect(cache.put.mock.calls.map(([path]) => path)).toEqual(shell)
    for (const [request] of fetcher.mock.calls) {
      expect(request.options).toEqual({ credentials: 'omit', cache: 'reload', redirect: 'error' })
      expect(shell).toContain(request.url)
    }
  })
  it.each([
    ['/api/agent/new/stream', 'POST', false], ['/api/files/123/content', 'GET', false],
    ['/api/auth/login', 'POST', false], ['/api/workspaces', 'GET', false],
    ['/api/developer/overview', 'GET', false], ['/v1/chat/completions', 'GET', false],
    ['/uploads/private.png', 'GET', false], ['/assets/main-123.js', 'GET', true],
    ['/index.html?token=do-not-cache', 'GET', false], ['/other-page', 'GET', false],
    ['https://api.example.com/assets/main-123.js', 'GET', false],
  ])('does not intercept %s (%s, auth=%s)', (path, method, authenticated) => {
    const { handlers, caches, cache, fetcher } = worker()
    const respondWith = vi.fn()
    handlers.fetch({ request: { url: new URL(path as string, 'https://web.example.com').href, method, mode: 'navigate',
      headers: new Headers(authenticated ? { Authorization: 'Bearer test-jwt' } : {}) }, respondWith })
    expect(respondWith).not.toHaveBeenCalled()
    expect(caches.open).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('serves cached shell for root navigation without runtime writes', async () => {
    const { handlers, cache, fetcher } = worker()
    let response: Promise<unknown> | undefined
    handlers.fetch({ request: { url: 'https://web.example.com/', method: 'GET', mode: 'navigate', headers: new Headers() }, respondWith: (value: Promise<unknown>) => { response = value } })
    expect(await response).toBe('cached-shell')
    expect(cache.match).toHaveBeenCalledWith('/index.html')
    expect(cache.put).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('cleans only its own previous shell caches', async () => {
    const { handlers, caches } = worker()
    let task: Promise<void> | undefined
    handlers.activate({ waitUntil: (value: Promise<void>) => { task = value } })
    await task
    expect(caches.delete.mock.calls).toEqual([['loop-owned-shell-old']])
  })
  it('rejects APIs or arbitrary paths in build-time precache', () => {
    expect(() => buildWorker(['/api/workspaces'], 'test')).toThrow()
    expect(() => buildWorker(['/assets/../api'], 'test')).toThrow()
  })
  it('emits valid PNG signatures and requested dimensions for iOS/install icons', () => {
    const image = iconPng(180)
    expect([...image.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(image.readUInt32BE(16)).toBe(180)
    expect(image.readUInt32BE(20)).toBe(180)
  })
})
