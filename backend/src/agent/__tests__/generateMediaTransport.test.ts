import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), sidecar: vi.fn(), save: vi.fn(), credit: vi.fn() }))
vi.mock('../../services/providerHttp', () => ({ providerRequest: mocks.request, sidecarRequest: mocks.sidecar }))
vi.mock('../artifacts', () => ({ saveArtifact: mocks.save }))
vi.mock('../../services/billing', () => ({ recordUsage: vi.fn() }))
vi.mock('../../services/dailyReservations', async original => ({
  ...await original<typeof import('../../services/dailyReservations')>(),
  reserveDailyCredits: mocks.credit, dailyDispatch: () => vi.fn(), cleanupDailyReservation: vi.fn(),
}))
import { generateImageTool } from '../tools/generateImage'
import { generateVideoTool } from '../tools/generateVideo'
import { IMAGE_RESPONSE_BYTES, VIDEO_RESPONSE_BYTES } from '../httpClient'

const endpoint = 'https://provider.example/api/generate?deployment=test'
const bytes = Buffer.from('fixture media')
const b64 = bytes.toString('base64')
function response(data: unknown, raw = false) {
  return { status: 200, ok: true, headers: new Headers({ 'content-type': raw ? 'video/mp4' : 'application/json' }),
    body: raw ? data : Buffer.from(JSON.stringify(data)), json: async () => data }
}
function ctx(signal?: AbortSignal) { return { userId: 'owner', conversationId: 'conversation', scratch: {}, emit: vi.fn(), signal } }

beforeEach(() => {
  vi.useFakeTimers()
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.credit.mockResolvedValue({ id: 'fixture-reservation' })
  mocks.save.mockResolvedValue({ id: 'artifact', url: '/api/files/artifact/content' })
  vi.stubEnv('HF_TOKEN', 'fixture-token')
  vi.stubEnv('HF_IMAGE_ENDPOINT_URL', endpoint)
  vi.stubEnv('HF_IMAGE_PROVIDER', '')
  vi.stubEnv('HF_IMAGE_MODEL', 'fixture-model')
  // Keep the original 5-minute budget in tests regardless of prod defaults.
  vi.stubEnv('HF_IMAGE_MAX_WAIT_MS', '300000')
  vi.stubEnv('HF_VIDEO_MAX_WAIT_MS', '300000')
  vi.stubEnv('IMAGE_API_URL', '')
  vi.stubEnv('VIDEO_API_URL', endpoint)
  vi.stubEnv('HF_VIDEO_ENDPOINT_URL', '')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs() })

