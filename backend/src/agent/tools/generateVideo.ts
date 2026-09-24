import { saveArtifact } from '../artifacts'
import { providerRequest } from '../../services/providerHttp'
import { checkedMedia, decodeMedia, mediaAuth, mediaFailure, mediaOperation, mediaUrl, VIDEO_RESPONSE_BYTES, type MediaOperation } from '../httpClient'
import { recordUsage } from '../../services/billing'
import { reserveDailyCredits, dailyDispatch, cleanupDailyReservation, DailyCreditError } from '../../services/dailyReservations'
import { optimizePromptDetailed } from '../../services/promptOptimizer'
import { gradioCallSpace } from './gradio'
import type { ToolDefinition } from '../types'

/** Shared by synchronous tools and durable jobs. The configured origin is the
 * only credential recipient; CDN URLs (including signed queries) are anonymous.
 */
export async function downloadVideo(endpoint: string, value: string, op: MediaOperation, depth = 0): Promise<Buffer> {
  if (depth > 3) throw new Error('Too many video result links')
  const url = mediaUrl(value, endpoint)
  const auth = new URL(url).origin === new URL(mediaUrl(endpoint)).origin ? mediaAuth(endpoint) : {}
  const response = await providerRequest(url, { ...auth, headers: { ...auth.headers, Accept: 'video/mp4, application/json' },
    signal: op.signal, timeoutMs: op.remaining(120000), maxBytes: VIDEO_RESPONSE_BYTES })
  op.check()
  if (!(response.headers.get('content-type') || '').includes('json')) return checkedMedia(response.body)
  return decodeVideoResponse(await response.json(), endpoint, op, depth + 1)
}

export async function decodeVideoResponse(data: any, endpoint: string, op: MediaOperation, depth = 0): Promise<Buffer> {
  op.check()
  const encoded = [data?.video_base64, data?.video, data?.data?.[0]?.b64_json, data?.images?.[0]?.b64_json,
    data?.data, data?.output].find(value => typeof value === 'string' && value.length > 0)
  if (encoded) return decodeMedia(encoded)
  const url = data?.video_url || data?.url || data?.data?.[0]?.url || data?.images?.[0]?.url || data?.result_url
  if (typeof url === 'string') return downloadVideo(endpoint, url, op, depth)
  throw new Error('Missing video data')
}

async function pollVideoJob(endpoint: string, statusUrl: string, resultUrl: string | undefined, op: MediaOperation): Promise<Buffer> {
  // Validate both links before beginning, and status again before every request.
  mediaUrl(statusUrl, endpoint, true)
  if (resultUrl) mediaUrl(resultUrl, endpoint)
  while (true) {
    const response = await providerRequest(mediaUrl(statusUrl, endpoint, true), { ...mediaAuth(endpoint),
      signal: op.signal, timeoutMs: op.remaining(30000), maxBytes: VIDEO_RESPONSE_BYTES })
    op.check()
    const status = await response.json()
    const state = String(status?.status || '').toLowerCase()
    if (state === 'completed' || state === 'succeeded') {
      return decodeVideoResponse({ ...status, result_url: status?.result_url || resultUrl }, endpoint, op)
    }
    if (state === 'failed' || state === 'cancelled') throw new Error('Video generation failed')
    await op.sleep(3000)
  }
}

