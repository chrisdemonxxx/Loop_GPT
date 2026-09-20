import type { ToolDefinition } from '../types'
import { providerRequest } from '../../services/providerHttp'
import { mediaAuth, IMAGE_RESPONSE_BYTES, type MediaOperation, mediaOperation, mediaFailure } from '../httpClient'

/** Generate speech from text using Kokoro-82M or a dedicated endpoint. */
export const speakTool: ToolDefinition = {
  name: 'speak_text',
  source: 'builtin',
  description: 'Convert text to speech audio. Returns a URL to the generated audio file.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to convert to speech.' },
      voice: { type: 'string', description: 'Voice style (e.g. "default", "whisper", "fast").', default: 'default' },
    },
    required: ['text'],
  },
  async handler(args, ctx) {
    const op = mediaOperation(120_000, ctx.signal)
    try {
      op.check()
      const text = String(args.text || '').trim()
      if (!text) return { content: 'Error: text is required.', isError: true }
      ctx.emit({ type: 'status', message: 'Generating speech…' })
      const endpoint = process.env.HF_TTS_ENDPOINT_URL || 'https://router.huggingface.co/hf-inference/models/hexgrad/Kokoro-82M'
      const payload = process.env.HF_TTS_ENDPOINT_URL
        ? { inputs: text, parameters: { voice: String(args.voice || 'default') } }
        : { inputs: text }
      const { headers, ...auth } = mediaAuth(endpoint)
      const res = await providerRequest(endpoint, {
        ...auth, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: op.signal, timeoutMs: op.remaining(60_000), maxBytes: IMAGE_RESPONSE_BYTES,
      })
      op.check()
      const contentType = res.headers.get('content-type') || ''
      if (contentType.includes('audio') || contentType.includes('wav') || contentType.includes('mp3')) {
        return { content: 'Audio generated. Use the download button to hear it.', data: { audio_url: '' } }
      }
      const data = await res.json()
      const audioUrl = data?.audio_url || data?.url || data?.content_url || ''
      if (audioUrl) return { content: 'Audio generated. Use the download button to hear it.', data: { audio_url: audioUrl } }
      return { content: 'Speech generated successfully.', data: { raw: data } }
    } catch (error) { return { content: mediaFailure(op, 'Speech'), isError: true } }
    finally { op.dispose() }
  },
}
