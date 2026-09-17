import { z } from 'zod'
import { resolveChatTarget } from './chatModels'

const selection = z.object({
  provider: z.literal('huggingface').optional(),
  model: z.string().trim().min(1).max(200).optional(),
}).passthrough()
const forbidden = ['apiKey', 'api_key', 'baseUrl', 'baseURL', 'base_url', 'models', 'selectionMode']

export class ModelSelectionError extends Error {
  constructor() { super('Only hosted model selection is supported; provider credentials and destination overrides are not accepted') }
}

/** HTTP boundary only. Never derive an SDK destination or credential from JSON. */
export function resolveHostedModelRequest(body: unknown) {
  const parsed = selection.safeParse(body)
  if (!parsed.success || forbidden.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    throw new ModelSelectionError()
  }
  // Preserve the catalog's existing alias/unknown-to-standard behavior. The raw
  // client model string is never forwarded upstream, even if it looks like a URL.
  const target = resolveChatTarget(parsed.data.model)
  return { provider: 'huggingface' as const, model: target.model, baseUrl: target.baseUrl, apiKey: undefined }
}
