import { beforeEach, describe, expect, it, vi } from 'vitest'
import { uploadBuildImage } from '../attachments'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/signed-link')) {
      return new Response(JSON.stringify({ url: '/api/files/att_1/content' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ attachmentId: 'att_1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
})

describe('uploadBuildImage', () => {
  it('stores an absolute url when API_URL is empty', async () => {
    const file = new File(['png'], 'shot.png', { type: 'image/png' })
    const result = await uploadBuildImage(file)
    expect(result.url).toBe(`${window.location.origin}/api/files/att_1/content`)
    expect(result.url.startsWith('http')).toBe(true)
  })
})
