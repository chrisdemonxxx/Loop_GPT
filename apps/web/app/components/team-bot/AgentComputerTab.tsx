'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, Loader2, MousePointer2, Square, RefreshCw, Power } from 'lucide-react'
import { getBotBox, BotApiError, type BotBox } from '../../lib/bot'
import type { TeachSession } from './useTeachSession'

/**
 * The agent's persistent computer (Grok parity): one always-on box per user,
 * watchable anytime from the Computer tab — not just while a task runs.
 *
 *  - Opening the tab boots/resumes the box and starts the live stream.
 *  - Every computer-enabled task attaches to THIS SAME VM, so the screen you
 *    watch here is the one the agent is driving.
 *  - A teach session overlays its state (recording strip, takeover CTA).
 */
export function AgentComputerTab({ session }: { session: TeachSession }) {
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

  // Boot on mount; keep the stream fresh while the tab is visible.
  useEffect(() => {
    void boot()
    pollRef.current = setInterval(() => void boot(), 60_000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [boot])

  // A teach session owns the interactive layer: while it drives, show its
  // run-specific stream (same box, takeover-aware URLs).
  const teachActive = session.phase === 'waiting' || session.phase === 'recording'
  const comp = session.computer
  const viewUrl = teachActive && comp?.viewUrl ? comp.viewUrl : box?.viewUrl || null
  const interactiveUrl = teachActive && comp?.interactiveUrl
    ? comp.interactiveUrl
    : (box?.interactiveUrl || null)

  const showInteractive = (teachActive && comp?.takeoverRequested && interactiveUrl) || (!teachActive && interactiveUrl)
  const shownUrl = showInteractive ? interactiveUrl : viewUrl

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Status strip */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] text-[11.5px] text-slate-500">
        <span className={`w-1.5 h-1.5 rounded-full ${box?.alive ? 'bg-emerald-400' : 'bg-slate-600'}`} aria-hidden />
        <span className="font-mono truncate">{box?.sandboxId ? `loop-bot-vm-${box.sandboxId.slice(0, 8)}` : 'loop-bot-vm'}</span>
        <span className="text-slate-600">·</span>
        <span>{box?.alive ? (box.resumed ? 'resumed' : 'always on') : booting ? 'booting…' : 'off'}</span>
        {typeof box?.ageMinutes === 'number' && box.alive && (
          <>
            <span className="text-slate-600">·</span>
            <span className="tabular-nums">up {box.ageMinutes}m</span>
          </>
        )}
        {session.phase === 'recording' && (
          <span className="flex items-center gap-1 text-rose-300 ml-1">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" aria-hidden />
            Recording · {session.frames} frame{session.frames === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          onClick={() => void boot()}
          aria-label="Refresh the stream"
          className="ml-auto p-1 rounded text-slate-500 hover:text-slate-300 hover:bg-white/[0.06] transition"
        >
          <RefreshCw size={12} />
        </button>
      </div>

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
                <Loader2 size={22} className="animate-spin text-slate-500" />
                <p className="text-[13px] text-slate-400">{box?.resumed === false ? 'Cold-booting the bot computer…' : 'Waking the bot computer…'}</p>
                <p className="text-[11.5px] text-slate-600">The screen appears here as soon as the desktop is up.</p>
              </>
            ) : error ? (
              <>
                <Monitor size={22} className="text-slate-600" />
                <p className="text-[13px] text-rose-300/90 max-w-sm">{error}</p>
                <button
                  type="button"
                  onClick={() => void boot()}
                  className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition"
                >
                  <Power size={12} /> Boot the computer
                </button>
              </>
            ) : (
              <>
                <Monitor size={22} className="text-slate-600" />
                <p className="text-[13px] text-slate-400">The computer is off.</p>
                <button
                  type="button"
                  onClick={() => void boot()}
                  className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition"
                >
                  <Power size={12} /> Boot the computer
                </button>
              </>
            )}
          </div>
        )}

        {/* Teach takeover CTA — the operator seizes the box to demonstrate. */}
        {session.phase === 'waiting' && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent">
            <div className="flex items-center gap-3 rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-3.5 py-2.5">
              <MousePointer2 size={14} className="text-amber-300 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] text-amber-100">Ready when you are — take over and show the bot how it&apos;s done.</p>
                <p className="text-[11px] text-amber-200/60">It records your screen until you press Stop.</p>
              </div>
              <button
                type="button"
                onClick={() => void session.takeOver()}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-amber-600 hover:bg-amber-500 transition"
              >
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
              <button
                type="button"
                onClick={() => void session.stop()}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-rose-600 hover:bg-rose-500 transition"
              >
                <Square size={11} /> Stop
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-white/[0.06] text-[11px] text-slate-600 flex items-center gap-2">
        <span>Loop Bot&apos;s screen — {box?.alive ? 'its persistent computer, always on' : 'boots when you need it'}</span>
        <span className="ml-auto font-mono text-slate-700">{box?.workspaceDir || '/workspace'}</span>
      </div>
    </div>
  )
}