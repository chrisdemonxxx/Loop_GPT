'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Monitor, Loader2, MousePointer2, Square, RefreshCw, Power, Maximize2, X, Circle, GraduationCap } from 'lucide-react'
import { getBotBox, BotApiError, type BotBox } from '../../lib/bot'
import type { TeachSession } from './useTeachSession'

/**
 * The agent's persistent computer, two presentations of the same stream:
 *
 *  - embedded (Computer tab in the profile panel): small live screen with an
 *    ⤢ expand button — Grok's "create bot" panel view.
 *  - expanded (onExpand → fixed overlay): the screen enlarges to fill the
 *    window with a smooth transition; header carries the "⏺ Teach a task"
 *    pill and the collapse ✕ — Grok's full-desktop view. Teach simply starts
 *    recording the human's workflow inside the computer (one click).
 */
export function AgentComputerTab({
  session,
  onExpand,
  expanded = false,
  onCollapse,
}: {
  session: TeachSession
  onExpand?: () => void
  expanded?: boolean
  onCollapse?: () => void
}) {
  const [box, setBox] = useState<BotBox | null>(null)
  const [booting, setBooting] = useState(false)
  const [error, setError] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const boot = useCallback(async () => {
    setBooting(true); setError('')
    try {
      const b = await getBotBox(session.phase === 'recording' || session.phase === 'waiting' ? 'teach' : 'default')
      setBox(b)
    } catch (err: any) {
      if (err instanceof BotApiError && err.status === 404) {
        setError('This backend does not have persistent boxes yet — the deployment is still rolling out. Retry in a minute.')
      } else if (err instanceof BotApiError && (err.status === 503 || /E2B/i.test(err.message || ''))) {
        setError('The computer provider is not configured on this deployment (E2B_API_KEY missing).')
      } else {
        setError(err?.message || 'Could not boot the bot computer.')
      }
    } finally {
      setBooting(false)
    }
  }, [session.phase])

  useEffect(() => {
    void boot()
    pollRef.current = setInterval(() => void boot(), 60_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [boot])

  const teachActive = session.phase === 'waiting' || session.phase === 'recording'
  const comp = session.computer
  const viewUrl = teachActive && comp?.viewUrl ? comp.viewUrl : box?.viewUrl || null
  const interactiveUrl = teachActive && comp?.interactiveUrl ? comp.interactiveUrl : (box?.interactiveUrl || null)
  // Embedded = watch (view-only); expanded = drive (interactive). During a
  // teach takeover the interactive layer always wins.
  const showInteractive =
    (teachActive && comp?.takeoverRequested && interactiveUrl) ||
    (!teachActive && expanded && interactiveUrl)
  const shownUrl = showInteractive ? interactiveUrl : viewUrl

  /** One click: boot the box and start recording the operator's workflow. */
  const startTeach = () => {
    void session.start('Watch the operator demonstrate a workflow on this computer and learn it as a reusable skill.')
  }

  const screen = (
    <>
      {/* Screen */}
      <div className="relative flex-1 min-h-0 bg-black">
        {shownUrl ? (
          <iframe
            key={shownUrl}
            src={shownUrl}
            title="Loop Bot computer"
            className="absolute inset-0 w-full h-full border-0"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center px-6">
            {booting ? (
              <>
                <LoadingDots />
                <p className="text-[13px] text-slate-400">{box?.resumed === false ? 'Starting desktop' : 'Waking the bot computer…'}</p>
              </>
            ) : error ? (
              <>
                <Monitor size={22} className="text-slate-600" />
                <p className="text-[13px] text-rose-300/90 max-w-sm">{error}</p>
                <button type="button" onClick={() => void boot()} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition">
                  <Power size={12} /> Boot the computer
                </button>
              </>
            ) : (
              <>
                <Monitor size={22} className="text-slate-600" />
                <p className="text-[13px] text-slate-400">The computer is off.</p>
                <button type="button" onClick={() => void boot()} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition">
                  <Power size={12} /> Boot the computer
                </button>
              </>
            )}
          </div>
        )}

        {/* Teach overlays */}
        {session.phase === 'waiting' && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent">
            <div className="flex items-center gap-3 rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-3.5 py-2.5">
              <MousePointer2 size={14} className="text-amber-300 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] text-amber-100">Ready when you are — take over and show the bot how it&apos;s done.</p>
                <p className="text-[11px] text-amber-200/60">It records your screen until you press Stop.</p>
              </div>
              <button type="button" onClick={() => void session.takeOver()} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-amber-600 hover:bg-amber-500 transition">
                <MousePointer2 size={12} /> Take over
              </button>
            </div>
          </div>
        )}
        {session.phase === 'recording' && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent">
            <div className="flex items-center gap-3 rounded-xl border border-rose-400/25 bg-rose-500/[0.08] px-3.5 py-2.5">
              <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse shrink-0" aria-hidden />
              <p className="flex-1 text-[12.5px] text-rose-100">Recording — drive the computer; the bot is watching.</p>
              <button type="button" onClick={() => void session.stop()} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-rose-600 hover:bg-rose-500 transition">
                <Square size={11} /> Stop
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Status strip */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-white/[0.06] text-[11px] text-slate-600 shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full ${box?.alive ? 'bg-emerald-400' : 'bg-slate-600'}`} aria-hidden />
        <span className="font-mono truncate">{box?.sandboxId ? `loop-bot-vm-${box.sandboxId.slice(0, 8)}` : 'loop-bot-vm'}</span>
        <span className="text-slate-700">·</span>
        <span>{box?.alive ? (box.resumed ? 'resumed' : 'always on') : booting ? 'booting…' : 'off'}</span>
        <span className="ml-auto font-mono text-slate-700">{box?.workspaceDir || '/workspace'}</span>
        <button type="button" onClick={() => void boot()} aria-label="Refresh the stream" className="p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-white/[0.06] transition">
          <RefreshCw size={12} />
        </button>
      </div>
    </>
  )

  // ── Expanded: full-window overlay with teach pill + collapse ──────────────
  if (expanded) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="fixed inset-0 z-50 flex flex-col bg-[#08080a]"
        role="dialog"
        aria-modal="true"
        aria-label="Loop Bot computer"
      >
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06] shrink-0">
          <Monitor size={15} className="text-slate-400" />
          <span className="text-[13px] font-medium text-slate-200">Loop Bot&apos;s computer</span>
          <div className="ml-auto flex items-center gap-2">
            <TeachPill session={session} onStart={startTeach} />
            <button
              type="button"
              onClick={onCollapse}
              aria-label="Shrink the computer view"
              className="p-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        {screen}
      </motion.div>
    )
  }

  // ── Embedded: small stream + expand button ─────────────────────────────────
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
        <span className="text-[11.5px] text-slate-400 font-medium">Its screen — live</span>
        <div className="ml-auto flex items-center gap-1">
          <TeachPill session={session} onStart={startTeach} compact />
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Enlarge the computer view"
              title="Enlarge"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-white/[0.06] transition"
            >
              <Maximize2 size={13} />
            </button>
          )}
        </div>
      </div>
      {screen}
    </div>
  )
}

/** The record-dot teach pill — one click starts recording, one click stops. */
function TeachPill({ session, onStart, compact = false }: { session: TeachSession; onStart: () => void; compact?: boolean }) {
  const { phase, frames, error } = session
  const base = compact ? 'px-2 py-1 text-[11px] gap-1' : 'px-3 py-1.5 text-[12.5px] gap-1.5'

  if (phase === 'starting' || phase === 'waiting') {
    return (
      <span className={`flex items-center rounded-lg font-medium text-rose-200 bg-rose-500/15 ring-1 ring-rose-400/25 ${base}`}>
        <Loader2 size={compact ? 10 : 12} className="animate-spin" />
        {phase === 'starting' ? 'Booting…' : 'Take over'}
      </span>
    )
  }
  if (phase === 'recording') {
    return (
      <button
        type="button"
        onClick={() => void session.stop()}
        className={`flex items-center rounded-lg font-medium text-white bg-rose-600 hover:bg-rose-500 transition ${base}`}
        title="Stop — the bot converts the recording into a skill"
      >
        <Square size={compact ? 9 : 11} className="fill-current" />
        Stop{!compact && ` · ${frames}f`}
      </button>
    )
  }
  if (phase === 'distilling') {
    return (
      <span className={`flex items-center rounded-lg font-medium text-[#e79d7f] bg-[#c96442]/15 ring-1 ring-[#c96442]/25 ${base}`}>
        <Loader2 size={compact ? 10 : 12} className="animate-spin" /> Saving skill…
      </span>
    )
  }
  if (phase === 'done') {
    return (
      <span className={`flex items-center rounded-lg font-medium text-emerald-200 bg-emerald-500/15 ring-1 ring-emerald-400/25 ${base}`}>
        <GraduationCap size={compact ? 10 : 12} /> Skill saved
      </span>
    )
  }
  if (phase === 'failed') {
    return (
      <button type="button" onClick={session.reset} title={error} className={`flex items-center rounded-lg font-medium text-rose-200 bg-rose-500/15 ring-1 ring-rose-400/25 ${base}`}>
        Retry
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={onStart}
      title="Start recording — drive the computer through the task once and it becomes a skill"
      className={`flex items-center rounded-lg font-medium text-slate-200 bg-white/[0.07] ring-1 ring-white/10 hover:bg-white/[0.12] transition ${base}`}
    >
      <Circle size={compact ? 8 : 10} className="fill-rose-500 text-rose-500" />
      Teach a task
    </button>
  )
}

/** Grok's "Starting desktop" three-dot loader. */
function LoadingDots() {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-2 h-2 rounded-full bg-slate-400 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
        />
      ))}
    </div>
  )
}
