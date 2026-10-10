import { describe, expect, it, vi } from 'vitest'
import { LOOPIT_API_BASE, createLoopitClient, resolvePreviewUrl } from '@loop/loopit-client'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('resolvePreviewUrl', () => {
  it('routes an engine data-plane path through the /api/loopit gateway', () => {
    expect(resolvePreviewUrl('/api/projects/proj_1/site/t/tok/index.html')).toBe(
      '/api/loopit/api/projects/proj_1/site/t/tok/index.html',
    )
  })

  it('is idempotent: an already-gatewayed path passes through unchanged', () => {
    const routed = `${LOOPIT_API_BASE}/api/projects/proj_1/site/t/tok/index.html`
    expect(resolvePreviewUrl(routed)).toBe(routed)
  })

  it('passes absolute http(s) URLs through untouched', () => {
    expect(resolvePreviewUrl('https://cdn.example.com/site/index.html')).toBe('https://cdn.example.com/site/index.html')
    expect(resolvePreviewUrl('http://localhost:8000/api/projects/p/site/t/t/index.html'))
      .toBe('http://localhost:8000/api/projects/p/site/t/t/index.html')
  })

  it('joins a bare relative path onto the base', () => {
    expect(resolvePreviewUrl('site/t/tok/index.html', '/api/loopit')).toBe('/api/loopit/site/t/tok/index.html')
  })

  it('prefixes engine paths against a direct-engine base URL too', () => {
    expect(resolvePreviewUrl('/api/projects/p/site/t/t/index.html', 'http://loopit-api:8000/')).toBe(
      'http://loopit-api:8000/api/projects/p/site/t/t/index.html',
    )
  })

  it('treats an exact-base path as already routed', () => {
    expect(resolvePreviewUrl('/api/loopit', '/api/loopit')).toBe('/api/loopit')
  })
})

describe('createLoopitClient site URL surfaces', () => {
  /** Routes the cookie-mint call and one data-plane call separately. */
  function routingFetch(data: () => unknown) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      return json(data())
    })
  }

  it('gateway-prefixes the preview URL minted by the engine', async () => {
    const fetchImpl = routingFetch(() => ({
      url: '/api/projects/proj_1/site/t/tok/index.html',
      expires_at: 0,
      token_type: 'signed_url',
    }))
    const client = createLoopitClient({ fetchImpl })
    await expect(client.createPreviewUrl('proj_1')).resolves.toBe(
      '/api/loopit/api/projects/proj_1/site/t/tok/index.html',
    )
    expect(String(fetchImpl.mock.calls.at(-1)?.[0])).toBe('/api/loopit/projects/proj_1/preview')
  })

  it('gateway-prefixes production_url in the deploy response', async () => {
    const fetchImpl = routingFetch(() => ({
      deployment_id: 'dep_1',
      project_id: 'proj_1',
      checkpoint_id: 'cp_1',
      status: 'live',
      production_url: '/api/projects/proj_1/site/t/tok/index.html',
      reason: 'ship it',
    }))
    const client = createLoopitClient({ fetchImpl })
    const result = await client.deployProject('proj_1', 'cp_1', 'ship it')
    expect(result.production_url).toBe('/api/loopit/api/projects/proj_1/site/t/tok/index.html')
    expect(result.status).toBe('live')
  })
})
