import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'http'
import express from 'express'

// The TTS upstreams are external (HF endpoint / Kokoro Space): stub the
// transport and pin the route's contract â€” voice mapping, text cap, the
// Gradio submitâ†’SSEâ†’download chain, and error shapes.
const providerRequest = vi.hoisted(() => vi.fn())
vi.mock('../../services/providerHttp', () => ({ providerRequest }))
vi.mock('../../services/billing', () => ({ recordUsage: vi.fn(async () => {}), estimateTokens: (t: string) => Math.ceil(t.length / 4) }))
process.env.NODE_ENV = 'development'
process.env.ENABLE_DEV_MODE = 'true'
delete process.env.HF_TTS_ENDPOINT_URL

import { ttsRouter } from '../tts'

let server: Server
let base: string

/** A providerRequest response shaped like fetch's Response. */
function res(init: { status?: number; contentType?: string; json?: any; text?: string; arrayBuffer?: Buffer }) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? init.contentType : undefined) },
    json: async () => init.json ?? null,
    text: async () => init.text ?? '',
    arrayBuffer: async () => (init.arrayBuffer ?? Buffer.alloc(0)).buffer.slice(
      (init.arrayBuffer ?? Buffer.alloc(0)).byteOffset,
      (init.arrayBuffer ?? Buffer.alloc(0)).byteOffset + (init.arrayBuffer ?? Buffer.alloc(0)).length,
    ),
  }
}

const WAV = Buffer.from('RIFF____WAVEfmt ')

/** Wire the full Space chain for a successful call. */
function mockSpaceSuccess() {
  providerRequest.mockReset()
  // 1) submit â†’ { event_id }
  providerRequest.mockResolvedValueOnce(res({ json: { event_id: 'evt-1' } }))
  // 2) SSE stream â†’ complete with an audio file URL
  providerRequest.mockResolvedValueOnce(res({
    text: 'event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"path":"/tmp/gradio/x/audio.wav","url":"/gradio_api/file=/tmp/gradio/x/audio.wav","orig_name":"audio.wav","meta":{"_type":"gradio.FileData"}},"text back"]\n\n',
  }))
  // 3) audio download â†’ WAV bytes
  providerRequest.mockResolvedValueOnce(res({ contentType: 'application/octet-stream', arrayBuffer: WAV }))
}

async function post(body: unknown) {
  const r = await fetch(`${base}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const buf = Buffer.from(await r.arrayBuffer())
  let json: any = null
  try { json = JSON.parse(buf.toString()) } catch { /* audio bytes */ }
  return { status: r.status, contentType: r.headers.get('content-type'), buf, json }
}

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/tts', ttsRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as any).port}`
})

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

describe('POST /api/tts (Â§8-45)', () => {
  it('generates audio through the Kokoro Space chain (submit â†’ SSE â†’ download)', async () => {
    mockSpaceSuccess()
    const r = await post({ text: 'Hello world' })
    expect(r.status).toBe(200)
    expect(r.contentType).toBe('audio/wav')
    expect(r.buf.subarray(0, 4).toString()).toBe('RIFF')
    // The submit carried the mapped default voice + speed.
    const submit = JSON.parse(providerRequest.mock.calls[0][1].body)
    expect(submit.data[0]).toBe('Hello world')
    expect(submit.data[1]).toBe('af_heart')
    expect(submit.data[2]).toBe(1)
  })

  it('passes valid Kokoro voice ids through and normalizes junk', async () => {
    mockSpaceSuccess()
    await post({ text: 'Hi', voice: 'am_adam' })
    expect(JSON.parse(providerRequest.mock.calls[0][1].body).data[1]).toBe('am_adam')
    mockSpaceSuccess()
    await post({ text: 'Hi', voice: 'Samantha (en-US)' })
    expect(JSON.parse(providerRequest.mock.calls[0][1].body).data[1]).toBe('af_heart')
  })

  it('clamps speed to the 0.5â€“2 range', async () => {
    mockSpaceSuccess()
    await post({ text: 'Hi', speed: 10 })
    expect(JSON.parse(providerRequest.mock.calls[0][1].body).data[2]).toBe(2)
    mockSpaceSuccess()
    await post({ text: 'Hi', speed: 0.1 })
    expect(JSON.parse(providerRequest.mock.calls[0][1].body).data[2]).toBe(0.5)
  })

  it('caps text at 4000 characters', async () => {
    mockSpaceSuccess()
    await post({ text: 'x'.repeat(9000) })
    expect(JSON.parse(providerRequest.mock.calls[0][1].body).data[0].length).toBe(4000)
  })

  it('rejects empty text with 400', async () => {
    const r = await post({ text: '   ' })
    expect(r.status).toBe(400)
  })

  it('returns 502 when the Space stream errors', async () => {
    providerRequest.mockReset()
    providerRequest.mockResolvedValueOnce(res({ json: { event_id: 'evt-2' } }))
    providerRequest.mockResolvedValueOnce(res({ text: 'event: error\ndata: "boom"\n\n' }))
    const r = await post({ text: 'Hello' })
    expect(r.status).toBe(502)
    expect(r.json.error).toContain('Text-to-speech')
  })

  it('uses the dedicated HF_TTS_ENDPOINT_URL when configured', async () => {
    process.env.HF_TTS_ENDPOINT_URL = 'https://my-tts.endpoints.huggingface.cloud'
    providerRequest.mockReset()
    providerRequest.mockResolvedValueOnce(res({ contentType: 'audio/wav', arrayBuffer: WAV }))
    const r = await post({ text: 'Hello', voice: 'af_heart' })
    expect(r.status).toBe(200)
    const [url, init] = providerRequest.mock.calls[0]
    expect(String(url)).toBe('https://my-tts.endpoints.huggingface.cloud')
    expect(JSON.parse(init.body)).toMatchObject({ inputs: 'Hello', parameters: { voice: 'af_heart' } })
    delete process.env.HF_TTS_ENDPOINT_URL
  })
})
