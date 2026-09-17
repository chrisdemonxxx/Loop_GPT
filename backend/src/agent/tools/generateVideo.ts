import { saveArtifact } from '../artifacts'
import { providerRequest } from '../../services/providerHttp'
import { checkedMedia, decodeMedia, mediaAuth, mediaFailure, mediaOperation, mediaUrl, VIDEO_RESPONSE_BYTES, type MediaOperation } from '../httpClient'
import { recordUsage } from '../../services/billing'
import { reserveDailyCredits, dailyDispatch, cleanupDailyReservation, DailyCreditError } from '../../services/dailyReservations'
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

async function generateVideoFromEndpoint(prompt: string, image: string | undefined, numFrames: number,
  fps: number, width: number, height: number, op: MediaOperation, beforeDispatch: () => Promise<void>): Promise<Buffer> {
  const endpoint = mediaUrl(process.env.VIDEO_API_URL || process.env.HF_VIDEO_ENDPOINT_URL || '')
  const auth = mediaAuth(endpoint)
  await beforeDispatch()
  const response = await providerRequest(endpoint, { ...auth, method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json', Accept: 'video/mp4, application/json' },
    body: JSON.stringify({ inputs: prompt, parameters: { num_frames: numFrames, fps, width, height,
      ...(image ? { guidance_scale: 7.5 } : {}) }, ...(image ? { image } : {}) }),
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
  description: 'Generate a short video clip from a text prompt or image+prompt. Videos are typically 4-8 seconds at 24fps.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Describe motion, style, lighting and atmosphere.' },
      image_prompt: { type: 'string', description: 'Optional base64 reference image for img2video.' },
      duration_seconds: { type: 'number', description: 'Video duration (2-10 seconds).', default: 4 },
      fps: { type: 'number', description: 'Frames per second (12-30).', default: 24 },
      aspect_ratio: { type: 'string', enum: ['landscape', 'portrait', 'square', 'wide'], default: 'landscape' },
    },
    required: ['prompt'],
  },
  async handler(args, ctx) {
    const op = mediaOperation(300000, ctx.signal)
    let reservation: Awaited<ReturnType<typeof reserveDailyCredits>> | undefined
    try {
      op.check()
      const prompt = String(args.prompt || '').trim()
      if (!prompt) return { content: 'Error: prompt is required for video generation.', isError: true }
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
      ctx.emit({ type: 'status', message: `Generating ${duration}s video at ${fps}fps (${width}x${height})...` })
      const buffer = await generateVideoFromEndpoint(prompt, args.image_prompt ? String(args.image_prompt) : undefined,
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
        data: { artifact, duration, fps, frames: numFrames, model: 'skyreels-v2' } }
    } catch (error) { return { content: error instanceof DailyCreditError ? error.message : mediaFailure(op, 'Video'), isError: true } }
    finally { await cleanupDailyReservation(reservation?.id); op.dispose() }
  },
}
