'use client'

import { useEffect, useState } from 'react'
import { ConfirmDialog, textareaCls } from '@loop/ui'
import type { CheckpointAction } from './hooks'

export type { CheckpointAction } from './hooks'

const COPY: Record<CheckpointAction['kind'], { title: string; confirm: string; destructive: boolean }> = {
  deploy: { title: 'Deploy this checkpoint?', confirm: 'Deploy', destructive: true },
  rollback: { title: 'Roll back to this checkpoint?', confirm: 'Roll back', destructive: true },
  fork: { title: 'Fork this checkpoint?', confirm: 'Fork', destructive: false },
}

const DEFAULT_REASON = 'Promoted from the build page'

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
  const [reason, setReason] = useState(DEFAULT_REASON)
  useEffect(() => {
    if (action) setReason(DEFAULT_REASON)
  }, [action?.kind, action?.checkpoint.checkpoint_id])

  const copy = action ? COPY[action.kind] : COPY.fork
  const needsReason = action?.kind === 'deploy'
  return (
    <ConfirmDialog
      open={action !== null}
      title={copy.title}
      tone={copy.destructive ? 'danger' : 'default'}
      confirmLabel={copy.confirm}
      busy={busy}
      confirmDisabled={needsReason && !reason.trim()}
      onCancel={onCancel}
      onConfirm={() => onConfirm(reason.trim())}
      body={action && (
        <>
          Target <code className="text-[var(--ink-primary)]">{action.checkpoint.label ?? action.checkpoint.checkpoint_id}</code>.
          {' '}This runs only after you confirm.
        </>
      )}
    >
      {needsReason && (
        <label className="mt-3 block text-ui-xs text-[var(--ink-muted)]">
          Reason
          <textarea
            className={`${textareaCls} mt-1`}
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      )}
    </ConfirmDialog>
  )
}
