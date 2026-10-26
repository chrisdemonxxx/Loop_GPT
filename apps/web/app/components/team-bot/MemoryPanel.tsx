'use client'

import { useState } from 'react'

export interface MemoryRow {
  id: string
  content: string
  visibility: 'private' | 'team'
  createdAt: string
}

export function MemoryPanel({
  memories,
  onAdd,
  onDelete,
}: {
  memories: MemoryRow[]
  onAdd: (input: { content: string; visibility: 'private' | 'team' }) => void
  onDelete: (id: string) => void
}) {
  const [content, setContent] = useState('')
  const [team, setTeam] = useState(false)
  return (
    <div>
      <h3 className="mb-1.5 text-2xs uppercase tracking-widest text-[var(--ink-muted)]">Memory</h3>
      <ul className="space-y-1.5">
        {memories.map((memory) => (
          <li key={memory.id} className="flex items-start justify-between gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-2.5 py-2">
            <div>
              <p className="text-ui-xs text-[var(--ink-secondary)]">{memory.content}</p>
              <p className="text-3xs text-[var(--ink-muted)]">{memory.visibility === 'team' ? 'Team' : 'Private'}</p>
            </div>
            <button type="button" onClick={() => onDelete(memory.id)} aria-label={`Delete memory ${memory.content}`} className="text-2xs text-[var(--ink-muted)] hover:text-[var(--danger)]">Delete</button>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!content.trim()) return
          onAdd({ content: content.trim(), visibility: team ? 'team' : 'private' })
        }}
      >
        <label className="block text-2xs text-[var(--ink-muted)]">
          New memory
          <input aria-label="New memory" value={content} onChange={(e) => setContent(e.target.value)} className="mt-1 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 text-ui-xs" />
        </label>
        <label className="flex items-center gap-1.5 text-2xs text-[var(--ink-secondary)]">
          <input type="checkbox" aria-label="Team" checked={team} onChange={(e) => setTeam(e.target.checked)} />
          Team
        </label>
        <button type="submit" className="rounded-lg bg-[var(--accent-fill)] px-2.5 py-1 text-2xs text-white">Add memory</button>
      </form>
      <p className="mt-1.5 text-3xs text-[var(--ink-muted)]">Private by default. Team notes stay on this bot and only you can read them.</p>
    </div>
  )
}
