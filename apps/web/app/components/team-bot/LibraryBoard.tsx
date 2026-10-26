'use client'

import { useState, type ReactNode } from 'react'

export interface LibraryCard {
  id: string
  kind: 'page' | 'file' | 'app' | 'skill'
  name: string
  path: string
  shareUrl?: string | null
}

const TABS = ['Skills', 'Pages', 'Files', 'Apps'] as const

export function LibraryBoard({
  skills,
  items,
  onShare,
  onRevoke,
}: {
  skills: ReactNode
  items: LibraryCard[]
  onShare: (id: string) => void
  onRevoke: (id: string) => void
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Skills')
  const kind = tab === 'Pages' ? 'page' : tab === 'Files' ? 'file' : tab === 'Apps' ? 'app' : null
  const shown = kind ? items.filter((item) => item.kind === kind) : []
  return (
    <div>
      <div role="tablist" className="mb-3 flex gap-1">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={`rounded-lg px-2 py-1 text-ui-xs ${tab === name ? 'bg-[var(--bg-hover-strong)] text-[var(--ink-primary)]' : 'text-[var(--ink-muted)]'}`}
          >
            {name}
          </button>
        ))}
      </div>
      {tab === 'Skills' ? skills : (
        <ul className="space-y-2">
          {shown.map((item) => (
            <li key={item.id} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tint)] p-2.5">
              <div className="text-ui-sm text-[var(--ink-primary)]">{item.name}</div>
              <div className="text-3xs text-[var(--ink-muted)]">{item.path}</div>
              <div className="mt-1.5 flex gap-2">
                <button type="button" onClick={() => onShare(item.id)} className="text-2xs text-[var(--accent-text)]">Share {item.name}</button>
                {item.shareUrl && (
                  <button type="button" onClick={() => onRevoke(item.id)} className="text-2xs text-[var(--ink-muted)]">Revoke {item.name} link</button>
                )}
              </div>
            </li>
          ))}
          {shown.length === 0 && <li className="text-ui-xs text-[var(--ink-muted)]">Nothing here yet.</li>}
        </ul>
      )}
    </div>
  )
}