describe('image provider migration', () => {
  it.each([generateImageTool, generateVideoTool])('fails closed when credit verification rejects for $name', async tool => {
    mocks.credit.mockRejectedValue(new Error('private database failure'))
    const result = await tool.handler({ prompt: 'fixture' }, ctx())
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('private database failure')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(mocks.sidecar).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it.each([response(bytes, true), response({ image: b64 }), response({ data: [{ b64_json: `data:image/png;base64,${b64}` }] })])(
    'decodes raw and base64 images and retains reference strength zero and owner bindings', async result => {
      mocks.request.mockResolvedValue(result)
      expect((await generateImageTool.handler({ prompt: 'fixture', image_prompt: b64, strength: 0 }, ctx())).isError).toBeUndefined()
      const [url, options] = mocks.request.mock.calls[0]
      expect(url).toBe(endpoint)
      expect(options).toMatchObject({ allowedOrigins: ['https://provider.example'], maxBytes: IMAGE_RESPONSE_BYTES,
        headers: { Authorization: 'Bearer fixture-token' } })
      expect(JSON.parse(options.body)).toMatchObject({ image: b64, parameters: { strength: 0 } })
      expect(mocks.save).toHaveBeenCalledWith(expect.any(String), bytes, { userId: 'owner', conversationId: 'conversation' })
    })

  it.each(['https://cdn.example/img?sig=a%2Fb&expires=42', 'https://provider.example/img?sig=secret'])('downloads returned image URLs anonymously: %s', async url => {
    mocks.request.mockResolvedValueOnce(response({ data: [{ url }] })).mockResolvedValueOnce(response(bytes, true))
    await generateImageTool.handler({ prompt: 'fixture' }, ctx())
    expect(mocks.request.mock.calls[1][0]).toBe(url)
    expect(mocks.request.mock.calls[1][1]).not.toHaveProperty('headers')
    expect(mocks.request.mock.calls[1][1]).not.toHaveProperty('allowedOrigins')
    expect(mocks.save).toHaveBeenCalled()
  })

  it('preserves dedicated -> fixed HF providers -> sidecar order and model is only payload data', async () => {
    vi.stubEnv('HF_IMAGE_MODEL', '../../arbitrary-provider')
    vi.stubEnv('IMAGE_API_URL', 'http://localhost:8081')
    mocks.request.mockRejectedValue(new Error('upstream secret'))
    mocks.sidecar.mockResolvedValueOnce(response({ healthy: true })).mockResolvedValueOnce(response({ image_base64: b64 }))
    const result = await generateImageTool.handler({ prompt: 'fixture', image_prompt: b64, strength: 0.25 }, ctx())
    expect(result.isError).toBeUndefined()
    expect(mocks.request.mock.calls.map(call => call[0])).toEqual([endpoint,
      ...['fal-ai', 'together', 'nscale'].map(provider => `https://router.huggingface.co/${provider}/v1/images/generations`)])
    expect(JSON.parse(mocks.request.mock.calls[1][1].body)).toMatchObject({ image: b64, strength: 0.25, model: '../../arbitrary-provider' })
    expect(mocks.sidecar.mock.calls.map(call => call[0])).toEqual(['/health', '/api/generate'])
  })

  it('rejects arbitrary configured provider segments', async () => {
    vi.stubEnv('HF_IMAGE_ENDPOINT_URL', '')
    vi.stubEnv('HF_IMAGE_PROVIDER', 'evil/../../nscale')
    expect((await generateImageTool.handler({ prompt: 'fixture' }, ctx())).isError).toBe(true)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('never falls back after cancellation and sanitizes model errors', async () => {
    const controller = new AbortController()
    mocks.request.mockImplementation(async () => { controller.abort(); throw new Error('secret query and token') })
    const result = await generateImageTool.handler({ prompt: 'fixture' }, ctx(controller.signal))
    expect(result).toMatchObject({ isError: true, content: 'Media operation cancelled' })
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.sidecar).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('shares the deadline across fallbacks and aborts the last request without another fallback', async () => {
    mocks.request.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 179000); throw new Error('failed') })
      .mockImplementationOnce(async (_url, options) => {
        expect(options.timeoutMs).toBe(120000)
        vi.setSystemTime(Date.now() + 120000)
        throw new Error('failed')
      }).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
        expect(options.timeoutMs).toBe(1000)
        options.signal.addEventListener('abort', () => reject(new Error('secret')), { once: true })
      }))
    const result = generateImageTool.handler({ prompt: 'fixture' }, ctx())
    // setSystemTime changes wall time but not timers; let the original budget timer fire.
    await vi.advanceTimersByTimeAsync(300000)
    expect(await result).toMatchObject({ isError: true, content: 'Media operation timed out' })
    expect(mocks.request).toHaveBeenCalledTimes(3)
  })
})

