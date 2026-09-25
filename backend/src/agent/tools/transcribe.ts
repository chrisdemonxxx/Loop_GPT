import type { ToolDefinition } from '../types'
import { providerRequest } from '../../services/providerHttp'
import { mediaAuth, IMAGE_RESPONSE_BYTES, type MediaOperation, mediaOperation, mediaFailure } from '../httpClient'

/** Transcribe audio using whisper-large-v3-turbo or a dedicated endpoint. */
export const transcribeTool: ToolDefinition = {
  name: 'transcribe_audio',
  source: 'builtin',
  description: 'Transcribe audio (file upload, URL, or base64) to text using the fastest available ASR model.',
  parameters: {
    type: 'object',
    properties: {
      audio: { type: 'string', description: 'Base64-encoded audio or a URL to an audio file.' },
      language: { type: 'string', description: 'Optional language code (e.g. "en"). Auto-detected if omitted.', default: '' },
    },
    required: ['audio'],
  },
  async handler(args, ctx) {
    const op = mediaOperation(120_000, ctx.signal)
    try {
      op.check()
      const audio = String(args.audio || '')
      if (!audio) return { content: 'Error: audio data is required.', isError: true }
      const lang = String(args.language || '')
      ctx.emit({ type: 'status', message: 'Transcribing audio…' })
      const endpoint = process.env.HF_ASR_ENDPOINT_URL || 'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3-turbo'
      const isEndpoint = !!process.env.HF_ASR_ENDPOINT_URL
      const body = isEndpoint
        ? JSON.stringify({ inputs: audio })
        : audio.startsWith('http')
          ? JSON.stringify({ inputs: (await (await fetch(audio, { signal: AbortSignal.timeout(15_000) })).arrayBuffer()) })
          : JSON.stringify({ inputs: audio })
      const { headers, ...auth } = mediaAuth(endpoint)
      const res = await providerRequest(endpoint, {
        ...auth, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: isEndpoint ? JSON.stringify({ inputs: audio }) : JSON.stringify({ inputs: audio }),
        signal: op.signal, timeoutMs: op.remaining(60_000), maxBytes: IMAGE_RESPONSE_BYTES,
      })
      op.check()
      const data = await res.json()
      const text = typeof data === 'string' ? data : data?.text || ''
      if (!text) return { content: 'Transcription returned empty text.', isError: true }
      return { content: `Transcription: "${text}"` }
    } catch (error) { return { content: mediaFailure(op, 'Transcription'), isError: true } }
    finally { op.dispose() }
  },
}
