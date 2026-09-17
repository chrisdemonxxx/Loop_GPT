import { sidecarRequest } from './providerHttp'
import { IMAGE_RESPONSE_BYTES, mediaOperation, type MediaOperation } from '../agent/httpClient'

interface GenerateImageRequest {
  prompt: string
  model?: 'flux-schnell' | 'flux-dev' | 'sd35'
  return_base64?: boolean
  image_prompt?: string
  strength?: number
}

interface GenerateImageResponse {
  image_path?: string
  image_base64?: string
  success: boolean
  model: string
  generation_time?: number
}

interface AnalyzeImageRequest { image_path: string; model?: 'blip' | 'llava' }
interface AnalyzeImageResponse { description: string; success: boolean; model: string }
interface VisionChatRequest { image_path: string; question: string; model?: 'llava' }
interface VisionChatResponse { answer: string; success: boolean; model: string }

class ImageApiService {
  private async request(path: '/api/generate' | '/api/analyze' | '/api/vision-chat', body: object, op: MediaOperation) {
    await this.ensureApiAvailable(op.signal, op.remaining(5000))
    const response = await sidecarRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: op.signal, timeoutMs: op.remaining(), maxBytes: IMAGE_RESPONSE_BYTES })
    op.check()
    return response.json()
  }

  async generateImage(request: GenerateImageRequest, signal?: AbortSignal): Promise<GenerateImageResponse> {
    const op = mediaOperation(120000, signal)
    try {
      if (!request.prompt?.trim()) throw new Error('Invalid prompt')
      const data = await this.request('/api/generate', {
        prompt: request.prompt, model: request.model || 'flux-schnell', return_base64: request.return_base64 !== false,
        image_prompt: request.image_prompt, strength: request.strength,
      }, op)
      if (data?.success === false || (!data?.image_path && !data?.image_base64)) throw new Error('Missing image')
      return { success: true, image_path: data.image_path, image_base64: data.image_base64,
        model: data.model || request.model || 'flux-schnell', generation_time: data.generation_time }
    } catch { op.check(); throw new Error('Image generation failed') }
    finally { op.dispose() }
  }

  async analyzeImage(request: AnalyzeImageRequest, signal?: AbortSignal): Promise<AnalyzeImageResponse> {
    const op = mediaOperation(30000, signal)
    try {
      if (!request.image_path) throw new Error('Missing image')
      const data = await this.request('/api/analyze', { image_path: request.image_path, model: request.model || 'blip' }, op)
      if (data?.success === false || typeof data?.description !== 'string') throw new Error('Missing description')
      return { success: true, description: data.description, model: data.model || request.model || 'blip' }
    } catch { op.check(); throw new Error('Image analysis failed') }
    finally { op.dispose() }
  }

  async visionChat(request: VisionChatRequest, signal?: AbortSignal): Promise<VisionChatResponse> {
    const op = mediaOperation(60000, signal)
    try {
      if (!request.image_path || !request.question?.trim()) throw new Error('Invalid request')
      const data = await this.request('/api/vision-chat', {
        image_path: request.image_path, question: request.question, model: request.model || 'llava',
      }, op)
      if (data?.success === false || typeof data?.answer !== 'string') throw new Error('Missing answer')
      return { success: true, answer: data.answer, model: data.model || request.model || 'llava' }
    } catch { op.check(); throw new Error('Vision chat failed') }
    finally { op.dispose() }
  }

  async healthCheck(signal?: AbortSignal, timeoutMs = 5000): Promise<{ healthy: boolean; error?: string }> {
    const op = mediaOperation(Math.min(5000, timeoutMs), signal)
    try {
      const response = await sidecarRequest('/health', { signal: op.signal, timeoutMs: op.remaining(), maxBytes: 65536 })
      op.check()
      return { healthy: response.status === 200 }
    } catch {
      if (signal?.aborted) throw new Error('Media operation cancelled')
      return { healthy: false, error: 'Image API is not reachable' }
    }
    finally { op.dispose() }
  }

  private async ensureApiAvailable(signal?: AbortSignal, timeoutMs = 5000): Promise<void> {
    if (!(await this.healthCheck(signal, timeoutMs)).healthy) throw new Error('Image API is not available')
  }
}

export const imageApiService = new ImageApiService()
