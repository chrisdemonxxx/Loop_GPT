'use client'

import { useEffect, useState } from 'react'
import { btnGhost, btnPrimary, useFocusTrap } from '@loop/ui'
import type { CheckpointView } from '@loop/loopit-client'

export type CheckpointAction = { kind: 'deploy' | 'rollback' | 'fork'; checkpoint: CheckpointView }

const COPY: Record<CheckpointAction['kind'], { title: string; confirm: string; destructive: boolean }> = {
  deploy: { title: 'Deploy this checkpoint?', confirm: 'Deploy', destructive: true },
  rollback: { title: 'Roll back to this checkpoint?', confirm: 'Roll back', destructive: true },
  fork: { title: 'Fork this checkpoint?', confirm: 'Fork', destructive: false },
}

export function CheckpointDialog({
  action,
  busy,
  onCancel,
  onConfirm,
}: {
  action: CheckpointAction | null
  busy: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}) {
  const open = action !== null
  const ref = useFocusTrap<HTMLDivElement>(open)
  const [reason, setReason] = useState('Promoted from the build page')
  useEffect(() => {
    if (!open) return
    setReason('Promoted from the build page')
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel, action?.checkpoint.checkpoint_id])

  if (!action) return null
  const copy = COPY[action.kind]
  const needsReason = action.kind === 'deploy'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="checkpoint-action-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-panel)] p-5 outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="checkpoint-action-title" className="text-sm font-semibold">{copy.title}</h2>
        <p className="mt-2 text-sm text-[var(--ink-secondary)]">
          Target <code className="text-[var(--ink-primary)]">{action.checkpoint.label ?? action.checkpoint.checkpoint_id}</code>.
          This runs only after you confirm.
        </p>
        {needsReason && (
          <label className="mt-3 block text-xs text-[var(--ink-muted)]">
            Reason
            <textarea
              className="mt-1 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-sunken)] px-3 py-2 text-sm text-[var(--ink-primary)]"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={copy.destructive
              ? 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-medium text-white bg-[var(--danger)] disabled:opacity-40'
              : btnPrimary}
            disabled={busy || (needsReason && !reason.trim())}
            onClick={() => onConfirm(reason.trim())}
          >
            {busy ? 'Working…' : copy.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
