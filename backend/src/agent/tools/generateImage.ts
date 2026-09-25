import { saveArtifact } from '../artifacts'
import { imageApiService } from '../../services/imageApi'
import { providerRequest } from '../../services/providerHttp'
import { checkedMedia, decodeMedia, IMAGE_RESPONSE_BYTES, mediaAuth, mediaFailure, mediaOperation, mediaUrl, type MediaOperation } from '../httpClient'
import { gradioCallSpace } from './gradio'
import { recordUsage } from '../../services/billing'
import { reserveDailyCredits, dailyDispatch, cleanupDailyReservation, DailyCreditError } from '../../services/dailyReservations'
import { optimizePromptDetailed } from '../../services/promptOptimizer'
import type { ToolDefinition } from '../types'

async function imageResponse(response: Awaited<ReturnType<typeof providerRequest>>, op: MediaOperation): Promise<Buffer> {
  op.check()
  if (!(response.headers.get('content-type') || '').includes('json')) return checkedMedia(response.body)
  const data = await response.json()
  const item = data?.data?.[0] || data?.images?.[0] || data?.[0] || data
  const encoded = item?.b64_json || item?.image_base64 || item?.image
  if (typeof encoded === 'string') return decodeMedia(encoded)
  const url = item?.url || item?.image_url
  if (typeof url === 'string') {
    // Returned image downloads are always anonymous, including same-origin URLs.
    const result = await providerRequest(mediaUrl(url), {
      signal: op.signal, timeoutMs: op.remaining(60000), maxBytes: IMAGE_RESPONSE_BYTES,
    })
    op.check()
    return checkedMedia(result.body)
  }
  throw new Error('Missing image data')
}

async function hfImageEndpoint(prompt: string, op: MediaOperation, beforeDispatch: () => Promise<void>, imageBase64?: string, strength = 0.6, faceLock = true, sceneLock = false): Promise<Buffer> {
  const endpoint = mediaUrl(process.env.HF_IMAGE_ENDPOINT_URL || '')

  // Gradio Space detection — the endpoint URL ends with .hf.space
  if (endpoint.includes('.hf.space')) {
    await beforeDispatch()
    // Modern Gradio API first (named endpoints); legacy /run/predict as fallback.
    // A reference image routes to the ref2lock EDIT endpoint (image in, image
    // out) so the subject's identity is preserved; without one it is plain
    // text-to-image.
    try {
      const media = await gradioCallSpace(endpoint, prompt, {
        imageBase64, signal: op.signal, timeoutMs: op.remaining(600000),
        mode: imageBase64 ? 'edit' : 'image', strength: imageBase64 ? strength : undefined,
        faceSwap: imageBase64 ? faceLock : undefined,
        sceneLock: imageBase64 ? sceneLock : undefined,
      })
      if (media.image) return media.image
      if (media.video) return media.video
    } catch (err: any) {
      console.error('[image:gradio] failed:', err?.message || err)
      op.check()
    }
    const gradioUrl = endpoint.replace(/\/+$/, '') + '/run/predict'
    const payload = { data: [prompt, imageBase64 || null], event_data: null }
    const auth = mediaAuth(endpoint)
    const res = await providerRequest(gradioUrl, { ...auth, method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: op.signal, timeoutMs: op.remaining(180000), maxBytes: IMAGE_RESPONSE_BYTES,
    })
    op.check()
    const data = await res.json()
    const output = data?.data?.[0]
    if (typeof output === 'string') {
      if (output.startsWith('http')) {
        const imgRes = await providerRequest(mediaUrl(output), { signal: op.signal, timeoutMs: op.remaining(60000), maxBytes: IMAGE_RESPONSE_BYTES })
        return checkedMedia(imgRes.body)
      }
      return decodeMedia(output)
    }
    if (Buffer.isBuffer(output)) return checkedMedia(output)
    throw new Error('Missing image data from Gradio Space')
  }

  const payload: any = { inputs: prompt, parameters: { num_inference_steps: 28, guidance_scale: 3.5 } }
  if (imageBase64) { payload.image = imageBase64; payload.parameters.strength = strength }
  const auth = mediaAuth(endpoint)
  await beforeDispatch()
  return imageResponse(await providerRequest(endpoint, { ...auth, method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json', Accept: 'image/png' },
    body: JSON.stringify(payload), signal: op.signal, timeoutMs: op.remaining(180000), maxBytes: IMAGE_RESPONSE_BYTES,
  }), op)
}

async function hfTextToImage(prompt: string, model: string, width: number, height: number,
  op: MediaOperation, beforeDispatch: () => Promise<void>, imageBase64?: string, strength = 0.6): Promise<Buffer> {
  const allowed = ['fal-ai', 'together', 'nscale']
  const configured = process.env.HF_IMAGE_PROVIDER
  if (configured && !allowed.includes(configured)) throw new Error('Invalid image provider')
  const providers = configured ? [configured] : allowed
  for (const provider of providers) {
    op.check()
    try {
      const endpoint = `https://router.huggingface.co/${provider}/v1/images/generations`
      const auth = mediaAuth(endpoint)
      const schnell = model.toLowerCase().includes('schnell')
      const payload = { model, prompt, response_format: 'b64_json', width, height,
        num_inference_steps: schnell ? 4 : 28, guidance_scale: schnell ? 0 : 3.5,
        ...(imageBase64 ? { image: imageBase64, strength } : {}),
      }
      await beforeDispatch()
      return await imageResponse(await providerRequest(endpoint, { ...auth, method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: op.signal, timeoutMs: op.remaining(120000), maxBytes: IMAGE_RESPONSE_BYTES,
      }), op)
    } catch { op.check() }
  }
  throw new Error('Image providers failed')
}

