/**
 * The model fleet — every deployment the router can send work to, declared in
 * one place with its capabilities. Chat tiers resolve through chatModels.ts
 * (their env contract stays unchanged); media targets are declared here with
 * the transports generateImage/generateVideo know how to drive.
 *
 * Verified live on 2026-10-10 (probes against the red-kit org):
 *   - MiniMax-H3 (LightX2V) endpoint: VIDEO ONLY. Its runner rejects image
 *     tasks ("Task 't2i' is not supported by this runner; expected one of:
 *     t2av, i2av, l2av, fl2av, ref2av"). It serves /v1/tasks/video — no
 *     image generation despite the routes existing in its OpenAPI.
 *   - The image Space (HF_IMAGE_ENDPOINT_URL when .hf.space): text-to-image
 *     and image-to-image edits via the generic Gradio named-API client.
 *
 * Upstream identity stays hidden from users (agent/guardrails.ts) — labels
 * here are internal/human-facing for logs and admin surfaces only.
 */

export type MediaTargetId = 'minimax' | 'image-space' | 'flux-providers'

export type MediaTask = 't2i' | 'i2i' | 't2v' | 'i2v'

export interface MediaTargetSpec {
  id: MediaTargetId
  label: string
  /** What this deployment can actually do (verified, not advertised). */
  tasks: MediaTask[]
  /** ref2lock-style face transplant params (face-swap checkbox) — best-effort:
   *  Gradio arg mapping simply drops the option when the Space has no such
   *  parameter, so a plain img2img edit is the graceful degradation. */
  faceLock: boolean
  /** Long-video controls (num_frames up to 241, timed action_prompts). */
  longVideo: boolean
  /** Resolved endpoint URL (undefined when unconfigured). */
  endpoint?: string
  configured: boolean
}

/** The MiniMax-H3 LightX2V endpoint — video tasks only (t2av/i2av long-form
 *  with num_frames + action_prompts). Selected by HF_VIDEO_API=lightx2v;
 *  the URL comes from the video env family. */
export function minimaxEndpoint(): string | undefined {
  return (
    process.env.MINIMAX_ENDPOINT_URL ||
    process.env.HF_VIDEO_ENDPOINT_URL ||
    process.env.VIDEO_API_URL ||
    undefined
  )?.replace(/\/+$/, '')
}

export function minimaxConfigured(): boolean {
  return !!minimaxEndpoint()
}

/** The image Space (currently red-kit/glm-image-pro; the ref2lock Chroma
 *  studio red-kit/nsfw-media-studio is the same lane when healthy). Detected
 *  by the .hf.space host of HF_IMAGE_ENDPOINT_URL. */
export function imageSpaceEndpoint(): string | undefined {
  const url = (process.env.HF_IMAGE_ENDPOINT_URL || '').replace(/\/+$/, '')
  return url.includes('.hf.space') ? url : undefined
}

export function fluxProvidersConfigured(): boolean {
  return !!process.env.HF_TOKEN
}

/** The media fleet, in router preference order per capability. */
export function mediaFleet(): MediaTargetSpec[] {
  const minimax = minimaxEndpoint()
  const space = imageSpaceEndpoint()
  return [
    {
      id: 'minimax',
      label: 'MiniMax studio',
      tasks: ['t2v', 'i2v'],
      faceLock: false,
      longVideo: true,
      endpoint: minimax,
      configured: !!minimax,
    },
    {
      id: 'image-space',
      label: 'Image studio',
      tasks: ['t2i', 'i2i'],
      faceLock: true,
      longVideo: false,
      endpoint: space,
      configured: !!space,
    },
    {
      id: 'flux-providers',
      label: 'Provider fallback',
      tasks: ['t2i', 'i2i'],
      faceLock: false,
      longVideo: false,
      configured: fluxProvidersConfigured(),
    },
  ]
}

export function mediaTarget(id: MediaTargetId): MediaTargetSpec {
  return mediaFleet().find((t) => t.id === id)!
}
