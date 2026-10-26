'use client'

import { useState } from 'react'

export function SkillEditor({
  initial,
  onSave,
  onRun,
  onCancel,
}: {
  initial?: { name?: string; description?: string; instructions?: string }
  onSave: (input: { name: string; description: string; instructions: string }) => void
  onRun?: (input: { name: string; description: string; instructions: string }) => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial?.name || '')
  const [description, setDescription] = useState(initial?.description || '')
  const [instructions, setInstructions] = useState(initial?.instructions || '')
  const value = { name: name.trim(), description: description.trim(), instructions }
  return (
    <form
      className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-3"
      onSubmit={(e) => { e.preventDefault(); if (value.name && value.instructions.trim()) onSave(value) }}
    >
      <label className="block text-2xs text-[var(--ink-muted)]">
        Name
        <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 text-ui-sm text-[var(--ink-primary)]" />
      </label>
      <label className="block text-2xs text-[var(--ink-muted)]">
        When to use
        <input aria-label="When to use" value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 text-ui-sm text-[var(--ink-primary)]" />
      </label>
      <label className="block text-2xs text-[var(--ink-muted)]">
        Instructions
        <textarea aria-label="Instructions" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={6} className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 font-mono text-ui-xs text-[var(--ink-primary)]" />
      </label>
      <div className="flex justify-end gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="px-2 py-1 text-ui-xs text-[var(--ink-muted)]">Cancel</button>}
        {onRun && <button type="button" onClick={() => onRun(value)} className="rounded-lg px-2.5 py-1 text-ui-xs text-[var(--accent-text)]">Run skill</button>}
        <button type="submit" className="rounded-lg bg-[var(--accent-fill)] px-2.5 py-1 text-ui-xs text-white">Save skill</button>
      </div>
    </form>
  )
}
