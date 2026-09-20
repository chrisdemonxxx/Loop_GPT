/**
 * Selectable chat model tiers.
 *
 * Loop GPT ships two hosted chat backends and one vision backend. All are
 * OpenAI-compatible, so the only thing that varies is the base URL and the
 * upstream model name:
 *
 *   standard — the everyday model (Qwen3.8-27B via the HF router). Fast, cheap.
 *   large    — the flagship DeepSeek-V4.1‑Flash‑Abliterated deployment.
 *   vision   — the best unrestricted VLM (huihui-ai abliterated Qwen3-VL).
 *
 * User-facing copy deliberately never names the upstream model — see
 * `agent/guardrails.ts`, which forbids disclosing model/provider identity.
 * Callers select a tier by id or alias; unknown values fall back to standard.
 */

export type ChatTier = 'standard' | 'large' | 'vision'

export interface ChatModelSpec {
  /** Stable public id, used as the `model` value in API requests. */
  id: string
  tier: ChatTier
  /** Short marketing label shown in the UI. */
  label: string
  description: string
  /** Advertised context window in tokens. */
  contextTokens: number
  /** Extra aliases accepted from clients. */
  aliases: string[]
}

/** Resolved routing target for a tier. */
export interface ChatTarget {
  tier: ChatTier
  /** Upstream model name to send to the provider. */
  model: string
  /** Provider base URL, or undefined to use the global default. */
  baseUrl?: string
  contextTokens: number
}

const STANDARD_CONTEXT = Number(process.env.HF_CONTEXT_TOKENS) || 32_768
const LARGE_CONTEXT = Number(process.env.HF_LARGE_CONTEXT_TOKENS) || 262_144

export const CHAT_MODELS: Record<ChatTier, ChatModelSpec> = {
  standard: {
    id: 'loop-chat',
    tier: 'standard',
    label: 'Loop GPT Standard',
    description: 'Fast everyday model. Best for chat, drafting and tool use.',
    contextTokens: STANDARD_CONTEXT,
    aliases: ['standard', 'loop-chat-standard', 'default', 'small', 'fast', 'qwen-vl-loop', 'loop-chat-vision'],
  },
  large: {
    id: 'loop-chat-large',
    tier: 'large',
    label: 'Loop GPT Large',
    description: 'Flagship model with a 256K context window. Best for deep reasoning, long documents and complex code.',
    contextTokens: LARGE_CONTEXT,
    aliases: ['large', 'loop-large', 'loop-chat-xl', 'xl', 'pro', 'max', 'qwen-vl-loop-large', 'loop-chat-large-vision'],
  },
  vision: {
    id: 'loop-vision',
    tier: 'vision',
    label: 'Loop GPT Vision',
    description: 'Unrestricted vision-language model. Understands images, diagrams, documents and screenshots.',
    contextTokens: 32_768,
    aliases: ['vision', 'loop-vision', 'vl', 'qwen-vl'],
  },
}

/** True when the large endpoint is configured; otherwise it is hidden entirely. */
export function largeModelEnabled(): boolean {
  return !!process.env.HF_LARGE_ENDPOINT_URL
}
export function visionModelEnabled(): boolean {
  // When a dedicated vision endpoint is configured, use it; otherwise fall
  // back to the large/DeepSeek tier (which already supports vision natively).
  return !!(process.env.HF_VISION_ENDPOINT_URL || largeModelEnabled())
}

/** Smart task router: analyses turn signals and recommends a tier.
 *
 * Returns the recommended target WITHOUT resolving the caller-supplied model
 * override (the caller may still select a specific tier — this is the default).
 *
 * Rules:
 *   mode = research → flagship (deep reasoning, multi-step).
 *   attachment (image) → useVLLM (vision) OR flagship if no dedicated vision endpoint.
 *   content length > 4 000 chars → flagship (long context).
 *   Heavy tool count (>= 4) → flagship.
 *   tool list includes code_execution / sandbox / web_search → flagship.
 *   otherwise → fast (Qwen3.8‑Cyber, fast/cheap).
 */
export function smartRouteTask(
  contentLength: number,
  mode: string,
  hasImage: boolean,
  toolNames: string[],
): ChatTarget {
  const ctx = contentLength
  const heavyTools = ['sandbox', 'code_execution', 'browser', 'web_search', 'web_fetch']
  const HEAVY_TOOL_LIMIT = 4

  // Research mode always uses the flagship tier.
  if (mode === 'research') {
    if (largeModelEnabled()) return resolveChatTarget('large')
    return resolveChatTarget('standard')
  }

  // Vision: route to the vision pipeline (dedicated VLM or DeepSeek large tier).
  if (hasImage && visionModelEnabled()) {
    const visionTarget = resolveVisionTarget({ provider: 'huggingface', model: '', baseUrl: '', apiKey: undefined })
    if (visionTarget) return visionTarget as unknown as ChatTarget
  }

  // Heavy context or tools → flagship.
  const toolCount = toolNames?.length || 0
  if (ctx > 4_000 || toolCount >= HEAVY_TOOL_LIMIT || toolNames?.some((t) => heavyTools.includes(t))) {
    if (largeModelEnabled()) return resolveChatTarget('large')
  }

  // Default: fast tier (standard → Qwen3.8‑Cyber).
  return resolveChatTarget('standard')
}

