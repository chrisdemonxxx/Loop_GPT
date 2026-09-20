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
  return !!process.env.HF_VISION_ENDPOINT_URL
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

/** When the user attaches an image, the agent stream route select the vision
 * target instead of the chat target (unless the caller explicitly requested a
 * non-standard tier). Returns the existing target when vision is unconfigured. */
export function resolveVisionTarget(callerTarget: ChatTarget): ChatTarget | null {
  if (!visionModelEnabled()) return null
  return resolveChatTarget('vision')
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
