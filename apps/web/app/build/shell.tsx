'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { btnGhost, btnPrimary } from '@loop/ui'
import type { UserFacingError } from '@loop/loopit-client'

export function BuildShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[var(--bg-base)] text-[var(--ink-primary)]">
      <header className="border-b border-[var(--border-subtle)] bg-[var(--bg-raised)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link href="/build" className="text-sm font-semibold">Build</Link>
          <Link href="/chat" className={btnGhost}>Chat</Link>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </div>
  )
}

export function ErrorNotice({ error, onRetry }: { error: UserFacingError; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-panel)] p-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <p className="text-sm font-medium">{error.title}</p>
        <p className="mt-1 text-sm text-[var(--ink-secondary)]">{error.message}</p>
        <p className="mt-1 text-xs text-[var(--ink-muted)]">{error.action}</p>
      </div>
      <div className="flex gap-2 shrink-0">
        {error.kind === 'auth' && <Link href="/login" className={btnPrimary}>Sign in</Link>}
        {onRetry && <button type="button" className={btnGhost} onClick={onRetry}>Retry</button>}
      </div>
    </div>
  )
}