export function availableChatModels(): ChatModelSpec[] {
  const out = [CHAT_MODELS.standard]
  if (largeModelEnabled()) out.push(CHAT_MODELS.large)
  if (visionModelEnabled()) out.push(CHAT_MODELS.vision)
  return out
}

/** Normalise a base URL to the OpenAI-compatible `/v1` root. */
function toV1(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

/**
 * Map a caller-supplied model string to a tier. Matching is case-insensitive
 * and accepts the public id, any alias, or the raw upstream model name.
 * Anything unrecognised resolves to `standard`.
 */
export function tierFor(model?: string | null): ChatTier {
  if (!model) return 'standard'
  const m = model.trim().toLowerCase()
  if (!m) return 'standard'

  for (const spec of Object.values(CHAT_MODELS)) {
    if (spec.id.toLowerCase() === m) return spec.tier
    if (spec.aliases.some((a) => a.toLowerCase() === m)) return spec.tier
  }
  // Match on the configured upstream names too.
  if (largeModelEnabled()) {
    const upstream = (process.env.HF_LARGE_MODEL || '').toLowerCase()
    if (upstream && upstream === m) return 'large'
    if (/^(glm|zai|z-ai)[\w.\-]*/.test(m)) return 'large'
  }
  return 'standard'
}

/** Resolve a tier (or a caller-supplied model string) to a routing target. */
export function resolveChatTarget(model?: string | null): ChatTarget {
  const tier = tierFor(model)

  if (tier === 'large' && largeModelEnabled()) {
    return {
      tier: 'large',
      model: process.env.HF_LARGE_MODEL || '/repository',
      baseUrl: toV1(process.env.HF_LARGE_ENDPOINT_URL as string),
      contextTokens: LARGE_CONTEXT,
    }
  }

  if (tier === 'vision' && visionModelEnabled()) {
    return {
      tier: 'vision',
      model: process.env.HF_VISION_MODEL || 'tgi',
      baseUrl: toV1(process.env.HF_VISION_ENDPOINT_URL as string),
      contextTokens: CHAT_MODELS.vision.contextTokens,
    }
  }

  return {
    tier: 'standard',
    model: process.env.HF_MODEL || 'tgi',
    baseUrl: process.env.HF_ENDPOINT_URL ? toV1(process.env.HF_ENDPOINT_URL) : undefined,
    contextTokens: STANDARD_CONTEXT,
  }
}

/** When the user attaches an image, the agent stream route selects the vision
 * target instead of the chat target. Uses a dedicated vision endpoint if one is
 * configured; otherwise falls back to the large/DeepSeek tier (which natively
 * supports multimodal input — the DeepSeek-V4.1-Flash-Abliterated endpoint).
 * Returns null when no vision-capable model is available. */
export function resolveVisionTarget(callerTarget: CallerTarget): CallerTarget | null {
  // Dedicated VLM endpoint configured → route to it.
  if (process.env.HF_VISION_ENDPOINT_URL && process.env.HF_VISION_MODEL) {
    const t = resolveChatTarget('vision')
    return { provider: 'huggingface', model: t.model, baseUrl: t.baseUrl, apiKey: undefined }
  }
  // No dedicated vision endpoint but the large/DeepSeek tier is set → it is
  // vision-capable; route to it for image-attachment turns.
  if (largeModelEnabled()) {
    const t = resolveChatTarget('large')
    return { provider: 'huggingface', model: t.model, baseUrl: t.baseUrl, apiKey: undefined }
  }
  return null
}

/** Minimal shape the caller target and our return need to match the agent route. */
interface CallerTarget {
  provider: string
  model: string
  baseUrl?: string
  apiKey?: string
}

/** Build an OpenAI‑compatible vision messages array from text + image buffer. */
export function buildVisionMessages(
  text: string,
  imageBuffer: Buffer,
  mimeType: string,
): Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }> {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` } },
      ],
    },
  ]
}

/** Public catalogue entries for `/v1/models` and the UI model picker. */
export function chatModelCatalog() {
  return availableChatModels().map((m) => ({
    id: m.id,
    tier: m.tier,
    label: m.label,
    description: m.description,
    contextTokens: m.contextTokens,
  }))
}
