'use client'

/**
 * Preview, workspace, and plan panes.
 * Desktop keeps the side-by-side layout. On a phone the plan (tasks, progress,
 * versions) is a third pane so rollback stays reachable.
 */

import { useState, type ReactNode } from 'react'
import { ListChecks, MessageSquare, Monitor } from 'lucide-react'

export type MobileBuildPane = 'preview' | 'workspace' | 'plan'

export function MobileBuildSplit({
  preview,
  chat,
  sidebar,
}: {
  preview: ReactNode
  chat: ReactNode
  /** Plan, progress, and versions. Desktop rail; a phone pane when present. */
  sidebar?: ReactNode
}) {
  const [pane, setPane] = useState<MobileBuildPane>('preview')

  return (
    <>
      <div className="mt-4 md:hidden">
        <div className="mb-2 flex gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-0.5" role="tablist" aria-label="Build panes">
          <MobilePaneTab active={pane === 'preview'} onClick={() => setPane('preview')} icon={Monitor} label="Preview" />
          <MobilePaneTab active={pane === 'workspace'} onClick={() => setPane('workspace')} icon={MessageSquare} label="Workspace" />
          {sidebar ? <MobilePaneTab active={pane === 'plan'} onClick={() => setPane('plan')} icon={ListChecks} label="Plan" /> : null}
        </div>
      </div>

      <div className="mt-4 md:grid md:gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        {sidebar ? (
          <div className={`space-y-4 min-w-0 order-2 xl:order-1 ${pane === 'plan' ? 'block' : 'hidden'} md:block`}>{sidebar}</div>
        ) : null}
        <div className={`min-w-0 ${sidebar ? 'order-1 xl:order-2' : ''} ${pane === 'preview' ? 'block' : 'hidden'} md:block`}>{preview}</div>
      </div>
      <div className={`${pane === 'workspace' ? 'block' : 'hidden'} md:block`}>{chat}</div>
    </>
  )
}

function MobilePaneTab({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: typeof Monitor
  label: string
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-2xs font-medium transition ${
        active ? 'bg-[var(--bg-overlay)] text-[var(--accent-text)] shadow-sm' : 'text-[var(--ink-muted)]'
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  )
}
