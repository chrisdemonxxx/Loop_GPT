import type { ToolDefinition } from '../types'
import { providerRequest } from '../../services/providerHttp'
import { mediaAuth, IMAGE_RESPONSE_BYTES, type MediaOperation, mediaOperation, mediaFailure } from '../httpClient'

/** Optical character recognition: extract text from images/documents. */
export const ocrTool: ToolDefinition = {
  name: 'ocr_image',
  source: 'builtin',
  description: 'Extract text from an image or PDF document using the best available OCR model.',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'Base64-encoded image/PDF or a URL.' },
    },
    required: ['image'],
  },
  async handler(args, ctx) {
    const op = mediaOperation(120_000, ctx.signal)
    try {
      op.check()
      const image = String(args.image || '')
      if (!image) return { content: 'Error: image data is required.', isError: true }
      ctx.emit({ type: 'status', message: 'Performing OCR…' })
      const endpoint = process.env.HF_OCR_ENDPOINT_URL || 'https://router.huggingface.co/hf-inference/models/stepfun-ai/GOT-OCR2_0'
      const { headers, ...auth } = mediaAuth(endpoint)
      const res = await providerRequest(endpoint, {
        ...auth, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: image }),
        signal: op.signal, timeoutMs: op.remaining(60_000), maxBytes: IMAGE_RESPONSE_BYTES,
      })
      op.check()
      const data = await res.json()
      const text = typeof data === 'string' ? data : data?.text || data?.generated_text || data?.content || ''
      if (!text) return { content: 'OCR returned no text.', isError: true }
      return { content: `Extracted text:\n\n${text.slice(0, 4000)}` }
    } catch (error) { return { content: mediaFailure(op, 'OCR'), isError: true } }
    finally { op.dispose() }
  },
}