async function generateVideoFromEndpoint(prompt: string, images: string[], numFrames: number,
  fps: number, width: number, height: number, op: MediaOperation, beforeDispatch: () => Promise<void>): Promise<Buffer> {
  const endpoint = mediaUrl(process.env.VIDEO_API_URL || process.env.HF_VIDEO_ENDPOINT_URL || '')
  const auth = mediaAuth(endpoint)
  await beforeDispatch()

  // Gradio Space detection. The Space signature takes one reference frame; the
  // first reference (the identity anchor) is used.
  if (endpoint.includes('.hf.space')) {
    // Modern Gradio API first (named endpoints); legacy /run/predict as fallback.
    try {
      const media = await gradioCallSpace(endpoint, prompt, { imageBase64: images[0], signal: op.signal, timeoutMs: op.remaining(600000), mode: 'video' })
      if (media.video) return media.video
      if (media.image) return media.image
    } catch (err: any) {
      console.error('[video:gradio] failed:', err?.message || err, err?.code ? `code=${err.code}` : '')
      op.check()
    }
    const gradioUrl = endpoint.replace(/\/+$/, '') + '/run/predict'
    const payload = { data: [prompt, images[0] || null, numFrames, fps, width, height], event_data: null }
    const res = await providerRequest(gradioUrl, { ...auth, method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      signal: op.signal, timeoutMs: op.remaining(300000), maxBytes: VIDEO_RESPONSE_BYTES,
    })
    op.check()
    const data = await res.json()
    const output = data?.data?.[0]
    if (typeof output === 'string' && output.startsWith('http')) return downloadVideo(endpoint, output, op)
    if (typeof output === 'string') return decodeMedia(output)
    if (Buffer.isBuffer(output)) return checkedMedia(output)
    throw new Error('Missing video data from Gradio Space')
  }

  const response = await providerRequest(endpoint, { ...auth, method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json', Accept: 'video/mp4, application/json' },
    body: JSON.stringify({ inputs: prompt, parameters: { num_frames: numFrames, fps, width, height,
      ...(images.length ? { guidance_scale: 7.5 } : {}) },
      // ref2lock: the first reference anchors identity; extras are style refs.
      ...(images.length ? { image: images[0] } : {}),
      ...(images.length > 1 ? { reference_images: images } : {}) }),
    signal: op.signal, timeoutMs: op.remaining(), maxBytes: VIDEO_RESPONSE_BYTES })
  op.check()
  if (!(response.headers.get('content-type') || '').includes('json')) return checkedMedia(response.body)
  const data = await response.json()
  if (data?.job_id && data?.status_url) return pollVideoJob(endpoint, data.status_url, data.result_url, op)
  return decodeVideoResponse(data, endpoint, op)
}

