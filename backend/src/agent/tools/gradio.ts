/**
 * Minimal client for the modern Gradio API (`/gradio_api/*`).
 *
 * Current Gradio Spaces expose named endpoints discovered from `/gradio_api/info`,
 * called as POST `/gradio_api/call/<api>` -> { event_id } and streamed from
 * GET `/gradio_api/call/<api>/<event_id>` (SSE). The legacy `/run/predict`
 * shape is still tried first by the media tools; this is the fallback that
 * actually works on current Spaces.
 */
import { providerRequest } from '../../services/providerHttp'
import { checkedMedia, decodeMedia, mediaAuth, mediaOperation, mediaUrl } from '../httpClient'

interface GradioParam {
  label?: string
  parameter_name?: string
  parameter_has_default?: boolean
  parameter_default?: any
  type?: any
  component?: string
}

export interface GradioMedia {
  image?: Buffer
  video?: Buffer
  text?: string
}

const NON_ENTRYPOINTS = /^\/(lambda|refresh_status|frame_info)/

export function pickApi(info: any, mode: 'image' | 'video' | 'edit' = 'video', hasImage = false): { api: string; params: GradioParam[] } | null {
  const named = info?.named_endpoints || {}
  const candidates: Array<{ api: string; params: GradioParam[]; score: number }> = []
  for (const [api, def] of Object.entries<any>(named)) {
    if (NON_ENTRYPOINTS.test(api)) continue
    const params: GradioParam[] = Array.isArray(def?.parameters) ? def.parameters : []
    const textParams = params.filter((p) => p?.type?.type === 'string' && p?.component === 'Textbox').length
    const imageParams = params.filter((p) => /Image/i.test(String(p?.component))).length
    const videoReturn = Array.isArray(def?.returns) && def.returns.some((r: any) => /Video/i.test(String(r?.component)))
    // Prefer a full chain (text + image in, image/video out) and penalise trivial ones.
    const score = textParams * 2 + imageParams + (videoReturn ? 3 : 0)
    // Mode-aware boosting: image mode prefers endpoints returning images
    // (Image component in returns), video mode prefers video-returning endpoints.
    const imageReturn = Array.isArray(def?.returns) && def.returns.some((r: any) => /Image/i.test(String(r?.component)))
    let modeScore: number
    if (mode === 'edit') {
      // ref2lock: an endpoint that TAKES an image, RETURNS an image, and
      // takes a PROMPT (img2img edit) is what anchors identity while applying
      // the prompt — prefer it over a bare face-swap endpoint.
      modeScore = (imageReturn ? 10 : 0) + (imageParams > 0 ? 6 : -20) + (videoReturn ? -5 : 0)
        + (textParams > 0 ? 8 : 0)
    } else if (mode === 'image') {
      modeScore = (imageReturn ? 10 : 0) + (videoReturn ? -5 : 0)
    } else {
      modeScore = (videoReturn ? 10 : 0) + (imageReturn ? -2 : 0)
    }
    // An endpoint that REQUIRES an Image parameter would receive null and fail
    // when we have none — penalise it in every mode (e.g. text-only video ->
    // /image_to_video over /generate_video; text-only image -> /generate_image
    // over the image-requiring /edit_image and /swap_face).
    const missingImagePenalty = imageParams > 0 && !hasImage ? -100 : 0
    candidates.push({ api, params, score: score + modeScore + missingImagePenalty })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  return { api: candidates[0].api, params: candidates[0].params }
}

export function buildArgs(params: GradioParam[], prompt: string, imageBase64?: string,
  opts: { strength?: number; faceSwap?: boolean; negativePrompt?: string } = {}): any[] {
  let promptUsed = false
  return params.map((p) => {
    const comp = String(p?.component || '')
    const label = String(p?.label || p?.parameter_name || '')
    if (/Image/i.test(comp)) {
      // Gradio Image components accept a FileData-shaped object whose `url`
      // carries a base64 data URI — a bare base64 string errors server-side.
      if (!imageBase64) return null
      const uri = imageBase64.startsWith('data:') ? imageBase64 : `data:image/png;base64,${imageBase64}`
      return { url: uri, orig_name: 'reference.png', meta: { _type: 'gradio.FileData' } }
    }
    if (/Textbox/i.test(comp)) {
      // A negative prompt falls back to the endpoint's own default (the media
      // Space ships the model card's quality negative) instead of forcing "".
      if (/neg/i.test(label)) return opts.negativePrompt !== undefined ? opts.negativePrompt : (p?.parameter_default ?? '')
      if (!promptUsed) { promptUsed = true; return prompt }
      return /prompt|motion|video/i.test(label) ? prompt : ''
    }
    // Identity-lock strength slider (ref2lock) honours the caller's value.
    if (opts.strength !== undefined && /Slider|Number/i.test(comp) && /strength|denoise|lock/i.test(label)) {
      return opts.strength
    }
    // Face-lock toggle (exact transplant) honours the caller's value.
    if (opts.faceSwap !== undefined && /Checkbox/i.test(comp) && /face|swap|lock/i.test(label)) {
      return opts.faceSwap
    }
    if (p?.parameter_has_default) return p.parameter_default
    if (p?.type?.enum?.length) return p.type.enum[0]
    if (/Checkbox/i.test(comp)) return false
    if (/Slider|Number/i.test(comp)) return 0
    return null
  })
}

/** Call a Gradio Space's best endpoint and return any image/video/text outputs. */
export async function gradioCallSpace(
  base: string,
  prompt: string,
  opts: { imageBase64?: string; signal?: AbortSignal; timeoutMs?: number; mode?: 'image' | 'video' | 'edit'; strength?: number; faceSwap?: boolean; negativePrompt?: string },
): Promise<GradioMedia> {
  const root = mediaUrl(base).replace(/\/+$/, '')
  const auth = mediaAuth(root)
  console.error('[gradio] fetching info from', root)
  const infoRes = await providerRequest(`${root}/gradio_api/info`, {
    ...auth, signal: opts.signal, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024,
  })
  const info = await infoRes.json()
  const chosen = pickApi(info, opts.mode, !!opts.imageBase64)
  if (!chosen) throw new Error('No usable Gradio endpoint')

  const data = buildArgs(chosen.params, prompt, opts.imageBase64, { strength: opts.strength, faceSwap: opts.faceSwap, negativePrompt: opts.negativePrompt })
  const callRes = await providerRequest(`${root}/gradio_api/call${chosen.api}`, {
    ...auth, method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: opts.signal, timeoutMs: opts.timeoutMs ?? 600000, maxBytes: 1024 * 1024,
  })
  const { event_id: eventId } = await callRes.json()
  if (!eventId) throw new Error('Gradio returned no event id')
  console.error('[gradio] submitted', chosen.api, 'event:', eventId)

  const op = mediaOperation(opts.timeoutMs ?? 600000, opts.signal)
  try {
    const stream = await providerRequest(`${root}/gradio_api/call${chosen.api}/${eventId}`, {
      ...auth, signal: opts.signal, timeoutMs: op.remaining(), maxBytes: 4 * 1024 * 1024,
    })
    // SSE event stream: `event: heartbeat` frames repeat for minutes during
    // generation (data: null), then `event: complete` (or `event: error`)
    // carries the payload. Pair event/data lines and keep ONLY the terminal
    // event — joining every data line (heartbeats included) breaks JSON.parse.
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
    if (resultJson === null && errorJson !== null) throw new Error(`Gradio event error: ${errorJson.slice(0, 200)}`)
    if (resultJson === null) {
      // Log the actual SSE tail so we can see what the Space actually sent
      // (heartbeat-only means the queue dropped it; an error event means the
      // generation failed server-side).
      const tail = raw.slice(-400).replace(/\n/g, ' | ')
      console.error(`[gradio] ${chosen.api}: no complete event. SSE tail: ${tail}`)
      throw new Error('Gradio stream ended without a complete event')
    }
    const payload = JSON.parse(resultJson)
    const out = Array.isArray(payload) ? payload : payload?.data
    const result: GradioMedia = {}
    const urls: Array<{ url: string; kind: 'image' | 'video' }> = []
    for (const item of Array.isArray(out) ? out : []) {
      if (typeof item === 'string' && !item.startsWith('data:') && result.text === undefined) result.text = item
      const url = item?.url || (typeof item?.path === 'string' ? item.path : undefined)
      const mime = String(item?.mime_type || '')
      if (typeof url === 'string') {
        if (mime.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(url)) urls.push({ url, kind: 'image' })
        else if (mime.startsWith('video/') || /\.(mp4|webm)$/i.test(url)) urls.push({ url, kind: 'video' })
      }
      if (item?.video?.url) urls.push({ url: item.video.url, kind: 'video' })
    }
    for (const u of urls) {
      const res = await providerRequest(mediaUrl(new URL(u.url, root).href), {
        ...auth, // private Spaces require the token on file downloads too
        signal: opts.signal, timeoutMs: op.remaining(120000), maxBytes: 64 * 1024 * 1024,
      })
      const buf = checkedMedia(res.body)
      if (u.kind === 'image' && !result.image) result.image = buf
      if (u.kind === 'video' && !result.video) result.video = buf
    }
    return result
  } finally { op.dispose() }
}

export { decodeMedia }
