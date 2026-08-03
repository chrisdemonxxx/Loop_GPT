/**
 * Central agent tuning knobs, env-overridable.
 *
 * Defaults are tuned for a well-resourced backend (e.g. the model served on an
 * A100 80GB, which comfortably handles a large context window, long outputs,
 * and many tool-calling iterations). Every value can be overridden via env.
 */
function num(name: string, fallback: number): number {
  const v = process.env[name]
  const n = v ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const agentConfig = {
  /** Max output tokens per model turn. */
  maxTokens: num('HF_MAX_TOKENS', 8192),
  /** Max output tokens for long-form synthesis (deep research reports). */
  maxSynthesisTokens: num('AGENT_MAX_SYNTHESIS_TOKENS', 8192),
  /** Max tool-calling iterations before the agent must answer. */
  maxSteps: num('AGENT_MAX_STEPS', 16),
  /** How many prior messages to include as conversation memory. */
  historyWindow: num('AGENT_HISTORY_WINDOW', 40),
  /** Sampling temperature. */
  temperature: Number(process.env.AGENT_TEMPERATURE ?? 0.7),
  /** Deep research breadth. */
  research: {
    maxQueries: num('RESEARCH_MAX_QUERIES', 7),
    maxSources: num('RESEARCH_MAX_SOURCES', 15),
    perSourceChars: num('RESEARCH_PER_SOURCE_CHARS', 6000),
  },
  /** Request timeout (ms) — generous for large generations / cold starts. */
  requestTimeoutMs: num('HF_REQUEST_TIMEOUT_MS', 300000),
}