export const generateImageTool: ToolDefinition = {
  name: 'generate_image',
  source: 'builtin',
  needsApproval: false, // Media generation is a core feature; metering bounds cost.
  description: 'Generate images from text prompts. When the user attached an image (or passes image_prompt), the reference anchors the subject identity: the prompt is generated, then the reference face is transplanted (SCRFD+ArcFace+inswapper) so the SAME person appears in the new scene/outfit (sharp + near-exact). scene_lock=true keeps the reference composition instead.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate.' },
      image_prompt: { type: 'string', description: 'Optional base64 reference image for ref2lock img2img (identity anchor).' },
      face_lock: { type: 'boolean', description: 'ref2lock: transplant the EXACT reference face onto the generated image (default true). Set false to skip the transplant.', default: true },
      scene_lock: { type: 'boolean', description: 'ref2lock: keep the REFERENCE composition (img2img) instead of generating the scene from the prompt (sharper). Default false.', default: false },
      aspect_ratio: { type: 'string', enum: ['square', 'landscape', 'portrait', 'wide'] },
      strength: { type: 'number', description: 'Identity-lock strength for a reference image (0-1): 0.45-0.7 keeps the subject recognisable, higher departs further.', default: 0.6 },
    },
    required: ['prompt'],
  },
  async handler(args, ctx) {
    const op = mediaOperation(Number(process.env.HF_IMAGE_MAX_WAIT_MS) || 900000, ctx.signal)
    let reservation: Awaited<ReturnType<typeof reserveDailyCredits>> | undefined
    try {
      op.check()
      const rawPrompt = String(args.prompt || '').trim()
      // img2img: an explicit base64 reference wins; otherwise an attached image
      // on this message is the reference (wired from the conversation).
      let imagePrompt = args.image_prompt ? String(args.image_prompt) : undefined
      if (!imagePrompt) {
        const attached = ctx.scratch?.referenceImages as string[] | undefined
        if (attached?.length) imagePrompt = attached[0]
      }
      // Per-modality prompt optimization (GAP-006), invisible by default.
      const promptMeta = await optimizePromptDetailed(rawPrompt, 'image').catch(() => ({ raw: rawPrompt, enhanced: rawPrompt, optimized: false }))
      const prompt = promptMeta.enhanced
      const parsedStrength = args.strength == null ? 0.6 : Number(args.strength)
      // ref2lock exact-face transplant (on by default when a reference exists).
      const faceLock = args.face_lock !== false
      // Sharp default: text-to-image the prompt, then transplant the face.
      // scene_lock=true keeps the reference composition (img2img) instead.
      const sceneLock = args.scene_lock === true
      const strength = Number.isFinite(parsedStrength) ? Math.max(0, Math.min(1, parsedStrength)) : 0.75
      if (!prompt) return { content: 'Error: prompt is required.', isError: true }
      const model = process.env.HF_IMAGE_MODEL || 'black-forest-labs/FLUX.1-dev'
      reservation = await reserveDailyCredits(ctx.userId, 'image', model)
      op.check()
      const dispatch = dailyDispatch(reservation.id, op.signal)
      const beforeDispatch = async () => { op.check(); await dispatch() }
      const sizes: Record<string, [number, number]> = {
        square: [1024, 1024], landscape: [1344, 768], portrait: [768, 1344], wide: [1536, 640],
      }
      const [width, height] = sizes[String(args.aspect_ratio || 'square')] || sizes.square
      const mode = imagePrompt ? 'img2img' : 'text2img'
      ctx.emit({ type: 'status', message: `Generating image (${mode} mode)...` })
      let buffer: Buffer | undefined
      if (process.env.HF_IMAGE_ENDPOINT_URL) {
        try { buffer = await hfImageEndpoint(prompt, op, beforeDispatch, imagePrompt, strength, faceLock, sceneLock) }
        catch (err: any) { console.error('[image:gradio] failed:', err?.message || err); op.check(); ctx.emit({ type: 'status', message: 'Endpoint failed, trying providers...' }) }
      }
      if (!buffer && process.env.HF_TOKEN) {
        try { buffer = await hfTextToImage(prompt, model, width, height, op, beforeDispatch, imagePrompt, strength) }
        catch { op.check(); ctx.emit({ type: 'status', message: 'HF providers failed, trying fallback...' }) }
      }
      if (!buffer && process.env.IMAGE_API_URL) {
        op.check()
        await beforeDispatch()
        const result = await imageApiService.generateImage({ prompt, image_prompt: imagePrompt, strength,
          model: 'flux-dev', return_base64: true }, op.signal)
        if (result.image_base64) buffer = decodeMedia(result.image_base64)
      }
      op.check()
      if (!buffer) return { content: 'Image generation unavailable.', isError: true }
      await recordUsage(ctx.userId, 'image', { reservationId: reservation.id, images: 1, model })
      const artifact = await saveArtifact(`${prompt.slice(0, 30).replace(/\s+/g, '-')}.png`, checkedMedia(buffer),
        { userId: ctx.userId, conversationId: ctx.conversationId })
      op.check()
      ctx.scratch.artifacts = ctx.scratch.artifacts || []
      ctx.scratch.artifacts.push(artifact)
      ctx.emit({ type: 'artifact', artifact })
      return { content: `Generated image (${mode} mode) for "${prompt.slice(0, 80)}...".`, data: { artifact, mode, prompt: promptMeta } }
    } catch (error) { return { content: error instanceof DailyCreditError ? error.message : mediaFailure(op, 'Image'), isError: true } }
    finally { await cleanupDailyReservation(reservation?.id); op.dispose() }
  },
}
