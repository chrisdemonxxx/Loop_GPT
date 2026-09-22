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

export function pickApi(info: any): { api: string; params: GradioParam[] } | null {
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
    candidates.push({ api, params, score })
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  return { api: candidates[0].api, params: candidates[0].params }
}

export function buildArgs(params: GradioParam[], prompt: string, imageBase64?: string): any[] {
  let promptUsed = false
  return params.map((p) => {
    const comp = String(p?.component || '')
    const label = String(p?.label || p?.parameter_name || '')
    if (/Image/i.test(comp)) return imageBase64 || null
    if (/Textbox/i.test(comp)) {
      if (/neg/i.test(label)) return ''
      if (!promptUsed) { promptUsed = true; return prompt }
      return /prompt|motion|video/i.test(label) ? prompt : ''
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
  opts: { imageBase64?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<GradioMedia> {
  const root = mediaUrl(base).replace(/\/+$/, '')
  const auth = mediaAuth(root)
  const infoRes = await providerRequest(`${root}/gradio_api/info`, {
    ...auth, signal: opts.signal, timeoutMs: 30000, maxBytes: 2 * 1024 * 1024,
  })
  const info = await infoRes.json()
  const chosen = pickApi(info)
  if (!chosen) throw new Error('No usable Gradio endpoint')

  const data = buildArgs(chosen.params, prompt, opts.imageBase64)
  const callRes = await providerRequest(`${root}/gradio_api/call${chosen.api}`, {
    ...auth, method: 'POST',
    headers: { ...auth.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: opts.signal, timeoutMs: opts.timeoutMs ?? 600000, maxBytes: 1024 * 1024,
  })
  const { event_id: eventId } = await callRes.json()
  if (!eventId) throw new Error('Gradio returned no event id')

  const op = mediaOperation(opts.timeoutMs ?? 600000, opts.signal)
  try {
    const stream = await providerRequest(`${root}/gradio_api/call${chosen.api}/${eventId}`, {
      ...auth, signal: opts.signal, timeoutMs: op.remaining(), maxBytes: 4 * 1024 * 1024,
    })
    const text = (await stream.text()).split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6).trim())
      .join('\n')
    if (!text || text === 'null') return {}
    const payload = JSON.parse(text)
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
