'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Loader2, AlertCircle, Bot } from 'lucide-react'
import { panelRight, sheetBottom } from '../../lib/motion'
import { useRunStream } from './useRunStream'
import { LineRender } from './LineRender'

/**
 * team-bot run trace viewer: the task's event timeline (thought → tool call →
 * result → outcome), right-dock on desktop, bottom sheet on mobile.
 *
 * Grok-parity note: there is exactly ONE computer surface in the product —
 * the profile panel's Computer tab (embedded) and its full-window expansion.
 * The trace viewer deliberately has no Computer tab: a second noVNC surface
 * per run was the "two layers" bug — two iframes, two auth keys, two states.
 * "Watch" in the chat opens the single computer surface; this dock is the
 * run's written record.
 */
export default function RunViewer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { task, events, live, loadError } = useRunStream(taskId)

  // Single shell: dock on ≥640px, sheet below — never both mounted.
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const mq = window.matchMedia('(min-width: 640px)')
    const apply = () => setIsDesktop(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const content = (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
        <Bot size={15} className="text-[var(--accent-text)] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-ui-sm font-medium text-[var(--ink-primary)] truncate">{task?.goal || 'Loop Bot run'}</div>
          <div className="text-2xs text-[var(--ink-muted)] flex items-center gap-2">
            {live ? <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> running</span>
              : task?.runs?.[0] ? <span>{task.runs[0].status}</span> : null}
            {task?.kind === 'scheduled' && <span>every {task.schedule}</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close trace viewer" className="p-1.5 rounded-lg text-[var(--ink-secondary)] hover:bg-[var(--bg-hover)]">
          <X size={16} />
        </button>
      </div>

      {loadError && (
        <div className="m-3 flex items-center gap-2 rounded-lg border border-[var(--danger-soft-border)] bg-[var(--danger-soft)] px-3 py-2 text-ui-xs text-[var(--danger)]">
          <AlertCircle size={13} className="shrink-0" /> {loadError}
        </div>
      )}

      <LineRender events={events} attaching={!loadError} />
    </div>
  )

  return isDesktop ? (
    <motion.div
      variants={panelRight} initial="initial" animate="animate" exit="exit"
      className="relative flex flex-col w-[460px] max-w-[92vw] h-dvh fixed right-0 top-0 z-40 glass-strong border-l border-[var(--border-subtle)] shadow-panel"
    >
      {content}
    </motion.div>
  ) : (
    <motion.div
      variants={sheetBottom} initial="initial" animate="animate" exit="exit"
      className="relative flex flex-col h-[88dvh] fixed inset-x-0 bottom-0 z-40 glass-strong rounded-t-2xl border-t border-[var(--border-subtle)] shadow-panel"
    >
      <div className="mx-auto mt-2 mb-1 w-9 h-1 rounded-full bg-[var(--bg-hover-strong)] shrink-0" aria-hidden />
      {content}
    </motion.div>
  )
}
