'use client'

import type { FileChange } from '@loop/loopit-client'

/** Lightweight unified-diff renderer (editable Monaco lives in CodeEditorDrawer). */
export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="m-0 overflow-auto p-3 font-mono text-3xs leading-relaxed">
      {lines.map((line, index) => {
        let cls = 'text-[var(--ink-secondary)]'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'bg-[var(--success-soft,transparent)] text-[var(--success)]'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'bg-[var(--danger-soft,transparent)] text-[var(--danger)]'
        else if (line.startsWith('@@')) cls = 'text-[var(--accent-text)]'
        else if (line.startsWith('---') || line.startsWith('+++')) cls = 'text-[var(--ink-muted)]'
        return (
          <div key={`${index}-${line.slice(0, 24)}`} className={`whitespace-pre-wrap break-words ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export function FileChangeChips({
  changes,
  onOpen,
}: {
  changes: FileChange[]
  onOpen: (change: FileChange) => void
}) {
  if (!changes.length) return null
  // Collapse duplicate paths to the latest change.
  const latest = new Map<string, FileChange>()
  for (const change of changes) latest.set(change.path, change)
  const items = [...latest.values()]
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {items.map((change) => (
        <button
          key={change.path}
          type="button"
          onClick={() => onOpen(change)}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-2 py-0.5 font-mono text-3xs text-[var(--ink-secondary)] hover:border-[var(--accent-soft-border)] hover:text-[var(--accent-text)] transition"
          title={`${change.op} · +${change.additions} −${change.deletions}`}
        >
          <span className="text-[var(--ink-muted)]">{change.op === 'create' ? '+' : change.op === 'delete' ? '−' : '~'}</span>
          {change.path}
          <span className="text-[var(--ink-muted)]">+{change.additions}/−{change.deletions}</span>
        </button>
      ))}
    </div>
  )
}
