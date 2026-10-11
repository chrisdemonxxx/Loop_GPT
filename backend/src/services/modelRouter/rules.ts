/**
 * Deterministic routing rules — the router's first pass. Rules are free and
 * instant, so anything they can decide confidently never reaches the router
 * model (JEV). Only genuinely ambiguous chat turns escalate to the
 * classifier (classifier.ts).
 *
 * Target facts verified live 2026-10-10: MiniMax-H3 is video-only; the image
 * Space owns every image task.
 */
import { mediaFleet, type MediaTargetId, type MediaTask } from './fleet'

export interface MediaRouteDecision {
  target: MediaTargetId
  task: MediaTask
  /** Face-identity intent (the Space's transplant/edit pipeline). */
  faceLock: boolean
  /** img2img denoise strength (0-1) for edit tasks. */
  strength: number
  /** Video length controls derived from the prompt. */
  numFrames?: number
  /** Why this target was picked (logged + surfaced in metadata). */
  reason: string
}

const FACE_INTENT = /\b(face|portrait|selfie|headshot|likeness|identity|same (person|man|woman|face)|this (person|man|woman|model)|keep (the|his|her|their) face)\b/i

/** Parse a requested duration out of the prompt: "10 seconds", "12s",
 *  "a 30 second clip", "long video". MiniMax renders at 24fps; its config
 *  default is 49 frames (~2s). Long-form asks get more frames (capped at the
 *  endpoint's 241-frame ceiling ≈ 10s). */
export function requestedVideoFrames(prompt: string): number | undefined {
  const m = /(\d{1,3})\s*(?:s|sec|secs|second|seconds)\b/i.exec(prompt)
  if (m) {
    const seconds = Math.max(1, Math.min(20, Number(m[1])))
    return Math.min(241, Math.max(49, Math.round(seconds * 24)))
  }
  if (/\b(long|extended|full[- ]length)\b.{0,30}\b(video|clip|animation)\b/i.test(prompt) || /\b(video|clip|animation)\b.{0,30}\b(long|extended|full[- ]length)\b/i.test(prompt)) {
    return 121 // ~5s
  }
  return undefined
}

/**
 * Route a pinned media turn (/image or /video) to the right deployment.
 * Returns null when nothing capable is configured — the caller falls back to
 * the tool's built-in provider chain.
 *
 * Image rules (image Space owns all image work; providers as last resort):
 *   reference + face/identity intent → Space edit with the face options
 *   reference                        → Space img2img edit
 *   no reference                     → Space text-to-image
 * Video rules (MiniMax only — it is the sole video target):
 *   reference → i2v (i2av); none → t2v (t2av)
 *   duration hints in the prompt raise num_frames / action pacing.
 */
export function routeMediaTurn(opts: {
  tool: 'generate_image' | 'generate_video'
  hasReference: boolean
  prompt: string
}): MediaRouteDecision | null {
  const fleet = mediaFleet()
  const minimax = fleet.find((t) => t.id === 'minimax')
  const space = fleet.find((t) => t.id === 'image-space')
  const flux = fleet.find((t) => t.id === 'flux-providers')

  if (opts.tool === 'generate_video') {
    if (!minimax?.configured) return null
    const frames = requestedVideoFrames(opts.prompt)
    const task: MediaTask = opts.hasReference ? 'i2v' : 't2v'
    return {
      target: 'minimax',
      task,
      faceLock: false,
      strength: 0.6,
      ...(frames ? { numFrames: frames } : {}),
      reason: opts.hasReference
        ? `image-to-video on MiniMax${frames ? ` (~${Math.round(frames / 24)}s)` : ''}`
        : `text-to-video on MiniMax${frames ? ` (~${Math.round(frames / 24)}s)` : ''}`,
    }
  }

  // generate_image — the Space owns t2i + i2i when configured.
  if (space?.configured) {
    const face = opts.hasReference && FACE_INTENT.test(opts.prompt)
    return {
      target: 'image-space',
      task: opts.hasReference ? 'i2i' : 't2i',
      faceLock: face,
      strength: 0.6,
      reason: opts.hasReference
        ? face ? 'face-identity edit → image studio' : 'image-to-image edit → image studio'
        : 'text-to-image → image studio',
    }
  }
  if (flux?.configured) {
    return {
      target: 'flux-providers',
      task: opts.hasReference ? 'i2i' : 't2i',
      faceLock: false,
      strength: 0.6,
      reason: 'image generation → provider fallback',
    }
  }
  return null
}