describe('video provider migration', () => {
  it.each([response(bytes, true), response({ video_base64: b64 }), response({ video: `data:video/mp4;base64,${b64}` }),
    response({ data: [{ b64_json: b64 }] })])('supports synchronous media envelopes', async result => {
    mocks.request.mockResolvedValue(result)
    expect((await generateVideoTool.handler({ prompt: 'fixture', image_prompt: b64 }, ctx())).isError).toBeUndefined()
    expect(mocks.request.mock.calls[0][1]).toMatchObject({ maxBytes: VIDEO_RESPONSE_BYTES, allowedOrigins: ['https://provider.example'] })
    expect(JSON.parse(mocks.request.mock.calls[0][1].body)).toMatchObject({ image: b64, parameters: { guidance_scale: 7.5 } })
    expect(mocks.save).toHaveBeenCalledWith(expect.any(String), bytes, { userId: 'owner', conversationId: 'conversation' })
  })

  it.each(['https://cdn.example/video?sig=a%2Fb&x=1', '/results/123?sig=a%2Fb'])('segregates tokens for direct URL results: %s', async url => {
    mocks.request.mockResolvedValueOnce(response({ video_url: url })).mockResolvedValueOnce(response(bytes, true))
    await generateVideoTool.handler({ prompt: 'fixture' }, ctx())
    const [download, options] = mocks.request.mock.calls[1]
    expect(download).toBe(new URL(url, endpoint).href)
    if (url.startsWith('/')) expect(options).toMatchObject({ allowedOrigins: ['https://provider.example'], headers: { Authorization: 'Bearer fixture-token' } })
    else { expect(options.headers.Authorization).toBeUndefined(); expect(options.allowedOrigins).toBeUndefined() }
  })

  it('resolves async status paths safely and downloads cross-origin results anonymously', async () => {
    mocks.request.mockResolvedValueOnce(response({ job_id: 'job', status_url: '/jobs/job?sig=a%2Fb', result_url: 'https://cdn.example/result?sig=x' }))
      .mockResolvedValueOnce(response({ status: 'completed' })).mockResolvedValueOnce(response(bytes, true))
    expect((await generateVideoTool.handler({ prompt: 'fixture' }, ctx())).isError).toBeUndefined()
    expect(mocks.request.mock.calls[1][0]).toBe('https://provider.example/jobs/job?sig=a%2Fb')
    expect(mocks.request.mock.calls[1][1]).toMatchObject({ allowedOrigins: ['https://provider.example'], headers: { Authorization: 'Bearer fixture-token' } })
    expect(mocks.request.mock.calls[2][1].headers.Authorization).toBeUndefined()
  })

  it.each(['https://evil.example/job', '//evil.example/job', 'https://provider.example:444/job', 'https://user:pass@provider.example/job'])('rejects unsafe status URLs before attaching credentials: %s', async status_url => {
    mocks.request.mockResolvedValueOnce(response({ job_id: 'job', status_url, result_url: '/result' }))
    const result = await generateVideoTool.handler({ prompt: 'fixture' }, ctx())
    expect(result).toMatchObject({ isError: true, content: 'Video generation failed' })
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })

  it('aborts poll sleeps immediately on caller cancellation', async () => {
    const controller = new AbortController()
    mocks.request.mockResolvedValueOnce(response({ job_id: 'job', status_url: '/job', result_url: '/result' }))
      .mockResolvedValue(response({ status: 'processing' }))
    const result = generateVideoTool.handler({ prompt: 'fixture' }, ctx(controller.signal))
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.request).toHaveBeenCalledTimes(2)
    controller.abort()
    expect(await result).toMatchObject({ isError: true, content: 'Media operation cancelled' })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('does not reflect provider errors and does not save oversized artifacts', async () => {
    mocks.request.mockResolvedValueOnce(response({ job_id: 'job', status_url: '/job', result_url: '/result' }))
      .mockResolvedValueOnce(response({ status: 'failed', error: 'token=secret signed-url' }))
    expect((await generateVideoTool.handler({ prompt: 'fixture' }, ctx())).content).toBe('Video generation failed')
    mocks.request.mockResolvedValue(response(Buffer.alloc(50 * 1024 * 1024 + 1), true))
    expect((await generateVideoTool.handler({ prompt: 'fixture' }, ctx())).isError).toBe(true)
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
