'use client'

/**
 * Phase 3.5 — responsive preview/chat split for PWA and small screens.
 * Desktop keeps the existing grid; mobile shows Preview | Chat tabs so the
 * parallel Monaco/PTY work can keep owning PreviewWorkspace chrome.
 */

import { useState, type ReactNode } from 'react'
import { MessageSquare, Monitor } from 'lucide-react'

export type MobileBuildPane = 'preview' | 'chat'

export function MobileBuildSplit({
  preview,
  chat,
  sidebar,
}: {
  preview: ReactNode
  chat: ReactNode
  /** Optional left rail (tasks / activity) — desktop only. */
  sidebar?: ReactNode
}) {
  const [pane, setPane] = useState<MobileBuildPane>('preview')

  return (
    <>
      {/* Mobile: Preview | Chat tabs */}
      <div className="mt-4 md:hidden">
        <div className="mb-2 flex gap-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-0.5" role="tablist" aria-label="Build panes">
          <MobilePaneTab active={pane === 'preview'} onClick={() => setPane('preview')} icon={Monitor} label="Preview" />
          <MobilePaneTab active={pane === 'chat'} onClick={() => setPane('chat')} icon={MessageSquare} label="Chat" />
        </div>
        <div className={pane === 'preview' ? 'block' : 'hidden'}>{preview}</div>
        <div className={pane === 'chat' ? 'block' : 'hidden'}>{chat}</div>
      </div>

      {/* Desktop / tablet: original split */}
      <div className="mt-4 hidden gap-4 md:grid xl:grid-cols-[340px_minmax(0,1fr)]">
        {sidebar ? <div className="space-y-4 min-w-0 order-2 xl:order-1">{sidebar}</div> : null}
        <div className={`min-w-0 ${sidebar ? 'order-1 xl:order-2' : ''}`}>{preview}</div>
      </div>
      <div className="hidden md:block">{chat}</div>
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
