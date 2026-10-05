'use client'

import { AnimatePresence, motion } from 'framer-motion'
import { Send, Square } from 'lucide-react'

/**
 * The composer's primary action — ONE morphing control, four states:
 *
 *   disabled  empty input: flat surface, muted icon, no glow (unmistakably off)
 *   ready     can send: brand accent + soft glow; hover lifts, press squashes
 *   running   stream live: morphs to the ■ stop glyph with a pulse ring
 *   queued    running + messages queued: stop state + count badge
 *
 * All colors come from the Phase-1 tokens (--accent*), so theming and the
 * light theme follow automatically — the old one-off #d76d4a ramp is gone.
 * Icons crossfade + rotate in 120ms; state color transitions 150–220ms.
 */
export type SendButtonState = 'disabled' | 'ready' | 'running' | 'queued'

export function sendButtonState(running: boolean, canSend: boolean, queuedCount: number): SendButtonState {
  if (running) return queuedCount > 0 ? 'queued' : 'running'
  return canSend ? 'ready' : 'disabled'
}

export function SendButton({
  running,
  canSend,
  queuedCount = 0,
  onStop,
}: {
  running: boolean
  canSend: boolean
  queuedCount?: number
  onStop: () => void
}) {
  const state = sendButtonState(running, canSend, queuedCount)
  const stopping = state === 'running' || state === 'queued'

  return (
    <motion.button
      type={stopping ? 'button' : 'submit'}
      onClick={stopping ? onStop : undefined}
      disabled={state === 'disabled'}
      title={stopping ? 'Stop' : 'Send'}
      aria-label={stopping ? 'Stop response' : 'Send message'}
      initial={false}
      animate={{ scale: 1 }}
      whileHover={state === 'ready' ? { y: -1 } : undefined}
      whileTap={state !== 'disabled' ? { scale: 0.92 } : undefined}
      transition={{ type: 'spring', stiffness: 500, damping: 26 }}
      className={[
        'tap-target relative w-9 h-9 flex items-center justify-center rounded-full transition-colors duration-150',
        state === 'disabled' && 'surface text-slate-600 cursor-not-allowed',
        state === 'ready' && 'text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)] shadow-[0_2px_14px_-2px_var(--accent-glow)]',
        stopping && 'surface border border-rose-400/30 text-slate-200 hover:text-rose-300 hover:border-rose-400/50',
      ].filter(Boolean).join(' ')}
    >
      {/* "Working" pulse ring — subtle terracotta, honors reduced-motion via
          the global animation kill-switch. */}
      {stopping && <span aria-hidden className="pulse-ring absolute inset-0 rounded-full" />}

      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={stopping ? 'stop' : 'send'}
          initial={{ opacity: 0, rotate: -90, scale: 0.8 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 90, scale: 0.8 }}
          transition={{ duration: 0.12, ease: 'easeOut' }}
          className="flex items-center justify-center"
        >
          {stopping ? <Square size={13} fill="currentColor" /> : <Send size={16} />}
        </motion.span>
      </AnimatePresence>

      {state === 'queued' && (
        <span
          aria-label={`${queuedCount} queued`}
          className="absolute -top-1 -right-1 min-w-4 h-4 px-0.5 rounded-full bg-[var(--accent)] text-white text-[10px] leading-4 font-semibold text-center shadow"
        >
          {queuedCount}
        </span>
      )}
    </motion.button>
  )
}
