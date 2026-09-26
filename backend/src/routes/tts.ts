/**
 * Backend TTS (§8-45 — backend-quality read-aloud):
 * POST /api/tts { text, voice?, speed? } → audio bytes.
 *
 * Primary upstream: a dedicated endpoint (HF_TTS_ENDPOINT_URL) when
 * configured. Default: the Kokoro-82M Gradio Space (hysts-mcp/Kokoro-TTS)
 * via the modern /gradio_api/call flow — HF's Inference Providers dropped
 * text-to-speech support platform-wide (every router provider 400s with
 * "Model not supported"), so the historical hf-inference default is dead.
 * The Space exposes /generate(text, voice, speed) with 28 Kokoro voices.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { providerRequest } from '../services/providerHttp'
import { mediaAuth, IMAGE_RESPONSE_BYTES, mediaOperation, mediaFailure, mediaUrl } from '../agent/httpClient'
import { recordUsage, type UsageKind } from '../services/billing'

export const ttsRouter = express.Router()

/** Default upstream: the Kokoro-82M Space (public, no auth required). */
const KOKORO_SPACE = process.env.HF_TTS_SPACE_URL || 'https://hysts-mcp-Kokoro-TTS.hf.space'
/** Kokoro voice ids the Space accepts; anything else falls back to af_heart. */
const KOKORO_VOICES = /^(af|am|bf|bm)_[a-z]+$/

/** Map the client's voice preference to a Kokoro voice id. */
function kokoroVoice(voice: string): string {
  const v = voice.trim().toLowerCase()
  return KOKORO_VOICES.test(v) ? v : 'af_heart'
}

/** Call the Kokoro Space's /generate endpoint and return WAV bytes. */
async function kokoroFromSpace(text: string, voice: string, speed: number, op: ReturnType<typeof mediaOperation>): Promise<Buffer> {
  const root = mediaUrl(KOKORO_SPACE).replace(/\/+$/, '')
  const auth = mediaAuth(root)
  const submit = await providerRequest(`${root}/gradio_api/call/generate`, {
    ...auth, method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [text, kokoroVoice(voice), speed] }),
    signal: op.signal, timeoutMs: op.remaining(30_000), maxBytes: 64 * 1024,
  })
  const { event_id: eventId } = await submit.json()
  if (!eventId) throw new Error('The TTS space returned no event id.')
  op.check()
  // One streaming GET: heartbeat frames repeat while the audio generates,
  // then `event: complete` carries the result payload (an audio file URL).
  const stream = await providerRequest(`${root}/gradio_api/call/generate/${eventId}`, {
    ...auth, signal: op.signal, timeoutMs: op.remaining(90_000), maxBytes: 4 * 1024 * 1024,
  })
  const raw = await stream.text()
  let currentEvent = ''
  let resultJson: string | null = null
  let errorJson: string | null = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) currentEvent = line.slice(6).trim()
    else if (line.startsWith('data:')) {
      const data = line.slice(5).trim()
      if (!data || data === 'null') continue
      if (currentEvent === 'complete') resultJson = data
      else if (currentEvent === 'error') errorJson = data
    }
  }
  if (resultJson === null) throw new Error(errorJson ? `TTS space error: ${String(errorJson).slice(0, 160)}` : 'The TTS stream ended without audio.')
  op.check()
  const payload = JSON.parse(resultJson)
  const out = Array.isArray(payload) ? payload : payload?.data
  const audioItem = Array.isArray(out) ? out.find((item: any) => typeof item?.url === 'string' || typeof item?.path === 'string') : null
  const audioUrl = audioItem?.url || audioItem?.path
  if (typeof audioUrl !== 'string' || !audioUrl) throw new Error('The TTS space returned no audio file.')
  const absolute = new URL(audioUrl, root).href
  const audioRes = await providerRequest(absolute, {
    ...auth, signal: op.signal, timeoutMs: op.remaining(60_000), maxBytes: IMAGE_RESPONSE_BYTES,
  })
  const buffer = Buffer.from(await audioRes.arrayBuffer())
  if (!buffer.length) throw new Error('The TTS audio download was empty.')
  return buffer
}

ttsRouter.post('/', authenticateToken, asyncHandler(async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 4000)
  const voice = String(req.body?.voice || 'default').slice(0, 40)
  const speed = Math.min(2, Math.max(0.5, Number(req.body?.speed) || 1))
  if (!text) return res.status(400).json({ error: 'text is required.' })

  const op = mediaOperation(120_000)
  try {
    op.check()
    let buffer: Buffer | null = null
    let contentType = 'audio/wav'

    if (process.env.HF_TTS_ENDPOINT_URL) {
      // Dedicated endpoint (the historical path): { inputs } → audio bytes.
      const endpoint = process.env.HF_TTS_ENDPOINT_URL
      const payload = { inputs: text, parameters: { voice } }
      const { headers, ...auth } = mediaAuth(endpoint)
      const upstream = await providerRequest(endpoint, {
        ...auth, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: op.signal, timeoutMs: op.remaining(90_000), maxBytes: IMAGE_RESPONSE_BYTES,
      })
      op.check()
      const ct = upstream.headers.get('content-type') || ''
      if (ct.startsWith('audio/') || ct.includes('wav') || ct.includes('mpeg')) {
        contentType = ct.includes('mpeg') ? 'audio/mpeg' : ct.includes('wav') ? 'audio/wav' : ct
        buffer = Buffer.from(await upstream.arrayBuffer())
      } else {
        const data: any = await upstream.json().catch(() => null)
        const audioUrl = data?.audio_url || data?.url || data?.content_url || ''
        if (audioUrl) {
          const audioRes = await providerRequest(audioUrl, { ...auth, signal: op.signal, timeoutMs: op.remaining(60_000), maxBytes: IMAGE_RESPONSE_BYTES })
          contentType = 'audio/wav'
          buffer = Buffer.from(await audioRes.arrayBuffer())
        }
      }
    } else {
      // Default upstream: the Kokoro Space.
      buffer = await kokoroFromSpace(text, voice, speed, op)
    }

    if (!buffer?.length) return res.status(502).json({ error: 'The TTS provider returned no audio.' })
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Cache-Control', 'no-store')
    await recordUsage((req as any).userId, 'chat' as UsageKind, { tokensIn: Math.ceil(text.length / 4), tokensOut: 0 })
    return res.send(buffer)
  } catch (error) {
    const message = mediaFailure(op, 'Text-to-speech') || 'TTS failed.'
    return res.status(502).json({ error: message })
  } finally {
    op.dispose()
  }
}))
