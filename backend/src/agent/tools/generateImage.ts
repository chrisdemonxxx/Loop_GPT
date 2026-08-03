/**
 * generate_image tool: text-to-image generation.
 *
 * Primary path uses Hugging Face Inference Providers text-to-image with the
 * HF token (model from HF_IMAGE_MODEL, default FLUX.1-dev). If an external
 * IMAGE_API_URL service is configured, it is used as a fallback.
 */
import { saveArtifact } from '../artifacts'
import { imageApiService } from '../../services/imageApi'
import { fetchBuffer, postJson } from '../httpClient'
import { checkCredits } from '../../services/billing'
import type { ToolDefinition } from '../types'

/**
 * Generate an image via Hugging Face Inference Providers.
 *
 * The legacy `hf-inference` text-to-image route is deprecated, so we use the
 * provider-routed OpenAI-compatible images endpoint
 * (`router.huggingface.co/<provider>/v1/images/generations`) and try live
 * providers in order until one returns an image. Responses come back either as
 * base64 (`data[].b64_json`) or a URL (`data[].url`), both of which we handle.
 */
/**
 * Generate via a dedicated Hugging Face Inference Endpoint running a diffusers
 * text-to-image model (e.g. an uncensored FLUX finetune). The endpoint accepts
 * the standard HF text-to-image body { inputs } and returns raw image bytes.
 */
async function hfImageEndpoint(prompt: string): Promise<Buffer> {
  const raw = (process.env.HF_IMAGE_ENDPOINT_URL || '').replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 180000) // cold-start tolerant
  try {
    const res = await fetch(raw, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HF_TOKEN || ''}`,
        'Content-Type': 'application/json',
        Accept: 'image/png',
      },
      body: JSON.stringify({ inputs: prompt, parameters: {} }),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const ct = res.headers.get('content-type') || ''
    // Custom handlers may return raw image bytes OR JSON (base64 / url). Handle both.
    if (ct.includes('application/json')) {
      const j: any = await res.json()
      const b64 = j?.image || j?.[0]?.image || j?.images?.[0]?.b64_json || j?.data?.[0]?.b64_json || (typeof j === 'string' ? j : null)
      if (b64) return Buffer.from(b64, 'base64')
      const url = j?.url || j?.[0]?.url || j?.images?.[0]?.url || j?.data?.[0]?.url
      if (url) return fetchBuffer(url, { timeoutMs: 60000 })
      throw new Error('endpoint returned JSON without an image')
    }
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

function inferenceParams(model: string, width = 1024, height = 1024) {
  const isSchnell = model.toLowerCase().includes('schnell')
  return {
    num_inference_steps: isSchnell ? 4 : 28,
    guidance_scale: isSchnell ? 0 : 3.5,
    width,
    height,
  }
}

async function hfTextToImage(prompt: string, model: string, width = 1024, height = 1024): Promise<Buffer> {
  const configured = process.env.HF_IMAGE_PROVIDER
  // fal-ai and together have strong FLUX.1-dev support; nscale as fallback
  const providers = configured ? [configured] : ['fal-ai', 'together', 'nscale']
  const auth = { Authorization: `Bearer ${process.env.HF_TOKEN || ''}` }
  const params = inferenceParams(model, width, height)
  let lastErr = ''

  for (const provider of providers) {
    try {
      const data = await postJson<any>(
        `https://router.huggingface.co/${provider}/v1/images/generations`,
        { model, prompt, response_format: 'b64_json', ...params },
        { headers: auth, timeoutMs: 120000 }
      )
      const item = data?.data?.[0] || data?.images?.[0]
      if (item?.b64_json) return Buffer.from(item.b64_json, 'base64')
      if (item?.url) return fetchBuffer(item.url, { timeoutMs: 60000 })
      lastErr = `provider ${provider} returned no image`
    } catch (e: any) {
      lastErr = `${provider}: ${e?.message || e}`
    }
  }
  throw new Error(lastErr || 'no image provider succeeded')
}

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  source: 'builtin',
  description: 'Generate a high-quality image from a text prompt using FLUX.1-dev. Returns an image artifact the user can view and download.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'A detailed, vivid description of the image to generate. More detail = better results.' },
      aspect_ratio: {
        type: 'string',
        enum: ['square', 'landscape', 'portrait', 'wide'],
        description: 'Image aspect ratio. square=1024x1024, landscape=1344x768, portrait=768x1344, wide=1536x640. Defaults to square.',
      },
    },
    required: ['prompt'],
  },
  async handler(args, ctx) {
    const prompt = String(args.prompt || '').trim()
    if (!prompt) return { content: 'Error: prompt is required.', isError: true }

    // Hard image-credit gate: refuse before spending compute if the user is out.
    if (ctx.userId) {
      try {
        const credit = await checkCredits(ctx.userId, 'image')
        if (!credit.ok) {
          return { content: credit.reason || 'Out of image credits for today.', isError: true }
        }
      } catch {
        /* metering unavailable — allow */
      }
    }

    const model = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-dev'
    const ratio = String(args.aspect_ratio || 'square')
    const SIZES: Record<string, [number, number]> = {
      square: [1024, 1024],
      landscape: [1344, 768],
      portrait: [768, 1344],
      wide: [1536, 640],
    }
    const [imgW, imgH] = SIZES[ratio] || SIZES.square

    let buffer: Buffer | null = null
    let usedModel = model
    // 1) Dedicated HF Inference Endpoint (e.g. an uncensored FLUX finetune).
    if (process.env.HF_IMAGE_ENDPOINT_URL) {
      try {
        buffer = await hfImageEndpoint(prompt)
        usedModel = process.env.HF_IMAGE_ENDPOINT_MODEL || 'custom endpoint'
      } catch (error: any) {
        ctx.emit({ type: 'status', message: `Image endpoint failed (${error?.message || error}); trying providers…` })
      }
    }
    // 2) Serverless HF Inference Providers (FLUX.1-dev via router).
    try {
      if (!buffer && process.env.HF_TOKEN) {
        buffer = await hfTextToImage(prompt, model, imgW, imgH)
      }
    } catch (error: any) {
      ctx.emit({ type: 'status', message: `HF image gen failed (${error?.message || error}); trying fallback…` })
    }

    // Fallback to the external image service if configured.
    if (!buffer && process.env.IMAGE_API_URL) {
      try {
        const result = await imageApiService.generateImage({ prompt, model: 'flux-dev', return_base64: true })
        if (result.image_base64) {
          buffer = Buffer.from(result.image_base64, 'base64')
          usedModel = result.model
        }
      } catch (error: any) {
        return { content: `Image generation failed: ${error?.message || error}`, isError: true }
      }
    }

    if (!buffer) {
      return { content: 'Image generation is not configured (set HF_TOKEN or IMAGE_API_URL).', isError: true }
    }

    const artifact = saveArtifact(`${prompt.slice(0, 30).replace(/\s+/g, '-')}.png`, buffer)
    ctx.scratch.artifacts = ctx.scratch.artifacts || []
    ctx.scratch.artifacts.push(artifact)
    ctx.emit({ type: 'artifact', artifact })
    return {
      content: `Generated an image for "${prompt}" using ${usedModel}. It is shown to the user.`,
      data: { artifact },
    }
  },
}
