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
  queued: 'text-amber-300', processing: 'text-sky-300', succeeded: 'text-emerald-300',
  dead_letter: 'text-rose-400', cancelled: 'text-slate-500', running: 'text-sky-300',
  completed: 'text-emerald-300', failed: 'text-rose-400',
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
      {tasks.length === 0 && <div className="text-xs text-slate-500">{emptyHint || 'No bot tasks yet.'}</div>}
      {tasks.map((t) => (
        <div key={t.id} onClick={() => onSelect(t)} className={`cursor-pointer rounded-lg px-3 py-2 ring-1 transition ${selectedId === t.id ? 'bg-violet-500/10 ring-violet-500/50' : 'bg-slate-900/50 ring-slate-800 hover:ring-slate-700'}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="truncate text-sm">{t.kind === 'teach' ? '🎓 ' : ''}{t.goal.slice(0, 90)}</div>
            <div className="flex items-center gap-1.5">
              {t.schedule && <span className="text-[10px] text-slate-500">↻ {t.schedule}</span>}
              {t.computer?.enabled && <MonitorPlay size={11} className="text-violet-400/80" />}
              <span className={`text-[11px] font-medium ${STATUS_COLOR[t.status] || 'text-slate-400'}`}>{t.status}</span>
              {(t.status === 'queued' || t.status === 'processing') && (
                <button onClick={(e) => { e.stopPropagation(); onCancel(t.id) }} className="text-slate-500 hover:text-rose-400"><XCircle size={14} /></button>
              )}
            </div>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            attempts {t.attempts} · failures {t.failures}{t.lastErrorCode ? ` · ${t.lastErrorCode}` : ''} · {new Date(t.createdAt).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  )
}