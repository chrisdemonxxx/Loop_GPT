import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const sidecar = vi.hoisted(() => vi.fn())
vi.mock('../providerHttp', () => ({ sidecarRequest: sidecar, providerRequest: vi.fn() }))
import { imageApiService } from '../imageApi'

function reply(data: unknown, status = 200) { return { status, json: async () => data } }
beforeEach(() => { vi.useFakeTimers(); sidecar.mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('image API uses fixed sidecar paths', () => {
  it('maps img2img payload, preserving zero strength and default base64 output', async () => {
    sidecar.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ image_base64: 'aGVsbG8=', model: 'flux-dev' }))
    const result = await imageApiService.generateImage({ prompt: 'fixture', image_prompt: 'reference', strength: 0, model: 'flux-dev' })
    expect(result).toMatchObject({ success: true, image_base64: 'aGVsbG8=' })
    expect(sidecar.mock.calls.map(call => call[0])).toEqual(['/health', '/api/generate'])
    const options = sidecar.mock.calls[1][1]
    expect(options).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' }, maxBytes: 16 * 1024 * 1024 })
    expect(JSON.parse(options.body)).toEqual({ prompt: 'fixture', image_prompt: 'reference', strength: 0, model: 'flux-dev', return_base64: true })
    expect(options.headers.Authorization).toBeUndefined()
  })
  it('preserves metadata-only image_path responses without reading a raw path', async () => {
    sidecar.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ image_path: '/sidecar/generated.png' }))
    expect(await imageApiService.generateImage({ prompt: 'fixture', return_base64: false })).toMatchObject({ image_path: '/sidecar/generated.png' })
    expect(sidecar).toHaveBeenCalledTimes(2)
    expect(JSON.parse(sidecar.mock.calls[1][1].body).return_base64).toBe(false)
  })
  it('routes analysis and vision through the sidecar policy, with bounded bodies and no credentials', async () => {
    sidecar.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ description: 'fixture' }))
      .mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ answer: 'answer' }))
    expect(await imageApiService.analyzeImage({ image_path: 'sidecar-image' })).toMatchObject({ description: 'fixture', success: true })
    expect(await imageApiService.visionChat({ image_path: 'sidecar-image', question: 'describe' })).toMatchObject({ answer: 'answer', success: true })
    expect(sidecar.mock.calls.map(call => call[0])).toEqual(['/health', '/api/analyze', '/health', '/api/vision-chat'])
    expect(JSON.parse(sidecar.mock.calls[1][1].body)).toEqual({ image_path: 'sidecar-image', model: 'blip' })
    expect(JSON.parse(sidecar.mock.calls[3][1].body)).toEqual({ image_path: 'sidecar-image', question: 'describe', model: 'llava' })
  })
  it('deducts health time from the generation budget', async () => {
    sidecar.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 4000); return reply({}) })
      .mockResolvedValueOnce(reply({ image_base64: 'aGVsbG8=' }))
    await imageApiService.generateImage({ prompt: 'fixture' })
    expect(sidecar.mock.calls[1][1].timeoutMs).toBe(116000)
  })
  it('stops after cancelled health and never generates', async () => {
    const controller = new AbortController()
    sidecar.mockImplementation(async () => { controller.abort(); throw new Error('token secret') })
    await expect(imageApiService.generateImage({ prompt: 'fixture' }, controller.signal)).rejects.toThrow('cancelled')
    expect(sidecar).toHaveBeenCalledTimes(1)
  })
  it('aborts an active sidecar request with the optional caller signal', async () => {
    const controller = new AbortController()
    sidecar.mockResolvedValueOnce(reply({})).mockImplementationOnce((_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('private upstream error')), { once: true })
    }))
    const result = imageApiService.generateImage({ prompt: 'fixture' }, controller.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort()
    expect((await result).message).toBe('Media operation cancelled')
    expect(sidecar.mock.calls[1][1].signal.aborted).toBe(true)
  })
  it('sanitizes health and generation failures instead of reflecting upstream data', async () => {
    sidecar.mockRejectedValue(new Error('secret-url token=secret raw upstream body'))
    expect(await imageApiService.healthCheck()).toEqual({ healthy: false, error: 'Image API is not reachable' })
    await expect(imageApiService.generateImage({ prompt: 'fixture' })).rejects.toThrow(/^Image generation failed$/)
    await expect(imageApiService.analyzeImage({ image_path: 'fixture' })).rejects.toThrow(/^Image analysis failed$/)
    await expect(imageApiService.visionChat({ image_path: 'fixture', question: 'q' })).rejects.toThrow(/^Vision chat failed$/)
  })
  it('keeps health timeout compatible with existing callers while forwarding cancellation', async () => {
    sidecar.mockImplementation((_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
    }))
    const result = imageApiService.healthCheck()
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toEqual({ healthy: false, error: 'Image API is not reachable' })
    const controller = new AbortController()
    controller.abort()
    await expect(imageApiService.healthCheck(controller.signal)).rejects.toThrow('cancelled')
  })
})
