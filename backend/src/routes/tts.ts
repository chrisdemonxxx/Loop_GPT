/**
 * Backend TTS (brief P2 — backend-quality read-aloud foundation):
 * POST /api/tts { text, voice? } → audio bytes (Kokoro-82M or
 * HF_TTS_ENDPOINT_URL). Gives browsers without speechSynthesis (Firefox) a
 * high-quality fallback for per-message read-aloud, and is the streaming
 * primitive a full voice mode would build on.
 */
import express from 'express'
import { asyncHandler } from '../middleware/errorLogger'
import { authenticateToken } from './auth'
import { providerRequest } from '../services/providerHttp'
import { mediaAuth, IMAGE_RESPONSE_BYTES, mediaOperation, mediaFailure } from '../agent/httpClient'
import { recordUsage, type UsageKind } from '../services/billing'

export const ttsRouter = express.Router()

ttsRouter.post('/', authenticateToken, asyncHandler(async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 4000)
  const voice = String(req.body?.voice || 'default').slice(0, 40)
  if (!text) return res.status(400).json({ error: 'text is required.' })

  const op = mediaOperation(120_000)
  try {
    op.check()
    const endpoint = process.env.HF_TTS_ENDPOINT_URL || 'https://router.huggingface.co/hf-inference/models/hexgrad/Kokoro-82M'
    const payload = process.env.HF_TTS_ENDPOINT_URL
      ? { inputs: text, parameters: { voice } }
      : { inputs: text }
    const { headers, ...auth } = mediaAuth(endpoint)
    const upstream = await providerRequest(endpoint, {
      ...auth, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: op.signal, timeoutMs: op.remaining(90_000), maxBytes: IMAGE_RESPONSE_BYTES,
    })
    op.check()
    const contentType = upstream.headers.get('content-type') || ''
    if (contentType.includes('audio') || contentType.includes('wav') || contentType.includes('mpeg')) {
      // Stream the audio bytes straight through.
      const buffer = Buffer.from(await upstream.arrayBuffer())
      res.setHeader('Content-Type', contentType.includes('wav') ? 'audio/wav' : contentType.includes('mpeg') ? 'audio/mpeg' : contentType)
      res.setHeader('Content-Length', String(buffer.length))
      res.setHeader('Cache-Control', 'no-store')
      await recordUsage((req as any).userId, 'chat' as UsageKind, { tokensIn: Math.ceil(text.length / 4), tokensOut: 0 })
      return res.send(buffer)
    }
    // Some endpoints return a JSON URL instead of bytes.
    const data: any = await upstream.json().catch(() => null)
    const audioUrl = data?.audio_url || data?.url || data?.content_url || ''
    if (audioUrl) return res.json({ url: audioUrl })
    return res.status(502).json({ error: 'The TTS provider returned no audio.' })
  } catch (error) {
    const message = mediaFailure(op, 'Text-to-speech') || 'TTS failed.'
    return res.status(502).json({ error: message })
  } finally {
    op.dispose()
  }
}))