export const generateVideoTool: ToolDefinition = {
  name: 'generate_video',
  source: 'builtin',
  needsApproval: false, // Media generation is a core feature; metering bounds cost.
  description: 'Generate a short video clip from a text prompt or image+prompt. When the user attached an image to this message, it is used automatically as the start frame (image-to-video). Videos are typically 4-8 seconds at 24fps.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Describe motion, style, lighting and atmosphere.' },
      image_prompt: { type: 'string', description: 'Optional base64 reference image for img2video (identity anchor).' },
      reference_images: { type: 'array', items: { type: 'string' }, description: 'Optional base64 reference frames for ref2lock. The first anchors subject identity; extra frames are style/composition references.' },
      duration_seconds: { type: 'number', description: 'Video duration (2-10 seconds).', default: 4 },
      fps: { type: 'number', description: 'Frames per second (12-30).', default: 24 },
      aspect_ratio: { type: 'string', enum: ['landscape', 'portrait', 'square', 'wide'], default: 'landscape' },
      lock_strength: { type: 'number', description: 'ref2lock: when a reference image is supplied and the person should appear in a NEW state (e.g. undressed), re-render the reference at this strength (0.45-0.7 keeps the face) before animating. Omit to animate the exact reference frame.' },
    },
    required: ['prompt'],
  },
  async handler(args, ctx) {
    const op = mediaOperation(Number(process.env.HF_VIDEO_MAX_WAIT_MS) || 900000, ctx.signal)
    let reservation: Awaited<ReturnType<typeof reserveDailyCredits>> | undefined
    try {
      op.check()
      const rawPrompt = String(args.prompt || '').trim()
      if (!rawPrompt) return { content: 'Error: prompt is required for video generation.', isError: true }
      // Per-modality prompt optimization (GAP-006), invisible by default.
      const promptMeta = await optimizePromptDetailed(rawPrompt, 'video').catch(() => ({ raw: rawPrompt, enhanced: rawPrompt, optimized: false }))
      const prompt = promptMeta.enhanced
      reservation = await reserveDailyCredits(ctx.userId, 'video', 'skyreels-v2')
      op.check()
      const dispatch = dailyDispatch(reservation.id, op.signal)
      const beforeDispatch = async () => { op.check(); await dispatch() }
      const duration = Math.max(2, Math.min(10, Number(args.duration_seconds) || 4))
      const fps = Math.max(12, Math.min(30, Number(args.fps) || 24))
      const numFrames = Math.min(Math.round(duration * fps), 120)
      const sizes: Record<string, [number, number]> = {
        landscape: [960, 544], portrait: [544, 960], square: [768, 768], wide: [1280, 720],
      }
      const [width, height] = sizes[String(args.aspect_ratio || 'landscape')] || sizes.landscape
      // ref2lock references: an explicit array, plus the single image_prompt.
      const refs: string[] = Array.isArray(args.reference_images)
        ? args.reference_images.map(String).filter(Boolean).slice(0, 4)
        : []
      if (args.image_prompt && !refs.includes(String(args.image_prompt))) refs.unshift(String(args.image_prompt))
      // Reference frames from the current conversation: images the user
      // attached with this message act as the start frame (ref2lock) when the
      // model didn't pass explicit base64 references.
      if (!refs.length) {
        const attached = ctx.scratch?.referenceImages as string[] | undefined
        if (attached?.length) refs.push(...attached.slice(0, 4))
      }
      // ref2lock edit-then-animate: when the user asks for the reference
      // person IN a new state (e.g. "make her NSFW"), first re-render the
      // reference at lock_strength with the prompt, then animate that frame —
      // the identity carries into the video instead of being re-invented.
      if (refs.length && args.lock_strength != null) {
        const lock = Math.max(0.2, Math.min(0.95, Number(args.lock_strength)))
        ctx.emit({ type: 'status', message: `Locking the reference identity (strength ${lock.toFixed(2)})…` })
        try {
          const editEndpoint = mediaUrl(process.env.HF_IMAGE_ENDPOINT_URL || process.env.HF_VIDEO_ENDPOINT_URL || '')
          const edited = await gradioCallSpace(editEndpoint, prompt, {
            imageBase64: refs[0], mode: 'edit', strength: lock,
            signal: op.signal, timeoutMs: op.remaining(300000),
          })
          if (edited.image) {
            refs[0] = `data:image/png;base64,${edited.image.toString('base64')}`
            ctx.emit({ type: 'status', message: 'Identity locked — animating the locked frame…' })
          }
        } catch (err: any) {
          console.error('[video:reflock] edit failed:', err?.message || err)
        }
      }
      ctx.emit({ type: 'status', message: `Generating ${duration}s video at ${fps}fps (${width}x${height})${refs.length ? ` from ${refs.length} reference frame(s)` : ''}...` })
      const buffer = await generateVideoFromEndpoint(prompt, refs,
        numFrames, fps, width, height, op, beforeDispatch)
      op.check()
      await recordUsage(ctx.userId, 'video', { reservationId: reservation.id, model: 'skyreels-v2' })
      const safePrompt = prompt.slice(0, 40).replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '')
      const artifact = await saveArtifact(`video-${safePrompt}.mp4`, checkedMedia(buffer),
        { userId: ctx.userId, conversationId: ctx.conversationId })
      op.check()
      ctx.scratch.artifacts = ctx.scratch.artifacts || []
      ctx.scratch.artifacts.push(artifact)
      ctx.emit({ type: 'artifact', artifact })
      return { content: `Generated a ${duration}-second video (${fps}fps, ${width}x${height}). Video is ready to view.`,
        data: { artifact, duration, fps, frames: numFrames, model: 'skyreels-v2', prompt: promptMeta, referenceFrames: refs.length } }
    } catch (error) {
      // Server-side diagnostics only: never leak provider/internal details
      // into the user-facing tool result (media transport security contract).
      console.error('[video] generation failed:', error instanceof Error ? error.message : error)
      return { content: error instanceof DailyCreditError ? error.message : mediaFailure(op, 'Video'), isError: true }
    }
    finally { await cleanupDailyReservation(reservation?.id); op.dispose() }
  },
}
