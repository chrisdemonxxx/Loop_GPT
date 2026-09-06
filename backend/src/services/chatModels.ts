/**
 * Selectable chat model tiers.
 *
 * Loop GPT ships two hosted chat backends. Both are OpenAI-compatible, so the
 * only thing that varies is the base URL and the upstream model name:
 *
 *   standard — the everyday model (Qwen3.8-27B via the HF router). Fast, cheap.
 *   large    — the flagship GLM deployment on a dedicated vLLM endpoint with a
 *              256K context window. Slower and pricier, better at hard reasoning
 *              and long documents.
 *
 * User-facing copy deliberately never names the upstream model — see
 * `agent/guardrails.ts`, which forbids disclosing model/provider identity.
 * Callers select a tier by id or alias; unknown values fall back to standard.
 */

export type ChatTier = 'standard' | 'large'

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
}

/** True when the large endpoint is configured; otherwise it is hidden entirely. */
export function largeModelEnabled(): boolean {
  return !!process.env.HF_LARGE_ENDPOINT_URL
}

export function availableChatModels(): ChatModelSpec[] {
  const out = [CHAT_MODELS.standard]
  if (largeModelEnabled()) out.push(CHAT_MODELS.large)
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
  // Match on the configured upstream names too, so `HF_LARGE_MODEL` works.
  if (largeModelEnabled()) {
    const upstream = (process.env.HF_LARGE_MODEL || '').toLowerCase()
    if (upstream && upstream === m) return 'large'
    // GLM deployments are commonly requested by family name.
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

  return {
    tier: 'standard',
    model: process.env.HF_MODEL || 'tgi',
    baseUrl: process.env.HF_ENDPOINT_URL ? toV1(process.env.HF_ENDPOINT_URL) : undefined,
    contextTokens: STANDARD_CONTEXT,
  }
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
