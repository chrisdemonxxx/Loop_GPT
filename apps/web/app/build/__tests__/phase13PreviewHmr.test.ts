import { describe, expect, it, vi } from 'vitest'
import { createLoopitClient } from '@loop/loopit-client'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createPreviewUrl HMR mode', () => {
  it('passes absolute HMR URLs through and sets mode', async () => {
    const hmrUrl = 'https://preview.example/p/proj_1/?token=abc'
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      return json({
        url: hmrUrl,
        expires_at: '2099-01-01T00:00:00.000Z',
        mode: 'hmr',
      })
    })
    const client = createLoopitClient({ fetchImpl })
    const preview = await client.createPreviewUrl('proj_1')
    expect(preview.url).toBe(hmrUrl)
    expect(preview.mode).toBe('hmr')
  })

  it('defaults mode to static for signed site previews', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/token')) {
        return json({ token: 'tok', expiresAt: new Date(Date.now() + 120_000).toISOString() })
      }
      return json({
        url: '/api/projects/proj_1/site/t/tok/index.html',
        expires_at: '2099-01-01T00:00:00.000Z',
      })
    })
    const client = createLoopitClient({ fetchImpl })
    const preview = await client.createPreviewUrl('proj_1')
    expect(preview.mode).toBe('static')
    expect(preview.url).toContain('/api/loopit/projects/')
  })
})
