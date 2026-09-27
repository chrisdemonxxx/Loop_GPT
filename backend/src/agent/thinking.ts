/**
 * Reasoning-effort resolver — the ONE place that maps a client's `thinking`
 * value onto the knobs we actually have. Contract: `team/CONTRACT_P2_STREAM.md` §A.
 *
 * `thinking` is a *widening*, not a fork: `true ≡ 'medium'`, `false ≡ off`,
 * omitted ≡ the operator env default. Every shipped client (mobile, any stale
 * static bundle) keeps a 200 — no deprecation window.
 *
 * The bug this closes: `agentRuntime.ts` honoured the per-run override for the
 * prompt suffix while `llmClient.ts` read `process.env.QWEN_THINKING` and
 * nothing else, so `thinking:true` appended `/think` while the transport still
 * said `enable_thinking:false`. Both call sites import this file now; neither
 * reads the env directly afterwards, so the two can no longer disagree.
 *
 * Three knobs exist and no more: the prompt suffix, `enable_thinking`, and
 * `max_tokens`. This resolver owns the first two plus the prompt-level CoT cap.
 * `max_tokens` is left to the caller — above `'high'` the only lever that
 * exists on our endpoints is a prompt-level cap, so `'xhigh'` differs from
 * `'high'` in the *prompt*, not in the transport. That is a stated limit,
 * not a bug.
 */

/** The effort tiers, in ascending order. Wire + zod source of truth. */
export const THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const

export type ThinkingEffort = (typeof THINKING_EFFORTS)[number]

/** What a client may send: the legacy boolean, an effort tier, or nothing. */
export type ThinkingInput = boolean | ThinkingEffort | undefined

/**
 * `qwen` — a Qwen-family model, which understands `/think`, `/no_think` and the
 * `enable_thinking` transport flag. `other` — anything else: it still gets the
 * suffix (today's code appends it for every provider), but `enable_thinking`
 * is never forced on for it.
 */
export type ThinkingFamily = 'qwen' | 'other'

export interface ResolvedThinking {
  /** Appended to the system prompt. `''` means no suffix. */
  suffix: '' | '/think' | '/no_think'
  /** Value for `enable_thinking`. `undefined` = send nothing (provider default). */
  enableThinking?: boolean
  /** Prompt-level reasoning cap in tokens. Only set above `'high'`. */
  cotCap?: number
}

/** The live fleet is Qwen-derived; anything else keeps the legacy behaviour. */
export function thinkingFamily(model: string | undefined | null): ThinkingFamily {
  return /qwen/i.test(model || '') ? 'qwen' : 'other'
}

/**
 * Resolve one client value into the transport/prompt knobs. Pure: the env is a
 * parameter, so the legacy path is testable and no caller has to read
 * `QWEN_THINKING` itself.
 */
export function resolveThinking(
  value: ThinkingInput,
  family: ThinkingFamily,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedThinking {
  const envValue = env.QWEN_THINKING
  const envOn = envValue === 'true'
  const qwen = family === 'qwen'

  // Omitted / 'auto' — legacy path, byte-for-byte today's behaviour:
  //   env 'true'      → /think, no enable_thinking override
  //   env undefined   → /no_think, enable_thinking:false
  //   env set to any other value → no suffix, enable_thinking:false
  if (value === undefined) {
    return {
      suffix: envOn ? '/think' : envValue === undefined ? '/no_think' : '',
      enableThinking: envOn ? undefined : false,
    }
  }

  // Explicit off — the legacy boolean and the only "off" tier.
  if (value === false) return { suffix: '/no_think', enableThinking: false }

  // Explicit on: `true` is the frozen alias for 'medium'.
  const effort: ThinkingEffort = value === true ? 'medium' : value
  const resolved: ResolvedThinking = {
    suffix: '/think',
    // 'low'/'medium' ask for thinking without pinning the transport — the
    // provider default is the point. Above that, `enable_thinking` is only a
    // Qwen transport flag, so a non-Qwen family never has it forced on.
    enableThinking: qwen && (effort === 'high' || effort === 'xhigh') ? true : undefined,
  }
  if (effort === 'high') resolved.cotCap = 2000
  else if (effort === 'xhigh') resolved.cotCap = 8000
  return resolved
}
