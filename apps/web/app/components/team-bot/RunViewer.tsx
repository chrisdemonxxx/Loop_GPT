'use client'

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  X, Monitor, Loader2, AlertCircle, Terminal, Bot,
} from 'lucide-react'
import { panelRight, sheetBottom } from '../../lib/motion'
import { useRunStream } from './useRunStream'
import { LineRender } from './LineRender'
import { ComputerPane } from './ComputerPane'

/**
 * team-bot run viewer (sand's composition root): live trace + the dedicated
 * computer's noVNC view with the takeover handshake. Right-dock on desktop,
 * bottom sheet on mobile — ONE shell mounted at a time (the old dual-mount
 * kept a hidden duplicate computer iframe streaming in the background).
 */
export default function RunViewer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { task, runId, events, live, computer, setComputer, loadError } = useRunStream(taskId)
  const [tab, setTab] = useState<'trace' | 'computer'>('trace')

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
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
        <Bot size={15} className="text-[var(--accent-text)] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-slate-100 truncate">{task?.goal || 'Loop Bot run'}</div>
          <div className="text-[11px] text-slate-500 flex items-center gap-2">
            {live ? <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> running</span>
              : task?.runs?.[0] ? <span>{task.runs[0].status}</span> : null}
            {computer?.minutes != null && <span>{computer.minutes} VM min</span>}
            {task?.kind === 'scheduled' && <span>every {task.schedule}</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close run viewer" className="p-1.5 rounded-lg text-slate-400 hover:bg-white/[0.06]">
          <X size={16} />
        </button>
      </div>

      {/* Tabs (computer only when one exists) */}
      <div className="shrink-0 flex border-b border-white/[0.06] text-[12px]">
        {(['trace', ...(computer ? ['computer' as const] : [])] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id as 'trace' | 'computer')}
            className={`flex-1 py-2 capitalize transition ${tab === id ? 'text-slate-100 border-b-2 border-[var(--accent)]' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {id === 'computer' ? <span className="inline-flex items-center gap-1"><Monitor size={11} /> Computer</span> : <span className="inline-flex items-center gap-1"><Terminal size={11} /> Trace</span>}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="m-3 flex items-center gap-2 rounded-lg border border-rose-400/25 bg-rose-500/[0.07] px-3 py-2 text-[12px] text-rose-200">
          <AlertCircle size={13} className="shrink-0" /> {loadError}
        </div>
      )}

      {tab === 'trace' && <LineRender events={events} attaching={!loadError} />}

      {tab === 'computer' && computer && (
        <ComputerPane runId={runId} computer={computer} setComputer={setComputer} />
      )}
    </div>
  )

  return isDesktop ? (
    <motion.div
      variants={panelRight} initial="initial" animate="animate" exit="exit"
      className="relative flex flex-col w-[460px] max-w-[92vw] h-dvh fixed right-0 top-0 z-40 glass-strong border-l border-white/[0.08] shadow-panel"
    >
      {content}
    </motion.div>
  ) : (
    <motion.div
      variants={sheetBottom} initial="initial" animate="animate" exit="exit"
      className="relative flex flex-col h-[88dvh] fixed inset-x-0 bottom-0 z-40 glass-strong rounded-t-2xl border-t border-white/[0.08] shadow-panel"
    >
      <div className="mx-auto mt-2 mb-1 w-9 h-1 rounded-full bg-white/[0.14] shrink-0" aria-hidden />
      {content}
    </motion.div>
  )
}