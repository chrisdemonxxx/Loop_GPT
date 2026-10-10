'use client'

/** Queue rows with status colors, schedule badges, computer chip, cancel. */
import { MonitorPlay, RefreshCw, XCircle } from 'lucide-react'

interface BotTask {
  id: string
  kind: string
  goal: string
  status: string
  schedule?: string | null
  attempts: number
  failures: number
  cancelRequested: boolean
  lastErrorCode?: string | null
  createdAt: string
  computer?: { enabled?: boolean; ttlMinutes?: number } | null
}

const STATUS_COLOR: Record<string, string> = {
  queued: 'text-[var(--warning)]', processing: 'text-sky-300', succeeded: 'text-[var(--success)]',
  dead_letter: 'text-[var(--danger)]', cancelled: 'text-[var(--ink-muted)]', running: 'text-sky-300',
  completed: 'text-[var(--success)]', failed: 'text-[var(--danger)]',
}

export function TaskQueueList({
  tasks, selectedId, onSelect, onCancel, emptyHint,
}: {
  tasks: BotTask[]
  selectedId?: string | null
  onSelect: (task: BotTask) => void
  onCancel: (id: string) => void
  emptyHint?: string
}) {
  return (
    <div className="max-h-[480px] space-y-1.5 overflow-y-auto">
      {tasks.length === 0 && <div className="text-xs text-[var(--ink-muted)]">{emptyHint || 'No bot tasks yet.'}</div>}
      {tasks.map((t) => (
        <div key={t.id} onClick={() => onSelect(t)} className={`cursor-pointer rounded-lg px-3 py-2 ring-1 transition ${selectedId === t.id ? 'bg-[var(--accent-soft)] ring-[var(--accent-soft-border)]' : 'bg-[var(--bg-tint)] ring-[var(--border-subtle)] hover:ring-[var(--border-strong)]'}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm">{t.kind === 'teach' ? '🎓 ' : ''}{t.goal.slice(0, 90)}</div>
            <div className="flex items-center gap-1.5">
              {t.schedule && <span className="text-3xs text-[var(--ink-muted)]">↻ {t.schedule}</span>}
              {t.computer?.enabled && <MonitorPlay size={11} className="text-[var(--accent-text)] opacity-80" />}
              <span className={`text-2xs font-medium ${STATUS_COLOR[t.status] || 'text-[var(--ink-secondary)]'}`}>{t.status}</span>
              {(t.status === 'queued' || t.status === 'processing') && (
                <button onClick={(e) => { e.stopPropagation(); onCancel(t.id) }} className="text-[var(--ink-muted)] hover:text-[var(--danger)]"><XCircle size={14} /></button>
              )}
            </div>
          </div>
          <div className="mt-0.5 text-2xs text-[var(--ink-muted)]">
            attempts {t.attempts} · failures {t.failures}{t.lastErrorCode ? ` · ${t.lastErrorCode}` : ''} · {new Date(t.createdAt).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  )
}