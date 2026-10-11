/**
 * The router brain (internal codename "JEV"): a small, fast model that picks
 * the right chat tier for turns the deterministic rules can't confidently
 * place. It is deliberately a SECOND opinion — rules run first (free,
 * instant); JEV only arbitrates the default-fast path, deciding whether a
 * prompt actually needs the flagship or deep-reasoning tier.
 *
 * Contract: OpenAI-compatible /v1/chat/completions at ROUTER_ENDPOINT_URL,
 * answering a single strict JSON object. Any failure (timeout, malformed
 * JSON, unknown tier) returns null and the caller keeps the rule-based
 * default — the router can never break the chat path.
 */
import { z } from 'zod'

export interface RouterClassification {
  tier: 'standard' | 'large' | 'vision' | 'glm5'
  reason: string
}

const ANSWER = z.object({
  tier: z.enum(['standard', 'large', 'vision', 'glm5']),
  reason: z.string().max(160).optional().default(''),
})

export function routerConfigured(): boolean {
  return !!process.env.ROUTER_ENDPOINT_URL
}

function routerV1Url(): string {
  const base = (process.env.ROUTER_ENDPOINT_URL || '').replace(/\/+$/, '')
  return base.endsWith('/v1') ? base : `${base}/v1`
}

const SYSTEM = `You are the model router for Loop GPT. Pick the CHEAPEST tier that fully serves the user's turn. Answer with STRICT JSON only: {"tier":"standard|large|vision|glm5","reason":"<short>"}.

Tiers:
- standard — fast everyday model. Casual chat, drafts, summaries, simple Q&A, quick tools.
- large — flagship. Complex reasoning, coding, long documents, nuanced writing, multi-step problems, images/screenshots to analyse.
- vision — dedicated image-understanding model. Only when the turn ATTACHES an image to look at (not generate).
- glm5 — deep deliberate reasoning. Only for exceptionally hard, multi-step, mathematical, or architectural problems.

Rules: vision needs an attached image. When unsure between standard and large, pick standard. JSON only, no prose.`

export async function classifyChatTurn(opts: {
  prompt: string
  hasImage: boolean
  mode: string
  toolNames: string[]
}): Promise<RouterClassification | null> {
  if (!routerConfigured()) return null
  const timeoutMs = Number(process.env.ROUTER_TIMEOUT_MS) || 3_500
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const key = process.env.ROUTER_API_KEY || process.env.HF_TOKEN || ''
    const res = await fetch(`${routerV1Url()}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.ROUTER_MODEL || 'router',
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              prompt: opts.prompt.slice(0, 1_500),
              has_attached_image: opts.hasImage,
              mode: opts.mode,
              tools: opts.toolNames.slice(0, 8),
            }),
          },
        ],
      }),
    })
    if (!res.ok) {
      console.warn(`[router] JEV answered HTTP ${res.status}; keeping rule-based default`)
      return null
    }
    const data: any = await res.json()
    const text: string = data?.choices?.[0]?.message?.content || ''
    const jsonStart = text.indexOf('{')
    const jsonEnd = text.lastIndexOf('}')
    if (jsonStart < 0 || jsonEnd <= jsonStart) return null
    const parsed = ANSWER.safeParse(JSON.parse(text.slice(jsonStart, jsonEnd + 1)))
    if (!parsed.success) return null
    console.info(`[router] JEV picked ${parsed.data.tier} in ${Date.now() - startedAt}ms${parsed.data.reason ? ` — ${parsed.data.reason}` : ''}`)
    return { tier: parsed.data.tier, reason: parsed.data.reason }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      console.warn(`[router] JEV timed out after ${timeoutMs}ms; keeping rule-based default`)
    } else {
      console.warn(`[router] JEV failed (${String(error?.message || error)}); keeping rule-based default`)
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}
