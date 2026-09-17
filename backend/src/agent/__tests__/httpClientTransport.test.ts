import { afterEach, describe, expect, it, vi } from 'vitest'
const request = vi.hoisted(() => vi.fn())
vi.mock('../../services/providerHttp', () => ({ providerRequest: request }))
import { checkedMedia, decodeMedia, fetchBuffer, fetchText, getJson, mediaOperation, mediaUrl, postForm, postJson } from '../httpClient'

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

describe('legacy HTTP helpers cannot bypass provider policy', () => {
  it('routes all helpers through providerRequest and never infers credential permission', async () => {
    request.mockResolvedValue({ text: async () => 'text', json: async () => ({ ok: true }), body: Buffer.from('bytes') })
    const url = 'https://public.example/test'
    const signal = new AbortController().signal
    const options = { signal, headers: { Authorization: 'Bearer fixture' } }
    expect(await fetchText(url, options)).toBe('text')
    expect(await getJson(url, options)).toEqual({ ok: true })
    await postJson(url, { hello: 'world' }, options)
    await postForm(url, { hello: 'a b' }, options)
    expect(await fetchBuffer(url, options)).toEqual(Buffer.from('bytes'))
    expect(request).toHaveBeenCalledTimes(5)
    for (const [calledUrl, opts] of request.mock.calls) {
      expect(calledUrl).toBe(url)
      expect(opts.signal).toBe(signal)
      expect(opts.allowedOrigins).toBeUndefined()
      expect(opts.redirect).toBeUndefined()
    }
    expect(request.mock.calls[2][1].body).toBe('{"hello":"world"}')
    expect(request.mock.calls[3][1].body).toEqual(Buffer.from('hello=a+b'))
  })
  it('propagates transport rejections and rejects unsupported methods', async () => {
    request.mockRejectedValue(new Error('Provider transport request failed'))
    await expect(fetchText('http://localhost/private')).rejects.toThrow('Provider transport')
    await expect(fetchBuffer('https://public.example', { method: 'DELETE' })).rejects.toThrow('Unsupported HTTP method')
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('media operation guards', () => {
  it('keeps signed queries and standard URL resolution; rejects ambiguous or credential-bearing URLs', () => {
    expect(mediaUrl('../result?sig=a%2Fb&x=1', 'https://provider.example/api/generate')).toBe('https://provider.example/result?sig=a%2Fb&x=1')
    for (const url of ['http://host/file', 'file:///private', 'https://user:pass@host/file', 'https://host/file#x', 'https://host/\npath', 'https://host\\path']) {
      expect(() => mediaUrl(url)).toThrow('Invalid media URL')
    }
  })
  it('rejects empty and malformed base64 and oversized decoded data', () => {
    expect(decodeMedia('data:video/mp4;base64,SGVsbG8=')).toEqual(Buffer.from('Hello'))
    for (const value of ['', 'a', '%bad', 'data:video/mp4,no-base64']) expect(() => decodeMedia(value)).toThrow()
    expect(() => checkedMedia(Buffer.alloc(50 * 1024 * 1024 + 1))).toThrow('Invalid media size')
  })
  it('bounds all waits to the original deadline and releases cancellation listeners', async () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const remove = vi.spyOn(external.signal, 'removeEventListener')
    const op = mediaOperation(1000, external.signal)
    await vi.advanceTimersByTimeAsync(600)
    expect(op.remaining()).toBe(400)
    const sleeping = op.sleep(5000).catch(error => error)
    await vi.advanceTimersByTimeAsync(400)
    expect(await sleeping).toBeInstanceOf(Error)
    expect(op.signal.aborted).toBe(true)
    expect(() => op.remaining()).toThrow('timed out')
    op.dispose()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
  it('honors an already-aborted caller before work starts', () => {
    const controller = new AbortController()
    controller.abort(new Error('sensitive reason'))
    const op = mediaOperation(1000, controller.signal)
    expect(() => op.check()).toThrow('Media operation cancelled')
    op.dispose()
  })
})
