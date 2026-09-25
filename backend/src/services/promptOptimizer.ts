/**
 * Server-side prompt optimization via the fast-tier model.
 *
 * Invisible by default: the caller keeps the user's raw text and sends the
 * enhanced version to the actual model. The raw/enhanced pair is returned in
 * the run metadata so the UI can offer a "view enhanced prompt" toggle.
 * Per-modality system prompts: chat/agent/research and image/video generation
 * want different enhancements.
 *
 * Fail-open: if the optimizer times out or errors, the raw prompt is used.
 */
import { createClient } from '../agent/llmClient'

export type PromptModality = 'chat' | 'agent' | 'research' | 'image' | 'video'

const COMMON = `Do NOT answer the question or add content the user didn't ask for.
Return ONLY the improved prompt, no commentary, no labels, no quotes.`

const SYSTEM: Record<PromptModality, string> = {
  chat: `You are a writing advisor. Improve the user's message to be more effective for an AI assistant: clear, specific, structured where appropriate. ${COMMON}`,
  agent: `You are a writing advisor. Improve the user's task for an autonomous tool-using agent: make the goal explicit, name the deliverable and any constraints, and keep it actionable. ${COMMON}`,
  research: `You are a writing advisor. Sharpen the user's research question: keep the intent, make scope and key angles explicit. ${COMMON}`,
  image: `You are a prompt engineer for a text-to-image / image-editing model. Rewrite the prompt with concrete subject, composition, lighting, style and camera detail. Preserve the original subject and any identity. ${COMMON}`,
  video: `You are a prompt engineer for an image-to-video model. Rewrite the prompt to describe motion, camera movement, pacing and atmosphere while preserving the reference subject's identity and style. ${COMMON}`,
}

const OPTIMIZE_TIMEOUT_MS = 8000

export function modalityOf(mode: string | undefined, hasImage?: boolean): PromptModality {
  if (mode === 'research') return 'research'
  if (mode === 'image') return 'image'
  if (mode === 'video') return 'video'
  if (mode === 'agent') return 'agent'
  return 'chat'
}

export interface OptimizeResult { raw: string; enhanced: string; optimized: boolean }

/** Run the optimizer. Returns enhanced text and whether it actually changed. */
export async function optimizePromptDetailed(raw: string, modality: PromptModality): Promise<OptimizeResult> {
  const trimmed = (raw || '').trim()
  if (!trimmed || trimmed.length > 50_000) return { raw: trimmed, enhanced: trimmed, optimized: false }
  // Deterministic in tests: never reach the network for prompt rewriting.
  if (process.env.NODE_ENV === 'test') return { raw: trimmed, enhanced: trimmed, optimized: false }

  try {
    // Fast-tier endpoint: HF_ENDPOINT_URL (the "fast"/standard tier).
    const endpoint = process.env.HF_OPTIMIZER_ENDPOINT_URL || process.env.HF_ENDPOINT_URL || process.env.HF_LARGE_ENDPOINT_URL
    if (!endpoint) return { raw: trimmed, enhanced: trimmed, optimized: false }

    const client = createClient('huggingface', undefined, endpoint.replace(/\/+$/, '') + '/v1')
    const result = await client.chat.completions.create({
      messages: [
        { role: 'system', content: SYSTEM[modality] || SYSTEM.chat },
        { role: 'user', content: trimmed },
      ],
      model: process.env.HF_OPTIMIZER_MODEL || process.env.HF_MODEL || 'tgi',
      max_tokens: Math.round(trimmed.length * 1.5) + 128,
      temperature: 0.3,
      top_p: 0.9,
    }, { maxRetries: 0, timeout: OPTIMIZE_TIMEOUT_MS })

    const enhanced = result.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '')
    if (!enhanced || enhanced.length < Math.max(trimmed.length * 0.3, 2)) return { raw: trimmed, enhanced: trimmed, optimized: false }
    return { raw: trimmed, enhanced, optimized: enhanced !== trimmed }
  } catch {
    // Fail-open: the raw prompt is always acceptable.
    return { raw: trimmed, enhanced: trimmed, optimized: false }
  }
}

/** Backwards-compatible: enhanced text only. */
export async function optimizePrompt(raw: string, modality: PromptModality): Promise<string> {
  return (await optimizePromptDetailed(raw, modality)).enhanced
}
