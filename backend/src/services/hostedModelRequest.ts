import { z } from 'zod'
import { resolveChatTarget, smartRouteTask } from './chatModels'

const selection = z.object({
  provider: z.literal('huggingface').optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).passthrough()
const forbidden = ['apiKey', 'api_key', 'baseUrl', 'baseURL', 'base_url', 'models', 'selectionMode']

export class ModelSelectionError extends Error {
  constructor() { super('Only hosted model selection is supported; provider credentials and destination overrides are not accepted') }
}

/**
 * HTTP boundary. When the caller specifies a model, honour it (must be a
 * recognised tier or alias). When omitted, use the smart task router
 * (GAP-026) which selects the tier based on turn features.
 */
export function resolveHostedModelRequest(body: unknown, turnFeatures?: {
  mode?: string
  contentLength?: number
  hasImage?: boolean
  toolNames?: string[]
}) {
  const parsed = selection.safeParse(body)
  if (!parsed.success || forbidden.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    throw new ModelSelectionError()
  }

  // Caller explicitly selected a model → honour it (falls back to standard
  // if unrecognised, per resolveChatTarget semantics).
  if (parsed.data.model) {
    const target = resolveChatTarget(parsed.data.model)
    return { provider: 'huggingface' as const, model: target.model, baseUrl: target.baseUrl, apiKey: undefined }
  }

  // No model selected → smart router decides.
  const target = smartRouteTask(
    turnFeatures?.contentLength ?? 0,
    turnFeatures?.mode ?? 'agent',
    turnFeatures?.hasImage ?? false,
    turnFeatures?.toolNames ?? [],
  )
  return { provider: 'huggingface' as const, model: target.model, baseUrl: target.baseUrl, apiKey: undefined }
}
