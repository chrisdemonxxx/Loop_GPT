'use client'

import {
  CREDITS_PER_TURN_HINT,
  EFFORT_OPTIONS,
  effortOption,
  formatCreditEstimate,
  shouldEstimateBeforeRun,
  type EffortTier,
  type RunTier,
} from '@loop/loopit-client'

export function EffortSwitch({
  value,
  onChange,
  disabled,
}: {
  value: EffortTier
  onChange: (tier: EffortTier) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-0.5" role="group" aria-label="Effort">
      {EFFORT_OPTIONS.map((option) => {
        const active = value === option.id
        return (
          <button
            key={option.id}
            type="button"
            title={`${option.hint} · ~${formatCreditEstimate(option.estimateCredits)} credits`}
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${
              active
                ? 'bg-[var(--bg-overlay)] text-[var(--accent-text)] shadow-sm'
                : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
            } disabled:opacity-50`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Compact credits / effort line for composers and run headers. */
export function CostTransparencyBar({
  tier,
  creditsSpent,
  iterations,
}: {
  tier?: RunTier | null
  creditsSpent?: number | null
  iterations?: number | null
}) {
  const option = effortOption(tier)
  const perTurn = creditsSpent != null && iterations != null && iterations > 0
    ? creditsSpent / iterations
    : CREDITS_PER_TURN_HINT
  return (
    <span className="text-3xs text-[var(--ink-muted)]">
      {option.label} · ~{formatCreditEstimate(perTurn)} credits/turn
      {creditsSpent != null && creditsSpent > 0 ? ` · ${formatCreditEstimate(creditsSpent)} spent` : ''}
      {` · est. ${formatCreditEstimate(option.estimateCredits)}`}
    </span>
  )
}

/** Estimate banner before Deep / Plan Approve. */
export function EffortEstimateNotice({
  tier,
  mode,
}: {
  tier?: RunTier | null
  mode?: string | null
}) {
  if (!shouldEstimateBeforeRun(tier, mode)) return null
  const option = effortOption(tier === 'max' ? 'deep' : tier)
  const planExtra = mode === 'plan' ? ' Approving a large plan may use the full budget.' : ''
  return (
    <p className="rounded-lg border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] px-2.5 py-1.5 text-3xs text-[var(--accent-text)]" role="status">
      Estimated ~{formatCreditEstimate(option.estimateCredits)} credits
      ({option.iterations} turns max) for {option.label}.{planExtra}
    </p>
  )
}
