'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { btnGhost, btnOutline, btnPrimary } from '@loop/ui'
import { toUserFacingError, type PendingReview } from '@loop/loopit-client'
import { useToast } from '../lib/toast'
import { DiffView, FileChangeChips } from './DiffView'
import {
  useApplyReview,
  useBuildNotifications,
  useDismissReview,
  useMarkNotificationsRead,
  usePendingReviews,
} from './hooks'

/** Notifications badge + pending Apply-changes reviews (Phase 2.9). */
export function NotificationsBell() {
  const toast = useToast()
  const notes = useBuildNotifications()
  const reviews = usePendingReviews()
  const markRead = useMarkNotificationsRead()
  const apply = useApplyReview()
  const dismiss = useDismissReview()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<PendingReview | null>(null)
  const unread = notes.data?.unread_count ?? 0
  const pending = reviews.data ?? []

  return (
    <div className="relative">
      <button
        type="button"
        className={`${btnGhost} relative`}
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        onClick={() => {
          setOpen((prev) => !prev)
          if (!open && unread > 0) markRead.mutate(null)
        }}
      >
        <Bell size={14} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-[var(--accent-fg,white)]">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-overlay)] p-3 shadow-lg">
          <div className="flex items-center justify-between gap-2">
            <p className="text-ui-xs font-medium text-[var(--ink-primary)]">Notifications</p>
            <button type="button" className="text-3xs text-[var(--ink-muted)]" onClick={() => setOpen(false)}>Close</button>
          </div>
          {pending.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-3xs font-medium uppercase tracking-wide text-[var(--ink-muted)]">Apply changes</p>
              {pending.map((review) => (
                <button
                  key={review.review_id}
                  type="button"
                  className="w-full rounded-lg border border-[var(--accent-soft-border)] bg-[var(--accent-soft)] px-3 py-2 text-left"
                  onClick={() => setActive(review)}
                >
                  <p className="text-ui-xs font-medium text-[var(--accent-text)]">{review.title || 'Background build ready'}</p>
                  <p className="mt-0.5 text-3xs text-[var(--ink-secondary)]">
                    {(review.file_changes?.length ?? 0)} file{(review.file_changes?.length ?? 0) === 1 ? '' : 's'} · review before merging
                  </p>
                </button>
              ))}
            </div>
          )}
          <div className="mt-3 max-h-48 space-y-2 overflow-auto">
            {(notes.data?.notifications ?? []).slice(0, 8).map((note) => (
              <div key={note.notification_id} className="rounded-lg border border-[var(--border-subtle)] px-2.5 py-2">
                <p className="text-ui-xs text-[var(--ink-primary)]">{note.title}</p>
                <p className="mt-0.5 text-3xs text-[var(--ink-muted)]">{note.body}</p>
                {note.run_id && (
                  <Link
                    href={`/build/?run=${encodeURIComponent(note.run_id)}`}
                    className="mt-1 inline-block text-3xs text-[var(--accent-text)]"
                    onClick={() => setOpen(false)}
                  >
                    Open run
                  </Link>
                )}
              </div>
            ))}
            {!pending.length && !(notes.data?.notifications?.length) && (
              <p className="text-3xs text-[var(--ink-muted)]">No notifications yet.</p>
            )}
          </div>
        </div>
      )}
      {active && (
        <ApplyReviewModal
          review={active}
          busy={apply.isPending || dismiss.isPending}
          onClose={() => setActive(null)}
          onApply={() => {
            apply.mutate(active.review_id, {
              onSuccess: () => {
                toast.push('success', 'Changes applied to the main version line')
                setActive(null)
                setOpen(false)
              },
              onError: (cause) => toast.push('error', toUserFacingError(cause).message),
            })
          }}
          onDismiss={() => {
            dismiss.mutate(active.review_id, {
              onSuccess: () => {
                toast.push('success', 'Background build dismissed')
                setActive(null)
              },
              onError: (cause) => toast.push('error', toUserFacingError(cause).message),
            })
          }}
        />
      )}
    </div>
  )
}

function ApplyReviewModal({
  review,
  busy,
  onClose,
  onApply,
  onDismiss,
}: {
  review: PendingReview
  busy: boolean
  onClose: () => void
  onApply: () => void
  onDismiss: () => void
}) {
  const [selected, setSelected] = useState(review.file_changes?.[0] ?? null)
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-overlay)] shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
          <div>
            <h2 className="text-ui-sm font-medium text-[var(--ink-primary)]">Apply changes</h2>
            <p className="mt-0.5 text-ui-xs text-[var(--ink-secondary)]">
              Review the background build diff, then merge into the main checkpoint line.
            </p>
          </div>
          <button type="button" className={btnGhost} onClick={onClose}>Close</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <FileChangeChips
            changes={review.file_changes ?? []}
            onOpen={(change) => setSelected(change)}
          />
          {selected?.diff && (
            <div className="mt-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-sunken)]">
              <DiffView diff={selected.diff} />
            </div>
          )}
          {!review.file_changes?.length && (
            <p className="text-ui-xs text-[var(--ink-muted)]">No file diffs recorded for this review.</p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
          <button type="button" className={btnOutline} disabled={busy} onClick={onDismiss}>Dismiss</button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={onApply}>
            {busy ? 'Working…' : 'Apply changes'}
          </button>
        </div>
      </div>
    </div>
  )
}
