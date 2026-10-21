/**
 * Phase 3.6 — effort / cost transparency for Build Mode.
 *
 * Maps Quick / Standard / Deep onto the engine `tier` that sizes the iteration
 * budget (brief.py: quick=8, standard=14, deep=24, max=40). Estimates are
 * client-side heuristics for the composer; live metering still posts per-turn
 * usage to Loop-GPT when LOOPIT_USAGE_URL is set.
 */

import type { RunTier } from './api'

export type EffortTier = Exclude<RunTier, 'max'>

export interface EffortOption {
  id: EffortTier
  label: string
  hint: string
  /** Engine iteration budget for this tier. */
  iterations: number
  /** Rough credit estimate before a run (heuristic, not a reservation). */
  estimateCredits: number
}

export const EFFORT_OPTIONS: EffortOption[] = [
  { id: 'quick', label: 'Quick', hint: 'Short recovery budget (~8 turns)', iterations: 8, estimateCredits: 0.08 },
  { id: 'standard', label: 'Standard', hint: 'Default build budget (~14 turns)', iterations: 14, estimateCredits: 0.14 },
  { id: 'deep', label: 'Deep', hint: 'Large plans (~24 turns)', iterations: 24, estimateCredits: 0.24 },
]

/** Credits shown as "per turn" when the stream has not yet reported a turn cost. */
export const CREDITS_PER_TURN_HINT = 0.01

export function effortOption(tier: RunTier | null | undefined): EffortOption {
  const found = EFFORT_OPTIONS.find((option) => option.id === tier)
  return found ?? EFFORT_OPTIONS[1]!
}

/** True when the selected effort (or plan mode) warrants an estimate banner. */
export function shouldEstimateBeforeRun(tier: RunTier | null | undefined, mode?: string | null): boolean {
  if (mode === 'plan') return true
  return tier === 'deep' || tier === 'max'
}

export function formatCreditEstimate(credits: number): string {
  if (credits >= 1) return credits.toFixed(2)
  return credits.toFixed(3)
}
