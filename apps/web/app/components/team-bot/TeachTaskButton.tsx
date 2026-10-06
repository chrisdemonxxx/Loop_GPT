'use client'

import { useRef, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Circle, Square, Loader2, GraduationCap, AlertCircle } from 'lucide-react'
import type { TeachSessionState } from './useTeachSession'

/**
 * The Grok Bot "⏺ Teach a task" pill, top-right of the agent page:
 *  - idle: red-dot record button; click opens the tiny goal popover
 *  - starting/waiting: progress state (computer booting / "take over to demo")
 *  - recording: becomes the STOP button — the session is recording the
 *    operator's demonstration live on the agent's computer
 *  - distilling/done: writing the skill → confirmation
 */
export function TeachTaskButton({ session }: { session: TeachSessionState }) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Close the goal popover on click-away / Escape.
  useEffect(() => {
    if (!popoverOpen) return
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPopoverOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopoverOpen(false) }
    document.addEventListener('mousedown', onPointer, true)
    document.addEventListener('touchstart', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer, true)
      document.removeEventListener('touchstart', onPointer, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [popoverOpen])

  const begin = async () => {
    if (!goal.trim() || busy) return
    setBusy(true)
    try {
      await session.start(goal.trim())
      setPopoverOpen(false)
      setGoal('')
    } finally {
      setBusy(false)
    }
  }

  const { phase, frames, error } = session

  // ── Live session states (no popover) ───────────────────────────────────────
  if (phase === 'starting' || phase === 'waiting') {
    return (
      <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium text-rose-200 bg-rose-500/15 ring-1 ring-rose-400/25">
        <Loader2 size={14} className="animate-spin" />
        {phase === 'starting' ? 'Booting the computer…' : 'Waiting — take over the computer to demonstrate'}
      </div>
    )
  }
  if (phase === 'recording') {
    return (
      <button
        type="button"
        onClick={() => void session.stop()}
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium text-white bg-rose-600 hover:bg-rose-500 transition shadow-[0_2px_14px_-2px_rgba(225,29,72,0.5)]"
        title="Release the computer — the bot converts the recording into a skill"
      >
        <Square size={12} className="fill-current" />
        Stop · {frames} frame{frames === 1 ? '' : 's'}
      </button>
    )
  }
  if (phase === 'distilling') {
    return (
      <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium text-[#e79d7f] bg-[#c96442]/15 ring-1 ring-[#c96442]/25">
        <Loader2 size={14} className="animate-spin" />
        Converting the demo into a skill…
      </div>
    )
  }
  if (phase === 'done') {
    return (
      <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium text-emerald-200 bg-emerald-500/15 ring-1 ring-emerald-400/25">
        <GraduationCap size={14} />
        Skill ready — it&apos;s in your Library
      </div>
    )
  }
  if (phase === 'failed') {
    return (
      <button
        type="button"
        onClick={session.reset}
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium text-rose-200 bg-rose-500/15 ring-1 ring-rose-400/25"
        title={error || 'The teach session failed'}
      >
        <AlertCircle size={14} />
        {error || 'Teach failed'} — retry
      </button>
    )
  }

  // ── Idle: the record button + the tiny goal popover ────────────────────────
  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setPopoverOpen((v) => !v)}
        className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-[13px] font-medium text-slate-200 bg-white/[0.07] ring-1 ring-white/10 hover:bg-white/[0.12] transition"
        title="Record yourself doing a task on the bot's computer — it becomes a reusable skill"
      >
        <Circle size={11} className="fill-rose-500 text-rose-500" />
        Teach a task
      </button>

      <AnimatePresence>
        {popoverOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute right-0 top-full mt-2 z-30 w-80 glass-strong rounded-xl border border-white/[0.08] shadow-panel p-3.5"
            role="dialog"
            aria-label="Teach a task"
          >
            <div className="text-[13px] font-medium text-slate-100 mb-1">What should the bot learn?</div>
            <div className="text-[11.5px] text-slate-500 mb-2.5">
              Its computer boots and starts recording. You drive it through the task once; stop, and it becomes a one-click skill.
            </div>
            <textarea
              ref={inputRef}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void begin() } }}
              rows={2}
              autoFocus
              placeholder="e.g. Search the MA corporations registry and extract the company status"
              className="w-full rounded-lg border border-white/10 bg-[#14141f] px-3 py-2 text-[13px] text-slate-200 placeholder:text-slate-600 focus:border-[#c96442] focus:outline-none resize-none"
            />
            <div className="mt-2.5 flex justify-end gap-2">
              <button type="button" onClick={() => setPopoverOpen(false)} className="px-3 py-1.5 rounded-lg text-[12.5px] text-slate-300 hover:bg-white/[0.06] transition">Cancel</button>
              <button
                type="button"
                onClick={() => void begin()}
                disabled={!goal.trim() || busy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-white bg-rose-600 hover:bg-rose-500 transition disabled:opacity-40"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Circle size={10} className="fill-current" />}
                Start recording
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}