'use client'

import type { RunMode } from '@loop/loopit-client'

const MODES: { id: RunMode; label: string; hint: string }[] = [
  { id: 'build', label: 'Build', hint: 'Write and verify code' },
  { id: 'chat', label: 'Chat', hint: 'Read-only Q&A' },
  { id: 'plan', label: 'Plan', hint: 'Draft a task list' },
]

export function ModeSwitch({
  value,
  onChange,
  disabled,
}: {
  value: RunMode
  onChange: (mode: RunMode) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-0.5" role="group" aria-label="Composer mode">
      {MODES.map((mode) => {
        const active = value === mode.id
        return (
          <button
            key={mode.id}
            type="button"
            title={mode.hint}
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(mode.id)}
            className={`rounded-md px-2.5 py-1 text-2xs font-medium transition ${
              active
                ? 'bg-[var(--bg-overlay)] text-[var(--accent-text)] shadow-sm'
                : 'text-[var(--ink-muted)] hover:text-[var(--ink-secondary)]'
            } disabled:opacity-50`}
          >
            {mode.label}
          </button>
        )
      })}
    </div>
  )
}
