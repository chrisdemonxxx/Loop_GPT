'use client'

import Link from 'next/link'
import { Plus } from 'lucide-react'
import { Badge } from '@loop/ui'
import { runTitle, type RunSummary } from '@loop/loopit-client'
import { useBuildRuns } from './hooks'
import { formatWhen, statusLabel, statusTone } from './status'

/** This user's builds. New build opens the prompt; a row opens that run's chat. */
export function BuildSessionRail({ activeRunId }: { activeRunId: string | null }) {
  const runs = useBuildRuns()
  const list = runs.data ?? []
  const facing = runs.error ? 'Could not load builds.' : ''

  return (
    <aside aria-label="Builds" className="flex w-full md:w-60 shrink-0 flex-col border-b md:border-b-0 md:border-r border-[var(--border-subtle)] bg-[var(--bg-sunken)] max-md:max-h-52">
      <div className="p-2 shrink-0">
        <Link
          href="/build"
          aria-current={activeRunId ? undefined : 'page'}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-tint)] px-2.5 py-1.5 text-ui-xs font-medium text-[var(--ink-secondary)] hover:border-[var(--accent-soft-border)] hover:text-[var(--accent-text)] transition"
        >
          <Plus size={13} aria-hidden /> New build
        </Link>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
        {runs.isPending && <p className="px-2 py-3 text-ui-xs text-[var(--ink-muted)]">Loading builds…</p>}
        {runs.isError && (
          <div className="px-2 py-3 text-ui-xs text-[var(--danger)]" role="alert">
            {facing}
            <button type="button" onClick={() => { void runs.refetch() }} className="ml-2 text-[var(--accent-text)] hover:underline">Retry</button>
          </div>
        )}
        {runs.isSuccess && list.length === 0 && (
          <p className="px-2 py-3 text-ui-xs text-[var(--ink-muted)]">No builds yet.</p>
        )}
        {list.map((run) => (
          <BuildSessionRow key={run.run_id} run={run} active={run.run_id === activeRunId} />
        ))}
      </div>
    </aside>
  )
}

function BuildSessionRow({ run, active }: { run: RunSummary; active: boolean }) {
  return (
    <Link
      href={`/build/?run=${encodeURIComponent(run.run_id)}`}
      aria-current={active ? 'page' : undefined}
      className={`block rounded-lg px-2 py-1.5 ${active ? 'bg-[var(--bg-hover-strong)]' : 'hover:bg-[var(--bg-hover)]'}`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className={`min-w-0 line-clamp-2 text-ui-xs ${active ? 'font-medium text-[var(--ink-primary)]' : 'text-[var(--ink-secondary)]'}`}>{runTitle(run)}</span>
        <Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
      </span>
      <span className="mt-0.5 block text-3xs text-[var(--ink-muted)]">{formatWhen(run.started_at)}</span>
    </Link>
  )
}
