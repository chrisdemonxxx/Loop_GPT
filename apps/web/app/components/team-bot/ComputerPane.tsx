'use client'

import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Hand, Loader2 } from 'lucide-react'
import { setBotTakeover } from '../../lib/bot'
import type { BotComputer } from '../../lib/bot'
import { scrim as scrimVariant } from '../../lib/motion'

/**
 * team-bot computer pane (sand's computer-screen-preview + takeover
 * handshake): sandbox metadata bar, takeover banner, the noVNC stream, and
 * the always-confirm takeover dialog.
 */
export function ComputerPane({
  runId, computer, setComputer,
}: {
  runId: string | null
  computer: BotComputer
  setComputer: React.Dispatch<React.SetStateAction<BotComputer | null>>
}) {
  const [confirmTakeover, setConfirmTakeover] = useState(false)
  const [takeoverBusy, setTakeoverBusy] = useState(false)

  const takeover = async (seize: boolean) => {
    if (!runId) return
    setTakeoverBusy(true)
    try {
      const r = await setBotTakeover(runId, seize)
      setComputer((cur) => cur ? { ...cur, takeoverRequested: r.takeoverRequested, interactiveUrl: r.interactiveUrl } : cur)
      setConfirmTakeover(false)
    } finally {
      setTakeoverBusy(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 text-[11px] text-slate-500 border-b border-white/[0.06]">
        <span className={`w-1.5 h-1.5 rounded-full ${computer.active ? 'bg-emerald-400' : 'bg-slate-600'}`} aria-hidden />
        <span className="font-mono truncate">{computer.sandboxId}</span>
        {computer.minutes != null && <span className="ml-auto tabular-nums">{computer.minutes} min</span>}
        {computer.active && !computer.takeoverRequested && (
          <button
            type="button"
            onClick={() => setConfirmTakeover(true)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.05] text-slate-200 hover:bg-white/[0.09] transition"
          >
            <Hand size={11} /> Take over
          </button>
        )}
      </div>

      {computer.takeoverRequested && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-400/20 text-[12px] text-amber-200">
          <Hand size={12} className="shrink-0" />
          <span className="flex-1">You&apos;re driving — the agent is paused.</span>
          <button type="button" onClick={() => void takeover(false)} disabled={takeoverBusy} className="px-2 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 transition">
            Release
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 bg-black">
        {computer.viewUrl ? (
          <iframe
            src={(computer.takeoverRequested && computer.interactiveUrl) || computer.viewUrl}
            title="Loop Bot computer"
            className="w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="h-full flex items-center justify-center text-slate-600 text-[12px]">stream unavailable</div>
        )}
      </div>

      {/* Takeover confirmation (product decision: always confirm) */}
      <AnimatePresence>
        {confirmTakeover && (
          <motion.div variants={scrimVariant} initial="initial" animate="animate" exit="exit"
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-4"
            onClick={() => setConfirmTakeover(false)}>
            <motion.div
              role="alertdialog" aria-modal="true" aria-label="Take over the computer"
              initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="glass-strong rounded-xl border border-white/[0.08] shadow-panel p-4 w-full max-w-xs"
              onClick={(e) => e.stopPropagation()}>
              <div className="text-[14px] font-medium text-slate-100">Take the wheel?</div>
              <p className="mt-1 text-[12.5px] text-slate-500">The agent pauses while you drive its computer. Release anytime — it auto-releases after 10 minutes.</p>
              <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirmTakeover(false)} className="px-3 py-1.5 rounded-lg text-[12.5px] text-slate-300 hover:bg-white/[0.06] transition">Cancel</button>
                <button
                  type="button"
                  onClick={() => void takeover(true)}
                  disabled={takeoverBusy}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition disabled:opacity-50"
                >
                  {takeoverBusy ? <Loader2 size={12} className="animate-spin" /> : <Hand size={12} />} Take over
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}