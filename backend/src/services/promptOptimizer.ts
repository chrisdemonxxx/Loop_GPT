/**
 * Server-side prompt optimization via the fast-tier model.
 * Invisible by default: the user's raw content is stored in messages while the
 * enhanced version is sent to the actual model. The raw vs enhanced comparison
 * appears in the design pass (the spec's "view/edit enhanced prompt" toggle).
 * Fail-open: if the optimizer times out or errors, the raw prompt is used.
 */
import { createClient } from '../agent/llmClient'
import type { UsageKind } from './billing'

const OPTIMIZE_SYSTEM = `You are a writing advisor. Improve the user's message to be more
effective for an AI assistant: clear, specific, structured where appropriate.
Do NOT answer the question or add content the user didn't ask for.
Return ONLY the improved message, no commentary, no labels.`

const OPTIMIZE_TIMEOUT_MS = 8000

/** Run the optimizer. Returns the enhanced text on success, or the raw text if
 * the fast-tier model is unavailable, times out, or returns garbage. */
export async function optimizePrompt(raw: string, _mode: UsageKind): Promise<string> {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 50_000) return trimmed

  try {
    // Fast-tier endpoint: HF_ENDPOINT_URL + HF_MODEL (the "fast"/standard tier).
    // Production may route to a dedicated optimizer endpoint registered in
    // the model provider's config; for now both tiers point at the live
    // dedicated endpoints (fast = standard).
    const endpoint = process.env.HF_ENDPOINT_URL || process.env.HF_LARGE_ENDPOINT_URL
    if (!endpoint) return trimmed

    const client = createClient('huggingface', undefined, endpoint + '/v1')
    const result = await client.chat.completions.create({
      messages: [
        { role: 'system', content: OPTIMIZE_SYSTEM },
        { role: 'user', content: trimmed },
      ],
      model: process.env.HF_MODEL || 'tgi',
      max_tokens: Math.round(trimmed.length * 1.5) + 128,
      temperature: 0.3,
      top_p: 0.9,
    }, { maxRetries: 0, timeout: OPTIMIZE_TIMEOUT_MS })

    const enhanced = result.choices?.[0]?.message?.content?.trim()
    if (!enhanced || enhanced.length < Math.max(trimmed.length * 0.3, 2)) return trimmed
    return enhanced
  } catch {
    // Fail-open: the raw prompt is always acceptable.
    return trimmed
  }
}
